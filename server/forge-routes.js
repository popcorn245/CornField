/**
 * @module server/forge-routes
 *
 * The read-only surface the issues and PRs panel reads (explorer/forge-panel.js, spec 0001 sections 3 and 4). Nothing
 * here writes to the forge: it only calls the interface's reads (server/forge.js), as the signed-in maintainer, with
 * their own token (`auth.forgeFor`), never one from the config. Without sign-in (Stage 1, loopback) there is nobody to
 * ask as, so the routes answer 403 and say so, and the explorer does not offer the panel (as the Proposals menu does
 * not list spec PRs without sign-in, server/proposal-pulls.js): no anonymous calls, so no unauthenticated rate limit
 * shared by every visitor and no cache-less repeats.
 *
 *   GET /api/forge/issues?state=open|closed|all&labels=a,b&limit=100   issues, newest first
 *   GET /api/forge/pulls?state=open|closed|all&limit=100               pull requests, newest first
 *   GET /api/forge/pulls/<n>                                           one pull request with its files and the checks on its head
 *
 * Every answer is `{ ok: true, forge, repo, at, rate, … }` (`rate`: what is left of the forge's limit, in words, or
 * null) or `{ ok: false, error, code }` with the forge's error in plain words. Answers are kept in `forge_cache`
 * (server/db.js) per forge, signed-in user and request for a minute, with an ETag of the body, so a page load is not
 * a dozen API calls and the browser's revalidation is a 304; the panel's Refresh (`Cache-Control: no-cache`) asks the
 * forge again. When the forge is rate-limited or does not answer, the last answer is served with `stale` saying why,
 * for up to a day, instead of nothing.
 */

import { createHash } from 'node:crypto';
import { ForgeError, hasAdapter, rateLimitWords } from './forge.js';

/** How long a kept answer is served without asking the forge again */
export const FRESH_MS = 60_000;
/** How long a kept answer is kept, for the days the forge cannot be asked */
export const KEEP_MS = 24 * 60 * 60 * 1000;
/** The most a listing may ask for, and what it asks for unless told */
export const MAX_LIMIT = 300;
export const DEFAULT_LIMIT = 100;

const FORGE_NAMES = { github: 'GitHub', forgejo: 'Forgejo' };
const STATUS = { unauthorized: 401, forbidden: 403, 'not-found': 404, conflict: 409, invalid: 400, 'rate-limited': 429, unavailable: 502, 'not-green': 409 };
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };

const send = (req, res, status, body, headers = {}) => {
  res.writeHead(status, { ...HEADERS, ...headers });
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
};

/** The listing's query from the address: checked here for its size, by the forge interface for the rest */
function listQuery(url, withLabels) {
  const q = { state: url.searchParams.get('state') ?? 'open', limit: Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT) };
  if (q.limit > MAX_LIMIT) throw new ForgeError(`The limit is at most ${MAX_LIMIT}.`, { code: 'invalid' });
  if (withLabels) q.labels = (url.searchParams.get('labels') ?? '').split(',').map((l) => l.trim()).filter(Boolean);
  return q;
}

/**
 * The reads: the request's route, the forge call that answers it, and the key it is kept under.
 * @returns {{ key: string, load: (forge: import('./forge.js').Forge) => Promise<object> } | null}
 */
function routeOf(reqPath, url) {
  if (reqPath === '/api/forge/issues') {
    const q = listQuery(url, true);
    return { key: `issues?state=${q.state}&limit=${q.limit}&labels=${q.labels.join(',')}`, load: async (forge) => ({ items: await forge.issues(q) }) };
  }
  if (reqPath === '/api/forge/pulls') {
    const q = listQuery(url, false);
    return { key: `pulls?state=${q.state}&limit=${q.limit}`, load: async (forge) => ({ items: await forge.pulls(q) }) };
  }
  const one = /^\/api\/forge\/pulls\/([1-9]\d{0,8})$/.exec(reqPath);
  if (one) {
    const n = Number(one[1]);
    return {
      key: `pulls/${n}`,
      load: async (forge) => {
        const pull = await forge.pull(n);
        const [files, checks] = await Promise.all([forge.pullFiles(n), pull.head.sha ? forge.checks(pull.head.sha) : []]);
        return { pull, files, checks };
      },
    };
  }
  return null;
}

/** The kept answer for a key, or null (a cache that cannot be read is no cache) */
function kept(db, key, now) {
  try {
    const row = db.prepare('SELECT etag, body, fetched_at FROM forge_cache WHERE key = ? AND expires_at > ?').get(key, new Date(now).toISOString());
    return row ? { etag: row.etag, body: JSON.parse(row.body), at: row.fetched_at } : null;
  } catch {
    return null;
  }
}

/** Keeps an answer, and lets go of the ones too old to serve at all */
function keep(db, key, etag, body, now) {
  try {
    db.prepare('DELETE FROM forge_cache WHERE expires_at <= ?').run(new Date(now).toISOString());
    db.prepare('INSERT INTO forge_cache (key, etag, body, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, body = excluded.body, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at')
      .run(key, etag, JSON.stringify(body), new Date(now).toISOString(), new Date(now + KEEP_MS).toISOString());
  } catch { /* an answer that could not be kept is still an answer */ }
}

/**
 * Answers a request for `/api/forge/…`; false for any other path (the caller goes on).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} reqPath the decoded path
 * @param {URL} url
 * @param {{ config: object, session: { userId: string } | null, auth: { store: null | (() => Promise<import('node:sqlite').DatabaseSync>), forgeFor: Function }, now?: () => number }} ctx
 *   `session` is the signed-in maintainer's (null without sign-in)
 * @returns {Promise<boolean>}
 */
export async function serveForge(req, res, reqPath, url, ctx) {
  if (reqPath !== '/api/forge' && !reqPath.startsWith('/api/forge/')) return false;
  req.resume();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(req, res, 405, { ok: false, error: 'The forge routes only read.' }, { Allow: 'GET, HEAD' });
    return true;
  }
  const { config, session, auth, now = Date.now } = ctx;
  if (!config.forge) {
    send(req, res, 404, { ok: false, error: 'No forge is configured: set `forge` in cornfield.config.js.', code: 'not-found' });
    return true;
  }
  const name = FORGE_NAMES[config.forge.type] || config.forge.type;
  if (!hasAdapter(config.forge.type)) {
    send(req, res, 501, { ok: false, error: `cornfield has no adapter for the forge type ${JSON.stringify(config.forge.type)} yet.`, code: 'unavailable' });
    return true;
  }
  if (!session) {
    send(req, res, 403, { ok: false, error: `Issues and pull requests are read from ${name} as the signed-in maintainer: set up sign-in to see them (docs/sign-in.md).`, code: 'forbidden' });
    return true;
  }
  try {
    const route = routeOf(reqPath, url);
    if (!route) {
      send(req, res, 404, { ok: false, error: `${reqPath} is not a forge route.`, code: 'not-found' });
      return true;
    }
    const key = `${config.forge.type}|${session.userId}|${route.key}`;
    let db = null;
    if (auth.store) {
      try { db = await auth.store(); } catch { db = null; }
    }
    const refresh = /no-cache/i.test(String(req.headers['cache-control'] || ''));
    const had = db ? kept(db, key, now()) : null;
    let answer = had && !refresh && now() - Date.parse(had.at) < FRESH_MS ? had : null;
    let stale = null;
    if (!answer) {
      const forge = auth.forgeFor(session);
      try {
        const data = await route.load(forge);
        const rate = forge.rateLimit();
        const body = { data, rate: rate && (rate.remaining != null || rate.retryAfter != null) ? rateLimitWords(name, rate, new Date(now())) : null };
        const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 20)}"`;
        if (db) keep(db, key, etag, body, now());
        answer = { etag, body, at: new Date(now()).toISOString() };
      } catch (err) {
        // The forge is rate-limited or away: what was seen last is better than a blank panel, and says so
        if (!(had && err instanceof ForgeError && (err.code === 'rate-limited' || err.code === 'unavailable'))) throw err;
        answer = had;
        stale = err.message;
      }
    }
    const headers = { ETag: answer.etag };
    if (!stale && answer.etag && req.headers['if-none-match'] === answer.etag) {
      res.writeHead(304, { ...headers, 'Cache-Control': 'no-cache' });
      res.end();
      return true;
    }
    send(req, res, 200, { ok: true, forge: config.forge.type, repo: config.forge.repo, at: answer.at, rate: answer.body.rate, ...(stale ? { stale } : {}), ...answer.body.data }, stale ? {} : headers);
  } catch (err) {
    if (!(err instanceof ForgeError)) throw err;
    const wait = err.rateLimit && err.rateLimit.retryAfter != null ? { 'Retry-After': String(Math.ceil(err.rateLimit.retryAfter)) } : {};
    send(req, res, err.status === 501 ? 501 : STATUS[err.code] || 502, { ok: false, error: err.message, code: err.code }, wait);
  }
  return true;
}

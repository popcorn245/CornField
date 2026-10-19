/**
 * @module server/forge-routes
 *
 * The surface the issues and PRs panel reads (explorer/forge-panel.js, spec 0001 sections 3 and 4). The GETs below
 * only call the interface's reads (server/forge.js); the two POSTs that act (land, re-run) are server/forge-actions.js.
 * All as the signed-in maintainer, with
 * their own token (`auth.forgeFor`), never one from the config. Without sign-in (Stage 1, loopback) there is nobody to
 * ask as, so the routes answer 403 and say so, and the explorer does not offer the panel (as the Proposals menu does
 * not list spec PRs without sign-in, server/proposal-pulls.js): no anonymous calls, so no unauthenticated rate limit
 * shared by every visitor and no cache-less repeats.
 *
 *   GET /api/forge/issues?state=open|closed|all&labels=a,b&limit=100   issues, newest first
 *   GET /api/forge/pulls?state=open|closed|all&limit=100               pull requests, newest first
 *   GET /api/forge/pulls/<n>                                           one pull request with its files and the checks on its head
 *                                                                      (each check says whether cornfield can re-run it: `canRerun`)
 *                                                                      (and `specs`: the proposals it changes and whether each is approved, for the pipeline's step 2)
 *   POST /api/forge/pulls/<n>/merge | /rerun                           land it, re-run a failed check (server/forge-actions.js)
 *   GET  /api/forge/issues/<n>/spec                                    the plan of step 1: what starting a spec on the issue would make (server/pipeline.js), never kept
 *   GET  /api/forge/pulls/<n>/build?slug=<proposal>                    the plan of step 2: the build issue of an approved proposal, never kept
 *   POST /api/forge/issues/<n>/spec | /pulls/<n>/build                 do them, with the plan's digest (server/forge-actions.js)
 *   GET /api/forge/work                                                what the agents view groups: pull requests and issues (any state), branches, open spec PRs, and the config's `agents` rules
 *   GET /api/forge/deploys?limit=100                                   the latest workflow runs that are deploys, each with what the
 *                                                                      config says it restarted (server/deploys.js, docs/deploys.md)
 *
 * Every answer is `{ ok: true, forge, repo, at, rate, … }` (`rate`: what is left of the forge's limit, in words, or
 * null) or `{ ok: false, error, code }` with the forge's error in plain words. Answers are kept in `forge_cache`
 * (server/db.js) per forge, signed-in user and request for a minute, with an ETag of the body, so a page load is not
 * a dozen API calls and the browser's revalidation is a 304; the panel's Refresh (`Cache-Control: no-cache`) asks the
 * forge again. When the forge is rate-limited or does not answer, the last answer is served with `stale` saying why,
 * for up to a day, instead of nothing.
 */

import { createHash } from 'node:crypto';
import { ForgeError, canRerun, hasAdapter, rateLimitWords } from './forge.js';
import { actionOf, serveAction } from './forge-actions.js';
import { planSpec, planBuild, pullSpecs } from './pipeline.js';
import { listPullProposals } from './proposal-pulls.js';
import { deploysOf } from './deploys.js';

/** How long a kept answer is served without asking the forge again */
export const FRESH_MS = 60_000;
/** How long a kept answer is kept, for the days the forge cannot be asked */
export const KEEP_MS = 24 * 60 * 60 * 1000;
/** The most a listing may ask for, and what it asks for unless told */
export const MAX_LIMIT = 300;
export const DEFAULT_LIMIT = 100;
/** What the agents view reads: the newest pull requests and issues, any state, and the most branches */
export const WORK_PULLS = 100;
export const WORK_ISSUES = 200;
export const WORK_BRANCHES = 300;
/** A pull request's text is read for "Closes #n": the first of it is enough, and the answer stays small */
export const WORK_BODY_MAX = 4000;

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
function routeOf(reqPath, url, config, where) {
  if (reqPath === '/api/forge/issues') {
    const q = listQuery(url, true);
    return { key: `issues?state=${q.state}&limit=${q.limit}&labels=${q.labels.join(',')}`, load: async (forge) => ({ items: await forge.issues(q) }) };
  }
  if (reqPath === '/api/forge/pulls') {
    const q = listQuery(url, false);
    return { key: `pulls?state=${q.state}&limit=${q.limit}`, load: async (forge) => ({ items: await forge.pulls(q) }) };
  }
  if (reqPath === '/api/forge/deploys') {
    const { limit } = listQuery(url, false);
    // The runs asked for are the last `limit` of every workflow; the config picks the deploys among them. The config is
    // in the key, so an answer kept before it changed is never served for the new one.
    const mapping = createHash('sha256').update(JSON.stringify(config.deploys || null)).digest('hex').slice(0, 12);
    return { key: `deploys?limit=${limit}&config=${mapping}`, load: async (forge) => ({ items: deploysOf(await forge.runs({ limit }), config.deploys) }) };
  }
  if (reqPath === '/api/forge/work') {
    return {
      key: 'work',
      load: async (forge) => {
        const [pulls, issues, branches, specs] = await Promise.all([
          forge.pulls({ state: 'all', limit: WORK_PULLS }), forge.issues({ state: 'all', labels: [], limit: WORK_ISSUES }), forge.branches(), listPullProposals(forge, config),
        ]);
        return {
          pulls: pulls.map((p) => ({ ...p, body: p.body.slice(0, WORK_BODY_MAX) })),
          issues,
          branches: branches.slice(0, WORK_BRANCHES),
          specs: specs.entries.map((e) => ({ pull: e.pull.number, slug: e.slug })),
          specsProblem: specs.problem,
          // In the kept answer, so a changed config is a changed ETag
          agents: config.agents,
        };
      },
    };
  }
  const one = /^\/api\/forge\/pulls\/([1-9]\d{0,8})$/.exec(reqPath);
  if (one) {
    const n = Number(one[1]);
    return {
      key: `pulls/${n}`,
      load: async (forge) => {
        const pull = await forge.pull(n);
        const [files, checks] = await Promise.all([forge.pullFiles(n), pull.head.sha ? forge.checks(pull.head.sha) : []]);
        // The proposals this pull request changes and whether a maintainer has approved each: step 2 of the pipeline is offered on one that is.
        // A forge that cannot say leaves it out; the panel just does not offer the step then
        let specs = [];
        if (where && pull.state === 'open') {
          try { specs = await pullSpecs(forge, where, pull, files); } catch { specs = []; }
        }
        return { pull, files, checks: checks.map((c) => ({ ...c, canRerun: canRerun(c) })), specs };
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
 * The plan of a pipeline step, read from the forge now and never kept: what the confirm step shows. A signed-in
 * maintainer's own token asks; nothing is written.
 * @param {{ n: number, action: 'spec' | 'build' }} act
 */
async function servePlan(req, res, act, url, ctx) {
  const { config, session, auth, now = Date.now } = ctx;
  if (!session) {
    send(req, res, 403, { ok: false, error: 'The pipeline\'s steps are done as the signed-in maintainer: set up sign-in first (docs/sign-in.md).', code: 'forbidden' });
    return;
  }
  try {
    const forge = auth.forgeFor(session);
    const where = ctx.where || { proposals: config.proposals };
    const plan = act.action === 'spec' ? await planSpec(forge, config, where, act.n) : await planBuild(forge, where, act.n, url.searchParams.get('slug') ?? '');
    const rate = forge.rateLimit();
    send(req, res, 200, { ok: true, forge: config.forge.type, repo: config.forge.repo, at: new Date(now()).toISOString(), rate: rate && (rate.remaining != null || rate.retryAfter != null) ? rateLimitWords(FORGE_NAMES[config.forge.type] || config.forge.type, rate, new Date(now())) : null, plan });
  } catch (err) {
    if (!(err instanceof ForgeError)) throw err;
    const wait = err.rateLimit && err.rateLimit.retryAfter != null ? { 'Retry-After': String(Math.ceil(err.rateLimit.retryAfter)) } : {};
    send(req, res, STATUS[err.code] || 502, { ok: false, error: err.message, code: err.code }, wait);
  }
}

/**
 * Answers a request for `/api/forge/…`; false for any other path (the caller goes on).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} reqPath the decoded path
 * @param {URL} url
 * @param {{ config: object, where?: { proposals: string }, session: { userId: string, login: string } | null, publicHost?: string | null, auth: { store: null | (() => Promise<import('node:sqlite').DatabaseSync>), forgeFor: Function }, now?: () => number }} ctx
 *   `session` is the signed-in maintainer's (null without sign-in)
 * @returns {Promise<boolean>}
 */
export async function serveForge(req, res, reqPath, url, ctx) {
  if (reqPath !== '/api/forge' && !reqPath.startsWith('/api/forge/')) return false;
  const { config, session, auth, now = Date.now } = ctx;
  const act = actionOf(reqPath);
  if (act) {
    if (!config.forge || !hasAdapter(config.forge.type)) {
      req.resume();
      send(req, res, config.forge ? 501 : 404, { ok: false, error: config.forge ? `cornfield has no adapter for the forge type ${JSON.stringify(config.forge.type)} yet.` : 'No forge is configured: set `forge` in cornfield.config.js.', code: config.forge ? 'unavailable' : 'not-found' });
      return true;
    }
    // The plan of a pipeline step is read at the same address the step is done at
    if ((req.method === 'GET' || req.method === 'HEAD') && (act.action === 'spec' || act.action === 'build')) {
      req.resume();
      await servePlan(req, res, act, url, ctx);
      return true;
    }
    await serveAction(req, res, act, ctx, (status, body, headers) => send(req, res, status, body, headers));
    return true;
  }
  req.resume();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(req, res, 405, { ok: false, error: 'The forge routes only read, but for landing and re-running a pull request.' }, { Allow: 'GET, HEAD' });
    return true;
  }
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
    const route = routeOf(reqPath, url, config, ctx.where);
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

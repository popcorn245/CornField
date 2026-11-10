/**
 * @module server/auth
 *
 * Sign-in with the repo's forge (GitHub or Forgejo OAuth) and the admins-only guard every route passes through
 * (spec 0001 sections 2.4 and 3, ADR 0004). `createAuth(config)` reads the sign-in settings from env; its `gate`
 * runs before every route the server answers:
 *
 *   no session               the sign-in page for a page, 401 for anything else
 *   a reader, not a maintainer   "this is the dev dashboard; ask a maintainer" for a page, 403 for anything else
 *   a maintainer             the route
 *
 * The permission is asked of the forge when the session starts and, for a maintainer, again once it is 15 minutes
 * old (by the forge's user id, so a rename is followed); a token the forge no longer accepts ends the session, a forge
 * that does not answer then is a 503 (never a pass). Someone who is not a maintainer is asked again at their next
 * sign-in: cornfield keeps no token of theirs.
 *
 * Its own routes, the only ones open without a session:
 *
 *   GET  /auth/sign-in     the sign-in page
 *   GET  /auth/start       to the forge's authorize page (a state and a PKCE verifier in a short-lived cookie)
 *   GET  /auth/callback    back from the forge: the code for a token, the user, their permission, a session
 *   POST /auth/sign-out    ends the session (same origin only)
 *   GET  /auth/me          who is signed in: { login, permission, admin }
 *
 * **Without sign-in configured** (no OAuth pair in env) the gate lets everything through: that is Stage 1, a
 * loopback-only server on the machine of its only user (server/bind.js keeps it there).
 *
 * Sign-in is configured by env only, never the config file: `CORNFIELD_GITHUB_CLIENT_ID` and
 * `CORNFIELD_GITHUB_CLIENT_SECRET` (or the `FORGEJO` pair, for the config's forge type), `CORNFIELD_SESSION_SECRET`
 * (at least 32 characters), and the config's `publicUrl` (`CORNFIELD_PUBLIC_URL`), which the OAuth app's callback
 * is under. Half of it set is an error at startup, not a quiet fallback to no sign-in.
 *
 * Sessions are rows of the SQLite file (server/db.js). The cookie holds a random value; the row's id is its HMAC
 * under the session secret, so the file alone opens no session. A maintainer's forge token is kept in the row
 * encrypted (AES-256-GCM, a key derived from the session secret) and never sent to the browser; anyone else's is
 * revoked at once. A token is revoked at the forge when its session ends (sign-out, expiry, no longer a maintainer)
 * where the forge lets an app do that: GitHub does (`DELETE /applications/<client id>/token`), Forgejo has no such
 * call, so there the user revokes cornfield's app in their own settings.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createForge as defaultCreateForge, isMaintainer, ForgeError } from './forge.js';
import { githubApiUrl } from './forge-github.js';
import { sameOrigin } from './proposals.js';
import { revokeOwnerTokens } from './review-tokens.js';

/** How often a session's permission is asked of the forge again */
export const RECHECK_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a session lasts unless `CORNFIELD_SESSION_DAYS` says otherwise */
export const SESSION_MS = 7 * DAY_MS;
export const SESSION_DAYS_ENV = 'CORNFIELD_SESSION_DAYS';
export const DEFAULT_SESSION_DAYS = 7;
export const MAX_SESSION_DAYS = 30;
/** A forge token this close to its expiry (or past it) is renewed before it is used */
export const REFRESH_SKEW_MS = 30_000;
/** How long the way out to the forge and back may take */
export const STATE_MS = 10 * 60 * 1000;
export const MIN_SESSION_SECRET = 32;
const TOKEN_TIMEOUT_MS = 15_000;
const REVOKE_TIMEOUT_MS = 5_000;
/** The most of a token endpoint's answer that is read: a token pair is a few hundred bytes */
const MAX_TOKEN_ANSWER = 64 * 1024;
/** Statuses that say "not now" (a timeout, a rate limit), never "no": a renewal answered with one ends no session */
const NOT_NOW = [408, 425, 429];

/** A response's text, at most `max` bytes: past that the body is dropped and the read throws */
async function cappedText(res, max) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text) > max) throw new Error('the answer is too large');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error('the answer is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}
/** What a session row keeps in place of a token when it keeps none (a signed-in non-maintainer) */
const NO_TOKEN = '';
/** What a renewal answers for a session that has no refresh token */
const NO_REFRESH = Symbol('no refresh token');

/** The env each forge's OAuth app is read from */
export const OAUTH_ENV = Object.freeze({
  github: { id: 'CORNFIELD_GITHUB_CLIENT_ID', secret: 'CORNFIELD_GITHUB_CLIENT_SECRET' },
  forgejo: { id: 'CORNFIELD_FORGEJO_CLIENT_ID', secret: 'CORNFIELD_FORGEJO_CLIENT_SECRET' },
});
export const SESSION_SECRET_ENV = 'CORNFIELD_SESSION_SECRET';
const FORGE_NAMES = { github: 'GitHub', forgejo: 'Forgejo' };

/**
 * The OAuth endpoints and scope of a forge. GitHub's `repo` scope is what reading a private repo, commenting and
 * merging need; Forgejo's OAuth apps are given the user's access without a scope.
 * @param {{ type: string, url?: string }} forge
 */
export function oauthEndpoints(forge) {
  // A Forgejo served under a path (https://example.org/forge) keeps it; GitHub's are at its origin
  const u = new URL(forge.url || (forge.type === 'github' ? 'https://github.com' : ''));
  const root = `${u.origin}${forge.type === 'github' ? '' : u.pathname.replace(/\/+$/, '')}`;
  return {
    authorize: `${root}/login/oauth/authorize`,
    token: `${root}/login/oauth/access_token`,
    scope: forge.type === 'github' ? 'repo' : '',
  };
}

/**
 * How many days a session lasts: `CORNFIELD_SESSION_DAYS`, a whole number from 1 to 30, 7 when unset. Anything else
 * throws, in words (a value that is quietly ignored would leave a team on 7 days without knowing).
 * @param {Record<string, string | undefined>} [env]
 */
export function sessionDays(env = process.env) {
  const raw = env[SESSION_DAYS_ENV];
  if (raw === undefined || raw === '') return DEFAULT_SESSION_DAYS;
  const days = /^[0-9]{1,3}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > MAX_SESSION_DAYS) throw new Error(`${SESSION_DAYS_ENV} is ${JSON.stringify(raw.slice(0, 40))}: use a whole number of days from 1 to ${MAX_SESSION_DAYS} (${DEFAULT_SESSION_DAYS} when unset).`);
  return days;
}

/**
 * The sign-in settings env gives, or null when sign-in is not configured at all. Throws, in words, when it is
 * half configured: one of a pair, no session secret, a short one, no public URL, no forge.
 * @param {{ forge?: { type: string, url?: string, repo: string } | null, publicUrl?: string | null }} config
 * @param {Record<string, string | undefined>} [env]
 * @returns {null | { forge: { type: string, url?: string, repo: string }, forgeName: string, clientId: string, clientSecret: string, sessionSecret: string, publicUrl: URL, secure: boolean, sessionDays: number }}
 */
export function signInSettings(config, env = process.env) {
  const set = (name) => typeof env[name] === 'string' && env[name] !== '';
  const days = sessionDays(env);
  const anyPair = Object.values(OAUTH_ENV).some((p) => set(p.id) || set(p.secret));
  if (!anyPair) {
    if (set(SESSION_SECRET_ENV)) throw new Error(`${SESSION_SECRET_ENV} is set but no OAuth app is: set the forge's client id and secret too (docs/sign-in.md), or unset it.`);
    return null;
  }
  const forge = config.forge;
  if (!forge) throw new Error('An OAuth app is set in env, but the config names no forge: add `forge: { type, url, repo }` to cornfield.config.js.');
  const pair = OAUTH_ENV[forge.type];
  if (!pair) throw new Error(`cornfield has no sign-in for the forge type ${JSON.stringify(forge.type)}.`);
  for (const [type, p] of Object.entries(OAUTH_ENV)) {
    if (type !== forge.type && (set(p.id) || set(p.secret))) throw new Error(`The config's forge is ${forge.type}, but ${set(p.id) ? p.id : p.secret} is set: use ${pair.id} and ${pair.secret}.`);
  }
  if (!set(pair.id) || !set(pair.secret)) throw new Error(`Sign-in needs both ${pair.id} and ${pair.secret}; only ${set(pair.id) ? pair.id : pair.secret} is set.`);
  if (!set(SESSION_SECRET_ENV)) throw new Error(`Sign-in needs ${SESSION_SECRET_ENV}: a random value of at least ${MIN_SESSION_SECRET} characters (openssl rand -base64 48).`);
  if (env[SESSION_SECRET_ENV].length < MIN_SESSION_SECRET) throw new Error(`${SESSION_SECRET_ENV} is too short: use at least ${MIN_SESSION_SECRET} random characters (openssl rand -base64 48).`);
  if (!config.publicUrl) throw new Error('Sign-in needs the public URL people open cornfield at (CORNFIELD_PUBLIC_URL): the OAuth app\'s callback is <public URL>/auth/callback.');
  let publicUrl;
  try {
    publicUrl = new URL(config.publicUrl);
  } catch {
    throw new Error(`The public URL ${JSON.stringify(config.publicUrl)} is not a URL.`);
  }
  if (publicUrl.protocol !== 'https:' && publicUrl.protocol !== 'http:') throw new Error('The public URL is an http or https URL.');
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('The public URL is an origin, like https://cornfield.example.org: cornfield is served at its root.');
  return {
    forge, forgeName: FORGE_NAMES[forge.type], clientId: env[pair.id], clientSecret: env[pair.secret], sessionSecret: env[SESSION_SECRET_ENV],
    publicUrl, secure: publicUrl.protocol === 'https:', sessionDays: days,
  };
}

// ---------------------------------------------------------------------------
//  Cookies, the session id, the token at rest
// ---------------------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const random = (n = 32) => b64url(randomBytes(n));

/** The cookies of a request, by name (the first of a name wins) */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    if (name && !(name in out)) out[name] = part.slice(at + 1).trim();
  }
  return out;
}

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The keys a session secret gives: one to name sessions and sign the state, one to encrypt tokens */
function keysOf(secret) {
  const derive = (info) => Buffer.from(hkdfSync('sha256', secret, 'cornfield', info, 32));
  return { mac: derive('cornfield session id'), enc: derive('cornfield forge token') };
}

const macOf = (key, text) => createHmac('sha256', key).update(text).digest('base64url');

/** A forge token, encrypted for its row: `v1.<iv>.<tag>.<ciphertext>` */
export function sealToken(key, token, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  // With `aad` (v2) the ciphertext opens only for that row and column: one cannot be moved into another session's row
  if (aad !== undefined) c.setAAD(Buffer.from(String(aad), 'utf8'));
  const body = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return `${aad !== undefined ? 'v2' : 'v1'}.${b64url(iv)}.${b64url(c.getAuthTag())}.${b64url(body)}`;
}

/** The token a row holds, or null when it does not open under this key (another secret, or tampered) */
export function openToken(key, sealed, aad, { legacy = true } = {}) {
  const [v, iv, tag, body] = String(sealed).split('.');
  if (!iv || !tag || body === undefined) return null;
  // v2 is bound to its row and column (`aad`); v1, sealed before that, opens only where a legacy value may still be
  if (v === 'v2' ? aad === undefined : v !== 'v1' || !legacy) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    if (v === 'v2') d.setAAD(Buffer.from(String(aad), 'utf8'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** A Set-Cookie value */
function cookie(name, value, { maxAge, secure }) {
  return [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', ...(secure ? ['Secure'] : []), `Max-Age=${maxAge}`].join('; ');
}

// ---------------------------------------------------------------------------
//  Pages
// ---------------------------------------------------------------------------

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLE = `
  :root { color-scheme: light dark; --bg: #f8fafc; --fg: #0f172a; --muted: #475569; --card: #ffffff; --line: #e2e8f0; --accent: #0f766e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1120; --fg: #e2e8f0; --muted: #94a3b8; --card: #111827; --line: #1f2937; --accent: #2dd4bf; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 16px; color: var(--muted); }
  .button { display: inline-block; padding: 10px 16px; border-radius: 8px; border: 0; background: var(--accent); color: var(--card); font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  .quiet { background: transparent; color: var(--accent); border: 1px solid var(--line); }
  form { margin: 0; }
`;

/** One small page: a heading, words, and what can be done next. No script. */
function pageHtml(title, heading, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · cornfield</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
${body}
</main>
</body>
</html>
`;
}

const signOutForm = '<form method="post" action="/auth/sign-out"><button class="button quiet" type="submit">Sign out</button></form>';

/**
 * Where a sign-in may send the person back to: a same-origin relative path (with its query), or null. An absolute URL
 * (`https://elsewhere`), a protocol-relative one (`//elsewhere`), a backslash trick (`/\\elsewhere`), a control character
 * and the sign-in routes themselves are refused, so the return is never an open redirect.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function safeReturn(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null;
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return null;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  let parsed;
  try { parsed = new URL(raw, 'http://cornfield.invalid'); } catch { return null; }
  if (parsed.origin !== 'http://cornfield.invalid') return null;
  if (parsed.pathname === '/auth' || parsed.pathname.startsWith('/auth/')) return null;
  return `${parsed.pathname}${parsed.search}`;
}

/** The sign-in page; `returnTo` (checked by safeReturn) is where the sign-in ends, so a link followed signed out is followed after */
export const signInPage = (title, forgeName, returnTo = null) => {
  const back = safeReturn(returnTo);
  const query = back && back !== '/' ? `?return=${escapeHtml(encodeURIComponent(back))}` : '';
  return pageHtml(title, `Sign in to ${title}`, `
<p>This is the dev dashboard. Sign in with ${escapeHtml(forgeName)} to see it; it is open to the repo's maintainers.</p>
<a class="button" href="/auth/start${query}">Sign in with ${escapeHtml(forgeName)}</a>`);
};

/** The one page a signed-in non-maintainer sees */
export const askMaintainerPage = (title, login, repo) => pageHtml(title, 'This is the dev dashboard', `
<p>You are signed in as ${escapeHtml(login)}, who does not maintain ${escapeHtml(repo)}. Only its maintainers can see the dashboard: ask a maintainer if you need something from it.</p>
<p>Made a maintainer since? Sign out and sign in again.</p>
${signOutForm}`);

/** A sign-in that did not work, and the way to try again */
const failedPage = (title, words) => pageHtml(title, 'Sign-in did not work', `
<p>${escapeHtml(words)}</p>
<a class="button" href="/auth/start">Try again</a>`);

/** The forge could not be asked about a session's permission */
const uncheckedPage = (title, words) => pageHtml(title, 'Your access could not be checked', `
<p>${escapeHtml(words)} Reload in a minute.</p>
${signOutForm}`);

// ---------------------------------------------------------------------------
//  The guard
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };

/** Whether a request is a person opening a page (answered with a page), not a module or the API (answered with JSON) */
function wantsPage(req, reqPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (reqPath === '/' || reqPath === '/index.html') return true;
  return req.headers['sec-fetch-dest'] === 'document' || /^text\/html\b/.test(String(req.headers.accept || ''));
}

/**
 * @typedef {{ id: string, forge: string, user_id: string, login: string, token: string, permission: string, created_at: string, checked_at: string, expires_at: string, refresh_token: string, token_expires_at: string | null, expiring_sent_at: string | null }} SessionRow
 * @typedef {{ login: string, userId: string, permission: string, admin: boolean, row: SessionRow }} Session
 */

/**
 * The sign-in of one server.
 * @param {object} config a loaded config (core/config.js)
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   now?: () => number,
 *   fetch?: typeof fetch,
 *   createForge?: typeof defaultCreateForge,
 *   forgeOptions?: object,
 * }} [opts] `now`, `fetch`, `createForge` and `forgeOptions` (passed to every forge made) are for tests
 */
export function createAuth(config, { env = process.env, now = Date.now, fetch: doFetch = globalThis.fetch, createForge = defaultCreateForge, forgeOptions = {} } = {}) {
  const settings = signInSettings(config, env);
  if (!settings) {
    return {
      enabled: false,
      settings: null,
      /** Stage 1: everything passes; the routes under /auth/ are not there */
      gate: async () => ({ done: false, session: null }),
      forgeFor: () => { throw new Error('Sign-in is not configured.'); },
      forgeForUser: async () => { throw new Error('Sign-in is not configured.'); },
      record: async () => { throw new Error('Sign-in is not configured.'); },
      knownPermission: async () => null,
      demoted: async () => {},
      begin: async () => { throw new Error('Sign-in is not configured.'); },
      finish: async () => { throw new Error('Sign-in is not configured.'); },
      store: null,
      close() {},
    };
  }

  const title = config.title || 'cornfield';
  const { forge: forgeConfig, forgeName, clientId, clientSecret, publicUrl, secure } = settings;
  const sessionMs = settings.sessionDays * DAY_MS;
  const keys = keysOf(settings.sessionSecret);
  const endpoints = oauthEndpoints(forgeConfig);
  const redirectUri = new URL('/auth/callback', publicUrl).href;
  const SESSION_COOKIE = secure ? '__Host-cornfield' : 'cornfield';
  const STATE_COOKIE = secure ? '__Host-cornfield-oauth' : 'cornfield-oauth';
  const publicHost = publicUrl.hostname;
  /** @type {import('node:sqlite').DatabaseSync | null} */
  let db = null;
  /** @type {Promise<import('node:sqlite').DatabaseSync> | null} */
  let opening = null;
  // The SQLite file is opened on the first request that needs it (node:sqlite is loaded only when sign-in is on)
  // A failed open is not kept: the next request tries again (a data folder mounted late, a lock released)
  const store = () => (opening ??= import('./db.js').then((m) => (db = m.openStore(config.dataDir))).catch((err) => { opening = null; throw err; }));
  const iso = (ms) => new Date(ms).toISOString();
  const forgeWith = (token) => createForge(forgeConfig, { token, ...forgeOptions });
  /** Session ids whose forge token is being renewed right now: one renewal per session, however many calls wait on it */
  const renewals = new Map();
  /**
   * A session's tokens are sealed for their row and column (AES-GCM's additional data): a sealed token copied into
   * another session's row, or from one column to the other, does not open. An access token sealed before this (v1)
   * still opens until its session ends; a refresh token never had a v1.
   */
  const aadOf = (id, column) => `cornfield session ${id} ${column}`;
  const sealFor = (id, column, value) => sealToken(keys.enc, value, aadOf(id, column));
  const openFor = (row, column) => openToken(keys.enc, row[column], aadOf(row.id, column), { legacy: column === 'token' });

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...(typeof body === 'string' ? HTML_HEADERS : JSON_HEADERS), ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const answer = (req, res, reqPath, status, page, error) => {
    if (wantsPage(req, reqPath)) return send(res, status, req.method === 'HEAD' ? '' : page);
    return send(res, status, { ok: false, error });
  };
  const redirect = (res, location, cookies = []) => {
    res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
    res.end();
  };
  const clearSession = cookie(SESSION_COOKIE, '', { maxAge: 0, secure });
  const clearState = cookie(STATE_COOKIE, '', { maxAge: 0, secure });

  /**
   * Revokes a token at the forge, best effort: GitHub's `DELETE /applications/<client id>/token` (the app's own
   * credentials). Forgejo's API has no way for an app to revoke a token; its users revoke the app in their settings.
   * A failure is logged (never the token) and does not stop what called it.
   */
  async function revoke(token) {
    if (!token || forgeConfig.type !== 'github') return false;
    const api = (forgeOptions.apiUrl || githubApiUrl(forgeConfig.url)).replace(/\/+$/, '');
    try {
      const res = await doFetch(`${api}/applications/${encodeURIComponent(clientId)}/token`, {
        method: 'DELETE',
        headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'cornfield', Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
        body: JSON.stringify({ access_token: token }),
        redirect: 'manual',
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
      await res.arrayBuffer();
      // 204: revoked; 404: GitHub no longer knows it (already revoked, or expired)
      if (res.status === 204 || res.status === 404) return true;
      console.error(`[cornfield] ${forgeName} did not revoke a token (HTTP ${res.status}).`);
    } catch (err) {
      console.error(`[cornfield] ${forgeName} could not be asked to revoke a token: ${err.message}`);
    }
    return false;
  }

  /** Ends a session: its row goes, and the token it kept is revoked */
  async function endRow(row) {
    (await store()).prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    if (row.token !== NO_TOKEN) await revoke(openFor(row, 'token'));
  }

  /** The session row a request's cookie names, live, or null */
  async function rowOf(req) {
    const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!value || value.length > 200) return null;
    const row = /** @type {SessionRow | undefined} */ ((await store()).prepare('SELECT * FROM sessions WHERE id = ?').get(macOf(keys.mac, value)));
    if (!row) return null;
    if (Date.parse(row.expires_at) <= now()) {
      await endRow(row);
      return null;
    }
    return row;
  }

  /** @returns {Session} */
  const sessionOf = (row) => ({ login: row.login, userId: row.user_id, permission: row.permission, admin: isMaintainer(row.permission), row });

  /**
   * The session of a request with its permission asked again when it is due. A session that keeps no token (someone
   * who is not a maintainer) is not asked again: they are, until they sign in again. The user is matched by the
   * forge's id, not by login, so a renamed maintainer keeps their session (with the new login).
   * @returns {Promise<{ session: Session | null, unchecked?: string }>}
   */
  async function currentSession(req) {
    const row = await rowOf(req);
    if (!row) return { session: null };
    if (row.token === NO_TOKEN || now() - Date.parse(row.checked_at) < RECHECK_MS) return { session: sessionOf(row) };
    const token = openFor(row, 'token');
    if (token === null) {
      await endRow(row);
      return { session: null };
    }
    try {
      const forge = managedForge(row);
      const user = await forge.me();
      if (String(user.id) !== row.user_id) {
        await endRow(row);
        return { session: null };
      }
      const permission = await forge.permission(forgeConfig.repo, user.login);
      const keep = isMaintainer(permission);
      // The token is not written back when it is kept: a renewal during these calls has stored a newer one
      const file = await store();
      const kept = /** @type {SessionRow | undefined} */ (file.prepare('SELECT * FROM sessions WHERE id = ?').get(row.id));
      if (!kept) return { session: null };
      const next = { ...kept, login: user.login, permission, checked_at: iso(now()), ...(keep ? {} : { token: NO_TOKEN, refresh_token: '', token_expires_at: null }) };
      file.prepare('UPDATE sessions SET login = ?, permission = ?, checked_at = ?, token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ?')
        .run(next.login, next.permission, next.checked_at, next.token, next.refresh_token, next.token_expires_at, row.id);
      if (!keep) await revoke(openFor(kept, 'token') ?? token);
      return { session: sessionOf(next) };
    } catch (err) {
      if (err instanceof ForgeError && err.code === 'unauthorized') {
        (await store()).prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
        return { session: null };
      }
      return { session: sessionOf(row), unchecked: err instanceof ForgeError ? err.message : `${forgeName} could not be asked.` };
    }
  }

  // --- the routes under /auth/ ---

  function start(res, url) {
    const state = random();
    const verifier = random();
    const expires = now() + STATE_MS;
    // The way back is signed with the state: a 5th part, base64url (no dots), empty for none
    const back = safeReturn(url.searchParams.get('return'));
    const payload = `${state}.${verifier}.${expires}.${back ? b64url(Buffer.from(back)) : ''}`;
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
    if (endpoints.scope) q.set('scope', endpoints.scope);
    redirect(res, `${endpoints.authorize}?${q}`, [cookie(STATE_COOKIE, `${payload}.${macOf(keys.mac, `state:${payload}`)}`, { maxAge: STATE_MS / 1000, secure })]);
  }

  /** The verifier of a callback whose state matches its cookie, or the words for why not */
  function checkState(req, url) {
    const raw = parseCookies(req.headers.cookie)[STATE_COOKIE];
    const parts = raw ? raw.split('.') : [];
    if (parts.length !== 5) return { error: 'The sign-in was started in another browser, or too long ago.' };
    const [state, verifier, expires, back, mac] = parts;
    if (!sameText(mac, macOf(keys.mac, `state:${state}.${verifier}.${expires}.${back}`))) return { error: 'The sign-in was started in another browser, or too long ago.' };
    if (!(Number(expires) > now())) return { error: 'The sign-in took too long.' };
    if (!sameText(state, url.searchParams.get('state') || '')) return { error: 'The sign-in came back with an answer to another request.' };
    return { verifier, returnTo: safeReturn(back ? Buffer.from(back, 'base64url').toString('utf8') : '') };
  }

  /**
   * The forge's token endpoint, for a code (sign-in) or a refresh token (renewal). Answers the pair it gave, or throws
   * a ForgeError: `unauthorized` when the forge refused (a code or refresh token that is bad, revoked or expired),
   * `unavailable` when it did not answer or said it could not now (nothing is ended for that).
   * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: string | null }>}
   */
  async function tokenRequest(grant, what) {
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...grant });
    let res;
    let parsed = null;
    try {
      res = await doFetch(endpoints.token, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'cornfield' }, body, redirect: 'manual', signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
      parsed = JSON.parse(await cappedText(res, MAX_TOKEN_ANSWER));
    } catch (err) {
      // A forge that answered 4xx with a body that is not JSON said no; one that did not answer, or broke, did not
      if (res && res.status >= 400 && res.status < 500 && !NOT_NOW.includes(res.status)) throw new ForgeError(`${forgeName} did not give a token for ${what}.`, { code: 'unauthorized', status: res.status, forge: forgeName });
      throw new ForgeError(`${forgeName} did not answer ${what}; try again in a minute.`, { code: 'unavailable', forge: forgeName, cause: err });
    }
    if (res.status >= 500 || NOT_NOW.includes(res.status) || (res.status >= 300 && res.status < 400) || (parsed && (parsed.error === 'temporarily_unavailable' || parsed.error === 'server_error'))) {
      throw new ForgeError(`${forgeName} could not answer ${what} just now; try again in a minute.`, { code: 'unavailable', status: res.status, forge: forgeName });
    }
    if (!res.ok || !parsed || typeof parsed.access_token !== 'string' || parsed.access_token === '') {
      const said = parsed && typeof parsed.error_description === 'string' ? ` ${forgeName} said: "${parsed.error_description.slice(0, 200)}"` : '';
      throw new ForgeError(`${forgeName} did not give a token for ${what}.${said}`, { code: 'unauthorized', status: res.status, forge: forgeName });
    }
    // Forgejo always says how long an access token lasts (1 hour unless the instance changed it) and gives a refresh
    // token; GitHub does only for an app with token expiration on. A token that says nothing is not expiring
    const seconds = Number(parsed.expires_in);
    return {
      accessToken: parsed.access_token,
      refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '',
      expiresAt: Number.isFinite(seconds) && seconds > 0 ? iso(now() + seconds * 1000) : null,
    };
  }

  const exchange = (code, verifier) => tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }, 'this sign-in');

  /**
   * Renews a session's forge token with its refresh token, once at a time per session. `used` is the sealed token the
   * caller found stale: if the row holds another by now, somebody renewed it already and that is what answers. Persists
   * the new pair together (a rotated refresh token makes the old one useless). Answers the row; `NO_REFRESH` when the
   * session keeps no refresh token (a GitHub app whose tokens do not expire, the usual case: nothing changes for it);
   * or null when the session is over: the refresh token is refused (revoked, expired), and the row is ended so the
   * "sign in again" behaviour applies. Throws a ForgeError `unavailable` when the forge cannot be asked now: the session
   * stays and the next call tries again.
   * @param {string} id the session row's id
   * @param {string} used
   * @returns {Promise<SessionRow | typeof NO_REFRESH | null>}
   */
  function renew(id, used) {
    const going = renewals.get(id);
    if (going) return going;
    const job = (async () => {
      const file = await store();
      const row = /** @type {SessionRow | undefined} */ (file.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
      if (!row || row.token === NO_TOKEN) return null;
      if (row.token !== used) return row;
      const refresh = row.refresh_token === '' ? null : openFor(row, 'refresh_token');
      // Nothing to renew with: the session is left as it is, and the call that found the token stale gets the forge's own answer
      if (refresh === null) return NO_REFRESH;
      // Another process (cornfield restarted, or two behind one data folder) may renew the same row at the same time. The
      // forge rotates the refresh token, so the slower of the two is refused: that is a lost race, not a refused sign-in,
      // and the row the winner wrote is the answer. The write itself only lands on the row as it was read.
      const rowNow = () => /** @type {SessionRow | undefined} */ (file.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
      let got;
      try {
        got = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh }, 'a renewed sign-in');
      } catch (err) {
        if (err instanceof ForgeError && err.code === 'unauthorized') {
          const after = rowNow();
          if (after && after.token !== row.token && after.token !== NO_TOKEN) return after;
          if (after) await endRow(after);
          return null;
        }
        throw err;
      }
      const next = { ...row, token: sealFor(id, 'token', got.accessToken), refresh_token: got.refreshToken === '' ? row.refresh_token : sealFor(id, 'refresh_token', got.refreshToken), token_expires_at: got.expiresAt };
      const wrote = file.prepare('UPDATE sessions SET token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ? AND token = ? AND refresh_token = ?').run(next.token, next.refresh_token, next.token_expires_at, id, row.token, row.refresh_token).changes;
      if (wrote === 1) return next;
      // The row changed while the forge was asked: ended (sign-out), or renewed elsewhere. The row as it is now answers
      const after = rowNow();
      return after && after.token !== NO_TOKEN ? after : null;
    })().finally(() => renewals.delete(id));
    renewals.set(id, job);
    return job;
  }

  /**
   * The forge as the session's owner, with a token that renews itself: past (or about to pass) its expiry it is renewed
   * before the call, and a call the forge answers 401 is renewed once and made again. A renewal that cannot be had
   * ends the session and the call throws the same `unauthorized` ForgeError as a session that is gone.
   * @param {SessionRow} row
   */
  function managedForge(row) {
    let sealed = row.token;
    let expiresAt = row.token_expires_at;
    let forge = forgeWith(/** @type {string} */ (openFor({ id: row.id, token: sealed }, 'token')));
    const over = () => new ForgeError(`${forgeName} sign-in has to be renewed; sign in again.`, { code: 'unauthorized', forge: forgeName });
    /** Whether the token is a new one: false when this session cannot renew (the call goes on as it would have) */
    const renewNow = async () => {
      const next = await renew(row.id, sealed);
      if (next === NO_REFRESH) return false;
      const token = next ? openFor(next, 'token') : null;
      if (!next || token === null) throw over();
      sealed = next.token;
      expiresAt = next.token_expires_at;
      forge = forgeWith(token);
      return true;
    };
    const due = () => expiresAt !== null && Date.parse(expiresAt) - REFRESH_SKEW_MS <= now();
    /** Who the forge says this token is: the login a `permission` question about the owner names */
    let ownLogin = row.login;
    /**
     * What the call answered, looked at once on its way out: when the forge says the owner themself does not maintain the repo, their API
     * tokens (review, agent, runner) are revoked there and then, wherever in cornfield the question was asked
     */
    const noted = async (prop, args, result) => {
      if (prop === 'me' && result && typeof result.login === 'string') ownLogin = result.login;
      if (prop === 'permission' && args[0] === forgeConfig.repo && typeof args[1] === 'string' && args[1].toLowerCase() === ownLogin.toLowerCase() && !isMaintainer(result)) {
        await demoted(row.user_id, ownLogin, result);
      }
      return result;
    };
    return new Proxy({}, {
      get(_, prop) {
        const member = forge[prop];
        if (typeof member !== 'function' || prop === 'rateLimit') return member;
        return async (...args) => {
          if (due()) {
            try {
              await renewNow();
            } catch (err) {
              // Renewing ahead of time could not be done now (the forge is down): a token that has not expired yet still works
              const stillGood = expiresAt !== null && Date.parse(expiresAt) > now();
              if (!(err instanceof ForgeError && err.code === 'unavailable' && stillGood)) throw err;
            }
          }
          try {
            return await noted(prop, args, await forge[prop](...args));
          } catch (err) {
            if (!(err instanceof ForgeError) || err.code !== 'unauthorized') throw err;
            // The forge refused the token: renew it (when it can be) and ask once more; else its refusal stands
            if (!(await renewNow())) throw err;
          }
          return noted(prop, args, await forge[prop](...args));
        };
      },
    });
  }

  /**
   * A token owner the forge says no longer maintains the repo: every API token of theirs (review, agent and runner) is revoked at once, and
   * the revoking is a row in the audit table. Never throws: what learned it goes on with its own answer.
   * @param {string} userId
   * @param {string} login
   * @param {string} permission what the forge said
   */
  async function demoted(userId, login, permission) {
    try {
      const n = revokeOwnerTokens(await store(), userId, now());
      if (!n) return;
      try {
        (await store()).prepare('INSERT INTO actions (at, login, action, target, request, status, answer) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(iso(now()), login, 'token-revoke', forgeConfig.repo, JSON.stringify({ reason: 'owner-not-maintainer', permission }), null, JSON.stringify({ revoked: n }));
      } catch (err) {
        console.error(`[cornfield] the revoking of ${login}'s tokens could not be written to the audit table: ${err instanceof Error ? err.message : err}`);
      }
    } catch (err) {
      console.error(`[cornfield] the tokens of ${login}, no longer a maintainer, could not be revoked: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function callback(req, res, url) {
    // The state cookie is cleared only by an answer to the sign-in it belongs to: a link from anywhere else
    // (`/auth/callback?error=x`) cannot cancel one in progress
    const fail = (words, clear = true) => send(res, 400, failedPage(title, words), clear ? { 'Set-Cookie': clearState } : {});
    const checked = checkState(req, url);
    if (checked.error) return fail(checked.error, false);
    if (url.searchParams.get('error')) return fail(url.searchParams.get('error') === 'access_denied' ? `The sign-in was cancelled on ${forgeName}.` : `${forgeName} did not sign you in.`);
    const code = url.searchParams.get('code');
    if (!code || code.length > 1000) return fail(`${forgeName} came back without a sign-in code.`);
    let given;
    let user;
    let permission;
    try {
      given = await exchange(code, checked.verifier);
      const forge = forgeWith(given.accessToken);
      user = await forge.me();
      permission = await forge.permission(forgeConfig.repo, user.login);
    } catch (err) {
      return fail(err instanceof ForgeError ? err.message : `${forgeName} could not be asked who you are.`);
    }
    const value = random();
    const at = now();
    const token = given.accessToken;
    const file = await store();
    for (const old of file.prepare('SELECT * FROM sessions WHERE expires_at <= ?').all(iso(at))) await endRow(/** @type {SessionRow} */ (old));
    // Only a maintainer's token is kept; anyone else's is revoked at once (they are asked again at their next sign-in)
    const keep = isMaintainer(permission);
    const id = macOf(keys.mac, value);
    file.prepare('INSERT INTO sessions (id, forge, user_id, login, token, permission, created_at, checked_at, expires_at, refresh_token, token_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, forgeConfig.type, String(user.id), user.login, keep ? sealFor(id, 'token', token) : NO_TOKEN, permission, iso(at), iso(at), iso(at + sessionMs),
        keep && given.refreshToken !== '' ? sealFor(id, 'refresh_token', given.refreshToken) : '', keep ? given.expiresAt : null);
    if (!keep) {
      await revoke(token);
      // Signed in, and not a maintainer: whatever API tokens they made while they were one stop working now
      await demoted(String(user.id), user.login, permission);
    }
    redirect(res, checked.returnTo || '/', [cookie(SESSION_COOKIE, value, { maxAge: sessionMs / 1000, secure }), clearState]);
  }

  async function authRoute(req, res, reqPath, url) {
    const allow = { '/auth/sign-in': 'GET, HEAD', '/auth/start': 'GET, HEAD', '/auth/callback': 'GET, HEAD', '/auth/me': 'GET, HEAD', '/auth/sign-out': 'POST' }[reqPath];
    if (!allow) return send(res, 404, { ok: false, error: 'Not found' });
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (!allow.split(', ').includes(method)) {
      req.resume();
      return send(res, 405, { ok: false, error: 'Method not allowed' }, { Allow: allow });
    }
    if (reqPath === '/auth/sign-in') {
      const { session } = await currentSession(req);
      const back = safeReturn(url.searchParams.get('return'));
      if (session?.admin) return redirect(res, back || '/');
      return send(res, 200, req.method === 'HEAD' ? '' : signInPage(title, forgeName, back));
    }
    if (reqPath === '/auth/start') return start(res, url);
    if (reqPath === '/auth/callback') return callback(req, res, url);
    if (reqPath === '/auth/me') {
      const { session } = await currentSession(req);
      if (!session) return send(res, 401, { ok: false, error: 'Not signed in.' });
      return send(res, 200, { ok: true, login: session.login, permission: session.permission, admin: session.admin });
    }
    // /auth/sign-out
    req.resume();
    if (!sameOrigin(req, publicHost)) return send(res, 403, { ok: false, error: 'Sign out from cornfield\'s own page.' });
    const row = await rowOf(req);
    if (row) await endRow(row);
    return redirect(res, '/auth/sign-in', [clearSession]);
  }

  return {
    enabled: true,
    settings,
    /**
     * Runs before every route. `done`: the gate answered (a sign-in route, the sign-in page, a 401, 403 or 503);
     * otherwise `session` is the maintainer's, and the route answers.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {string} reqPath the decoded path
     * @param {URL} url
     * @returns {Promise<{ done: true } | { done: false, session: Session | null }>}
     */
    async gate(req, res, reqPath, url) {
      if (reqPath === '/auth' || reqPath.startsWith('/auth/')) {
        await authRoute(req, res, reqPath, url);
        return { done: true };
      }
      const { session, unchecked } = await currentSession(req);
      if (!session) {
        req.resume();
        answer(req, res, reqPath, 401, signInPage(title, forgeName, `${url.pathname}${url.search}`), 'Sign in first.');
        return { done: true };
      }
      if (unchecked) {
        req.resume();
        answer(req, res, reqPath, 503, uncheckedPage(title, unchecked), unchecked);
        return { done: true };
      }
      if (!session.admin) {
        req.resume();
        answer(req, res, reqPath, 403, askMaintainerPage(title, session.login, forgeConfig.repo), 'This is the dev dashboard; ask a maintainer.');
        return { done: true };
      }
      return { done: false, session };
    },
    /**
     * Writes one row of the `actions` audit table: who did what to what, when, and what the forge answered. The caller
     * decides what happens when this throws (the action it records has usually happened already).
     * @param {{ login: string, action: string, target: string, request?: object, status?: number | null, answer?: object | null }} entry
     */
    /**
     * What cornfield last heard of a user's permission on the repo: their newest sign-in's (asked of the forge at sign-in and every 15 minutes
     * while they use cornfield), or null when it has no sign-in of theirs at all. A runner token is not asked of the forge per call; this is its
     * cheap guard (server/runner-api.js).
     * @param {string} userId
     * @returns {Promise<string | null>}
     */
    async knownPermission(userId) {
      const row = /** @type {{ permission: string } | undefined} */ ((await store()).prepare('SELECT permission FROM sessions WHERE user_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1').get(String(userId)));
      return row ? row.permission : null;
    },
    /** Revokes a user's API tokens when cornfield has learned they no longer maintain the repo (see `demoted`) */
    demoted,
    async record({ login, action, target, request = {}, status = null, answer = null }) {
      (await store()).prepare('INSERT INTO actions (at, login, action, target, request, status, answer) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(iso(now()), login, action, target, JSON.stringify(request), status, answer === null ? null : JSON.stringify(answer));
    },
    /**
     * The first half of an audit row, written before anything is asked of the forge, so an action that never comes
     * back (a crash, a lost connection) still left its trace. Answers the row's id for `finish`.
     * @param {{ login: string, action: string, target: string, request?: object }} entry
     * @returns {Promise<number>}
     */
    async begin({ login, action, target, request = {} }) {
      return Number((await store()).prepare('INSERT INTO actions (at, login, action, target, request) VALUES (?, ?, ?, ?, ?)')
        .run(iso(now()), login, action, target, JSON.stringify(request)).lastInsertRowid);
    },
    /**
     * The rest of a row `begin` wrote: what was asked in the end, and what the forge (or cornfield) answered.
     * @param {number} id
     * @param {{ target?: string, request?: object, status?: number | null, answer?: object | null }} rest
     */
    async finish(id, { target, request, status = null, answer = null }) {
      const db = await store();
      if (target !== undefined) db.prepare('UPDATE actions SET target = ? WHERE id = ?').run(target, id);
      if (request !== undefined) db.prepare('UPDATE actions SET request = ? WHERE id = ?').run(JSON.stringify(request), id);
      db.prepare('UPDATE actions SET status = ?, answer = ? WHERE id = ?').run(status, answer === null ? null : JSON.stringify(answer), id);
    },
    /** The forge as a signed-in user, with their own token (for the routes that act on the forge) */
    forgeFor(session) {
      const token = session.row.token === NO_TOKEN ? null : openFor(session.row, 'token');
      if (token === null) throw new ForgeError(`${forgeName} sign-in has to be renewed; sign in again.`, { code: 'unauthorized', forge: forgeName });
      return managedForge(session.row);
    },
    /**
     * The forge as a user who may not be at the dashboard now, with the token their newest live sign-in keeps (a
     * maintainer's session row holds it, encrypted, until the session ends: sign-out, expiry, or a demotion). This is how
     * a review that came through the API (server/review-api.js) is posted as its token's owner. Throws a ForgeError
     * `unauthorized` when they have no live sign-in, so there is nothing to post with. It does not check the permission:
     * the caller asks the forge, with this token, every time.
     * @param {string} userId the forge's id for the user
     */
    async forgeForUser(userId) {
      const row = /** @type {SessionRow | undefined} */ ((await store()).prepare('SELECT * FROM sessions WHERE user_id = ? AND token <> ? AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(String(userId), NO_TOKEN, iso(now())));
      const token = row ? openFor(row, 'token') : null;
      if (token === null) throw new ForgeError(`The token's owner has no live sign-in to ${forgeName}; they sign in to cornfield again, then the token works again.`, { code: 'unauthorized', forge: forgeName });
      return managedForge(/** @type {SessionRow} */ (row));
    },
    /** The SQLite file (opened on first use), for the routes that keep answers in it (server/forge-routes.js) */
    store,
    close() {
      if (db?.isOpen) db.close();
      db = null;
      opening = null;
    },
  };
}

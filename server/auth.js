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

/** How often a session's permission is asked of the forge again */
export const RECHECK_MS = 15 * 60 * 1000;
/** How long a session lasts */
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
/** How long the way out to the forge and back may take */
export const STATE_MS = 10 * 60 * 1000;
export const MIN_SESSION_SECRET = 32;
const TOKEN_TIMEOUT_MS = 15_000;
const REVOKE_TIMEOUT_MS = 5_000;
/** What a session row keeps in place of a token when it keeps none (a signed-in non-maintainer) */
const NO_TOKEN = '';

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
 * The sign-in settings env gives, or null when sign-in is not configured at all. Throws, in words, when it is
 * half configured: one of a pair, no session secret, a short one, no public URL, no forge.
 * @param {{ forge?: { type: string, url?: string, repo: string } | null, publicUrl?: string | null }} config
 * @param {Record<string, string | undefined>} [env]
 * @returns {null | { forge: { type: string, url?: string, repo: string }, forgeName: string, clientId: string, clientSecret: string, sessionSecret: string, publicUrl: URL, secure: boolean }}
 */
export function signInSettings(config, env = process.env) {
  const set = (name) => typeof env[name] === 'string' && env[name] !== '';
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
    publicUrl, secure: publicUrl.protocol === 'https:',
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
export function sealToken(key, token) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return `v1.${b64url(iv)}.${b64url(c.getAuthTag())}.${b64url(body)}`;
}

/** The token a row holds, or null when it does not open under this key (another secret, or tampered) */
export function openToken(key, sealed) {
  const [v, iv, tag, body] = String(sealed).split('.');
  if (v !== 'v1' || !iv || !tag || body === undefined) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
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

/** The sign-in page */
export const signInPage = (title, forgeName) => pageHtml(title, `Sign in to ${title}`, `
<p>This is the dev dashboard. Sign in with ${escapeHtml(forgeName)} to see it; it is open to the repo's maintainers.</p>
<a class="button" href="/auth/start">Sign in with ${escapeHtml(forgeName)}</a>`);

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
 * @typedef {{ id: string, forge: string, user_id: string, login: string, token: string, permission: string, created_at: string, checked_at: string, expires_at: string }} SessionRow
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
      record: async () => { throw new Error('Sign-in is not configured.'); },
      store: null,
      close() {},
    };
  }

  const title = config.title || 'cornfield';
  const { forge: forgeConfig, forgeName, clientId, clientSecret, publicUrl, secure } = settings;
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
    if (row.token !== NO_TOKEN) await revoke(openToken(keys.enc, row.token));
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
    const token = openToken(keys.enc, row.token);
    if (token === null) {
      await endRow(row);
      return { session: null };
    }
    try {
      const forge = forgeWith(token);
      const user = await forge.me();
      if (String(user.id) !== row.user_id) {
        await endRow(row);
        return { session: null };
      }
      const permission = await forge.permission(forgeConfig.repo, user.login);
      const keep = isMaintainer(permission);
      const next = { ...row, login: user.login, permission, checked_at: iso(now()), token: keep ? row.token : NO_TOKEN };
      (await store()).prepare('UPDATE sessions SET login = ?, permission = ?, checked_at = ?, token = ? WHERE id = ?').run(next.login, next.permission, next.checked_at, next.token, row.id);
      if (!keep) await revoke(token);
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

  function start(res) {
    const state = random();
    const verifier = random();
    const expires = now() + STATE_MS;
    const payload = `${state}.${verifier}.${expires}`;
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
    if (endpoints.scope) q.set('scope', endpoints.scope);
    redirect(res, `${endpoints.authorize}?${q}`, [cookie(STATE_COOKIE, `${payload}.${macOf(keys.mac, `state:${payload}`)}`, { maxAge: STATE_MS / 1000, secure })]);
  }

  /** The verifier of a callback whose state matches its cookie, or the words for why not */
  function checkState(req, url) {
    const raw = parseCookies(req.headers.cookie)[STATE_COOKIE];
    const parts = raw ? raw.split('.') : [];
    if (parts.length !== 4) return { error: 'The sign-in was started in another browser, or too long ago.' };
    const [state, verifier, expires, mac] = parts;
    if (!sameText(mac, macOf(keys.mac, `state:${state}.${verifier}.${expires}`))) return { error: 'The sign-in was started in another browser, or too long ago.' };
    if (!(Number(expires) > now())) return { error: 'The sign-in took too long.' };
    if (!sameText(state, url.searchParams.get('state') || '')) return { error: 'The sign-in came back with an answer to another request.' };
    return { verifier };
  }

  /** The forge's token for a code, or throws a ForgeError */
  async function exchange(code, verifier) {
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier });
    let res;
    let parsed = null;
    try {
      res = await doFetch(endpoints.token, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'cornfield' }, body, redirect: 'manual', signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
      parsed = JSON.parse(await res.text());
    } catch (err) {
      throw new ForgeError(`${forgeName} did not answer the sign-in; try again in a minute.`, { code: 'unavailable', forge: forgeName, cause: err });
    }
    if (!res.ok || !parsed || typeof parsed.access_token !== 'string' || parsed.access_token === '') {
      const said = parsed && typeof parsed.error_description === 'string' ? ` ${forgeName} said: "${parsed.error_description.slice(0, 200)}"` : '';
      throw new ForgeError(`${forgeName} did not give a token for this sign-in.${said}`, { code: 'unauthorized', status: res.status, forge: forgeName });
    }
    return parsed.access_token;
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
    let token;
    let user;
    let permission;
    try {
      token = await exchange(code, checked.verifier);
      const forge = forgeWith(token);
      user = await forge.me();
      permission = await forge.permission(forgeConfig.repo, user.login);
    } catch (err) {
      return fail(err instanceof ForgeError ? err.message : `${forgeName} could not be asked who you are.`);
    }
    const value = random();
    const at = now();
    const file = await store();
    for (const old of file.prepare('SELECT * FROM sessions WHERE expires_at <= ?').all(iso(at))) await endRow(/** @type {SessionRow} */ (old));
    // Only a maintainer's token is kept; anyone else's is revoked at once (they are asked again at their next sign-in)
    const keep = isMaintainer(permission);
    file.prepare('INSERT INTO sessions (id, forge, user_id, login, token, permission, created_at, checked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(macOf(keys.mac, value), forgeConfig.type, String(user.id), user.login, keep ? sealToken(keys.enc, token) : NO_TOKEN, permission, iso(at), iso(at), iso(at + SESSION_MS));
    if (!keep) await revoke(token);
    redirect(res, '/', [cookie(SESSION_COOKIE, value, { maxAge: SESSION_MS / 1000, secure }), clearState]);
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
      if (session?.admin) return redirect(res, '/');
      return send(res, 200, req.method === 'HEAD' ? '' : signInPage(title, forgeName));
    }
    if (reqPath === '/auth/start') return start(res);
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
        answer(req, res, reqPath, 401, signInPage(title, forgeName), 'Sign in first.');
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
    async record({ login, action, target, request = {}, status = null, answer = null }) {
      (await store()).prepare('INSERT INTO actions (at, login, action, target, request, status, answer) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(iso(now()), login, action, target, JSON.stringify(request), status, answer === null ? null : JSON.stringify(answer));
    },
    /** The forge as a signed-in user, with their own token (for the routes that act on the forge) */
    forgeFor(session) {
      const token = session.row.token === NO_TOKEN ? null : openToken(keys.enc, session.row.token);
      if (token === null) throw new ForgeError(`${forgeName} sign-in has to be renewed; sign in again.`, { code: 'unauthorized', forge: forgeName });
      return forgeWith(token);
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

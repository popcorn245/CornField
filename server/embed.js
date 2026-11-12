/**
 * @module server/embed
 *
 * Letting a listed sibling app in (spec 0011 D9). The config's `embed.origins` (core/config.js `embedOrigin`: exact, canonical origins)
 * names pages that may ask this server for what the map and the review need, with the signed-in maintainer's own session, and decide
 * one review. Nothing here is on by default: with no origin listed `createEmbed(...).headers()` answers `{}`, nothing is answered
 * for a preflight and no write is let in, so every response is what it was before.
 *
 * What it decides (all pure: headers and paths in, headers and booleans out):
 *
 *   - **Reads**, on an explicit list of routes (`ROUTES`, default deny): for a request whose `Origin` is exactly a listed origin, the
 *     answer carries `Access-Control-Allow-Origin: <that origin>` (never `*`), `Vary: Origin`, and on the routes behind the session also
 *     `Access-Control-Allow-Credentials: true` and the headers the explorer reads (`X-Proposal-Sha256`, `X-Proposal-Source`,
 *     `X-Proposals-Forge-Error`). The routes that answer without a session (the theme) carry no `Allow-Credentials`: they hold nothing
 *     the session decides, and a fetch of them is made without credentials. Every other route, an `/api/*-tokens` and `/api/agent-runs`
 *     route and any other `/api/forge/*` route included, gets no CORS header at all.
 *   - **The preflight** (`OPTIONS` with `Access-Control-Request-Method`): answered for a listed origin on a route of the list, for the
 *     methods and request headers that route needs and no others (`Content-Type` on the two writes, none on a read).
 *   - **Writes**: today's same-origin rule stays for every write (server/proposals.js `sameOrigin`). For exactly two writes, the review
 *     PUT and the Undo of an approval's hold (`WRITES`), a listed origin is accepted too: its `Origin` must be exactly listed and
 *     `Sec-Fetch-Site` must be `same-site`, or missing (a browser too old to send it still sends `Origin` on a cross-origin PUT or POST;
 *     and the session cookie is `SameSite=Lax`, so a request that is not same-site arrives with no session to act as). Any other value
 *     (`cross-site`, `same-origin`, `none`) is refused. The caller has checked `Host` already (`sameOrigin` does it first).
 *   - **Signing in and returning**: `listedReturn` says whether a sign-in may end on an absolute URL: only one whose origin is listed.
 *
 * The session cookie is not touched here (HttpOnly, SameSite=Lax, host-only; server/auth.js). See docs/embedding.md.
 */

/** @typedef {{ test: RegExp | string, kind: 'session' | 'open', methods: string[], headers: string[] }} Route */

/** The headers the explorer reads from an answer: a page on another origin can read them only if they are exposed */
const EXPOSED = ['X-Proposal-Sha256', 'X-Proposal-Source', 'X-Proposals-Forge-Error'];

const READ = ['GET', 'HEAD'];
const SLUG = '[^/]+';

/**
 * The routes a listed origin may reach, and nothing else. `session`: behind the sign-in guard, so the credentialed form of CORS; `open`:
 * answered before it (the look of the sign-in pages: theme.css, a named theme, and the images and fonts a theme names).
 * `methods` are what a preflight may ask for; `headers` are the request headers it may list (lowercase).
 * @type {readonly Route[]}
 */
export const ROUTES = Object.freeze([
  { test: '/cornfield/config.json', kind: 'session', methods: READ, headers: [] },
  { test: '/topology.json', kind: 'session', methods: READ, headers: [] },
  { test: '/topology.cloud.json', kind: 'session', methods: READ, headers: [] },
  { test: '/proposals', kind: 'session', methods: READ, headers: [] },
  { test: new RegExp(`^/proposals/${SLUG}\\.json$`), kind: 'session', methods: READ, headers: [] },
  { test: new RegExp(`^/proposals/${SLUG}/decision$`), kind: 'session', methods: READ, headers: [] },
  // The review: read, and the one write a listed origin may make on a proposal (see `WRITES`)
  { test: new RegExp(`^/proposals/${SLUG}/review$`), kind: 'session', methods: [...READ, 'PUT'], headers: ['content-type'] },
  // The list of a proposal's mockups, not the files (`/mockups/<n>`)
  { test: new RegExp(`^/proposals/${SLUG}/mockups$`), kind: 'session', methods: READ, headers: [] },
  // One pull request: the proposal bar reads it
  { test: /^\/api\/forge\/pulls\/[1-9]\d{0,8}$/, kind: 'session', methods: READ, headers: [] },
  // The Undo of an approval's hold
  { test: /^\/api\/forge\/pulls\/[1-9]\d{0,8}\/landing\/cancel$/, kind: 'session', methods: ['POST'], headers: ['content-type'] },
  { test: '/cornfield/theme.css', kind: 'open', methods: READ, headers: [] },
  { test: /^\/cornfield\/theme\/[^/]+\.css$/, kind: 'open', methods: READ, headers: [] },
  { test: /^\/cornfield\/theme\/assets\/.+$/, kind: 'open', methods: READ, headers: [] },
]);

/**
 * The two writes a listed origin may make, as `[method, route]`. Every other write from a listed origin is refused exactly as a stranger's is.
 * (Which code path asks is decided where the write is handled: server/proposals.js `putPullReview`, server/lander.js `serveLanding`.)
 */
export const WRITES = Object.freeze(['PUT /proposals/<slug>/review', 'POST /api/forge/pulls/<n>/landing/cancel']);

/** @param {string} reqPath @returns {Route | null} */
export function routeOf(reqPath) {
  for (const r of ROUTES) if (typeof r.test === 'string' ? r.test === reqPath : r.test.test(reqPath)) return r;
  return null;
}

/**
 * Whether a write may come from a listed origin: its `Origin` is exactly one of `origins`, and `Sec-Fetch-Site` is `same-site` or not sent.
 * Only the two routes in `WRITES` ask. `Host` is not looked at here.
 * @param {Record<string, string | string[] | undefined>} headers a request's headers (Node's lowercase names)
 * @param {readonly string[]} origins
 */
export function listedWrite(headers, origins) {
  const origin = headers.origin;
  if (typeof origin !== 'string' || !origins.includes(origin)) return false;
  const site = headers['sec-fetch-site'];
  return site === undefined || site === 'same-site';
}

/** What an absolute way back may not hold: a control character, a space, or a backslash (browsers read `\` as `/`) */
const RETURN_BAD = /[\u0000- \u007f\\]/;
/** The longest absolute way back a sign-in keeps (it rides in the state cookie) */
export const RETURN_MAX = 1024;

/**
 * An absolute http(s) URL as the URL parser reads it, or null: with an explicit scheme (so `//host`, `javascript:` and a path are not one),
 * no control character, space or backslash, no user name or password, at most RETURN_MAX characters.
 * @param {unknown} raw
 * @returns {URL | null}
 */
export function absoluteUrl(raw) {
  if (typeof raw !== 'string' || raw === '' || raw.length > RETURN_MAX || RETURN_BAD.test(raw) || !/^https?:\/\/[^/?#]/i.test(raw)) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username !== '' || u.password !== '') return null;
  return u;
}

/**
 * Where a sign-in may end on another origin: the URL as parsed (`href`, so what is sent in `Location` is what was checked) when its origin
 * is exactly a listed one, else null. A different port, a longer host (`https://tasks.example.com.evil.test`), a user name
 * (`https://tasks.example.com@evil.test`) and a scheme other than the listed one all fail.
 * @param {unknown} raw
 * @param {readonly string[]} origins
 * @returns {string | null}
 */
export function listedReturn(raw, origins) {
  if (!origins.length) return null;
  const u = absoluteUrl(raw);
  if (!u || !origins.includes(u.origin) || u.href.length > RETURN_MAX) return null;
  return u.href;
}

/**
 * @param {readonly string[]} [origins] the config's `embed.origins`, canonical (core/config.js `embedOrigin`)
 */
export function createEmbed(origins = []) {
  const list = Object.freeze([...origins]);
  /** The one `Origin` of a request, when it is exactly a listed origin; two `Origin` headers are none */
  const listed = (req) => {
    if (!list.length) return null;
    let n = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'origin') n++;
    const o = req.headers.origin;
    return n === 1 && typeof o === 'string' && list.includes(o) ? o : null;
  };
  return {
    enabled: list.length > 0,
    origins: list,
    listed,
    /**
     * The headers to put on every answer of this request (the guard's 401 and the route's refusals included, so the page can read why):
     * `{}` unless an origin is listed and the path is on the list. `Vary: Origin` goes on the list's routes for every request, listed or
     * not (the answer differs by `Origin`); the CORS headers only for a listed origin and a method the route has.
     * @returns {Record<string, string>}
     */
    headers(req, reqPath) {
      if (!list.length) return {};
      const route = routeOf(reqPath);
      if (!route) return {};
      const out = { Vary: 'Origin' };
      const origin = listed(req);
      if (!origin || req.method === 'OPTIONS' || !route.methods.includes(req.method)) return out;
      out['Access-Control-Allow-Origin'] = origin;
      if (route.kind === 'session') {
        out['Access-Control-Allow-Credentials'] = 'true';
        out['Access-Control-Expose-Headers'] = EXPOSED.join(', ');
      }
      return out;
    },
    /**
     * The answer to a preflight, or null when it is none of ours (not `OPTIONS`, no `Access-Control-Request-Method`, an origin that is not
     * listed, a route off the list, a method or a request header the route does not take): the request then goes on as any other and
     * gets no CORS header, so the browser refuses it.
     * @returns {{ status: number, headers: Record<string, string> } | null}
     */
    preflight(req, reqPath) {
      if (!list.length || req.method !== 'OPTIONS') return null;
      const origin = listed(req);
      const asked = req.headers['access-control-request-method'];
      const route = routeOf(reqPath);
      if (!origin || !route || typeof asked !== 'string' || !route.methods.includes(asked)) return null;
      const wanted = String(req.headers['access-control-request-headers'] || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
      if (wanted.some((h) => !route.headers.includes(h))) return null;
      const headers = {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': route.methods.join(', '),
        'Access-Control-Max-Age': '600',
        Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
        'Content-Length': '0',
      };
      if (route.kind === 'session') headers['Access-Control-Allow-Credentials'] = 'true';
      if (route.headers.length) headers['Access-Control-Allow-Headers'] = 'Content-Type';
      return { status: 204, headers };
    },
  };
}

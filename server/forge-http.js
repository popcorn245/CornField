/**
 * @module server/forge-http
 *
 * What every forge adapter shares when it talks HTTP to its forge: one request with a time limit and a JSON
 * answer; `ForgeError`, in plain words, for anything that is not a 2xx (signed out, not allowed, not found, a rate
 * limit, the forge not answering); and pagination over `Link: <…>; rel="next"` (GitHub and Forgejo both send it).
 *
 * A token is only ever sent to the forge's own API origin: a `next` link to anywhere else ends the listing, and a
 * redirect is not followed (it is an error that says the repo has moved). Nothing here knows which forge it talks to beyond its name (for the words) and how
 * it reads its rate-limit headers.
 */

/** How long one request may take, in milliseconds */
export const REQUEST_TIMEOUT_MS = 15_000;
/** The most pages one listing follows (at 100 a page, 5000 items), so a runaway `next` cannot loop */
export const MAX_PAGES = 50;

/**
 * @typedef {'unauthorized' | 'forbidden' | 'not-found' | 'conflict' | 'invalid' | 'rate-limited' | 'unavailable' | 'not-green'} ForgeErrorCode
 * @typedef {{ limit: number | null, remaining: number | null, resetAt: string | null, retryAfter: number | null }} RateLimit
 */

/** A forge answer that is not what was asked for, in words a person can act on */
export class ForgeError extends Error {
  /**
   * @param {string} message plain words, shown as they are
   * @param {{ code: ForgeErrorCode, status?: number | null, forge?: string, rateLimit?: RateLimit | null, cause?: unknown }} details
   */
  constructor(message, { code, status = null, forge = '', rateLimit = null, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ForgeError';
    this.code = code;
    this.status = status;
    this.forge = forge;
    this.rateLimit = rateLimit;
  }
}

/** The URL of `rel="next"` in a `Link` header, or null */
export function nextLink(header) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(/,(?=\s*<)/)) {
    const m = /^\s*<([^>]*)>(.*)$/.exec(part);
    if (!m) continue;
    const rel = m[2].split(';').map((p) => /^\s*rel\s*=\s*"?([^"]*)"?\s*$/i.exec(p)?.[1]).find((r) => r !== undefined);
    if (rel && rel.toLowerCase().split(/\s+/).includes('next')) return m[1];
  }
  return null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "in about 6 minutes", "in 40 seconds", "now" */
function inWords(seconds) {
  if (seconds <= 0) return 'now';
  if (seconds < 90) return `in ${plural(Math.ceil(seconds), 'second')}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `in about ${plural(minutes, 'minute')}`;
  return `in about ${plural(Math.round(minutes / 60), 'hour')}`;
}

/**
 * A rate limit in words, for an error or a quiet line in the panel:
 *   - used up: "GitHub's limit for this sign-in is used up; it resets at 21:14 UTC (in about 6 minutes)."
 *   - slow down (a secondary limit, `Retry-After`): "GitHub asked cornfield to slow down; try again in 40 seconds."
 *   - otherwise: "48 of 5000 GitHub calls left; the count resets at 21:14 UTC (in about 6 minutes)."
 * Pure: `now` is passed in.
 * @param {string} forge the forge's name, like "GitHub"
 * @param {RateLimit} rate
 * @param {Date} [now]
 * @returns {string}
 */
export function rateLimitWords(forge, rate, now = new Date()) {
  if (rate.retryAfter != null) return `${forge} asked cornfield to slow down; try again ${inWords(rate.retryAfter)}.`;
  const reset = rate.resetAt ? new Date(rate.resetAt) : null;
  const when = reset && !Number.isNaN(reset.getTime())
    ? ` at ${reset.toISOString().slice(11, 16)} UTC (${inWords((reset.getTime() - now.getTime()) / 1000)})`
    : '';
  if (rate.remaining === 0) return `${forge}'s limit for this sign-in is used up; it resets${when || ' soon'}.`;
  if (rate.remaining == null) return `${forge} did not say how many calls are left.`;
  return `${rate.remaining}${rate.limit != null ? ` of ${rate.limit}` : ''} ${forge} calls left${when ? `; the count resets${when}` : ''}.`;
}

/** The forge's own words from an error answer (`{ message }` on both forges), at most one short line, or '' */
function forgeMessage(body) {
  const m = body && typeof body === 'object' && typeof body.message === 'string' ? body.message.split('\n')[0] : '';
  return m.length > 200 ? `${m.slice(0, 199)}…` : m;
}

/**
 * The error for an answer that is not a 2xx.
 * @param {string} forge
 * @param {number} status
 * @param {unknown} body the parsed body, or null
 * @param {RateLimit} rate
 * @param {string} what what was asked, for the words ("pull request #12")
 * @returns {ForgeError}
 */
export function errorFor(forge, status, body, rate, what) {
  const said = forgeMessage(body);
  const theirs = said ? ` ${forge} said: "${said}"` : '';
  const at = { status, forge, rateLimit: rate };
  if (status === 403 || status === 429) {
    // Used up, or a "slow down" (a secondary limit: a Retry-After, or only the forge's words; then wait a minute)
    if (rate.remaining === 0 || rate.retryAfter != null) return new ForgeError(rateLimitWords(forge, rate), { ...at, code: 'rate-limited' });
    if (status === 429 || /rate limit/i.test(said)) {
      const slow = { ...rate, retryAfter: 60 };
      return new ForgeError(rateLimitWords(forge, slow), { ...at, rateLimit: slow, code: 'rate-limited' });
    }
  }
  if (status >= 300 && status < 400) return new ForgeError(`${forge} says ${what} has moved; check forge.repo in cornfield.config.js.`, { ...at, code: 'not-found' });
  if (status === 401) return new ForgeError(`${forge} did not accept the sign-in; sign in again.`, { ...at, code: 'unauthorized' });
  if (status === 403) return new ForgeError(`${forge} does not let this sign-in do that to ${what}.${theirs}`, { ...at, code: 'forbidden' });
  if (status === 404) return new ForgeError(`${forge} has no ${what}, or this sign-in cannot see it.`, { ...at, code: 'not-found' });
  if (status === 405 || status === 409) return new ForgeError(`${forge} refused: ${what} cannot be changed that way now.${theirs}`, { ...at, code: 'conflict' });
  if (status === 400 || status === 422) return new ForgeError(`${forge} did not accept the request for ${what}.${theirs}`, { ...at, code: 'invalid' });
  return new ForgeError(`${forge} could not answer for ${what} (HTTP ${status}); try again in a minute.`, { ...at, code: 'unavailable' });
}

/** For a forge that sends no rate-limit headers: only a `Retry-After`, when there is one */
export function retryAfterOnly(headers) {
  const after = headers.get('retry-after');
  const seconds = after === null ? NaN : Number(after);
  return { limit: null, remaining: null, resetAt: null, retryAfter: Number.isFinite(seconds) ? seconds : null };
}

/**
 * A client for one forge's API.
 * @param {{
 *   forge: string,
 *   apiUrl: string,
 *   token?: string | null,
 *   authScheme?: string,
 *   headers?: Record<string, string>,
 *   readRateLimit?: (headers: Headers) => RateLimit,
 *   fetch?: typeof fetch,
 *   timeoutMs?: number,
 * }} opts `forge` is the name in words ("GitHub"); `apiUrl` the API's root; `token` the signed-in user's own;
 *   `authScheme` 'Bearer' (GitHub) or 'token' (Forgejo); `headers` go with every request
 */
export function createClient({ forge, apiUrl, token = null, authScheme = 'Bearer', headers = {}, readRateLimit = retryAfterOnly, fetch: doFetch = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const base = new URL(apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`);
  /** @type {RateLimit | null} */
  let lastRate = null;

  const urlOf = (pathOrUrl) => {
    const url = new URL(pathOrUrl.replace(/^\//, ''), base);
    if (url.origin !== base.origin) throw new ForgeError(`cornfield will not send a ${forge} sign-in to ${url.origin}.`, { code: 'invalid', forge });
    return url;
  };

  /**
   * One request. A 2xx answers `{ status, body, headers }` (body: the parsed JSON, the text when `raw`, or null when
   * empty); anything else throws a ForgeError, except a status in `allow`, which answers too (a 404 that means "none").
   * @param {string} method
   * @param {string} pathOrUrl a path under the API root, or a full URL on its origin (a `next` link)
   * @param {{ body?: unknown, what?: string, raw?: boolean, bytes?: boolean, accept?: string, allow?: number[] }} [opts]
   *   `bytes`: the body is a Buffer, not decoded (a picture)
   */
  async function request(method, pathOrUrl, { body, what = 'that', raw = false, bytes = false, accept, allow = [] } = {}) {
    const url = urlOf(pathOrUrl);
    /** @type {Record<string, string>} */
    const h = { 'User-Agent': 'cornfield', ...headers };
    if (accept) h.Accept = accept;
    if (token) h.Authorization = `${authScheme} ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    let res;
    let text;
    let buffer = null;
    try {
      res = await doFetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (bytes) buffer = Buffer.from(await res.arrayBuffer());
      text = buffer ? buffer.toString('utf8') : await res.text();
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError';
      throw new ForgeError(`${forge} did not answer${timedOut ? ` within ${plural(Math.max(1, Math.round(timeoutMs / 1000)), 'second')}` : ''}; try again in a minute.`, { code: 'unavailable', forge, cause: err });
    }
    lastRate = readRateLimit(res.headers);
    let parsed = null;
    if (text !== '' && !raw && !buffer) {
      try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    if (res.ok) {
      if (text !== '' && !raw && !buffer && parsed === null) {
        throw new ForgeError(`${forge} answered for ${what} with something that is not JSON.`, { code: 'unavailable', status: res.status, forge, rateLimit: lastRate });
      }
      return { status: res.status, body: buffer ?? (raw ? text : parsed), headers: res.headers };
    }
    if (allow.includes(res.status)) return { status: res.status, body: parsed, headers: res.headers };
    throw errorFor(forge, res.status, parsed, lastRate, what);
  }

  /**
   * Every item of a listing, following `next` links on the API's own origin, up to `limit` items.
   * @param {string} path the first page, with its query (and the page size as the forge names it)
   * @param {{ what?: string, limit?: number, items?: (body: any) => any[] }} [opts] `items` picks the list out of a
   *   page that wraps it (GitHub's check runs)
   */
  async function list(path, { what = 'that', limit = Infinity, items = (b) => b } = {}) {
    const out = [];
    let next = path;
    for (let page = 0; next && page < MAX_PAGES && out.length < limit; page++) {
      const { body, headers: got } = await request('GET', next, { what });
      const these = items(body);
      if (!Array.isArray(these)) throw new ForgeError(`${forge} answered for ${what} with something that is not a list.`, { code: 'unavailable', forge });
      out.push(...these);
      const link = nextLink(got.get('link'));
      next = link && new URL(link, base).origin === base.origin ? link : null;
    }
    return out.length > limit ? out.slice(0, limit) : out;
  }

  return { request, list, rateLimit: () => lastRate };
}

/**
 * @module explorer/engine/source-address
 *
 * The addresses of a cornfield server (spec 0011 D6), apart from the load that uses them (engine/source.js re-exports all of this): checking a `src`,
 * the server's sign-in and the origin of a page. They are small and a piece that has a `src` needs them at once (the instance's base is made from
 * the address), while the load itself, its states and the server's theme are a chunk that comes later (pieces/review-source.js, pieces/scope.js).
 */

export const SIGN_IN_PATH = '/auth/start';

/** A control character, a space or a backslash (a browser reads `\` as `/`): never in an address */
const BAD_CHAR = /[\u0000- \u007f\\]/;

/**
 * An address of a cornfield server, checked: an http(s) origin with an optional path, and nothing else (no user name, no query, no fragment).
 * `base` is what the instance is made with: the origin and the path without a trailing slash.
 * @param {unknown} src
 * @returns {{ ok: true, base: string, origin: string } | { ok: false, problem: string }}
 */
export function parseSource(src) {
  if (typeof src !== 'string' || !src.trim()) return { ok: false, problem: 'is empty' };
  const text = src.trim();
  if (BAD_CHAR.test(text)) return { ok: false, problem: 'has a space, a control character or a backslash' };
  let u;
  try { u = new URL(text); } catch { return { ok: false, problem: 'is not an address (an http or https address, as the server is opened in a browser)' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, problem: 'is not http or https' };
  if (!/^https?:\/\/[^/?#]/i.test(text)) return { ok: false, problem: 'has no host' };
  if (u.username || u.password) return { ok: false, problem: 'has a user name or password' };
  if (text.includes('?') || text.includes('#')) return { ok: false, problem: 'has a query or a fragment' };
  return { ok: true, base: u.origin + u.pathname.replace(/\/+$/, ''), origin: u.origin };
}

/**
 * The server's sign-in, which ends on the page it was asked from: `<base>/auth/start?returnTo=<page URL>` (docs/sign-in.md). The server follows
 * `returnTo` only for an origin its `embed.origins` lists. A page that is not http(s) (a file, about:blank) has nothing to return to. A user name
 * or password in the page's address (`https://user:pass@tasks.example.com/`) is never sent to the server: it is taken out (the server would refuse
 * such a `returnTo` anyway).
 * @param {string} base
 * @param {string} pageUrl
 */
export function signInUrl(base, pageUrl) {
  let back = '';
  if (typeof pageUrl === 'string' && /^https?:\/\//i.test(pageUrl)) {
    try {
      const u = new URL(pageUrl);
      u.username = '';
      u.password = '';
      back = `?returnTo=${encodeURIComponent(u.href)}`;
    } catch { back = ''; }
  }
  return `${base}${SIGN_IN_PATH}${back}`;
}

/** The origin of a page address, or '' */
export function originOf(url) {
  try { return /^https?:/i.test(url) ? new URL(url).origin : ''; } catch { return ''; }
}


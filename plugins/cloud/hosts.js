/**
 * @module plugins/cloud/hosts
 *
 * Finding the outside hosts a source file names, and what the code does with each (the code detector
 * of the cloud deriver): a call from the server, a fetch by the visitor's browser (a stylesheet or
 * preconnect `<link>`, a `<script>` or `<iframe>` src, an `<img>`, an import map, a CSS `@import` or
 * `url()`), or a link a person follows (an `<a href>`, a `<meta>`'s content, a markdown link, prose in a
 * page), which is described but never drawn.
 *
 * Only the host is kept: never a path, a query or a version string (they can carry an account or a key).
 * Pure: text in, hosts out.
 */

/** Names that never resolve to anyone's service (RFC 2606, RFC 6761, mDNS) */
const RESERVED = ['example.com', 'example.net', 'example.org', 'test', 'example', 'invalid', 'localhost', 'local', 'internal'];
/** A `<link rel>` that makes the browser fetch */
const FETCHING_RELS = /\b(?:stylesheet|preload|modulepreload|preconnect|dns-prefetch|prefetch|icon|manifest|apple-touch-icon)\b/i;
/** An https URL's host: the scheme, then a dotted name (an IPv4 address is one too) */
const URL_HOST = /https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?![a-z0-9-])/gi;
/** Comments out of JavaScript, keeping `https://` (the `//` after a colon or a quote is not a comment) */
export const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

const under = (host, domain) => host === domain || host.endsWith(`.${domain}`);

/** Whether a host is outside: not one of `ownDomains` (or under one), not a reserved name, not a private or tailnet address */
export function isOutsideHost(host, ownDomains = []) {
  const h = String(host).toLowerCase();
  if (ownDomains.some((d) => under(h, d)) || RESERVED.some((d) => under(h, d))) return false;
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    // Loopback, the private ranges, link-local, and the tailnet's CGNAT range
    if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  return true;
}

/** The `<name …>` element still open at the end of `before` (no `</name` after it), or null */
function openElement(before, name) {
  const lower = before.toLowerCase();
  const at = lower.lastIndexOf(`<${name}`);
  if (at < 0 || lower.indexOf(`</${name}`, at) >= 0) return null;
  const end = before.indexOf('>', at);
  return end < 0 ? null : before.slice(at, end + 1);
}

/** @typedef {{ context: 'server' | 'browser' | 'link', how?: string }} UrlContext */

/**
 * What a CSS context does with a URL right after `before`
 * @param {string} before
 * @returns {UrlContext}
 */
function cssContext(before) {
  if (/@import\s+(?:url\(\s*)?["']?$/i.test(before)) return { context: 'browser', how: 'CSS @import' };
  if (/url\(\s*["']?$/i.test(before)) return { context: 'browser', how: 'CSS url()' };
  return { context: 'link' };
}

/**
 * What the code does with the URL that starts at `at`: a call from the server, a fetch by the visitor's
 * browser (with what fetches it), or a link a person follows.
 * @param {string} text
 * @param {number} at
 * @param {'code' | 'html' | 'css'} type
 * @returns {{ context: 'server' | 'browser' | 'link', how?: string }}
 */
function contextAt(text, at, type) {
  const before = text.slice(Math.max(0, at - 4000), at);
  if (type === 'css') return cssContext(before);
  // An attribute of a tag: `<tag … attr="` right before the URL (a tag name is lower case and followed by a space)
  const attr = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\s[^<>]*?([\w:-]+)\s*=\s*["']?$/.exec(before);
  if (attr) {
    const [, tag, name] = attr;
    if (tag === 'link') {
      const close = text.indexOf('>', at);
      const whole = before.slice(attr.index) + text.slice(at, close < 0 ? at : close);
      const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(whole)?.[1] || '';
      return FETCHING_RELS.test(rel) ? { context: 'browser', how: 'link tag' } : { context: 'link' };
    }
    if (tag === 'a' || tag === 'meta' || tag === 'form' || name === 'href' || name === 'content' || name === 'action') return { context: 'link' };
    return { context: 'browser', how: tag === 'script' ? 'script tag' : tag };
  }
  const script = openElement(before, 'script');
  if (script) return /type\s*=\s*["']?importmap/i.test(script) ? { context: 'browser', how: 'import map' } : { context: 'browser', how: 'script tag' };
  if (openElement(before, 'style')) return cssContext(before);
  const css = cssContext(before);
  if (css.context === 'browser') return css;
  // A markdown link or an autolink is followed, not fetched; so is prose in a page
  if (/\]\(\s*$/.test(before) || /<$/.test(before) || type === 'html') return { context: 'link' };
  return { context: 'server' };
}

/**
 * Every outside https host in a file, in order, with what the code does with it.
 * @param {string} source
 * @param {'code' | 'html' | 'css'} type
 * @param {{ ownDomains?: string[] }} [opts] the repo's own domains: never outside
 * @returns {{ host: string, context: 'server' | 'browser' | 'link', how?: string }[]}
 */
export function hostsIn(source, type, { ownDomains = [] } = {}) {
  const text = type === 'html' ? source.replace(/<!--[\s\S]*?-->/g, ' ') : type === 'css' ? source.replace(/\/\*[\s\S]*?\*\//g, ' ') : stripComments(source);
  const out = [];
  for (const m of text.matchAll(URL_HOST)) {
    const host = m[1].toLowerCase();
    if (!isOutsideHost(host, ownDomains)) continue;
    const at = /** @type {number} */ (m.index);
    const found = contextAt(text, at, type);
    out.push({ host, ...(found.context === 'server' ? constantContext(text, at, type) || found : found) });
  }
  return out;
}

/**
 * A URL held in a constant (`const FONTS_URL = '…'`) does what the code does where it puts the constant:
 * `<link rel="stylesheet" href="${FONTS_URL}">` is a browser fetch. Null when the URL is not a constant's
 * value or nothing interpolates it into markup.
 */
function constantContext(text, at, type) {
  const name = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`]$/.exec(text.slice(Math.max(0, at - 200), at))?.[1];
  if (!name) return null;
  const uses = [...text.matchAll(new RegExp(`\\$\\{\\s*${name.replace(/\$/g, '\\$')}\\s*\\}`, 'g'))].map((u) => contextAt(text, /** @type {number} */ (u.index), type));
  return uses.find((u) => u.context === 'browser') || (uses.length && uses.every((u) => u.context === 'link') ? uses[0] : null);
}

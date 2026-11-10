/**
 * @module core/theme
 *
 * The `theme` key of cornfield.config.js (docs/config.md#theme), and the rules a theme file must keep.
 * Pure: no files are read here (core/validate.js reads them, server/server.js serves them).
 *
 *   theme: {
 *     css: './tools/cornfield/theme.css',                          // one repo-local stylesheet, loaded after cornfield's own
 *     fonts: ['https://fonts.googleapis.com/css2?family=Nunito'],   // an allow-list of https: stylesheet URLs
 *     fontHosts: [],                                                // the hosts of the font FILES, when a fonts host is not a known pair
 *     names: { day: './tools/cornfield/day.css' },                  // named themes: data-theme-name on <html>, a picker in the header
 *     default: 'day',                                               // the name used until a viewer picks one
 *   }
 *
 * A theme is CSS only: never script, never inlined into the page.
 */

import path from 'node:path';

export const THEME_KEYS = Object.freeze(['css', 'fonts', 'fontHosts', 'names', 'default']);
/** The largest a theme file may be, in bytes */
export const MAX_THEME_BYTES = 256 * 1024;
export const MAX_THEME_NAMES = 12;
export const MAX_THEME_FONTS = 8;
/** A theme's name: it is put on <html data-theme-name> and in a URL, so it is plain */
export const THEME_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Stylesheet hosts whose font files come from a known host (the host itself, when it serves both) */
export const KNOWN_FONT_PAIRS = Object.freeze({
  'fonts.googleapis.com': ['fonts.gstatic.com'],
  'fonts.bunny.net': ['fonts.bunny.net'],
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A path inside the repo, relative, ending in .css */
const cssPathInRepo = (p) => isText(p) && !path.isAbsolute(p) && !/^[a-z]:/i.test(p) && !p.split(/[\\/]/).includes('..') && !p.includes('\0') && /\.css$/i.test(p);

/**
 * A fonts entry as a parsed https URL, or null when it is not an acceptable one: https only, a plain
 * host name (no credentials, no wildcard, no IP address), no fragment.
 * @param {unknown} v
 * @returns {URL | null}
 */
export function fontUrl(v) {
  if (typeof v !== 'string' || v !== v.trim() || /[\s"'<>\\`]/.test(v)) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || !HOST.test(u.hostname) || /^\d+(?:\.\d+){3}$/.test(u.hostname)) return null;
  return u;
}

/**
 * What is wrong with a `theme` value (as the config file wrote it).
 * @param {unknown} t
 * @returns {string[]}
 */
export function themeProblems(t) {
  if (t === undefined) return [];
  if (!isObject(t)) return ['"theme" is { css?, fonts?, fontHosts?, names?, default? }.'];
  const out = [];
  for (const k of Object.keys(t)) if (!THEME_KEYS.includes(k)) out.push(`theme.${k}: the keys are ${THEME_KEYS.join(', ')}.`);
  if (t.css !== undefined && t.css !== null && !cssPathInRepo(t.css)) out.push('theme.css is one stylesheet (a .css file) inside the repo, written relative to it, like "./tools/cornfield/theme.css".');
  let pairsKnown = true;
  let fontCount = 0;
  if (t.fonts !== undefined) {
    if (!Array.isArray(t.fonts) || t.fonts.length > MAX_THEME_FONTS) out.push(`theme.fonts is a list of at most ${MAX_THEME_FONTS} https: stylesheet URLs.`);
    else {
      fontCount = t.fonts.length;
      t.fonts.forEach((f, i) => {
        const u = fontUrl(f);
        if (!u) out.push(`theme.fonts[${i}] must be an https: stylesheet URL with a plain host name (no http:, no data:, no credentials, no IP address).`);
        else if (!KNOWN_FONT_PAIRS[u.hostname]) pairsKnown = false;
      });
    }
  }
  const hosts = t.fontHosts;
  if (hosts !== undefined) {
    if (!Array.isArray(hosts) || hosts.length > MAX_THEME_FONTS || hosts.some((h) => typeof h !== 'string' || !HOST.test(h) || /^\d+(?:\.\d+){3}$/.test(h))) out.push(`theme.fontHosts is a list of at most ${MAX_THEME_FONTS} host names (like "fonts.example.org"): where the font files of theme.fonts come from.`);
    else if (!fontCount) out.push('theme.fontHosts only goes with theme.fonts.');
  }
  if (fontCount && !pairsKnown && !(Array.isArray(hosts) && hosts.length)) out.push(`theme.fonts names a host cornfield does not know the font file host of (known: ${Object.keys(KNOWN_FONT_PAIRS).join(', ')}): list where the font files come from in theme.fontHosts.`);
  let names = [];
  if (t.names !== undefined) {
    if (!isObject(t.names)) out.push('theme.names is { name: "./path.css" }.');
    else {
      names = Object.keys(t.names);
      if (names.length > MAX_THEME_NAMES) out.push(`theme.names lists at most ${MAX_THEME_NAMES} themes.`);
      for (const [n, p] of Object.entries(t.names)) {
        if (!THEME_NAME.test(n)) out.push(`theme.names "${n}": a name is lower-case letters, digits and hyphens, at most 32 characters.`);
        if (!cssPathInRepo(p)) out.push(`theme.names.${n} is a .css file inside the repo, written relative to it.`);
      }
    }
  }
  if (t.default !== undefined && t.default !== null) {
    if (!isText(t.default)) out.push('theme.default is the name of one of theme.names.');
    else if (!names.includes(t.default)) out.push(`theme.default "${t.default}" is not one of theme.names (${names.join(', ') || 'none are listed'}).`);
  }
  return out;
}

/** The font hosts a theme allows: `{ style, font }`, each a list of origins for the CSP (sorted, no repeats) */
export function fontOrigins(theme) {
  const style = new Set();
  const font = new Set();
  for (const f of (theme && theme.fonts) || []) {
    const u = fontUrl(f);
    if (!u) continue;
    style.add(u.origin);
    font.add(u.origin);
    for (const h of KNOWN_FONT_PAIRS[u.hostname] || []) font.add(`https://${h}`);
  }
  for (const h of (theme && theme.fontHosts) || []) if (HOST.test(h)) font.add(`https://${h}`);
  return { style: [...style].sort(), font: [...font].sort() };
}

/** The files a theme names, `[{ key, rel }]`: `css` is key "css", a named theme is `names.<name>` */
export function themeFiles(theme) {
  const out = [];
  if (theme && theme.css) out.push({ key: 'css', rel: theme.css });
  for (const [n, rel] of Object.entries((theme && theme.names) || {})) out.push({ key: `names.${n}`, rel });
  return out;
}

/** CSS escapes undone (`\6a ` and `\j` are both "j"), so a word cannot be hidden by writing it escaped */
function unescapeCss(s) {
  return s.replace(/\\([0-9a-f]{1,6})\s?|\\([^\n])/gi, (_m, hex, ch) => {
    if (hex) { const cp = parseInt(hex, 16); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; }
    return ch;
  });
}

const FORBIDDEN = [
  [/expression\s*\(/i, 'expression('],
  [/javascript\s*:/i, 'javascript:'],
  [/vbscript\s*:/i, 'vbscript:'],
  [/behaviou?r\s*:/i, 'behavior:'],
  [/-moz-binding/i, '-moz-binding'],
];

/**
 * What is wrong with a theme file's text: it must be plain CSS, and keep out of script. An `@import` is refused
 * unless it is an https: URL that is in the config's `theme.fonts`.
 * @param {string} text
 * @param {{ fonts?: string[] }} [opts] the config's allow-list
 * @returns {string[]}
 */
export function cssProblems(text, { fonts = [] } = {}) {
  const out = [];
  if (typeof text !== 'string' || text.includes('\0')) return ['is not text (it holds a NUL byte), so it is not CSS.'];
  const stripped = unescapeCss(text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ''));
  if (/<\s*\/?\s*(?:script|style|html|head|body|!doctype)\b/i.test(stripped) || /<!--/.test(stripped)) out.push('looks like HTML, not CSS.');
  for (const [re, word] of FORBIDDEN) if (re.test(stripped)) out.push(`uses ${word}, which a theme may not (a theme is CSS only, never script).`);
  const allowed = new Set(fonts);
  for (const m of stripped.matchAll(/@import\b\s*(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"');]*))/gi)) {
    const target = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!allowed.has(target) || !fontUrl(target)) out.push(`has an @import of "${target.slice(0, 80)}": only an https: URL listed in theme.fonts may be imported.`);
  }
  // Braces must balance (outside strings): a quick check that it is a stylesheet and not something else
  let depth = 0;
  let quote = null;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (quote) { if (ch === '\n') quote = null; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) break;
  }
  if (depth !== 0) out.push('has unbalanced braces, so it is not valid CSS.');
  return out;
}

/** The theme as the browser is told it: names and the default, never a path on this machine */
export function clientTheme(theme) {
  if (!theme) return null;
  const names = Object.keys(theme.names || {});
  return names.length ? { names, default: theme.default || null } : null;
}

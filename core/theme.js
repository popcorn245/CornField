/**
 * @module core/theme
 *
 * The `theme` key of cornfield.config.js (docs/config.md#theme), and the rules a theme file must keep.
 * No theme file is read here (core/validate.js reads them, server/server.js serves them); `themeAssetFile` alone looks at the disk,
 * so the server and `validate` find an asset beside a theme by the same rule.
 *
 *   theme: {
 *     css: './tools/cornfield/theme.css',                          // one repo-local stylesheet, loaded after cornfield's own
 *     fonts: ['https://fonts.googleapis.com/css2?family=Nunito'],   // an allow-list of https: stylesheet URLs
 *     fontHosts: [],                                                // the hosts of the font FILES, when a fonts host is not a known pair
 *     names: { day: './tools/cornfield/day.css' },                  // named themes: data-theme-name on <html>, a picker in the header
 *     default: 'day',                                               // the name used until a viewer picks one
 *     icons: { app: './tools/cornfield/icons/app.svg' },            // an icon per node kind, drawn inside the node on the map (svg or png)
 *     pixelated: true,                                              // small icons are drawn crisp (nearest-neighbour), not smoothed
 *     contrast: 'error',                                            // 'warn' turns a failing contrast pair in `validate` into a warning
 *   }
 *
 * A theme is CSS only: never script, never inlined into the page.
 */

import fs from 'node:fs';
import path from 'node:path';
import { NODE_THEMES } from './schema.js';

export const THEME_KEYS = Object.freeze(['css', 'fonts', 'fontHosts', 'names', 'default', 'icons', 'pixelated', 'contrast']);
/** The node kinds an icon may be set for: every node type of the map */
export const ICON_KINDS = Object.freeze(Object.keys(NODE_THEMES));
/** The file types of a node icon */
export const ICON_EXTENSIONS = Object.freeze(['.svg', '.png']);
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
  if (!isObject(t)) return ['"theme" is { css?, fonts?, fontHosts?, names?, default?, icons?, pixelated?, contrast? }.'];
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
  if (t.contrast !== undefined && t.contrast !== 'error' && t.contrast !== 'warn') out.push('theme.contrast is "error" (a pair below WCAG AA fails validate; the default) or "warn" (it is a warning).');
  if (t.default !== undefined && t.default !== null) {
    if (!isText(t.default)) out.push('theme.default is the name of one of theme.names.');
    else if (!names.includes(t.default)) out.push(`theme.default "${t.default}" is not one of theme.names (${names.join(', ') || 'none are listed'}).`);
  }
  if (t.pixelated !== undefined && typeof t.pixelated !== 'boolean') out.push('theme.pixelated is true or false.');
  if (t.icons !== undefined) {
    if (!isObject(t.icons)) out.push('theme.icons is { "<node kind>": "./path.svg" }.');
    else {
      for (const [kind, rel] of Object.entries(t.icons)) {
        if (!ICON_KINDS.includes(kind)) out.push(`theme.icons "${kind}": not a node kind (${ICON_KINDS.join(', ')}).`);
        const found = themeIconAsset(t, rel);
        if ('problem' in found) out.push(`theme.icons.${kind} ${found.problem}`);
      }
    }
  }
  return out;
}

/**
 * Where a node icon of the config is served, by its repo path: `{ asset }` (the path after THEME_ASSET_PREFIX) or `{ problem }`.
 * An icon is an .svg or .png file inside the repo, and inside the theme folder (themeAssetDir): it is served by the route that serves the
 * images beside a theme, nothing else. No disk is read here (core/validate.js checks the file).
 * @param {object} theme
 * @param {unknown} rel the icon's path as the config wrote it
 * @returns {{ asset: string } | { problem: string }}
 */
export function themeIconAsset(theme, rel) {
  if (!isText(rel) || path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.includes('\0') || rel.includes('\\') || rel.split('/').includes('..')) return { problem: 'is an .svg or .png file inside the repo, written relative to it, like "./tools/cornfield/icons/app.svg".' };
  if (!ICON_EXTENSIONS.includes(path.posix.extname(rel).toLowerCase())) return { problem: `(${rel}) is not an .svg or .png file.` };
  const dir = themeAssetDir(theme);
  if (!dir) return { problem: `(${rel}) cannot be served: icons are served beside the theme files, so the theme needs a stylesheet (theme.css or theme.names) in a folder, not at the top of the repo.` };
  const norm = path.posix.normalize(rel);
  if (!norm.startsWith(`${dir}/`)) return { problem: `(${rel}) is outside the theme folder ${dir}, the only folder whose images are served; put the icon under it.` };
  const asset = themeAssetPath(norm.slice(dir.length + 1));
  return asset ? { asset } : { problem: `(${rel}) has a name that cannot be served (letters, digits, ".", "_" and "-" only, no segment starting with a dot).` };
}

/** The icons the browser is told: `{ kind: '/cornfield/theme/assets/<path>' }`, those the config names validly */
export function iconUrls(theme) {
  const out = {};
  if (!theme || !isObject(theme.icons)) return out;
  for (const [kind, rel] of Object.entries(theme.icons)) {
    if (!ICON_KINDS.includes(kind)) continue;
    const found = themeIconAsset(theme, rel);
    if (!('problem' in found)) out[kind] = THEME_ASSET_PREFIX + found.asset;
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
 * The text with its comments replaced by `gap`, read as a browser tokenizes CSS: a comment marker inside a string is part of the
 * string (so `content: "/＊"` cannot hide what follows), an escaped character is never a marker, and an unclosed comment runs to the end.
 * @param {string} text
 * @param {string} gap
 */
export function withoutComments(text, gap) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { out += text.slice(i, i + 2); i++; continue; }
    if (quote) { if (ch === quote || ch === '\n') quote = null; out += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      out += gap;
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The ways a stylesheet's text is read for the checks, comments taken out as a browser does and CSS escapes undone: with each comment
 * as a space, as a browser reads it (`@import/＊＊/url(…)` is still an import), and with comments removed outright, so a word split by
 * one (`java/＊＊/script:`) is still found. A check that either fails, fails.
 */
const readings = (text) => [unescapeCss(withoutComments(text, ' ')), unescapeCss(withoutComments(text, ''))];

/** Every `@import` and what it names: `@import "x"`, `@import url(x)`, and an `@import` with nothing after it ('') */
const IMPORT = /@import\s*(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"');]*))/gi;

/**
 * What is wrong with a theme file's text: it must be plain CSS, and keep out of script. An `@import` is refused
 * unless it is an https: URL that is in the config's `theme.fonts`.
 * @param {string} text
 * @param {{ fonts?: string[] }} [opts] the config's allow-list
 * @returns {string[]}
 */
export function cssProblems(text, { fonts = [] } = {}) {
  if (typeof text !== 'string' || text.includes('\0')) return ['is not text (it holds a NUL byte), so it is not CSS.'];
  const out = new Set();
  const views = readings(text);
  if (views.some((v) => /<\s*\/?\s*(?:script|style|html|head|body|!doctype)\b/i.test(v) || /<!--/.test(v))) out.add('looks like HTML, not CSS.');
  for (const [re, word] of FORBIDDEN) if (views.some((v) => re.test(v))) out.add(`uses ${word}, which a theme may not (a theme is CSS only, never script).`);
  const allowed = new Set(fonts);
  for (const v of views) {
    for (const m of v.matchAll(IMPORT)) {
      const target = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      if (!allowed.has(target) || !fontUrl(target)) out.add(`has an @import of "${target.slice(0, 80)}": only an https: URL listed in theme.fonts may be imported.`);
    }
  }
  // Braces must balance (outside strings, escapes skipped): a quick check that it is a stylesheet and not something else
  const plain = withoutComments(text, '');
  let depth = 0;
  let quote = null;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === '\n') quote = null; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) break;
  }
  if (depth !== 0) out.add('has unbalanced braces, so it is not valid CSS.');
  return [...out];
}

// ---------------------------------------------------------------------------
//  Assets beside a theme: images and fonts a theme's url() names
// ---------------------------------------------------------------------------

/** Where the files beside a theme are served (server/server.js): `/cornfield/theme/assets/<path under the theme folder>` */
export const THEME_ASSET_PREFIX = '/cornfield/theme/assets/';
/** The largest a theme asset may be, in bytes */
export const MAX_THEME_ASSET_BYTES = 1024 * 1024;
/** The only files served beside a theme, by lower-case extension: images and fonts, never a page or a script */
export const THEME_ASSET_TYPES = Object.freeze({
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
});
/** An SVG is an image here, never a page: if it is opened on its own it may not run or load anything */
export const THEME_SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'";
/** A `data:` URL a theme may use in url(): an image */
const DATA_IMAGE = /^data:image\/(?:png|gif|webp|avif|svg\+xml)[;,]/i;
const ASSET_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The served path of a theme file, by its key from `themeFiles` */
export const themeFileUrl = (key) => (key === 'css' ? '/cornfield/theme.css' : `/cornfield/theme/${key.slice('names.'.length)}.css`);

/**
 * The path under the theme folder that an asset request names (the decoded part after THEME_ASSET_PREFIX), or null when it is not
 * one that may be served: plain ASCII segments (letters, digits, `.`, `_`, `-`), none empty, none starting with a dot (so no `..`,
 * no `.git`), no backslash, at most 8 deep, and a THEME_ASSET_TYPES extension.
 * @param {string} rest
 * @returns {string | null}
 */
export function themeAssetPath(rest) {
  if (typeof rest !== 'string' || rest.length > 512) return null;
  const parts = rest.split('/');
  if (parts.length > 8 || !parts.every((p) => ASSET_SEGMENT.test(p))) return null;
  return THEME_ASSET_TYPES[path.posix.extname(rest).toLowerCase()] ? parts.join('/') : null;
}

/**
 * The repo folder whose images and fonts are served beside the theme (relative, with `/`): the folder of the theme files, or the
 * deepest one that holds them all when they sit in different folders. null when there are no theme files or that folder is the
 * repo's top, so a theme at the top of the repo never opens the whole repo's images.
 * @param {object} theme
 * @returns {string | null}
 */
export function themeAssetDir(theme) {
  const dirs = themeFiles(theme).map(({ rel }) => path.posix.normalize(String(rel).replace(/\\/g, '/')).split('/').slice(0, -1).filter((p) => p && p !== '.'));
  if (!dirs.length) return null;
  const common = [];
  for (let i = 0; dirs.every((d) => i < d.length && d[i] === dirs[0][i]); i++) common.push(dirs[0][i]);
  return common.length && !common.includes('..') ? common.join('/') : null;
}

/**
 * Every url() (and src()) a stylesheet names, as written, escapes undone, comments and @import rules left out (an @import is
 * cssProblems's to check).
 * @param {string} text
 * @returns {string[]}
 */
export function cssUrls(text) {
  if (typeof text !== 'string') return [];
  const css = unescapeCss(withoutComments(text, ' ')).replace(/@import\b[^;]*;?/gi, ' ');
  return [...css.matchAll(/(?<![\w-])(?:url|src)\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)].map((m) => (m[1] ?? m[2] ?? m[3] ?? '').trim());
}

/**
 * Where a url() in a theme file leads, read as the browser reads it: relative to where that file is served (`/cornfield/theme.css`
 * or `/cornfield/theme/<name>.css`). `{ data: true }` for a data: image, `{ asset }` for a path under THEME_ASSET_PREFIX that may
 * be served (themeAssetPath), else `{ problem }`.
 * @param {string} ref what url() holds
 * @param {string} servedAt the file's served path (themeFileUrl)
 * @returns {{ data?: true, asset?: string, problem?: string }}
 */
export function themeUrlTarget(ref, servedAt) {
  if (DATA_IMAGE.test(ref)) return { data: true };
  const why = `url(${ref.slice(0, 80)}) is not an image or font served beside the theme: write it as ${THEME_ASSET_PREFIX}<path> (a png, svg, webp, gif, avif, woff2 or woff file under the theme's folder), or as a data: image.`;
  if (!ref) return { problem: why };
  let u;
  try { u = new URL(ref, `https://cornfield.invalid${servedAt}`); } catch { return { problem: why }; }
  if (u.origin !== 'https://cornfield.invalid' || !u.pathname.startsWith(THEME_ASSET_PREFIX)) return { problem: why };
  let rest;
  try { rest = decodeURIComponent(u.pathname.slice(THEME_ASSET_PREFIX.length)); } catch { return { problem: why }; }
  const asset = themeAssetPath(rest);
  return asset ? { asset } : { problem: why };
}

/** The theme as the browser is told it: names and the default, the icons' served paths and the pixelated flag, never a path on this machine */
export function clientTheme(theme) {
  if (!theme) return null;
  const names = Object.keys(theme.names || {});
  const icons = iconUrls(theme);
  const pixelated = theme.pixelated === true;
  if (!names.length && !Object.keys(icons).length && !pixelated) return null;
  return { names, default: names.length ? theme.default || null : null, ...(Object.keys(icons).length ? { icons } : {}), ...(pixelated ? { pixelated } : {}) };
}

/**
 * The file on disk an asset path names (themeAssetPath's result), or why there is none: it must be a plain file under the theme folder
 * (themeAssetDir) once links are followed (a link that leads out of that folder is refused), at most MAX_THEME_ASSET_BYTES.
 * @param {string} root the repo
 * @param {object} theme the config's theme
 * @param {string} rel the asset path
 * @returns {{ file: string, size: number, type: string } | { problem: string }}
 */
export function themeAssetFile(root, theme, rel) {
  const dir = themeAssetDir(theme);
  if (!dir) return { problem: 'no theme folder serves assets (the theme files are at the top of the repo, so nothing beside them is served; put them in a folder).' };
  const type = THEME_ASSET_TYPES[path.posix.extname(rel).toLowerCase()];
  if (!type || themeAssetPath(rel) !== rel) return { problem: 'is not an image or font file name that may be served.' };
  let base;
  let real;
  try {
    const top = fs.realpathSync(root);
    base = fs.realpathSync(path.join(root, ...dir.split('/')));
    if (!base.startsWith(top + path.sep)) return { problem: `the theme folder ${dir} leaves the repo.` };
  } catch { return { problem: `the theme folder ${dir} does not exist.` }; }
  try { real = fs.realpathSync(path.join(base, ...rel.split('/'))); } catch { return { problem: `${dir}/${rel} does not exist.` }; }
  if (!real.startsWith(base + path.sep)) return { problem: `${dir}/${rel} leads out of the theme folder (a link).` };
  const stats = fs.statSync(real);
  if (!stats.isFile()) return { problem: `${dir}/${rel} is not a file.` };
  if (stats.size > MAX_THEME_ASSET_BYTES) return { problem: `${dir}/${rel} is ${Math.ceil(stats.size / 1024)} KB; an asset beside a theme is at most ${MAX_THEME_ASSET_BYTES / 1024 / 1024} MB.` };
  return { file: real, size: stats.size, type };
}

/**
 * What is wrong with the icon files of the config (`theme.icons`): each one exists as a plain file under the theme folder (a link out of it is
 * refused), is at most MAX_THEME_ASSET_BYTES, and is what its extension says (an .svg is text with an <svg> element and no script, a .png starts
 * with the PNG signature). The server serves an icon only if themeAssetFile finds it, so this is the same rule.
 * @param {{ root: string, theme?: object }} config
 * @returns {string[]}
 */
export function themeIconFileProblems(config) {
  const out = [];
  const icons = config.theme && isObject(config.theme.icons) ? config.theme.icons : {};
  for (const [kind, rel] of Object.entries(icons)) {
    const where = `theme.icons.${kind} (${rel})`;
    const target = themeIconAsset(config.theme, rel);
    if ('problem' in target) { out.push(`${where} ${target.problem}`); continue; }
    const found = themeAssetFile(config.root, config.theme, target.asset);
    if ('problem' in found) { out.push(`${where} ${found.problem}`); continue; }
    let head;
    try { head = fs.readFileSync(found.file); } catch { out.push(`${where} cannot be read.`); continue; }
    if (path.posix.extname(target.asset).toLowerCase() === '.png') {
      if (!head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) out.push(`${where} is not a PNG image.`);
    } else {
      const text = head.toString('utf8');
      if (!/<svg[\s>]/i.test(text)) out.push(`${where} is not an SVG image (no <svg> element).`);
      else if (/<\s*script\b|\son[a-z]+\s*=|javascript\s*:/i.test(text)) out.push(`${where} holds script, which an icon may not (an icon is an image only).`);
    }
  }
  return out;
}

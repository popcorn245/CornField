/**
 * @module core/brand
 *
 * The `brand` key of cornfield.config.js (docs/config.md#brand), and the rules a brand asset must keep.
 * `brandAssetFile` is the one place that looks at an asset on disk, so the server and `cornfield validate` judge a file by the same rule.
 *
 *   brand: {
 *     logo: './tools/cornfield/logo.svg',        // replaces the brand mark in the header
 *     wordmark: './tools/cornfield/word.svg',    // replaces the title text in the header
 *     favicon: './tools/cornfield/favicon.png',  // <link rel="icon">
 *     appName: 'Acme',                           // replaces "cornfield" in visible chrome and the tab title
 *     color: '#e53e3e',                          // the manifest's theme_color (and the tab's theme-color)
 *     background: '#ffffff',                     // the manifest's background_color
 *   }
 *
 * Images only, from the repo only, served same-origin and never inlined into the page.
 */

import fs from 'node:fs';
import path from 'node:path';

export const BRAND_KEYS = Object.freeze(['logo', 'wordmark', 'favicon', 'appName', 'color', 'background']);
/** The keys that name an image file */
export const BRAND_IMAGE_KEYS = Object.freeze(['logo', 'wordmark', 'favicon']);
/** The largest a brand asset may be, in bytes */
export const MAX_BRAND_BYTES = 512 * 1024;
export const MAX_APP_NAME = 64;
/** Where the brand images are served (server/server.js): `/cornfield/brand/<key>.<ext>`, only for a key the config sets */
export const BRAND_PREFIX = '/cornfield/brand/';
export const MANIFEST_PATH = '/manifest.webmanifest';
/** The only brand image types, by lower-case extension */
export const BRAND_TYPES = Object.freeze({ '.svg': 'image/svg+xml', '.png': 'image/png' });
/** An SVG is an image here, never a page: opened on its own it may not run or load anything */
export const BRAND_SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'";
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const unset = (v) => v === undefined || v === null;
/** A path inside the repo, relative, ending in .svg or .png */
const imagePathInRepo = (p) => isText(p) && !path.isAbsolute(p) && !/^[a-z]:/i.test(p) && !p.split(/[\\/]/).includes('..') && !p.includes('\0') && Boolean(BRAND_TYPES[path.extname(p).toLowerCase()]);

/**
 * What is wrong with a `brand` value (as the config file wrote it).
 * @param {unknown} b
 * @returns {string[]}
 */
export function brandProblems(b) {
  if (b === undefined) return [];
  if (!isObject(b)) return ['"brand" is { logo?, wordmark?, favicon?, appName?, color?, background? }.'];
  const out = [];
  for (const k of Object.keys(b)) if (!BRAND_KEYS.includes(k)) out.push(`brand.${k}: the keys are ${BRAND_KEYS.join(', ')}.`);
  for (const k of BRAND_IMAGE_KEYS) {
    if (!unset(b[k]) && !imagePathInRepo(b[k])) out.push(`brand.${k} is one image (an .svg or .png file) inside the repo, written relative to it, like "./tools/cornfield/${k}.svg".`);
  }
  if (!unset(b.appName) && (typeof b.appName !== 'string' || !b.appName.trim() || b.appName.length > MAX_APP_NAME || /[\u0000-\u001f\u007f]/.test(b.appName))) {
    out.push(`brand.appName is text of at most ${MAX_APP_NAME} characters, on one line.`);
  }
  for (const k of ['color', 'background']) {
    if (!unset(b[k]) && !(typeof b[k] === 'string' && HEX_COLOR.test(b[k]))) out.push(`brand.${k} is a hex colour, like "#e53e3e" or "#e33".`);
  }
  return out;
}

/** Whether the brand sets anything at all */
export const brandOn = (brand) => Boolean(brand) && BRAND_KEYS.some((k) => !unset(brand[k]));

/** The name chrome shows: the brand's `appName`, else null (the caller falls back to the repo's title or "cornfield") */
export const appNameOf = (brand) => (brand && typeof brand.appName === 'string' && brand.appName.trim() ? brand.appName.trim() : null);

/**
 * The images a brand names, `[{ key, rel, url, type }]`: the url is where the server serves it (`/cornfield/brand/<key>.<ext>`).
 * @param {object} brand
 */
export function brandImages(brand) {
  const out = [];
  for (const key of BRAND_IMAGE_KEYS) {
    const rel = brand && brand[key];
    if (!imagePathInRepo(rel)) continue;
    const ext = path.extname(rel).toLowerCase();
    out.push({ key, rel, url: `${BRAND_PREFIX}${key}${ext}`, type: BRAND_TYPES[ext] });
  }
  return out;
}

/**
 * The brand as the browser is told it: URLs and the name, never a path on this machine. null when nothing is set.
 * @param {object} brand
 * @param {string} poweredBy where "powered by cornfield" leads
 */
export function clientBrand(brand, poweredBy) {
  if (!brandOn(brand)) return null;
  const urls = Object.fromEntries(brandImages(brand).map((i) => [i.key, i.url]));
  return { logo: urls.logo || null, wordmark: urls.wordmark || null, favicon: urls.favicon || null, appName: appNameOf(brand), poweredBy };
}

/** Whether the first bytes of an SVG file are an SVG document: optional BOM, space, an xml declaration, comments and a doctype, then `<svg` */
function looksLikeSvg(buf) {
  let s = buf.toString('utf8').replace(/^﻿/, '');
  for (;;) {
    s = s.replace(/^\s+/, '');
    const skip = /^(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>)/i.exec(s);
    if (!skip) break;
    s = s.slice(skip[0].length);
  }
  return /^<svg[\s>/]/.test(s);
}

/** Whether a file's bytes are what its extension says (`.png`: the PNG signature; `.svg`: an SVG document) */
export function magicMatches(ext, buf) {
  if (ext === '.png') return buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
  if (ext === '.svg') return !buf.includes(0) && looksLikeSvg(buf);
  return false;
}

/** A PNG's width and height from its header, or null */
export function pngSize(buf) {
  if (!magicMatches('.png', buf) || buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/**
 * The file on disk a brand image names, or why there is none: a plain file whose real path is inside the repo (a link out is
 * refused), with an allowed extension and bytes that match it, at most MAX_BRAND_BYTES.
 * @param {string} root the repo
 * @param {string} rel the path as the config wrote it
 * @returns {{ file: string, size: number, type: string, ext: string, body: Buffer } | { problem: string }}
 */
export function brandAssetFile(root, rel) {
  const ext = typeof rel === 'string' ? path.extname(rel).toLowerCase() : '';
  const type = BRAND_TYPES[ext];
  if (!type) return { problem: 'is not an .svg or .png file.' };
  let base;
  let real;
  try { base = fs.realpathSync(root); } catch { return { problem: 'the repo does not exist.' }; }
  try { real = fs.realpathSync(path.resolve(root, rel)); } catch { return { problem: 'does not exist.' }; }
  if (!real.startsWith(base + path.sep)) return { problem: 'leaves the repo (a link or a path that resolves outside it).' };
  const stats = fs.statSync(real);
  if (!stats.isFile()) return { problem: 'is not a file.' };
  if (stats.size > MAX_BRAND_BYTES) return { problem: `is ${Math.ceil(stats.size / 1024)} KB; a brand image is at most ${MAX_BRAND_BYTES / 1024} KB.` };
  const body = fs.readFileSync(real);
  if (body.length > MAX_BRAND_BYTES) return { problem: `is over ${MAX_BRAND_BYTES / 1024} KB; a brand image is at most that.` };
  if (!magicMatches(ext, body)) return { problem: `is not really ${ext === '.png' ? 'a PNG' : 'an SVG'} (its first bytes do not match its ${ext} extension).` };
  return { file: real, size: body.length, type, ext, body };
}

/**
 * The web app manifest for a brand (served at MANIFEST_PATH): name and short name from `appName` or the repo's title, the favicon
 * and the logo as icons, the colours when the config sets them, standalone, starting at `/`.
 * @param {object} brand
 * @param {string} title the repo's title
 * @param {(rel: string) => { body: Buffer } | { problem: string }} readImage
 */
export function manifestOf(brand, title, readImage) {
  const name = appNameOf(brand) || title;
  const icons = [];
  const seen = new Set();
  for (const img of brandImages(brand).filter((i) => i.key !== 'wordmark').sort((a, b) => a.key.localeCompare(b.key))) { // favicon, then logo
    if (seen.has(img.rel)) continue;
    seen.add(img.rel);
    const found = readImage(img.rel);
    if ('problem' in found) continue;
    const size = img.type === 'image/png' ? pngSize(found.body) : null;
    icons.push({ src: img.url, type: img.type, sizes: img.type === 'image/png' ? (size ? `${size.width}x${size.height}` : '') : 'any', purpose: 'any' });
  }
  return {
    name,
    short_name: [...name].slice(0, 12).join(''),
    start_url: '/',
    display: 'standalone',
    ...(brand && brand.color ? { theme_color: brand.color } : {}),
    ...(brand && brand.background ? { background_color: brand.background } : {}),
    icons: icons.map((i) => (i.sizes ? i : { src: i.src, type: i.type, purpose: i.purpose })),
  };
}

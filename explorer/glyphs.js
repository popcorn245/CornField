/**
 * @module explorer/glyphs
 *
 * The built-in glyph of each node type (spec 0008 D8): a small monochrome picture drawn in the middle of a node once it is 14 px across on screen,
 * where the white core dot is. It tells types of one silhouette apart beyond their colour. Both renderers draw the same picture, made once here as
 * a small transparent image (like kind-letters.js), and by the same rule:
 *
 *   a theme's icon for the node (`theme.icons`)  >  a finer kind's letters (spec 0009, kind-letters.js)  >  the type's glyph  >  the white core dot
 *
 * Canvas 2D draws the image with `drawImage` where an icon would go; WebGL uploads it as a texture and draws it in the icon pass, grouped by
 * `glyph:<type>|<ink>`. The glyphs are a fixed set (one per type in core/schema.js, nothing a map holds), in two inks at most per type
 * (white or dark, whichever reads on the node's fill; or the theme's `--corn-map-glyph`), so the textures are few and bounded.
 */

import { NODE_THEMES } from '../core/schema.js';
import { parseColor } from './theme-model.js';

/** A node is at least this many px across (on screen) before its glyph is drawn: smaller, no glyph reads and the silhouette does the work */
export const GLYPH_MIN_PX = 14;
/** The glyph's box, as a fraction of the node's radius across (a square centred on the node, like an icon) */
export const GLYPH_RATIO = 1.2;
const SIDE = 96;
const GRID = 24; // the glyphs are drawn on a 24 by 24 grid
const KEY_PREFIX = 'glyph:';
/** The two inks the glyph takes when the theme does not set `--corn-map-glyph`: white on a deep fill, dark on a pale one */
export const INK_LIGHT = '#ffffff';
export const INK_DARK = '#0b1220';
/** The most glyph images made: types times inks is far under it; a theme that sets many colours at once cannot grow it */
export const MAX_GLYPH_IMAGES = 64;

/** Types that have a glyph: the built-in ones. A type a project invents has none (it keeps the white core dot) */
export const GLYPH_TYPES = Object.freeze(Object.keys(NODE_THEMES));
export const hasGlyph = (type) => typeof type === 'string' && Object.hasOwn(NODE_THEMES, type);

/** The key a glyph goes under in the renderers' icon tables */
export const glyphKey = (type, ink) => `${KEY_PREFIX}${type}|${ink}`;
export const isGlyphKey = (key) => typeof key === 'string' && key.startsWith(KEY_PREFIX);
/** @returns {{type: string, ink: string}} */
export function glyphOfKey(key) {
  const rest = key.slice(KEY_PREFIX.length);
  const at = rest.indexOf('|');
  return { type: rest.slice(0, at), ink: rest.slice(at + 1) };
}

const luminanceOf = ([r, g, b]) => {
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratioOf = (a, b) => { const [hi, lo] = a > b ? [a, b] : [b, a]; return (hi + 0.05) / (lo + 0.05); };

/** The ink that reads on a fill: white or dark, whichever has the higher contrast (the glyph is at least 3:1 on every fill of the default palette: a test holds it) */
export function inkFor(fill) {
  const lum = luminanceOf(parseColor(fill));
  return ratioOf(1, lum) >= ratioOf(luminanceOf(parseColor(INK_DARK)), lum) ? INK_LIGHT : INK_DARK;
}

/** The ink a node's glyph is drawn in: the theme's (`--corn-map-glyph`, in the style's `values`), else the one that reads on its fill */
export const glyphInk = (node, style) => (style && style.values && style.values['--corn-map-glyph']) || inkFor(node.color);

/** Whether a node's glyph is drawn at this zoom: it has one, no icon or letters replace it, and it is wide enough on screen */
export const showsGlyph = (node, zoom) => !!node.glyph && !node.icon && !node.letters && node.r * 2 * zoom >= GLYPH_MIN_PX;

/** The glyph of each type: a function that adds its strokes and fills to a 24 by 24 grid (`ink` is already the fill and stroke style) */
const PATHS = {
  root: (c) => { ring(c, 12, 12, 8); dot(c, 12, 12, 3.2); },
  app: (c) => { c.beginPath(); c.rect(3.5, 5, 17, 14); c.stroke(); line(c, 3.5, 9.5, 20.5, 9.5); },
  page: (c) => { c.beginPath(); c.rect(6, 3.5, 12, 17); c.stroke(); line(c, 9, 9, 15, 9); line(c, 9, 12.5, 15, 12.5); line(c, 9, 16, 13, 16); },
  pkg: (c) => { c.beginPath(); c.rect(4, 7, 16, 13); c.stroke(); line(c, 4, 12, 20, 12); line(c, 12, 7, 12, 12); },
  core: (c) => { ring(c, 12, 12, 8.2); dot(c, 12, 12, 4); },
  token: (c) => { for (const [x, y] of [[5, 5], [13, 5], [5, 13], [13, 13]]) { c.fillRect(x, y, 6, 6); } },
  atom: (c) => { c.beginPath(); c.ellipse(12, 12, 9.5, 4, -0.5, 0, Math.PI * 2); c.stroke(); dot(c, 12, 12, 3); },
  molecule: (c) => { line(c, 7, 16, 17, 8); dot(c, 7, 16, 4); dot(c, 17, 8, 4); },
  tool: (c) => { line(c, 12, 4, 12, 20); line(c, 4, 12, 20, 12); },
  rom: (c) => { c.beginPath(); c.arc(12, 12, 7.5, 0.4, Math.PI * 1.6); c.stroke(); c.beginPath(); c.moveTo(14.5, 2.5); c.lineTo(20, 5.5); c.lineTo(14, 8.5); c.closePath(); c.fill(); },
  service: (c) => { c.beginPath(); c.moveTo(13.5, 2.5); c.lineTo(6, 13.5); c.lineTo(11.5, 13.5); c.lineTo(10, 21.5); c.lineTo(18, 9.5); c.lineTo(12.5, 9.5); c.closePath(); c.fill(); },
  store: (c) => { c.beginPath(); c.ellipse(12, 6.5, 7.5, 3, 0, 0, Math.PI * 2); c.stroke(); line(c, 4.5, 6.5, 4.5, 17.5); line(c, 19.5, 6.5, 19.5, 17.5); c.beginPath(); c.ellipse(12, 17.5, 7.5, 3, 0, 0, Math.PI); c.stroke(); },
  table: (c) => { c.beginPath(); c.rect(4, 5, 16, 14); c.stroke(); line(c, 4, 10, 20, 10); line(c, 12, 10, 12, 19); },
  external: (c) => { line(c, 7, 17, 17, 7); c.beginPath(); c.moveTo(9.5, 6.5); c.lineTo(17.5, 6.5); c.lineTo(17.5, 14.5); c.stroke(); },
  stack: (c) => { for (const y of [4.5, 10.5, 16.5]) c.fillRect(4, y, 16, 3.5); },
  machine: (c) => { c.beginPath(); c.rect(3.5, 4.5, 17, 11); c.stroke(); line(c, 12, 15.5, 12, 19.5); line(c, 7.5, 19.5, 16.5, 19.5); },
  container: (c) => { c.beginPath(); c.rect(4, 4, 16, 16); c.stroke(); c.fillRect(8.5, 8.5, 7, 7); },
  device: (c) => { c.beginPath(); c.rect(7.5, 3, 9, 18); c.stroke(); dot(c, 12, 17.5, 1.3); },
  floor: (c) => { c.beginPath(); c.moveTo(3.5, 20.5); c.lineTo(3.5, 15.5); c.lineTo(9, 15.5); c.lineTo(9, 10.5); c.lineTo(14.5, 10.5); c.lineTo(14.5, 5.5); c.lineTo(20.5, 5.5); c.stroke(); },
  room: (c) => { c.beginPath(); c.rect(6.5, 3.5, 11, 17); c.stroke(); dot(c, 14.5, 12.5, 1.4); },
  persona: (c) => { dot(c, 12, 8, 3.8); c.beginPath(); c.arc(12, 21, 8, Math.PI * 1.15, Math.PI * 1.85); c.stroke(); },
};
function line(c, x1, y1, x2, y2) { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
function ring(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke(); }
function dot(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); }

/** Draws a glyph on a 2D context sized `side` px, in `ink` (the tone was chosen against the node's fill, so the glyph needs no halo; it sits over the white core dot) */
export function drawGlyph(ctx, type, side, ink) {
  const draw = PATHS[type];
  if (!draw) return;
  const k = side / GRID;
  ctx.save();
  ctx.scale(k, k);
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  draw(ctx);
  ctx.restore();
}

const images = new Map();
/** Lets the images go (a test starts afresh with it) */
export const forgetGlyphImages = () => images.clear();

/**
 * The image of a type's glyph in an ink, made once (null where there is no canvas to draw one on, as in a test without a browser, and for a type with no glyph).
 * @param {string} type
 * @param {string} ink a CSS colour
 * @returns {CanvasImageSource | null}
 */
export function glyphImage(type, ink) {
  if (!hasGlyph(type) || typeof ink !== 'string') return null;
  const key = glyphKey(type, ink);
  if (images.has(key)) return images.get(key);
  if (images.size >= MAX_GLYPH_IMAGES) return null;
  let image = null;
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(SIDE, SIDE) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: SIDE, height: SIDE }) : null;
    const ctx = canvas && canvas.getContext && canvas.getContext('2d');
    if (ctx && ctx.stroke) { drawGlyph(ctx, type, SIDE, ink); image = canvas; }
  } catch { image = null; }
  images.set(key, image);
  return image;
}

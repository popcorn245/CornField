/**
 * @module explorer/css-color
 *
 * A CSS colour as the renderers can use it, read once here so every reader (the map's tokens in map-style.js, a node's own
 * colour in scene.js) agrees on what a colour is. The text is project or theme data: it only ever leaves here as `#rrggbb`,
 * `rgb()` or `rgba()` that this file built or checked, never as the text it was given.
 */

import { parseColor } from './theme-model.js';
import { readColor } from '../core/color.js';

let probe;
const normalised = new Map();

/** A canvas context to normalise a colour the way the browser reads it (`hsl()`, a name, `color-mix()`), or null where there is none */
function probeContext() {
  if (probe !== undefined) return probe;
  probe = null;
  try { if (typeof document !== 'undefined') probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true }) || null; } catch { probe = null; }
  return probe;
}

/**
 * A token's value as a colour the renderers can use (`#rrggbb`, `rgb()`, `rgba()`), or null for `auto`, empty, or anything that is not a colour.
 * @param {string} value
 * @returns {string | null}
 */
export function cssColor(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s || s.toLowerCase() === 'auto') return null;
  if (inRange(s)) return s;
  if (/^transparent$/i.test(s)) return 'rgba(0, 0, 0, 0)';
  if (normalised.has(s)) return normalised.get(s);
  let out = null;
  const ctx = isColor(s) && !/currentcolor/i.test(s) ? probeContext() : null; // a canvas has no current colour: it would read as black
  if (ctx) {
    try {
      // The browser's own reading: a value it refuses leaves fillStyle as it was, so two different starting colours tell a refusal
      // from a colour that happens to equal the first one
      const read = (from) => { ctx.fillStyle = from; ctx.fillStyle = s; return String(ctx.fillStyle); };
      const a = read('#010203');
      const got = a !== '#010203' ? a : read('#040506') !== '#040506' ? a : null;
      // A colour the browser keeps in another space (`oklch()`, `color(display-p3 ...)`) is read back as the sRGB pixel it paints
      out = got === null ? null : parseable(got) ? got : pixelOf(ctx, s);
    } catch { out = null; }
  }
  normalised.set(s, out);
  return out;
}

/** Whether CSS itself reads `s` as a colour (a canvas is more lenient: it takes `rgb(1.2.3, 0, 0)`); true where the page cannot say */
function isColor(s) {
  try { return typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports('color', s); } catch { return false; }
}

/** `#rgb`, `#rrggbb`, `rgb()` or `rgba()` with every channel in range: what both renderers read as written */
function inRange(s) {
  if (!parseable(s)) return false;
  // The numbers as written: parseColor clamps them, and an out-of-range channel must go to the browser to be read
  const nums = /^rgba?\(/i.test(s.trim()) ? s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')).split(',').map(Number) : null;
  if (nums && (nums.slice(0, 3).some((c) => !(c >= 0 && c <= 255)) || (nums.length > 3 && !(nums[3] > 0 && nums[3] <= 1)))) return false;
  const [r, g, b, a] = parseColor(s);
  return [r, g, b].every((c) => Number.isFinite(c) && c >= 0 && c <= 255) && Number.isFinite(a) && a > 0 && a <= 1;
}
/** The forms parseColor (theme-model.js) reads; anything else is normalised by the browser first */
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$|^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)$/i;
const parseable = (s) => COLOR_RE.test(s.trim());

/** The sRGB pixel `css` paints, as `rgba()` (or null when the context cannot be read) */
function pixelOf(ctx, css) {
  if (!ctx.getImageData || !ctx.fillRect) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return rgbaText(r, g, b, a / 255);
}

export const rgbaText = (r, g, b, a) => `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;


/** The longest colour a node may carry: every real colour is far shorter, and a longer text is never handed to the browser to read */
export const MAX_NODE_COLOR_CHARS = 200;

/**
 * A node's own `color` (project data) as a colour both renderers draw the same, or null when it is not one: a typo, `#12345`, an empty
 * string, a number, `null`, a value with a quote or `url(`, text over MAX_NODE_COLOR_CHARS. The caller then uses the node type's fill.
 * Where the page has no canvas to read with (Node, the tests), the forms core/color.js reads are kept as written.
 * @param {unknown} value
 * @returns {string | null}
 */
export function nodeColor(value) {
  if (typeof value !== 'string' || value.length > MAX_NODE_COLOR_CHARS) return null;
  const s = value.trim();
  if (!s || /^(?:auto|currentcolor)$/i.test(s)) return null;
  const c = cssColor(s);
  if (c) return c;
  return probeContext() === null && readColor(s) ? s : null;
}

/**
 * @module core/color
 *
 * Colour arithmetic with no dependencies and no Node built-ins, so the explorer (served from core/, see
 * server/server.js BROWSER_CORE), `cornfield validate` (core/contrast.js) and the tests all share one implementation.
 *
 *   parseColor(css)      a literal CSS colour as [r, g, b, a] (0..255, alpha 0..1); transparent for anything it cannot read
 *   readColor(css)       the same, or null when it is not a colour this file reads (so a caller can tell "unknown" from "transparent")
 *   luminance([r,g,b])   WCAG relative luminance
 *   ratio(la, lb)        the WCAG contrast ratio of two luminances
 *   contrast(a, b)       the WCAG contrast ratio of two CSS colours (alpha ignored)
 *   mixColors(a, pa, b, pb)  `color-mix(in srgb, …)` of two [r,g,b,a]
 *   over(fg, bg)         a translucent colour composited over an opaque one: opaque [r,g,b,1], channels rounded
 *   toHex([r,g,b])       '#rrggbb'
 *
 * Read: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` and `hsl()` / `hsla()` (comma or space syntax, an optional `/ alpha`,
 * percentages), `transparent`, the basic colour names, and `color-mix(in srgb, A p%, B [p%])` (of any of these, nested). Anything else
 * (`oklch()`, `var()`, `calc()`, `currentcolor`, `auto`) is not read.
 */

const NAMED = Object.freeze({
  black: '#000000', white: '#ffffff', red: '#ff0000', lime: '#00ff00', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff',
  magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000',
  green: '#008000', purple: '#800080', teal: '#008080', navy: '#000080', orange: '#ffa500',
});

const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The text between the outer parentheses of `name(...)` if `s` is exactly one such call, else null */
function callArgs(s, name) {
  const m = new RegExp(`^${name}\\(`, 'i').exec(s);
  if (!m || !s.endsWith(')')) return null;
  let depth = 0;
  for (let i = m[0].length - 1; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0 && i !== s.length - 1) return null;
  }
  return depth === 0 ? s.slice(m[0].length, -1) : null;
}

/** Split at the top level (outside parentheses) on a separator character */
export function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === sep && depth === 0) { out.push(s.slice(from, i)); from = i + 1; }
  }
  out.push(s.slice(from));
  return out;
}

const channelValue = (t, scale) => {
  const m = new RegExp(`^(${NUM})(%?)$`, 'i').exec(t);
  return m ? (m[2] ? (Number(m[1]) / 100) * scale : Number(m[1])) : null;
};
const alphaValue = (t) => (t === undefined ? 1 : (() => { const v = channelValue(t, 1); return v === null ? null : clamp(v, 0, 1); })());

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** The arguments of rgb()/hsl(), comma or space syntax, as [a, b, c, alpha?] strings; null when the shape is wrong */
function fnParts(args) {
  const parts = args.trim().split(/\s*[,/]\s*|\s+/).filter(Boolean);
  return parts.length === 3 || parts.length === 4 ? parts : null;
}

/** @returns {number[] | null} */
function readOne(css) {
  const s = String(css).trim();
  const lower = s.toLowerCase();
  if (lower === 'transparent') return [0, 0, 0, 0];
  if (NAMED[lower]) return readOne(NAMED[lower]);
  let m = /^#([0-9a-f]{3,4})$/.exec(lower);
  if (m) {
    const c = [...m[1]].map((h) => parseInt(h + h, 16));
    return [c[0], c[1], c[2], c.length === 4 ? c[3] / 255 : 1];
  }
  m = /^#([0-9a-f]{6}|[0-9a-f]{8})$/.exec(lower);
  if (m) {
    const h = m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  const rgb = callArgs(lower, 'rgba?');
  if (rgb !== null) {
    const p = fnParts(rgb);
    if (!p) return null;
    const c = p.slice(0, 3).map((t) => channelValue(t, 255));
    const a = alphaValue(p[3]);
    return c.some((v) => v === null) || a === null ? null : [...c.map((v) => clamp(v, 0, 255)), a];
  }
  const hsl = callArgs(lower, 'hsla?');
  if (hsl !== null) {
    const p = fnParts(hsl);
    if (!p) return null;
    const h = new RegExp(`^(${NUM})(?:deg)?$`).exec(p[0]);
    const sat = /%$/.test(p[1]) ? channelValue(p[1], 1) : null;
    const lig = /%$/.test(p[2]) ? channelValue(p[2], 1) : null;
    const a = alphaValue(p[3]);
    if (!h || sat === null || lig === null || a === null) return null;
    return [...hslToRgb(((Number(h[1]) % 360) + 360) % 360, clamp(sat, 0, 1), clamp(lig, 0, 1)), a];
  }
  const mix = callArgs(lower, 'color-mix');
  if (mix !== null) {
    const parts = splitTop(mix, ',').map((t) => t.trim());
    if (parts.length !== 3 || !/^in\s+srgb$/.test(parts[0])) return null;
    const side = (t) => {
      const before = /^(\d*\.?\d+)%\s+(.+)$/.exec(t);
      const after = /^(.+?)\s+(\d*\.?\d+)%$/.exec(t);
      const [col, pct] = before ? [before[2], before[1]] : after ? [after[1], after[2]] : [t, null];
      const c = readOne(col);
      return c && { c, p: pct === null ? null : Number(pct) / 100 };
    };
    const a = side(parts[1]);
    const b = side(parts[2]);
    if (!a || !b || (a.p !== null && (a.p < 0 || a.p > 1)) || (b.p !== null && (b.p < 0 || b.p > 1))) return null;
    const pa = a.p ?? (b.p === null ? 0.5 : 1 - b.p);
    const pb = b.p ?? 1 - pa;
    if (pa + pb <= 0) return null;
    return mixColors(a.c, pa, b.c, pb);
  }
  return null;
}

/** A CSS colour as `[r, g, b, a]`, or null when it is not one this file reads */
export function readColor(css) {
  try { return readOne(css); } catch { return null; }
}

/** `[r, g, b, a]` (0..255, alpha 0..1); transparent for anything that is not read. */
export function parseColor(css) {
  return readColor(css) ?? [0, 0, 0, 0];
}

/**
 * `color-mix(in srgb, a pa, b pb)`: premultiplied, as browsers mix. Percentages that add to less than 1 scale the alpha; to more, are normalised.
 * @param {number[]} a @param {number} pa @param {number[]} b @param {number} pb
 */
export function mixColors(a, pa, b, pb) {
  const sum = pa + pb;
  const [wa, wb] = [pa / sum, pb / sum];
  const alpha = a[3] * wa + b[3] * wb;
  const ch = (i) => (alpha === 0 ? 0 : (a[i] * a[3] * wa + b[i] * b[3] * wb) / alpha);
  return [ch(0), ch(1), ch(2), alpha * Math.min(1, sum)];
}

/** A colour composited over an opaque one: opaque `[r, g, b, 1]`, channels rounded to 8 bits, as a screen shows it */
export function over(fg, bg) {
  const a = fg[3];
  return [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a))).concat(1);
}

export const toHex = ([r, g, b]) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
/** WCAG relative luminance of `[r, g, b]` (0..255) */
export const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
export const ratio = (la, lb) => (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);

/** The WCAG contrast ratio of two opaque CSS colours (alpha is ignored) */
export const contrast = (a, b) => ratio(luminance(parseColor(a)), luminance(parseColor(b)));

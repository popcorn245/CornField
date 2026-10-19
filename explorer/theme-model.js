/**
 * @module explorer/theme-model
 *
 * Light and dark, the pure half (MAP-01). No DOM, no `window`: theme.js is the half that reads the system
 * setting, keeps the choice and repaints.
 *
 * The explorer was drawn for a dark ground, and its colours are written for it (scene.js, flows.js, the
 * node types of core/schema.js, the house, the outage and verdict painters). Light mode does not keep a
 * second copy of each. It derives the light picture from the dark one, by one rule per kind of colour:
 *
 *   - A chromatic colour keeps its hue and saturation, and only its lightness moves: down until it stands
 *     out from the light ground by at least `MIN_CONTRAST.mark` (3:1, WCAG 1.4.11 for the parts of a
 *     picture) or, for text, `MIN_CONTRAST.text` (4.5:1, WCAG 1.4.3). A colour that already does is left
 *     alone. So a sky-blue page stays a sky-blue page, a little deeper; the yellow of a table turns ochre.
 *   - A light grey or white (the labels, the ownership lines, the grid, a packet) is mirrored: its
 *     lightness becomes 1 - lightness, so it is as far from the light ground as it was from the dark one,
 *     and its alpha is kept, so a quiet line stays quiet. A dark grey (an outage's black node) already
 *     stands out on light and is kept.
 *   - Transparent stays transparent.
 *
 *   resolveTheme(choice, prefersLight)   'light' | 'dark' from 'system' | 'light' | 'dark'
 *   themeChoiceFrom(search, stored)      the choice the address (?theme=) or the stored setting makes
 *   lightColor(css, role)                one colour for the light ground (memoised)
 *   themed(css, theme, role)             the same, or the colour untouched in the dark theme
 *   lightenScene(scene)                  every colour of a built scene, in place (scene.js calls it)
 *   contrast(a, b)                       the WCAG contrast ratio of two CSS colours
 *   parseColor(css)                      a CSS colour as [r, g, b, a] (scene.js re-exports it for the renderers)
 */

export const THEME_CHOICES = ['system', 'light', 'dark'];
/** Where the choice is kept in the browser (theme.js); `?theme=` in the address wins over it, without being kept */
export const THEME_STORAGE_KEY = 'topology-explorer:theme';
/** The light page's ground (--hx-bg in explorer.css): what the light colours are measured against */
export const LIGHT_GROUND = '#f4f6fa';
/** The dark page's ground, for checking what the dark theme already does */
export const DARK_GROUND = '#090d16';
/** WCAG 2.1 minimums, with a little room over them for the page's tinted ground and the canvas blending */
export const MIN_CONTRAST = { mark: 3.2, text: 4.8 };
/** Below this chroma (max - min channel, 0..1) a colour counts as a grey, and is mirrored instead of deepened */
const GREY_CHROMA = 0.16;
/** How much more alpha a line gets on the light ground (lightenScene) */
export const LINE_GAIN = 1.35;
/** The darkest a mirrored grey goes: slate-900's lightness, so white text becomes ink, not black */
const INK_LIGHTNESS = 0.11;

// ---------------------------------------------------------------------------
//  Which theme
// ---------------------------------------------------------------------------

/**
 * @param {string} choice 'system' | 'light' | 'dark' (anything else is 'system')
 * @param {boolean} prefersLight what `prefers-color-scheme: light` says
 * @returns {'light'|'dark'}
 */
export function resolveTheme(choice, prefersLight) {
  if (choice === 'light' || choice === 'dark') return choice;
  return prefersLight ? 'light' : 'dark';
}

/**
 * The choice in force: `?theme=light|dark|system` in the address, else the stored one, else 'system'.
 * @param {string} search a location.search
 * @param {string|null} stored what THEME_STORAGE_KEY holds
 * @returns {{choice: 'system'|'light'|'dark', fromAddress: boolean}}
 */
export function themeChoiceFrom(search, stored) {
  const asked = new URLSearchParams(search || '').get('theme');
  if (THEME_CHOICES.includes(asked)) return { choice: asked, fromAddress: true };
  return { choice: THEME_CHOICES.includes(stored) ? stored : 'system', fromAddress: false };
}

/** The choice after `choice` on the toggle: system, light, dark, then system again */
export const nextChoice = (choice) => THEME_CHOICES[(THEME_CHOICES.indexOf(choice) + 1) % THEME_CHOICES.length];

/** What the toggle says it is set to, in plain words (its label and title) */
export function themeWords(choice, theme) {
  if (choice === 'system') return `Theme: follows the system (${theme} now)`;
  return `Theme: ${choice}`;
}

// ---------------------------------------------------------------------------
//  Colour arithmetic
// ---------------------------------------------------------------------------

/** `#rgb`, `#rrggbb`, `rgb(...)` or `rgba(...)` → `[r, g, b, a]` (0..255, alpha 0..1); transparent for anything else. scene.js re-exports it. */
export function parseColor(css) {
  const s = String(css).trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16)).concat(1);
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  return [0, 0, 0, 0];
}

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
/** WCAG relative luminance of `[r, g, b]` (0..255) */
export const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratio = (la, lb) => (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);

/** The WCAG contrast ratio of two opaque CSS colours (alpha is ignored) */
export const contrast = (a, b) => ratio(luminance(parseColor(a)), luminance(parseColor(b)));

/** `[r, g, b]` (0..255) to `[h, s, l]` (h in degrees, s and l 0..1) */
export function toHsl([r, g, b]) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

/** `[h, s, l]` back to `[r, g, b]` (0..255, rounded) */
export function fromHsl([h, s, l]) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const css = (rgb, a) => (a >= 1 ? hex(rgb) : `rgba(${rgb.join(', ')}, ${+a.toFixed(3)})`);

// ---------------------------------------------------------------------------
//  One colour for the light ground
// ---------------------------------------------------------------------------

const groundLum = luminance(parseColor(LIGHT_GROUND));
const memo = new Map();

/**
 * One dark-theme colour, for the light ground (the rules are at the top of this file).
 * @param {string} color a CSS colour: `#rgb`, `#rrggbb`, `rgb()` or `rgba()`; anything else comes back as it is
 * @param {'mark'|'text'} [role] how much it must stand out: a part of the picture (3:1) or text (4.5:1)
 * @returns {string}
 */
export function lightColor(color, role = 'mark') {
  const key = `${role}|${color}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const out = computeLight(color, role);
  memo.set(key, out);
  return out;
}

function computeLight(color, role) {
  if (typeof color !== 'string') return color;
  const [r, g, b, a] = parseColor(color);
  if (a === 0) return color; // transparent, or not a colour parseColor reads (a gradient, a name): left as it is
  const [h, s, l] = toHsl([r, g, b]);
  const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  // a light grey is mirrored (alpha kept; never quite black, the ink is slate)
  if (chroma < GREY_CHROMA && l > 0.5) return css(fromHsl([h, s, Math.max(INK_LIGHTNESS, 1 - l)]), a);
  // anything else that already stands out (a dark grey, a deep colour) is kept
  const min = MIN_CONTRAST[role] || MIN_CONTRAST.mark;
  if (ratio(luminance([r, g, b]), groundLum) >= min) return color;
  // lower the lightness, hue and saturation kept, to the lightest step that clears `min` (luminance falls with lightness)
  let lo = 0, hi = l;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (ratio(luminance(fromHsl([h, s, mid])), groundLum) >= min) lo = mid; else hi = mid;
  }
  return css(fromHsl([h, s, lo]), a);
}

/** `color` for `theme`: untouched in the dark theme, `lightColor` in the light one */
export const themed = (color, theme, role = 'mark') => (theme === 'light' ? lightColor(color, role) : color);

// ---------------------------------------------------------------------------
//  A whole scene
// ---------------------------------------------------------------------------

const lightText = (t) => { if (t) t.color = lightColor(t.color, 'text'); };

/**
 * Every colour of a built scene (scene.js), for the light ground, in place; marks it `theme: 'light'`.
 * A built scene is new each time (buildScene makes fresh objects), so changing it in place is safe.
 * The looks a renderer holds itself (halo, mark ring, the white core) come from `looksFor('light')` in scene.js.
 * @param {import('./scene.js').Scene} scene
 * @returns {import('./scene.js').Scene}
 */
export function lightenScene(scene) {
  scene.theme = 'light';
  for (const n of scene.nodes) {
    n.color = lightColor(n.color);
    n.labelColor = lightColor(n.labelColor, 'text');
  }
  for (const e of scene.edges) {
    // A thin dark line on a light ground reads weaker than a thin light one on a dark ground at the same
    // alpha (the contrast ratio is lower): a faded or translucent line gets LINE_GAIN more, capped at opaque
    if (e.alpha < 1) e.alpha = Math.min(1, e.alpha * LINE_GAIN);
    e.color = lightColor(e.color);
    const [r, g, b, a] = parseColor(e.color);
    if (a > 0 && a < 1) e.color = css([r, g, b], Math.min(1, a * LINE_GAIN));
    if (e.glowColor) e.glowColor = lightColor(e.glowColor);
    if (e.label) e.label = { ...e.label, color: lightColor(e.label.color, 'text') };
    if (e.packet) e.packet = { ...e.packet, color: lightColor(e.packet.color), glowColor: lightColor(e.packet.glowColor) };
  }
  const { decor } = scene;
  if (decor.grid) decor.grid = { ...decor.grid, color: lightColor(decor.grid.color) };
  decor.rings = decor.rings.map((ring) => ({ ...ring, color: lightColor(ring.color) }));
  decor.lanes = decor.lanes.map((lane) => {
    const out = { ...lane, fill: lightColor(lane.fill), stroke: lightColor(lane.stroke) };
    for (const k of ['title', 'note', 'arrow']) if (out[k]) { out[k] = { ...out[k] }; lightText(out[k]); }
    return out;
  });
  return scene;
}

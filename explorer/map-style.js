/**
 * @module explorer/map-style
 *
 * The map's styling from the theme (docs/theming.md, "The map"). The map canvas reads its colours from `--corn-map-*` custom
 * properties (tokens.css) on load and again whenever the theme changes, then draws again:
 *
 *   --corn-map-node-<kind>                    a node kind's fill                     (kind: a node type, `app`, `page`, `table` ...)
 *   --corn-map-group-<group>                  the same by group, the node's layer in the Layers menu (`cloud`, `web`, `house`, `app` ...)
 *   --corn-map-stroke, --corn-map-stroke-width  every node's outline: its colour (none at `auto`) and its width, in world px
 *   --corn-map-label, --corn-map-label-halo   a node label's colour, and the outline under every label that keeps it readable over the lines
 *   --corn-map-edge-<kind>                    an edge kind's colour (`ownership`, `usage`, `flow`, `reads`, `writes`, `calls` ...)
 *   --corn-map-added|changed|removed|edit     the diff: a proposal's marks on nodes and edges
 *   --corn-map-selected|match                 the halo of the selected node, and of a search hit
 *   --corn-map-lit                            the lines of the focus: the links the selection (or a walk's step) lights
 *   --corn-map-collision                      the collision mark of two runs on one node (a DOM mark: explorer.css reads it)
 *
 * `auto` (the default of every one of them but the width and the collision) means "keep what the map draws without a theme": the
 * node's own colour from the topology, deepened for the light ground by theme-model.js, and every other colour as scene.js has
 * it. So with no theme the map is exactly what it was. A colour overrides it as written, in both themes (a theme sets its own
 * for the light ground under :root[data-theme="light"]). A kind's token wins over its group's.
 *
 * How it reaches the pixels. scene.js stays pure: it describes the picture with the colours it always had. A renderer (and the label
 * layer) asks `styledScene(scene, style)` for the same picture in the theme's colours, and `looksWith(looks, style)` for the halos and
 * the mark rings; the style is `getMapStyle()`, which `refreshMapStyle()` reads from the page's computed style. With nothing set,
 * `styledScene` hands the scene back untouched. A node or an edge a painter gave a colour (an outage, a check's verdict, a pull
 * request: `scene.painted`) keeps it: those colours mean something.
 *
 * Icons (`theme.icons`) are loaded here, one image per node kind (`createIconStore`); a kind whose file is missing or will not load
 * simply has no icon. `pixelated` (`theme.pixelated`) is the renderers' cue to sample without smoothing.
 */

import { NODE_THEMES } from '../core/schema.js';
import { parseColor } from './theme-model.js';
import { looksFor } from './scene.js';

/** The node kinds (topology types) and the groups (layers a node can belong to) the tokens exist for */
export const MAP_KINDS = Object.freeze(Object.keys(NODE_THEMES));
export const MAP_GROUPS = Object.freeze(['app', 'pkg', 'page', 'atom', 'molecule', 'token', 'tool', 'table', 'rom', 'service', 'cloud', 'web', 'stack', 'machine', 'container', 'device', 'house', 'persona']);
/** The kinds of edge scene.js draws */
export const MAP_EDGE_KINDS = Object.freeze(['ownership', 'usage', 'flow', 'reads', 'writes', 'calls', 'triggers', 'delivers', 'runs-on', 'uses', 'extends']);
/** The diff marks, and the other states the map colours */
export const MAP_MARKS = Object.freeze(['added', 'changed', 'removed', 'edit']);
export const MAP_STATES = Object.freeze(['selected', 'match', 'lit']);
export const STROKE_TOKEN = '--corn-map-stroke';
export const STROKE_WIDTH_TOKEN = '--corn-map-stroke-width';
export const LABEL_TOKEN = '--corn-map-label';
export const LABEL_HALO_TOKEN = '--corn-map-label-halo';
export const COLLISION_TOKEN = '--corn-map-collision';
/** The width of an outline when the token is not a length (px, world units) */
export const DEFAULT_STROKE_WIDTH = 1.5;
/** An icon is drawn this many radii across (a square, so it fits inside the circle) */
export const ICON_RATIO = 1.2;
/** Where the server serves the images beside a theme (core/theme.js THEME_ASSET_PREFIX); an icon is fetched from nowhere else */
export const ICON_URL_PREFIX = '/cornfield/theme/assets/';

export const nodeToken = (kind) => `--corn-map-node-${kind}`;
export const groupToken = (group) => `--corn-map-group-${group}`;
export const edgeToken = (kind) => `--corn-map-edge-${kind}`;
export const stateToken = (name) => `--corn-map-${name}`;

/** The colour tokens script reads: all of them but the width and the collision mark (which CSS reads) */
export const MAP_COLOR_TOKENS = Object.freeze([
  ...MAP_KINDS.map(nodeToken),
  ...MAP_GROUPS.map(groupToken),
  STROKE_TOKEN,
  LABEL_TOKEN,
  LABEL_HALO_TOKEN,
  ...MAP_EDGE_KINDS.map(edgeToken),
  ...MAP_MARKS.map(stateToken),
  ...MAP_STATES.map(stateToken),
]);
/** Every map token */
export const mapTokenNames = () => [...MAP_COLOR_TOKENS, STROKE_WIDTH_TOKEN, COLLISION_TOKEN];

// ---------------------------------------------------------------------------
//  Reading a token
// ---------------------------------------------------------------------------

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

const rgbaText = (r, g, b, a) => `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;

/** `token` as the colour of something that was `original`: the token's colour, with the original's own alpha kept (a faint line stays faint) */
export function withAlphaOf(token, original) {
  const [r, g, b, a] = parseColor(token);
  const oa = parseColor(original)[3];
  if (oa >= 1) return token;
  return rgbaText(r, g, b, a * oa);
}

/**
 * The tokens as the page computes them.
 * @param {(name: string) => string} read the value of a custom property
 * @returns {{values: Record<string, string>, strokeWidth: number}} `values` holds only the tokens that are a colour (not `auto`)
 */
export function readMapTokens(read) {
  const values = {};
  for (const name of MAP_COLOR_TOKENS) {
    const c = cssColor(read(name));
    if (c) values[name] = c;
  }
  const w = parseFloat(String(read(STROKE_WIDTH_TOKEN) ?? ''));
  return { values, strokeWidth: Number.isFinite(w) && w >= 0 ? w : DEFAULT_STROKE_WIDTH };
}

/** A reader of the page's computed custom properties, or null where there is no page */
export function pageReader(doc = typeof document !== 'undefined' ? document : null) {
  const win = doc && doc.defaultView;
  if (!doc || !doc.documentElement || !win || !win.getComputedStyle) return null;
  const style = win.getComputedStyle(doc.documentElement);
  return (name) => style.getPropertyValue(name);
}

// ---------------------------------------------------------------------------
//  Icons
// ---------------------------------------------------------------------------

function loadImage(url) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') { reject(new Error('no Image')); return; }
    const img = new Image();
    img.onload = () => (img.naturalWidth > 0 && img.naturalHeight > 0 ? resolve(img) : reject(new Error(`${url} has no size`)));
    img.onerror = () => reject(new Error(`${url} did not load`));
    img.src = url;
  });
}

/**
 * One image per node kind, loaded once. `get(kind)` is the image when it has loaded, else null: a kind with no icon, one still loading, and
 * one whose file is missing or is not an image are the same to the map (no icon), and one failure never touches another.
 * @param {Record<string, string>} urls kind to served path (only paths under ICON_URL_PREFIX, for a kind that is a node kind)
 * @param {{load?: (url: string) => Promise<unknown>, onChange?: () => void, warn?: (message: string) => void}} [opts]
 */
export function createIconStore(urls, { load = loadImage, onChange = () => {}, warn = (m) => console.warn(m) } = {}) {
  const entries = new Map();
  let ready = 0;
  for (const [kind, url] of Object.entries(urls || {})) {
    if (!MAP_KINDS.includes(kind) || typeof url !== 'string' || !url.startsWith(ICON_URL_PREFIX) || url.includes('..')) continue;
    const entry = { status: 'loading', image: null };
    entries.set(kind, entry);
    Promise.resolve().then(() => load(url)).then((image) => {
      entry.status = 'ready';
      entry.image = image;
      ready++;
      onChange();
    }, (err) => {
      entry.status = 'failed';
      warn(`Map icon for "${kind}" not drawn: ${err && err.message ? err.message : err}`);
    });
  }
  return {
    kinds: [...entries.keys()],
    get: (kind) => { const e = entries.get(kind); return e && e.status === 'ready' ? e.image : null; },
    status: (kind) => (entries.has(kind) ? entries.get(kind).status : 'none'),
    anyReady: () => ready > 0,
  };
}

// ---------------------------------------------------------------------------
//  The style in force
// ---------------------------------------------------------------------------

/**
 * @typedef {object} MapStyle
 * @property {number} version      changes whenever anything below does: a renderer draws again when it differs from the one it drew
 * @property {Record<string, string>} values  the tokens that are a colour, by name (those at `auto` are absent)
 * @property {number} strokeWidth  px, world units
 * @property {ReturnType<typeof createIconStore> | null} icons
 * @property {boolean} pixelated   sample icons without smoothing
 * @property {boolean} plain       nothing to apply: no colour set, no icon loaded (the scene is drawn as it is)
 */

let tokens = { values: {}, strokeWidth: DEFAULT_STROKE_WIDTH };
let icons = null;
let pixelated = false;
let version = 0;
let current = compose();
const listeners = new Set();

function compose() {
  const plain = !Object.keys(tokens.values).length && !(icons && icons.anyReady());
  return Object.freeze({ version, values: tokens.values, strokeWidth: tokens.strokeWidth, icons, pixelated, plain });
}

function changed() {
  version++;
  current = compose();
  listeners.forEach((fn) => fn(current));
}

/** @returns {MapStyle} */
export const getMapStyle = () => current;

/** Calls `fn(style)` when the style changes (a token, an icon arriving); returns how to stop */
export function onMapStyleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Reads the tokens again; true when something differed (and the listeners were told). Run on load and whenever the theme changes.
 * @param {(name: string) => string} [read] default: the page's computed style
 */
export function refreshMapStyle(read = pageReader()) {
  if (!read) return false;
  const next = readMapTokens(read);
  const same = next.strokeWidth === tokens.strokeWidth
    && Object.keys(next.values).length === Object.keys(tokens.values).length
    && Object.entries(next.values).every(([k, v]) => tokens.values[k] === v);
  if (same) return false;
  tokens = next;
  changed();
  return true;
}

/**
 * Starts loading the config's icons (`theme.icons`, as the browser is told them: kind to served path) and sets the pixelated flag.
 * @param {{icons?: Record<string, string>, pixelated?: boolean} | null | undefined} theme
 * @param {Parameters<typeof createIconStore>[1]} [opts]
 */
export function setMapIcons(theme, opts = {}) {
  const urls = theme && theme.icons && typeof theme.icons === 'object' ? theme.icons : {};
  pixelated = !!(theme && theme.pixelated === true);
  icons = Object.keys(urls).length ? createIconStore(urls, { ...opts, onChange: () => { changed(); if (opts.onChange) opts.onChange(); } }) : null;
  changed();
  return icons;
}

/**
 * The config's part of the map theme once the page has it: loads the icons, sets the pixelated flag, and marks <html data-pixelated> so a
 * stylesheet can sample any DOM image without smoothing too (`image-rendering: pixelated`, explorer.css).
 * @param {Document} doc
 * @param {{icons?: Record<string, string>, pixelated?: boolean} | null | undefined} theme `config.theme` of /cornfield/config.json
 */
export function applyMapTheme(doc, theme, opts = {}) {
  if (theme && theme.pixelated === true) doc.documentElement.setAttribute('data-pixelated', ''); else doc.documentElement.removeAttribute('data-pixelated');
  return setMapIcons(theme, opts);
}

/** Back to nothing set (for tests) */
export function resetMapStyle() {
  tokens = { values: {}, strokeWidth: DEFAULT_STROKE_WIDTH };
  icons = null;
  pixelated = false;
  changed();
}

/**
 * Keeps the style right as the page changes its theme: `data-theme` or `data-theme-name` on <html> changing, a stylesheet finishing loading
 * (a named theme's, or the theme file's), and `prefers-color-scheme` flipping. Returns how to stop.
 * @param {Document} doc
 */
export function watchMapStyle(doc) {
  const refresh = () => { refreshMapStyle(pageReader(doc)); };
  const stops = [];
  const win = doc.defaultView;
  if (win && win.MutationObserver) {
    const obs = new win.MutationObserver(refresh);
    obs.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-name', 'class'] });
    stops.push(() => obs.disconnect());
  }
  const onLoad = (event) => { if (event.target && event.target.tagName === 'LINK') refresh(); }; // load does not bubble: captured
  doc.addEventListener('load', onLoad, true);
  stops.push(() => doc.removeEventListener('load', onLoad, true));
  const media = win && win.matchMedia ? win.matchMedia('(prefers-color-scheme: light)') : null;
  if (media) {
    if (media.addEventListener) { media.addEventListener('change', refresh); stops.push(() => media.removeEventListener('change', refresh)); }
    else if (media.addListener) { media.addListener(refresh); stops.push(() => media.removeListener(refresh)); }
  }
  refresh();
  return () => stops.forEach((fn) => fn());
}

// ---------------------------------------------------------------------------
//  Applying it
// ---------------------------------------------------------------------------

const firstOf = (values, names) => { for (const n of names) if (values[n]) return values[n]; return null; };

function styleEdge(e, values, painted) {
  if (e.mark && e.mark !== 'none') {
    const c = values[stateToken(e.mark)];
    if (!c) return e;
    return { ...e, color: c, glowColor: e.glowColor ? c : e.glowColor };
  }
  if (painted.has(e.key)) return e;
  const lit = !e.curve && e.glow > 0 && !e.arrow; // a straight link the focus lights
  const c = (lit && values[stateToken('lit')]) || values[edgeToken(e.kind)];
  if (!c) return e;
  const out = { ...e, color: withAlphaOf(c, e.color) };
  if (e.glowColor) out.glowColor = withAlphaOf(c, e.glowColor);
  if (e.packet) out.packet = { ...e.packet, glowColor: withAlphaOf(c, e.packet.glowColor) };
  return out;
}

function compute(scene, style) {
  const { values } = style;
  const label = values[LABEL_TOKEN];
  const stroke = values[STROKE_TOKEN];
  const painted = scene.painted || { nodes: new Set(), edges: new Set() };
  const nodes = scene.nodes.map((n) => {
    const fill = !painted.nodes.has(n.id) && firstOf(values, [nodeToken(n.type), groupToken(n.group || n.type)]);
    const icon = style.icons && style.icons.get(n.type) ? n.type : null;
    if (!fill && !label && !stroke && !icon) return n;
    const out = { ...n };
    if (fill) out.color = fill;
    if (label) out.labelColor = withAlphaOf(label, n.labelColor);
    if (stroke && style.strokeWidth > 0) out.stroke = { color: stroke, width: style.strokeWidth };
    if (icon) out.icon = icon;
    return out;
  });
  const out = { ...scene, nodes, edges: scene.edges.map((e) => styleEdge(e, values, painted.edges)) };
  const halo = values[LABEL_HALO_TOKEN];
  if (halo) { // the outline under the labels, at the widths it has (labels.js reads `scene.labelOutline` before the ground's own)
    const { node, edge } = looksFor(scene.theme).labelOutline;
    out.labelOutline = { node: { ...node, color: halo }, edge: { ...edge, color: halo } };
  }
  return out;
}

const sceneMemo = new WeakMap();

/**
 * `scene` in the style's colours, with the outline and icon of each node that has one: the same object when there is nothing to apply, and
 * the same result for the same scene and style version, so a renderer's cache of what it packed holds.
 * @param {import('./scene.js').Scene} scene
 * @param {MapStyle} [style]
 */
export function styledScene(scene, style = current) {
  if (!style || style.plain) return scene;
  const hit = sceneMemo.get(scene);
  if (hit && hit.version === style.version) return hit.out;
  const out = compute(scene, style);
  sceneMemo.set(scene, { version: style.version, out });
  return out;
}

const looksMemo = new WeakMap();

/**
 * The halos and mark rings (scene.js `looksFor`) in the style's colours: a selected node's, a search hit's, and each diff mark's.
 * @param {ReturnType<typeof import('./scene.js').looksFor>} looks
 * @param {MapStyle} [style]
 */
export function looksWith(looks, style = current) {
  if (!style || style.plain) return looks;
  const hit = looksMemo.get(looks);
  if (hit && hit.version === style.version) return hit.out;
  const { values } = style;
  const halo = { ...looks.halo };
  for (const name of ['selected', 'match']) {
    const c = values[stateToken(name)];
    if (c) halo[name] = { ...halo[name], ring: c, fill: halo[name].fill ? withAlphaOf(c, halo[name].fill) : halo[name].fill };
  }
  const mark = { ...looks.mark };
  for (const name of MAP_MARKS) {
    const c = values[stateToken(name)];
    if (c) mark[name] = { ...mark[name], color: c };
  }
  const out = { ...looks, halo, mark };
  looksMemo.set(looks, { version: style.version, out });
  return out;
}

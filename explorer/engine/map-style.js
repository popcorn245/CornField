/**
 * @module explorer/engine/map-style
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
 *   --corn-map-font                           the font list of every label on the map (a list of families, `auto` for the map's own)
 *   --corn-map-edge-width                     the width of an ordinary line, in map px (`auto` keeps each line's own; the focus's and the marks' keep their proportion)
 *   --corn-map-label-min                      the smallest a label is drawn on screen, in px (11 by default; below 9px it is ignored; a hub's title is 2 more)
 *   --corn-map-grey                           what a review greys (the nodes and lines a proposal does not involve) is drawn in: a colour, or `auto` for each one's own tone with its hue taken away
 *   --corn-map-grey-alpha                     how much of a greyed node is left: a number from 0.1 to 1 (`auto` is 0.45); its lines are faded in the same proportion
 *   --corn-map-glow                           the soft glow round nodes, lines and packets: a factor (`0` none, `1` as drawn, `auto` as drawn)
 *
 * `auto` (the default of every one of them but the width and the collision) means "keep what the map draws without a theme": the
 * node's own colour from the topology, deepened for the light ground by theme-model.js, and every other colour as scene.js has
 * it. So with no theme the map is exactly what it was. A colour overrides it as written, in both themes (a theme sets its own
 * for the light ground under :root[data-theme="light"]). A kind's token wins over its group's.
 *
 * How it reaches the pixels. scene.js stays pure: it describes the picture with the colours it always had. A renderer (and the label
 * layer) asks `styledScene(scene, style)` for the same picture in the theme's colours, and `looksWith(looks, style)` for the halos and
 * the mark rings; the style is the instance's (`mapStyleOf(inst).get()`), which `refresh()` reads from the computed style at the instance's root. With nothing set,
 * `styledScene` hands the scene back untouched. A node or an edge a painter gave a colour (an outage, a check's verdict, a pull
 * request: `scene.painted`) keeps it: those colours mean something.
 *
 * Icons (`theme.icons`) are loaded here, one image per node kind (`createIconStore`); a kind whose file is missing or will not load
 * simply has no icon. `pixelated` (`theme.pixelated`) is the renderers' cue to sample without smoothing.
 */

import { NODE_THEMES } from '../../core/schema.js';
import { parseColor } from '../theme-model.js';
import { cssColor, rgbaText } from '../css-color.js';
export { cssColor };
import { GREY_ALPHA, LABEL_MIN_FLOOR, looksFor } from '../scene.js';
import { iconKeyShape, iconKeysFor, mapFillNames, mapGroupToken, mapKindToken } from '../../core/layers.js';

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
export const FONT_TOKEN = '--corn-map-font';
export const EDGE_WIDTH_TOKEN = '--corn-map-edge-width';
export const GLOW_TOKEN = '--corn-map-glow';
export const LABEL_MIN_TOKEN = '--corn-map-label-min';
export const GREY_TOKEN = '--corn-map-grey';
export const GREY_ALPHA_TOKEN = '--corn-map-grey-alpha';
/** The least a greyed node may be left at: under it the map would vanish (a value below is read as `auto`) */
export const MIN_GREY_ALPHA = 0.1;
/** The ink of a node's glyph and of a finer kind's letters (spec 0008 D8); `auto` is the white or the dark that reads on the node's fill (glyphs.js) */
export const GLYPH_TOKEN = '--corn-map-glyph';
/** The largest label minimum a theme may ask for: bigger text would leave no room for another label */
export const MAX_LABEL_MIN = 24;
/** The width an ordinary line has with no theme (scene.js `flowEdge`): the `--corn-map-edge-width` scales every line by its ratio to this */
export const BASE_EDGE_WIDTH = 1.6;
/** The most a font list may hold: the families, and the characters */
export const MAX_FONT_FAMILIES = 8;
export const MAX_FONT_CHARS = 200;
/** The widest a line may be set, and the largest glow factor: a typo cannot draw a map of paint */
export const MAX_EDGE_WIDTH = 12;
export const MAX_GLOW = 4;
/** The width of an outline when the token is not a length (px, world units) */
export const DEFAULT_STROKE_WIDTH = 1.5;
/** An icon is drawn this many radii across (a square, so it fits inside the circle) */
export const ICON_RATIO = 1.2;
/** Where the server serves the images beside a theme (core/theme.js THEME_ASSET_PREFIX); an icon is fetched from nowhere else */
export const ICON_URL_PREFIX = '/cornfield/theme/assets/';

export const nodeToken = (kind) => `--corn-map-node-${kind}`;
export const groupToken = (group) => `--corn-map-group-${group}`;
/** The fill token of a finer kind: `--corn-map-kind-service-timer`, or null for a kind that cannot be a part of a name (core/layers.js) */
export const kindToken = (type, kind) => mapKindToken(type, kind);
export const edgeToken = (kind) => `--corn-map-edge-${kind}`;
export const stateToken = (name) => `--corn-map-${name}`;

/** The colour tokens script reads: all of them but the width and the collision mark (which CSS reads) */
export const MAP_COLOR_TOKENS = Object.freeze([
  ...MAP_KINDS.map(nodeToken),
  ...MAP_GROUPS.map(groupToken),
  STROKE_TOKEN,
  LABEL_TOKEN,
  LABEL_HALO_TOKEN,
  GLYPH_TOKEN,
  GREY_TOKEN,
  ...MAP_EDGE_KINDS.map(edgeToken),
  ...MAP_MARKS.map(stateToken),
  ...MAP_STATES.map(stateToken),
]);
/** Every map token */
export const mapTokenNames = () => [...MAP_COLOR_TOKENS, STROKE_WIDTH_TOKEN, COLLISION_TOKEN, FONT_TOKEN, EDGE_WIDTH_TOKEN, GLOW_TOKEN, LABEL_MIN_TOKEN, GREY_ALPHA_TOKEN];

// ---------------------------------------------------------------------------
//  Reading a token
// ---------------------------------------------------------------------------

/** `token` as the colour of something that was `original`: the token's colour, with the original's own alpha kept (a faint line stays faint) */
export function withAlphaOf(token, original) {
  const [r, g, b, a] = parseColor(token);
  const oa = parseColor(original)[3];
  if (oa >= 1) return token;
  return rgbaText(r, g, b, a * oa);
}

const GENERIC_FAMILY = /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math|fangsong)$/i;
const SYSTEM_FONT_KEYWORD = /^(?:-apple-system|BlinkMacSystemFont)$/;

/**
 * A font list the canvas may be given, or null (`auto`, empty, or anything that is not a plain list of families). Each family is a name in
 * quotes, or bare words (`Nunito`, `ui-rounded`, `sans-serif`); nothing that can carry a URL or script (no parentheses, slashes, colons,
 * semicolons, braces, angle brackets, `@`, backslashes, `url`, `var`, `expression`) and no more than MAX_FONT_FAMILIES of them.
 * Returned with each name quoted, so a name with a space is one family.
 * @param {unknown} value
 * @returns {string | null}
 */
export function cssFontList(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s || s.length > MAX_FONT_CHARS || s.toLowerCase() === 'auto') return null;
  if (/[();:{}<>@\\/\u0000-\u001f\u007f]|\burl\b|\bvar\b|\bexpression\b|\bimport\b/i.test(s)) return null;
  const parts = s.split(',').map((p) => p.trim());
  if (parts.length > MAX_FONT_FAMILIES) return null;
  const out = [];
  for (const part of parts) {
    const quoted = /^"([A-Za-z0-9 ._+-]{1,60})"$|^'([A-Za-z0-9 ._+-]{1,60})'$/.exec(part);
    // A bare name may start with one hyphen (`-apple-system`, in cornfield's own --corn-font), never two (a custom property's name)
    const name = quoted ? (quoted[1] ?? quoted[2]).trim() : /^-?[A-Za-z][A-Za-z0-9 _-]{0,59}$/.test(part) ? part.replace(/\s+/g, ' ') : null;
    if (!name) return null;
    // Generic families and the two system-font keywords stay bare (quoted, they would name a font called that); every other name is quoted
    out.push(GENERIC_FAMILY.test(name) ? name.toLowerCase() : SYSTEM_FONT_KEYWORD.test(name) ? name : `"${name}"`);
  }
  return out.join(', ');
}

/** A length in px (`2px`, `2`) over 0 and at most max, or null for `auto` and anything else (a canvas ignores a line width of 0) */
function pxOf(value, max) {
  const m = /^\s*(\d*\.?\d+)(?:px)?\s*$/i.exec(String(value ?? ''));
  const n = m ? parseFloat(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

/** The label minimum: a length in px from LABEL_MIN_FLOOR to MAX_LABEL_MIN, or null for `auto` and anything else (under the floor is ignored, so a theme cannot make labels unreadable) */
function labelMinOf(value) {
  const n = pxOf(value, MAX_LABEL_MIN);
  return n !== null && n >= LABEL_MIN_FLOOR ? n : null;
}

/** The glow factor: a number (`0` for none, `1` as drawn, up to MAX_GLOW; `0px` reads as 0), or null for `auto` and anything else */
function factorOf(value) {
  const m = /^\s*(\d*\.?\d+)(px)?\s*$/i.exec(String(value ?? ''));
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (m[2] && n !== 0) return null; // a length is not a factor, only zero is the same in both
  return Number.isFinite(n) && n >= 0 && n <= MAX_GLOW ? n : null;
}

/** The greyed node's opacity: a number from MIN_GREY_ALPHA to 1, or null for `auto` and anything else */
function greyAlphaOf(value) {
  const m = /^\s*(\d*\.?\d+)\s*$/.exec(String(value ?? ''));
  const n = m ? parseFloat(m[1]) : NaN;
  return Number.isFinite(n) && n >= MIN_GREY_ALPHA && n <= 1 ? n : null;
}

/**
 * The tokens as the page computes them.
 * @param {(name: string) => string} read the value of a custom property
 * @param {string[]} [extra] more colour tokens to read: those of the finer kinds and project layers on the map (`setMapSubjects`)
 * @returns {{values: Record<string, string>, strokeWidth: number, font: string | null, edgeWidth: number | null, glow: number | null, labelMin: number | null, greyAlpha: number | null}}
 *   `values` holds only the tokens that are a colour (not `auto`); `font`, `edgeWidth`, `glow`, `labelMin` and `greyAlpha` are null at `auto` or when the value is not one
 */
export function readMapTokens(read, extra = []) {
  const values = {};
  for (const name of [...MAP_COLOR_TOKENS, ...extra]) {
    const c = cssColor(read(name));
    if (c) values[name] = c;
  }
  const w = parseFloat(String(read(STROKE_WIDTH_TOKEN) ?? ''));
  return {
    values,
    strokeWidth: Number.isFinite(w) && w >= 0 ? w : DEFAULT_STROKE_WIDTH,
    font: cssFontList(read(FONT_TOKEN)),
    edgeWidth: pxOf(read(EDGE_WIDTH_TOKEN), MAX_EDGE_WIDTH),
    glow: factorOf(read(GLOW_TOKEN)),
    labelMin: labelMinOf(read(LABEL_MIN_TOKEN)),
    greyAlpha: greyAlphaOf(read(GREY_ALPHA_TOKEN)),
  };
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
    if (!iconKeyShape(kind) || typeof url !== 'string' || !url.startsWith(ICON_URL_PREFIX) || url.includes('..')) continue;
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
 * @property {string | null} font   the label font list (`--corn-map-font`), null at `auto`
 * @property {number | null} edgeWidth  an ordinary line's width in px (`--corn-map-edge-width`), null at `auto`
 * @property {number | null} glow   the glow factor (`--corn-map-glow`), null at `auto`
 * @property {number | null} labelMin  the smallest label size in px (`--corn-map-label-min`), null at `auto` or under 9px
 * @property {number | null} greyAlpha  how much of a greyed node is left (`--corn-map-grey-alpha`), null at `auto` or when it is not a number from 0.1 to 1
 * @property {ReturnType<typeof createIconStore> | null} icons
 * @property {boolean} pixelated   sample icons without smoothing
 * @property {boolean} plain       nothing to apply: no colour set, no icon loaded (the scene is drawn as it is)
 */

const NO_TOKENS = { values: {}, strokeWidth: DEFAULT_STROKE_WIDTH, font: null, edgeWidth: null, glow: null, labelMin: null, greyAlpha: null };
/** The style with nothing set: what a renderer or a label layer made without an instance draws with (the scene as it is) */
export const PLAIN_STYLE = Object.freeze({ version: 0, values: Object.freeze({}), strokeWidth: DEFAULT_STROKE_WIDTH, font: null, edgeWidth: null, glow: null, labelMin: null, greyAlpha: null, icons: null, pixelated: false, plain: true });
const MAX_SUBJECT_TOKENS = 500;

/**
 * The map style of one instance: the tokens read from its root, the icons, and who is told when either changes. One per instance
 * (`mapStyleOf(inst)`), so two maps on a page each read their own root's tokens and draw their own.
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst
 */
export function createMapStyle(inst) {
  let tokens = NO_TOKENS;
  let icons = null;
  let pixelated = false;
  let version = 0;
  /** The tokens of the finer kinds and project layers on the map, read besides the fixed list (their names come from the map and the config, through core/layers.js, which refuses a name that is not a plain one) */
  let subjectTokens = [];
  const listeners = new Set();

  const compose = () => {
    const plain = !Object.keys(tokens.values).length && !(icons && icons.anyReady()) && tokens.font === null && tokens.edgeWidth === null && tokens.glow === null && tokens.labelMin === null && tokens.greyAlpha === null;
    return Object.freeze({ version, values: tokens.values, strokeWidth: tokens.strokeWidth, font: tokens.font, edgeWidth: tokens.edgeWidth, glow: tokens.glow, labelMin: tokens.labelMin, greyAlpha: tokens.greyAlpha, icons, pixelated, plain });
  };
  let current = compose();

  let ended = false;
  inst.own(() => { ended = true; listeners.clear(); }); // the instance's end: an icon that arrives later tells nobody

  const changed = () => {
    if (ended) return;
    version++;
    current = compose();
    listeners.forEach((fn) => fn(current));
    inst.emit('mapstyle', current);
  };

  const store = {
    /** @returns {MapStyle} */
    get: () => current,

    /** Calls `fn(style)` when the style changes (a token, an icon arriving); returns how to stop */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * Tells the style which finer kinds (`[type, kind]`) and project layers (keys) are on the map, so the tokens that colour them
     * (`--corn-map-kind-<type>-<kind>`, `--corn-map-group-<key>`) are read. True when the set changed and a token differed.
     * @param {{kinds?: [string, string][], layers?: string[]}} [subjects]
     */
    setSubjects({ kinds = [], layers = [] } = {}) {
      const names = [...new Set([...kinds.map(([t, k]) => mapKindToken(t, k)), ...layers.map((l) => mapGroupToken(l))].filter(Boolean))].sort().slice(0, MAX_SUBJECT_TOKENS);
      if (names.length === subjectTokens.length && names.every((n, i) => n === subjectTokens[i])) return false;
      subjectTokens = names;
      return store.refresh();
    },

    /**
     * Reads the tokens again; true when something differed (and the listeners were told). Run on load and whenever the theme changes.
     * @param {(name: string) => string} [read] default: the computed style at the instance's root
     */
    refresh(read = inst.tokenReader()) {
      if (!read) return false;
      const next = readMapTokens(read, subjectTokens);
      const same = next.strokeWidth === tokens.strokeWidth && next.font === tokens.font && next.edgeWidth === tokens.edgeWidth && next.glow === tokens.glow && next.labelMin === tokens.labelMin
        && Object.keys(next.values).length === Object.keys(tokens.values).length
        && Object.entries(next.values).every(([k, v]) => tokens.values[k] === v);
      if (same) return false;
      tokens = next;
      changed();
      // A web font the labels name is fetched when something asks for it, and a canvas does not wait for one: ask now, and draw again when it is in
      try { const fonts = inst.doc && inst.doc.fonts; if (next.font && fonts && fonts.load) fonts.load(`12px ${next.font}`).catch(() => {}); } catch { /* no font loading here */ }
      return true;
    },

    /**
     * Starts loading the config's icons (`theme.icons`, as the browser is told them: kind to served path) and sets the pixelated flag.
     * The images are fetched from the instance's base.
     * @param {{icons?: Record<string, string>, pixelated?: boolean} | null | undefined} theme
     * @param {Parameters<typeof createIconStore>[1]} [opts]
     */
    setIcons(theme, opts = {}) {
      const urls = theme && theme.icons && typeof theme.icons === 'object' ? theme.icons : {};
      pixelated = !!(theme && theme.pixelated === true);
      const load = opts.load || ((url) => loadImage(inst.url(url)));
      icons = Object.keys(urls).length ? createIconStore(urls, { ...opts, load, onChange: () => { changed(); if (opts.onChange) opts.onChange(); } }) : null;
      changed();
      return icons;
    },

    /**
     * The config's part of the map theme once the page has it: loads the icons, sets the pixelated flag, and marks the root element
     * `data-pixelated` (for the page, <html>) so a stylesheet can sample any DOM image without smoothing too (`image-rendering: pixelated`, explorer.css).
     * @param {{icons?: Record<string, string>, pixelated?: boolean} | null | undefined} theme `config.theme` of /cornfield/config.json
     */
    applyTheme(theme, opts = {}) {
      const el = inst.tokenElement();
      if (el && el.setAttribute) { if (theme && theme.pixelated === true) el.setAttribute('data-pixelated', ''); else el.removeAttribute('data-pixelated'); }
      return store.setIcons(theme, opts);
    },

    /** Back to nothing set (for tests) */
    reset() {
      tokens = NO_TOKENS;
      icons = null;
      pixelated = false;
      subjectTokens = [];
      changed();
    },

    /**
     * Keeps the style right as the theme changes: `data-theme` or `data-theme-name` on the root element changing, a stylesheet finishing loading
     * (a named theme's, or the theme file's: `load` captured at the root), and `prefers-color-scheme` flipping. Everything is removed by `inst.destroy()`;
     * the returned function stops it earlier.
     */
    watch() {
      const refresh = () => { store.refresh(); };
      const stops = [];
      const el = inst.tokenElement();
      if (el && inst.win && inst.win.MutationObserver) {
        const obs = new inst.win.MutationObserver(refresh);
        obs.observe(el, { attributes: true, attributeFilter: ['data-theme', 'data-theme-name', 'class'] });
        stops.push(() => obs.disconnect());
      }
      if (inst.root) {
        const onLoad = (event) => { if (event.target && event.target.tagName === 'LINK') refresh(); }; // load does not bubble: captured
        stops.push(inst.listen(inst.root, 'load', onLoad, true));
      }
      const media = inst.win && inst.win.matchMedia ? inst.win.matchMedia('(prefers-color-scheme: light)') : null;
      if (media) {
        if (media.addEventListener) { media.addEventListener('change', refresh); stops.push(() => media.removeEventListener('change', refresh)); }
        else if (media.addListener) { media.addListener(refresh); stops.push(() => media.removeListener(refresh)); }
      }
      const fonts = inst.doc && inst.doc.fonts;
      if (fonts && fonts.addEventListener) {
        const again = () => { if (tokens.font) changed(); }; // the label font arrived: the canvas draws again with it
        fonts.addEventListener('loadingdone', again);
        stops.push(() => fonts.removeEventListener('loadingdone', again));
      }
      refresh();
      const stop = () => { while (stops.length) stops.pop()(); };
      inst.own(stop);
      return stop;
    },
  };
  return store;
}

/** The instance's map style (made on first use) */
export const mapStyleOf = (inst) => inst.slot('map-style', createMapStyle);

// ---------------------------------------------------------------------------
//  Applying it
// ---------------------------------------------------------------------------

const firstOf = (values, names) => { for (const n of names) if (values[n]) return values[n]; return null; };

/** The tokens that can fill a node, most specific first (core/layers.js `mapFillNames`, the one place the order is written) */
export const fillNames = mapFillNames;

/** The theme's fill for a node of that kind, layer, type and group (`values` of a style), or null: the node then draws its own colour (`auto`) */
export const fillOf = (values, node) => firstOf(values, fillNames(node));

/** A line's shape in the theme: its width scaled to `--corn-map-edge-width`, its glow and its packet's by `--corn-map-glow` (nothing at `auto`) */
function shapeEdge(e, style) {
  const scale = style.edgeWidth == null ? 1 : style.edgeWidth / BASE_EDGE_WIDTH;
  const glow = style.glow == null ? 1 : style.glow;
  if (scale === 1 && glow === 1) return e;
  const out = { ...e, width: e.width * scale, glow: e.glow * glow };
  if (e.packet) out.packet = { ...e.packet, glow: e.packet.glow * glow };
  return out;
}

function styleEdge(e, style, painted) {
  const { values } = style;
  if (e.mark && e.mark !== 'none') {
    const c = values[stateToken(e.mark)];
    return shapeEdge(c ? { ...e, color: c, glowColor: e.glowColor ? c : e.glowColor } : e, style);
  }
  if (painted.has(e.key)) return shapeEdge(e, style);
  const lit = !e.curve && e.glow > 0 && !e.arrow; // a straight link the focus lights
  const c = (lit && values[stateToken('lit')]) || values[edgeToken(e.kind)];
  if (!c) return shapeEdge(e, style);
  const out = { ...e, color: withAlphaOf(c, e.color) };
  if (e.glowColor) out.glowColor = withAlphaOf(c, e.glowColor);
  if (e.packet) out.packet = { ...e.packet, glowColor: withAlphaOf(c, e.packet.glowColor) };
  return shapeEdge(out, style);
}

/** A colour with its hue taken away: the grey of the same lightness, alpha kept. Both renderers read the same `rgb()` */
export function greyOf(color) {
  const [r, g, b, a] = parseColor(color);
  const l = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  return a >= 1 ? `rgb(${l}, ${l}, ${l})` : rgbaText(l, l, l, a);
}

function compute(scene, style) {
  const { values } = style;
  const greyToken = values[GREY_TOKEN];
  const fade = style.greyAlpha == null ? 1 : style.greyAlpha / GREY_ALPHA;
  const toGrey = (c) => (greyToken ? withAlphaOf(greyToken, c) : greyOf(c));
  const label = values[LABEL_TOKEN];
  const stroke = values[STROKE_TOKEN];
  const painted = scene.painted || { nodes: new Set(), edges: new Set() };
  const nodes = scene.nodes.map((n) => {
    // Which fill wins, most specific first (spec 0009 D6): the finer kind, the project layer, the type, the starting layer
    const fill = !painted.nodes.has(n.id) && fillOf(values, n);
    const icon = style.icons ? iconKeysFor(n.type, n.kind, n.layer).find((k) => style.icons.get(k)) || null : null; // the same order: kind, layer, type
    const glows = style.glow != null && style.glow !== 1 && n.glow > 0;
    const grey = !!n.greyed && !painted.nodes.has(n.id); // a review greys what the change does not involve; a colour a painter gave means something and stays
    if (!fill && !label && !stroke && !icon && !glows && !grey) return n;
    const out = { ...n };
    if (glows) out.glow = n.glow * style.glow;
    if (fill) out.color = fill;
    if (label) out.labelColor = withAlphaOf(label, n.labelColor);
    if (stroke && style.strokeWidth > 0) out.stroke = { color: grey ? toGrey(stroke) : stroke, width: style.strokeWidth };
    if (icon && !grey) out.icon = icon; // a picture has its own hues: a greyed node keeps its silhouette, glyph and letters
    if (grey) { out.color = toGrey(out.color); out.alpha = Math.min(1, n.alpha * fade); }
    return out;
  });
  const edges = scene.edges.map((e) => {
    const styled = styleEdge(e, style, painted.edges);
    if (!e.greyed || painted.edges.has(e.key)) return styled;
    return { ...styled, color: toGrey(styled.color), glowColor: null, alpha: Math.min(1, styled.alpha * fade) };
  });
  const out = { ...scene, nodes, edges };
  if (style.font) out.labelFont = style.font; // every label's font list (labels.js reads `scene.labelFont`)
  if (style.labelMin != null) out.labelMin = style.labelMin; // the smallest label on screen (labels.js reads `scene.labelMin`)
  const halo = values[LABEL_HALO_TOKEN];
  if (halo) { // the outline under the labels, at the widths it has (labels.js reads `scene.labelOutline` before the ground's own)
    const { node, edge } = looksFor(scene.theme).labelOutline;
    out.labelOutline = { node: { ...node, color: halo }, edge: { ...edge, color: halo } };
  }
  return out;
}

// Both memos hold the style they were made for, not its version: a style is a new frozen object at every change, and two instances' styles
// count their versions apart, so the same version number can be two different themes (`looksFor` hands every instance the same looks object)
const sceneMemo = new WeakMap();

/**
 * `scene` in the style's colours, with the outline and icon of each node that has one: the same object when there is nothing to apply, and
 * the same result for the same scene and style, so a renderer's cache of what it packed holds.
 * @param {import('./scene.js').Scene} scene
 * @param {MapStyle} [style] the instance's (`mapStyleOf(inst).get()`); none: the scene as it is
 */
export function styledScene(scene, style) {
  if (!style || (style.plain && !scene.greying)) return scene; // a review's greying is applied even with no theme
  const hit = sceneMemo.get(scene);
  if (hit && hit.style === style) return hit.out;
  const out = compute(scene, style);
  sceneMemo.set(scene, { style, out });
  return out;
}

const looksMemo = new WeakMap();

/**
 * The halos and mark rings (scene.js `looksFor`) in the style's colours: a selected node's, a search hit's, and each diff mark's.
 * @param {ReturnType<typeof import('./scene.js').looksFor>} looks
 * @param {MapStyle} [style]
 */
export function looksWith(looks, style) {
  if (!style || style.plain) return looks;
  const hit = looksMemo.get(looks);
  if (hit && hit.style === style) return hit.out;
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
  looksMemo.set(looks, { style, out });
  return out;
}

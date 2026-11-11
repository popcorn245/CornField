/**
 * @module core/map-tokens
 *
 * The map's non-colour tokens, as `cornfield validate` reads them: `--corn-map-font`, `--corn-map-edge-width`, `--corn-map-glow` and `--corn-map-label-min`. The
 * map reads each with the same parser (explorer/map-style.js `readMapTokens`), and one it cannot read is drawn as if it were `auto`; this
 * says so before the theme ships, as a warning naming the token, the theme, the level and what it may hold (docs/theming.md, The map).
 */

import { declaredProps, expand, projectGroupOf, resolveProps, themesToCheck } from './contrast.js';
import { iconKeyShape, parseKindToken } from './layers.js';
import { readColor } from './color.js';
import { MAX_NODE_COLOR_CHARS } from '../explorer/css-color.js';
import { EDGE_WIDTH_TOKEN, FONT_TOKEN, GLOW_TOKEN, LABEL_MIN_TOKEN, MAX_EDGE_WIDTH, MAX_GLOW, MAX_LABEL_MIN, readMapTokens } from '../explorer/map-style.js';

const WANTS = {
  [FONT_TOKEN]: ['font', 'a list of font families (quoted names or plain words, at most 8; no url(), and no punctuation but commas and quotes)'],
  [EDGE_WIDTH_TOKEN]: ['edgeWidth', `a width in px over 0 and at most ${MAX_EDGE_WIDTH}`],
  [GLOW_TOKEN]: ['glow', `a factor from 0 (no glow) to ${MAX_GLOW}`],
  [LABEL_MIN_TOKEN]: ['labelMin', `a size in px from 9 to ${MAX_LABEL_MIN} (11px is the default and the least it draws at; under 9px is ignored)`],
};

/**
 * One warning per map token a theme sets to something the map cannot use (once per theme, whichever level shows it first).
 * @param {{ root: string, theme?: object }} config
 * @returns {string[]}
 */
export function mapTokenWarnings(config) {
  const themes = themesToCheck(config);
  if (!themes) return [];
  const out = [];
  for (const { theme, sheets, name } of themes) {
    const said = new Set();
    for (const mode of ['light', 'dark']) {
      const props = resolveProps(sheets, { mode, system: mode, name });
      const read = (token) => { if (!props.has(token)) return 'auto'; const r = expand(`var(${token})`, props); return 'text' in r ? r.text.trim() : ''; };
      const got = readMapTokens(read);
      for (const [token, [key, wants]] of Object.entries(WANTS)) {
        const raw = read(token);
        if (said.has(token) || raw.toLowerCase() === 'auto' || got[key] !== null) continue;
        said.add(token);
        const who = theme === 'standard' ? 'the standard theme' : `named theme "${theme}"`;
        out.push(`theme: ${token} in ${who} (${mode}) is "${raw.slice(0, 60)}${raw.length > 60 ? '…' : ''}", which the map cannot use, so it draws as auto: write ${wants}, or auto.`);
      }
    }
  }
  return out;
}

/**
 * Warnings about a kind or a project layer a theme names that is not there (spec 0009 D6): a typo would otherwise do nothing, silently.
 *  - a `--corn-map-kind-<type>-<kind>` token for a kind no node of that type has on the map, or that is not shaped like one
 *  - a `--corn-map-group-<key>` token for a layer the config does not have (not a starting group either)
 *  - a `theme.icons` key `"<type>:<kind>"` for a kind not on the map, or `"layer:<key>"` for a layer not in the config
 * Each warning names the token or icon key and what is on the map. Warnings, never errors: a theme may be shared between repos.
 * @param {{ root: string, theme?: object, layers?: { add?: { key: string }[] } }} config
 * @param {{ nodes: { type: string, kind?: unknown }[] } | null} map the committed map
 * @returns {string[]}
 */
export function layerTokenWarnings(config, map) {
  const out = [];
  const nodes = (map && map.nodes) || [];
  const kinds = new Map();
  for (const n of nodes) if (typeof n.kind === 'string' && n.kind) { if (!kinds.has(n.type)) kinds.set(n.type, new Set()); kinds.get(n.type).add(n.kind); }
  const layers = new Set(((config.layers && config.layers.add) || []).map((l) => l.key));
  const kindsOf = (type) => (kinds.has(type) ? [...kinds.get(type)].sort().slice(0, 8).join(', ') : 'none');
  const layersWord = layers.size ? [...layers].join(', ') : 'none are in the config';
  const typoOfKind = (type, kind) => `${type} kinds on the map: ${kindsOf(type)}`;
  const themes = themesToCheck(config);
  for (const { theme, sheets } of themes || []) {
    const who = theme === 'standard' ? 'the standard theme' : `named theme "${theme}"`;
    for (const name of [...declaredProps(sheets)].sort()) {
      if (name.startsWith('--corn-map-kind-')) {
        const k = parseKindToken(name);
        if (!k) out.push(`theme: ${name} in ${who} is not a kind token: write --corn-map-kind-<node type>-<kind>, like --corn-map-kind-service-timer (lower-case words joined by "-").`);
        else if (!kinds.has(k.type) || !kinds.get(k.type).has(k.kind)) out.push(`theme: ${name} in ${who} names a kind no ${k.type} on the map has (${typoOfKind(k.type, k.kind)}), so it paints nothing: check the spelling.`);
      } else if (name.startsWith('--corn-map-group-')) {
        const key = projectGroupOf(name);
        if (name.slice('--corn-map-group-'.length) && key && !layers.has(key)) out.push(`theme: ${name} in ${who} names a layer the config does not have (project layers: ${layersWord}), so it paints nothing: check the spelling.`);
      }
    }
  }
  const icons = config.theme && config.theme.icons && typeof config.theme.icons === 'object' ? Object.keys(config.theme.icons) : [];
  for (const key of icons) {
    const shape = iconKeyShape(key);
    if (!shape) continue; // refused by the config check
    if ('layer' in shape && !layers.has(shape.layer)) out.push(`theme.icons "${key}" names a layer the config does not have (project layers: ${layersWord}), so it is never drawn: check the spelling.`);
    else if ('kind' in shape && (!kinds.has(shape.type) || !kinds.get(shape.type).has(shape.kind))) out.push(`theme.icons "${key}" names a kind no ${shape.type} on the map has (${typoOfKind(shape.type, shape.kind)}), so it is never drawn: check the spelling.`);
  }
  return out;
}

/** How many node colours are named one by one, per kind of line: past this, one line counts the rest */
export const MAX_NODE_COLOR_WARNINGS = 10;
const SHOWN_CHARS = 40;

/** What JSON leaves as it is but a terminal must not get raw: DEL and the C1 controls, and the invisible and bidirectional marks */
const UNSEEN = new RegExp('[\\u007f-\\u009f\\u00ad\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]', 'g');

/**
 * Project text as a terminal may print it: JSON-quoted (so a line break, an escape character and every other C0 control is `\n`, `\u001b`,
 * ...), cut to `max` characters, and with the controls JSON leaves alone made visible too (DEL, the C1 controls such as U+009B, which some
 * terminals read as an escape, and the invisible and bidirectional marks that could make a line read as something it is not).
 * @param {unknown} v
 * @param {number} [max]
 * @returns {string}
 */
export function quoted(v, max = SHOWN_CHARS) {
  let t;
  try { t = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v); } catch { t = String(v); }
  const chars = Array.from(t);
  if (chars.length > max) t = `${chars.slice(0, max).join('')}...`;
  return JSON.stringify(t).replace(UNSEEN, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Colour functions a current browser reads that core/color.js does not work out (it reads rgb() and hsl() only in their plainer forms) */
const UNCHECKED_FN = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i;
/** The CSS system colours (CSS Color 4, with the deprecated ones browsers still read): the map draws them, in the colour the device gives */
const SYSTEM_COLORS = new Set(('accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext field fieldtext graytext highlight '
  + 'highlighttext linktext mark marktext selecteditem selecteditemtext visitedtext activeborder activecaption appworkspace background buttonhighlight '
  + 'buttonshadow captiontext inactiveborder inactivecaption inactivecaptiontext infobackground infotext menu menutext scrollbar threeddarkshadow '
  + 'threedface threedhighlight threedlightshadow threedshadow window windowframe windowtext').split(' '));

/**
 * How `cornfield validate` can speak of a node's own `color`, which the map checks in the browser (explorer/css-color.js `nodeColor`):
 * - `ok`: core/color.js reads it (hex, rgb(), hsl(), the 148 names, transparent, color-mix in srgb), so the browser does too;
 * - `unchecked`: the shape of a colour a current browser reads that core/color.js cannot work out (`oklch()`, `lab()`, `hwb()`, `color()`,
 *   `color-mix()` in another space, rgb()/hsl() in a newer form, a system colour): the map draws it if it is valid, else the type's fill;
 * - `bad`: no browser's map draws it (a typo, `#12345`, an empty string, a number, `currentcolor`, `var()`, `light-dark()`, which a canvas
 *   does not read, text over MAX_NODE_COLOR_CHARS): the map draws the type's fill.
 * @param {unknown} value a node's `color`, not undefined
 * @returns {'ok' | 'unchecked' | 'bad'}
 */
export function nodeColorClass(value) {
  if (typeof value !== 'string' || value.length > MAX_NODE_COLOR_CHARS) return 'bad';
  const s = value.trim();
  if (!s || /currentcolor|light-dark\(|var\(|env\(|attr\(/i.test(s)) return 'bad'; // the map never draws these (explorer/css-color.js)
  if (readColor(s)) return 'ok';
  if (UNCHECKED_FN.test(s) && s.endsWith(')')) return 'unchecked';
  return SYSTEM_COLORS.has(s.toLowerCase()) ? 'unchecked' : 'bad';
}

const nodesWithColor = (map, kind) => ((map && map.nodes) || []).filter((n) => n && n.color !== undefined && nodeColorClass(n.color) === kind);
const capped = (nodes, line, rest) => {
  const out = nodes.slice(0, MAX_NODE_COLOR_WARNINGS).map(line);
  if (nodes.length > MAX_NODE_COLOR_WARNINGS) out.push(rest(nodes.length - MAX_NODE_COLOR_WARNINGS, nodes.length));
  return out;
};

/**
 * A warning per node whose own `color` no browser's map draws (nodeColorClass `bad`): the map draws that node in its type's fill instead
 * (explorer/scene.js `buildNodes`). The id and the value are printed as quoted text (`quoted`), at most MAX_NODE_COLOR_WARNINGS lines, then a count.
 * @param {{ nodes?: { id?: unknown, color?: unknown }[] } | null} map the committed map
 * @returns {string[]}
 */
export function nodeColorWarnings(map) {
  return capped(nodesWithColor(map, 'bad'),
    (n) => `node ${quoted(n.id)} has color ${quoted(n.color)}, which is not a colour the map reads: it draws in its type's fill. Write #rrggbb, rgb(), rgba() or hsl().`,
    (more, all) => `${more} more nodes have a color the map does not read (${all} in all): they draw in their type's fill.`);
}

/**
 * A note per node whose own `color` validate cannot check (nodeColorClass `unchecked`: `oklch()`, `lab()`, a system colour, ...). Not a
 * warning: a current browser draws a valid one, and only an invalid one falls back to the type's fill. Same form and cap as the warnings.
 * @param {{ nodes?: { id?: unknown, color?: unknown }[] } | null} map the committed map
 * @returns {string[]}
 */
export function nodeColorNotes(map) {
  return capped(nodesWithColor(map, 'unchecked'),
    (n) => `node ${quoted(n.id)} has color ${quoted(n.color)}, which validate cannot check: a current browser draws it if it is a valid colour, else the node draws in its type's fill.`,
    (more, all) => `${more} more nodes have a color validate cannot check (${all} in all).`);
}

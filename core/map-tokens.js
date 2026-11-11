/**
 * @module core/map-tokens
 *
 * The map's non-colour tokens, as `cornfield validate` reads them: `--corn-map-font`, `--corn-map-edge-width`, `--corn-map-glow` and `--corn-map-label-min`. The
 * map reads each with the same parser (explorer/map-style.js `readMapTokens`), and one it cannot read is drawn as if it were `auto`; this
 * says so before the theme ships, as a warning naming the token, the theme, the level and what it may hold (docs/theming.md, The map).
 */

import { declaredProps, expand, projectGroupOf, resolveProps, themesToCheck } from './contrast.js';
import { iconKeyShape, parseKindToken } from './layers.js';
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

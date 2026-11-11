/**
 * @module core/map-tokens
 *
 * The map's non-colour tokens, as `cornfield validate` reads them: `--corn-map-font`, `--corn-map-edge-width` and `--corn-map-glow`. The
 * map reads each with the same parser (explorer/map-style.js `readMapTokens`), and one it cannot read is drawn as if it were `auto`; this
 * says so before the theme ships, as a warning naming the token, the theme, the level and what it may hold (docs/theming.md, The map).
 */

import { expand, resolveProps, themesToCheck } from './contrast.js';
import { EDGE_WIDTH_TOKEN, FONT_TOKEN, GLOW_TOKEN, MAX_EDGE_WIDTH, MAX_GLOW, readMapTokens } from '../explorer/map-style.js';

const WANTS = {
  [FONT_TOKEN]: ['font', 'a list of font families (quoted names or plain words, at most 8; no url(), and no punctuation but commas and quotes)'],
  [EDGE_WIDTH_TOKEN]: ['edgeWidth', `a width in px over 0 and at most ${MAX_EDGE_WIDTH}`],
  [GLOW_TOKEN]: ['glow', `a factor from 0 (no glow) to ${MAX_GLOW}`],
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

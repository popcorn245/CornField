/**
 * @vitest-environment node
 *
 * `cornfield validate` warns about a map font, line width or glow the map cannot read (core/map-tokens.js): the map draws it as auto.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { mapTokenWarnings } from '../../core/map-tokens.js';
import { CORNFIELD } from '../helpers.js';

const dirs = [];
const repoWith = (css) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-maptokens-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'theme'));
  fs.writeFileSync(path.join(dir, 'theme', 'theme.css'), css);
  return { root: dir, theme: { css: 'theme/theme.css' } };
};
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('map tokens the map cannot read', () => {
  it('warns once per token, naming the theme, the level and what it may hold', () => {
    const w = mapTokenWarnings(repoWith(':root { --corn-map-font: url(x), sans-serif; --corn-map-edge-width: 0; --corn-map-glow: 3px; }'));
    expect(w).toHaveLength(3);
    expect(w.find((l) => l.includes('--corn-map-font'))).toMatch(/standard theme .*"url\(x\), sans-serif".*draws as auto/);
    expect(w.find((l) => l.includes('--corn-map-edge-width'))).toMatch(/over 0 and at most 12/);
    expect(w.find((l) => l.includes('--corn-map-glow'))).toMatch(/factor from 0/);
  });

  it('warns about a smallest label under 9px, which the map ignores (spec 0008)', () => {
    const w = mapTokenWarnings(repoWith(':root { --corn-map-label-min: 7px; }'));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/--corn-map-label-min.*"7px".*a size in px from 9 to 24/);
    expect(mapTokenWarnings(repoWith(':root { --corn-map-label-min: 13px; }'))).toEqual([]);
  });

  it('says nothing for auto, for good values, and for the default font stack given by var()', () => {
    expect(mapTokenWarnings({ root: CORNFIELD, theme: {} })).toEqual([]);
    expect(mapTokenWarnings(repoWith(':root { --corn-map-font: var(--corn-font); --corn-map-edge-width: 2.4px; --corn-map-glow: 0; }'))).toEqual([]);
    expect(mapTokenWarnings({ root: CORNFIELD, theme: { css: 'test/fixtures/themes/retro/theme.css' } })).toEqual([]);
  });
});

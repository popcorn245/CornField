/**
 * The map's palette (spec 0008 D8): CIEDE2000 itself (against Sharma's published pairs), every node type has a silhouette, the default palette keeps
 * types of one silhouette at least ΔE 15 apart on the dark ground and the light one, and `validate` warns, without failing, when a theme's map colours do not.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deltaE2000Lab, deltaE2000, toLab } from '../../core/delta-e.js';
import { NODE_SHAPES, NODE_THEMES, SHAPES, MIN_SHAPE_DELTA_E, shapeOf } from '../../core/schema.js';
import { TOKENS_FILE, checkThemeContrast, describePalette, paletteProblems } from '../../core/contrast.js';
import { lightColor, parseColor } from '../../explorer/theme-model.js';

describe('CIEDE2000', () => {
  it('matches the published test pairs (Sharma, Wu, Dalal 2005)', () => {
    const cases = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
      [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
      [[50, 2.5, 0], [73, 25, -18], 27.1492],
    ];
    for (const [a, b, want] of cases) expect(deltaE2000Lab(a, b)).toBeCloseTo(want, 3);
  });
  it('is 0 for the same colour, symmetric, and 100 from black to white', () => {
    expect(deltaE2000([10, 120, 200], [10, 120, 200])).toBe(0);
    expect(deltaE2000([200, 30, 30], [30, 200, 30])).toBeCloseTo(deltaE2000([30, 200, 30], [200, 30, 30]), 9);
    expect(deltaE2000([0, 0, 0], [255, 255, 255])).toBeCloseTo(100, 1);
    expect(toLab([255, 255, 255])[0]).toBeCloseTo(100, 1);
  });
});

describe('silhouettes', () => {
  it('gives every node type one, from the fixed list', () => {
    for (const type of Object.keys(NODE_THEMES)) expect(SHAPES, type).toContain(NODE_SHAPES[type]);
    expect(shapeOf('persona')).toBe('diamond');
    expect(shapeOf('store')).toBe('rounded-square');
    expect(shapeOf('external')).toBe('hexagon');
    expect(shapeOf('machine')).toBe('square');
    expect(shapeOf('page')).toBe('circle');
    expect(shapeOf('constructor')).toBe('circle'); // project data only selects from the table
    expect(shapeOf('__proto__')).toBe('circle');
    expect(shapeOf(undefined)).toBe('circle');
  });
});

describe('the default palette (D8)', () => {
  const table = [];
  for (const mode of ['dark', 'light']) {
    const fill = (t) => parseColor(mode === 'light' ? lightColor(NODE_THEMES[t].color) : NODE_THEMES[t].color).slice(0, 3);
    const types = Object.keys(NODE_SHAPES);
    for (let i = 0; i < types.length; i++) for (let j = i + 1; j < types.length; j++) {
      if (NODE_SHAPES[types[i]] === NODE_SHAPES[types[j]]) table.push({ mode, pair: `${types[i]}/${types[j]}`, d: deltaE2000(fill(types[i]), fill(types[j])) });
    }
  }
  it('keeps every two types that share a silhouette at least ΔE 15 apart, on both grounds', () => {
    const close = table.filter((r) => r.d < MIN_SHAPE_DELTA_E).map((r) => `${r.mode} ${r.pair} ${r.d.toFixed(1)}`);
    expect(close).toEqual([]);
    expect(table.length).toBeGreaterThan(60);
  });
  it('has no pair for `paletteProblems` to find in the standard theme', () => {
    expect(paletteProblems([{ theme: 'standard', sheets: [fs.readFileSync(TOKENS_FILE, 'utf8')] }])).toEqual([]);
  });
});

describe('a theme\'s map colours (validate)', () => {
  const css = fs.readFileSync(TOKENS_FILE, 'utf8');
  const bad = ':root { --corn-map-node-page: #38bdf8; --corn-map-node-pkg: #3ab9f8; }';
  it('finds two types of one silhouette that the theme set too close, in both modes, naming the tokens', () => {
    const found = paletteProblems([{ theme: 'night', name: 'night', sheets: [css, bad] }]);
    expect(found.map((f) => `${f.mode} ${f.a}/${f.b}`).sort()).toEqual(['dark page/pkg', 'light page/pkg']);
    expect(describePalette(found[0])).toMatch(/named theme "night" \((dark|light)\): page \(--corn-map-node-page\) and pkg \(--corn-map-node-pkg\) share the circle silhouette and are ΔE \d+\.\d apart, under 15/);
  });
  it('does not mind two types of different silhouettes sharing a colour', () => {
    const same = ':root { --corn-map-node-page: #38bdf8; --corn-map-node-table: #38bdf8; }';
    expect(paletteProblems([{ theme: 'night', name: 'night', sheets: [css, same] }])).toEqual([]);
  });
  it('is a warning in `cornfield validate`, never an error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palette-'));
    try {
      fs.writeFileSync(path.join(dir, 'theme.css'), `/* a theme */\n${bad}\n`);
      const out = checkThemeContrast({ root: dir, theme: { css: 'theme.css' } });
      expect(out.errors.filter((e) => /map colours/.test(e))).toEqual([]);
      expect(out.warnings.some((w) => /theme map colours: .*page.*pkg.*circle silhouette/.test(w))).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('--corn-map-glyph in validate', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'glyph-'));
  it('is read at 3:1 against every fill when a theme sets it, and a bad one is an error naming the token', () => {
    const d = dir();
    try {
      fs.writeFileSync(path.join(d, 'theme.css'), ':root { --corn-map-glyph: #38bdf8; }');
      const out = checkThemeContrast({ root: d, theme: { css: 'theme.css' } });
      expect(out.errors.some((e) => /--corn-map-glyph \(the glyph on a page node\)/.test(e))).toBe(true);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
    expect(fs.readFileSync(TOKENS_FILE, 'utf8')).toMatch(/--corn-map-glyph: auto;/);
  });
});

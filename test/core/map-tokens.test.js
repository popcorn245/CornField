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
import { mapTokenWarnings, nodeColorClass, nodeColorNotes, nodeColorWarnings, quoted, MAX_NODE_COLOR_WARNINGS } from '../../core/map-tokens.js';
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

describe('cornfield validate: nodeColorWarnings', () => {
  const map = (colors) => ({ nodes: colors.map((c, i) => ({ id: `n${i}`, type: 'page', color: c })) });
  it('is quiet for every colour core/color.js reads, and for a node with no colour', () => {
    expect(nodeColorWarnings(map(['#336699', '#369', '#3699', '#336699cc', 'rgb(1,2,3)', 'rgba(1, 2, 3, .5)', 'hsl(10, 50%, 50%)', 'teal', 'transparent']))).toEqual([]);
    expect(nodeColorWarnings({ nodes: [{ id: 'a', type: 'page' }] })).toEqual([]);
    expect(nodeColorWarnings(null)).toEqual([]);
  });
  it('names the node and the value, one line each, as quoted text cut short', () => {
    const w = nodeColorWarnings({ nodes: [{ id: 'good', color: '#fff' }, { id: 'a<b>', color: '#12345' }, { id: 'long', color: 'x'.repeat(10000) }, { id: 'num', color: 7 }, { id: 'nul', color: null }] });
    expect(w).toHaveLength(4);
    expect(w[0]).toContain('"a<b>"');
    expect(w[0]).toContain('"#12345"');
    expect(w[1].length).toBeLessThan(250);
    expect(w[1]).toContain('...');
    expect(w[2]).toContain('"7"');
    expect(w[3]).toContain('"null"');
  });
  it('prints a count, not a thousand lines', () => {
    const w = nodeColorWarnings(map(Array(1000).fill('#12345')));
    expect(w).toHaveLength(MAX_NODE_COLOR_WARNINGS + 1);
    expect(w.at(-1)).toContain('990 more');
  });
  it('never says a colour the browser draws falls back: every CSS name is read, and the forms only a browser works out get a note, not a warning', () => {
    // The 148 names, any case: the browser draws each, so validate is quiet
    expect(nodeColorWarnings(map(['hotpink', 'RebeccaPurple', 'cornflowerblue', 'lightgoldenrodyellow', 'darkslategrey']))).toEqual([]);
    expect(nodeColorNotes(map(['hotpink', 'rebeccapurple']))).toEqual([]);
    // Drawn by a current browser, but not worked out here: a note that says so, never the warning
    const modern = ['oklch(60% 0.1 200)', 'oklab(0.6 0.1 0.1)', 'lab(50% 20 30)', 'lch(50% 30 200)', 'hwb(10 20% 30%)', 'color(display-p3 1 0 0)',
      'color-mix(in oklch, red, blue)', 'rgb(from red r g b)', 'hsl(120 50 50)', 'hsl(0.5turn 50% 50%)', 'rgb(none 0 0)', 'Canvas', 'ButtonText'];
    for (const c of modern) expect([c, nodeColorClass(c)]).toEqual([c, 'unchecked']);
    expect(nodeColorWarnings(map(modern))).toEqual([]);
    const notes = nodeColorNotes(map(modern));
    expect(notes).toHaveLength(MAX_NODE_COLOR_WARNINGS + 1);
    expect(notes[0]).toBe('node "n0" has color "oklch(60% 0.1 200)", which validate cannot check: a current browser draws it if it is a valid colour, else the node draws in its type\'s fill.');
    expect(notes.at(-1)).toContain('3 more');
    for (const n of notes) expect(n).not.toContain('it draws in its type\'s fill.');
  });
  it('keeps the firm warning for what no browser\'s map draws', () => {
    const bad = ['#12345', 'bluee', '', '   ', 'not a colour', 'currentcolor', 'var(--x)', 'light-dark(red, blue)', 'color-mix(in srgb, currentcolor, red)', 'auto', 'inherit', 'url(x)', 'expression(alert(1))', 'oklch(60% 0.1 200', 'x'.repeat(10000)];
    for (const c of bad) expect([c.slice(0, 30), nodeColorClass(c)]).toEqual([c.slice(0, 30), 'bad']);
    for (const c of [7, null, {}, ['#fff'], true]) expect(nodeColorClass(c)).toBe('bad');
    expect(nodeColorWarnings(map(['bluee', '#12345']))).toEqual([
      'node "n0" has color "bluee", which is not a colour the map reads: it draws in its type\'s fill. Write #rrggbb, rgb(), rgba() or hsl().',
      'node "n1" has color "#12345", which is not a colour the map reads: it draws in its type\'s fill. Write #rrggbb, rgb(), rgba() or hsl().',
    ]);
    expect(nodeColorNotes(map(bad))).toEqual([]);
  });
  it('prints a node\'s id and colour as inert text: no escape sequence, line break, C1 control or bidi mark reaches the terminal raw', () => {
    const evil = '\u001b]0;pwned\u0007\u001b[2J\r\nwarning: all good\u009b31m\u202etxt.exe\u007f';
    const [w] = nodeColorWarnings({ nodes: [{ id: evil, color: evil }] });
    expect(w).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/);
    expect(w).toContain('\\u001b');
    expect(w).toContain('\\u009b');
    expect(w).toContain('\\u202e');
    expect(w.split('\n')).toHaveLength(1);
    expect(quoted('a"b')).toBe('"a\\"b"');
    expect(quoted({ a: 1 })).toBe('"{\\"a\\":1}"');
    expect(quoted('\u{1F600}'.repeat(50)).length).toBeLessThan(100); // cut by character, not through a surrogate pair
  });
});

describe('core/color.js reads what a browser reads (#231): validate and the map agree', () => {
  it('reads all 148 CSS named colours, in any case, as the browser does', async () => {
    // @ts-expect-error plain JS module, no declarations
    const { readColor, toHex } = await import('../../core/color.js');
    for (const [name, hex] of [['hotpink', '#ff69b4'], ['RebeccaPurple', '#663399'], ['lightgoldenrodyellow', '#fafad2'], ['darkslategrey', '#2f4f4f'], ['orange', '#ffa500']]) {
      expect([name, toHex(readColor(name))]).toEqual([name, hex]);
    }
    expect(readColor('bluee')).toBeNull();
  });
  it('reads rgb() and hsl() only in the shapes a browser draws: commas throughout, or spaces with a slash before the alpha', async () => {
    // @ts-expect-error plain JS module, no declarations
    const { readColor } = await import('../../core/color.js');
    for (const ok of ['rgb(1,2,3)', 'rgba(1, 2, 3, .5)', 'rgb(1 2 3 / 50%)', 'rgb(1 2 3/.5)', 'hsl(210 50% 40% / 0.5)', 'hsl(10, 50%, 50%)']) expect([ok, !!readColor(ok)]).toEqual([ok, true]);
    for (const no of ['rgb(1 2 3 4)', 'rgb(1, 2 3)', 'rgb(1, 2, 3 / .5)', 'rgb(1 2 3 /)', 'rgb(1 2/3)']) expect([no, readColor(no)]).toEqual([no, null]);
  });
});

// The Work view's colours (spec 0012 D2): a default for each kind, a token a theme sets, and the contrast check `validate` runs reads them.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { WORK_KINDS, WORK_THEMES, WORK_EDGES, WORK_EDGE_THEMES } from '../../core/schema.js';
import { workEdge } from '../../explorer/work-model.js';
import { checkSheets, describeFinding } from '../../core/contrast.js';
import { readColor } from '../../core/color.js';
import { deltaE2000 } from '../../core/delta-e.js';

const tokens = fs.readFileSync(new URL('../../explorer/tokens.css', import.meta.url), 'utf8');
const theming = fs.readFileSync(new URL('../../docs/theming.md', import.meta.url), 'utf8');

describe('--corn-work-<kind>', () => {
  it('has a token in the theme contract, in tokens.css and in docs/theming.md, for each of the six kinds', () => {
    expect(WORK_KINDS).toEqual(['thread', 'issue', 'proposal', 'run', 'pull', 'deploy']);
    for (const kind of WORK_KINDS) {
      expect(tokens).toContain(`--corn-work-${kind}: auto;`);
      expect(theming).toContain(`\`--corn-work-${kind}\``);
      expect(theming).toContain(WORK_THEMES[kind].color);
    }
  });
  it('gives each kind a silhouette of the map\'s five, and the two circles are told apart by colour', () => {
    expect(WORK_KINDS.map((k) => WORK_THEMES[k].shape)).toEqual(['circle', 'circle', 'diamond', 'hexagon', 'rounded-square', 'square']);
    expect(deltaE2000(readColor(WORK_THEMES.thread.color).slice(0, 3), readColor(WORK_THEMES.issue.color).slice(0, 3))).toBeGreaterThan(15);
  });
  it('is checked against the ground in the contrast check, light and dark, and the defaults pass', () => {
    const found = checkSheets([{ theme: 'standard', sheets: [tokens] }]).filter((f) => /node in the Work view/.test(f.use || ''));
    expect(new Set(found.map((f) => f.fg.split(',')[0])).size).toBe(WORK_KINDS.length);
    for (const f of found) expect(f.ratio, describeFinding(f)).toBeGreaterThanOrEqual(f.min);
  });
  it('reads a theme\'s token: a pale fill on a light ground fails', () => {
    const bad = checkSheets([{ theme: 'x', sheets: [tokens, ':root[data-theme="light"] { --corn-work-pull: #f0f0f0; } :root { --corn-ground: #ffffff; }'] }]).filter((f) => /node in the Work view/.test(f.use || '') && f.fg === '--corn-work-pull');
    expect(bad.some((f) => f.ratio < f.min)).toBe(true);
  });
});

describe('--corn-work-edge-<name>', () => {
  it('has a token in the theme contract, in tokens.css and in docs/theming.md, and its default is the colour the lines had', () => {
    expect(WORK_EDGES).toEqual(['work', 'code', 'adds']);
    expect(WORK_EDGE_THEMES).toEqual({ work: '#818cf8', code: '#cbd5e1', adds: '#2dd4bf' });
    for (const name of WORK_EDGES) {
      expect(tokens).toContain(`--corn-work-edge-${name}: auto;`);
      expect(theming).toContain(`\`--corn-work-edge-${name}\``);
      expect(theming).toContain(WORK_EDGE_THEMES[name]);
    }
  });
  it('is checked against the ground in the contrast check, light and dark, and the defaults pass', () => {
    const found = checkSheets([{ theme: 'standard', sheets: [tokens] }]).filter((f) => /in the Work view, where it joins the selection/.test(f.use || ''));
    expect(found).toHaveLength(WORK_EDGES.length * 2);
    for (const f of found) expect(f.ratio, describeFinding(f)).toBeGreaterThanOrEqual(f.min);
  });
  it('reads a theme\'s token: a pale line on a light ground fails', () => {
    const bad = checkSheets([{ theme: 'x', sheets: [tokens, ':root[data-theme="light"] { --corn-work-edge-adds: #f0f0f0; } :root { --corn-ground: #ffffff; }'] }]).filter((f) => f.fg === '--corn-work-edge-adds' && /where it joins/.test(f.use || ''));
    expect(bad.some((f) => f.ratio < f.min)).toBe(true);
  });
  it('is drawn in the theme\'s colour when it sets one, else in the default', () => {
    const edge = { from: 'a', to: 'b', kind: 'closes', tone: 'work', word: 'closes' };
    const a = { x: 0, y: 0, r: 10 };
    const dashes = { PROPOSED_DASH: [4, 4], USAGE_DASH: [2, 2] };
    expect(workEdge(edge, a, a, true, true, 'k', dashes).color).toBe(WORK_EDGE_THEMES.work);
    expect(workEdge(edge, a, a, true, true, 'k', dashes, { work: '#ff00ff' }).color).toBe('#ff00ff');
    expect(workEdge({ ...edge, kind: 'adds', tone: 'code' }, a, a, true, true, 'k', dashes, { work: '#ff00ff' }).color).toBe(WORK_EDGE_THEMES.adds);
  });
});

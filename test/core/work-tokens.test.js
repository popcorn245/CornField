// The Work view's colours (spec 0012 D2): a default for each kind, a token a theme sets, and the contrast check `validate` runs reads them.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { WORK_KINDS, WORK_THEMES } from '../../core/schema.js';
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
    const found = checkSheets([{ theme: 'standard', sheets: [tokens] }]).filter((f) => /Work view/.test(f.use || ''));
    expect(new Set(found.map((f) => f.fg.split(',')[0])).size).toBe(WORK_KINDS.length);
    for (const f of found) expect(f.ratio, describeFinding(f)).toBeGreaterThanOrEqual(f.min);
  });
  it('reads a theme\'s token: a pale fill on a light ground fails', () => {
    const bad = checkSheets([{ theme: 'x', sheets: [tokens, ':root[data-theme="light"] { --corn-work-pull: #f0f0f0; } :root { --corn-ground: #ffffff; }'] }]).filter((f) => /Work view/.test(f.use || '') && f.fg === '--corn-work-pull');
    expect(bad.some((f) => f.ratio < f.min)).toBe(true);
  });
});

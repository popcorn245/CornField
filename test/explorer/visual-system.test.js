/**
 * @vitest-environment node
 *
 * One visual system (issue #200, finding F53 of the 0.34 design review): the panel titles are one style, the controls of
 * a bar are one height, labels are one style, "pressed" is one look, and the panels share their padding and head height.
 * These read explorer/explorer.css, so a rule moved back to its own size fails here. The measured picture (type styles,
 * paddings, heights on the big fixture) is in the pull request; this holds what a reader of the CSS can hold.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPLORER } from '../helpers.js';

import { explorerCss } from './stylesheets.js';
const css = explorerCss(['explorer.css'], { stripComments: true });

/** A selector list split at its top-level commas (not those inside :where(…) or :is(…)) */
function splitList(head) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of head) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ',' && !depth) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  return out.concat(cur.trim()).filter(Boolean);
}
/** A selector's specificity as [ids, classes, types], what is inside :where() counting nothing */
function specificity(sel) {
  const s = sel.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '').replace(/::?[a-z-]+\(|\)/g, (m) => (m === ')' ? '' : m.startsWith('::') ? ' ' : ' .x '));
  return [(s.match(/#[\w-]+/g) || []).length, (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length, (s.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length];
}
/** Every rule as { selectors, body, media }, in file order, the at-rules they sit in flattened to a string */
function rules(text) {
  const out = [];
  const walk = (src, media) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1; let j = open + 1;
      while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
      const body = src.slice(open + 1, j - 1);
      if (/^@(media|container)\b/.test(head)) walk(body, `${media} ${head}`.trim());
      else if (!head.startsWith('@')) out.push({ selectors: splitList(head), body, media });
      i = j;
    }
  };
  walk(text, '');
  return out;
}
const ALL = rules(css);
/** The last declaration of `prop` that applies to exactly the selector `sel`, outside any media query (the desktop's) */
const declared = (sel, prop) => {
  let v = null;
  for (const r of ALL) {
    if (r.media || !r.selectors.includes(sel)) continue;
    const m = r.body.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`));
    if (m) v = m[1].trim();
  }
  return v;
};

const TITLES = ['.hx-drawer-title', '.hx-forge-detail-title', '.hx-forge-notes-title', '.hx-confirm-title', '.hx-proposal-name'];

describe('the panel title is one style', () => {
  it('sets the size, weight and line height of the Work panel, the node panel, the proposal bar, a detail and a dialog alike', () => {
    for (const sel of TITLES) {
      expect(declared(sel, 'font-size'), sel).toBe('var(--corn-text-lg)');
      expect(declared(sel, 'font-weight'), sel).toBe('700');
      expect(declared(sel, 'line-height'), sel).toBe('1.25');
    }
  });

  it('has no second rule that gives the node panel a title of its own (a longer selector would also beat a brand hook)', () => {
    const own = ALL.filter((r) => r.selectors.some((s) => /hx-drawer-title/.test(s) && s !== '.hx-drawer-title') && /font-(size|weight)|line-height/.test(r.body));
    expect(own.map((r) => r.selectors.join(', '))).toEqual([]);
  });

  it('reads sizes from the type scale only, and uses no weight between two steps of it', () => {
    expect(css).not.toMatch(/font-weight:\s*650/);
  });
});

describe('a bar\'s controls are one height, --corn-control-height (read through --hx-control-h, never under 44px on a phone)', () => {
  const TOKEN = 'var(--hx-control-h)';
  // [what, selector, property]: the controls of the header, the proposal bar, the decision foot, the player and the Work panel's top row
  const READS = [
    ['the header: the Layers chip', '.hx-layers-chip', 'height'],
    ['the header: the search field', '.hx-search', 'height'],
    ['the header: Work', '.hx-work', 'height'],
    ['the header: the account button', '.hx-account-btn', 'height'],
    ['the proposal bar: Edit and My edits', '.hx-proposal-tools .hx-btn', 'height'],
    ['the proposal bar: the more button', '.hx-proposal-more .hx-btn--icon', 'height'],
    ['the decision foot: Send back and Approve', '.hx-proposal-actions .hx-btn', 'height'],
    ['the player: Previous, Play and Next', ':where(.hx-forge-head, .hx-player-controls, .hx-player-as, .hx-proposal-bar .hx-waiting-line) .hx-btn', 'height'],
    ['the player: the speed', '.hx-player-speed', 'height'],
    ['the player: Close', '.hx-player .hx-close', 'height'],
    ['the Work panel: Close', '.hx-close', 'height'],

    ['the Work panel: a tab', '.hx-forge-tab', 'min-height'],
    ['the proposal bar: Answer, in the line that says a run waits on you', ':where(.hx-forge-head, .hx-player-controls, .hx-player-as, .hx-proposal-bar .hx-waiting-line) .hx-btn', 'height'],
    ['the account menu: the named theme select', '.hx-account-select', 'height'],
  ];
  for (const [what, sel, prop] of READS) {
    it(`${what} reads the token`, () => { expect(declared(sel, prop), `${sel} ${prop}`).toBe(TOKEN); });
  }

  it('makes a segmented control one height outside as well: its buttons are the token less the frame', () => {
    for (const sel of ['.hx-seg-btn', '.hx-view-btn', '.hx-account-seg-btn']) expect(declared(sel, 'height'), sel).toBe('var(--hx-seg-inner)');
    const inner = declared('*', '--hx-seg-inner'); // on every element, not :root: it exists inside a shadow root too (base.css)
    expect(inner).toContain('var(--hx-control-h)');
    expect(inner).toContain('var(--corn-border)');
    // the frame is two thirds of a step of padding and two borders, so the outside of the control is the token
    for (const sel of ['.hx-seg', '.hx-view', '.hx-account-seg']) expect(declared(sel, 'padding'), sel).toBe('calc(var(--corn-space-1) / 2)');
  });

  it('reads the token only through --hx-control-h, which a phone floors at 44px: a brand that sets the token on :root (36px, say) cannot shrink a phone\'s targets', () => {
    expect(declared('*', '--hx-control-h')).toBe('var(--corn-control-height)');
    const phone = ALL.filter((r) => /max-width: 767px/.test(r.media) && r.selectors.includes('*') && /--hx-control-h\s*:/.test(r.body));
    expect(phone.map((r) => r.body.trim())).toEqual(['--hx-control-h: max(44px, var(--corn-control-height)); --hx-seg-inner: var(--hx-control-h);']);
    // no other rule reads the token itself, so none can bypass the floor
    const direct = ALL.filter((r) => /var\(--corn-control-height\)/.test(r.body) && !/--hx-control-h\s*:/.test(r.body));
    expect(direct.map((r) => r.selectors.join(', '))).toEqual([]);
  });

  it('gives its rules no more weight than one class (an ancestor is in :where()), so a brand\'s [data-corn] hook still wins', () => {
    // the rules of the density work (explorer.css's section, now in the pieces' files): the panel title, the panel head, the bars' controls, and
    // every rule that sets a height from the control token or a panel's head height
    const DENSITY = ['.hx-drawer-title', '.hx-forge-detail-title', '.hx-forge-notes-title', '.hx-confirm-title', '.hx-proposal-name', '.hx-forge-head', '.hx-drawer-head',
      ':where(.hx-forge-head, .hx-player-controls, .hx-player-as, .hx-proposal-bar .hx-waiting-line) .hx-btn', ':where(.hx-header) .hx-live-chip'];
    const subject = (sel) => sel.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '').trim().split(/[\s>+~]+/).pop();
    const own = ALL.filter((r) => r.selectors.some((sel) => DENSITY.includes(sel) || DENSITY.slice(0, 7).some((d) => subject(sel).includes(d))) && /(^|;|\s)(min-)?height\s*:|font-size\s*:/.test(r.body));
    expect(own.length).toBeGreaterThanOrEqual(3);
    const block = [...own, ...ALL.filter((r) => /var\(--hx-control-h\)|--corn-panel-head-height/.test(r.body))].map((r) => `${r.selectors.join(', ')} {${r.body}}`).join('\n');
    const heavy = [...own, ...ALL.filter((r) => /--corn-panel-head-height/.test(r.body))].flatMap((r) => r.selectors).filter((sel) => { const [a, b, c] = specificity(sel); return a > 0 || b > 1 || (b === 1 && c > 0); });
    expect(heavy).toEqual([]);
    expect(block).not.toMatch(/!important/);
  });

  it('writes no literal height of 24 to 36px on a control of those bars outside a phone\'s media query', () => {
    const SELECTORS = READS.map((r) => r[1]).concat(['.hx-seg-btn', '.hx-view-btn', '.hx-account-seg-btn']);
    const bad = ALL.filter((r) => !r.media && r.selectors.some((s) => SELECTORS.includes(s)) && /(^|;|\s)(min-)?height:\s*(2[4-9]|3[0-6])px/.test(r.body));
    expect(bad.map((r) => r.selectors.join(', '))).toEqual([]);
  });
});

describe('the panels share their padding and head height', () => {
  it('pads the Work body and the node body by --corn-panel-pad on every side, so their text starts at one edge', () => {
    expect(declared('.hx-forge-body', 'padding')).toBe('var(--corn-panel-pad)');
    expect(declared('.hx-drawer-body', 'padding')).toBe('var(--corn-panel-pad)');
    expect(declared('.hx-forge-body', '--hx-forge-pad')).toBe('var(--corn-panel-pad)');
    expect(declared('.hx-forge-body', '--hx-forge-padx')).toBe('var(--corn-panel-pad)');
  });

  it('gives the Work head and the node head the same least height, --corn-panel-head-height', () => {
    expect(declared('.hx-forge-head', 'min-height')).toBe('var(--corn-panel-head-height)');
    expect(declared('.hx-drawer-head', 'min-height')).toBe('var(--corn-panel-head-height)');
  });
});

describe('a label is one style, the small uppercase kind', () => {
  const LABEL = ['font-size: var(--corn-text-2xs)', 'font-weight: 700', 'text-transform: uppercase', 'letter-spacing: 0.05em'];
  it('is the same on the menu title, the sandbox title, a field, the search groups and a persona', () => {
    for (const sel of ['.hx-menu-title', '.hx-sandbox-title', '.hx-forge-field', '.hx-search-group-title']) {
      const r = ALL.filter((x) => !x.media && x.selectors.includes(sel)).map((x) => x.body).join(';');
      for (const d of LABEL) expect(r, `${sel} ${d}`).toContain(d);
    }
  });

  it('leaves a persona\'s name in its own words (sentence case, as since 0.39.0): it names people, it is not a label', () => {
    const r = ALL.filter((x) => x.selectors.includes('.hx-persona-name')).map((x) => x.body).join(';');
    expect(r).not.toContain('text-transform');
    expect(r).toContain('font-size: var(--corn-text-xs)');
  });
});

describe('"pressed" is one look: the accent fill and its text, with no shadow', () => {
  it('is the same on the View switch, the Before / Diff / After control and the theme control', () => {
    for (const sel of ['.hx-view-btn[aria-pressed="true"]', '.hx-account-seg-btn[aria-pressed="true"]', '.hx-seg-btn[aria-pressed="true"]']) {
      const r = ALL.filter((x) => !x.media && x.selectors.includes(sel)).map((x) => x.body).join(';');
      expect(r, sel).toContain('background: var(--corn-accent)');
      expect(r, sel).toContain('color: var(--corn-text-on-accent)');
      expect(r, sel).not.toContain('box-shadow');
    }
  });

  it('keeps Before / Diff / After at one weight pressed or not, so the words do not change width and the bar does not move', () => {
    const r = ALL.filter((x) => x.selectors.some((s) => /^\.hx-seg-btn(\.is-on|\[aria-pressed="true"\])$/.test(s))).map((x) => x.body).join(';');
    expect(r).not.toMatch(/font-weight/);
  });
});

describe('the header fits a narrow desktop', () => {
  it('shows the live chip as its dot from 768 to 1023px, where its words ran the header 100px past the page', () => {
    const r = ALL.filter((x) => /min-width: 768px\) and \(max-width: 1023px/.test(x.media) && x.selectors.includes('.hx-live-chip-text'));
    expect(r.map((x) => x.body.trim())).toEqual(['display: none;']);
  });
});

describe('names that must not collide, and a chip that centres its words', () => {
  it('keeps the old --hx-control colour alias for plugin CSS: the bar height has its own name', () => {
    const tokens = fs.readFileSync(path.join(EXPLORER, 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(tokens).toMatch(/--hx-control:\s*var\(--corn-surface-2\)/); // docs/theming.md, "The old --hx-* names"
    expect(css).not.toMatch(/--hx-control\s*:/); // explorer.css never redefines it, as a length or anything else
    expect(css).not.toMatch(/var\(--hx-control\)/);
  });

  it('centres the words of a kind chip where the chip is 44px tall', () => {
    // the rule sits in the touch block, right after the one that makes the chip 44px tall
    expect(css).toMatch(/\.hx-lines-kind,[^{}]*\{\s*min-height:\s*44px;\s*\}\s*\.hx-lines-kind\s*\{\s*align-items:\s*center;/);
  });
});

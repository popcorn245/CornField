/**
 * The state machine behind the phone's bottom sheets (TOPO-18): peek by default, one
 * expanded at a time.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { createSheetModel } from '../../explorer/sheet-model.js';

describe('sheet model', () => {
  it('starts every sheet as a peek', () => {
    const m = createSheetModel();
    m.add('proposal');
    m.add('player');
    expect(m.expanded()).toBeNull();
    expect(m.isExpanded('proposal')).toBe(false);
    expect(m.ids()).toEqual(['proposal', 'player']);
  });

  it('expands one sheet and collapses the others', () => {
    const m = createSheetModel();
    ['proposal', 'player', 'drawer'].forEach((id) => m.add(id));
    expect(m.expand('proposal')).toBe(true);
    expect(m.expand('proposal')).toBe(false); // already open: nothing changed
    expect(m.expand('player')).toBe(true);
    expect(m.isExpanded('proposal')).toBe(false);
    expect(m.expanded()).toBe('player');
  });

  it('collapses one, all, and toggles', () => {
    const m = createSheetModel();
    m.add('a');
    m.add('b');
    m.expand('a');
    expect(m.collapse('b')).toBe(false); // b was not the open one
    expect(m.expanded()).toBe('a');
    expect(m.toggle('a')).toBe(true);
    expect(m.expanded()).toBeNull();
    expect(m.toggle('b')).toBe(true);
    expect(m.expanded()).toBe('b');
    expect(m.collapseAll()).toBe(true);
    expect(m.collapseAll()).toBe(false);
  });

  it('ignores a sheet it does not know, and forgets an open one that is removed', () => {
    const m = createSheetModel();
    expect(m.expand('ghost')).toBe(false);
    expect(m.toggle('ghost')).toBe(false);
    m.add('a');
    m.expand('a');
    m.remove('a');
    expect(m.expanded()).toBeNull();
    expect(m.has('a')).toBe(false);
  });
});

describe('the phone\'s backdrop (F32)', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../explorer/explorer.css'), 'utf8');
  const phone = css.slice(css.indexOf('@media (max-width: 767px) {\n  .hx-dock'));

  it('draws nothing over the free band the selected node is panned into, but stays a tap target', () => {
    const rule = phone.match(/\.hx-stage\[data-sheet-open="drawer"\] \.hx-backdrop:not\(\[hidden\]\) \{([^}]*)\}/);
    expect(rule).toBeTruthy();
    expect(rule[1]).toMatch(/display: block/); // still there to close the panel on a tap
    expect(rule[1]).toMatch(/background: transparent/); // no scrim
    expect(rule[1]).toMatch(/backdrop-filter: none/); // no blur
    expect(rule[1]).toMatch(/-webkit-backdrop-filter: none/);
  });
});

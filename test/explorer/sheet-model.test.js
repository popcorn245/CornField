/**
 * The state machine behind the phone's bottom sheets (TOPO-18): peek by default, one
 * expanded at a time.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { createSheetModel, sheetCap, mapFloorPx, MAP_FLOOR, STUB_PX } from '../../explorer/sheet-model.js';

import { explorerCss } from './stylesheets.js';
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

describe('spec 0010 D7: two sheets, one expanded, a stub, the map keeps 35%', () => {
  const open = (...ids) => { const m = createSheetModel(); ids.forEach((id) => { m.add(id); m.hide(id); }); return m; };

  it('opens every sheet as a peek', () => {
    const m = open('proposal', 'forge');
    m.show('proposal');
    m.show('forge');
    expect(m.stateOf('proposal')).toBe('peek');
    expect(m.stateOf('forge')).toBe('peek');
    expect(m.stateOf('drawer')).toBeUndefined();
    expect(m.expanded()).toBeNull();
  });

  it('holds at most two sheets: Work displaces the node panel and the node panel displaces Work; the review is not displaced', () => {
    const m = open('proposal', 'drawer', 'forge');
    m.show('proposal');
    expect(m.show('drawer')).toEqual([]);
    expect(m.show('forge')).toEqual(['drawer']);
    expect(m.shown().sort()).toEqual(['forge', 'proposal']);
    expect(m.stateOf('drawer')).toBe('hidden');
    expect(m.show('drawer')).toEqual(['forge']);
    expect(m.shown().sort()).toEqual(['drawer', 'proposal']);
    expect(m.show('proposal')).toEqual([]); // the review has no rival
  });

  it('folds the other group\'s sheet to a stub while one is expanded, and swaps them when the stub is tapped', () => {
    const m = open('proposal', 'forge');
    m.show('proposal');
    m.show('forge');
    m.expand('forge');
    expect(m.stateOf('forge')).toBe('expanded');
    expect(m.stateOf('proposal')).toBe('stub');
    expect(m.stubs()).toBe(1);
    m.expand('proposal'); // a tap on the stub
    expect(m.stateOf('proposal')).toBe('expanded');
    expect(m.stateOf('forge')).toBe('stub');
    m.collapseAll();
    expect([m.stateOf('proposal'), m.stateOf('forge'), m.stubs()]).toEqual(['peek', 'peek', 0]);
  });

  it('has no stub when there is nothing else open, and does not stub the review\'s own pair', () => {
    const alone = open('forge');
    alone.show('forge');
    alone.expand('forge');
    expect(alone.stubs()).toBe(0);
    const pair = open('proposal', 'player');
    pair.show('proposal');
    pair.show('player');
    pair.expand('player');
    expect(pair.stateOf('proposal')).toBe('peek');
  });

  it('cannot expand a sheet that is not open, and forgets an expanded sheet that is displaced or closed', () => {
    const m = open('drawer', 'forge');
    expect(m.expand('forge')).toBe(false);
    m.show('drawer');
    m.expand('drawer');
    m.show('forge'); // displaces the expanded node panel
    expect(m.expanded()).toBeNull();
    m.expand('forge');
    m.hide('forge');
    expect(m.expanded()).toBeNull();
  });

  it('caps an expanded sheet so the map keeps 35% of the screen: 296 px at 844, whatever is open', () => {
    expect(MAP_FLOOR).toBe(0.35);
    expect(mapFloorPx(844)).toBe(296);
    expect(sheetCap(844, 0)).toBe(844 - 296); // alone
    expect(sheetCap(844, 1)).toBe(844 - 296 - STUB_PX); // with the other sheet folded to its stub: 504
    for (const vh of [568, 667, 844, 932]) {
      for (const stubs of [0, 1]) {
        const dock = sheetCap(vh, stubs) + stubs * STUB_PX; // the expanded sheet at its cap, and the stub
        expect(vh - dock, `${vh} with ${stubs} stub`).toBeGreaterThanOrEqual(mapFloorPx(vh));
      }
    }
    expect(sheetCap(100, 3)).toBe(0); // never negative
  });
});

describe('the phone\'s backdrop (F32)', () => {
  const css = explorerCss();
  const phone = css.slice(css.indexOf('@container corn-box (max-width: 767px) {\n  .hx-dock')); // a phone's rules: the dock's container query (sheets.css)

  it('draws nothing over the free band the selected node is panned into, but stays a tap target', () => {
    const rule = phone.match(/\.hx-stage\[data-sheet-open="drawer"\] \.hx-backdrop:not\(\[hidden\]\) \{([^}]*)\}/);
    expect(rule).toBeTruthy();
    expect(rule[1]).toMatch(/display: block/); // still there to close the panel on a tap
    expect(rule[1]).toMatch(/background: transparent/); // no scrim
    expect(rule[1]).toMatch(/backdrop-filter: none/); // no blur
    expect(rule[1]).toMatch(/-webkit-backdrop-filter: none/);
  });
});

/**
 * The state machine behind the phone's bottom sheets (TOPO-18): peek by default, one
 * expanded at a time.
 */
import { describe, it, expect } from 'vitest';
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

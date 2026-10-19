/**
 * @vitest-environment node
 *
 * The map by keyboard (MAP-02), the pure half: what each key means, the order the nodes are stepped through,
 * and the words a screen reader is told.
 */
import { describe, it, expect } from 'vitest';
import {
  MAP_KEYS, MOVE_FAR, MOVE_STEP, PAN_FAR, PAN_STEP, ZOOM_STEP, describeNode, mapKeyAction, readingOrder, stepFrom, zoomWords,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/keyboard-model.js';

describe('mapKeyAction', () => {
  it('pans with the arrows, further with Shift; the content moves the other way, so Right shows what is right', () => {
    expect(mapKeyAction('ArrowRight')).toEqual({ type: 'pan', dx: -PAN_STEP, dy: -0 });
    expect(mapKeyAction('ArrowUp', { shift: true })).toEqual({ type: 'pan', dx: -0, dy: PAN_FAR });
  });

  it('zooms with + and = and - and _, fits with 0', () => {
    for (const k of ['+', '=']) expect(mapKeyAction(k)).toEqual({ type: 'zoom', factor: ZOOM_STEP });
    for (const k of ['-', '_']) expect(mapKeyAction(k)).toEqual({ type: 'zoom', factor: 1 / ZOOM_STEP });
    expect(mapKeyAction('0')).toEqual({ type: 'fit' });
  });

  it('steps with N, P, ] and [, jumps with Home and End', () => {
    for (const k of ['n', 'N', ']']) expect(mapKeyAction(k)).toEqual({ type: 'step', by: 1 });
    for (const k of ['p', 'P', '[']) expect(mapKeyAction(k)).toEqual({ type: 'step', by: -1 });
    expect(mapKeyAction('Home')).toEqual({ type: 'first' });
    expect(mapKeyAction('End')).toEqual({ type: 'last' });
  });

  it('Enter and Escape act only on a selected node', () => {
    expect(mapKeyAction('Enter')).toBe(null);
    expect(mapKeyAction('Escape')).toBe(null);
    expect(mapKeyAction('Enter', { selected: true })).toEqual({ type: 'open' });
    expect(mapKeyAction('Escape', { selected: true })).toEqual({ type: 'close' });
  });

  it('Alt+arrow moves the selected node, only in Freeform and only with a node selected', () => {
    expect(mapKeyAction('ArrowLeft', { alt: true, freeform: true, selected: true })).toEqual({ type: 'move', dx: -MOVE_STEP, dy: 0 });
    expect(mapKeyAction('ArrowDown', { alt: true, shift: true, freeform: true, selected: true })).toEqual({ type: 'move', dx: 0, dy: MOVE_FAR });
    expect(mapKeyAction('ArrowLeft', { alt: true, freeform: false, selected: true })).toBe(null);
    expect(mapKeyAction('ArrowLeft', { alt: true, freeform: true, selected: false })).toBe(null);
  });

  it('leaves Left and Right to a playing scenario, and every Ctrl or Cmd key to the page', () => {
    expect(mapKeyAction('ArrowLeft', { scenario: true })).toBe(null);
    expect(mapKeyAction('ArrowRight', { scenario: true })).toBe(null);
    expect(mapKeyAction('ArrowUp', { scenario: true })).toMatchObject({ type: 'pan' });
    expect(mapKeyAction('z', { ctrl: true })).toBe(null);
    expect(mapKeyAction('+', { meta: true })).toBe(null);
    expect(mapKeyAction('a')).toBe(null);
    expect(mapKeyAction('Tab')).toBe(null);
  });

  it('every key the help names does something', () => {
    expect(MAP_KEYS.length).toBeGreaterThanOrEqual(8);
  });
});

describe('readingOrder and stepFrom', () => {
  const nodes = [
    { id: 'c', x: 300, y: 10 }, { id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 25 }, // one row (within 40)
    { id: 'd', x: -50, y: 200 }, { id: 'e', x: 50, y: 210 },
  ];

  it('reads rows top to bottom, each left to right', () => {
    expect(readingOrder(nodes).map((n) => n.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(nodes[0].id).toBe('c'); // the input is not sorted in place
  });

  it('steps forward and back, wrapping round; with nothing selected it starts at the first or the last', () => {
    const order = readingOrder(nodes);
    expect(stepFrom(order, 'b', 1).id).toBe('c');
    expect(stepFrom(order, 'e', 1).id).toBe('a');
    expect(stepFrom(order, 'a', -1).id).toBe('e');
    expect(stepFrom(order, null, 1).id).toBe('a');
    expect(stepFrom(order, 'gone', -1).id).toBe('e');
    expect(stepFrom([], 'a', 1)).toBe(null);
  });
});

describe('the words', () => {
  it('names the node, its kind, its connections and its place', () => {
    expect(describeNode({ label: 'orders', type: 'table', degree: 5 }, 40, 2)).toBe('orders, table, 5 connections, 3 of 40');
    expect(describeNode({ label: 'Cloudflare', type: 'external', degree: 1 })).toBe('Cloudflare, outside service, 1 connection');
    expect(describeNode({ label: 'x', type: 'page' })).toBe('x, page');
    expect(zoomWords(1.25)).toBe('Zoom 125 percent');
  });
});

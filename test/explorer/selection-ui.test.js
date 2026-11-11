// @vitest-environment happy-dom
/**
 * A selection on the page (spec 0008 D5 and D6), through the page's own markup: one hop lit, the panel's lines by kind (a chip lights
 * one kind), the switch that brings the wider set back, the camera that a click leaves alone and a list, a link or the keyboard moves,
 * Frame them and F. A kind or a type is project data: it reaches the panel as text.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap } from '../../explorer/view.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { LAYER_DEFS, renderLayerToggles } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { closeDrawer, selectNode } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard, resetKeyboardForTests, frameThem } from '../../explorer/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { stopFlight, tickFlight } from '../../explorer/fly.js';

const page = fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const $ = (id) => document.getElementById(id);
const node = (id, type, label, x, y, extra = {}) => ({ id, type, x, y, r: 20, color: '#336699', label, ...extra });
const nodes = [
  node('root', 'root', 'root', 0, 0),
  node('app', 'app', 'Orders app', 100, 0),
  node('p1', 'page', '/one', 200, 0), node('p2', 'page', '/two', 200, 80),
  node('tbl', 'table', 'orders', 300, 0), node('svc', 'service', 'sync-worker', 300, 80),
  node('tbl2', 'table', 'carts', 300, 160), node('far', 'service', 'faraway', 9000, 9000),
];
const edges = [
  { from: 'root', to: 'app' }, { from: 'app', to: 'p1' }, { from: 'app', to: 'p2' },
  { from: 'p1', to: 'tbl', kind: 'reads', keys: [], label: 'r' }, { from: 'p1', to: 'svc', kind: 'calls', label: 'c' },
  { from: 'p2', to: 'tbl2', kind: 'writes', label: 'w' }, { from: 'far', to: 'svc', kind: 'calls', label: 'x' },
];

function mount() {
  document.body.innerHTML = body;
  const ctx = new Proxy({}, { get: (_t, key) => (key === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = $('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, labelCanvas: null, proposal: null, view: 'orbit', selectedNode: null, selectedKind: null, throughChildren: false, live: null, house: null, scenario: null, runsMap: null, searchQuery: '', searchCurrent: null, isFreeform: false });
  for (const l of LAYER_DEFS) state.activeLayers[l.key] = !['stack', 'machine', 'container', 'device', 'house', 'persona'].includes(l.key);
  state.baseNodes = nodes.map((n) => ({ ...n }));
  state.baseEdges = edges.map((e) => ({ ...e }));
  render.resize();
  setMap(state.baseNodes.map((n) => ({ ...n })), state.baseEdges);
  renderLayerToggles();
  resetKeyboardForTests();
  initKeyboard();
  state.camera = { x: 0, y: 0, zoom: 1 };
}
const litIds = () => render.getScene().nodes.filter((n) => n.connected).map((n) => n.id).sort();
const pick = (id) => state.nodes.find((n) => n.id === id);
const chips = () => [...document.querySelectorAll('[data-corn="lines-kind"]')];
const key = (k) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); state.canvas.dispatchEvent(e); return e; };
const flush = async () => { for (let i = 0; i < 80; i++) tickFlight(1000 + i * 100); };
const centreOn = (n, zoom = 1) => { state.camera = { x: 500 - n.x * zoom, y: 350 - n.y * zoom, zoom }; };

afterEach(() => { stopFlight(); closeDrawer(); document.body.innerHTML = ''; });

describe('one hop and the panel\'s lines (D5)', () => {
  it('lights what is one edge from a node, and says its lines by kind in the panel', async () => {
    mount();
    await selectNode(pick('p1'));
    expect(litIds()).toEqual(['app', 'p1', 'svc', 'tbl']);
    expect(chips().map((c) => c.textContent.replace(/\s+/g, ' ').trim())).toEqual(['Owns 1', 'Reads 1', 'Calls 1']);
    expect(document.querySelector('[data-corn="lines-by-kind"]')).not.toBeNull();
  });

  it('a kind\'s chip lights that kind alone, and the same chip again lights them all', async () => {
    mount();
    await selectNode(pick('p1'));
    const calls = chips().find((c) => c.textContent.includes('Calls'));
    calls.focus();
    calls.click();
    expect(litIds()).toEqual(['p1', 'svc']);
    expect(chips().find((c) => c.textContent.includes('Calls')).getAttribute('aria-pressed')).toBe('true');
    expect(chips()).toHaveLength(3); // the other kinds stay listed
    expect(document.activeElement.dataset.focusKey).toBe('kind:calls'); // the focus stayed on the chip
    chips().find((c) => c.textContent.includes('Calls')).click();
    expect(litIds()).toEqual(['app', 'p1', 'svc', 'tbl']);
  });

  it('the switch brings back the children\'s neighbours, off by default, and only a node with children has it', async () => {
    mount();
    await selectNode(pick('app'));
    expect(litIds()).toEqual(['app', 'p1', 'p2', 'root']);
    const box = document.querySelector('[data-corn="lines-switch"]');
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(litIds()).toEqual(['app', 'p1', 'p2', 'root', 'svc', 'tbl', 'tbl2']);
    expect(document.querySelector('[data-corn="lines-switch"]').checked).toBe(true);
    await selectNode(pick('p1'));
    expect(document.querySelector('[data-corn="lines-switch"]')).toBeNull(); // a page has no children
  });

  it('a kind chosen for one node is forgotten for the next', async () => {
    mount();
    await selectNode(pick('p1'));
    chips()[1].click();
    expect(state.selectedKind).toBe('reads');
    await selectNode(pick('p2'));
    expect(state.selectedKind).toBeNull();
  });

  it('shows a kind of the project\'s own as text', async () => {
    mount();
    const evil = '<img src=x onerror=alert(1)>';
    state.edges.push({ from: 'p1', to: 'far', kind: evil });
    await selectNode(pick('p1'));
    expect(document.querySelector('[data-corn="lines-by-kind"] img')).toBeNull();
    expect(document.querySelector('[data-corn="lines-by-kind"]').textContent).toContain(evil);
  });
});

describe('the camera (D6)', () => {
  it('a click on the map leaves it where it is', async () => {
    mount();
    state.camera = { x: 10, y: 20, zoom: 0.7 };
    await selectNode(pick('p1'));
    await flush();
    expect(state.camera).toEqual({ x: 10, y: 20, zoom: 0.7 });
  });

  it('a selection from a list, a link or the keyboard frames the node and what it lights', async () => {
    mount();
    state.camera = { x: 5000, y: 5000, zoom: 0.7 };
    await selectNode(pick('p1'), { frame: true });
    await flush();
    const p = (n) => ({ x: state.camera.x + n.x * state.camera.zoom, y: state.camera.y + n.y * state.camera.zoom });
    for (const id of ['app', 'p1', 'svc', 'tbl']) {
      const s = p(pick(id));
      expect(s.x).toBeGreaterThan(0); expect(s.x).toBeLessThan(1000);
      expect(s.y).toBeGreaterThan(0); expect(s.y).toBeLessThan(700);
    }
  });

  it('centres a node at zoom 1 when what it lights is too spread out to frame', async () => {
    mount();
    state.edges.push({ from: 'p1', to: 'far', kind: 'calls', label: 'x' });
    state.camera = { x: 0, y: 0, zoom: 0.3 };
    await selectNode(pick('p1'), { frame: true });
    await flush();
    expect(state.camera.zoom).toBe(1);
  });

  it('says how much is off screen, and Frame them and F bring it all in', async () => {
    mount();
    centreOn(pick('app'), 4); // zoomed in on the app: its neighbours are off to the sides
    await selectNode(pick('app'));
    const line = () => document.querySelector('[data-lines-reach]').textContent;
    expect(line()).toMatch(/^3 connected · [1-3] off screen$/);
    const button = document.querySelector('[data-corn="frame-button"]');
    expect(button.textContent).toBe('Frame them');
    expect(button.dataset.action).toBe('frame-selection');
    frameThem();
    await flush();
    render.renderNow();
    expect(line()).toBe('3 connected · all on screen'); // the line follows the camera as it is drawn
    centreOn(pick('app'), 4);
    const e = key('f');
    expect(e.defaultPrevented).toBe(true);
    await flush();
    render.renderNow();
    expect(line()).toBe('3 connected · all on screen');
  });

  it('F with nothing selected is left to the page', () => {
    mount();
    expect(key('f').defaultPrevented).toBe(false);
  });
});

describe('accessibility (axe)', () => {
  it('finds nothing wrong with the lines by kind, the switch, Frame them and the Key', async () => {
    const { default: axe } = await import('axe-core');
    mount();
    await selectNode(pick('app'));
    $('drawer-lines').querySelector('[data-lines-kind="ownership"]').click(); // a chip pressed: its list is open too
    expect($('drawer-lines').querySelector('[data-corn="lines-switch"]')).not.toBeNull();
    expect($('edge-key').querySelectorAll('svg[data-corn="swatch"]').length).toBeGreaterThan(5);
    const r = await axe.run({ include: [['#drawer-lines'], ['#edge-key']] }, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([]);
  });
});

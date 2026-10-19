// @vitest-environment happy-dom
/**
 * The keyboard and screen-reader pass (MAP-02), on the page's own markup (explorer/index.html) with its stylesheets:
 *
 *  - axe-core finds no violation in each state the explorer has: the map, the Layers menu, a node's panel, a
 *    proposal open with what-if editing, the scenario player. happy-dom has no layout, so the rules that need one
 *    (colour contrast) are left to a real browser: the PR runs axe in Chromium as well;
 *  - everything the pointer does on the map has a key: pan, zoom, fit, select a node, open and close its panel,
 *    move a node in Freeform, draw an edge in a what-if edit; and a screen reader is told where the keyboard landed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import axe from 'axe-core';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap } from '../../explorer/view.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode, closeDrawer } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard, resetKeyboardForTests } from '../../explorer/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { readingOrder } from '../../explorer/keyboard-model.js';
// @ts-expect-error plain JS modules, no declarations
import { toggleLegendMenu, renderLayerToggles } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { initProposals, openProposal, closeProposal } from '../../explorer/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { initWhatIf, resetWhatIfForTests } from '../../explorer/whatif.js';
// @ts-expect-error plain JS modules, no declarations
import { initScenarioUi, playScenario, clearScenario } from '../../explorer/scenario-ui.js';

const EXPLORER = path.resolve(__dirname, '../../explorer');
const page = fs.readFileSync(path.join(EXPLORER, 'index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const css = ['explorer.css', 'house.css'].map((f) => fs.readFileSync(path.join(EXPLORER, f), 'utf8')).join('\n');

const node = (id, type, x, y, extra = {}) => ({ id, type, x, y, r: 20, color: '#336699', label: id, degree: 1, ...extra });
const MAP = {
  nodes: [node('root', 'root', 0, 0), node('app-a', 'app', 200, 0), node('page-a', 'page', 300, 100, { label: '/orders' }), node('table-t', 'table', -200, 100, { label: 'orders' })],
  edges: [{ from: 'root', to: 'app-a' }, { from: 'app-a', to: 'page-a' }, { from: 'page-a', to: 'table-t', kind: 'reads', keys: ['a'], status: 'live', label: 'rows' }],
};
const PROPOSAL = {
  version: 1, title: 'Meals', summary: 'Adds /meals.',
  nodes: { add: [{ id: 'page-new', label: '/meals', type: 'page', parent: 'app-a' }] },
  scenarios: [{ id: 's', title: 'A walk', steps: [{ node: 'page-new', text: 'You open meals.' }, { node: 'table-t', text: 'It reads orders.' }] }],
};

const $ = (id) => document.getElementById(id);
const key = (el, k, opts = {}) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }); el.dispatchEvent(e); return e; };
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** axe on the page as it stands, rules that need a layout off; returns the violations as "rule: target" */
async function audit() {
  const r = await axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, rules: { 'color-contrast': { enabled: false } } });
  return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

function mount() {
  document.head.innerHTML = `<title>cornfield</title><style>${css}</style>`;
  document.documentElement.lang = 'en';
  document.body.innerHTML = body;
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = $('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, labelCanvas: null, proposal: null, proposalView: 'diff', proposalErrors: [], view: 'orbit', selectedNode: null, isFreeform: false, scenario: null, searchQuery: '' });
  state.camera = { x: 0, y: 0, zoom: 1 };
  render.resize();
  state.baseNodes = MAP.nodes.map((n) => ({ ...n }));
  state.baseEdges = MAP.edges;
  setMap(MAP.nodes.map((n) => ({ ...n })), MAP.edges);
  resetKeyboardForTests();
  initKeyboard();
  return canvas;
}

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { clearScenario(); closeDrawer(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('axe finds no violation', () => {
  it('on the map as it loads', async () => {
    mount();
    expect(await audit()).toEqual([]);
  });

  it('with the Layers menu open, which says it is open', async () => {
    mount();
    renderLayerToggles();
    toggleLegendMenu();
    expect($('legend-toggle-btn').getAttribute('aria-expanded')).toBe('true');
    expect(await audit()).toEqual([]);
  });

  it('with a node\'s panel open; closed, the panel is inert so Tab never reaches it off screen', async () => {
    mount();
    expect($('spec-drawer').inert).toBe(true);
    await selectNode(state.nodes.find((n) => n.id === 'table-t'));
    expect($('spec-drawer').inert).toBe(false);
    expect(await audit()).toEqual([]);
    closeDrawer();
    expect($('spec-drawer').inert).toBe(true);
  });

  it('with a proposal open, what-if editing on, and the scenario player playing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/proposals') return { ok: true, status: 200, headers: new Headers(), json: async () => [{ slug: '0013-meals', title: 'Meals', summary: 'Adds /meals.', source: 'checkout', counts: { added: 1, changed: 0, removed: 0, scenarios: 1 }, errors: 0 }] };
      if (u.pathname.endsWith('/review')) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
      return { ok: true, status: 200, headers: new Headers({ 'X-Proposal-Source': 'checkout' }), json: async () => structuredClone(PROPOSAL) };
    }));
    mount();
    resetWhatIfForTests();
    initWhatIf();
    await initProposals();
    initScenarioUi();
    expect(await openProposal('0013-meals', 'checkout')).toBe(true);
    await settle();
    expect(await audit()).toEqual([]);
    await selectNode(state.nodes.find((n) => n.id === 'app-a'));
    expect(await audit()).toEqual([]);
    playScenario(PROPOSAL.scenarios[0], { autoplay: false });
    await settle();
    expect(document.querySelector('.hx-player')).not.toBe(null);
    expect(await audit()).toEqual([]);
    clearScenario();
    closeProposal();
  });
});

describe('the map by keyboard', () => {
  it('is in the tab order, named, with its keys described', () => {
    const canvas = mount();
    expect(canvas.tabIndex).toBe(0);
    expect(canvas.getAttribute('aria-label')).toBe('Topology map');
    expect($(canvas.getAttribute('aria-describedby')).textContent).toContain('N and P select the next and the previous node');
  });

  it('pans with the arrows, zooms with + and -, fits with 0, and says the zoom', async () => {
    const canvas = mount();
    const before = { ...state.camera };
    expect(key(canvas, 'ArrowRight').defaultPrevented).toBe(true);
    expect(state.camera.x).toBe(before.x - 60);
    key(canvas, 'ArrowDown', { shiftKey: true });
    expect(state.camera.y).toBe(before.y - 240);
    const zoom = state.camera.zoom;
    key(canvas, '+');
    expect(state.camera.zoom).toBeCloseTo(zoom * 1.25);
    await settle(40);
    expect($('map-announcer').textContent).toMatch(/^Zoom \d+ percent$/);
    key(canvas, '-');
    expect(state.camera.zoom).toBeCloseTo(zoom);
    key(canvas, '0');
    await settle(40);
    expect($('map-announcer').textContent).toMatch(/^The whole map/);
    expect(key(canvas, 'a').defaultPrevented).toBe(false); // a key the map does not use is the page's
  });

  it('steps through the nodes in reading order with N and P, Home and End, selecting and announcing each', async () => {
    const canvas = mount();
    const order = readingOrder(state.nodes).map((n) => n.id);
    key(canvas, 'n');
    expect(state.selectedNode.id).toBe(order[0]);
    expect($('spec-drawer').classList.contains('drawer-open')).toBe(true);
    await settle(40);
    expect($('map-announcer').textContent).toBe(`${state.selectedNode.label}, ${state.selectedNode.type}, 1 connection, 1 of ${order.length}`);
    key(canvas, ']');
    expect(state.selectedNode.id).toBe(order[1]);
    key(canvas, 'p');
    expect(state.selectedNode.id).toBe(order[0]);
    key(canvas, 'End');
    expect(state.selectedNode.id).toBe(order[order.length - 1]);
    key(canvas, 'Home');
    expect(state.selectedNode.id).toBe(order[0]);
    expect(document.activeElement === canvas || document.activeElement === document.body).toBe(true); // stepping leaves the focus on the map
  });

  it('Enter goes into the panel; Escape there closes it and gives the map the focus back', async () => {
    const canvas = mount();
    canvas.focus();
    key(canvas, 'n');
    key(canvas, 'Enter');
    expect(document.activeElement).toBe($('drawer-title'));
    key($('drawer-title'), 'Escape');
    expect(state.selectedNode).toBe(null);
    expect(document.activeElement).toBe(canvas);
    await settle(40);
    expect($('map-announcer').textContent).toBe('Panel closed');
  });

  it('Escape on the map closes the panel too', () => {
    const canvas = mount();
    key(canvas, 'n');
    key(canvas, 'Escape');
    expect(state.selectedNode).toBe(null);
  });

  it('in Freeform, Alt+arrow moves the selected node, and the position is kept', () => {
    const canvas = mount();
    state.isFreeform = true;
    key(canvas, 'n');
    const n = state.selectedNode;
    const x = n.x;
    key(canvas, 'ArrowRight', { altKey: true });
    expect(n.x).toBe(x + 20);
    expect(state.freeformPositions[n.id]).toEqual({ x: n.x, y: n.y });
    state.isFreeform = false;
    key(canvas, 'ArrowRight', { altKey: true });
    expect(n.x).toBe(x + 20); // the orbit layout is fixed
  });

  it('leaves Left and Right to a playing scenario', () => {
    const canvas = mount();
    state.scenario = { id: 'x' };
    const x = state.camera.x;
    expect(key(canvas, 'ArrowLeft').defaultPrevented).toBe(false);
    expect(state.camera.x).toBe(x);
    state.scenario = null;
  });

  it('Enter in the search box selects the first match; a miss is said', async () => {
    mount();
    const input = $('node-search');
    input.value = 'orders';
    key(input, 'Enter');
    expect(state.selectedNode.label.toLowerCase()).toContain('orders');
    input.value = 'nothing like it';
    key(input, 'Enter');
    await settle(40);
    expect($('map-announcer').textContent).toBe('No node matches nothing like it');
  });

  it('Escape closes the Layers menu and puts the focus back on its button', () => {
    mount();
    renderLayerToggles();
    toggleLegendMenu();
    key(document.body, 'Escape');
    expect($('legend-dropdown').hidden).toBe(true);
    expect($('legend-toggle-btn').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe($('legend-toggle-btn'));
  });
});

describe('a what-if edge without a drag', () => {
  it('picks the other end from a list in the node\'s panel and opens the edge form', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/proposals') return { ok: true, status: 200, headers: new Headers(), json: async () => [] };
      if (u.pathname.endsWith('/review')) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
      return { ok: true, status: 200, headers: new Headers({ 'X-Proposal-Source': 'checkout' }), json: async () => structuredClone(PROPOSAL) };
    }));
    mount();
    resetWhatIfForTests();
    initWhatIf();
    await initProposals();
    expect(await openProposal('0013-meals', 'checkout')).toBe(true);
    await selectNode(state.nodes.find((n) => n.id === 'page-a'));
    await settle();
    const pick = document.querySelector('[data-edge-to]');
    expect(pick).not.toBe(null);
    expect([...pick.options].map((o) => o.value)).not.toContain('page-a');
    pick.value = 'table-t';
    document.querySelector('[data-whatif="edge-to"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const form = document.querySelector('[data-form="edge"]');
    expect(form).not.toBe(null);
    expect(form.textContent).toContain('/orders → orders');
    expect(document.activeElement).toBe(form.querySelector('[name="kind"]'));
    closeProposal();
  });
});

// @vitest-environment happy-dom
/**
 * The Work view's code grouped by area, and a spec pull request's thread folded into its proposal (spec 0015 D1, D2), through the page's own markup with a fake
 * server behind `fetch`: a tap on an area opens it in place and a second tap closes it, clearing the selection closes it, a link to a node of code opens its area,
 * the lines to code are the selection's, and `?thread=` of a folded thread selects its proposal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { state, pageInstance } from '../../explorer/state.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap } from '../../explorer/view.js';
// @ts-expect-error plain JS modules, no declarations
import { initForgePanel, resetForgePanelForTests, closeForge } from '../../explorer/forge-panel.js';
// @ts-expect-error plain JS modules, no declarations
import { initWorkView, resetWorkViewForTests, closeWork, openWork, followWorkAddress } from '../../explorer/work-view.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard, resetKeyboardForTests } from '../../explorer/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { initSheets } from '../../explorer/sheets.js';
// @ts-expect-error plain JS modules, no declarations
import { closeDrawer, selectNode } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode as tapSelect } from '../../explorer/engine/selection.js';
// @ts-expect-error plain JS modules, no declarations
import { resetConnectionForTests } from '../../explorer/connection.js';
import { explorerPage } from '../helpers.js';

const page = explorerPage({ pieces: ['map'] });
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const node = (id, type) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, degree: 0 });
const MAP = {
  nodes: [node('root', 'root'), node('billing', 'app'), node('invoices', 'table'), node('payments', 'table'), node('auth', 'service')],
  edges: [{ from: 'root', to: 'billing' }, { from: 'root', to: 'auth' }, { from: 'billing', to: 'invoices' }, { from: 'billing', to: 'payments' }],
};
const GRAPH = {
  ok: true,
  nodes: [
    { id: 'pull:7', kind: 'pull', stage: 'build', title: 'Page the invoices', state: 'open', open: true, waiting: false, number: 7, updated: '2026-11-12T00:00:00Z' },
    { id: 'issue:3', kind: 'issue', stage: 'talk', title: 'Sign-in loops', state: 'open', open: true, waiting: false, number: 3, updated: '2026-11-11T00:00:00Z' },
    { id: 'proposal:0100-flow', kind: 'proposal', stage: 'decide', title: 'A new flow', state: 'to-decide', open: true, waiting: true, slug: '0100-flow', number: 21, updated: '2026-11-11T00:00:00Z' },
    { id: 'thread:21', kind: 'thread', stage: 'talk', title: 'Spec: A new flow', state: 'open', open: true, waiting: false, number: 21, threadKind: 'proposal', updated: '2026-11-11T00:00:00Z' },
  ],
  edges: [
    { from: 'pull:7', to: 'invoices', rel: 'changes' },
    { from: 'pull:7', to: 'payments', rel: 'changes' },
    { from: 'pull:7', to: 'issue:3', rel: 'closes' },
    { from: 'issue:3', to: 'auth', rel: 'mentions' },
    { from: 'proposal:0100-flow', to: 'billing', rel: 'changes' },
    { from: 'thread:21', to: 'proposal:0100-flow', rel: 'discusses' },
  ],
  problems: [],
};
const $ = (id) => document.getElementById(id);

function fakeServer() {
  const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => structuredClone(data) });
  vi.stubGlobal('fetch', vi.fn(async (url) => (new URL(url, 'http://localhost').pathname === '/api/forge/work-graph' ? json(200, GRAPH) : json(404, { ok: false, error: 'No such thing.', code: 'not-found' }))));
}
const settle = async () => { for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0); };

function mount() {
  document.body.innerHTML = body;
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = $('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1200, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 800, configurable: true });
  Object.assign(state, { canvas, ctx, labelCanvas: null, proposal: null, view: 'orbit', selectedNode: null, scenario: null, searchQuery: '' });
  state.camera = { x: 600, y: 400, zoom: 1 };
  state.work = null;
  render.resize();
  state.baseNodes = MAP.nodes.map((n) => ({ ...n }));
  state.baseEdges = MAP.edges;
  setMap(MAP.nodes.map((n) => ({ ...n })), MAP.edges);
  resetKeyboardForTests();
  initKeyboard();
  initSheets();
  resetForgePanelForTests(() => Date.parse('2026-11-12T12:00:00Z'));
  resetWorkViewForTests();
  initForgePanel({ forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' }, signIn: { login: 'maintainer-one' } }, { clock: () => Date.parse('2026-11-12T12:00:00Z') });
  initWorkView({ offered: true });
}
const at = (id) => state.nodes.find((n) => n.id === id);
/** A tap on a node of the map: the map selects it, and says it was tapped (input.js `select`) */
const tap = async (id) => { const n = at(id); tapSelect(pageInstance(), n, { source: 'tap' }); pageInstance().emit('select', n); await settle(); };
const drawn = () => render.getScene().edges.map((e) => `${e.from}>${e.to}`).sort();

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { closeWork(); closeForge({ restoreFocus: false }); if ($('spec-drawer')) closeDrawer(); resetConnectionForTests(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = ''; });

describe('the code grouped by area (spec 0015 D1)', () => {
  it('draws one node per area, and only the lines between work while nothing is selected', async () => {
    fakeServer();
    mount();
    await openWork();
    await settle();
    expect(state.nodes.filter((n) => !n.work && !n.hidden).map((n) => n.id).sort()).toEqual(['auth', 'billing']);
    expect(at('invoices').hidden).toBe(true);
    expect(drawn()).toEqual(['pull:7>issue:3']);
  });

  it('opens an area in place on a tap, closes it on a second, and closes it when the selection is cleared', async () => {
    fakeServer();
    mount();
    await openWork();
    await settle();
    await tap('billing');
    expect(state.work.open).toBe('billing');
    expect(at('invoices').hidden).toBe(false);
    expect(drawn()).toEqual(expect.arrayContaining(['pull:7>invoices', 'pull:7>payments', 'proposal:0100-flow>billing']));
    await tap('billing');
    expect(state.work.open).toBeNull();
    expect(at('invoices').hidden).toBe(true);
    expect(drawn()).toEqual(expect.arrayContaining(['pull:7>billing', 'proposal:0100-flow>billing'])); // a line to a closed area ends at it
    await tap('billing');
    expect(state.work.open).toBe('billing');
    closeDrawer(); // Escape, Close, a click on the bare map
    await settle();
    expect(state.selectedNode).toBeNull();
    expect(state.work.open).toBeNull();
  });

  it('draws a piece of work\'s lines to code while it is selected, ending at the closed area', async () => {
    fakeServer();
    mount();
    await openWork();
    await settle();
    await selectNode(at('pull:7'));
    await settle();
    expect(drawn()).toEqual(['pull:7>billing', 'pull:7>issue:3']);
  });

  it('opens the area of a node of code a link or a search selects', async () => {
    fakeServer();
    mount();
    await openWork({ select: 'payments' });
    await settle();
    expect(state.selectedNode && state.selectedNode.id).toBe('payments');
    expect(state.work.open).toBe('billing');
    expect(at('payments').hidden).toBe(false);
  });
});

describe('a spec pull request\'s thread folded into its proposal (spec 0015 D2)', () => {
  it('is not drawn, and ?thread= selects the proposal', async () => {
    fakeServer();
    mount();
    history.replaceState(null, '', '/?thread=21');
    await followWorkAddress();
    await settle();
    expect(at('thread:21').hidden).toBe(true);
    expect(at('thread:21').foldedInto).toBe('proposal:0100-flow');
    expect(state.selectedNode && state.selectedNode.id).toBe('proposal:0100-flow');
    await selectNode(at('thread:21')); // a search's choice of it
    await settle();
    expect(state.selectedNode && state.selectedNode.id).toBe('proposal:0100-flow');
  });
});

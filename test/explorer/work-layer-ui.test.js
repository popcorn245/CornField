// @vitest-environment happy-dom
/**
 * The Work layer on the Map view and the Work view share one read (spec 0012 D4), through the page's own markup with a fake server behind `fetch`:
 * a poll never asks a slow forge twice at once, a read that replaces another keeps the node it was to select, a poll that fails is quiet on the map,
 * and the node panel open on a node shows its Open work when the layer comes on, without being chosen again.
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
import { initWorkView, resetWorkViewForTests, closeWork } from '../../explorer/work-view.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard, resetKeyboardForTests } from '../../explorer/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { initSheets } from '../../explorer/sheets.js';
// @ts-expect-error plain JS modules, no declarations
import { closeDrawer, selectNode } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { setLayer } from '../../explorer/engine/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { resetConnectionForTests } from '../../explorer/connection.js';
import { explorerPage } from '../helpers.js';

const page = explorerPage({ pieces: ['map'] });
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const MAP = { nodes: [{ id: 'billing', type: 'service', x: 0, y: 0, r: 20, color: '#336699', label: 'billing', degree: 0 }, { id: 'auth', type: 'service', x: 300, y: 0, r: 20, color: '#336699', label: 'auth', degree: 0 }], edges: [] };
const GRAPH = {
  ok: true,
  nodes: [
    { id: 'pull:7', kind: 'pull', stage: 'build', title: 'Page the invoices', state: 'open', open: true, waiting: false, number: 7, updated: '2026-11-12T00:00:00Z', url: 'https://forge.example/pull/7' },
    { id: 'issue:3', kind: 'issue', stage: 'talk', title: 'Sign-in loops', state: 'open', open: true, waiting: false, number: 3, updated: '2026-11-11T00:00:00Z' },
  ],
  edges: [{ from: 'pull:7', to: 'billing', rel: 'changes' }, { from: 'issue:3', to: 'auth', rel: 'mentions' }],
  problems: [],
};
const $ = (id) => document.getElementById(id);
const POLL = 60_000;

/** A fake server: the work graph answers at once, or is held until `release` (each held request in turn), or fails with `fail` */
function fakeServer() {
  const reads = [];
  const held = [];
  const opts = { hold: false, fail: null };
  const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => structuredClone(data) });
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = new URL(url, 'http://localhost');
    if (u.pathname !== '/api/forge/work-graph') return json(404, { ok: false, error: 'No such thing.', code: 'not-found' }); // the lists and a piece's detail: not what is tested here
    reads.push(Date.now());
    if (opts.fail) return json(opts.fail, { ok: false, error: 'No.' });
    if (opts.hold) return new Promise((resolve) => held.push(() => resolve(json(200, GRAPH))));
    return json(200, GRAPH);
  }));
  return { reads, opts, release: () => held.splice(0).forEach((f) => f()), held };
}
const settle = async () => { for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0); };

function mount() {
  document.body.innerHTML = body;
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = $('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, labelCanvas: null, proposal: null, view: 'orbit', selectedNode: null, scenario: null, searchQuery: '' });
  state.camera = { x: 500, y: 350, zoom: 1 };
  state.activeLayers['work-badges'] = false;
  state.work = null; // no answer from an earlier test
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
const layer = (on) => setLayer(pageInstance(), 'work-badges', on);
const openWorkLinks = () => [...document.querySelectorAll('#spec-drawer [data-corn="work-links"] li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim());

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { closeWork(); layer(false); closeForge({ restoreFocus: false }); if ($('spec-drawer')) closeDrawer(); resetConnectionForTests(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = ''; });

describe('one read and one poll (spec 0012 D4)', () => {
  it('asks nothing while the layer is off, reads once when it comes on, then once a minute, and stops when it goes off', async () => {
    const server = fakeServer();
    mount();
    await vi.advanceTimersByTimeAsync(3 * POLL);
    expect(server.reads).toHaveLength(0);
    layer(true);
    await settle();
    expect(server.reads).toHaveLength(1);
    expect(state.work.badges.get('billing').map((i) => i.tag)).toEqual(['PR #7']);
    await vi.advanceTimersByTimeAsync(2 * POLL);
    expect(server.reads).toHaveLength(3);
    layer(false);
    await vi.advanceTimersByTimeAsync(3 * POLL);
    expect(server.reads).toHaveLength(3);
  });

  it('never asks a slow forge twice at once: the minute\'s poll waits for the read on its way', async () => {
    const server = fakeServer();
    mount();
    layer(true);
    await settle();
    server.opts.hold = true;
    await vi.advanceTimersByTimeAsync(POLL); // the poll's read, held
    expect(server.reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3 * POLL); // the forge is slower than three polls
    expect(server.reads).toHaveLength(2);
    expect(server.held).toHaveLength(1);
    server.release();
    await settle();
    await vi.advanceTimersByTimeAsync(POLL);
    expect(server.reads).toHaveLength(3);
  });

  it('keeps the node an open asked for when a refresh replaces its read', async () => {
    const server = fakeServer();
    mount();
    layer(true);
    await settle();
    server.opts.hold = true;
    pageInstance().emit('work:open', { id: 'pull:7' }); // a node panel's Open work link: the view opens, and reads
    await settle();
    expect(state.view).toBe('work');
    document.querySelector('.hx-work-bar [data-action="refresh-forge"], [data-action="refresh-forge"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(server.held).toHaveLength(2); // the refresh's own read replaced the open's
    server.release();
    await settle();
    expect(state.selectedNode && state.selectedNode.id).toBe('pull:7');
  });

  it('is quiet on the map when the minute\'s poll fails: the badges stay, nothing is said, no card', async () => {
    const server = fakeServer();
    mount();
    layer(true);
    await settle();
    await vi.advanceTimersByTimeAsync(2000); // what the read said is said
    expect($('map-announcer').textContent).toBe('Work layer: 2 nodes have open work.');
    $('map-announcer').textContent = '';
    for (const status of [500, 401]) {
      server.opts.fail = status;
      await vi.advanceTimersByTimeAsync(POLL);
      await settle();
      expect(state.work.status).toBe('ok');
      expect(state.work.badges.size).toBe(2);
      expect($('map-announcer').textContent).toBe('');
    }
  });
});

describe('the node panel follows the layer', () => {
  it('shows Open work on the selected node when the layer comes on, and takes it away when it goes off, without the node chosen again', async () => {
    fakeServer();
    mount();
    await selectNode(state.nodes.find((n) => n.id === 'billing'));
    await settle();
    expect(openWorkLinks()).toEqual([]);
    const title = $('drawer-title').textContent;
    layer(true);
    await settle();
    expect(openWorkLinks()).toEqual(['Pull requestPR #7 · Page the invoices Open ↗']);
    expect($('drawer-title').textContent).toBe(title);
    expect(document.querySelectorAll('#spec-drawer [data-corn="work-links"]')).toHaveLength(1);
    layer(false);
    await settle();
    expect(openWorkLinks()).toEqual([]);
    expect($('drawer-title').textContent).toBe(title);
  });
});

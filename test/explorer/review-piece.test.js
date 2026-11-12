// @vitest-environment happy-dom
/**
 * Spec 0011 D3, D4, D8: the review as one piece (explorer/pieces/review.js). One root, one instance, the map, the proposal's bar, the change list with its
 * player, the decision and the node panel laid out in it; it takes a topology and a proposal as objects (no request), or a base and a slug; a phone is a
 * narrow box, not a narrow window; nothing leaves the box, and destroy leaves nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { loadSample, SAMPLE, EXPLORER } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { mount, STYLESHEETS, EMPTY_WORDS } from '../../explorer/pieces/review.js';
// @ts-expect-error plain JS modules, no declarations
import { setTopology, setMap } from '../../explorer/engine/topology.js';
// @ts-expect-error plain JS modules, no declarations
import { createInstance } from '../../explorer/instance.js';
// @ts-expect-error plain JS modules, no declarations
import { isPhone, expandSheet } from '../../explorer/engine/sheets.js';
// @ts-expect-error plain JS modules, no declarations
import { sheetCap } from '../../explorer/sheet-model.js';
// @ts-expect-error plain JS modules, no declarations
import { NOTHING_TO_DECIDE } from '../../explorer/decision-model.js';

const sample = loadSample();
const proposal = JSON.parse(fs.readFileSync(`${SAMPLE}/docs/specs/proposals/0002-checkout.json`, 'utf8'));
const topology = () => structuredClone({ nodes: sample.nodes, edges: sample.edges });
const ctx2d = new Proxy({}, { get: (t, k) => (k === 'measureText' ? (text) => ({ width: String(text).length * 6 }) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });

let restore = [];
const live = { doc: new Set(), win: new Set() };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  live.doc.clear();
  live.win.clear();
  for (const [target, set] of [[document, live.doc], [window, live.win]]) {
    const add = target.addEventListener;
    const remove = target.removeEventListener;
    target.addEventListener = function (t, fn, o) { set.add(t); return add.call(this, t, fn, o); };
    target.removeEventListener = function (t, fn, o) { return remove.call(this, t, fn, o); };
    restore.push(() => { target.addEventListener = add; target.removeEventListener = remove; });
  }
  const realGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) { return type === '2d' ? ctx2d : null; };
  restore.push(() => { HTMLCanvasElement.prototype.getContext = realGet; });
});
afterEach(() => {
  restore.forEach((fn) => fn());
  restore = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function host() {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
}
const make = (options = {}, el = host()) => ({ el, piece: mount(el, null, { renderer: 'canvas2d', ...options }) });
const ids = (el) => [...el.querySelectorAll('[id]')].map((e) => e.id);

describe('its layout: one root, with the places the cross-piece lookups expect', () => {
  it('makes one box in the host, holding a stage, the dock, the bar, the column, the node panel and the player\'s place, named as the page names them', () => {
    const { el, piece } = make({ topology: topology(), proposal });
    expect(el.children.length).toBe(1);
    const box = el.firstElementChild;
    expect(box.getAttribute('data-corn')).toBe('review');
    expect(box.getAttribute('part')).toBe('review');
    expect(box.getAttribute('role')).toBe('region');
    expect(box.getAttribute('aria-label')).toBe('Proposal review');
    expect(make({ label: ' Spec review ' }).el.firstElementChild.getAttribute('aria-label')).toBe('Spec review');
    for (const id of ['sheet-dock', 'proposal-bar', 'proposal-body', 'review-column', 'spec-drawer', 'drawer-backdrop', 'graph-canvas', 'map-announcer', 'review-decision']) {
      expect(piece.inst.el(id), id).toBeTruthy();
      expect(box.contains(piece.inst.el(id)), id).toBe(true);
    }
    expect(box.querySelector('[data-corn="stage"] > #sheet-dock')).toBeTruthy();
    // the column and the bar are in the dock (changes.js and the player find the dock by id), the panel too, and the decision is the column's foot
    const dock = piece.inst.el('sheet-dock');
    for (const id of ['proposal-bar', 'review-column', 'spec-drawer']) expect(piece.inst.el(id).parentElement).toBe(dock);
    expect(piece.inst.el('review-column').contains(piece.inst.el('review-decision'))).toBe(true);
    expect(piece.inst.root).toBe(box);
    expect(piece.inst.el('proposal-myedits')).toBe(null); // the what-if editor is not converted
    expect(piece.inst.el('forge-panel')).toBe(null);
    expect(piece.inst.el('legend-dropdown')).toBe(null);
  });

  it('exports the stylesheets a shell loads, in order', () => {
    expect(STYLESHEETS).toEqual(['base.css', 'map.css', 'node-panel.css', 'proposal.css', 'changes.css', 'decision.css', 'sheets.css', 'review.css']);
  });

  it('gives every hook its part, the box included', () => {
    const { el } = make({ topology: topology(), proposal });
    for (const x of el.querySelectorAll('[data-corn]')) expect(x.getAttribute('part'), x.outerHTML.slice(0, 80)).toBe(x.getAttribute('data-corn'));
  });
});

describe('what it takes', () => {
  it('draws a topology and a proposal object with no request, the added nodes placed beside what was there', () => {
    const fetch = vi.fn(() => Promise.reject(new Error('no server')));
    const t = topology();
    const before = JSON.stringify(t);
    const { piece } = make({ topology: t, proposal, slug: '0002-checkout', source: 'pull/2', fetch: undefined });
    expect(fetch).not.toHaveBeenCalled();
    const { state } = piece.inst;
    expect(state.proposal.title).toBe(proposal.title);
    expect(state.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    expect(state.nodes.some((n) => n.mark === 'added')).toBe(true);
    expect(state.proposalSlug).toBe(null); // no base, no fetch: the name and source are not handed to pieces that would ask a server
    expect(JSON.stringify(t)).toBe(before);
    expect(piece.inst.el('proposal-title').textContent).toBe(proposal.title);
    expect(piece.inst.el('review-column').hidden).toBe(false);
  });

  it('makes no request of any kind with objects handed in (the global fetch is never called)', () => {
    const spy = vi.fn(() => Promise.reject(new Error('no')));
    vi.stubGlobal('fetch', spy);
    make({ topology: topology(), proposal, source: 'pull/2', slug: 'x' });
    vi.advanceTimersByTime(2000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('says in words that there is nothing to decide with objects and no server, and offers no Approve or Send back that would do nothing', () => {
    const { piece } = make({ topology: topology(), proposal, slug: '0002-checkout', source: 'pull/2' });
    const foot = piece.inst.el('review-decision');
    const line = foot.querySelector('[data-review-line]');
    expect(foot.closest('[hidden]')).toBe(null);
    expect(line.closest('[hidden]')).toBe(null);
    expect(line.textContent).toBe(NOTHING_TO_DECIDE);
    for (const b of foot.querySelectorAll('[data-review]')) expect(b.closest('[hidden]'), b.textContent).not.toBe(null);
    piece.update({ proposal: null });
    expect(line.closest('[hidden]')).not.toBe(null);
  });

  it('fetches a slug through its base, and only once there is a map to lay it on', async () => {
    const calls = [];
    const fetch = vi.fn(async (url) => { calls.push(String(url)); return String(url).includes('/proposals/') && String(url).endsWith('.json') ? new Response(JSON.stringify(proposal), { status: 200, headers: { 'X-Proposal-Source': 'checkout' } }) : new Response('{}', { status: 404 }); });
    const { piece } = make({ base: 'http://map.example.test', fetch, proposal: '0002-checkout' });
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.some((u) => u.includes('/proposals/0002-checkout.json'))).toBe(false); // no topology yet: held
    piece.update({ topology: topology() });
    await vi.advanceTimersByTimeAsync(10);
    expect(calls[0]).toBe('http://map.example.test/proposals/0002-checkout.json');
    expect(piece.inst.state.proposal.title).toBe(proposal.title);
  });

  it('closes on null, switches Before / Diff / After, and takes the map\'s views by the same word', () => {
    const { piece } = make({ topology: topology(), proposal });
    const { state } = piece.inst;
    piece.update({ view: 'after' });
    expect(state.proposalView).toBe('after');
    piece.update({ view: 'dataflow' });
    expect(state.view).toBe('dataflow');
    expect(state.proposalView).toBe('after');
    piece.update({ view: 'map', proposal: null });
    expect(state.view).toBe('orbit');
    expect(state.proposal).toBe(null);
    expect(piece.inst.el('review-column').hidden).toBe(true);
  });

  it('selects a node by id and tells the instance', () => {
    const { piece } = make({ topology: topology() });
    const seen = [];
    piece.inst.on('selection', (e) => seen.push(e.node && e.node.id));
    piece.update({ node: sample.nodes[2].id });
    expect(seen).toEqual([sample.nodes[2].id]);
  });
});

describe('engine/topology.js: the one function the map piece and this piece call', () => {
  it('copies the topology in, builds the flow, and keeps the selection when its node is still there', () => {
    const inst = createInstance({});
    const t = topology();
    expect(setTopology(inst, t)).toBe(true);
    expect(inst.state.baseNodes).toHaveLength(t.nodes.length);
    expect(inst.state.nodes[0]).not.toBe(t.nodes[0]);
    expect(inst.state.flow).toBeTruthy();
    inst.state.selectedNode = inst.state.nodes[1];
    setTopology(inst, topology());
    expect(inst.state.selectedNode.id).toBe(t.nodes[1].id);
    setTopology(inst, { nodes: [t.nodes[0]], edges: [] });
    expect(inst.state.selectedNode).toBe(null);
    expect(setTopology(inst, null)).toBe(false);
  });

  it('lays a proposal\'s map out around the base: a node that was there keeps its place', () => {
    const { piece } = make({ topology: topology() });
    const { state } = piece.inst;
    const was = new Map(state.nodes.map((n) => [n.id, [n.x, n.y]]));
    piece.update({ proposal });
    for (const n of state.nodes) if (was.has(n.id)) expect([n.x, n.y], n.id).toEqual(was.get(n.id));
    expect(setMap).toBeTypeOf('function');
  });

  it('keeps every node small in the data-flow lanes with a proposal open, the added ones too (as cornfield\'s page does)', () => {
    // the sample proposal adds pages, which the lanes leave out: a table is added too, which they hold
    const withTable = structuredClone(proposal);
    withTable.nodes.add.push({ id: 'table-receipts', label: 'receipts', type: 'table', table: 'receipts', parent: 'store-sqlite', desc: 'Receipts.' });
    withTable.edges.add.push({ from: 'store-sqlite', to: 'table-receipts' }, { from: 'page-api-checkout', to: 'table-receipts', kind: 'writes', status: 'proposed', label: 'receipts.add' });
    const { piece } = make({ topology: topology(), proposal: withTable });
    const { state } = piece.inst;
    piece.update({ view: 'dataflow' });
    const laned = state.flow.tiers.flatMap((t) => t.nodes);
    expect(laned.some((n) => n.mark === 'added')).toBe(true);
    for (const n of laned) expect(n.r, n.id).toBeLessThanOrEqual(13);
  });

  it('is the one layout: cornfield\'s page (view.js) lays nothing out of its own but the House view', () => {
    const view = fs.readFileSync(`${EXPLORER}/view.js`, 'utf8');
    expect(view).toMatch(/layoutMap\(pageInstance\(\)\)/);
    for (const own of ['layoutOrbit', 'computeLaneLayout', 'pinLanes', 'placeAddedNodes', 'placeLiveNodes']) expect(view, own).not.toMatch(new RegExp(`\\b${own}\\b`));
  });
});

describe('a phone is a narrow box, not a narrow window', () => {
  it('asks the box\'s width', () => {
    const { el, piece } = make({ topology: topology(), proposal });
    const box = el.firstElementChild;
    const width = (w) => Object.defineProperty(box, 'clientWidth', { value: w, configurable: true });
    width(390);
    expect(isPhone(piece.inst)).toBe(true);
    width(1100);
    expect(isPhone(piece.inst)).toBe(false);
  });
});

describe('a sheet is capped by the box, not the window', () => {
  it('keeps the map 35% of the box\'s height', () => {
    const { el, piece } = make({ topology: topology(), proposal });
    const box = el.firstElementChild;
    Object.defineProperty(box, 'clientWidth', { value: 390, configurable: true });
    Object.defineProperty(box, 'clientHeight', { value: 500, configurable: true });
    window.innerHeight = 900;
    expandSheet(piece.inst, 'proposal');
    expect(piece.inst.el('sheet-dock').style.getPropertyValue('--hx-sheet-cap')).toBe(`${sheetCap(500, 0)}px`);
    expect(sheetCap(500, 0)).not.toBe(sheetCap(900, 0));
  });
});

describe('nothing leaves the box', () => {
  it('adds nothing to the document or the window, and nothing outside the host', () => {
    const el = host();
    const outside = document.body.innerHTML.replace(el.outerHTML, '');
    mount(el, null, { renderer: 'canvas2d', topology: topology(), proposal });
    expect(document.body.children.length).toBe(1); // the host, and nothing beside it
    expect(document.body.innerHTML.replace(el.outerHTML, '')).toBe(outside);
    // the few facts the instance itself listens to (instance.js: the tab shown or hidden, the network, the window's focus), never a key or a click
    expect([...live.doc].filter((t) => t !== 'visibilitychange')).toEqual([]);
    expect([...live.win].filter((t) => !['offline', 'online', 'focus', 'pagehide'].includes(t))).toEqual([]);
    expect(document.documentElement.getAttributeNames()).toEqual([]);
  });

  it('removes those too on destroy', () => {
    const removed = [];
    const rd = document.removeEventListener;
    document.removeEventListener = function (t, ...r) { removed.push(t); return rd.call(this, t, ...r); };
    restore.push(() => { document.removeEventListener = rd; });
    const { piece } = make({ topology: topology(), proposal });
    piece.destroy();
    expect(removed).toContain('visibilitychange');
  });

  it('destroys completely, 30 times over, and a second destroy does nothing', () => {
    const el = host();
    for (let i = 0; i < 30; i++) {
      const piece = mount(el, null, { renderer: 'canvas2d', topology: topology(), proposal });
      piece.destroy();
      piece.destroy();
    }
    expect(el.innerHTML).toBe('');
    expect(document.body.children.length).toBe(1);
  });

  it('is two reviews with nothing in common in one document', () => {
    const a = make({ topology: topology(), proposal });
    const b = make({ topology: topology() });
    a.piece.update({ node: sample.nodes[2].id });
    expect(a.piece.inst.state.selectedNode.id).toBe(sample.nodes[2].id);
    expect(b.piece.inst.state.selectedNode).toBe(null);
    expect(b.piece.inst.state.proposal).toBe(null);
    a.piece.destroy();
    expect(b.el.firstElementChild).toBeTruthy();
    expect(b.piece.inst.el('graph-canvas')).toBeTruthy();
  });
});

describe('in a shadow root, as the coming tag holds it', () => {
  /** A plain element with an open shadow root, in the document: what a shell does at its least */
  function shadowHost() {
    const el = document.createElement('div');
    document.body.append(el);
    return el.attachShadow({ mode: 'open' });
  }

  it('finds its own elements and its own focus there (inst.active() is the focused element in the shadow root, not the host)', () => {
    const root = shadowHost();
    const piece = mount(root, null, { renderer: 'canvas2d', topology: topology(), proposal });
    expect(piece.inst.root.getRootNode()).toBe(root);
    for (const id of ['sheet-dock', 'proposal-bar', 'review-column', 'spec-drawer', 'graph-canvas', 'review-decision']) expect(piece.inst.el(id), id).toBeTruthy();
    const title = piece.inst.el('proposal-title');
    title.setAttribute('tabindex', '-1');
    title.focus();
    expect(root.activeElement).toBe(title);
    expect(piece.inst.active()).toBe(title);
    piece.inst.state.canvas.focus();
    expect(piece.inst.active()).toBe(piece.inst.state.canvas);
  });

  it('puts no id in the document: two reviews in two shadow roots share none', () => {
    const a = mount(shadowHost(), null, { renderer: 'canvas2d', topology: topology(), proposal });
    const b = mount(shadowHost(), null, { renderer: 'canvas2d', topology: topology() });
    expect(document.querySelectorAll('[id]').length).toBe(0);
    expect(a.inst.el('graph-canvas')).not.toBe(b.inst.el('graph-canvas'));
    a.destroy();
    b.destroy();
  });
});

describe('hostile and odd input: text only, no throw, and a plain word where there is nothing to show', () => {
  let errors;
  let spy;
  const onError = (e) => errors.push(e.error || e.message);
  beforeEach(() => { errors = []; window.addEventListener('error', onError); spy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' '))); });
  afterEach(() => { window.removeEventListener('error', onError); spy.mockRestore(); });
  const evil = '<img src=x onerror="window.__pwned=1"><b data-x>bold</b>"\'><svg onload=alert(1)>';
  const markupIn = (box) => {
    const attrs = [...box.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name));
    return { img: box.querySelectorAll('img, b[data-x], [src]').length, on: attrs.filter((a) => a.startsWith('on')), js: box.querySelectorAll('a[href^="javascript"]').length };
  };

  it('a topology and a proposal with markup in every string and ids with quotes and brackets', async () => {
    const id = (s) => `n"]>${s}[0]'<x>`;
    const t = {
      nodes: [
        { id: id('a'), label: evil, type: 'service', desc: evil, links: [{ label: evil, url: 'javascript:alert(1)' }] },
        { id: id('b'), label: evil, type: 'table', parent: id('a'), desc: evil },
        { id: id('c'), label: evil, type: evil, desc: evil },
      ],
      edges: [{ from: id('a'), to: id('b'), kind: 'writes', label: evil }, { from: id('b'), to: id('a'), kind: evil, label: evil }, { from: id('c'), to: id('nowhere') }],
    };
    const p = {
      version: 1, spec: evil, title: evil, summary: evil,
      nodes: { add: [{ id: id('d'), label: evil, type: 'page', parent: id('a'), desc: evil }], change: [{ id: id('b'), set: { desc: evil }, why: evil }], remove: [{ id: id('c'), why: evil }] },
      edges: { add: [{ from: id('d'), to: id('a'), kind: 'calls', label: evil }] },
      scenarios: [{ id: `s"><img>`, title: evil, actor: evil, steps: [{ node: id('d'), text: evil }, { node: id('nowhere'), text: evil }] }],
    };
    const { el, piece } = make({ topology: t, proposal: p });
    await vi.advanceTimersByTimeAsync(50);
    piece.update({ node: id('d') });
    await vi.advanceTimersByTimeAsync(50);
    expect(piece.inst.el('proposal-title').textContent).toBe(evil);
    const row = el.querySelector('.hx-sc-row'); if (row) row.click();
    const step = el.querySelector('.hx-step'); if (step) step.click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(markupIn(el)).toEqual({ img: 0, on: [], js: 0 });
    expect(window.__pwned).toBeUndefined();
    piece.destroy();
    expect(errors).toEqual([]);
  });

  it('cycles, an edge to a missing node, an empty topology, nothing at all, and a proposal for another map', async () => {
    expect(make({}).el.querySelector('[data-corn="empty"]').hidden).toBe(true); // no word before a topology is handed in
    const cycle = { nodes: [{ id: 'a', type: 'service' }, { id: 'b', type: 'service', parent: 'a' }, { id: 'c', type: 'service', parent: 'b' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }, { from: 'a', to: 'ghost' }] };
    cycle.nodes[0].parent = 'c';
    const { piece } = make({ topology: cycle });
    expect(piece.inst.state.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    for (const t of [{ nodes: [], edges: [] }, null, undefined, 'nodes', { nodes: 'x', edges: 7 }, { nodes: [null, 1, { id: 3 }, { id: 'ok' }], edges: [null, { from: 'ok' }] }]) piece.update({ topology: t });
    expect(piece.inst.state.nodes.map((n) => n.id)).toEqual(['ok']);
    const empty = piece.elements[0].querySelector('[data-corn="empty"]');
    expect(empty.hidden).toBe(true);
    piece.update({ topology: { nodes: [], edges: [] } });
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe(EMPTY_WORDS);
    piece.update({ topology: cycle, proposal });
    await vi.advanceTimersByTimeAsync(50);
    // a proposal of another map opens on this one (its changes to nodes this map has not are left out by applyProposal), and says what it can
    expect(piece.inst.el('proposal-title').textContent).toBe(proposal.title);
    expect(piece.inst.state.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    piece.destroy();
    expect(errors).toEqual([]);
  });

  it('a proposal before its topology, both replaced while drawing, and views and config that are not what they should be', async () => {
    const { piece } = make({ proposal });
    expect(piece.inst.state.proposal).toBe(null);
    piece.update({ topology: topology() });
    expect(piece.inst.state.proposal.title).toBe(proposal.title);
    for (let i = 0; i < 5; i++) {
      piece.update({ topology: topology(), proposal: { ...proposal, title: `t${i}` } });
      await vi.advanceTimersByTimeAsync(5);
    }
    expect(piece.inst.el('proposal-title').textContent).toBe('t4');
    for (const view of ['house', 'nope', 7, null, {}, '<b>', 'dataflow', 'after', 'orbit', 'before']) piece.update({ view });
    expect(piece.inst.state.view).toBe('orbit');
    expect(piece.inst.state.proposalView).toBe('before');
    piece.update({ view: 'dataflow' });
    for (const view of ['house', 'nope', 7, null, '<b>']) piece.update({ view }); // not a view: nothing changes
    expect(piece.inst.state.view).toBe('dataflow');
    expect(piece.inst.state.proposalView).toBe('before');
    for (const config of [null, 7, 'x', { layers: 'x' }, { layers: [null, 7, { id: evil, label: evil, match: 'nope' }] }, { theme: 7 }, { layers: [{ id: 'l', label: evil, types: ['service'], default: 'off' }] }]) piece.update({ config });
    expect(markupIn(piece.elements[0])).toEqual({ img: 0, on: [], js: 0 });
    piece.destroy();
    expect(errors).toEqual([]);
  });

  it('5,000 nodes lay out and open a proposal', async () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, label: `n${i}`, type: i % 7 ? 'page' : 'service', parent: i % 7 ? `n${i - (i % 7)}` : undefined }));
    const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));
    const { piece } = make({ topology: { nodes, edges }, proposal: { version: 1, title: 'big', nodes: { add: [{ id: 'new', type: 'page', parent: 'n0', label: 'new' }] }, edges: { add: [{ from: 'n1', to: 'new' }] } } });
    expect(piece.inst.state.nodes.length).toBe(5001);
    expect(piece.inst.state.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    piece.destroy();
    expect(errors).toEqual([]);
  }, 30_000);
});

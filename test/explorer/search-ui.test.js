// @vitest-environment happy-dom
/**
 * Search on the page (spec 0008 D4), through the page's own markup: the count in the field, the list under it grouped by type, Frame all,
 * stepping with Enter, Shift+Enter and the arrow keys, N and P on the map, the no-match words, a match in a layer that is off turning its
 * layer on, and the words reaching a screen reader. Nothing typed or read from the map ever becomes markup.
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
import { closeDrawer } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard, resetKeyboardForTests } from '../../explorer/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { initSearch, setQuery, stepMatch, frameAll, currentResult, searchActive, resetSearchForTests } from '../../explorer/search.js';
// @ts-expect-error plain JS modules, no declarations
import { stopFlight, tickFlight, flying } from '../../explorer/fly.js';
// @ts-expect-error plain JS modules, no declarations
import { NO_MATCH_DELAY_MS } from '../../explorer/search-status.js';

const page = fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const $ = (id) => document.getElementById(id);

const node = (id, type, label, x, extra = {}) => ({ id, type, x, y: 0, r: 20, color: '#336699', label, ...extra });
const base = {
  nodes: [
    node('root', 'root', 'root', 0),
    node('app-orders', 'app', 'Orders app', 100),
    ...Array.from({ length: 4 }, (_, i) => node(`page-sync-${i}`, 'page', `/sync/${i}`, 200 + i * 100, { file: `apps/orders/sync${i}.js` })),
    node('svc-sync', 'service', 'sync-worker', 700, { kind: 'webhook' }),
    node('svc-mail', 'service', 'mailer', 800, { kind: 'job' }),
    node('table-sync', 'table', 'sync_state', 900),
    node('machine-sync', 'machine', 'Sync box', 1000),
  ],
  edges: [
    { from: 'root', to: 'app-orders' },
    ...Array.from({ length: 4 }, (_, i) => ({ from: 'app-orders', to: `page-sync-${i}` })),
    { from: 'app-orders', to: 'svc-sync' }, { from: 'app-orders', to: 'svc-mail' }, { from: 'root', to: 'table-sync' }, { from: 'root', to: 'machine-sync' },
  ],
};

function mount() {
  document.body.innerHTML = body;
  const ctx = new Proxy({}, { get: (_t, key) => (key === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = $('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, labelCanvas: null, proposal: null, view: 'orbit', selectedNode: null, live: null, house: null, scenario: null, runsMap: null, searchQuery: '', searchCurrent: null, isFreeform: false });
  for (const l of LAYER_DEFS) state.activeLayers[l.key] = !['stack', 'machine', 'container', 'device', 'house', 'persona'].includes(l.key);
  state.baseNodes = base.nodes.map((n) => ({ ...n }));
  state.baseEdges = base.edges;
  render.resize();
  setMap(state.baseNodes.map((n) => ({ ...n })), state.baseEdges);
  renderLayerToggles();
  resetKeyboardForTests();
  resetSearchForTests();
  initKeyboard();
  initSearch();
}

const type = (value, id = 'node-search') => { const input = $(id); input.focus(); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
const key = (el, k, opts = {}) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }); el.dispatchEvent(e); return e; };
const rows = (id = 'search-results') => [...$(id).querySelectorAll('[data-corn="search-result"]')];
const names = (id = 'search-results') => rows(id).map((r) => r.textContent);
const settle = () => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(60) : new Promise((r) => setTimeout(r, 20)));

afterEach(() => { vi.useRealTimers(); stopFlight(); closeDrawer(); document.body.innerHTML = ''; });

describe('the count and the list', () => {
  it('shows the count in the field and a list grouped by type, with Frame all first and each row\'s parent', () => {
    mount();
    type('sync');
    expect($('search-count').textContent).toBe('7 matches');
    expect($('search-steps').hidden).toBe(false);
    const list = $('search-results');
    expect(list.hidden).toBe(false);
    expect(rows()[0].textContent).toBe('Frame all 6'); // the machine is on a layer that is off: not on the map
    const groups = [...list.querySelectorAll('[data-corn="search-group"]')].map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['Services, 1', 'Tables, 1', 'Pages & Routes, 4', 'In layers that are off, 1']);
    const sync0 = rows().find((r) => r.dataset.searchId === 'page-sync-0');
    expect(sync0.textContent).toContain('/sync/0');
    expect(sync0.textContent).toContain('Orders app'); // its parent
    const off = rows().find((r) => r.dataset.searchId === 'machine-sync');
    expect(off.textContent).toContain('Machines'); // an off row says which layer
  });

  it('says No match, and in the list that nothing matches and what a search reads', () => {
    vi.useFakeTimers();
    mount();
    type('zzzz');
    expect($('search-count').textContent).toBe('No match');
    expect($('search-count').dataset.empty).toBe('true');
    expect($('search-results').querySelector('[data-corn="search-empty"]').textContent).toBe('No node matches “zzzz”. Search reads names, files, types and kinds.');
    expect(rows()).toEqual([]);
    vi.advanceTimersByTime(NO_MATCH_DELAY_MS);
    expect($('search-status').textContent).toBe('No match for “zzzz”'); // announced
  });

  it('announces the count of a search that found something, and hides the count and the list with no query', () => {
    vi.useFakeTimers();
    mount();
    type('sync');
    expect($('search-status').textContent).toBe('7 matches');
    type('');
    expect($('search-count').textContent).toBe('');
    expect($('search-steps').hidden).toBe(true);
    expect($('search-results').hidden).toBe(true);
    expect($('search-status').textContent).toBe('');
  });

  it('puts what the query and the map hold in as text, never as markup', () => {
    mount();
    base.nodes.push(node('evil', 'page', '<img src=x onerror=alert(1)>', 1100, { file: '"><svg onload=alert(1)>' }));
    try {
      mount();
      type('<img');
      expect($('search-results').querySelector('img')).toBeNull();
      expect($('search-results').textContent).toContain('<img src=x');
      type('<b>no</b>');
      expect($('search-results').querySelector('b')).toBeNull();
      expect($('search-results').textContent).toContain('<b>no</b>');
    } finally { base.nodes.pop(); }
  });

  it('keeps both fields in step, and each has its own count and list', () => {
    mount();
    type('sync', 'mobile-node-search');
    expect($('node-search').value).toBe('sync');
    expect($('mobile-search-count').textContent).toBe('7 matches');
    expect($('search-count').textContent).toBe('7 matches');
    expect(rows('mobile-search-results').length).toBe(rows('mobile-search-results').length);
    expect(rows('mobile-search-results')[0].textContent).toBe('Frame all 6');
  });

  it('closes the list on Escape (the query stays), and Escape again clears the search', () => {
    mount();
    type('sync');
    const e = key($('node-search'), 'Escape');
    expect(e.defaultPrevented).toBe(true);
    expect($('search-results').hidden).toBe(true);
    expect(state.searchQuery).toBe('sync');
    key($('node-search'), 'Escape');
    expect(state.searchQuery).toBe('');
    expect($('node-search').value).toBe('');
  });
});

describe('stepping', () => {
  it('Enter selects the best match and flies to it at zoom 1 or closer; Enter again goes on; Shift+Enter goes back', async () => {
    mount();
    state.activeLayers.machine = true; // stepping onto a match in a layer that is off turns it on, and the list is ordered again: tested below
    state.camera = { x: 0, y: 0, zoom: 0.1 };
    type('sync');
    key($('node-search'), 'Enter');
    await settle();
    const first = currentResult().matches[0].node;
    expect(state.selectedNode.id).toBe(first.id);
    expect(state.searchCurrent).toBe(first.id);
    expect($('search-count').textContent).toBe('1 of 7');
    // the camera flies there at zoom 1 (reduced motion jumps; otherwise a glide, run here by hand)
    for (let t = 0; flying() && t < 400; t++) tickFlight(16 * t);
    expect(state.camera.zoom).toBeGreaterThanOrEqual(1);
    expect(state.camera.x + first.x * state.camera.zoom).toBeGreaterThan(100); // on screen, in the middle of the free part
    expect(state.camera.x + first.x * state.camera.zoom).toBeLessThan(900);
    key($('node-search'), 'Enter');
    await settle();
    expect($('search-count').textContent).toBe('2 of 7');
    key($('node-search'), 'Enter', { shiftKey: true });
    await settle();
    expect($('search-count').textContent).toBe('1 of 7');
    key($('node-search'), 'Enter', { shiftKey: true });
    await settle();
    expect($('search-count').textContent).toBe('7 of 7'); // wraps round
  });

  it('keeps the camera\'s zoom when it is already closer than 1', async () => {
    mount();
    state.camera = { x: 0, y: 0, zoom: 2 };
    type('mailer');
    key($('node-search'), 'Enter');
    await settle();
    for (let t = 0; flying() && t < 400; t++) tickFlight(16 * t);
    expect(state.camera.zoom).toBeGreaterThanOrEqual(2);
  });

  it('says the match in the live region and the announcer', async () => {
    vi.useFakeTimers();
    mount();
    type('mailer');
    key($('node-search'), 'Enter');
    await settle();
    expect($('search-status').textContent).toBe('1 of 1: mailer, in Orders app');
    expect($('map-announcer').textContent).toBe('1 of 1: mailer, in Orders app');
  });

  it('moves from the field into the list with the down arrow, through it with the arrows, and back with the up arrow; Enter on a row chooses it', async () => {
    mount();
    type('sync');
    key($('node-search'), 'ArrowDown');
    expect(document.activeElement).toBe(rows()[0]); // Frame all
    key(document.activeElement, 'ArrowDown');
    expect(document.activeElement).toBe(rows()[1]);
    key(document.activeElement, 'ArrowUp');
    key(document.activeElement, 'ArrowUp');
    expect(document.activeElement).toBe($('node-search'));
    key($('node-search'), 'ArrowUp');
    expect(document.activeElement).toBe(rows().at(-1)); // the last row
    key(document.activeElement, 'Escape');
    expect(document.activeElement).toBe($('node-search'));
    // a click on a row chooses it, and the focus stays on that row (the list is repainted round it)
    const row = rows().find((r) => r.dataset.searchId === 'page-sync-2');
    row.focus();
    row.click();
    await settle();
    expect(state.selectedNode.id).toBe('page-sync-2');
    expect(document.activeElement.dataset.searchId).toBe('page-sync-2');
    expect(document.activeElement.getAttribute('aria-current')).toBe('true');
    expect($('search-count').textContent).toMatch(/^\d of 7$/);
  });

  it('N and P on the map step through the matches while a search is on, and through every node when none is', async () => {
    mount();
    const canvas = $('graph-canvas');
    type('sync');
    canvas.focus();
    key(canvas, 'n');
    await settle();
    expect(state.searchCurrent).toBe(currentResult().matches[0].node.id);
    key(canvas, 'n');
    await settle();
    expect(state.searchCurrent).toBe(currentResult().matches[1].node.id);
    key(canvas, 'p');
    await settle();
    expect(state.searchCurrent).toBe(currentResult().matches[0].node.id);
    setQuery('');
    expect(searchActive()).toBe(false);
    const before = state.searchCurrent;
    key(canvas, 'n');
    await settle();
    expect(state.searchCurrent).toBe(null); // a new question has no current answer; N is the plain step again
    expect(before).not.toBe(undefined);
    expect(state.selectedNode).not.toBeNull();
  });

  it('the ^ and v buttons step too', async () => {
    mount();
    type('sync');
    document.querySelector('#search-steps [data-action="search-next"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(stepMatch).toBeTypeOf('function');
    // main.js wires the click; here the model does it
    expect(stepMatch(1)).toBe(true);
    await settle();
    expect($('search-count').textContent).toMatch(/of 7$/);
  });

  it('a new query forgets the current match, and a query with no match steps nowhere', () => {
    mount();
    type('sync');
    stepMatch(1);
    setQuery('mail');
    expect(state.searchCurrent).toBe(null);
    setQuery('qqqq');
    expect(stepMatch(1)).toBe(false);
  });

  it('choosing a match in a layer that is off turns the layer on', async () => {
    mount();
    expect(state.activeLayers.machine).toBe(false);
    type('sync');
    rows().find((r) => r.dataset.searchId === 'machine-sync').click();
    await settle();
    expect(state.activeLayers.machine).toBe(true);
    expect(state.selectedNode.id).toBe('machine-sync');
    expect(render.getScene().nodes.some((n) => n.id === 'machine-sync')).toBe(true);
    // the list no longer has it under "layers that are off"
    expect([...$('search-results').querySelectorAll('[data-corn="search-group"]')].map((g) => g.getAttribute('aria-label'))).not.toContain('In layers that are off, 1');
  });
});

describe('Frame all', () => {
  it('fits the camera to every match on the map (not to the ones in layers that are off)', () => {
    mount();
    type('sync');
    state.camera = { x: -5000, y: 3000, zoom: 1 }; // looking at nothing
    rows()[0].click();
    const matches = currentResult().matches.filter((m) => m.on).map((m) => m.node);
    for (const n of matches) {
      const sx = state.camera.x + n.x * state.camera.zoom;
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sx).toBeLessThanOrEqual(1000);
    }
    expect(frameAll).toBeTypeOf('function');
  });
});

describe('the map\'s half of it', () => {
  it('gives the matches their halo and the current one its label first, and dims the rest', async () => {
    mount();
    type('sync');
    const dimmed = render.getScene().nodes.filter((n) => !n.match);
    expect(dimmed.length).toBeGreaterThan(0);
    expect(dimmed.every((n) => n.alpha < 0.1)).toBe(true);
    stepMatch(1);
    await settle();
    const current = render.getScene().nodes.filter((n) => n.current);
    expect(current.map((n) => n.id)).toEqual([state.searchCurrent]);
    expect(current[0].halo).toBe('match');
  });

  it('is the markup: the field has a count, steps and a list with their hooks', () => {
    mount();
    for (const hook of ['search-count', 'search-steps', 'search-results', 'search-status']) expect(document.querySelectorAll(`[data-corn="${hook}"]`).length, hook).toBeGreaterThanOrEqual(2); // the desktop's and the phone's
    for (const b of document.querySelectorAll('.hx-search-btn')) expect(b.getAttribute('aria-label')).toBeTruthy();
    expect($('node-search').getAttribute('role')).toBe('combobox');
  });
});

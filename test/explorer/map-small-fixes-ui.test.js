// @vitest-environment happy-dom
/**
 * Small map fixes of the 0.34 design review, through the page's own markup: the Layers menu has a row for every node
 * type on the map and its chip counts layers only (F59); the service panel's Kind value does not repeat the
 * description (F60); a search with no match says so by the field, politely (F24).
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
import { LAYER_DEFS, renderLayerToggles, toggleLayer } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode, closeDrawer } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { updateSearchStatus, NO_MATCH_DELAY_MS } from '../../explorer/search-status.js';

import { explorerCss } from './stylesheets.js';
const page = fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');

const node = (id, type, extra = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, ...extra });
const base = {
  nodes: [
    node('root', 'root'), node('app-a', 'app'), node('core-a', 'core'), node('store-a', 'store'), node('rom-a', 'rom'), node('table-a', 'table'),
    node('weird-a', 'gizmo'), // a type no row is defined for
    node('svc-a', 'service', { kind: 'hook', summary: 'Takes the payment webhook.', desc: 'Takes the payment webhook. A hook service (apps/api/hook.js).', file: 'apps/api/hook.js' }),
    node('svc-b', 'service', { kind: 'job', summary: 'Runs nightly.', desc: 'A job service.', file: 'apps/api/job.js' }),
  ],
  edges: [{ from: 'root', to: 'app-a' }, { from: 'app-a', to: 'svc-a' }, { from: 'app-a', to: 'svc-b' }, { from: 'root', to: 'store-a' }, { from: 'store-a', to: 'table-a' }],
};

const $ = (id) => document.getElementById(id);

function mount() {
  document.body.innerHTML = body;
  const ctx = new Proxy({}, { get: (_t, key) => (key === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = $('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, proposal: null, view: 'orbit', selectedNode: null, live: null, house: null, scenario: null, runsMap: null });
  for (const l of LAYER_DEFS) state.activeLayers[l.key] = !['stack', 'machine', 'container', 'device', 'house', 'persona'].includes(l.key);
  state.baseNodes = base.nodes.map((n) => ({ ...n }));
  state.baseEdges = base.edges;
  render.resize();
  setMap(state.baseNodes.map((n) => ({ ...n })), state.baseEdges);
  renderLayerToggles();
}

const row = (key) => document.querySelector(`[data-action="toggle-layer"][data-layer="${key}"]`);
afterEach(() => { closeDrawer(); document.body.innerHTML = ''; });

describe('the Layers menu (F59)', () => {
  it('has a row for every node type on the map: core and store, and a type it has no row defined for', () => {
    mount();
    for (const key of ['app', 'core', 'store', 'rom', 'table', 'service', 'gizmo']) expect(row(key), key).not.toBeNull();
    expect(row('core').querySelector('.hx-count').textContent).toBe('1');
    expect(row('store').querySelector('.hx-count').textContent).toBe('1');
    expect(row('gizmo').querySelector('.hx-count').textContent).toBe('1');
    expect(row('root')).toBeNull(); // the root is always shown
  });

  it('puts a type it has no row for in as text, never as markup', () => {
    base.nodes.push(node('odd-a', '"><img src=x onerror=alert(1)>'));
    try {
      mount();
      expect(document.querySelector('#layer-toggles-container img')).toBeNull();
      expect(document.querySelector('#layer-toggles-container').textContent).toContain('<img');
    } finally { base.nodes.pop(); }
  });

  it('hides core and stores with their own rows', () => {
    mount();
    const ids = () => render.getScene().nodes.map((n) => n.id);
    expect(ids()).toEqual(expect.arrayContaining(['core-a', 'store-a']));
    toggleLayer('store');
    expect(ids()).not.toContain('store-a');
    toggleLayer('store');
    toggleLayer('core');
    expect(ids()).not.toContain('core-a');
    toggleLayer('core');
    toggleLayer('gizmo');
    expect(ids()).not.toContain('weird-a');
    toggleLayer('gizmo');
  });

  it('counts layers only in the chip: the runs overlay is not one, and Data Flow counts links', () => {
    mount();
    const chip = () => $('layers-count').textContent;
    const defined = LAYER_DEFS.filter((l) => !l.overlay).length + 1; // + the one a plugin type adds
    const on = () => document.querySelectorAll('[data-action="toggle-layer"][aria-pressed="true"]').length;
    const m = /(\d+) of (\d+)/.exec(chip());
    expect(Number(m[2])).toBe(defined);
    expect(Number(m[1])).toBe(on() - (row('runs').getAttribute('aria-pressed') === 'true' ? 1 : 0));
    toggleLayer('runs');
    expect(/(\d+) of (\d+)/.exec(chip())[1]).toBe(m[1]); // switching the overlay does not move the chip
    toggleLayer('runs');
    expect(row('flow').querySelector('.hx-count').textContent).toMatch(/links?$/);
  });
});

describe('the service panel (F60)', () => {
  const fact = (name) => [...document.querySelectorAll('.hx-fact')].find((f) => f.querySelector('.hx-fact-k').textContent === name);

  it('says the kind in the badge and not in a row, and does not say again what the description says', async () => {
    mount();
    await selectNode(state.nodes.find((n) => n.id === 'svc-a'));
    expect($('drawer-description').textContent).toContain('Takes the payment webhook.');
    expect($('drawer-badge').textContent).toBe('Service · hook'); // spec 0009 D5: the Kind row is gone
    expect(fact('Kind')).toBeUndefined();
    expect(fact('Summary')).toBeUndefined(); // the description holds it
  });

  it('still shows a summary the description does not hold', async () => {
    mount();
    await selectNode(state.nodes.find((n) => n.id === 'svc-b'));
    expect(fact('Summary').textContent).toContain('Runs nightly.');
  });

  it('breaks the value at word boundaries only (the stylesheet says so)', () => {
    mount();
    const css = explorerCss();
    expect(css).toMatch(/\.hx-fact-v\s*\{[^}]*overflow-wrap:\s*break-word/);
    expect(css).toMatch(/\.hx-fact-v\s*\{[^}]*word-break:\s*normal/);
  });
});

describe('a search with no match (F24)', () => {
  afterEach(() => vi.useRealTimers());

  it('says so by the field, in a polite live region, and clears when there is a match or no query', () => {
    vi.useFakeTimers();
    mount();
    const status = $('search-status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect($('mobile-search-status').getAttribute('aria-live')).toBe('polite');
    expect(status.closest('.hx-search')).not.toBeNull();
    updateSearchStatus('zzzz', false);
    vi.advanceTimersByTime(NO_MATCH_DELAY_MS);
    expect(status.textContent).toBe('No match for “zzzz”');
    expect($('mobile-search-status').textContent).toBe('No match for “zzzz”');
    updateSearchStatus('app', true);
    expect(status.textContent).toBe('');
    updateSearchStatus('zzzz', false);
    vi.advanceTimersByTime(NO_MATCH_DELAY_MS);
    updateSearchStatus('', false);
    expect(status.textContent).toBe('');
  });

  it('changes the live region once while a no-match query is typed, not on every key', () => {
    vi.useFakeTimers();
    mount();
    const seen = [];
    const type = (q, found = false) => { updateSearchStatus(q, found); vi.advanceTimersByTime(80); seen.push($('search-status').textContent); };
    ['z', 'zz', 'zzq', 'zzqx', 'zzqxj'].forEach((q) => type(q));
    type('app', true); // a match in between clears at once and cancels the wait
    ['zz', 'zzq'].forEach((q) => type(q));
    expect(seen.every((t) => t === '')).toBe(true); // nothing read out while the keys come
    vi.advanceTimersByTime(NO_MATCH_DELAY_MS);
    expect($('search-status').textContent).toBe('No match for “zzq”');
  });

  it('puts the query in as text, never as markup', () => {
    vi.useFakeTimers();
    mount();
    updateSearchStatus('<img src=x onerror=alert(1)>', false);
    vi.advanceTimersByTime(NO_MATCH_DELAY_MS);
    expect($('search-status').querySelector('img')).toBeNull();
    expect($('search-status').textContent).toContain('<img');
  });
});

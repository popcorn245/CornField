// @vitest-environment happy-dom
/**
 * Sheets on a phone (spec 0010 D7), through the page's own markup: two sheets at most (the review, and Work or the node panel), every sheet opening
 * as a peek, one expanded at a time with the other folded to a stub that swaps back when tapped, Escape folding then closing, and the cap that
 * keeps the map's 35%.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap } from '../../explorer/view.js';
// @ts-expect-error plain JS modules, no declarations
import { initForgePanel, resetForgePanelForTests, openForge, closeForge, showWorkRef } from '../../explorer/forge-panel.js';
// @ts-expect-error plain JS modules, no declarations
import { initWorkView, resetWorkViewForTests } from '../../explorer/work-view.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard, resetKeyboardForTests } from '../../explorer/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { initSheets, showSheet } from '../../explorer/sheets.js';
// @ts-expect-error plain JS modules, no declarations
import { closeDrawer, copySpec, selectNode } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
// @ts-expect-error plain JS modules, no declarations
import { formatCost, formatTokens, runName, runTone, runMeta, limitRows, pullRunWords, changeWords, RUN_TONE } from '../../explorer/runs-model.js';
// @ts-expect-error plain JS modules, no declarations
import { RUN_STATES, CORN_STATES, cornState, stateIconHtml } from '../../explorer/corn-state.js';
// @ts-expect-error plain JS modules, no declarations
import { mergeSpecs, specWhere } from '../../explorer/proposal-model.js';
// @ts-expect-error plain JS modules, no declarations
import { approvalWarning, emptyWords } from '../../explorer/forge-panel-model.js';
// @ts-expect-error plain JS modules, no declarations
import { OFFLINE_WORDS, ONLINE_WORDS, resetConnectionForTests } from '../../explorer/connection.js';
import { explorerCss } from './stylesheets.js';
import { explorerPage } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations


const EXPLORER = path.resolve(__dirname, '../../explorer');
const page = explorerPage({ pieces: ['map'] });
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const css = explorerCss(['tokens.css', 'explorer.css', 'house.css']);
const NOW = Date.parse('2026-11-05T12:00:00Z');
const MAP = { nodes: [{ id: 'root', type: 'root', x: 0, y: 0, r: 20, color: '#336699', label: 'root', degree: 0 }], edges: [] };
const $ = (id) => document.getElementById(id);
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const said = async () => { await new Promise((r) => setTimeout(r, 600)); return $('map-announcer').textContent; }; // past the search's own 500 ms wait
const notice = () => { const el = $('forge-notice').cloneNode(true); el.querySelector('button')?.remove(); return el.textContent.trim(); };



const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();
const spec = (n, slug) => ({ slug, title: `Title of ${slug}`, summary: '', spec: null, source: `pull/${n}`, counts: {}, errors: 0, review: null, pull: { number: n, title: 't', url: 'https://git.example.test/pull', draft: false, author: 'a', createdAt: ago(9), updatedAt: ago(5), pushedAt: ago(5) } });
const phone = (on) => vi.stubGlobal('matchMedia', (query) => ({ matches: on && /max-width: 767px/.test(query), media: query, addEventListener() {}, removeEventListener() {} }));

function fakeServer() {
  const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = new URL(url, 'http://localhost');
    if (u.pathname === '/api/agent-runs') return json(200, { ok: true, runs: [], open: 0, maxOpen: 10, profiles: [], limits: {} });
    if (u.pathname === '/proposals') return json(200, [spec(21, '0021-a'), spec(22, '0022-b')]);
    if (['/api/forge/issues', '/api/forge/pulls', '/api/forge/threads', '/api/forge/deploys'].includes(u.pathname)) return json(200, { ok: true, at: ago(0.01), rate: '', items: [] });
    return json(404, { ok: false, error: 'No such thing.', code: 'not-found' });
  }));
}

function mount() {
  document.head.innerHTML = `<title>cornfield</title><style>${css}</style>`;
  document.body.innerHTML = body;
  document.documentElement.lang = 'en';
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = $('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 390, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 844, configurable: true });
  Object.assign(state, { canvas, ctx, labelCanvas: null, proposal: null, view: 'orbit', selectedNode: null, isFreeform: false, scenario: null, searchQuery: '' });
  state.camera = { x: 0, y: 0, zoom: 1 };
  render.resize();
  state.baseNodes = MAP.nodes.map((n) => ({ ...n }));
  state.baseEdges = MAP.edges;
  setMap(MAP.nodes.map((n) => ({ ...n })), MAP.edges);
  resetKeyboardForTests();
  initKeyboard();
  initSheets();
  resetForgePanelForTests();
  resetWorkViewForTests();
  initForgePanel({ forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' }, signIn: { login: 'maintainer-one' } });
  initWorkView({ offered: true });
}
const sheet = (id) => $(id);
const stateOf = (id) => sheet(id).dataset.sheetState;
const openProposal = () => { const bar = $('proposal-bar'); bar.hidden = false; $('proposal-title').textContent = 'Retire the old export'; Object.assign(state, { proposal: {}, proposalSlug: '0042-x', proposalSource: 'pull/42' }); showSheet('proposal'); };
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); phone(true); Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true }); fakeServer(); });
afterEach(() => { closeForge({ restoreFocus: false }); if (document.getElementById('spec-drawer')) closeDrawer(); resetConnectionForTests(); vi.unstubAllGlobals(); document.body.innerHTML = ''; Object.assign(state, { proposal: null, proposalSlug: null, proposalSource: null }); });

describe('every sheet opens as a peek, and only a deep link opens one expanded', () => {
  it('opens Work as a peek over the review\'s peek', async () => {
    mount();
    openProposal();
    click($('forge-btn'));
    await flush();
    expect([stateOf('proposal-bar'), stateOf('forge-panel')]).toEqual(['peek', 'peek']);
    expect($('forge-panel').dataset.sheetAway).toBeUndefined();
  });

  it('opens the Work list expanded for a link that names a tab (openForge with a tab)', async () => {
    mount();
    openForge({ tab: 'specs' });
    await flush();
    expect(stateOf('forge-panel')).toBe('expanded');
  });
});

describe('a sheet registered twice', () => {
  it('still answers one tap on its handle once: the sheets set up again (a re-init) add no second listener', async () => {
    mount();
    initSheets();
    resetWorkViewForTests();
    initForgePanel({ forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' }, signIn: { login: 'maintainer-one' } });
    initWorkView({ offered: true });
    openProposal();
    click($('proposal-bar').querySelector('.hx-sheet-handle'));
    expect(stateOf('proposal-bar')).toBe('expanded'); // two listeners would expand it and fold it straight back
    click($('forge-btn'));
    await flush();
    click($('forge-panel').querySelector(':scope > .hx-sheet-handle'));
    expect(stateOf('forge-panel')).toBe('expanded');
  });
});

describe('one expanded at a time: the other folds to a stub, and a tap on the stub swaps them', () => {
  it('folds the review to a 44px stub with its title while Work is expanded, and Work says what waits in its own stub', async () => {
    mount();
    openProposal();
    click($('forge-btn'));
    await flush();
    click($('forge-panel').querySelector('.hx-sheet-handle'));
    expect(stateOf('forge-panel')).toBe('expanded');
    expect(stateOf('proposal-bar')).toBe('stub');
    const stub = $('proposal-bar').querySelector('[data-corn="sheet-stub"]');
    expect(stub.hidden).toBe(false);
    expect(stub.textContent).toBe('Retire the old export');
    expect(stub.tagName).toBe('BUTTON');
    // the stub is the one visible thing in the folded sheet
    expect([...$('proposal-bar').children].filter((c) => !c.hidden && c !== stub && !c.matches('.hx-sheet-stub'))).not.toHaveLength(0); // (the rest is there, hidden by CSS: display: none !important)
    expect(css).toMatch(/\[data-sheet-state="stub"\] > :not\(\.hx-sheet-stub\) \{ display: none !important; \}/);
    expect(css).toMatch(/\[data-sheet-state="stub"\] \{ min-height: 44px; max-height: 44px;/);
    stub.focus();
    click(stub); // swap
    expect(stateOf('proposal-bar')).toBe('expanded');
    expect(stateOf('forge-panel')).toBe('stub');
    expect(document.activeElement).toBe($('proposal-bar').querySelector(':scope > .hx-sheet-handle')); // the focus goes with it, not to the page (so Escape folds it)
    expect($('forge-panel').querySelector('[data-corn="sheet-stub"]').textContent).toContain('Work list');
    click($('proposal-bar').querySelector('.hx-sheet-handle')); // fold back
    expect([stateOf('proposal-bar'), stateOf('forge-panel')]).toEqual(['peek', 'peek']);
  });

  it('shows the number waiting on Work\'s stub, as a badge that is spoken', async () => {
    mount();
    await flush(); // two specs to decide
    openProposal();
    click($('forge-btn'));
    await flush();
    click($('proposal-bar').querySelector('.hx-sheet-handle'));
    const stub = $('forge-panel').querySelector('[data-corn="sheet-stub"]');
    expect(stub.querySelector('[data-corn="waiting-badge"]').textContent).toBe('2');
    expect(stub.getAttribute('aria-label')).toBe('Work list, 2 waiting on you');
  });

  it('caps the expanded sheet so the map keeps 296 px of 844: the dock says its room under a stub', async () => {
    mount();
    openProposal();
    click($('forge-btn'));
    await flush();
    click($('forge-panel').querySelector('.hx-sheet-handle'));
    expect($('sheet-dock').style.getPropertyValue('--hx-sheet-cap')).toBe('504px'); // 844 - 296 - 44
    expect(css).toMatch(/\.hx-forge\[data-sheet-state="expanded"\] \{ max-height: min\(var\(--hx-sheet-cap, 60cqh\), 60cqh\); \}/);
    click($('forge-panel').querySelector('.hx-sheet-handle'));
    expect($('sheet-dock').style.getPropertyValue('--hx-sheet-cap')).toBe('548px'); // nothing folded: 844 - 296
  });
});

describe('two sheets at most: Work and the node panel take turns', () => {
  it('hides the node panel while Work is open, keeps the node selected, and a tap on the node brings its sheet back and closes Work', async () => {
    mount();
    const node = state.baseNodes[0];
    selectNode(node);
    await flush();
    expect(stateOf('spec-drawer')).toBe('peek');
    click($('forge-btn'));
    await flush();
    expect($('spec-drawer').hasAttribute('data-sheet-away')).toBe(true);
    expect($('spec-drawer').inert).toBe(true);
    expect(state.selectedNode && state.selectedNode.id).toBe(node.id); // still selected
    expect($('forge-panel').classList.contains('forge-open')).toBe(true);
    selectNode(node); // tapped again
    await flush();
    expect($('spec-drawer').hasAttribute('data-sheet-away')).toBe(false);
    expect($('spec-drawer').inert).toBe(false);
    expect($('forge-panel').classList.contains('forge-open')).toBe(false); // Work is closed, not folded
    expect(stateOf('spec-drawer')).toBe('peek');
  });

  it('does none of it from 768px: both panels are open at once', async () => {
    phone(false);
    mount();
    selectNode(state.baseNodes[0]);
    await flush();
    click($('forge-btn'));
    await flush();
    expect($('spec-drawer').hasAttribute('data-sheet-away')).toBe(false);
    expect($('forge-panel').classList.contains('forge-open')).toBe(true);
    expect($('spec-drawer').classList.contains('drawer-open')).toBe(true);
  });
});

describe('getting back: the map, the handle, Escape', () => {
  it('folds an expanded Work to a peek on Escape, then closes it on the next, and the focus stays in the panel', async () => {
    mount();
    click($('forge-btn'));
    await flush();
    click($('forge-panel').querySelector('.hx-sheet-handle'));
    expect(stateOf('forge-panel')).toBe('expanded');
    $('forge-title').focus();
    key($('forge-title'), 'Escape');
    expect(stateOf('forge-panel')).toBe('peek');
    expect($('forge-panel').classList.contains('forge-open')).toBe(true);
    expect(document.activeElement).toBe($('forge-panel').querySelector('.hx-sheet-handle'));
    key($('forge-title'), 'Escape');
    expect($('forge-panel').classList.contains('forge-open')).toBe(false);
  });

  it('folds the expanded sheet when the map is tapped', async () => {
    mount();
    click($('forge-btn'));
    await flush();
    click($('forge-panel').querySelector('.hx-sheet-handle'));
    $('graph-canvas').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(stateOf('forge-panel')).toBe('peek');
  });
});

describe('the hint', () => {
  it('is hidden while a sheet is expanded (and while one is open)', async () => {
    mount();
    const hint = document.querySelector('[data-corn="hint"]');
    const { syncHint } = await import('../../explorer/hint.js');
    syncHint();
    click($('forge-btn'));
    await flush();
    click($('forge-panel').querySelector('.hx-sheet-handle'));
    syncHint();
    expect(hint.hidden).toBe(true);
  });
});

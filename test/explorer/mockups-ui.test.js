// @vitest-environment happy-dom
/**
 * A proposal's mockups in a page (explorer/mockups.js, mockups-model.js): the section in a node's panel, the window one
 * opens in, and what keeps an untrusted mockup from running script: an `<img>` for pictures and SVG, an `<iframe>` with an
 * empty `sandbox` for HTML, an address built from the position and never the path, every title escaped. Driven through the
 * page's own markup (explorer/index.html) with a fake server behind `fetch`.
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
import { selectNode, closeDrawer } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard, resetKeyboardForTests } from '../../explorer/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { initProposals, openProposal, closeProposal } from '../../explorer/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { initWhatIf, resetWhatIfForTests } from '../../explorer/whatif.js';
// @ts-expect-error plain JS modules, no declarations
import { initMockups, resetMockupsForTests, refreshMockups, openMockup, closeMockup } from '../../explorer/mockups.js';
// @ts-expect-error plain JS modules, no declarations
import { mockupsFor, mockupsSectionHtml, mockupUrl, stateWords, typeOf } from '../../explorer/mockups-model.js';

const EXPLORER = path.resolve(__dirname, '../../explorer');
const page = fs.readFileSync(path.join(EXPLORER, 'index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const css = ['explorer.css', 'house.css'].map((f) => fs.readFileSync(path.join(EXPLORER, f), 'utf8')).join('\n');

const node = (id, type, x, y, extra = {}) => ({ id, type, x, y, r: 20, color: '#336699', label: id, degree: 1, ...extra });
const MAP = {
  nodes: [node('root', 'root', 0, 0), node('app-a', 'app', 200, 0), node('page-a', 'page', 300, 100, { label: '/orders' })],
  edges: [{ from: 'root', to: 'app-a' }, { from: 'app-a', to: 'page-a' }],
};
const EVIL = '<img src=x onerror="window.pwned=1">Evil "title"';
const MOCKUPS = [
  { node: 'page-new', path: 'screens/list.png', title: 'The meal list' },
  { node: 'page-new', path: 'screens/edit.html', title: 'The edit form' },
  { node: 'page-new', path: 'screens/flow.svg', title: EVIL },
  { node: 'app-a', path: '../../etc/passwd.png', title: 'Out of the folder' },
  { node: 'app-a', path: 'screens/app.webp', title: 'The app screen' },
];
const PROPOSAL = {
  version: 1, title: 'Meals', summary: 'Adds /meals.',
  nodes: { add: [{ id: 'page-new', label: '/meals', type: 'page', parent: 'app-a' }], change: [{ id: 'app-a', set: { desc: 'x' }, why: 'w' }] },
  mockups: MOCKUPS,
};

const $ = (id) => document.getElementById(id);
const key = (el, k, opts = {}) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }); el.dispatchEvent(e); return e; };
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const panelButtons = () => [...document.querySelectorAll('#drawer-meta-list [data-mockup]')];

let states = [];
let calls = [];

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

async function open() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = new URL(url, 'http://localhost');
    calls.push(u.pathname + u.search);
    const reply = (data, headers = {}) => ({ ok: true, status: 200, headers: new Headers(headers), json: async () => data });
    if (u.pathname === '/proposals') return reply([{ slug: '0013-meals', title: 'Meals', summary: 'Adds /meals.', source: 'checkout', counts: { added: 1, changed: 1, removed: 0, scenarios: 0 }, errors: 0 }]);
    if (u.pathname.endsWith('/review')) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
    if (u.pathname.endsWith('/mockups')) return reply(states);
    return reply(structuredClone(PROPOSAL), { 'X-Proposal-Source': 'checkout' });
  }));
  mount();
  window.happyDOM.settings.disableIframePageLoading = true; // the frame's address is the server's; nothing is fetched here (happy-dom still logs that it declined)
  resetWhatIfForTests();
  resetMockupsForTests();
  initWhatIf();
  initMockups();
  await initProposals();
  expect(await openProposal('0013-meals', 'checkout')).toBe(true);
  await settle();
}

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); states = []; calls = []; });
afterEach(() => { closeMockup(); resetMockupsForTests(); if ($('spec-drawer')) { closeProposal(); closeDrawer(); } vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('the model', () => {
  it('finds the mockups of a node, in the proposal\'s order, with their position, type and address', () => {
    const got = mockupsFor(PROPOSAL, '0013-meals', 'checkout', 'page-new', { 1: 'changed' });
    expect(got.map((m) => [m.index, m.type, m.state, m.url])).toEqual([
      [0, 'image', 'unreviewed', '/proposals/0013-meals/mockups/0?source=checkout'],
      [1, 'page', 'changed', '/proposals/0013-meals/mockups/1?source=checkout'],
      [2, 'image', 'unreviewed', '/proposals/0013-meals/mockups/2?source=checkout'],
    ]);
    expect(mockupsFor(PROPOSAL, '0013-meals', 'checkout', 'root')).toEqual([]);
    expect(mockupsFor(null, 'x', null, 'page-new')).toEqual([]);
    expect(mockupsFor(PROPOSAL, null, null, 'page-new')).toEqual([]);
  });

  it('never puts the path in the address, and leaves out a path that leaves the folder', () => {
    expect(JSON.stringify(mockupsFor(PROPOSAL, '0013-meals', 'checkout', 'app-a'))).not.toContain('passwd');
    expect(mockupsFor(PROPOSAL, '0013-meals', 'checkout', 'app-a').map((m) => m.index)).toEqual([4]);
    expect(mockupUrl('a b', 'pull/7', 3)).toBe('/proposals/a%20b/mockups/3?source=pull%2F7');
    expect(mockupUrl('a', null, 0)).toBe('/proposals/a/mockups/0');
  });

  it('says in words where a mockup stands, and what kind it is', () => {
    expect([stateWords('approved'), stateWords('changed'), stateWords('unreviewed'), stateWords('missing'), stateWords('odd')]).toEqual(['Reviewed', 'Changed since you approved', 'Not reviewed yet', 'File not found', 'Not reviewed yet']);
    expect([typeOf('a.html'), typeOf('a.HTML'), typeOf('a.svg'), typeOf('a.png')]).toEqual(['page', 'page', 'image', 'image']);
    expect(mockupsSectionHtml([])).toBe('');
  });

  it('escapes the title wherever it is written', () => {
    const html = mockupsSectionHtml(mockupsFor(PROPOSAL, '0013-meals', 'checkout', 'page-new'));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('in the node\'s panel', () => {
  it('lists a node\'s mockups as buttons, with where each stands, and none for a node without', async () => {
    states = [{ index: 0, state: 'approved' }, { index: 1, state: 'changed' }];
    await open();
    await selectNode(state.nodes.find((n) => n.id === 'page-new'));
    expect(panelButtons().map((b) => b.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    const section = document.querySelector('#drawer-meta-list [data-mockups]');
    expect(section.textContent).toContain('Reviewed');
    expect(section.textContent).toContain('Changed since you approved');
    expect(section.textContent).toContain('Not reviewed yet');
    expect(calls).toContain('/proposals/0013-meals/mockups?source=checkout');
    await selectNode(state.nodes.find((n) => n.id === 'root'));
    expect(panelButtons()).toEqual([]);
  });

  it('shows no section without a proposal, and the title as text only', async () => {
    await open();
    await selectNode(state.nodes.find((n) => n.id === 'page-new'));
    expect(document.querySelector('#drawer-meta-list img')).toBe(null);
    expect(panelButtons()[2].textContent).toContain(EVIL);
    expect(window.pwned).toBeUndefined();
    closeProposal();
    await selectNode(state.nodes.find((n) => n.id === 'app-a'));
    expect(panelButtons()).toEqual([]);
  });

  it('puts the section under the proposal\'s own, for a node the proposal changes', async () => {
    await open();
    await selectNode(state.nodes.find((n) => n.id === 'app-a'));
    const list = document.querySelector('#drawer-meta-list');
    expect(list.firstElementChild.hasAttribute('data-proposal-mark')).toBe(true);
    expect(list.children[1].hasAttribute('data-mockups')).toBe(true);
    expect(panelButtons().map((b) => b.dataset.mockup)).toEqual(['4']);
  });

  it('is repainted when the review says a mockup changed, keeping the focus where it was', async () => {
    states = [{ index: 0, state: 'approved' }];
    await open();
    await selectNode(state.nodes.find((n) => n.id === 'page-new'));
    panelButtons()[0].focus();
    states = [{ index: 0, state: 'changed' }];
    await refreshMockups();
    expect(document.querySelector('#drawer-meta-list [data-mockups]').textContent).toContain('Changed since you approved');
    expect(document.activeElement).toBe(panelButtons()[0]);
  });
});

describe('the window', () => {
  const dialog = () => document.querySelector('.hx-mockup-dialog[role="dialog"]');

  it('shows a picture in an <img> with the title as its alt text, from an address made of the position', async () => {
    await open();
    await selectNode(state.nodes.find((n) => n.id === 'page-new'));
    panelButtons()[0].click();
    const img = dialog().querySelector('img');
    expect(img.getAttribute('alt')).toBe('The meal list');
    expect(img.getAttribute('src')).toBe('/proposals/0013-meals/mockups/0?source=checkout');
    expect(dialog().querySelector('iframe, object, embed, script')).toBe(null);
    expect(dialog().getAttribute('role')).toBe('dialog');
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')).textContent).toBe('The meal list');
  });

  it('shows an SVG as an image too, never inline, an object or a frame; a hostile title stays text', async () => {
    await open();
    await selectNode(state.nodes.find((n) => n.id === 'page-new'));
    panelButtons()[2].click();
    expect(dialog().querySelector('img').getAttribute('src')).toBe('/proposals/0013-meals/mockups/2?source=checkout');
    expect(dialog().querySelector('iframe, object, embed, svg, script')).toBe(null);
    expect(dialog().querySelectorAll('img')).toHaveLength(1);
    expect(dialog().querySelector('#mockup-title').textContent).toBe(EVIL);
    expect(dialog().querySelector('img').getAttribute('alt')).toBe(EVIL);
    expect(window.pwned).toBeUndefined();
  });

  it('shows HTML in an iframe whose sandbox is empty: no scripts, no same-origin, no forms, no popups', async () => {
    await open();
    await selectNode(state.nodes.find((n) => n.id === 'page-new'));
    panelButtons()[1].click();
    const frame = dialog().querySelector('iframe');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.sandbox.length).toBe(0);
    expect(frame.getAttribute('title')).toBe('The edit form');
    expect(frame.getAttribute('src')).toBe('/proposals/0013-meals/mockups/1?source=checkout');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    expect(frame.outerHTML).not.toMatch(/allow-/);
    expect(dialog().querySelector('img')).toBe(null);
  });

  it('takes the focus, says what opened, and gives the focus back on Escape without closing the panel', async () => {
    await open();
    await selectNode(state.nodes.find((n) => n.id === 'page-new'));
    const opener = panelButtons()[0];
    opener.focus();
    opener.click();
    expect(document.activeElement).toBe(dialog());
    expect($('map-announcer').textContent).toBe('Mockup: The meal list. Not reviewed yet. Escape closes it.');
    const e = key(document.activeElement, 'Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(dialog()).toBe(null);
    expect(document.activeElement).toBe(opener);
    expect($('map-announcer').textContent).toBe('Mockup closed');
    expect(state.selectedNode.id).toBe('page-new'); // Escape closed the window only
    expect($('spec-drawer').inert).toBe(false);
  });

  it('keeps Tab inside, round and round, and Close shuts it', async () => {
    await open();
    await selectNode(state.nodes.find((n) => n.id === 'page-new'));
    const opener = panelButtons()[1];
    opener.click();
    const close = dialog().querySelector('[data-mockup-close]');
    const frame = dialog().querySelector('iframe');
    key(document.activeElement, 'Tab');
    expect(document.activeElement).toBe(close);
    key(close, 'Tab');
    expect(document.activeElement).toBe(frame);
    key(frame, 'Tab');
    expect(document.activeElement).toBe(close);
    key(close, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(frame);
    close.click();
    expect(dialog()).toBe(null);
    expect(document.activeElement).toBe(opener);
  });

  it('opens one at a time, refuses a position the proposal does not list, and goes when the proposal closes', async () => {
    await open();
    await selectNode(state.nodes.find((n) => n.id === 'page-new'));
    panelButtons()[0].click();
    panelButtons()[1].click();
    expect(document.querySelectorAll('.hx-mockup-dialog[role="dialog"]')).toHaveLength(1);
    expect(dialog().querySelector('iframe')).not.toBe(null);
    expect(openMockup(3, null)).toBe(false); // out of the folder: not offered
    expect(openMockup(99, null)).toBe(false);
    expect(openMockup(-1, null)).toBe(false);
    closeProposal();
    expect(dialog()).toBe(null);
    expect(state.mockupStates).toEqual({});
  });
});

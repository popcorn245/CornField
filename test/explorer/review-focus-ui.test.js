// @vitest-environment happy-dom
/**
 * Opening a proposal narrows the map to the change (issue #232), through the page's own markup: the layers the proposal does not touch are hidden
 * for the review and come back exactly when it closes (nothing in the viewer's saved choices moves), the Layers menu says which rows the review hid
 * and still works by hand, "Show the whole map" is a real switch that is announced, a scenario turns on what its steps need and gives it back,
 * and a deep link, a second proposal and Before / After behave.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap } from '../../explorer/view.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { initProposals, openProposal, closeProposal, setProposalView } from '../../explorer/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { initReviewColumn, resetReviewColumnForTests } from '../../explorer/review-column.js';
// @ts-expect-error plain JS modules, no declarations
import { setProjectLayers, toggleLayer, toggleAllLayers, renderLayerToggles } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { isNodeVisible } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { GREY_LABEL_ALPHA } from '../../explorer/diff-marks.js';
// @ts-expect-error plain JS modules, no declarations
import { initScenarioUi, playScenario, stopScenario, clearScenario } from '../../explorer/scenario-ui.js';
// @ts-expect-error plain JS modules, no declarations
import { initSearch, setQuery, stepMatch, resetSearchForTests } from '../../explorer/search.js';

const page = fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');

const node = (id, type, extra = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, ...extra });
const base = {
  nodes: [
    node('root', 'root'), node('app-a', 'app'), node('page-old', 'page'), node('page-keep', 'page'), node('table-t', 'table'),
    node('svc-s', 'service'), node('tool-t', 'tool'), node('ext-x', 'external', { kind: 'cloud' }),
  ],
  edges: [{ from: 'root', to: 'app-a' }, { from: 'app-a', to: 'page-old' }, { from: 'app-a', to: 'page-keep' }, { from: 'page-old', to: 'table-t', kind: 'reads', status: 'live' }, { from: 'svc-s', to: 'ext-x', kind: 'calls', status: 'live' }],
};
/** Changes one page and adds one beside it: only the Pages layer is touched */
const small = { version: 1, title: 'Small', summary: 'One page.', nodes: { change: [{ id: 'page-old', set: { desc: 'new' }, why: 'w' }], add: [{ id: 'page-new', label: '/new', type: 'page', parent: 'app-a' }] } };
/** Touches a page, a table (an edge's end) and a service */
const wide = { version: 1, title: 'Wide', summary: 'A few.', nodes: { change: [{ id: 'page-old', set: { desc: 'x' }, why: 'w' }, { id: 'svc-s', set: { desc: 'x' }, why: 'w' }] }, edges: { add: [{ from: 'page-keep', to: 'table-t', kind: 'writes' }] } };
/** Touches every layer on the map */
const everything = { version: 1, title: 'Everything', summary: 'All.', nodes: { change: base.nodes.filter((n) => n.type !== 'root').map((n) => ({ id: n.id, set: { desc: 'x' }, why: 'w' })) } };
/** Changes only an edge: its two ends' layers stay */
const edgeOnly = { version: 1, title: 'Edge', summary: 'An edge.', edges: { add: [{ from: 'page-keep', to: 'svc-s', kind: 'calls' }] } };

const LISTING = [];
function fakeHub(files) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = new URL(url, 'http://localhost');
    if (u.pathname === '/proposals') return { ok: true, status: 200, headers: new Headers(), json: async () => LISTING };
    const m = /^\/proposals\/(.+)\.json$/.exec(u.pathname);
    const file = m && files[m[1]];
    if (!file) return { ok: false, status: 404, headers: new Headers(), json: async () => ({ error: 'No such proposal' }) };
    return { ok: true, status: 200, headers: new Headers({ 'X-Proposal-Source': 'checkout' }), json: async () => structuredClone(file) };
  }));
}

const $ = (id) => document.getElementById(id);
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const row = (key) => document.querySelector(`[data-action="toggle-layer"][data-layer="${key}"]`);
const whole = () => $('proposal-whole');
const said = async () => { await new Promise((r) => setTimeout(r, 50)); return $('map-announcer').textContent; };
const visible = () => state.nodes.filter((n) => isNodeVisible(state, n)).map((n) => n.id).sort();
const drawn = () => render.getScene().nodes.map((n) => n.id).sort();
const STORE = 'cornfield:layers';

async function mount(search = '', saved = null) {
  localStorage.clear();
  if (saved !== null) localStorage.setItem(STORE, saved);
  resetReviewColumnForTests();
  document.body.innerHTML = body;
  const ctx = new Proxy({}, { get: (_t, key) => (key === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = document.getElementById('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, proposal: null, review: null, proposalView: 'diff', proposalErrors: [], view: 'orbit', selectedNode: null, scenario: null, runsMap: null });
  state.baseNodes = base.nodes.map((n) => ({ ...n }));
  state.baseEdges = base.edges;
  render.resize();
  setMap(state.baseNodes.map((n) => ({ ...n })), state.baseEdges);
  setProjectLayers(undefined); // the viewer's saved choices are read here
  history.replaceState(null, '', `/${search}`);
  initReviewColumn();
  initScenarioUi();
  return initProposals();
}

beforeEach(() => { vi.stubGlobal('requestAnimationFrame', () => 0); });
afterEach(() => { clearScenario(); vi.unstubAllGlobals(); document.body.innerHTML = ''; localStorage.clear(); setProjectLayers(undefined); });

describe('opening a proposal narrows the map to the change', () => {
  it('hides the layers the proposal does not touch, draws what it touches, and says so once', async () => {
    fakeHub({ small });
    await mount();
    expect(visible()).toEqual(['app-a', 'ext-x', 'page-keep', 'page-old', 'root', 'svc-s', 'table-t', 'tool-t']);
    await openProposal('small');
    expect(state.review).toMatchObject({ whole: false });
    expect(visible()).toEqual(['app-a', 'page-keep', 'page-new', 'page-old', 'root']); // the Pages layer and the Apps layer (the added page's ownership edge ends there), and the root
    expect(drawn()).toEqual(visible());
    const line = await said();
    expect(line).toMatch(/^Opened Small: .* Showing 2 of \d+ layers: the ones this proposal changes\.$/);
    // not on every redraw
    $('map-announcer').textContent = '';
    render.render();
    setProposalView('after');
    expect(await said()).toBe('After view');
  });

  it('greys what is on screen and not involved, and only that', async () => {
    fakeHub({ small });
    await mount();
    await openProposal('small');
    const by = (id) => render.getScene().nodes.find((n) => n.id === id);
    expect(by('page-keep').greyed).toBe(true);
    expect(by('page-old').greyed).toBeUndefined();
    expect(by('page-new').greyed).toBeUndefined();
  });

  it('a greyed node\'s label recedes: a cluster\'s title is plain and at the least size, at the dimmed-label opacity, and not asked for', async () => {
    fakeHub({ wide });
    await mount();
    await openProposal('wide');
    if (!isNodeVisible(state, state.nodes.find((n) => n.id === 'app-a'))) toggleLayer('app'); // on by hand, for the review
    const app = render.getScene().nodes.find((n) => n.id === 'app-a');
    expect(app.greyed).toBe(true);
    expect(app).toMatchObject({ labelBold: false, labelSize: 11, labelKeep: false, labelAlpha: GREY_LABEL_ALPHA[state.theme === 'light' ? 'light' : 'dark'] });
    expect(GREY_LABEL_ALPHA).toEqual({ light: 0.6, dark: 0.5 }); // 4.4:1 on the default light ground, 5.2:1 on the dark: at or near the dimmed-label floor
    click(whole()); // the whole map: Diff as it always was, a cluster's title bold again
    expect(render.getScene().nodes.find((n) => n.id === 'app-a')).toMatchObject({ labelBold: true, labelSize: 12 });
  });

  it('hides nothing and says nothing of hiding when the proposal touches every layer', async () => {
    fakeHub({ everything });
    await mount();
    await openProposal('everything');
    expect(visible()).toEqual(['app-a', 'ext-x', 'page-keep', 'page-old', 'root', 'svc-s', 'table-t', 'tool-t']);
    expect(await said()).not.toMatch(/layers/);
    expect(document.querySelectorAll('[data-corn="layer-note"]').length).toBe(0);
  });

  it('an edge-only change keeps the layers of its two ends', async () => {
    fakeHub({ edgeOnly });
    await mount();
    await openProposal('edgeOnly');
    expect(visible()).toEqual(['page-keep', 'page-old', 'root', 'svc-s']);
  });

  it('a layer the viewer had turned off that the proposal touches comes on for the review and goes off again on close', async () => {
    fakeHub({ wide });
    await mount('', JSON.stringify({ service: false, table: false }));
    expect(state.activeLayers.service).toBe(false);
    await openProposal('wide');
    expect(visible()).toContain('svc-s');
    expect(visible()).toContain('table-t');
    closeProposal();
    expect(state.activeLayers.service).toBe(false);
    expect(visible()).not.toContain('svc-s');
  });

  it('a deep link that opens a proposal directly gets the same review', async () => {
    fakeHub({ small });
    await mount('?proposal=small');
    await new Promise((r) => setTimeout(r, 20));
    expect(state.proposal).not.toBeNull();
    expect(visible()).toEqual(['app-a', 'page-keep', 'page-new', 'page-old', 'root']);
  });

  it('opening a second proposal while one is open starts a fresh review: what was turned on by hand is forgotten, the switch is off', async () => {
    fakeHub({ small, wide });
    await mount();
    await openProposal('small');
    toggleLayer('tool', { viewer: true });
    click(whole());
    expect(state.review.whole).toBe(true);
    await openProposal('wide');
    expect(state.review.whole).toBe(false);
    expect(state.review.manual).toEqual({});
    expect(whole().getAttribute('aria-pressed')).toBe('false');
    expect(visible()).not.toContain('tool-t');
    expect(visible()).toContain('svc-s');
  });

  it('the same layers are hidden in Before and After as in Diff, and what the keyboard walks is what is visible', async () => {
    fakeHub({ small });
    await mount();
    await openProposal('small');
    const diff = visible();
    setProposalView('before');
    expect(visible().filter((id) => id !== 'page-new')).toEqual(diff.filter((id) => id !== 'page-new'));
    expect(state.nodes.filter((n) => isNodeVisible(state, n)).every((n) => ['app-a', 'page-keep', 'page-old', 'root'].includes(n.id))).toBe(true);
    setProposalView('after');
    expect(visible()).toEqual(diff);
  });
});

describe('the layout does not move when layers are hidden', () => {
  it('every node the proposal did not add keeps its place through opening, hiding, the whole map, a hand toggle and closing', async () => {
    fakeHub({ small });
    await mount();
    const at = () => Object.fromEntries(state.nodes.filter((n) => n.id !== 'page-new').map((n) => [n.id, [n.x, n.y, n.r]]));
    const plain = at();
    await openProposal('small');
    expect(at()).toEqual(plain);
    click(whole());
    expect(at()).toEqual(plain);
    click(whole());
    toggleLayer('tool', { viewer: true });
    expect(at()).toEqual(plain);
    closeProposal();
    expect(at()).toEqual(plain);
  });

  it('the camera frames the change as it did: the same framing with the whole map on and off (the layers only change what is drawn)', async () => {
    fakeHub({ small });
    await mount();
    await openProposal('small');
    const cam = { ...state.camera };
    click(whole());
    expect(state.camera).toEqual(cam);
    click(whole());
    expect(state.camera).toEqual(cam);
  });
});

describe('closing restores the viewer\'s layers exactly, and writes nothing', () => {
  it('leaves state.activeLayers and the saved choices byte for byte as they were, through a whole review with manual toggles, All and None', async () => {
    fakeHub({ small });
    const saved = JSON.stringify({ app: false, 'odd-one': true, tool: false });
    await mount('', saved);
    const layersBefore = JSON.stringify(state.activeLayers);
    const visibleBefore = visible();
    const rowsBefore = [...document.querySelectorAll('[data-action="toggle-layer"]')].map((r) => `${r.dataset.layer}:${r.getAttribute('aria-pressed')}`);
    await openProposal('small');
    toggleLayer('service', { viewer: true });
    toggleLayer('page', { viewer: true });
    toggleAllLayers(false, { viewer: true });
    toggleAllLayers(true, { viewer: true });
    toggleLayer('table', { viewer: true });
    click(whole());
    click(whole());
    expect(localStorage.getItem(STORE)).toBe(saved);
    expect(JSON.stringify(state.activeLayers)).toBe(layersBefore);
    closeProposal();
    expect(state.review).toBeNull();
    expect(localStorage.getItem(STORE)).toBe(saved);
    expect(JSON.stringify(state.activeLayers)).toBe(layersBefore);
    expect([...document.querySelectorAll('[data-action="toggle-layer"]')].map((r) => `${r.dataset.layer}:${r.getAttribute('aria-pressed')}`)).toEqual(rowsBefore);
    expect(visible()).toEqual(visibleBefore);
  });

  it('writes nothing even when the viewer had nothing saved', async () => {
    fakeHub({ small });
    await mount();
    expect(localStorage.getItem(STORE)).toBeNull();
    await openProposal('small');
    toggleLayer('tool', { viewer: true });
    toggleLayer('page', { viewer: true });
    expect(localStorage.getItem(STORE)).toBeNull();
    closeProposal();
    expect(localStorage.getItem(STORE)).toBeNull();
    expect(state.activeLayers.page).toBe(true);
  });

  it('a toggle after closing is the viewer\'s again and is kept', async () => {
    fakeHub({ small });
    await mount();
    await openProposal('small');
    closeProposal();
    toggleLayer('tool', { viewer: true });
    expect(JSON.parse(localStorage.getItem(STORE))).toEqual({ tool: false });
  });
});

describe('the Layers menu during a review', () => {
  it('says which rows the review hid, keeps them operable, and turning one on is for the review only', async () => {
    fakeHub({ small });
    await mount();
    await openProposal('small');
    const note = (key) => row(key).querySelector('[data-corn="layer-note"]');
    expect(note('service').textContent).toBe('hidden while reviewing');
    expect(row('service').getAttribute('aria-pressed')).toBe('false');
    expect(note('page')).toBeNull();
    expect(document.querySelector('#layers-count').textContent).toMatch(/^ · 2 of /);
    toggleLayer('service', { viewer: true }); // what a click on the row does (main.js)
    expect(row('service').getAttribute('aria-pressed')).toBe('true');
    expect(note('service')).toBeNull();
    expect(visible()).toContain('svc-s');
    expect(document.querySelector('#layers-count').textContent).toMatch(/^ · 3 of /);
    expect(localStorage.getItem(STORE)).toBeNull();
    expect(state.activeLayers.service).not.toBe(false);
  });

  it('search still finds a node on a layer the review hid, and choosing it turns that layer on for the review only', async () => {
    fakeHub({ small });
    await mount('', JSON.stringify({ tool: false }));
    initSearch();
    resetSearchForTests();
    const saved = localStorage.getItem(STORE);
    const mine = JSON.stringify(state.activeLayers);
    await openProposal('small');
    const svc = state.nodes.find((n) => n.id === 'svc-s');
    expect(isNodeVisible(state, svc)).toBe(false);
    setQuery('svc-s');
    expect(stepMatch(1)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(isNodeVisible(state, svc)).toBe(true);
    expect(state.review.manual.service).toBe(true);
    expect(localStorage.getItem(STORE)).toBe(saved);
    expect(JSON.stringify(state.activeLayers)).toBe(mine);
    setQuery('');
    closeProposal();
    expect(isNodeVisible(state, svc)).toBe(true); // the viewer had Services on
    expect(localStorage.getItem(STORE)).toBe(saved);
  });

  it('All and None act on the review, not on the viewer', async () => {
    fakeHub({ small });
    await mount();
    await openProposal('small');
    toggleAllLayers(true, { viewer: true });
    expect(visible()).toContain('svc-s');
    expect(document.querySelector('#layers-count').textContent).toMatch(/^ · (\d+) of \1$/);
    toggleAllLayers(false, { viewer: true });
    expect(visible()).toEqual(['app-a', 'page-new', 'page-old', 'root']); // the change's own nodes (and the ends of its edges) are always drawn
    expect(state.activeLayers.page).toBe(true);
  });
});

describe('"Show the whole map"', () => {
  it('is a real toggle button in the proposal bar, off at every opening, with a hook and its words', async () => {
    fakeHub({ small });
    await mount();
    await openProposal('small');
    const b = whole();
    expect(b.tagName).toBe('BUTTON');
    expect(b.getAttribute('type')).toBe('button');
    expect(b.getAttribute('aria-pressed')).toBe('false');
    expect(b.getAttribute('data-corn')).toBe('whole-map');
    expect(b.closest('.hx-proposal-tools')).not.toBeNull();
    expect(b.textContent).toBe('Whole map'); // short words that read right pressed or not; the name and the tooltip say it in full
    expect(b.getAttribute('aria-label')).toBe('Show the whole map');
    expect(b.getAttribute('title')).toBe('Show the whole map');
  });

  it('brings back today\'s Diff: every layer the viewer has on, dimmed and coloured, announced; off narrows again; survives Before, Diff and After', async () => {
    fakeHub({ small });
    await mount();
    await openProposal('small');
    click(whole());
    expect(whole().getAttribute('aria-pressed')).toBe('true');
    expect(await said()).toBe('Showing the whole map.');
    expect(visible()).toEqual(['app-a', 'ext-x', 'page-keep', 'page-new', 'page-old', 'root', 'svc-s', 'table-t', 'tool-t']);
    expect(render.getScene().nodes.some((n) => n.greyed)).toBe(false);
    expect(render.getScene().nodes.find((n) => n.id === 'svc-s').alpha).toBeLessThan(1); // dimmed, as Diff always did
    setProposalView('before');
    setProposalView('after');
    setProposalView('diff');
    expect(whole().getAttribute('aria-pressed')).toBe('true');
    expect(visible()).toContain('svc-s');
    click(whole());
    expect(whole().getAttribute('aria-pressed')).toBe('false');
    expect(await said()).toMatch(/^Showing 2 of \d+ layers/);
    expect(visible()).not.toContain('svc-s');
  });

  it('keeps the focus on the switch', async () => {
    fakeHub({ small });
    await mount();
    await openProposal('small');
    whole().focus();
    click(whole());
    expect(document.activeElement).toBe(whole());
  });
});

describe('scenarios', () => {
  const scenario = { id: 's', title: 'Reads', stepMs: 1000, steps: [{ node: 'page-old', text: 'Opens.' }, { node: 'svc-s', text: 'The service answers.' }] };
  it('playing one turns on the layers its steps need and says so; stopping returns to the focused view', async () => {
    fakeHub({ small });
    await mount();
    await openProposal('small');
    expect(visible()).not.toContain('svc-s');
    playScenario(scenario, { autoplay: false });
    expect(visible()).toContain('svc-s');
    expect(await said()).toBe('Turned on Services to show this scenario\'s steps.');
    expect(state.activeLayers.service).not.toBe(false); // the viewer's own state: never written
    expect(localStorage.getItem(STORE)).toBeNull();
    stopScenario();
    expect(visible()).not.toContain('svc-s');
    expect(row('service').getAttribute('aria-pressed')).toBe('false');
  });

  it('a layer the reviewer turned on by hand stays on when a scenario stops', async () => {
    fakeHub({ small });
    await mount();
    await openProposal('small');
    toggleLayer('service', { viewer: true });
    playScenario(scenario, { autoplay: false });
    stopScenario();
    expect(visible()).toContain('svc-s');
  });
});

describe('the House and Flow views draw their own sets', () => {
  it('the Flow view\'s nodes are what the flow holds, whatever the review hid', async () => {
    fakeHub({ small });
    await mount();
    await openProposal('small');
    state.view = 'dataflow';
    state.flow = { ids: new Set(['svc-s', 'page-old']), edges: [], headers: [], top: 0 };
    expect(isNodeVisible(state, state.nodes.find((n) => n.id === 'svc-s'))).toBe(true);
    expect(isNodeVisible(state, state.nodes.find((n) => n.id === 'tool-t'))).toBe(false);
    state.view = 'orbit';
    state.flow = null;
  });
});

describe('the menu is plain text', () => {
  it('writes the hidden note as text and keeps the row\'s label', async () => {
    fakeHub({ small });
    await mount();
    await openProposal('small');
    renderLayerToggles();
    expect(row('service').textContent).toContain('hidden while reviewing');
    expect(row('service').textContent).toContain('Services');
  });
});

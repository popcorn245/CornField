// @vitest-environment happy-dom
/**
 * The proposal picker, the Before / Diff / After control, the counts chip, the problems list, the
 * panel and Close (TOPO-09), driven through the page's own markup (explorer/index.html) with a
 * fake hub behind `fetch` and a recording canvas, so what a click does to the state and the DOM
 * is what is read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap, setView } from '../../explorer/view.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { initProposals, openProposal, closeProposal, setProposalView, loadProposalList, markedEdgeAt, problemsHtml, showEdgePanel } from '../../explorer/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode, closeDrawer } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { initSheets, sheetState, measureCovered } from '../../explorer/sheets.js';

const page = fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page) [1].replace(/<script[\s\S]*?<\/script>/g, '');

const node = (id        , type        , extra         = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, ...extra });
const base = {
  nodes: [node('root', 'root'), node('app-a', 'app', { desc: 'old words' }), node('page-old', 'page'), node('page-keep', 'page'), node('table-t', 'table')],
  edges: [
    { from: 'root', to: 'app-a' }, { from: 'app-a', to: 'page-old' }, { from: 'app-a', to: 'page-keep' },
    { from: 'page-old', to: 'table-t', kind: 'reads', keys: ['a'], status: 'live', label: 'renders rows' },
  ],
};
const good = {
  version: 1, spec: '0013', title: 'Meals', summary: 'Adds /meals.',
  nodes: {
    add: [{ id: 'page-new', label: '/meals', type: 'page', parent: 'app-a', desc: 'planner' }],
    change: [{ id: 'app-a', set: { desc: 'new words' }, why: 'mentions meals' }],
    remove: [{ id: 'page-old', why: 'replaced by /meals' }],
  },
  edges: { add: [{ from: 'page-new', to: 'table-t', kind: 'writes', label: 'meals.add' }] },
};
const invalid = { version: 1, title: 'Bad', summary: 's', nodes: { add: [{ id: 'app-a', label: 'again', type: 'page' }, { id: 'page-x', label: 'x', type: 'nonsense' }] } };

const LISTING = [
  { slug: '0013-meals', title: 'Meals', summary: 'Adds /meals.', spec: '0013', source: 'topo-09', counts: { added: 2, changed: 1, removed: 1, scenarios: 0 }, errors: 0 },
  { slug: '0013-meals', title: 'Meals', summary: 'Adds /meals.', spec: '0013', source: 'checkout', counts: { added: 2, changed: 1, removed: 1, scenarios: 0 }, errors: 0 },
  { slug: '0014-bad', title: 'Bad', summary: 's', spec: null, source: 'checkout', counts: { added: 2, changed: 0, removed: 0, scenarios: 0 }, errors: 2 },
  { slug: '0015-garbled', title: '0015-garbled', summary: '', spec: null, source: 'checkout', counts: null, errors: null, error: 'Not valid JSON: Unexpected token' },
];

/** A fake hub: the listing, and each proposal by "slug@source" (or by slug alone) */
function fakeHub(listing          , files                        ) {
  const calls           = [];
  const fetchMock = vi.fn(async (url        ) => {
    calls.push(url);
    const u = new URL(url, 'http://localhost');
    if (u.pathname === '/proposals') return { ok: true, status: 200, headers: new Headers(), json: async () => listing };
    const m = /^\/proposals\/(.+)\.json$/.exec(u.pathname);
    const source = u.searchParams.get('source');
    const file = m && (files[`${m[1]}@${source}`] || (!source && files[m[1]]));
    if (!file) return { ok: false, status: 404, headers: new Headers(), json: async () => ({ error: 'No such proposal' }) };
    return { ok: true, status: 200, headers: new Headers({ 'X-Proposal-Source': source || 'checkout' }), json: async () => structuredClone(file) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const $ = (id        ) => document.getElementById(id)               ;
const click = (el         ) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const seg = (view        ) => document.querySelector(`[data-action="proposal-view"][data-view="${view}"]`)               ;
const settle = () => new Promise((r) => setTimeout(r, 0));
const ids = () => render.getScene().nodes.map((n     ) => n.id);

let started = false;
/** Where the plain map put each base node (x, y, r), before any proposal */
let plainAt                           = {};
async function mount(search = '') {
  document.body.innerHTML = body;
  const ctx      = new Proxy({}, { get: (_t, key        ) => (key === 'measureText' ? (t        ) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas      = document.getElementById('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  state.canvas = canvas;
  state.ctx = ctx;
  state.proposal = null;
  state.proposalView = 'diff';
  state.proposalErrors = [];
  state.view = 'orbit';
  state.selectedNode = null;
  state.baseNodes = base.nodes.map((n) => ({ ...n }));
  state.baseEdges = base.edges;
  render.resize();
  setMap(state.baseNodes.map((n     ) => ({ ...n })), state.baseEdges);
  plainAt = Object.fromEntries(state.nodes.map((n     ) => [n.id, [n.x, n.y, n.r]]));
  history.replaceState(null, '', `/${search}`);
  const ok = await initProposals();
  started = true;
  return ok;
}

beforeEach(() => { started = false; });
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('the picker', () => {
  it('says "No proposals" when the hub lists none', async () => {
    fakeHub([], {});
    await mount();
    click($('proposal-btn'));
    await settle();
    expect($('proposal-menu').hidden).toBe(false);
    expect($('proposal-menu').textContent).toContain('No proposals');
    expect($('proposal-btn').getAttribute('aria-expanded')).toBe('true');
  });

  it('lists what the hub returns, worktree copy first, with counts, where it is and its problems', async () => {
    fakeHub(LISTING, {});
    await mount();
    click($('proposal-btn'));
    await settle();
    const rows = [...document.querySelectorAll('.hx-proposal-item')]                 ;
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain('In worktree topo-09');
    expect(rows[0].textContent).toContain('2 added · 1 changed · 1 removed');
    expect(rows[1].textContent).toContain('In the checkout');
    expect(rows[2].textContent).toContain('2 problems');
    expect(rows[0].dataset.source).toBe('topo-09');
  });

  it('names the spec PR of a proposal, and says plainly why the PRs are missing when the forge could not be asked', async () => {
    const pull = { number: 23, title: 'Meals proposal', url: 'https://forge.example/pull/23', draft: true, author: 'agent-four' };
    const entry = { slug: '0013-meals', title: 'Meals', summary: 's', spec: '0013', source: 'pull/23', counts: { added: 1, changed: 0, removed: 0 }, errors: 0, review: null, pull };
    const said = 'GitHub did not accept the sign-in; sign in again.';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'X-Proposals-Forge-Error': encodeURIComponent(said) }), json: async () => [entry] })));
    await mount();
    click($('proposal-btn'));
    await settle();
    const rows = [...document.querySelectorAll('.hx-proposal-item')]                 ;
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Spec PR #23 (draft) by agent-four');
    expect(rows[0].dataset.source).toBe('pull/23');
    expect($('proposal-menu').textContent).toContain(`The spec PRs could not be listed: ${said}`);
  });

  it('lists a file that does not parse, with its error, and cannot be opened', async () => {
    fakeHub(LISTING, {});
    await mount();
    click($('proposal-btn'));
    await settle();
    const broken = document.querySelector('.hx-proposal-item.is-broken')               ;
    expect(broken.textContent).toContain('Not valid JSON');
    expect(broken.tagName).not.toBe('BUTTON');
    expect(broken.dataset.action).toBeUndefined();
  });

  it('says so when the list cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, headers: new Headers(), json: async () => ({}) })));
    await mount();
    await loadProposalList();
    click($('proposal-btn'));
    await settle();
    expect($('proposal-menu').textContent).toContain('could not be loaded');
  });

  it('closes again on a second click, on Escape and on a click elsewhere', async () => {
    fakeHub(LISTING, {});
    await mount();
    click($('proposal-btn')); await settle();
    click($('proposal-btn')); await settle();
    expect($('proposal-menu').hidden).toBe(true);
    click($('proposal-btn')); await settle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect($('proposal-menu').hidden).toBe(true);
    click($('proposal-btn')); await settle();
    click(document.body);
    expect($('proposal-menu').hidden).toBe(true);
  });

  it('opens the proposal that is clicked, from the place it was listed', async () => {
    const hub = fakeHub(LISTING, { '0013-meals@topo-09': good });
    await mount();
    click($('proposal-btn'));
    await settle();
    click(document.querySelector('[data-slug="0013-meals"][data-source="topo-09"]') );
    await settle();
    expect(hub.calls).toContain('/proposals/0013-meals.json?source=topo-09');
    expect(state.proposal.title).toBe('Meals');
    expect(state.proposalSource).toBe('topo-09');
    expect($('proposal-menu').hidden).toBe(true);
    expect(location.search).toBe('?proposal=0013-meals&source=topo-09');
  });
});

describe('/?proposal=<slug>', () => {
  it('opens that proposal straight away, in Diff', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    expect(await mount('?proposal=0013-meals')).toBe(true);
    expect(state.proposal.title).toBe('Meals');
    expect(state.proposalView).toBe('diff');
    expect($('proposal-bar').hidden).toBe(false);
  });

  it('takes &source= and &proposalView=', async () => {
    const hub = fakeHub(LISTING, { '0013-meals@topo-09': good });
    await mount('?proposal=0013-meals&source=topo-09&proposalView=after');
    expect(hub.calls[0]).toBe('/proposals/0013-meals.json?source=topo-09');
    expect(state.proposalView).toBe('after');
  });

  it('does nothing without it', async () => {
    const hub = fakeHub(LISTING, {});
    expect(await mount('?view=dataflow')).toBe(false);
    expect(hub.calls).toEqual([]);
    expect(state.proposal).toBeNull();
    expect($('proposal-bar').hidden).toBe(true);
  });

  it('says so, in the bar, when there is no such proposal, and leaves the map alone', async () => {
    fakeHub(LISTING, {});
    expect(await mount('?proposal=nope')).toBe(false);
    expect($('proposal-bar').hidden).toBe(false);
    expect($('proposal-message').textContent).toContain('No proposal called nope');
    expect($('proposal-body').hidden).toBe(true);
    expect(state.proposal).toBeNull();
    expect(state.nodes).toHaveLength(base.nodes.length);
  });

  it('ignores a slug that cannot be a file name without asking the hub', async () => {
    const hub = fakeHub(LISTING, {});
    expect(await mount('?proposal=../../etc/passwd')).toBe(false);
    expect(hub.calls).toEqual([]);
  });
});

describe('the bar', () => {
  it('shows the title, the summary and the counts chip', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    expect($('proposal-title').textContent).toBe('Meals');
    expect($('proposal-summary').textContent).toBe('Adds /meals.');
    expect($('proposal-chip').textContent).toBe('2 added · 1 changed · 1 removed');
  });

  it('has Before, Diff and After, with Diff pressed first, and each click switches the picture and the pressed button', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    expect([...document.querySelectorAll('.hx-seg-btn')].map((b) => b.textContent)).toEqual(['Before', 'Diff', 'After']);
    const pressed = () => [...document.querySelectorAll('.hx-seg-btn')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
    expect(pressed()).toEqual(['Diff']);
    expect(ids()).toEqual(['root', 'app-a', 'page-old', 'page-keep', 'table-t', 'page-new']);

    click(seg('before'));
    expect(pressed()).toEqual(['Before']);
    expect(state.proposalView).toBe('before');
    expect(ids()).toEqual(['root', 'app-a', 'page-old', 'page-keep', 'table-t']);

    click(seg('after'));
    expect(pressed()).toEqual(['After']);
    expect(ids()).toEqual(['root', 'app-a', 'page-keep', 'table-t', 'page-new']);

    click(seg('diff'));
    expect(pressed()).toEqual(['Diff']);
    expect(render.getScene().nodes.find((n     ) => n.id === 'page-new').mark).toBe('added');
  });

  it('never moves a node when the view changes', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    const at = () => Object.fromEntries(state.nodes.map((n     ) => [n.id, [n.x, n.y, n.r]]));
    const diff = at();
    click(seg('before')); expect(at()).toEqual(diff);
    click(seg('after')); expect(at()).toEqual(diff);
  });

  it('puts the added node beside its parent and leaves the others where the plain map has them', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    const laid = new Map(state.nodes.map((n     ) => [n.id, n]));
    const added      = laid.get('page-new');
    const parent      = laid.get('app-a');
    expect(Math.hypot(added.x - parent.x, added.y - parent.y)).toBeLessThan(260);
    expect(added.x === 0 && added.y === 0).toBe(false);
    // every node that was on the map keeps the place and size the plain map gave it
    for (const id of Object.keys(plainAt)) {
      const n      = laid.get(id);
      expect([n.x, n.y, n.r], id).toEqual(plainAt[id]);
    }
    // and closing the proposal gives the plain layout back exactly
    closeProposal();
    for (const n of state.nodes) expect([n.x, n.y, n.r], n.id).toEqual(plainAt[n.id]);
  });

  it('lists a proposal\'s problems and still shows what it can', async () => {
    fakeHub(LISTING, { '0014-bad': invalid });
    await mount('?proposal=0014-bad');
    expect($('proposal-errors').hidden).toBe(false);
    expect($('proposal-errors-count').textContent).toMatch(/\d+ problems? in this proposal/);
    expect($('proposal-errors-list').children.length).toBeGreaterThanOrEqual(2);
    expect($('proposal-errors-list').textContent).toContain('nodes.add[0]');
    expect(ids()).toContain('page-x'); // an unknown type is still drawn
    expect(ids()).toContain('app-a');
  });

  it('shows no problem list for a proposal that validates', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    expect($('proposal-errors').hidden).toBe(true);
  });

  it('shows no problem list for a proposal whose build has landed, and still draws it', async () => {
    // page-keep and app-a are on the map already, as the proposal adds them: a landing, not a mistake
    const landed = { version: 1, title: 'Landed', summary: 's', nodes: { add: [{ id: 'page-keep', label: '/keep', type: 'page', parent: 'app-a' }] } };
    fakeHub([{ ...LISTING[0], slug: '0016-landed' }], { '0016-landed': landed });
    await mount('?proposal=0016-landed');
    expect($('proposal-errors').hidden).toBe(true);
    expect(ids()).toContain('page-keep');
  });

  it('cuts a long list of problems short', () => {
    const errors = Array.from({ length: 12 }, (_, i) => ({ path: `p[${i}]`, message: `bad ${i}` }));
    const html = problemsHtml(errors);
    expect((html.match(/<li/g) || []).length).toBe(9);
    expect(html).toContain('and 4 more');
  });

  it('lists every change behind the chip, and picks one', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    expect($('proposal-changes').hidden).toBe(true);
    click($('proposal-chip'));
    expect($('proposal-changes').hidden).toBe(false);
    const rows = [...document.querySelectorAll('.hx-change-row')]                 ;
    expect(rows).toHaveLength(4); // 1 added node + 1 added edge + 1 changed + 1 removed; the ownership edge is a consequence
    expect(rows.map((r) => r.querySelector('.hx-change-what') .textContent)).toEqual(['Added', 'Added', 'Changed', 'Removed']);
    click(rows[0]);
    await settle();
    expect(state.selectedNode.id).toBe('page-new');
  });

  it('shows the four marks in the legend while a proposal is open, and not otherwise', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    expect($('proposal-legend').hidden).toBe(false);
    expect(document.querySelectorAll('#proposal-legend .hx-mark-dot')).toHaveLength(4);
    closeProposal();
    expect($('proposal-legend').hidden).toBe(true);
  });
});

describe('the data-flow view', () => {
  it('lays out and draws the proposal there too, and comes back to the orbit with nothing moved', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    const orbit = Object.fromEntries(state.nodes.map((n     ) => [n.id, [n.x, n.y, n.r]]));
    setView('dataflow');
    expect(state.view).toBe('dataflow');
    expect(Number.isFinite(render.getScene().decor.lanes.length)).toBe(true);
    setView('orbit');
    for (const n of state.nodes) expect([n.x, n.y, n.r], n.id).toEqual(orbit[n.id]);
  });
});

describe('Close', () => {
  it('returns to the plain map: the base nodes and edges, no marks, no bar, no address', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals&proposalView=after');
    expect(state.nodes).toHaveLength(base.nodes.length + 1);
    click(document.querySelector('[data-action="close-proposal"]') );
    expect(state.proposal).toBeNull();
    expect(state.nodes.map((n     ) => n.id)).toEqual(base.nodes.map((n) => n.id));
    expect(state.edges).toBe(state.baseEdges);
    expect(state.nodes.every((n     ) => n.mark === undefined)).toBe(true);
    expect($('proposal-bar').hidden).toBe(true);
    expect(location.search).toBe('');
    const scene = render.getScene();
    expect(scene.nodes.every((n     ) => n.mark === 'none' && n.alpha === 1)).toBe(true);
  });

  it('leaves the base untouched however long the proposal was open', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    click(seg('before')); click(seg('after'));
    closeProposal();
    expect(state.baseNodes.every((n     ) => n.mark === undefined && !('before' in n))).toBe(true);
    expect(state.baseNodes.find((n     ) => n.id === 'app-a').desc).toBe('old words');
    expect(state.baseNodes).toHaveLength(base.nodes.length);
  });

  it('keeps other address parameters, and Before / After in the address when they are not the default', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?fixture=5k&proposal=0013-meals');
    expect(location.search).toBe('?fixture=5k&proposal=0013-meals');
    click(seg('after'));
    expect(location.search).toBe('?fixture=5k&proposal=0013-meals&proposalView=after');
    closeProposal();
    expect(location.search).toBe('?fixture=5k');
  });

  it('can open another proposal after one was closed', async () => {
    fakeHub(LISTING, { '0013-meals': good, '0014-bad': invalid });
    await mount('?proposal=0013-meals');
    closeProposal();
    expect(await openProposal('0014-bad')).toBe(true);
    expect(state.proposal.title).toBe('Bad');
  });
});

describe('the panel', () => {
  it('shows why a node changed and each changed field before and after', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    await selectNode(state.nodes.find((n     ) => n.id === 'app-a'));
    const meta = $('drawer-meta-list');
    expect(meta.textContent).toContain('Changed by this proposal');
    expect(meta.textContent).toContain('mentions meals');
    const row = meta.querySelector('.hx-change') ;
    expect(row.querySelector('.hx-change-field') .textContent).toBe('desc');
    expect(row.querySelector('.hx-change-before') .textContent).toBe('old words');
    expect(row.querySelector('.hx-change-after') .textContent).toBe('new words');
    expect($('spec-drawer').classList.contains('drawer-open')).toBe(true);
  });

  it('shows why an added or removed node is there', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    await selectNode(state.nodes.find((n     ) => n.id === 'page-old'));
    expect($('drawer-meta-list').textContent).toContain('replaced by /meals');
    await selectNode(state.nodes.find((n     ) => n.id === 'page-new'));
    expect($('drawer-meta-list').textContent).toContain('Added by this proposal');
    expect($('drawer-meta-list').textContent).toContain('planner');
  });

  it('shows nothing of the proposal for a node it does not touch, nor with no proposal open', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    await selectNode(state.nodes.find((n     ) => n.id === 'page-keep'));
    expect($('drawer-meta-list').textContent).not.toContain('this proposal');
    closeProposal();
    await selectNode(state.nodes.find((n     ) => n.id === 'app-a'));
    expect($('drawer-meta-list').textContent).not.toContain('this proposal');
  });

  it('closes the panel when its node is not in the view that was picked', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    await selectNode(state.nodes.find((n     ) => n.id === 'page-new'));
    click(seg('before'));
    expect(state.selectedNode).toBeNull();
    expect($('spec-drawer').classList.contains('drawer-open')).toBe(false);
  });
});

describe('marked edges', () => {
  it('finds a marked edge near a point, and no edge that is not marked', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    const e = render.getScene().edges.find((x     ) => x.mark === 'added' && x.kind === 'writes');
    const mid = { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 };
    const hit = markedEdgeAt(e.curve ? e.curve.cx / 2 + (e.x1 + e.x2) / 4 : mid.x, e.curve ? e.curve.cy / 2 + (e.y1 + e.y2) / 4 : mid.y, 6);
    expect(hit && hit.kind).toBe('writes');
    expect(hit.why).toBeUndefined(); // an addition has no reason of its own
    expect(markedEdgeAt(99999, 99999, 6)).toBeNull();
    // a point on an unmarked edge picks nothing, or a marked edge that crosses it, never the unmarked one
    for (const plain of render.getScene().edges.filter((x     ) => x.mark === 'none')) {
      const hit = markedEdgeAt((plain.x1 + plain.x2) / 2, (plain.y1 + plain.y2) / 2, 0.5);
      expect(hit === null || hit.mark !== 'none').toBe(true);
    }
  });

  it('opens a marked edge in the panel: what it joins, why it is there and its fields', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    showEdgePanel(state.edges.find((e     ) => e.kind === 'writes'));
    expect($('drawer-title').textContent).toBe('/meals → table-t');
    expect($('drawer-badge').textContent).toBe('EDGE');
    expect($('drawer-meta-list').textContent).toContain('Added by this proposal');
    expect($('drawer-meta-list').textContent).toContain('meals.add');
    expect($('drawer-props-list').textContent).toContain('writes');
    expect($('spec-drawer').classList.contains('drawer-open')).toBe(true);
    expect(state.selectedEdge.kind).toBe('writes');
    expect(state.selectedNode).toBeNull();
    // picking a node afterwards drops the edge
    await selectNode(state.nodes.find((n     ) => n.id === 'app-a'));
    expect(state.selectedEdge).toBeNull();
  });

  it('has none in the Before view', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    setProposalView('before');
    expect(render.getScene().edges.every((e     ) => e.mark === 'none')).toBe(true);
  });
});

describe('scene', () => {
  it('is not rebuilt for a view change that changes nothing, and is for one that does', async () => {
    fakeHub(LISTING, { '0013-meals': good });
    await mount('?proposal=0013-meals');
    render.renderNow(); // the first picture builds the scene
    const before = render.sceneBuilds();
    setProposalView('diff'); // already Diff
    render.renderNow();
    expect(render.sceneBuilds()).toBe(before);
    setProposalView('after');
    render.renderNow();
    expect(render.sceneBuilds()).toBe(before + 1);
  });

  it('keeps the plain scene exactly as buildScene makes it with no proposal', async () => {
    fakeHub(LISTING, {});
    await mount();
    expect(started).toBe(true);
    const direct = buildScene(state);
    expect(render.getScene().nodes).toEqual(direct.nodes);
  });
});

// ---------------------------------------------------------------------------
//  On a phone the bar and the panel are bottom sheets (TOPO-18)
// ---------------------------------------------------------------------------
describe('on a phone: bottom sheets', () => {
  const phone = (on = true) => {
    vi.stubGlobal('matchMedia', (query        ) => ({ matches: on && query.includes('767px'), addEventListener() {}, removeEventListener() {} }));
    (window       ).matchMedia = (globalThis       ).matchMedia;
  };
  const handle = (id        ) => document.querySelector(`#${id} .hx-sheet-handle`)               ;
  const mountSheets = async (search = '?proposal=0013-meals') => {
    phone();
    fakeHub(LISTING, { '0013-meals': good });
    await mount(search);
    initSheets();
    state.coveredBottom = 0;
  };
  afterEach(() => { state.coveredBottom = 0; });

  it('puts the proposal bar and the node panel in the dock, each a peek with a handle', async () => {
    await mountSheets();
    expect($('proposal-bar').parentElement .id).toBe('sheet-dock');
    expect($('spec-drawer').parentElement .id).toBe('sheet-dock');
    expect($('proposal-bar').dataset.sheetState).toBe('peek');
    expect($('spec-drawer').dataset.sheetState).toBe('peek');
    expect(handle('proposal-bar').getAttribute('aria-expanded')).toBe('false');
    expect(handle('spec-drawer')).not.toBeNull();
  });

  it('expands the bar on its handle and folds it on the next tap, on a tap on the map, and when the proposal closes', async () => {
    await mountSheets();
    handle('proposal-bar').click();
    expect($('proposal-bar').dataset.sheetState).toBe('expanded');
    handle('proposal-bar').click();
    expect($('proposal-bar').dataset.sheetState).toBe('peek');
    handle('proposal-bar').click();
    state.canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect($('proposal-bar').dataset.sheetState).toBe('peek');
    handle('proposal-bar').click();
    click(document.querySelector('[data-action="close-proposal"]') );
    expect(sheetState('proposal')).toBe('peek'); // the next proposal opens as a peek again
  });

  it('expands on a tap on the counts in the peek instead of opening the list, and opens the list when expanded', async () => {
    await mountSheets();
    click($('proposal-chip'));
    expect($('proposal-bar').dataset.sheetState).toBe('expanded');
    expect($('proposal-changes').hidden).toBe(true);
    click($('proposal-chip'));
    expect($('proposal-changes').hidden).toBe(false);
  });

  it('still closes the proposal from the peek', async () => {
    await mountSheets();
    click(document.querySelector('[data-action="close-proposal"]') );
    expect(state.proposal).toBeNull();
  });

  it('opens the node panel as a peek, expands it on its handle and folds the bar: one at a time', async () => {
    await mountSheets();
    handle('proposal-bar').click();
    await selectNode(state.nodes.find((n     ) => n.id === 'app-a'));
    expect($('spec-drawer').classList.contains('drawer-open')).toBe(true);
    expect($('spec-drawer').dataset.sheetState).toBe('peek');
    expect(sheetState('proposal')).toBe('expanded'); // opening a peek folds nothing
    handle('spec-drawer').click();
    expect($('spec-drawer').dataset.sheetState).toBe('expanded');
    expect(sheetState('proposal')).toBe('peek');
    expect(state.canvas.parentElement .dataset.sheetOpen).toBe('drawer');
  });

  it('folds an expanded panel to its peek when the dim layer is tapped, and keeps the node selected', async () => {
    await mountSheets();
    await selectNode(state.nodes.find((n     ) => n.id === 'app-a'));
    handle('spec-drawer').click();
    click($('drawer-backdrop'));
    expect($('spec-drawer').classList.contains('drawer-open')).toBe(true);
    expect($('spec-drawer').dataset.sheetState).toBe('peek');
    expect(state.selectedNode.id).toBe('app-a');
  });

  it('lets Close through from a peek, and the next node opens as a peek again once the panel is closed', async () => {
    await mountSheets();
    const reached           = [];
    const seen = (e       ) => { const a = (e.target           ).closest('[data-action]')                      ; if (a) reached.push(a.dataset.action ); };
    document.addEventListener('click', seen);
    await selectNode(state.nodes.find((n     ) => n.id === 'app-a'));
    click(document.querySelector('#spec-drawer [data-action="close-drawer"]') );
    click(document.querySelector('#spec-drawer [data-action="copy-spec"]') ); // anything else on a peek only expands it
    document.removeEventListener('click', seen);
    expect(reached).toEqual(['close-drawer']);
    expect($('spec-drawer').dataset.sheetState).toBe('expanded');
    closeDrawer(); // what the Close button does (main.js)
    expect($('spec-drawer').classList.contains('drawer-open')).toBe(false);
    expect(sheetState('drawer')).toBe('peek');
    await selectNode(state.nodes.find((n     ) => n.id === 'app-a'));
    expect($('spec-drawer').dataset.sheetState).toBe('peek');
  });

  it('expands the panel on a tap on its peek title rather than closing it: only Close closes', async () => {
    await mountSheets();
    await selectNode(state.nodes.find((n     ) => n.id === 'app-a'));
    $('drawer-title').click();
    expect($('spec-drawer').dataset.sheetState).toBe('expanded');
    expect($('spec-drawer').classList.contains('drawer-open')).toBe(true);
  });

  it('leaves the desktop alone: a wide window has no covered height, however the sheets are set', async () => {
    await mountSheets();
    phone(false);
    Object.defineProperty($('sheet-dock'), 'offsetHeight', { value: 250, configurable: true });
    expect(measureCovered()).toBe(0);
    expect(state.coveredBottom).toBe(0);
    handle('proposal-bar').click(); // the handle is hidden by the CSS here; a stray tap changes no layout
    expect(measureCovered()).toBe(0);
  });
});

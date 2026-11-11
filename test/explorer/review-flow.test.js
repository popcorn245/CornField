// @vitest-environment happy-dom
/**
 * The review flow, from the 0.34 design review (F06 to F21): where the camera goes when a proposal opens and when a change is
 * picked, which copy the bar says it is, where focus goes after an action, what a bad link offers, and the phone rules (the player's
 * controls, the note above the keyboard, the reason Approve is off, reflow). Driven through the page's own markup (explorer/index.html)
 * with a stub renderer; layout is not computed in happy-dom, so the boxes the camera frames into are given to the elements.
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
import { initProposals, showProposal, openProposal } from '../../explorer/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { initScenarioUi, clearScenario, playScenario } from '../../explorer/scenario-ui.js';
// @ts-expect-error plain JS modules, no declarations
import { initWhatIf, resetWhatIfForTests } from '../../explorer/whatif.js';
// @ts-expect-error plain JS modules, no declarations
import { initReview, resetReviewForTests } from '../../explorer/review.js';
// @ts-expect-error plain JS modules, no declarations
import { initSheets, visibleMapRect } from '../../explorer/sheets.js';
// @ts-expect-error plain JS modules, no declarations
import { freeRect, frameNodes, largestGroup, allInside, READ_ZOOM, FRAME_ZOOM_MIN } from '../../explorer/camera.js';
// @ts-expect-error plain JS modules, no declarations
import { checksLine, sourceChip, notFoundWords, malformedLinkWords, otherCopies, pullNumberOf, touchedIds } from '../../explorer/proposal-model.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const page = fs.readFileSync(path.resolve(here, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page) [1].replace(/<script[\s\S]*?<\/script>/g, '');
const css = fs.readFileSync(path.resolve(here, '../../explorer/explorer.css'), 'utf8');

const node = (id        , type        , x        , y        , extra         = {}) => ({ id, type, x, y, r: 20, color: '#336699', label: id, ...extra });
// A map much bigger than the screen: the change is a small part of it, and the rest is far away
const base = {
  nodes: [
    node('root', 'root', 0, 0), node('app-a', 'app', 300, 0), node('page-old', 'page', 300, 200), node('table-t', 'table', 600, 100),
    node('far-1', 'page', 9000, 9000), node('far-2', 'page', -9000, -9000), node('far-3', 'page', 9000, -9000),
  ],
  edges: [
    { from: 'root', to: 'app-a' }, { from: 'app-a', to: 'page-old' }, { from: 'root', to: 'far-1' }, { from: 'root', to: 'far-2' }, { from: 'root', to: 'far-3' },
    { from: 'page-old', to: 'table-t', kind: 'reads', keys: ['a'], status: 'live', label: 'renders rows' },
  ],
};
const robot = (extra         = {}) => ({
  version: 1, spec: '0013', title: 'Meals', summary: 'Adds /meals.',
  nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }], remove: [{ id: 'page-old', why: 'replaced' }] },
  edges: { add: [{ from: 'page-meals', to: 'table-t', kind: 'writes', label: 'meals.add' }] },
  scenarios: [
    { id: 'one', title: 'First walk', steps: [{ node: 'page-meals', text: 'The page opens.' }, { node: 'table-t', text: 'The row is stored.' }] },
    { id: 'two', title: 'Second walk', steps: [{ node: 'app-a', text: 'only' }] },
  ],
  ...extra,
});

const $ = (id        ) => document.getElementById(id)               ;
const q = (sel        ) => document.querySelector(sel)               ;
const click = (el         ) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const rect = (top        , bottom        , left = 0, right = 1000) => () => ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top });
const boxOf = (el         , props         ) => Object.entries(props).forEach(([k, v]) => Object.defineProperty(el, k, { value: v, configurable: true }));

/** What `fetch` answers: the review of a PR, the PR itself with its checks, the listing, the proposals */
function fakeHub(opts                                                                                                                                                      = {}) {
  const json = (status        , data         , headers                         = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => data });
  const mock = vi.fn(async (url        , init              = {}) => {
    const u = new URL(url, 'http://localhost');
    if (/^\/proposals\/.+\/review$/.test(u.pathname)) return init.method === 'PUT' ? json(200, { version: 1, verdict: JSON.parse(String(init.body)).verdict, at: new Date().toISOString() }) : json(404, { error: 'none' });
    if (u.pathname === '/proposals') return json(200, opts.listing || []);
    const one = /^\/proposals\/(.+)\.json$/.exec(u.pathname);
    if (one) {
      const source = u.searchParams.get('source');
      return (opts.files || {})[`${one[1]}@${source}`] ? json(200, (opts.files || {})[`${one[1]}@${source}`], { 'X-Proposal-Source': source }) : json(404, { error: 'No such proposal' });
    }
    const pull = /^\/api\/forge\/pulls\/(\d+)$/.exec(u.pathname);
    if (pull && opts.pull) return json(200, { ok: true, pull: opts.pull, files: [], checks: opts.checks || [] });
    return json(404, { error: 'unexpected' });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function mount() {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  resetWhatIfForTests();
  resetReviewForTests();
  document.body.innerHTML = body;
  localStorage.clear();
  const ctx      = new Proxy({}, { get: (_t, k        ) => (k === 'measureText' ? (t        ) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas      = document.getElementById('graph-canvas');
  canvas.getContext = () => ctx;
  canvas.getBoundingClientRect = rect(0, 700) ;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  state.canvas = canvas;
  state.ctx = ctx;
  Object.assign(state, { proposal: null, effectiveProposal: null, proposalSlug: null, proposalSource: null, proposalView: 'diff', proposalErrors: [], view: 'orbit', selectedNode: null, selectedEdge: null, scenario: null });
  state.baseNodes = base.nodes.map((n) => ({ ...n }));
  state.baseEdges = base.edges;
  render.resize();
  setMap(state.baseNodes.map((n     ) => ({ ...n })), state.baseEdges);
  history.replaceState(null, '', '/');
  initSheets();
  initScenarioUi();
  clearScenario();
  await initProposals();
  initWhatIf();
  initReview();
}

const phone = (on         ) => vi.stubGlobal('matchMedia', (query        ) => ({ matches: on && /max-width: 767px/.test(query), media: query, addEventListener() {}, removeEventListener() {} }));
const open = (proposal         = robot(), slug                = '0013-meals', source                = 'pull/23') => showProposal(proposal, { slug, source, view: 'diff', fit: true });
/** The ids of what the proposal changes: marked nodes, and both ends of marked edges */
const changed = () => [...touchedIds(state.nodes, state.edges).touched].map((id) => state.nodes.find((n     ) => n.id === id));
const onScreen = (n     ) => ({ x: state.camera.x + n.x * state.camera.zoom, y: state.camera.y + n.y * state.camera.zoom });
const inRect = (n     , r     ) => { const p = onScreen(n); return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height; };

beforeEach(async () => { fakeHub(); phone(false); await mount(); });
afterEach(() => { resetReviewForTests(); clearScenario(); vi.unstubAllGlobals(); document.body.innerHTML = ''; localStorage.clear(); });

describe('F06 the camera on open: the changed nodes, in the part of the map nothing covers', () => {
  it('frames the changed nodes and not the whole map or their neighbours, at a zoom where labels read', () => {
    boxOf($('proposal-bar'), {});
    $('proposal-bar').getBoundingClientRect = rect(48, 190) ;
    open();
    const things = changed();
    expect(things.map((n     ) => n.id).sort()).toEqual(['app-a', 'page-meals', 'page-old', 'table-t']); // app-a: the end of the new ownership edge
    const r = visibleMapRect();
    expect(r.y).toBeGreaterThanOrEqual(142); // under the bar
    for (const n of things) expect(inRect(n, r), n.id).toBe(true);
    expect(state.camera.zoom).toBeGreaterThan(0.4); // the whole map would be a zoom of 0.03: nothing of the change would read
    expect(state.camera.zoom).toBeLessThanOrEqual(1);
  });

  it('on a phone keeps them above the sheets', () => {
    phone(true);
    initSheets();
    boxOf(q('#sheet-dock'), { offsetHeight: 300 });
    open();
    const r = visibleMapRect();
    expect(r.y + r.height).toBeLessThanOrEqual(700 - 300);
    for (const n of changed()) expect(inRect(n, r), n.id).toBe(true);
  });

  it('shows the whole map when the proposal changes nothing', () => {
    showProposal({ version: 1, title: 'Nothing', summary: 's' }, { slug: '0001-nothing', source: 'checkout', view: 'diff', fit: true });
    const r = visibleMapRect();
    for (const n of state.nodes) expect(inRect(n, r), n.id).toBe(true);
  });

  it('never goes below the lowest zoom a fit goes to; a change wider than that is framed where most of it is, not on the ground between', () => {
    $('proposal-bar').getBoundingClientRect = rect(48, 640) ; // a tall bar: the map left is a strip, too short for the whole change at the floor
    open(robot({ nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }], remove: [{ id: 'page-old' }, { id: 'far-1' }] } }));
    expect(state.camera.zoom).toBeGreaterThanOrEqual(FRAME_ZOOM_MIN); // readable group, not a speck: the map's own floor is lower
    const r = visibleMapRect();
    const all = changed();
    const group = largestGroup(all, r, { padding: 40 });
    const shown = all.filter((n     ) => inRect(n, r));
    expect(group.length).toBeLessThan(all.length); // they do not all fit
    expect(group.length).toBeGreaterThan(1);
    expect(shown.map((n     ) => n.id).sort()).toEqual(group.map((n     ) => n.id).sort()); // the biggest group is on screen, whole
  });

  it('draws a change on a layer that is off, and frames it: a review never hides its own change (spec 0009 D3)', () => {
    $('proposal-bar').getBoundingClientRect = rect(48, 190) ;
    state.activeLayers = { ...state.activeLayers, table: false };
    try {
      open();
      const table = state.nodes.find((n     ) => n.id === 'table-t');
      expect(table).toBeTruthy();
      expect(render.isNodeVisible(table)).toBe(true); // the Tables layer is off, and the proposal changes this table
      const r = visibleMapRect();
      for (const n of changed()) expect(inRect(n, r), n.id).toBe(true);
    } finally { state.activeLayers = { ...state.activeLayers, table: true }; }
  });
});

describe('the framing helpers', () => {
  it('freeRect takes the covers off each side and never leaves less than the least', () => {
    expect(freeRect(1000, 700, { top: 100, right: 400 })).toEqual({ x: 0, y: 100, width: 600, height: 600 });
    const tiny = freeRect(1000, 200, { top: 150, bottom: 150 }, 120);
    expect(tiny.height).toBeGreaterThanOrEqual(120);
  });

  it('largestGroup keeps them all when they fit at the floor, and else the most a window that size holds', () => {
    const r = { x: 0, y: 0, width: 1000, height: 700 };
    const near = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 0, y: 300 }];
    expect(largestGroup(near, r, { minZoom: 0.18 })).toEqual(near);
    const spread = [...near, { x: 20000, y: 0 }, { x: 0, y: -20000 }];
    expect(largestGroup(spread, r, { minZoom: 0.18 })).toEqual(near);
    expect(largestGroup(spread, r, { minZoom: 0.01 })).toEqual(spread); // a lower floor holds them all
  });

  it('frameNodes centres the nodes in the rect, and zooms in no further than asked', () => {
    const cam = frameNodes([{ x: 100, y: 100 }], { x: 0, y: 200, width: 800, height: 400 }, { padding: 40, maxZoom: 1 });
    expect(cam.zoom).toBe(1);
    expect(cam.x + 100).toBeCloseTo(400);
    expect(allInside([{ x: 100, y: 100 }], cam, { x: 0, y: 200, width: 800, height: 400 })).toBe(true);
    expect(frameNodes([], { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
  });
});

describe('F07 choosing a change centres it in the visible part of the map', () => {
  it('lands clear of the open list and the node panel', () => {
    $('proposal-bar').getBoundingClientRect = rect(48, 400) ; // the bar with its list open
    boxOf($('spec-drawer'), { offsetWidth: 420 });
    open();
    click($('proposal-chip'));
    const row = q('.hx-change-row[data-key="page-meals"]')               ;
    click(row);
    const r = visibleMapRect();
    expect(r.x + r.width).toBeLessThanOrEqual(1000 - 420);
    expect(r.y).toBeGreaterThanOrEqual(400);
    const meals = state.nodes.find((n     ) => n.id === 'page-meals');
    const p = onScreen(meals);
    expect(p.y).toBeGreaterThan(400); // not under the list
    expect(p.x).toBeLessThan(580); // not under the panel
    expect(state.camera.zoom).toBeGreaterThanOrEqual(READ_ZOOM); // its label reads
  });
});

describe('F08 the bar says which copy is under review', () => {
  it('a PR copy: the number, draft or open, the checks in words, linking to the PR', async () => {
    fakeHub({ pull: { number: 24, draft: true, state: 'open', url: 'https://github.com/o/r/pull/24' }, checks: [{ name: 'a', state: 'running' }, { name: 'b', state: 'success' }] });
    open(robot(), '0013-meals', 'pull/24');
    await settle();
    const chip = $('proposal-source');
    expect(chip.hidden).toBe(false);
    expect(chip.dataset.corn).toBe('proposal-source');
    expect(chip.textContent).toBe('PR #24 · draft · 1 check running');
    expect(chip.getAttribute('href')).toBe('https://github.com/o/r/pull/24');
    expect(chip.dataset.cornState).toBe('draft'); // the public state set (docs/theming.md), as on a state pill
    expect(chip.hasAttribute('data-tone')).toBe(false);
  });

  it('says only what it knows until the forge answers, and never links a scheme that is not http(s)', async () => {
    fakeHub({ pull: { number: 25, draft: false, state: 'open', url: 'javascript:alert(1)' }, checks: [] });
    open(robot(), '0013-meals', 'pull/25');
    expect($('proposal-source').textContent).toBe('PR #25');
    expect($('proposal-source').hasAttribute('data-corn-state')).toBe(false); // not known yet
    await settle();
    expect($('proposal-source').dataset.cornState).toBe('open');
    expect($('proposal-source').textContent).toBe('PR #25 · open · no checks');
    expect($('proposal-source').hasAttribute('href')).toBe(false);
  });

  it('a local draft says so, and where', () => {
    open(robot(), '0013-meals', 'checkout');
    expect($('proposal-source').textContent).toBe('Local draft · in the checkout');
    expect($('proposal-source').hasAttribute('href')).toBe(false);
    expect($('proposal-source').dataset.cornState).toBe('draft'); // a branch with no pull request yet is `draft`
    open(robot(), '0013-meals', 'topo-09');
    expect($('proposal-source').textContent).toBe('Local draft · in worktree topo-09');
  });

  it('the words, as a pure function', () => {
    expect(checksLine([])).toBe('no checks');
    expect(checksLine([{ state: 'success' }])).toBe('1 check passed');
    expect(checksLine([{ state: 'success' }, { state: 'success' }])).toBe('all 2 checks passed');
    expect(checksLine([{ state: 'failure' }, { state: 'failure' }, { state: 'running' }])).toBe('2 checks failed, 1 check running');
    expect(sourceChip('pull/7', { draft: false, url: 'https://x/7' }, []).text).toBe('PR #7 · open · no checks');
    expect(sourceChip('pull/7', { state: 'merged', draft: false }, null)).toMatchObject({ text: 'PR #7 · merged', state: 'merged' });
    expect(pullNumberOf('pull/7')).toBe(7);
    expect(pullNumberOf('pull/0')).toBeNull();
    expect(pullNumberOf('checkout')).toBeNull();
  });
});

describe('F12 focus goes somewhere stated', () => {
  it('Approve: it keeps the focus, and the status line (a live region) says it once', async () => {
    const s = fakeHub();
    open();
    const approve = q('[data-review="approved"]')                     ;
    approve.focus();
    click(approve);
    expect(approve.getAttribute('aria-disabled')).toBe('true'); // busy, but still the focused button (not `disabled`)
    expect(document.activeElement).toBe(approve);
    click(approve); // pressed again while busy: nothing
    await settle();
    expect(s.mock.calls.filter(([, init]     ) => init && init.method === 'PUT')).toHaveLength(1);
    const line = q('[data-review-status]')                     ;
    expect(line.textContent).toMatch(/Approved/);
    expect(line.querySelector('[role=status]').textContent).toBe('Approved'); // the verdict is the live region; the time beside it is not
    expect(line.hasAttribute('tabindex')).toBe(false); // never focused: a focused live region is read twice
    expect(document.activeElement).toBe(approve);
  });

  it('Approve from a tap that left the focus on the page: it goes to Approve, not nowhere', async () => {
    open();
    click(q('[data-review="approved"]'));
    (document.activeElement               )?.blur?.();
    await settle();
    expect(document.activeElement).toBe(q('[data-review="approved"]'));
  });

  it('Send back with a note: back on the button that opened the note', async () => {
    open();
    const send = q('[data-review="notes"]')                     ;
    click(send);
    expect(document.activeElement).toBe($('review-note'));
    ($('review-note')                     ).value = 'not yet';
    send.focus();
    click(send);
    await settle();
    expect(document.activeElement).toBe(send);
  });

  it('the change list: focus goes to its first row, and Escape folds it back onto its chip', () => {
    open();
    click($('proposal-chip'));
    expect(document.activeElement).toBe(q('#proposal-changes button'));
    document.activeElement .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect($('proposal-changes').hidden).toBe(true);
    expect(document.activeElement).toBe($('proposal-chip'));
  });

  it('the scenario list: focus goes to its first row; choosing one puts focus on the player\'s Pause; Escape closes it and gives Play the focus', () => {
    open();
    click($('proposal-play'));
    const first = q('.hx-scenarios-item')                     ;
    expect(document.activeElement).toBe(first);
    first.click();
    const toggle = q('[data-action=scenario-toggle]')                     ;
    expect(document.activeElement).toBe(toggle);
    expect(toggle.textContent).toBe('Pause');
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(q('.hx-player')).toBeNull();
    expect(document.activeElement).toBe($('proposal-play'));
  });

  it('Tab order: an open list comes right after its button, then the toolbar goes on (WCAG 2.4.3)', () => {
    open();
    const tab = (shift = false) => {
      const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
      document.activeElement .dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    // The change list, opened from the counts: its rows, then Before / Diff / After
    click($('proposal-chip'));
    const rows = [...document.querySelectorAll('#proposal-changes button')];
    expect(document.activeElement).toBe(rows[0]);
    expect(tab(true)).toBe(true);
    expect(document.activeElement).toBe($('proposal-chip'));
    expect(tab()).toBe(true);
    expect(document.activeElement).toBe(rows[0]);
    rows[rows.length - 1].focus();
    expect(tab()).toBe(true);
    const next = document.activeElement;
    expect(next.closest('#proposal-changes')).toBeNull();
    expect($('proposal-chip').compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(next.compareDocumentPosition(q('[data-review="approved"]')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // before Approve, not after it
    expect(tab(true)).toBe(true);
    expect(document.activeElement).toBe(rows[rows.length - 1]);
    // The scenario list, opened from Play: its rows, then Edit
    click($('proposal-play'));
    const items = [...document.querySelectorAll('.hx-scenarios-item')];
    expect(document.activeElement).toBe(items[0]);
    items[items.length - 1].focus();
    expect(tab()).toBe(true);
    expect(document.activeElement).toBe($('proposal-edit'));
    expect(tab(true)).toBe(true);
    expect(document.activeElement).toBe(items[items.length - 1]);
    // Past ⋯ the bar is left: the open lists' rows are not met again
    $('proposal-more').focus();
    tab();
    expect(document.activeElement.closest?.('#proposal-changes, #proposal-scenarios') ?? null).toBeNull();
  });

  it('Escape in the scenario list folds it back onto Play', () => {
    open();
    click($('proposal-play'));
    document.activeElement .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(q('#proposal-scenarios').hidden).toBe(true);
    expect(document.activeElement).toBe($('proposal-play'));
    expect($('proposal-play').getAttribute('aria-expanded')).toBe('false');
  });

  it('when Play cannot take the focus (a phone\'s peek folds it away), closing the player puts it on the map, not the page', () => {
    open();
    playScenario({ id: 's', title: 'S', steps: [{ node: 'root', text: 'a' }] }, { autoplay: false });
    (q('[data-action=scenario-close]')                     ).focus();
    const play = $('proposal-play');
    play.focus = () => {}; // as a display: none button does
    click(q('[data-action=scenario-close]'));
    expect(document.activeElement).toBe(state.canvas);
  });

  it('closing the player with its own button gives the focus back to Play too', () => {
    open();
    click($('proposal-play'));
    (q('.hx-scenarios-item')                     ).click();
    (q('[data-action=scenario-close]')                     ).focus();
    click(q('[data-action=scenario-close]'));
    expect(document.activeElement).toBe($('proposal-play'));
  });
});

describe('F15 a disabled Approve says why, in words, where a phone shows it', () => {
  it('the reason is a line the buttons point at', () => {
    open(robot(), '0013-meals', 'checkout');
    const approve = q('[data-review="approved"]')                     ;
    expect(approve.disabled).toBe(true);
    const hint = $('review-hint');
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toMatch(/spec PR/);
    expect(approve.getAttribute('aria-describedby')).toBe('review-hint');
  });

  it('the phone\'s peek keeps that line (and a refusal) while it folds the rest of the review away', () => {
    expect(css).toMatch(/\[data-sheet-state="peek"\] \.hx-review > :not\(\[data-review-hint\]\):not\(\[data-review-msg\]\) \{ display: none; \}/);
    expect(css).not.toMatch(/\.hx-proposal-more-menu, \.hx-review\) \{ display: none; \}/);
  });
});

describe('F16 a link that finds nothing says what, and offers the ways on', () => {
  const listing = [
    { slug: '0100-flow', source: 'checkout', title: 'Flow', pull: null },
    { slug: '0100-flow', source: 'pull/21', title: 'Flow', pull: { number: 21, draft: false } },
    { slug: '0101-other', source: 'checkout', title: 'Other', pull: null },
  ];

  it('names what was not found, and offers the copy that exists and the Specs list', async () => {
    fakeHub({ listing, files: { '0100-flow@pull/21': robot() } });
    expect(await openProposal('0100-flow', 'pull/23')).toBe(false);
    expect($('proposal-message').textContent).toBe('There is no proposal called 0100-flow in PR #23.');
    const ways = [...document.querySelectorAll('#proposal-ways button')];
    expect(ways.map((b) => b.textContent)).toEqual(['Open the copy in PR #21', 'Open the copy in the checkout', 'Open the Specs list']);
    expect($('proposal-ways').hidden).toBe(false);
    for (const b of ways) expect(b.hasAttribute('data-peek-ok'), b.textContent).toBe(true); // they act from a phone's peek, which keeps them
    click(ways[0]);
    await settle();
    expect(state.proposalSource).toBe('pull/21');
    expect($('proposal-ways').hidden).toBe(true);
  });

  it('a slug that exists nowhere offers the Specs list alone, which opens the list (the Work panel, or the Proposals menu without one)', async () => {
    fakeHub({ listing });
    expect(await openProposal('0999-none', null)).toBe(false);
    expect($('proposal-message').textContent).toBe('There is no proposal called 0999-none.');
    const ways = [...document.querySelectorAll('#proposal-ways button')];
    expect(ways.map((b) => b.textContent)).toEqual(['Open the Specs list']);
    click(ways[0]);
    await settle();
    expect(($('proposal-menu')               ).hidden).toBe(false);
  });

  it('a source that is not a PR, the checkout or a worktree the listing has is said so, and not echoed', async () => {
    expect(notFoundWords('x', 'garbage')).toBe('There is no proposal called x. This link\'s source is not a PR, the checkout or a worktree.');
    expect(notFoundWords('x', 'topo-09', new Set(['checkout', 'topo-09']))).toBe('There is no proposal called x in worktree topo-09.');
    expect(notFoundWords('x', '<img src=x onerror=alert(1)>', new Set(['<img src=x onerror=alert(1)>']))).not.toMatch(/img/);
    expect(otherCopies(listing, '0100-flow', 'checkout').map((c) => c.source)).toEqual(['pull/21']);
    expect(otherCopies(null, 'x', null)).toEqual([]);
    fakeHub({ listing });
    expect(await openProposal('0100-flow', '<b>garbage</b>')).toBe(false);
    expect($('proposal-message').textContent).not.toMatch(/garbage/);
    expect($('proposal-bar').querySelector('b')).toBeNull();
    expect([...document.querySelectorAll('#proposal-ways button')].map((b) => b.textContent)).toEqual(['Open the copy in PR #21', 'Open the copy in the checkout', 'Open the Specs list']);
  });

  it('#213 a link whose proposal is not a name says so, shows the value as text only, and offers the Specs list', async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    history.replaceState(null, '', `/?proposal=${encodeURIComponent(evil)}&source=pull/21`);
    const f = fakeHub({ listing });
    expect(await initProposals()).toBe(false);
    const msg = $('proposal-message');
    expect(msg.hidden).toBe(false);
    expect($('proposal-bar').hidden).toBe(false);
    expect(msg.textContent).toBe(`This link does not name a proposal: \u201c${evil}\u201d is not a proposal's name.`);
    expect(msg.children).toHaveLength(0); // text, not markup
    expect($('proposal-bar').querySelector('img')).toBeNull();
    expect([...document.querySelectorAll('#proposal-ways button')].map((b) => b.textContent)).toEqual(['Open the Specs list']);
    expect($('proposal-bar').querySelector('a[href]')).toBeNull();
    expect(f.mock.calls.some(([u]     ) => String(u).startsWith('/proposals/'))).toBe(false); // nothing is asked of the server for it
    expect(malformedLinkWords('?proposal=')).toBe('This link does not name a proposal.');
    expect(malformedLinkWords('?proposal=0100-ok')).toBeNull();
    expect(malformedLinkWords('?other=1')).toBeNull();
    expect(malformedLinkWords(`?proposal=${'a'.repeat(30)}%20${'b'.repeat(80)}`)).toMatch(/\u2026\u201d/); // a long value is cut
    history.replaceState(null, '', '/');
  });
});

describe('the phone and reflow rules (F11, F14, F21): what the stylesheet says', () => {
  const phoneCss = css.slice(css.indexOf('the review flow, 0.34 design review'));
  it('F11 the player peek keeps Previous, Pause and Next, and they work from the peek', () => {
    expect(css).toMatch(/\.hx-player\[data-sheet-state="peek"\] > :not\(\.hx-sheet-handle\):not\(\.hx-player-head\):not\(\.hx-player-text\):not\(\.hx-player-controls\)/);
    clearScenario();
    playScenario({ id: 's', title: 'S', steps: [{ node: 'root', text: 'a' }] }, { autoplay: false });
    for (const a of ['scenario-prev', 'scenario-toggle', 'scenario-next']) expect(q(`[data-action=${a}]`).hasAttribute('data-peek-ok')).toBe(true);
  });

  it('F14 with the note open on a phone: Approve and the rest fold away, the send button sits right under the field', () => {
    expect(phoneCss).toMatch(/\.hx-proposal-bar:has\(\.hx-review-form:not\(\[hidden\]\)\) \.hx-proposal-actions \.hx-btn--approve \{ display: none; \}/);
    expect(phoneCss).toMatch(/\.hx-proposal-bar:has\(\.hx-review-form:not\(\[hidden\]\)\) \.hx-proposal-actions \{ order: 4; grid-template-columns: 1fr; \}/);
  });

  it('F21 the counts wrap and the sheet never scrolls sideways', () => {
    expect(phoneCss).toMatch(/\.hx-proposal-chip \{ flex-wrap: wrap; max-width: 100%; white-space: normal;/);
    expect(phoneCss).toMatch(/\.hx-proposal-bar \{ overflow-x: hidden; overflow-wrap: anywhere; \}/);
    expect(phoneCss).toMatch(/max-height: 480px/); // a short window: an open sheet may take it
  });
});

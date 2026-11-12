// @vitest-environment happy-dom
/**
 * Runs on the map (issue #82): the marks over the nodes an open run is changing (a pulsing ring; a dashed ring, a sign and words where two
 * runs meet; still under reduced motion; off with the layer), the Runs view (state, profile, limits beside what was reported, links, the runner's
 * log, nodes, collisions), two profiles of one request side by side, the timeline in order, a run lit on the map, the live region on a change,
 * and axe in both themes over all of it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import axe from 'axe-core';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap } from '../../explorer/view.js';
// @ts-expect-error plain JS modules, no declarations
import { initForgePanel, resetForgePanelForTests, openForge, closeForge } from '../../explorer/forge-panel.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard, resetKeyboardForTests } from '../../explorer/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { initSheets } from '../../explorer/sheets.js';
// @ts-expect-error plain JS modules, no declarations
import { closeDrawer } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { groupRuns, overlayOf, timelineWords, changeWords, limitRows, litOfRun, collisionWords } from '../../explorer/runs-model.js';
// @ts-expect-error plain JS modules, no declarations
// @ts-expect-error plain JS modules, no declarations
import { pagePiece } from '../../explorer/page-pieces.js';
// The marks are the Work piece's own (pieces/work.js): motion is set on it, and it forgets the marks when it is reset (resetForgePanelForTests)
const setReducedMotionForTests = (on) => { const p = pagePiece('work'); if (p) p.setReducedMotion(on); };
const resetRunsMapForTests = () => setReducedMotionForTests(null);
// @ts-expect-error plain JS modules, no declarations
import { toggleLayer } from '../../explorer/layers.js';
import { explorerPage } from '../helpers.js';


import { explorerCss } from './stylesheets.js';
const EXPLORER = path.resolve(__dirname, '../../explorer');
const page = explorerPage({ pieces: ['map'] });
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const css = explorerCss(['tokens.css', 'explorer.css', 'house.css']);
const NOW = Date.parse('2026-11-05T12:00:00Z');
const MAP = { nodes: [
  { id: 'orders', type: 'page', x: 100, y: 100, r: 14, color: '#38bdf8', label: 'orders', degree: 0 },
  { id: 'cart', type: 'page', x: 200, y: 140, r: 14, color: '#38bdf8', label: 'cart', degree: 0 },
  { id: 'web', type: 'app', x: 300, y: 200, r: 18, color: '#6366f1', label: 'web', degree: 0 },
], edges: [] };
const user = (login) => ({ login, url: `https://git.example.test/${login}` });
const issue = (number, title) => ({ number, title, state: 'open', author: user('maintainer-one'), labels: [], comments: 0, url: `https://git.example.test/owner/name/issues/${number}`, createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-01T09:00:00Z', closedAt: null, body: '' });
const pr = (number, title, text, ref) => ({ number, title, body: text, state: 'open', draft: false, author: user('runner-bot'), labels: [], head: { ref, sha: 'a'.repeat(40) }, base: { ref: 'main' }, url: `https://git.example.test/owner/name/pull/${number}`, createdAt: '2026-11-04T09:00:00Z', updatedAt: '2026-11-04T09:00:00Z', mergedAt: null });

const $ = (id) => document.getElementById(id);
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const said = async () => { await new Promise((r) => setTimeout(r, 50)); return $('map-announcer').textContent; };
const openAgents = async () => { openForge({ tab: 'pulls' }); await settle(); click(q('[data-forge-kind="work"]')); await settle(); };
const run = (id, extra = {}) => ({
  runId: `run-01JC8Z3Q5M7VXK2RT9N4B6HD${id}`, kind: 'code', profile: 'claude', refs: { issue: 7 }, status: 'working', open: true, requestedBy: 'maintainer-one',
  requestedAt: '2026-11-05T11:00:00Z', via: 'dashboard', comment: { id: '9', url: 'https://git.example.test/owner/name/issues/7#issuecomment-9' },
  limits: { minutes: 30, cost: 5 }, stopRequested: null, checks: 'running', brief: 'Add meals', branch: 'agent/meals', nodes: ['orders'], nodesFrom: 'files', collidesWith: [],
  report: { state: 'working', at: '2026-11-05T11:30:00Z', by: 'runner-bot', note: 'tests <img src=x onerror=alert(1)> failing', url: 'https://ci.example.org/1', tokens: 1200, cost: 0.4 },
  pull: { number: 50, state: 'open', url: 'https://git.example.test/owner/name/pull/50', by: 'runner-bot', trusted: true, via: 'body' },
  timeline: [
    { at: '2026-11-05T11:00:00Z', kind: 'requested', actor: 'maintainer-one', ref: 'claude', note: null, url: null },
    { at: '2026-11-05T11:05:00Z', kind: 'claimed', actor: 'runner-bot', ref: 'claimed', note: null, url: null },
    { at: '2026-11-05T11:20:00Z', kind: 'push', actor: null, ref: 'abcdef0123456', note: 'agent/meals', url: null },
    { at: '2026-11-05T11:21:00Z', kind: 'pull-opened', actor: 'runner-bot', ref: '#50', note: null, url: null },
    { at: '2026-11-05T11:30:00Z', kind: 'report', actor: 'runner-bot', ref: 'working', note: 'tests <b>failing</b>', url: null },
    { at: '2026-11-05T11:40:00Z', kind: 'checks', actor: null, ref: 'running', note: null, url: null },
  ],
  ...extra,
});
const A = run('A');
const B = run('B', { refs: { issue: 9 }, nodes: ['orders', 'cart'], collidesWith: [A.runId], timeline: [A.timeline[0]], pull: null, report: null, branch: null, checks: null, profile: 'qwen', brief: 'Other' });
const A2 = { ...A, collidesWith: [B.runId] };
// the same request under two profiles
const P1 = run('P', { refs: { issue: 11 }, profile: 'claude', nodes: ['web'], brief: 'Compare me', requestedAt: '2026-11-05T11:50:00Z', collidesWith: [] });
const P2 = run('Q', { refs: { issue: 11 }, profile: 'qwen', nodes: ['web'], brief: 'Compare me', requestedAt: '2026-11-05T11:50:30Z', collidesWith: [], report: null, pull: null, checks: null });
const DONE = run('D', { refs: { issue: 3 }, status: 'merged', open: false, nodes: ['cart'], brief: 'old', requestedAt: '2026-11-04T09:00:00Z' });

function fakeServer(initial) {
  const state2 = { runs: initial };
  const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = new URL(url, 'http://localhost');
    const at = '2026-11-05T11:58:00.000Z';
    if (u.pathname === '/api/agent-runs') return json(200, { ok: true, runs: state2.runs, open: state2.runs.filter((r) => r.open).length, maxOpen: 3, profiles: ['claude', 'qwen'], limits: {} });
    if (u.pathname === '/api/forge/work') return json(200, { ok: true, at, rate: '', pulls: [], issues: [], branches: [], specs: [], rules: {} });
    return json(404, { ok: false, error: 'No such thing.', code: 'not-found' });
  }));
  return state2;
}

function mount() {
  document.head.innerHTML = `<title>cornfield</title><style>${css}</style>`;
  document.body.innerHTML = body;
  document.documentElement.lang = 'en';
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = $('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, labelCanvas: null, proposal: null, view: 'orbit', selectedNode: null, isFreeform: false, scenario: null, searchQuery: '', forgeLit: null, activeLayers: {} });
  state.camera = { x: 0, y: 0, zoom: 1 };
  render.resize();
  state.baseNodes = MAP.nodes.map((n) => ({ ...n }));
  state.baseEdges = MAP.edges;
  setMap(MAP.nodes.map((n) => ({ ...n })), MAP.edges);
  resetKeyboardForTests();
  initKeyboard();
  initSheets();
  resetForgePanelForTests(() => NOW);
  resetRunsMapForTests();
  return initForgePanel({ forge: { type: 'github', url: 'https://git.example.test', repo: 'owner/name' }, signIn: { login: 'maintainer-one' }, agents: { runs: true } }, { clock: () => NOW });
}
const marks = () => qa('#run-overlay .hx-run-mark');
const rows = () => qa('#forge-runs-list li.hx-run');

const audit = async () => {
  const r = await axe.run({ include: [document.documentElement] }, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }, rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
};

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { closeForge({ restoreFocus: false }); closeDrawer(); resetRunsMapForTests(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('the words (runs-model.js)', () => {
  beforeEach(() => { document.body.innerHTML = body; });
  it('group the same request under different profiles, and nothing else', () => {
    const g = groupRuns([P2, P1, A, DONE]);
    expect(g.map((x) => x.kind)).toEqual(['compare', 'run', 'run']);
    expect(g[0].runs.map((r) => r.profile)).toEqual(['claude', 'qwen']);
    // same profile twice, another brief, another subject, or far apart in time: not a compare
    expect(groupRuns([P1, { ...P1, runId: 'run-x' }]).map((x) => x.kind)).toEqual(['run', 'run']);
    expect(groupRuns([P1, { ...P2, brief: 'else' }]).map((x) => x.kind)).toEqual(['run', 'run']);
    expect(groupRuns([P1, { ...P2, refs: { issue: 12 } }]).map((x) => x.kind)).toEqual(['run', 'run']);
    expect(groupRuns([P1, { ...P2, requestedAt: '2026-11-05T08:00:00Z' }]).map((x) => x.kind)).toEqual(['run', 'run']);
  });

  it('mark the nodes of open runs, collisions where two meet, and nothing for a finished run', () => {
    const o = overlayOf([A2, B, DONE]);
    expect([...o.flight.keys()].sort()).toEqual(['cart', 'orders']);
    expect([...o.collide.keys()]).toEqual(['orders']);
    expect(o.collide.get('orders')).toEqual([A.runId, B.runId]);
    expect([...litOfRun(DONE).changed]).toEqual(['cart']);
    expect(collisionWords(B, [A2, B], MAP.nodes)).toBe(`Collides with ${A.runId} on orders`);
    expect(collisionWords(DONE, [DONE], MAP.nodes)).toBe(null);
  });

  it('say a timeline in the order it came, and the limits beside what was reported in words', () => {
    expect(A.timeline.map((e) => timelineWords(e).what)).toEqual([
      'Requested by maintainer-one under the profile claude', 'Claimed by runner-bot', 'Push seen: abcdef0 on agent/meals', 'Opened pull request #50 by runner-bot', 'Reported working by runner-bot', 'Checks running',
    ]);
    expect(limitRows(A)).toEqual([
      { name: 'Minutes', limit: '30', reported: 'not reported' }, { name: 'Cost', limit: '5.00', reported: '0.40' }, { name: 'Tokens', limit: 'no limit asked', reported: '1,200' },
    ]);
  });

  it('say a runner by its label, and an older row\'s login as it was', () => {
    const runner = { kind: 'runner', label: 'bucket-bot', tokenId: 3, mintedBy: { login: 'maintainer-one', userId: '1001' } };
    expect(timelineWords({ kind: 'claimed', actor: runner }).what).toBe('Claimed by bucket-bot');
    expect(timelineWords({ kind: 'report', ref: 'working', actor: runner }).what).toBe('Reported working by bucket-bot');
    expect(timelineWords({ kind: 'report', ref: 'working', actor: 'old-login' }).what).toBe('Reported working by old-login');
    expect(timelineWords({ kind: 'claimed', actor: null }).what).toBe('Claimed');
  });

  it('say what changed, and nothing on the first answer', () => {
    expect(changeWords(null, [A])).toEqual([]);
    // a run is called by what its card shows, never by its id
    const nameA = 'code on issue #7, profile claude, asked by maintainer-one';
    const nameB = 'code on issue #9, profile qwen, asked by maintainer-one';
    expect(changeWords([A, B], [A2, { ...B, status: 'done', open: false }])).toEqual([
      `Run ${nameA} now collides with ${nameB}`, `Run ${nameB} is now done`, `Run ${nameB} no longer collides`,
    ]);
    expect(changeWords([A], [A2, B])).toEqual([`Run ${nameA} now collides with ${nameB}`, expect.stringMatching(/^New run: /)]);
  });
});

describe('the marks on the map', () => {
  it('pulse on the nodes an open run changes, and a collision is a dashed ring with a sign and words', async () => {
    fakeServer([A2, B, DONE]);
    mount();
    await settle();
    render.renderNow();
    const byNode = Object.fromEntries(marks().map((m) => [m.dataset.node, m]));
    expect(Object.keys(byNode).sort()).toEqual(['cart', 'orders']); // the finished run's node 'cart' is also B's: both open runs name it? B names cart
    expect(byNode.orders.classList.contains('hx-run-mark--collision')).toBe(true);
    expect(byNode.orders.textContent).toContain('⚠');
    expect(byNode.orders.textContent).toContain('Collision · 2 runs');
    expect(byNode.cart.classList.contains('hx-run-mark--flight')).toBe(true);
    expect(byNode.cart.textContent).toBe('');
    const at = render.getScene().nodes.find((n) => n.id === 'orders');
    expect(parseFloat(byNode.orders.style.left)).toBeCloseTo(at.x, 0);
    expect($('run-overlay').getAttribute('aria-hidden')).toBe('true');
    expect($('runs-legend').hidden).toBe(false);
    // the ring pulses by CSS, which reduced motion turns into a still ring
    expect(css).toMatch(/\.hx-run-mark--flight \.hx-run-ring \{ animation: hx-run-pulse/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.hx-run-ring \{ animation: none !important/);
  });

  it('are still, not moving, when motion is reduced', async () => {
    fakeServer([A2, B]);
    mount();
    await settle();
    setReducedMotionForTests(true);
    render.renderNow();
    expect($('run-overlay').classList.contains('is-static')).toBe(true);
    setReducedMotionForTests(false);
    render.renderNow();
    expect($('run-overlay').classList.contains('is-static')).toBe(false);
  });

  it('follow the camera, keep their elements while panning, and go with the layer toggle', async () => {
    fakeServer([A2, B]);
    mount();
    await settle();
    render.renderNow();
    const first = marks()[0];
    state.camera = { x: 50, y: 10, zoom: 2 };
    render.renderNow();
    expect(marks()[0]).toBe(first);
    const at = render.getScene().nodes.find((n) => n.id === first.dataset.node);
    expect(parseFloat(first.style.left)).toBeCloseTo(at.x * 2 + 50, 0);
    toggleLayer('runs');
    render.renderNow();
    expect(marks()).toHaveLength(0);
    toggleLayer('runs');
    render.renderNow();
    expect(marks().length).toBeGreaterThan(0);
    expect(qa('#layer-toggles-container [data-layer="runs"]')).toHaveLength(1);
  });

  it('are not touched by a frame that moves nothing (the packets\' frames), and move again with the camera', async () => {
    fakeServer([A2, B]);
    mount();
    await settle();
    render.renderNow();
    const el = marks()[0];
    el.style.left = '-9999px';
    render.renderNow(); // same scene, same camera: nothing is written
    expect(el.style.left).toBe('-9999px');
    state.camera = { ...state.camera, x: state.camera.x + 5 };
    render.renderNow();
    expect(el.style.left).not.toBe('-9999px');
  });

  it('are not there for a finished run or without any run', async () => {
    fakeServer([DONE]);
    mount();
    await settle();
    render.renderNow();
    expect(marks()).toHaveLength(0);
    expect($('runs-legend').hidden).toBe(true);
  });
});

describe('the Runs view', () => {
  it('shows state, profile, limits beside what was reported, links, nodes, the collision, and the runner\'s log', async () => {
    fakeServer([A2, B]);
    mount();
    await openAgents();
    expect(rows()).toHaveLength(2);
    const a = rows().find((r) => r.dataset.run === A.runId);
    expect(a.textContent).toContain('Working');
    expect(a.textContent).toContain('profile claude');
    expect(a.querySelector('.hx-run-limits').textContent).toContain('Cost');
    expect(a.querySelector('.hx-run-limits').textContent).toContain('limit: 5.00; reported: 0.40');
    expect(a.textContent).toContain('Checks running');
    expect(a.textContent).toContain('Changing orders');
    expect(a.textContent).toContain(`Collides with ${B.runId} on orders`);
    expect(a.textContent).toContain('Runner: tests <img src=x onerror=alert(1)> failing');
    expect(a.querySelector('img')).toBe(null);
    expect([...a.querySelectorAll('a')].map((l) => [l.textContent.replace(' (new tab)', '').trim(), l.getAttribute('href')])).toEqual([
      ['Request on GitHub', 'https://git.example.test/owner/name/issues/7#issuecomment-9'],
      ['Thread #7', 'https://git.example.test/owner/name/issues/7'],
      ['Branch agent/meals', 'https://git.example.test/owner/name/tree/agent/meals'],
      ['Pull request #50', 'https://git.example.test/owner/name/pull/50'],
      ["Runner's log", 'https://ci.example.org/1'],
    ]);
  });

  it('puts two profiles of one request side by side in a labelled group, and keeps the others apart', async () => {
    fakeServer([P1, P2, A]);
    mount();
    await openAgents();
    const group = q('#forge-runs-list section.hx-run-compare');
    expect(group.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.getElementById(group.getAttribute('aria-labelledby')).textContent).toBe('Code on issue #11 under 2 profiles: claude and qwen');
    expect([...group.querySelectorAll('li.hx-run')].map((r) => r.textContent.match(/profile (\w+)/)[1])).toEqual(['claude', 'qwen']);
    expect(group.querySelector('ul.hx-run-columns')).not.toBe(null);
    expect(qa('#forge-runs-list li.hx-run')).toHaveLength(3);
    // two columns on a wide panel, stacked on a narrow one
    expect(css).toMatch(/\.hx-run-columns \{[^}]*grid-template-columns: 1fr;/);
    expect(css).toMatch(/@container corn-box \(min-width: 1100px\)[\s\S]*\.hx-run-columns \{ grid-template-columns: repeat\(2/);
  });

  it('opens a timeline as an ordered list with times, escaped, and keeps it open when the list is drawn again', async () => {
    fakeServer([A2]);
    mount();
    await openAgents();
    const btn = q(`[data-run-timeline="${A.runId}"]`);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(q('.hx-run-timeline')).toBe(null);
    btn.focus();
    click(btn);
    await settle();
    expect(q(`[data-run-timeline="${A.runId}"]`).getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(q(`[data-run-timeline="${A.runId}"]`));
    const ol = q('ol.hx-run-timeline');
    expect(ol.getAttribute('aria-label')).toMatch(/oldest first/);
    const items = [...ol.querySelectorAll('li')];
    expect(items.map((li) => li.querySelector('time').getAttribute('datetime'))).toEqual(A.timeline.map((e) => e.at));
    expect(items[0].textContent).toContain('1 hour ago');
    expect(items[0].textContent).toContain('Requested by maintainer-one');
    expect(items[4].textContent).toContain('tests <b>failing</b>');
    expect(ol.querySelector('b')).toBe(null);
    click(q('[data-action="refresh-forge"]'));
    await settle();
    expect(q('ol.hx-run-timeline')).not.toBe(null);
  });

  it('lights a run\'s nodes like a pull request, with a button that is pressed and lets go', async () => {
    fakeServer([A2, B]);
    mount();
    await openAgents();
    const pick = q(`[data-run-select="${B.runId}"]`);
    expect(pick.getAttribute('aria-pressed')).toBe('false');
    pick.focus();
    click(pick);
    await settle();
    expect([...state.forgeLit.changed].sort()).toEqual(['cart', 'orders']);
    expect(q(`[data-run-select="${B.runId}"]`).getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(q(`[data-run-select="${B.runId}"]`));
    expect(await said()).toMatch(/2 nodes lit/);
    click(q(`[data-run-select="${B.runId}"]`));
    await settle();
    expect(state.forgeLit).toBe(null);
  });

  it('says when a run\'s state or a collision changes, through the live region', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const server = fakeServer([A, { ...B, collidesWith: [], nodes: ['web'] }]);
      mount();
      await vi.advanceTimersByTimeAsync(1);
      server.runs = [A2, B];
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(100);
      expect($('map-announcer').textContent).toBe('Run code on issue #7, profile claude, asked by maintainer-one now collides with code on issue #9, profile qwen, asked by maintainer-one. Run code on issue #9, profile qwen, asked by maintainer-one now collides with code on issue #7, profile claude, asked by maintainer-one');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.each(['dark', 'light'])('accessibility, %s theme', (theme) => {
  it('passes axe with the marks on the map, the Runs view, a compare, and a timeline open', async () => {
    document.documentElement.dataset.theme = theme;
    fakeServer([A2, B, P1, P2, DONE]);
    mount();
    document.documentElement.dataset.theme = theme;
    await settle();
    render.renderNow();
    expect(marks().length).toBeGreaterThan(0);
    expect(await audit()).toEqual([]);
    q('#legend-toggle-btn').click?.();
    await openAgents();
    expect(await audit()).toEqual([]);
    click(q(`[data-run-timeline="${A.runId}"]`));
    click(q(`[data-run-select="${B.runId}"]`));
    await settle();
    expect(q('.hx-run-compare')).not.toBe(null);
    expect(q('ol.hx-run-timeline')).not.toBe(null);
    expect(await audit()).toEqual([]);
    delete document.documentElement.dataset.theme;
  });
});

describe('the runs are read again every minute, only while one is open', () => {
  const reads = () => /** @type {any} */ (globalThis.fetch).mock.calls.filter(([u]) => String(u).startsWith('/api/agent-runs')).length;
  afterEach(() => { vi.useRealTimers(); });

  it('reads again while a run is open, stops when none is, never stacks, and stops while the page is put away', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = fakeServer([A]);
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(1);
    // A second init (as a test reset or a re-wire would) does not start a second timer
    initForgePanel({ forge: { type: 'github', url: 'https://git.example.test', repo: 'owner/name' }, signIn: { login: 'maintainer-one' }, agents: { runs: true } }, { clock: () => NOW });
    await vi.advanceTimersByTimeAsync(0);
    const afterInit = reads();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toBe(afterInit + 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toBe(afterInit + 2);
    // Put away (closed, or into the back-forward cache): no read; shown again: reads resume
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(reads()).toBe(afterInit + 2);
    window.dispatchEvent(new Event('pageshow'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toBe(afterInit + 3);
    // The run finishes: the answer has none open, so the timer is not armed again
    server.runs = [{ ...A, open: false, status: 'merged' }];
    await vi.advanceTimersByTimeAsync(60_000);
    const last = reads();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(reads()).toBe(last);
  });

  it('with no run open, there is no timer at all', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fakeServer([DONE]);
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(reads()).toBe(1);
  });
});

describe('the proposal bar beside the issues and PRs panel (explorer.css)', () => {
  beforeEach(() => { document.body.innerHTML = body; });
  // happy-dom has no layout: the rule is held here, and measured in Chromium at 1100, 1440 and 1920 px wide for the review of #90
  it('makes room by the panel\'s own width, which the compare widens, never a fixed offset', () => {
    const cssText = explorerCss();
    expect(cssText).not.toMatch(/proposal-bar \{ left: \d+px/);
    expect(cssText).toContain('.hx-stage:has(.forge-open) .hx-proposal-bar { left: calc(var(--hx-forge-w) + 12px);');
    expect(cssText).toContain('width: var(--hx-forge-w);');
    expect(cssText).toContain('.hx-stage:has(.hx-forge .hx-run-compare) { --hx-forge-w: min(780px, calc(100% - 24px)); }');
    expect(cssText).toContain('.hx-stage:has(.hx-forge .hx-run-compare):has(.drawer-open) { --hx-forge-w: min(400px, calc(100% - 24px)); }');
  });
});

// @vitest-environment happy-dom
/**
 * A node's History in the node panel (spec 0014 D2), through the page's own markup with a fake server behind `fetch`: nothing is read while
 * the config says `history: false`; with it on, the first node shown reads `GET /api/history` once, and its panel lists the node's commits
 * newest first, each with its trail (spec, issue, pull request, commit) linked to the forge and its gaps dashed; a spec's chip lights what the
 * spec reached and dims the rest, and the same chip, or a cleared selection, ends it. Words from git are text, never markup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { state, pageInstance } from '../../explorer/state.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap } from '../../explorer/view.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard, resetKeyboardForTests } from '../../explorer/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { initSheets } from '../../explorer/sheets.js';
// @ts-expect-error plain JS modules, no declarations
import { closeDrawer, selectNode } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { initHistory } from '../../explorer/history.js';
// @ts-expect-error plain JS modules, no declarations
import { setLayer, setProjectLayers } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { layerRows } from '../../explorer/engine/layers.js';
import { explorerPage } from '../helpers.js';

const page = explorerPage({ pieces: ['map'] });
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');

const node = (id, type, file, extra = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, degree: 1, ...(file ? { file } : {}), ...extra });
const MAP = {
  nodes: [
    node('root', 'root', 'package.json'), node('pkg-server', 'pkg', 'server', { label: 'server' }),
    node('core-auth', 'core', 'server/auth.js', { label: 'auth.js' }), node('core-db', 'core', 'server/db.js', { label: 'db.js' }),
    node('page-spec', 'page', 'docs/specs/0007-sign-in.md', { label: '/docs/specs/0007-sign-in', desc: 'Spec 0007: Sign-in (who may do what) (docs/specs/0007-sign-in.md)' }),
  ],
  edges: [{ from: 'root', to: 'pkg-server' }, { from: 'pkg-server', to: 'core-auth' }, { from: 'pkg-server', to: 'core-db' }, { from: 'root', to: 'page-spec' }],
};
const sha = (c) => c.repeat(40);
const HISTORY = {
  ok: true, head: sha('c'), cut: false,
  commits: [
    { sha: sha('a'), date: '2026-10-01T10:00:00Z', subject: 'start', pr: null, issues: [], keys: [], specs: [], files: 3, nodes: ['core-auth', 'pkg-server', 'root'] },
    { sha: sha('b'), date: '2026-10-05T10:00:00Z', subject: 'feat(auth): sign-in <b>now</b>', pr: 12, issues: [7], keys: [], specs: ['0007'], files: 2, nodes: ['core-auth', 'core-db', 'pkg-server'] },
    { sha: sha('c'), date: '2026-10-09T10:00:00Z', subject: 'fix(auth): a typo', pr: 13, issues: [], keys: ['CF-9'], specs: [], files: 1, nodes: ['core-auth', 'pkg-server'] },
  ],
  nodes: { root: { born: 0, commits: [0] }, 'pkg-server': { born: 0, commits: [0, 1, 2] }, 'core-auth': { born: 0, commits: [0, 1, 2] }, 'core-db': { born: 1, commits: [1] }, 'page-spec': { born: 0, commits: [] } },
};
const FORGE = { type: 'github', url: 'https://github.com', repo: 'owner/name' };

const $ = (id) => document.getElementById(id);
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const pick = (id) => state.nodes.find((n) => n.id === id);
const sceneNode = (id) => render.getScene().nodes.find((n) => n.id === id);

function fakeServer(answer = () => ({ status: 200, body: HISTORY })) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    calls.push(String(url));
    const { status, body: data } = answer(String(url));
    return { ok: status < 400, status, headers: new Headers(), json: async () => data };
  }));
  return { calls };
}

let stop = () => {};
function mount(config = { history: true, forge: FORGE }) {
  document.body.innerHTML = body;
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = $('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, labelCanvas: null, proposal: null, view: 'orbit', selectedNode: null, isFreeform: false, scenario: null, searchQuery: '', historyPick: null, historyAt: null, forge: config.forge || null });
  state.camera = { x: 0, y: 0, zoom: 1 };
  render.resize();
  setMap(MAP.nodes.map((n) => ({ ...n })), MAP.edges);
  resetKeyboardForTests();
  initKeyboard();
  initSheets();
  setProjectLayers(undefined);
  stop = initHistory(pageInstance(), config);
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { stop(); closeDrawer(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('a node\'s History', () => {
  it('reads nothing, and shows no section, when history is off', async () => {
    const server = fakeServer();
    mount({ history: false, forge: FORGE });
    selectNode(pick('core-auth'));
    await settle();
    expect(server.calls).toEqual([]);
    expect(q('#drawer-history').innerHTML).toBe('');
  });

  it('reads the history once, and lists the commits newest first with their trails linked to the forge', async () => {
    const server = fakeServer();
    mount();
    selectNode(pick('core-auth'));
    expect(q('#drawer-history').textContent).toContain('Reading the history');
    await settle();
    const box = q('#drawer-history');
    expect(box.querySelector('h3 .hx-sec-name').textContent).toBe('History'); // its count on its toggle (spec 0015 D4)
    expect(box.querySelector('h3 [data-corn="count"]').textContent).toBe('3');
    expect(q(".hx-history-stats").textContent).toBe('3 commits · 2 pull requests · 67% traced to a spec or issue');
    const commits = qa('.hx-history-commit');
    expect(commits.map((c) => c.querySelector('.hx-history-subject').textContent)).toEqual(['fix(auth): a typo', 'feat(auth): sign-in <b>now</b>', 'start']);
    expect(box.querySelector('b:not(.hx-ms)')).toBe(null); // a subject is text
    const trail = commits[1].querySelectorAll('[data-trail]:not([data-trail="gap"])');
    expect([...trail].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Spec 0007', 'https://github.com/owner/name/blob/HEAD/docs/specs/0007-sign-in.md'],
      ['Issue #7', 'https://github.com/owner/name/issues/7'],
      ['PR #12', 'https://github.com/owner/name/pull/12'],
      ['bbbbbbb', `https://github.com/owner/name/commit/${sha('b')}`],
    ]);
    // gaps are said, not guessed: an issue key stands for the issue, unlinked; nothing named is a dashed gap
    expect([...commits[0].querySelectorAll('[data-trail]')].map((x) => x.textContent)).toEqual(['no spec', 'CF-9', 'PR #13', 'ccccccc']);
    expect([...commits[2].querySelectorAll('[data-trail="gap"]')].map((x) => x.textContent)).toEqual(['no spec', 'no issue', 'no pull request']);
    expect(commits[2].textContent).toContain('born here');
    selectNode(pick('core-db'));
    await settle();
    expect(server.calls).toEqual(['/api/history']);
    expect(qa('.hx-history-commit')).toHaveLength(1);
  });

  it('lights what a spec reached and dims the rest; the chip again, or a cleared selection, ends it', async () => {
    fakeServer();
    mount();
    selectNode(pick('core-auth'));
    await settle();
    const chip = q('[data-history-spec="0007"]');
    expect(chip.textContent).toBe('Spec 0007 Sign-in');
    click(chip);
    expect([...state.historyPick.nodes].sort()).toEqual(['core-auth', 'core-db', 'pkg-server']);
    expect(sceneNode('core-db').alpha).toBe(1);
    expect(sceneNode('page-spec').alpha).toBeLessThan(1);
    expect(q('[data-history-spec="0007"]').getAttribute('aria-pressed')).toBe('true');
    click(q('[data-history-spec="0007"]'));
    expect(state.historyPick).toBe(null);
    click(q('[data-history-spec="0007"]'));
    expect(state.historyPick).not.toBe(null);
    closeDrawer();
    expect(state.historyPick).toBe(null);
  });

  it('says plainly when the history cannot be read', async () => {
    fakeServer(() => ({ status: 503, body: { ok: false, error: 'The history could not be read: git is not installed where cornfield runs.' } }));
    mount();
    selectNode(pick('core-auth'));
    await settle();
    expect(q('#drawer-history [data-corn="error"]').textContent).toBe('The history could not be read: git is not installed where cornfield runs.');
  });

  it('links nothing without a forge it knows, and nothing that is not https', async () => {
    fakeServer();
    mount({ history: true, forge: { type: 'github', url: 'http://github.example.test', repo: 'owner/name' } });
    selectNode(pick('core-auth'));
    await settle();
    expect(qa('#drawer-history a')).toEqual([]);
    expect(qa('.hx-history-commit')).toHaveLength(3);
  });

  it('puts a picked spec on the map as a bar, with its file linked and the way back', async () => {
    fakeServer();
    mount();
    selectNode(pick('core-auth'));
    await settle();
    click(q('[data-history-spec="0007"]'));
    const bar = q('.hx-history-bar');
    expect(bar.querySelector('.hx-history-bar-text').textContent).toBe('Spec 0007 · Sign-in: 1 commit, 3 nodes');
    expect(bar.querySelector('a').getAttribute('href')).toBe('https://github.com/owner/name/blob/HEAD/docs/specs/0007-sign-in.md');
    click(bar.querySelector('[data-history-unpick]'));
    expect(state.historyPick).toBe(null);
    expect(q('.hx-history-bar')).toBe(null);
  });
});

describe('the History layer', () => {
  const row = () => layerRows(pageInstance()).overlays.find((r) => r.key === 'history-halos');

  it('has no row, and reads nothing, when history is off', async () => {
    const server = fakeServer();
    mount({ history: false, forge: FORGE });
    expect(row()).toBe(undefined);
    await settle();
    expect(server.calls).toEqual([]);
  });

  it('is a row under Overlays, off to start; turned on it reads the history once and puts a halo on each node it changed', async () => {
    const server = fakeServer();
    mount();
    expect(row()).toMatchObject({ label: 'History', overlay: true, countText: 'not read yet' });
    await settle();
    expect(server.calls).toEqual([]);
    expect(q('.hx-history-halo')).toBe(null);
    setLayer('history-halos', true);
    expect(row().countText).toBe('reading…');
    await settle();
    render.renderNow();
    expect(server.calls).toEqual(['/api/history']);
    expect(row().countText).toBe('4 nodes');
    const halos = qa('.hx-history-halo');
    expect(halos).toHaveLength(4); // root, pkg-server, core-auth, core-db; the spec page no commit changed has none
    expect(q('.hx-history-halos').getAttribute('aria-hidden')).toBe('true');
    // core-auth changed in all three commits (the widest), core-db once, four days before the newest (this week); root eight days before (this month)
    const byNode = Object.fromEntries(halos.map((h) => [h.dataset.node, h]));
    expect(Object.keys(byNode).sort()).toEqual(['core-auth', 'core-db', 'pkg-server', 'root']);
    expect(byNode['core-auth'].style.getPropertyValue('--w')).toBe('6px');
    expect(byNode['core-db'].dataset.band).toBe('week');
    expect(byNode.root.dataset.band).toBe('month');
    setLayer('history-halos', false);
    render.renderNow();
    expect(qa('.hx-history-halo')).toEqual([]);
    expect(server.calls).toEqual(['/api/history']);
  });
});

describe('Replay', () => {
  const visible = (id) => !!sceneNode(id);
  const strip = () => q('.hx-timeline');
  /** Replay's button: on the History row of the Layers menu (spec 0015 D6), not in the header */
  const replayBtn = () => q('.hx-row-action[data-action="history-replay"]');

  it('has its button on the History row of the Layers menu, only when history is on, and none in the header', () => {
    fakeServer();
    mount({ history: false, forge: FORGE });
    setProjectLayers(undefined); // the menu drawn
    expect(replayBtn()).toBe(null);
    stop();
    mount();
    setProjectLayers(undefined);
    const btn = replayBtn();
    expect(btn.textContent).toBe('Replay');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.closest('.hx-toggle-line').querySelector('[data-corn="row"]').dataset.layer).toBe('history-halos');
    expect(btn.closest('[data-corn="row"]')).toBe(null); // beside the row's toggle, not in it
    expect($('replay-btn')).toBe(null);
    expect(q('[data-corn="header"] [data-action="history-replay"]:not(.hx-row-action)')).toBe(null);
  });

  it('pressed, turns the History layer on, opens the timeline and closes the menu; pressed again, closes the timeline', async () => {
    fakeServer();
    mount();
    pageInstance().reducedMotion = true;
    setProjectLayers(undefined);
    expect(layerRows(pageInstance()).overlays.find((r) => r.key === 'history-halos')).toBeTruthy();
    expect(state.activeLayers['history-halos']).not.toBe(true);
    click(q('[data-action="toggle-layers-menu"]'));
    expect(q('[data-corn="layers-menu"]').hidden).toBe(false);
    click(replayBtn());
    await settle();
    expect(q('[data-corn="layers-menu"]').hidden).toBe(true);
    expect(state.activeLayers['history-halos']).toBe(true);
    expect(state.replay.at).toBe(0);
    expect(strip()).not.toBe(null);
    expect(replayBtn().getAttribute('aria-pressed')).toBe('true');
    click(replayBtn());
    expect(state.replay).toBe(null);
    expect(replayBtn().getAttribute('aria-pressed')).toBe('false');
    expect(state.activeLayers['history-halos']).toBe(true); // closing the timeline leaves the layer as it is
  });

  it('reads the history, then shows the map at its first commit and steps through it, the keyboard\'s playhead saying where it is', async () => {
    const server = fakeServer();
    mount();
    const inst = pageInstance();
    inst.reducedMotion = true; // nothing plays by itself, nothing buds
    const said = [];
    const offSaid = inst.on('announce', (t) => said.push(t));
    inst.emit('history:replay');
    await settle();
    render.renderNow();
    expect(server.calls).toEqual(['/api/history']);
    expect(replayBtn().getAttribute('aria-pressed')).toBe('true');
    expect(state.replay.at).toBe(0);
    expect(visible('core-auth')).toBe(true);
    expect(visible('core-db')).toBe(false); // born at the second commit
    const range = strip().querySelector('input[type="range"]');
    expect([range.min, range.max, range.value]).toEqual(['0', '2', '0']);
    expect(range.getAttribute('aria-valuetext')).toContain('Commit 1 of 3');
    expect(strip().querySelector('.hx-timeline-count').textContent).toBe('4 nodes · 3 edges · commit 1 of 3 · 4 born');
    expect(q('[data-replay="back"]').disabled).toBe(true);
    // a step forward: core-db is born, and the commit's nodes pulse (a still ring under reduced motion)
    click(q('[data-replay="forward"]'));
    render.renderNow();
    expect(visible('core-db')).toBe(true);
    expect(qa('.hx-replay-pulse').map((p) => p.dataset.node).sort()).toEqual(['core-auth', 'core-db', 'pkg-server']);
    expect(q('.hx-replay-pulses').classList.contains('is-static')).toBe(true);
    expect(strip().querySelector('.hx-timeline-line').textContent).toContain('Spec 0007');
    expect(said[said.length - 1]).toMatch(/^Commit 2 of 3, .+: feat\(auth\): sign-in <b>now<\/b>\. Born: db\.js\. Changed: auth\.js and server\. 5 nodes on the map\.$/);
    // scrubbing to the last commit, then Now: the map as it is
    range.value = '2';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    expect(state.historyAt).toBe(2);
    expect(q('[data-replay="forward"]').disabled).toBe(true);
    click(q('[data-replay="now"]'));
    expect(state.replay).toBe(null);
    expect(state.historyAt).toBe(null);
    expect(strip()).toBe(null);
    expect(replayBtn().getAttribute('aria-pressed')).toBe('false');
    expect(visible('core-db')).toBe(true);
    offSaid();
  });

  it('opens at a commit chosen in a node\'s History, paused', async () => {
    fakeServer();
    mount();
    pageInstance().reducedMotion = false;
    selectNode(pick('core-auth'));
    await settle();
    click(q('[data-history-at="1"]'));
    await settle();
    expect(state.replay.at).toBe(1);
    expect(q('[data-replay="play"]').getAttribute('aria-label')).toBe('Play');
    pageInstance().emit('history:replay');
    expect(state.replay).toBe(null);
  });
});


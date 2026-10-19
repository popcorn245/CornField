// @vitest-environment happy-dom
/**
 * The issues and PRs panel in a page (CF-07), through the page's own markup (explorer/index.html) with a fake server
 * behind `fetch` and a recording canvas: nothing appears without a forge; with one, the button opens the panel (focus
 * on its title, Escape closes it, inert while closed), the lists and their filters, links out, a pull request
 * selected asks for its files and checks and lights the nodes they are on the map, a file on no node is listed, a
 * failing check lights its tests, a node button selects the node, errors and rate limits are a line in words, and on a
 * phone the panel is a bottom sheet. Everything it does is said through the map's live region.
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
import { initForgePanel, resetForgePanelForTests, openForge, closeForge, refreshForge } from '../../explorer/forge-panel.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard, resetKeyboardForTests } from '../../explorer/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { initSheets, sheetState } from '../../explorer/sheets.js';
// @ts-expect-error plain JS modules, no declarations
import { closeDrawer } from '../../explorer/panels.js';

const page = fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');

const node = (id, type, file, extra = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, degree: 1, ...(file ? { file } : {}), ...extra });
const MAP = {
  nodes: [
    node('root', 'root', 'package.json'), node('pkg-server', 'pkg', 'server', { label: 'server' }), node('core-server', 'core', 'server/server.js', { label: 'server.js', parent: 'pkg-server' }),
    node('core-meals', 'core', 'server/meals.js', { label: 'meals.js', parent: 'pkg-server' }), node('tests-auth', 'core', 'test/server/auth.test.js', { label: 'auth.test.js' }),
  ],
  edges: [{ from: 'root', to: 'pkg-server' }, { from: 'pkg-server', to: 'core-server' }, { from: 'pkg-server', to: 'core-meals' }, { from: 'root', to: 'tests-auth' }],
};

const user = (login) => ({ login, url: `https://git.example.test/${login}` });
const pr = (number, title, extra = {}) => ({
  number, title, state: 'open', draft: false, author: user('agent-four'), labels: [], head: { ref: `branch-${number}`, sha: `sha${number}` }, base: { ref: 'main' },
  url: `https://git.example.test/owner/name/pull/${number}`, createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T11:00:00Z', mergedAt: null, ...extra,
});
const PULLS = {
  open: [pr(13, 'Lint everything', { labels: ['agent'] }), pr(12, 'Meals page'), pr(14, 'Half done', { draft: true, author: user('maintainer-one') })],
  closed: [pr(9, 'Old work', { state: 'merged', author: user('maintainer-one') }), pr(8, 'Dropped', { state: 'closed' })],
};
const issue = (number, title, extra = {}) => ({ number, title, state: 'open', author: user('maintainer-one'), labels: ['v1'], comments: 0, url: `https://git.example.test/owner/name/issues/${number}`, createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T12:00:00Z', closedAt: null, ...extra });
const DETAIL = {
  12: {
    pull: PULLS.open[1],
    files: [
      { path: 'server/server.js', status: 'modified', previousPath: null, additions: 3, deletions: 1 },
      { path: 'server/meals.js', status: 'added', previousPath: null, additions: 40, deletions: 0 },
      { path: 'docs/specs/proposals/0013-meals.json', status: 'added', previousPath: null, additions: 40, deletions: 0 },
    ],
    checks: [{ id: 'run:41', name: 'test', state: 'success', url: 'https://git.example.test/runs/41', rerunnable: false }],
  },
  13: {
    pull: PULLS.open[0],
    files: [{ path: 'server/server.js', status: 'modified', previousPath: null, additions: 2, deletions: 2 }],
    checks: [
      { id: 'run:42', name: 'vitest test/server/auth.test.js', state: 'failure', url: 'https://git.example.test/runs/42', rerunnable: true, canRerun: true },
      { id: 'run:43', name: 'lint', state: 'failure', url: null, rerunnable: false, canRerun: false },
      { id: 'run:44', name: 'build', state: 'running', url: null, rerunnable: false },
    ],
  },
};

const NOW = Date.parse('2026-10-19T12:00:00Z');
const $ = (id) => document.getElementById(id);
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (el, k) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const said = async () => { await new Promise((r) => setTimeout(r, 50)); return $('map-announcer').textContent; };
const choose = (id, value) => { const el = $(id); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
const rows = () => qa('#forge-list .hx-forge-item');

/** A fake server behind `fetch`: the forge routes, and a record of every call */
function fakeServer(opts = {}) {
  const calls = [];
  const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });
  const mock = vi.fn(async (url, init = {}) => {
    calls.push({ url, init });
    if (opts.down) throw new TypeError('Failed to fetch');
    const u = new URL(url, 'http://localhost');
    if (init.method === 'POST') {
      const answer = opts.posts && opts.posts[u.pathname];
      return answer ? json(answer.status ?? 200, answer.body) : json(404, { ok: false, error: 'No such action.' });
    }
    const override = opts.answers && opts.answers[u.pathname + u.search];
    if (override) return json(override.status ?? 200, override.body);
    const at = '2026-10-19T11:58:00.000Z';
    if (u.pathname === '/api/forge/pulls') return json(200, { ok: true, forge: 'github', repo: 'owner/name', at, rate: '4990 of 5000 GitHub calls left; the count resets at 12:30 UTC (in about 30 minutes).', items: PULLS[u.searchParams.get('state')] || [...PULLS.open, ...PULLS.closed] });
    if (u.pathname === '/api/forge/issues') return json(200, { ok: true, forge: 'github', repo: 'owner/name', at, rate: '', items: [issue(5, 'Sign-in'), issue(3, 'Forge adapters', { labels: [], author: user('agent-four') }), issue(4, 'Odd link', { url: 'javascript:alert(1)' })] });
    const one = /^\/api\/forge\/pulls\/(\d+)$/.exec(u.pathname);
    if (one && DETAIL[one[1]]) return json(200, { ok: true, forge: 'github', repo: 'owner/name', at, rate: '', ...DETAIL[one[1]] });
    return json(404, { ok: false, error: `GitHub has no pull request #${one ? one[1] : '?'} in owner/name, or this sign-in cannot see it.`, code: 'not-found' });
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock, urls: () => calls.map((c) => c.url) };
}

function mount({ forge = { type: 'github', url: 'https://github.com', repo: 'owner/name' }, signIn = { login: 'maintainer-one' } } = {}) {
  document.body.innerHTML = body;
  document.documentElement.lang = 'en';
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = $('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, labelCanvas: null, proposal: null, view: 'orbit', selectedNode: null, isFreeform: false, scenario: null, searchQuery: '', forgeLit: null });
  state.camera = { x: 0, y: 0, zoom: 1 };
  render.resize();
  state.baseNodes = MAP.nodes.map((n) => ({ ...n }));
  state.baseEdges = MAP.edges;
  setMap(MAP.nodes.map((n) => ({ ...n })), MAP.edges);
  resetKeyboardForTests();
  initKeyboard();
  initSheets();
  resetForgePanelForTests(() => NOW);
  return initForgePanel({ forge, signIn }, { clock: () => NOW });
}

const sceneNode = (id) => render.getScene().nodes.find((n) => n.id === id);

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { closeForge({ restoreFocus: false }); closeDrawer(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('with no forge in the config', () => {
  it('shows nothing, asks nothing, and the page is as it was', async () => {
    const server = fakeServer();
    expect(mount({ forge: null })).toBe(false);
    expect($('forge-btn').hidden).toBe(true);
    expect($('forge-panel').hidden).toBe(true);
    expect($('forge-panel').inert).toBe(true);
    openForge();
    expect($('forge-panel').classList.contains('forge-open')).toBe(false);
    expect(server.calls).toEqual([]);
    expect(state.forgeLit).toBe(null);
  });
});

describe('with a forge but nobody signed in (Stage 1)', () => {
  it('shows nothing and asks nothing: the server has nobody to ask the forge as', async () => {
    const server = fakeServer();
    expect(mount({ signIn: false })).toBe(false);
    expect($('forge-btn').hidden).toBe(true);
    expect($('forge-panel').hidden).toBe(true);
    openForge();
    expect($('forge-panel').classList.contains('forge-open')).toBe(false);
    expect(server.calls).toEqual([]);
  });
});

describe('opening and closing', () => {
  it('a button opens the panel with the focus on its title, loads the pull requests, and says so', async () => {
    const server = fakeServer();
    expect(mount()).toBe(true);
    expect($('forge-btn').hidden).toBe(false);
    expect($('forge-btn').getAttribute('aria-expanded')).toBe('false');
    expect($('forge-panel').inert).toBe(true);
    click($('forge-btn'));
    await settle();
    expect($('forge-panel').inert).toBe(false);
    expect($('forge-panel').classList.contains('forge-open')).toBe(true);
    expect($('forge-btn').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe($('forge-title'));
    expect(server.urls()).toEqual(['/api/forge/pulls?state=open&limit=100']);
    expect(rows().map((r) => r.querySelector('.hx-forge-title').textContent)).toEqual(['Lint everything', 'Meals page', 'Half done']);
    expect($('forge-status').textContent).toBe('3 of 3 pull requests, as of 2 minutes ago');
    expect($('forge-rate').textContent).toMatch(/^4990 of 5000 GitHub calls left/);
    expect(await said()).toBe('3 pull requests shown');
  });

  it('Escape closes it, gives the button the focus back and inerts the panel; the second open does not ask again', async () => {
    const server = fakeServer();
    mount();
    click($('forge-btn'));
    await settle();
    expect(key($('forge-title'), 'Escape').defaultPrevented).toBe(true);
    expect($('forge-panel').inert).toBe(true);
    expect($('forge-panel').classList.contains('forge-open')).toBe(false);
    expect(document.activeElement).toBe($('forge-btn'));
    expect($('forge-btn').getAttribute('aria-expanded')).toBe('false');
    expect(await said()).toBe('Issues and pull requests closed');
    click($('forge-btn'));
    await settle();
    expect(server.calls).toHaveLength(1);
    click(q('[data-action="close-forge"]'));
    expect($('forge-panel').inert).toBe(true);
    expect(document.activeElement).toBe($('forge-btn'));
  });

  it('a field keeps its own Escape', async () => {
    fakeServer();
    mount();
    openForge();
    await settle();
    expect(key($('forge-text'), 'Escape').defaultPrevented).toBe(false);
    expect($('forge-panel').classList.contains('forge-open')).toBe(true);
  });
});

describe('the lists and their filters', () => {
  it('lists each pull request with its state, who and when, labels, and a link out to the forge', async () => {
    fakeServer();
    mount();
    openForge();
    await settle();
    const [lint, , draft] = rows();
    expect(lint.querySelector('.hx-forge-meta').textContent).toBe('Open #13 · agent-four · 2 days ago');
    expect([...lint.querySelectorAll('.hx-forge-label')].map((l) => l.textContent)).toEqual(['agent']);
    expect(draft.querySelector('.hx-forge-state').textContent).toBe('Draft');
    const out = lint.querySelector('a.hx-forge-out');
    expect(out.getAttribute('href')).toBe('https://git.example.test/owner/name/pull/13');
    expect(out.getAttribute('target')).toBe('_blank');
    expect(out.getAttribute('rel')).toBe('noreferrer');
    expect(out.getAttribute('aria-label')).toBe('Open pull request 13 on GitHub (new tab)');
  });

  it('filters by state (merged asks for the closed ones), label, author and a search, and says how many', async () => {
    const server = fakeServer();
    mount();
    openForge();
    await settle();
    choose('forge-author', 'maintainer-one');
    expect(rows().map((r) => r.querySelector('.hx-forge-title').textContent)).toEqual(['Half done']);
    expect($('forge-status').textContent).toMatch(/^1 of 3 pull requests/);
    expect(await said()).toBe('1 of 3 pull requests shown');
    choose('forge-author', '');
    choose('forge-label', 'agent');
    expect(rows()).toHaveLength(1);
    choose('forge-label', '');
    $('forge-text').value = 'meals';
    $('forge-text').dispatchEvent(new Event('input', { bubbles: true }));
    expect(rows().map((r) => r.querySelector('.hx-forge-title').textContent)).toEqual(['Meals page']);
    $('forge-text').value = 'nothing like it';
    $('forge-text').dispatchEvent(new Event('input', { bubbles: true }));
    expect(q('.hx-forge-empty').textContent).toBe('No pull request matches these filters.');
    $('forge-text').value = '';
    $('forge-text').dispatchEvent(new Event('input', { bubbles: true }));
    choose('forge-state', 'merged');
    await settle();
    expect(server.urls().at(-1)).toBe('/api/forge/pulls?state=closed&limit=100');
    expect(rows().map((r) => r.querySelector('.hx-forge-title').textContent)).toEqual(['Old work']);
    choose('forge-state', 'closed');
    expect(rows().map((r) => r.querySelector('.hx-forge-title').textContent)).toEqual(['Dropped']);
    expect(server.calls).toHaveLength(2); // merged and closed share one list
    expect([...$('forge-state').options].map((o) => o.textContent)).toEqual(['Open', 'Merged', 'Closed', 'All']);
  });

  it('the issues are links out; a link that is not the forge\'s web address is not a link', async () => {
    const server = fakeServer();
    mount();
    openForge();
    await settle();
    click(q('[data-forge-kind="issues"]'));
    await settle();
    expect(server.urls().at(-1)).toBe('/api/forge/issues?state=open&limit=100');
    expect(q('[data-forge-kind="issues"]').getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-forge-kind="pulls"]').getAttribute('aria-pressed')).toBe('false');
    expect([...$('forge-state').options].map((o) => o.textContent)).toEqual(['Open', 'Closed', 'All']);
    const links = qa('#forge-list a.hx-forge-row');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://git.example.test/owner/name/issues/5', 'https://git.example.test/owner/name/issues/3']);
    expect(links[0].textContent).toContain('Sign-in');
    expect(rows()[2].querySelector('a')).toBe(null);
    expect(rows()[2].textContent).toContain('Odd link');
    choose('forge-label', 'v1');
    expect(rows().map((r) => r.querySelector('.hx-forge-title').textContent)).toEqual(['Sign-in', 'Odd link']);
    click(q('[data-forge-kind="pulls"]'));
    expect(rows()).toHaveLength(3);
    expect($('forge-label').value).toBe(''); // a kind starts with its own filters
  });
});

describe('a pull request lights the map', () => {
  async function select(n) {
    q(`[data-forge-pr="${n}"]`).focus();
    click(q(`[data-forge-pr="${n}"]`));
    await settle();
  }

  it('asks for its files and checks and lights the nodes the files are; the rest fades back', async () => {
    const server = fakeServer();
    mount();
    openForge();
    await settle();
    await select(12);
    expect(server.urls().at(-1)).toBe('/api/forge/pulls/12');
    expect(q('[data-forge-pr="12"]').getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(q('[data-forge-pr="12"]')); // the row kept the focus through the redraw
    expect([...state.forgeLit.changed].sort()).toEqual(['core-meals', 'core-server']);
    expect(sceneNode('core-server')).toMatchObject({ alpha: 1, halo: 'match' });
    expect(sceneNode('core-meals')).toMatchObject({ alpha: 1, halo: 'match' });
    expect(sceneNode('root').alpha).toBeLessThan(0.5);
    expect($('forge-btn-lit').textContent).toBe('#12');
    expect($('forge-btn').getAttribute('aria-label')).toBe('Issues and pull requests, pull request 12 selected');
    expect(await said()).toBe('Pull request 12, Meals page: 3 files, 2 on the map, 2 nodes lit. 1 check passed.');
  });

  it('lists every file, one on no node too, each node with a button; and the checks with their words', async () => {
    fakeServer();
    mount();
    openForge();
    await settle();
    await select(12);
    const files = qa('.hx-forge-file');
    expect(files.map((f) => f.querySelector('code').textContent)).toEqual(['server/server.js', 'server/meals.js', 'docs/specs/proposals/0013-meals.json']);
    expect(files[0].textContent).toContain('modified');
    expect(files[0].textContent).toContain('+3');
    expect(files[0].textContent).toContain('−1');
    expect(files[0].querySelector('button').textContent).toBe('server.js');
    expect(files[2].textContent).toContain('not on the map');
    expect(files[2].querySelector('button')).toBe(null);
    expect(q('.hx-forge-sub').textContent).toBe('Checks: 1 check passed');
    expect(qa('.hx-forge-sub')[1].textContent).toBe('3 files changed, 2 on the map');
    expect(q('.hx-forge-check').textContent).toContain('passed');
    expect(q('.hx-forge-check a').getAttribute('href')).toBe('https://git.example.test/runs/41');
    expect(q('.hx-forge-detail-title').textContent).toBe('#12 Meals page');
    expect(q('#forge-detail .hx-link[href="https://git.example.test/owner/name/pull/12"]').textContent).toBe('Open on GitHub ↗');
  });

  it('a failing check lights the test files it names, red; one that names none says so', async () => {
    fakeServer();
    mount();
    openForge();
    await settle();
    await select(13);
    expect([...state.forgeLit.failing]).toEqual(['tests-auth']);
    expect(sceneNode('tests-auth')).toMatchObject({ alpha: 1, halo: 'match', color: '#f87171' });
    const checks = qa('.hx-forge-check');
    expect(checks.map((c) => c.querySelector('.hx-forge-state').textContent)).toEqual(['failed', 'failed', 'running']);
    expect(checks[0].querySelector('.hx-forge-lights').textContent).toBe('Lights test/server/auth.test.js');
    expect(checks[1].querySelector('.hx-forge-lights').textContent).toBe('Names no test file, so lights nothing');
    expect(checks[2].querySelector('.hx-forge-lights')).toBe(null);
    expect(q('.hx-forge-sub').textContent).toBe('Checks: 2 failed, 1 still running');
    expect(q('.hx-forge-key')).not.toBe(null);
    expect(await said()).toMatch(/1 file, 1 on the map, 2 nodes lit\. 2 failed, 1 still running\.$/);
  });

  it('a node button selects the node on the map, and says it', async () => {
    fakeServer();
    mount();
    openForge();
    await settle();
    await select(12);
    click(q('[data-forge-node="core-meals"]'));
    await settle();
    expect(state.selectedNode.id).toBe('core-meals');
    expect($('spec-drawer').classList.contains('drawer-open')).toBe(true);
    expect(await said()).toBe('meals.js, core');
  });

  it('picking it again, or Clear, lets go: nothing lit, the focus on the panel\'s title', async () => {
    fakeServer();
    mount();
    openForge();
    await settle();
    await select(12);
    click(q('[data-forge-pr="12"]'));
    expect(state.forgeLit).toBe(null);
    expect($('forge-detail').hidden).toBe(true);
    expect($('forge-btn-lit').hidden).toBe(true);
    expect(sceneNode('root').alpha).toBe(1);
    await select(13);
    click(q('[data-action="clear-forge-pr"]'));
    expect(state.forgeLit).toBe(null);
    expect(document.activeElement).toBe($('forge-title'));
    expect(await said()).toBe('Pull request 13 cleared');
  });

  it('closing the panel leaves the lights, which the button names', async () => {
    fakeServer();
    mount();
    openForge();
    await settle();
    await select(12);
    closeForge();
    expect(state.forgeLit).not.toBe(null);
    expect($('forge-btn-lit').textContent).toBe('#12');
  });

  it('follows the map when its nodes change (a proposal opening)', async () => {
    fakeServer();
    mount();
    openForge();
    await settle();
    await select(12);
    expect(state.forgeLit.changed.has('core-server')).toBe(true);
    setMap(MAP.nodes.filter((n) => n.id !== 'core-server').map((n) => ({ ...n })), MAP.edges.filter((e) => e.to !== 'core-server'));
    expect([...state.forgeLit.changed].sort()).toEqual(['core-meals', 'pkg-server']);
    expect(qa('.hx-forge-file')[0].querySelector('button').textContent).toBe('server');
  });

  it('a pull request that touches no node lights nothing and leaves the map as it was', async () => {
    fakeServer({ answers: { '/api/forge/pulls/14': { body: { ok: true, at: '2026-10-19T11:58:00.000Z', rate: '', pull: PULLS.open[2], files: [{ path: 'README.md', status: 'modified', previousPath: null, additions: 1, deletions: 0 }], checks: [] } } } });
    mount();
    openForge();
    await settle();
    await select(14);
    expect(state.forgeLit.changed.size).toBe(0);
    expect(sceneNode('root').alpha).toBe(1);
    expect(q('.hx-forge-file').textContent).toContain('not on the map');
    expect(q('.hx-forge-sub').textContent).toBe('Checks: No checks');
    expect(q('.hx-forge-key')).toBe(null);
  });
});

describe('when the forge or the server cannot answer', () => {
  it('says a rate limit in the server\'s words, and keeps the panel usable', async () => {
    fakeServer({ answers: { '/api/forge/pulls?state=open&limit=100': { status: 429, body: { ok: false, error: 'GitHub\'s limit for this sign-in is used up; it resets at 21:14 UTC (in about 6 minutes).', code: 'rate-limited' } } } });
    mount();
    openForge();
    await settle();
    expect($('forge-notice').hidden).toBe(false);
    expect($('forge-notice').textContent).toBe('GitHub\'s limit for this sign-in is used up; it resets at 21:14 UTC (in about 6 minutes).');
    expect(rows()).toHaveLength(0);
    expect(await said()).toBe($('forge-notice').textContent);
  });

  it('says an older answer is older, with why', async () => {
    fakeServer({ answers: { '/api/forge/pulls?state=open&limit=100': { body: { ok: true, at: '2026-10-19T09:00:00.000Z', rate: '', stale: 'GitHub did not answer within 15 seconds; try again in a minute.', items: PULLS.open } } } });
    mount();
    openForge();
    await settle();
    expect($('forge-notice').textContent).toBe('Showing an older answer. GitHub did not answer within 15 seconds; try again in a minute.');
    expect($('forge-status').textContent).toBe('3 of 3 pull requests, as of 3 hours ago');
    expect(rows()).toHaveLength(3);
  });

  it('says a sign-in that ended, and a server that is gone', async () => {
    fakeServer({ answers: { '/api/forge/pulls?state=open&limit=100': { status: 401, body: { ok: false, error: 'Sign in first.' } } } });
    mount();
    openForge();
    await settle();
    expect($('forge-notice').textContent).toMatch(/^Your sign-in has ended/);
    closeForge({ restoreFocus: false });
    fakeServer({ down: true });
    mount();
    openForge();
    await settle();
    expect($('forge-notice').textContent).toMatch(/could not be reached/);
  });

  it('a pull request that cannot be read says why in its place, and lights nothing', async () => {
    fakeServer();
    mount();
    openForge();
    await settle();
    click(q('[data-forge-pr="12"]'));
    await settle();
    expect(state.forgeLit).not.toBe(null);
    fakeServer({ answers: { '/api/forge/pulls/13': { status: 404, body: { ok: false, error: 'GitHub has no pull request #13 in owner/name, or this sign-in cannot see it.' } } } });
    click(q('[data-forge-pr="13"]'));
    await settle();
    expect(state.forgeLit).toBe(null);
    expect(q('#forge-detail .hx-forge-notice').textContent).toBe('GitHub has no pull request #13 in owner/name, or this sign-in cannot see it.');
  });

  it('Refresh asks again past the server\'s cache, the list and the selected pull request', async () => {
    const server = fakeServer();
    mount();
    openForge();
    await settle();
    click(q('[data-forge-pr="12"]'));
    await settle();
    server.calls.length = 0;
    click(q('[data-action="refresh-forge"]'));
    await settle();
    expect(server.urls()).toEqual(['/api/forge/pulls?state=open&limit=100', '/api/forge/pulls/12']);
    expect(server.calls.map((c) => c.init.cache)).toEqual(['reload', 'reload']);
    await refreshForge();
    expect(await said()).not.toBe('');
  });
});

describe('on a phone', () => {
  const phone = (matches) => vi.stubGlobal('matchMedia', (query) => ({ matches: matches && /max-width: 767px/.test(query), media: query, addEventListener() {}, removeEventListener() {} }));

  it('is a bottom sheet in the dock: expanded when opened, a peek when collapsed, and not there when closed', async () => {
    phone(true);
    fakeServer();
    mount();
    expect($('forge-panel').parentElement.id).toBe('sheet-dock');
    expect(sheetState('forge')).toBe('peek');
    expect($('forge-panel').querySelector('.hx-sheet-handle')).not.toBe(null);
    openForge();
    await settle();
    expect(sheetState('forge')).toBe('expanded');
    expect($('forge-panel').dataset.sheetState).toBe('expanded');
    expect($('forge-panel').querySelector('.hx-sheet-handle').getAttribute('aria-expanded')).toBe('true');
    click($('forge-panel').querySelector('.hx-sheet-handle'));
    expect(sheetState('forge')).toBe('peek');
    click($('forge-panel').querySelector('.hx-sheet-handle'));
    expect(sheetState('forge')).toBe('expanded');
    closeForge();
    expect(sheetState('forge')).toBe('peek');
    expect($('forge-panel').inert).toBe(true);
  });

  it('a node button collapses the sheet so the map and the node\'s own sheet show', async () => {
    phone(true);
    fakeServer();
    mount();
    openForge();
    await settle();
    click(q('[data-forge-pr="12"]'));
    await settle();
    click(q('[data-forge-node="core-server"]'));
    await settle();
    expect(sheetState('forge')).toBe('peek');
    expect(state.selectedNode.id).toBe('core-server');
  });
});

describe('actions: landing a green pull request and re-running a failed check', () => {
  const LANDED = { status: 200, body: { ok: true, merged: true, number: 12, sha: 'fff0000000000000000000000000000000000000', head: 'sha12' } };
  const mockCalls = () => /** @type {any} */ (globalThis.fetch).mock.calls.map(([url, init]) => ({ url, init: init || {} }));
  const posts = () => mockCalls().filter((c) => c.init.method === 'POST');

  const select = async (n) => {
    openForge();
    await settle();
    click(q(`[data-forge-pr="${n}"]`));
    await settle();
  };

  it('a green, open, ready pull request has Land it; the others say why not, in words', async () => {
    fakeServer();
    mount();
    await select(12);
    expect(q('[data-forge-merge]').textContent).toBe('Land it …');
    expect(qa('.hx-forge-why')[0].textContent).toMatch(/Never forced, never deployed/);
    click(q('[data-action="clear-forge-pr"]'));
    click(q('[data-forge-pr="13"]'));
    await settle();
    expect(q('[data-forge-merge]')).toBe(null);
    expect(q('.hx-forge-detail .hx-forge-why').textContent).toBe('Cannot be landed from here. Not every check is green: vitest test/server/auth.test.js failed; lint failed; build is still running.');
  });

  it('a draft says it is a draft', async () => {
    fakeServer({ answers: { '/api/forge/pulls/14': { body: { ok: true, pull: PULLS.open[2], files: [], checks: [{ id: 'run:1', name: 'test', state: 'success', url: null, rerunnable: false, canRerun: false }] } } } });
    mount();
    await select(14);
    expect(q('[data-forge-merge]')).toBe(null);
    expect(q('.hx-forge-detail .hx-forge-why').textContent).toBe('Cannot be landed from here. It is a draft: mark it ready on the forge first.');
  });

  it('Land it opens a confirm dialog that shows exactly what will land, announced, with the focus on Cancel', async () => {
    fakeServer();
    mount();
    await select(12);
    click(q('[data-forge-merge]'));
    const dialog = q('#forge-confirm [role="dialog"]');
    expect($('forge-confirm').hidden).toBe(false);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('forge-confirm-title');
    expect($('forge-confirm-title').textContent).toBe('Land pull request #12?');
    const facts = qa('#forge-confirm dt').map((dt) => [dt.textContent, dt.nextElementSibling.textContent]);
    expect(facts).toEqual([
      ['Pull request', '#12 Meals page'], ['Commit', 'sha12'], ['From', 'branch-12'], ['Into', 'main'], ['How', 'A merge commit, made by GitHub'], ['Checks', '1 check passed'],
    ]);
    expect(qa('#forge-confirm .hx-confirm-checks li').map((li) => li.textContent.trim())).toEqual(['passed test']);
    expect($('forge-confirm').textContent).toMatch(/Nothing is deployed/);
    expect(document.activeElement).toBe(q('[data-action="forge-confirm-cancel"]'));
    expect(await said()).toMatch(/^Land pull request #12\? Pull request: #12 Meals page\. Commit: sha12\./);
    expect(posts()).toEqual([]);
  });

  it('the focus cannot leave the dialog; Escape or Cancel closes it, the focus back on the button', async () => {
    fakeServer();
    mount();
    await select(12);
    click(q('[data-forge-merge]'));
    $('forge-btn').focus();
    expect(document.activeElement).toBe(q('[data-action="forge-confirm-cancel"]'));
    expect(key(q('[data-action="forge-confirm-cancel"]'), 'Escape').defaultPrevented).toBe(true);
    expect($('forge-confirm').hidden).toBe(true);
    $('forge-btn').focus();
    expect(document.activeElement).toBe($('forge-btn'));
    q('[data-forge-merge]').focus();
    expect(document.activeElement).toBe(q('[data-forge-merge]'));
    click(q('[data-forge-merge]'));
    click(q('[data-action="forge-confirm-cancel"]'));
    expect($('forge-confirm').hidden).toBe(true);
    expect(document.activeElement).toBe(q('[data-forge-merge]'));
    expect(posts()).toEqual([]);
  });

  it('Tab stays inside the dialog, both ways, and a map key does not reach the map', async () => {
    fakeServer();
    mount();
    await select(12);
    click(q('[data-forge-merge]'));
    const cancel = q('[data-action="forge-confirm-cancel"]');
    const go = q('[data-action="forge-confirm-go"]');
    const tab = (el, shiftKey = false) => { const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };
    expect(tab(cancel).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(go);
    tab(go);
    expect(document.activeElement).toBe(cancel);
    tab(cancel, true);
    expect(document.activeElement).toBe(go);
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    key(go, 'ArrowLeft');
    document.removeEventListener('keydown', seen);
    expect(seen).not.toHaveBeenCalled();
  });

  it('confirming posts the head that was shown, says it landed, and looks at the forge again', async () => {
    const server = fakeServer({ posts: { '/api/forge/pulls/12/merge': LANDED } });
    mount();
    await select(12);
    click(q('[data-forge-merge]'));
    click(q('[data-action="forge-confirm-go"]'));
    await settle();
    const sent = posts();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('/api/forge/pulls/12/merge');
    expect(JSON.parse(sent[0].init.body)).toEqual({ sha: 'sha12' });
    expect(sent[0].init.headers['Content-Type']).toBe('application/json');
    expect($('forge-confirm').hidden).toBe(true);
    expect(q('.hx-forge-detail .hx-forge-notice').textContent).toBe('Pull request #12 landed as fff0000.');
    expect(await said()).toBe('Pull request #12 landed as fff0000.');
    expect(server.urls().filter((u) => u === '/api/forge/pulls/12')).toHaveLength(2);
  });

  it('three clicks on Land it send one request', async () => {
    fakeServer({ posts: { '/api/forge/pulls/12/merge': LANDED } });
    mount();
    await select(12);
    click(q('[data-forge-merge]'));
    const go = q('[data-action="forge-confirm-go"]');
    click(go);
    click(go);
    click(go);
    await settle();
    expect(posts()).toHaveLength(1);
  });

  it('a refusal is said in the server\'s words and nothing is shown as landed', async () => {
    fakeServer({ posts: { '/api/forge/pulls/12/merge': { status: 409, body: { ok: false, code: 'conflict', error: 'Pull request #12 has changed since it was looked at (its head is now abc0000); look again before landing it.' } } } });
    mount();
    await select(12);
    click(q('[data-forge-merge]'));
    click(q('[data-action="forge-confirm-go"]'));
    await settle();
    expect(q('.hx-forge-detail .hx-forge-notice').textContent).toBe('Pull request #12 was not landed: Pull request #12 has changed since it was looked at (its head is now abc0000); look again before landing it.');
    expect(q('.hx-forge-detail .hx-forge-notice--ok')).toBe(null);
    expect(await said()).toMatch(/^Pull request #12 was not landed/);
  });

  it('a server that is gone is said, and the panel does not claim it landed', async () => {
    const server = fakeServer({ posts: { '/api/forge/pulls/12/merge': LANDED } });
    mount();
    await select(12);
    click(q('[data-forge-merge]'));
    server.mock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    click(q('[data-action="forge-confirm-go"]'));
    await settle();
    expect(q('.hx-forge-detail .hx-forge-notice').textContent).toBe('Pull request #12 was not landed: cornfield could not be reached. Look at the forge before trying again.');
  });

  it('a failed check the forge can re-run has Re-run, which posts the head and the check; one it cannot says why', async () => {
    fakeServer({ posts: { '/api/forge/pulls/13/rerun': { status: 202, body: { ok: true, rerun: true, number: 13, check: 'run:42', name: 'vitest test/server/auth.test.js' } } } });
    mount();
    await select(13);
    const buttons = qa('[data-forge-rerun]');
    expect(buttons.map((b) => b.dataset.forgeRerun)).toEqual(['run:42']);
    expect(buttons[0].getAttribute('aria-label')).toBe('Re-run vitest test/server/auth.test.js');
    const checks = qa('.hx-forge-check');
    expect(checks[1].textContent).toMatch(/GitHub does not let cornfield re-run this one: re-run it there\./);
    expect(checks[2].querySelector('button')).toBe(null);
    expect(checks[2].textContent).not.toMatch(/re-run/);
    click(buttons[0]);
    await settle();
    const sent = posts();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('/api/forge/pulls/13/rerun');
    expect(JSON.parse(sent[0].init.body)).toEqual({ sha: 'sha13', check: 'run:42' });
    expect(q('.hx-forge-detail .hx-forge-notice').textContent).toBe('vitest test/server/auth.test.js is running again.');
    expect(await said()).toBe('vitest test/server/auth.test.js is running again.');
  });

  it('a passing check has no Re-run and nothing to explain', async () => {
    fakeServer();
    mount();
    await select(12);
    expect(q('[data-forge-rerun]')).toBe(null);
    expect(q('.hx-forge-check').textContent).not.toMatch(/re-run/i);
  });

  it('the buttons are real buttons, in the tab order', async () => {
    fakeServer();
    mount();
    await select(12);
    const merge = q('[data-forge-merge]');
    expect([merge.tagName, merge.getAttribute('type'), merge.tabIndex]).toEqual(['BUTTON', 'button', 0]);
  });
});

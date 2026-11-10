// @vitest-environment happy-dom
/**
 * The Threads tab of the issues and PRs panel, and a node's "Mentioned in" (docs/threads.md), through the page's own markup
 * (explorer/index.html) with a fake server behind `fetch`: the tab lists ideas and spec conversations newest activity first;
 * opening a thread shows its messages read-only with a link out to reply, and lights the nodes its text mentions (the same
 * paint path a pull request uses) while a mention that is on no node stays text; a node's panel lists the threads that mention
 * it and opens one; "New idea" posts to cornfield's own server and says what came of it. The server side is
 * test/server/threads-routes.test.js; the accessibility pass is in a11y.test.js.
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
import { initSheets } from '../../explorer/sheets.js';
// @ts-expect-error plain JS modules, no declarations
import { closeDrawer, selectNode } from '../../explorer/panels.js';

const page = fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');

const node = (id, type, file, extra = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, degree: 1, ...(file ? { file } : {}), ...extra });
const MAP = {
  nodes: [
    node('root', 'root', 'package.json'), node('pkg-server', 'pkg', 'server', { label: 'server' }),
    node('core-auth', 'core', 'server/auth.js', { label: 'auth.js', parent: 'pkg-server' }), node('core-hooks', 'core', 'server/hooks.js', { label: 'hooks.js', parent: 'pkg-server' }),
    node('core-db', 'core', 'server/db.js', { label: 'db.js', parent: 'pkg-server' }),
  ],
  edges: [{ from: 'root', to: 'pkg-server' }, { from: 'pkg-server', to: 'core-auth' }, { from: 'pkg-server', to: 'core-hooks' }, { from: 'pkg-server', to: 'core-db' }],
};

const user = (login) => ({ login, url: `https://git.example.test/${login}` });
const URL_OF = (n) => `https://git.example.test/owner/name/issues/${n}`;
const THREADS = [
  { kind: 'idea', number: 41, title: 'Rework sign-in', state: 'open', author: user('maintainer-one'), labels: ['idea'], url: URL_OF(41), createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-19T11:00:00Z', comments: 2, refs: ['server/auth.js', 'core-hooks', 'nowhere.md'], proposals: [{ pull: 40, slug: '0040-meals' }] },
  { kind: 'proposal', number: 40, title: 'Spec: Meals', state: 'open', author: user('agent-four'), labels: [], url: 'https://git.example.test/owner/name/pull/40', createdAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-19T11:30:00Z', comments: 1, refs: ['server/hooks.js'], slugs: ['0040-meals'], idea: 41 },
  { kind: 'idea', number: 42, title: 'A quiet one', state: 'open', author: user('agent-four'), labels: ['idea'], url: URL_OF(42), createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z', comments: 0, refs: [] },
];
const msg = (id, who, text, extra = {}) => ({ id, author: user(who), url: `${URL_OF(41)}#c${id}`, createdAt: '2026-10-18T09:00:00Z', updatedAt: '2026-10-18T09:00:00Z', body: text, ...extra });
const DETAIL = {
  41: { kind: 'idea', number: 41, title: 'Rework sign-in', state: 'open', author: user('maintainer-one'), url: URL_OF(41), labels: ['idea'], createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-19T11:00:00Z', hidden: 0,
    proposals: [{ pull: 40, slug: '0040-meals' }],
    messages: [
      msg('opening', 'maintainer-one', 'Thinking about [[server/auth.js]] and [[nowhere.md]].\n\nSecond line stays.', { opening: true }),
      msg('9101', 'agent-four', 'The hooks too: [[core-hooks]]. In code `[[core-db]]` is not a link.\n```\n[[core-db]]\n```'),
      msg('9102', 'reviewer-one', '<b>not markup</b> & no mention'),
    ] },
  40: { kind: 'proposal', number: 40, title: 'Spec: Meals', state: 'open', author: user('agent-four'), url: 'https://git.example.test/owner/name/pull/40', labels: [], createdAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-19T11:30:00Z', hidden: 0, slugs: ['0040-meals'], idea: 41,
    messages: [msg('9201', 'maintainer-one', 'Looks right: [[server/hooks.js]]')] },
};

const NOW = Date.parse('2026-10-19T12:00:00Z');
const $ = (id) => document.getElementById(id);
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const said = async () => { await new Promise((r) => setTimeout(r, 50)); return $('map-announcer').textContent; };
const rows = () => qa('#forge-list .hx-forge-item');
const sceneNode = (id) => render.getScene().nodes.find((n) => n.id === id);

/** A fake server behind `fetch`: the forge routes the Threads tab uses, and a record of every call */
function fakeServer(opts = {}) {
  const calls = [];
  const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });
  const mock = vi.fn(async (url, init = {}) => {
    calls.push({ url, init });
    if (opts.down) throw new TypeError('Failed to fetch');
    const u = new URL(url, 'http://localhost');
    const at = '2026-10-19T11:58:00.000Z';
    if (init.method === 'POST') {
      const answer = opts.posts && opts.posts[u.pathname];
      return answer ? json(answer.status ?? 200, answer.body) : json(404, { ok: false, error: 'No such action.' });
    }
    if (u.pathname === '/api/agent-runs') return opts.runs ? json(200, { ok: true, runs: opts.runs, open: opts.runs.filter((r) => r.open).length, maxOpen: 3, profiles: [], runners: 0 }) : json(404, { ok: false, error: 'No such route.' });
    if (u.pathname === '/api/forge/threads') return json(200, { ok: true, forge: 'github', repo: 'owner/name', at, rate: '', label: 'idea', problem: opts.problem || null, items: opts.threads || THREADS });
    const one = /^\/api\/forge\/threads\/(\d+)$/.exec(u.pathname);
    if (one && DETAIL[one[1]]) return json(200, { ok: true, forge: 'github', repo: 'owner/name', at, rate: '', thread: opts.detail ? opts.detail(DETAIL[one[1]]) : DETAIL[one[1]] });
    if (one) return json(404, { ok: false, error: `#${one[1]} is not a thread: an idea is an issue labelled "idea", and a proposal's thread is its spec pull request.`, code: 'not-found' });
    if (u.pathname === '/api/forge/pulls') return json(200, { ok: true, forge: 'github', repo: 'owner/name', at, rate: '', items: [{ number: 12, title: 'Meals page', state: 'open', draft: false, author: user('agent-four'), labels: [], head: { ref: 'b', sha: 's' }, base: { ref: 'main' }, url: 'https://git.example.test/pull/12', createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T11:00:00Z', mergedAt: null }] });
    if (u.pathname === '/api/forge/pulls/12') return json(200, { ok: true, forge: 'github', repo: 'owner/name', at, rate: '', pull: { number: 12, title: 'Meals page', state: 'open', draft: false, author: user('agent-four'), labels: [], head: { ref: 'b', sha: 's' }, base: { ref: 'main' }, url: 'https://git.example.test/pull/12', createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T11:00:00Z', mergedAt: null }, files: [{ path: 'server/db.js', status: 'modified', previousPath: null, additions: 1, deletions: 1 }], checks: [] });
    return json(404, { ok: false, error: 'No such route.' });
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock, urls: () => calls.map((c) => c.url), posts: () => calls.filter((c) => c.init.method === 'POST') };
}

function mount({ forge = { type: 'github', url: 'https://github.com', repo: 'owner/name' }, threads = { label: 'idea' }, signIn = { login: 'maintainer-one' } } = {}) {
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
  return initForgePanel({ forge, signIn, ...(threads === undefined ? {} : { threads }) }, { clock: () => NOW });
}
const openThreads = async () => {
  openForge({ tab: 'pulls' });
  await settle();
  click(q('[data-forge-kind="threads"]'));
  await settle();
};

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { closeForge({ restoreFocus: false }); closeDrawer(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('the Threads tab', () => {
  it('lists ideas and spec conversations, newest activity first, each with its kind and a way out', async () => {
    const server = fakeServer();
    mount();
    await openThreads();
    expect(server.urls()).toEqual(['/api/forge/pulls?state=open&limit=100', '/api/forge/threads?state=open&limit=100', '/api/agent-runs']); // the runs, once, for the rows' run state
    expect(rows().map((r) => r.querySelector('.hx-forge-title').textContent)).toEqual(['Rework sign-in', 'Spec: Meals', 'A quiet one']);
    expect(qa('[data-thread-run]')).toEqual([]); // no run is about any of them
    const first = rows()[0];
    expect(first.textContent).toContain('Idea');
    expect(first.textContent).toContain('#41 · maintainer-one · 2 comments');
    expect(first.textContent).toContain('Proposal 0040-meals');
    expect(rows()[1].textContent).toContain('Proposal 0040-meals');
    expect(rows()[1].textContent).toContain('Idea #41');
    expect(first.querySelector('a.hx-forge-out').getAttribute('href')).toBe(URL_OF(41));
    expect(first.querySelector('a.hx-forge-out').getAttribute('aria-label')).toBe('Open thread 41 on GitHub (new tab)');
    expect($('forge-status').textContent).toBe('3 of 3 threads, as of 2 minutes ago');
    expect(await said()).toBe('3 threads shown');
  });

  it('shows the state of the run that is about a thread, as a word on its row (issue #104)', async () => {
    const run = (runId, status, extra = {}) => ({ runId, status, open: !['done', 'failed', 'stopped', 'merged', 'closed'].includes(status), requestedAt: '2026-10-19T09:00:00Z', target: 41, refs: { thread: 41 }, thread: { number: 41, mirror: null }, ...extra });
    fakeServer({ runs: [
      run('run-01JC8Z3Q5M7VXK2RT9N4B6HDE1', 'done', { requestedAt: '2026-10-18T09:00:00Z' }),
      run('run-01JC8Z3Q5M7VXK2RT9N4B6HDE2', 'waiting'),
      // the spec pull request's conversation, by the number the server says (a proposal's run), and an older answer that has only `target`
      run('run-01JC8Z3Q5M7VXK2RT9N4B6HDE3', 'working', { target: 40, refs: { proposal: '0040-meals' }, thread: { number: 40, mirror: { url: 'https://git.example.test/c/1' } } }),
      { runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDE4', status: 'failed', open: false, requestedAt: '2026-10-19T08:00:00Z', target: 42, refs: { issue: 42 } },
    ] });
    mount();
    await openThreads();
    await settle();
    const word = (n) => rows().find((r) => r.querySelector('[data-forge-thread]').dataset.forgeThread === String(n)).querySelector('[data-thread-run]');
    // the open run is the one shown, and the other on the same thread is counted
    expect(word(41).textContent).toBe('Run: Waiting (+1)');
    expect(word(41).dataset.threadRun).toBe('run-01JC8Z3Q5M7VXK2RT9N4B6HDE2');
    expect(word(41).className).toContain('hx-forge-state--queued');
    expect(word(40).textContent).toBe('Run: Working');
    expect(word(42).textContent).toBe('Run: Failed');
    expect(word(42).className).toContain('hx-forge-state--failure');
  });

  it('is filtered by state and by a search over the title, number and author', async () => {
    fakeServer({ threads: [...THREADS, { ...THREADS[2], number: 43, title: 'Settled', state: 'closed' }] });
    mount();
    await openThreads();
    expect(rows()).toHaveLength(3);
    const text = $('forge-text');
    text.value = 'agent-four';
    text.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rows().map((r) => r.querySelector('.hx-forge-title').textContent)).toEqual(['Spec: Meals', 'A quiet one']);
    text.value = '';
    text.dispatchEvent(new Event('input', { bubbles: true }));
    $('forge-state').value = 'all';
    $('forge-state').dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(rows().some((r) => r.textContent.includes('Settled'))).toBe(true);
    // a label filter means nothing here: every idea has the label
    expect($('forge-label').parentElement.hidden).toBe(true);
  });

  it('says what could not be read, and an older answer, in words', async () => {
    fakeServer({ problem: 'The forge is away.' });
    mount();
    await openThreads();
    expect($('forge-notice').textContent).toBe('Some threads could not all be read: The forge is away.');
  });

  it('is off, and asks nothing about threads, when the config says threads: false', async () => {
    const server = fakeServer();
    mount({ threads: false });
    expect(q('[data-forge-kind="threads"]').hidden).toBe(true);
    expect(state.threadIndex).toBe(null);
    openForge({ tab: 'pulls' });
    await settle();
    selectNode(MAP.nodes[2]);
    await settle();
    expect(server.urls().some((u) => u.includes('/threads'))).toBe(false);
    expect(q('#drawer-threads').innerHTML).toBe('');
  });

  it('is on for a server that does not say (an older one)', async () => {
    fakeServer();
    mount({ threads: undefined });
    expect(q('[data-forge-kind="threads"]').hidden).toBe(false);
  });
});

describe('a thread is read here and answered on the forge', () => {
  it('shows the messages as written, read-only, with a link out to reply', async () => {
    const server = fakeServer();
    mount();
    await openThreads();
    click(q('[data-forge-thread="41"]'));
    await settle();
    expect(server.urls().at(-1)).toBe('/api/forge/threads/41');
    const detail = $('forge-detail');
    expect(detail.hidden).toBe(false);
    expect(detail.getAttribute('aria-label')).toBe('Selected thread');
    expect(detail.querySelector('.hx-forge-detail-title').textContent).toBe('#41 Rework sign-in');
    const msgs = qa('.hx-thread-msg');
    expect(msgs).toHaveLength(3);
    expect(msgs[0].textContent).toContain('maintainer-one opened this');
    // the text is the text: no markup is made of it
    expect(msgs[2].querySelector('.hx-thread-body').textContent).toBe('<b>not markup</b> & no mention');
    expect(msgs[2].querySelector('b')).toBe(null);
    expect(msgs[0].querySelector('.hx-thread-body').textContent).toBe('Thinking about [[server/auth.js]] and [[nowhere.md]].\n\nSecond line stays.');
    // nothing to type into inside a thread: replying is on the forge
    expect(detail.querySelector('input, textarea, select, form')).toBe(null);
    const reply = [...detail.querySelectorAll('a')].find((a) => a.textContent.startsWith('Reply on GitHub'));
    expect(reply.getAttribute('href')).toBe(URL_OF(41));
    expect(reply.getAttribute('target')).toBe('_blank');
    expect(detail.textContent).toContain('Read-only here');
    expect(detail.textContent).toContain('Proposal 0040-meals in pull request #40');
    expect([...detail.querySelectorAll('a')].find((a) => a.getAttribute('aria-label') === 'Open this message on GitHub (new tab)')).toBeTruthy();
    expect($('forge-btn-lit').textContent).toBe('thread #41');
    expect(await said()).toBe('Thread 41, Rework sign-in: 3 messages, 2 nodes lit, 1 named that is not on the map. Read-only: reply on GitHub.');
  });

  it('names the configured forge, Forgejo too, in every link and word; a hostile mention stays text', async () => {
    const hostile = (d) => ({ ...d, messages: [...d.messages, { id: '9666', author: user('<img src=x onerror=alert(1)>'), url: URL_OF(41), createdAt: '2026-10-19T11:00:00Z', updatedAt: '2026-10-19T11:00:00Z', body: 'see [[<img src=x onerror=alert(1)>]] and [["><script>alert(1)</script>]]' }] });
    fakeServer({ detail: hostile });
    mount({ forge: { type: 'forgejo', url: 'https://git.example.test', repo: 'owner/name' } });
    await openThreads();
    click(q('[data-forge-thread="41"]'));
    await settle();
    const detail = $('forge-detail');
    const words = `${detail.textContent} ${[...detail.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).join(' ')} ${await said()}`;
    expect(words).not.toContain('GitHub');
    expect([...detail.querySelectorAll('a')].find((a) => a.textContent.startsWith('Reply on Forgejo'))).toBeTruthy();
    expect(detail.querySelector('a[aria-label="Open this message on Forgejo (new tab)"]')).toBeTruthy();
    expect(detail.textContent).toContain('a conversation on Forgejo');
    // the mention and the login are text: nothing became an element
    expect(detail.querySelector('img, script')).toBe(null);
    expect(detail.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(detail.textContent).toContain('"><script>alert(1)</script>');
    // and New idea says where it will open the issue
    click($('idea-open'));
    expect($('idea-words').textContent).toBe('This opens an issue labelled "idea" on Forgejo, as you. The conversation lives there; cornfield keeps no copy of it.');
  });

  it('lights the nodes its text mentions, outside code, the way a pull request lights its files', async () => {
    fakeServer();
    mount();
    await openThreads();
    click(q('[data-forge-thread="41"]'));
    await settle();
    expect([...state.forgeLit.changed].sort()).toEqual(['core-auth', 'core-hooks']);
    expect(state.forgeLit.failing.size).toBe(0);
    // [[core-db]] is in a code span and a fence: not lit, and the rest fades back
    expect(sceneNode('core-auth').halo).toBe('match');
    expect(sceneNode('core-hooks').alpha).toBe(1);
    expect(sceneNode('core-db').alpha).toBeLessThan(0.5);
    expect(sceneNode('root').alpha).toBeLessThan(0.5);
    // the nodes are buttons that select them on the map, and what is on no node is said so
    const chips = qa('#forge-detail .hx-forge-node').map((b) => b.textContent);
    expect(chips).toContain('auth.js');
    expect(chips).toContain('hooks.js');
    expect($('forge-detail').textContent).toContain('nowhere.md is mentioned but not on the map, so it stays text.');
    expect($('forge-detail').textContent).toContain('Mentions: 2 nodes on the map');
    const first = qa('.hx-thread-msg')[0];
    expect([...first.querySelectorAll('.hx-forge-node')].map((b) => b.textContent)).toEqual(['auth.js']);
    expect(first.textContent).toContain('not on the map: nowhere.md');
    click(first.querySelector('.hx-forge-node'));
    expect(state.selectedNode.id).toBe('core-auth');
  });

  it('a path lights the node that owns it, and a block names nodes precisely', async () => {
    fakeServer({ detail: (d) => ({ ...d, messages: [msg('1', 'a', 'in [[server/other.js]]\n```cornfield-thread\n{"nodes":["core-db"],"proposal":"0040-meals"}\n```')] }) });
    mount();
    await openThreads();
    click(q('[data-forge-thread="41"]'));
    await settle();
    expect([...state.forgeLit.changed].sort()).toEqual(['core-db', 'pkg-server']);
  });

  it('a spec conversation is a thread too', async () => {
    fakeServer();
    mount();
    await openThreads();
    click(q('[data-forge-thread="40"]'));
    await settle();
    expect($('forge-detail').textContent).toContain('Spec pull request for 0040-meals');
    expect($('forge-detail').textContent).toContain('Names idea #41');
    expect([...state.forgeLit.changed]).toEqual(['core-hooks']);
  });

  it('Clear, or the row again, lets go; selecting a pull request lets go of a thread and the other way round', async () => {
    fakeServer();
    mount();
    await openThreads();
    click(q('[data-forge-thread="41"]'));
    await settle();
    expect(state.forgeLit).not.toBe(null);
    click(q('[data-action="clear-forge-thread"]'));
    expect(state.forgeLit).toBe(null);
    expect($('forge-detail').hidden).toBe(true);
    expect($('forge-list').hidden).toBe(false); // the list is back
    expect(document.activeElement).toBe(q('[data-forge-thread="41"]')); // on the row that was opened
    expect(await said()).toBe('Thread 41 cleared');
    click(q('[data-forge-thread="41"]'));
    await settle();
    click(q('[data-forge-thread="41"]'));
    expect(state.forgeLit).toBe(null);

    click(q('[data-forge-thread="41"]'));
    await settle();
    click(q('[data-forge-kind="pulls"]'));
    await settle();
    click(q('[data-forge-pr="12"]'));
    await settle();
    expect(qa('.hx-thread-msg')).toEqual([]);
    expect($('forge-detail').getAttribute('aria-label')).toBe('Selected pull request');
    expect([...state.forgeLit.changed]).toEqual(['core-db']);
    click(q('[data-forge-kind="threads"]'));
    await settle();
    click(q('[data-forge-thread="41"]'));
    await settle();
    expect($('forge-detail').getAttribute('aria-label')).toBe('Selected thread');
    expect([...state.forgeLit.changed].sort()).toEqual(['core-auth', 'core-hooks']);
  });

  it('says in words when a thread cannot be read, and Refresh asks for it again', async () => {
    const server = fakeServer({ detail: undefined });
    mount();
    await openThreads();
    click(q('[data-forge-thread="42"]')); // the fake has no detail for 42
    await settle();
    expect($('forge-detail').textContent).toContain('is not a thread');
    click(q('[data-forge-thread="41"]'));
    await settle();
    server.calls.length = 0;
    await refreshForge();
    expect(server.urls()).toContain('/api/forge/threads/41');
    expect(server.calls.find((c) => c.url === '/api/forge/threads/41').init.cache).toBe('reload');
  });

  it('follows the map: a proposal opening changes the nodes, and the lights follow', async () => {
    fakeServer();
    mount();
    await openThreads();
    click(q('[data-forge-thread="41"]'));
    await settle();
    expect(state.forgeLit.changed.has('core-auth')).toBe(true);
    // the map now on screen has no auth.js: its mention goes to the folder that owns the path
    const fewer = MAP.nodes.filter((n) => n.id !== 'core-auth');
    setMap(fewer.map((n) => ({ ...n })), MAP.edges.filter((e) => e.to !== 'core-auth'));
    await settle();
    expect([...state.forgeLit.changed].sort()).toEqual(['core-hooks', 'pkg-server']);
  });
});

describe('a node\'s panel lists the threads that mention it', () => {
  const pick = (id) => MAP.nodes.find((n) => n.id === id);

  it('reads the list once the first node is selected, and fills "Mentioned in" in place', async () => {
    const server = fakeServer();
    mount();
    selectNode(pick('core-hooks'));
    expect(q('#drawer-threads').textContent).not.toContain('Mentioned');
    await settle();
    expect(server.urls()).toEqual(['/api/forge/threads?state=open&limit=100']);
    const box = q('#drawer-threads');
    expect(box.textContent).toContain('Mentioned in 2 threads:');
    expect([...box.querySelectorAll('[data-thread-open]')].map((b) => b.textContent)).toEqual(['#41 Rework sign-in', '#40 Spec: Meals']);
    expect(box.textContent).toContain('idea');
    expect(box.textContent).toContain('proposal');
    // the panel is not asked for again for the next node
    selectNode(pick('core-auth'));
    await settle();
    expect(server.urls()).toHaveLength(1);
    expect(q('#drawer-threads').textContent).toContain('Mentioned in 1 thread:');
  });

  it('a path mention counts for the node that owns the file, and a node nobody mentions has no section', async () => {
    fakeServer();
    mount();
    selectNode(pick('core-auth'));
    await settle();
    expect(q('#drawer-threads [data-thread-open]').dataset.threadOpen).toBe('41');
    selectNode(pick('core-db'));
    await settle();
    expect(q('#drawer-threads').textContent).not.toContain('Mentioned');
    expect(q('#drawer-threads [data-thread-open]')).toBe(null);
  });

  it('a button opens the thread in the issues and PRs panel, which lights its nodes', async () => {
    fakeServer();
    mount();
    selectNode(pick('core-hooks'));
    await settle();
    click(q('[data-thread-open="40"]'));
    await settle();
    expect($('forge-panel').classList.contains('forge-open')).toBe(true);
    expect(q('[data-forge-kind="threads"]').getAttribute('aria-pressed')).toBe('true');
    expect($('forge-detail').getAttribute('aria-label')).toBe('Selected thread');
    expect($('forge-detail').textContent).toContain('Spec: Meals');
    expect([...state.forgeLit.changed]).toEqual(['core-hooks']);
  });

  it('shares the list with the tab: opening the tab afterwards does not ask twice for the same state', async () => {
    const server = fakeServer();
    mount();
    selectNode(pick('core-hooks'));
    await settle();
    await openThreads();
    expect(server.urls().filter((u) => u.startsWith('/api/forge/threads?'))).toHaveLength(1);
  });

  it('draws nothing, and breaks nothing, when the list cannot be read', async () => {
    fakeServer({ down: true });
    mount();
    selectNode(pick('core-hooks'));
    await settle();
    expect(q('#drawer-threads').textContent).not.toContain('Mentioned');
  });
});

describe('Start a thread about this (a node\'s panel)', () => {
  const pick = (id) => MAP.nodes.find((n) => n.id === id);
  const type = (id, value) => { const el = $(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const POSTED = { '/api/forge/threads': { status: 201, body: { ok: true, action: 'idea', created: true, number: 77, issue: { number: 77, title: 'db.js', url: URL_OF(77) } } } };
  const button = () => q('#drawer-threads [data-thread-start]');

  it('shows only when threads are on and a maintainer is signed in', async () => {
    fakeServer();
    mount();
    selectNode(pick('core-db'));
    expect(button().textContent).toBe('Start a thread about this');
    expect(button().dataset.threadStart).toBe('core-db');
    expect(button().getAttribute('aria-label')).toContain('GitHub');
    closeDrawer();
    expect(mount({ threads: false })).toBe(true);
    selectNode(pick('core-db'));
    await settle();
    expect(q('[data-thread-start]')).toBe(null);
    closeDrawer();
    expect(mount({ signIn: false })).toBe(false);
    selectNode(pick('core-db'));
    await settle();
    expect(q('[data-thread-start]')).toBe(null);
  });

  it('names the configured forge, never GitHub, on Forgejo', async () => {
    fakeServer();
    mount({ forge: { type: 'forgejo', url: 'https://git.example.test', repo: 'owner/name' } });
    selectNode(pick('core-db'));
    expect(button().getAttribute('aria-label')).toContain('Forgejo');
    expect(button().getAttribute('aria-label')).not.toContain('GitHub');
    click(button());
    await settle();
    expect($('idea-words').textContent).toContain('Forgejo');
  });

  it('opens the New idea form with [[id]] on its own line under an empty line, the label as the title, and the focus in the form', async () => {
    fakeServer();
    mount();
    selectNode(pick('core-auth'));
    await settle();
    button().focus();
    click(button());
    await settle();
    expect($('forge-panel').classList.contains('forge-open')).toBe(true);
    expect(q('[data-forge-kind="threads"]').getAttribute('aria-pressed')).toBe('true');
    expect($('idea-form').hidden).toBe(false);
    expect($('idea-open').getAttribute('aria-expanded')).toBe('true');
    expect($('idea-title').value).toBe('auth.js');
    expect($('idea-body').value).toBe('[[core-auth]]\n\n');
    expect(document.activeElement).toBe($('idea-title'));
  });

  it('closing the form returns the focus to the node\'s button', async () => {
    fakeServer();
    mount();
    selectNode(pick('core-auth'));
    await settle();
    click(button());
    await settle();
    click(q('[data-action="idea-cancel"]'));
    expect($('idea-form').hidden).toBe(true);
    expect(document.activeElement).toBe(button());
    // opened from the bar's own button, it goes back to that one
    click($('idea-open'));
    click(q('[data-action="idea-cancel"]'));
    expect(document.activeElement).toBe($('idea-open'));
  });

  it('posts the edited title and the text through POST /api/forge/threads, then "Mentioned in" lists the new thread, selected so its node lights', async () => {
    const posted = [];
    const server = fakeServer({ posts: POSTED });
    mount();
    selectNode(pick('core-db'));
    await settle();
    expect(q('#drawer-threads').textContent).not.toContain('Mentioned');
    click(button());
    await settle();
    type('idea-title', 'Move db.js to its own package');
    type('idea-body', '[[core-db]]\n\nIt has outgrown the server.');
    // the list the forge answers with from now on has the new idea, which names the node
    const NEW = { kind: 'idea', number: 77, title: 'Move db.js to its own package', state: 'open', author: user('maintainer-one'), labels: ['idea'], url: URL_OF(77), createdAt: '2026-10-19T11:59:00Z', updatedAt: '2026-10-19T11:59:00Z', comments: 0, refs: ['core-db'] };
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if (!init.method && new URL(url, 'http://localhost').pathname === '/api/forge/threads') {
        posted.push(init);
        const at = '2026-10-19T11:59:30.000Z';
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true, at, rate: '', label: 'idea', problem: null, items: [NEW, ...THREADS] }) };
      }
      if (!init.method && new URL(url, 'http://localhost').pathname === '/api/forge/threads/77') {
        const opening = { id: 'opening', author: user('maintainer-one'), url: URL_OF(77), createdAt: NEW.createdAt, updatedAt: NEW.updatedAt, body: '[[core-db]]\n\nIt has outgrown the server.', opening: true };
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true, at: '2026-10-19T11:59:30.000Z', rate: '', thread: { ...NEW, messages: [opening], hidden: 0 } }) };
      }
      return real(url, init);
    }));
    click($('idea-send'));
    await settle();
    expect(server.posts()).toHaveLength(1);
    expect(server.posts()[0].url).toBe('/api/forge/threads');
    expect(JSON.parse(server.posts()[0].init.body)).toEqual({ title: 'Move db.js to its own package', body: '[[core-db]]\n\nIt has outgrown the server.' });
    expect(posted.some((i) => i.cache === 'reload')).toBe(true); // the forge was asked again, not the minute's cache
    const box = q('#drawer-threads');
    expect(box.textContent).toContain('Mentioned in 1 thread:');
    expect(box.querySelector('[data-thread-open="77"]').textContent).toBe('#77 Move db.js to its own package');
    expect(document.activeElement).toBe(button());
    // the new thread is selected on the Threads tab, so the node it mentions lights; the words say all of it at once
    expect(q('[data-forge-thread="77"]').getAttribute('aria-pressed')).toBe('true');
    expect($('forge-btn-lit').textContent).toBe('thread #77');
    expect([...state.forgeLit.changed]).toEqual(['core-db']);
    const words = await said();
    expect(words).toContain('Opened idea #77');
    expect(words).toContain('Thread 77, Move db.js to its own package: 1 message, 1 node lit.');
    expect(words).toContain('It is listed under Mentioned in for db.js.');
  });

  it('after posting, the new thread\'s messages pending, then an answer with no thread, then a failure: nothing lit, nothing thrown, all said', async () => {
    const unhandled = [];
    const catcher = (err) => { unhandled.push(err); };
    process.on('unhandledRejection', catcher);
    try {
      const server = fakeServer({ posts: POSTED });
      mount();
      selectNode(pick('core-db'));
      await settle();
      // The new thread's messages: held until the test lets them go, then answered as asked
      let release = null;
      let answer = null;
      const real = globalThis.fetch;
      vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
        if (!init.method && new URL(url, 'http://localhost').pathname === '/api/forge/threads/77') {
          await new Promise((r) => { release = r; });
          return answer();
        }
        return real(url, init);
      }));
      const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });

      // 1. pending: the idea is opened and the thread is selected, but nothing is lit before its messages are in
      click(button());
      await settle();
      click($('idea-send'));
      await settle();
      expect(server.posts()).toHaveLength(1);
      expect(release).not.toBe(null);
      expect(state.forgeLit).toBe(null);
      // 2. it comes back as a 200 with no thread in it: a failure in words, nothing lit
      answer = () => json(200, { ok: true, at: '2026-10-19T11:59:30.000Z', rate: '' });
      release();
      await settle();
      expect(state.forgeLit).toBe(null);
      expect(q('#forge-detail').textContent).toContain('Thread 77 could not be read: the answer had no thread in it.');
      const words = await said();
      expect(words).toContain('Opened idea #77');
      expect(words).toContain('Thread 77 could not be read');
      expect(document.activeElement).toBe(button());

      // 3. again, and the forge fails: said, nothing lit, the form usable
      release = null;
      click(button());
      await settle();
      $('idea-title').value = 'Another';
      click($('idea-send'));
      await settle();
      answer = () => json(502, { ok: false, error: 'GitHub did not answer.', code: 'unavailable' });
      release();
      await settle();
      expect(state.forgeLit).toBe(null);
      expect(q('#forge-detail').textContent).toContain('GitHub did not answer.');
      expect(await said()).toContain('GitHub did not answer.');
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', catcher);
    }
  });

  it('never loses a draft: a typed title stays, typed text stays under the mention, and the mention is added once', async () => {
    fakeServer();
    mount();
    openForge({ tab: 'pulls' });
    await settle();
    click(q('[data-forge-kind="threads"]'));
    await settle();
    click($('idea-open'));
    type('idea-title', 'My own title');
    type('idea-body', 'Half a thought');
    click(q('[data-action="idea-cancel"]')); // put away, not thrown away
    selectNode(pick('core-db'));
    await settle();
    click(button());
    await settle();
    expect($('idea-title').value).toBe('My own title');
    expect($('idea-body').value).toBe('[[core-db]]\n\nHalf a thought');
    // again, from the same node: nothing doubled
    click(button());
    await settle();
    expect($('idea-body').value).toBe('[[core-db]]\n\nHalf a thought');
    // from another node: its mention goes on top, the rest kept
    selectNode(pick('core-auth'));
    await settle();
    click(button());
    await settle();
    expect($('idea-body').value).toBe('[[core-auth]]\n\n[[core-db]]\n\nHalf a thought');
    expect($('idea-title').value).toBe('My own title');
  });

  it('an empty title takes the node\'s label; a draft with only spaces is no draft', async () => {
    fakeServer();
    mount();
    openForge({ tab: 'pulls' });
    await settle();
    click(q('[data-forge-kind="threads"]'));
    await settle();
    click($('idea-open'));
    type('idea-title', '   ');
    type('idea-body', '  \n ');
    selectNode(pick('core-hooks'));
    await settle();
    click(button());
    await settle();
    expect($('idea-title').value).toBe('hooks.js');
    expect($('idea-body').value).toBe('[[core-hooks]]\n\n');
  });

  it('posts the mention alone when nothing is written under it, and keeps the form on a refusal', async () => {
    const server = fakeServer({ posts: { '/api/forge/threads': { status: 403, body: { ok: false, error: 'Not a maintainer.', code: 'forbidden' } } } });
    mount();
    selectNode(pick('core-hooks'));
    await settle();
    click(button());
    await settle();
    click($('idea-send'));
    await settle();
    expect(JSON.parse(server.posts()[0].init.body)).toEqual({ title: 'hooks.js', body: '[[core-hooks]]' });
    expect($('idea-form').hidden).toBe(false);
    expect(document.activeElement).toBe($('idea-title'));
  });
});

describe('New idea', () => {
  const type = (id, value) => { const el = $(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };

  it('is a button on the Threads tab only, and opens a form that says what it will do', async () => {
    fakeServer();
    mount();
    openForge({ tab: 'pulls' });
    await settle();
    expect($('forge-idea').hidden).toBe(true);
    click(q('[data-forge-kind="threads"]'));
    await settle();
    expect($('forge-idea').hidden).toBe(false);
    expect($('idea-form').hidden).toBe(true);
    expect($('idea-open').getAttribute('aria-expanded')).toBe('false');
    click($('idea-open'));
    expect($('idea-form').hidden).toBe(false);
    expect($('idea-open').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe($('idea-title'));
    expect($('idea-words').textContent).toBe('This opens an issue labelled "idea" on GitHub, as you. The conversation lives there; cornfield keeps no copy of it.');
    click(q('[data-forge-kind="issues"]'));
    expect($('forge-idea').hidden).toBe(true);
  });

  it('asks for a title first, and Cancel posts nothing', async () => {
    const server = fakeServer();
    mount();
    await openThreads();
    click($('idea-open'));
    click($('idea-send'));
    expect($('idea-message').textContent).toBe('Give the idea a title.');
    expect($('idea-message').classList.contains('hx-forge-msg--bad')).toBe(true);
    expect(document.activeElement).toBe($('idea-title'));
    expect(server.posts()).toEqual([]);
    click(q('[data-action="idea-cancel"]'));
    expect($('idea-form').hidden).toBe(true);
    expect(document.activeElement).toBe($('idea-open'));
    expect(server.posts()).toEqual([]);
    expect(await said()).toBe('Cancelled. Nothing was opened.');
  });

  it('posts the title and text once to cornfield\'s own server, says what came of it with a link, and reads the list again', async () => {
    const server = fakeServer({ posts: { '/api/forge/threads': { status: 201, body: { ok: true, action: 'idea', created: true, number: 77, issue: { number: 77, title: 'Meal plans', url: URL_OF(77) } } } } });
    mount();
    await openThreads();
    click($('idea-open'));
    type('idea-title', '  Meal plans ');
    type('idea-body', 'What if we planned the week?');
    server.calls.length = 0;
    click($('idea-send'));
    expect($('idea-send').disabled).toBe(true);
    click($('idea-send')); // a second click while it is going does nothing
    await settle();
    expect(server.posts()).toHaveLength(1);
    const post = server.posts()[0];
    expect(post.url).toBe('/api/forge/threads');
    expect(post.init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(post.init.body)).toEqual({ title: 'Meal plans', body: 'What if we planned the week?' });
    expect($('idea-message').textContent).toContain('Opened idea #77 on GitHub.');
    expect($('idea-message').classList.contains('hx-forge-msg--bad')).toBe(false);
    const link = $('idea-message').querySelector('a');
    expect(link.getAttribute('href')).toBe(URL_OF(77));
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect($('idea-form').hidden).toBe(true);
    expect($('idea-title').value).toBe('');
    expect($('idea-body').value).toBe('');
    expect(server.urls().filter((u) => u.startsWith('/api/forge/threads?'))).not.toHaveLength(0);
    expect(await said()).toContain('Opened idea #77');
  });

  it('says a refusal in the server\'s words and keeps what was typed', async () => {
    const server = fakeServer({ posts: { '/api/forge/threads': { status: 403, body: { ok: false, error: 'Only the repo\'s maintainers open ideas; reader-two is not one now.', code: 'forbidden' } } } });
    mount();
    await openThreads();
    click($('idea-open'));
    type('idea-title', 'Mine');
    click($('idea-send'));
    await settle();
    expect(server.posts()).toHaveLength(1);
    expect($('idea-message').textContent).toBe('Only the repo\'s maintainers open ideas; reader-two is not one now.');
    expect($('idea-message').classList.contains('hx-forge-msg--bad')).toBe(true);
    expect($('idea-form').hidden).toBe(false);
    expect($('idea-title').value).toBe('Mine');
    expect(document.activeElement).toBe($('idea-title'));
  });

  it('says when the sign-in has ended, and when cornfield did not answer', async () => {
    fakeServer({ posts: { '/api/forge/threads': { status: 401, body: { ok: false } } } });
    mount();
    await openThreads();
    click($('idea-open'));
    type('idea-title', 'Mine');
    click($('idea-send'));
    await settle();
    expect($('idea-message').textContent).toBe('Your sign-in has ended. Sign in again to open an idea.');
  });
});

// @vitest-environment happy-dom
/**
 * The pipeline's own steps in the issues and PRs panel (PIPE-05), through the page's own markup (explorer/index.html)
 * with a fake server behind `fetch`: an open issue has "Start a spec", a spec pull request with an approved proposal has
 * "Open the build issue", each reads the server's plan first and shows exactly what will be made in a confirm dialog
 * (focus on Cancel, Tab inside, Escape closes), posts only the plan's digest (and the proposal and commit shown),
 * says what it came to, and a step done before is found rather than made again. Landing (step 3) is the merge of
 * forge-panel-ui.test.js. Everything is said through the map's live region.
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
import { initForgePanel, resetForgePanelForTests, openForge, closeForge } from '../../explorer/forge-panel.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard, resetKeyboardForTests } from '../../explorer/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { initSheets } from '../../explorer/sheets.js';
// @ts-expect-error plain JS modules, no declarations
import { closeDrawer } from '../../explorer/panels.js';

const page = fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');

const node = (id, type, file) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, degree: 1, ...(file ? { file } : {}) });
const MAP = { nodes: [node('root', 'root', 'package.json'), node('core-server', 'core', 'server/server.js')], edges: [{ from: 'root', to: 'core-server' }] };

const user = (login) => ({ login, url: `https://git.example.test/${login}` });
const issue = (number, title, extra = {}) => ({ number, title, state: 'open', author: user('maintainer-one'), labels: ['v1'], comments: 0, url: `https://git.example.test/owner/name/issues/${number}`, createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T12:00:00Z', closedAt: null, ...extra });
const pull40 = { number: 40, title: 'Meals spec', state: 'open', draft: true, author: user('agent-four'), labels: [], head: { ref: 'spec/0040-meals', sha: '4040000000000000000000000000000000000000' }, base: { ref: 'main' }, url: 'https://git.example.test/owner/name/pull/40', createdAt: '2026-10-19T09:00:00Z', updatedAt: '2026-10-19T09:00:00Z', mergedAt: null };
const detail40 = (specs) => ({ pull: pull40, files: [{ path: 'docs/specs/proposals/0040-meals.json', status: 'added', previousPath: null, additions: 20, deletions: 0 }], checks: [], specs });

const SPEC_PLAN = {
  kind: 'spec', digest: 'a'.repeat(32), issue: { number: 7, title: 'Meals <img src=x onerror=alert(1)> page', url: 'https://git.example.test/owner/name/issues/7' }, base: 'main', branch: 'spec/7-meals-page', path: 'docs/specs/proposals/7-meals-page.json',
  message: 'Start a spec for #7', title: 'Spec: Meals <img src=x onerror=alert(1)> page', body: 'Refs #7\n\nA draft pull request.', content: '{\n  "version": 1,\n  "title": "Meals"\n}\n', existing: null,
};
const BUILD_PLAN = {
  kind: 'build', digest: 'b'.repeat(32), pull: { number: 40, title: 'Meals spec', url: pull40.url }, slug: '0040-meals', path: 'docs/specs/proposals/0040-meals.json', sha: pull40.head.sha,
  review: { by: 'maintainer-one', url: 'https://git.example.test/c/1', at: '2026-10-19T10:00:00Z' }, title: 'Build: Meals', body: 'Build the approved proposal `0040-meals`.\n\n## Nodes\n\n- [ ] Add `page-meals`\n', items: 1, existing: null,
};

const NOW = Date.parse('2026-10-19T12:00:00Z');
const $ = (id) => document.getElementById(id);
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (el, k) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const said = async () => { await new Promise((r) => setTimeout(r, 50)); return $('map-announcer').textContent; };

/** A fake server behind `fetch`: the forge routes (plans too) and a record of every call */
function fakeServer(opts = {}) {
  const calls = [];
  const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });
  const specs = opts.specs ?? [{ slug: '0040-meals', path: 'docs/specs/proposals/0040-meals.json', approved: true }];
  const mock = vi.fn(async (url, init = {}) => {
    calls.push({ url, init });
    if (opts.down) throw new TypeError('Failed to fetch');
    const u = new URL(url, 'http://localhost');
    const at = '2026-10-19T11:58:00.000Z';
    if (init.method === 'POST') {
      const answer = opts.posts && opts.posts[u.pathname];
      return answer ? json(answer.status ?? 200, answer.body) : json(404, { ok: false, error: 'No such action.' });
    }
    const override = opts.answers && opts.answers[u.pathname + u.search];
    if (override) return json(override.status ?? 200, override.body);
    if (u.pathname === '/api/forge/issues/7/spec') return json(200, { ok: true, at, rate: '', plan: opts.specPlan ?? SPEC_PLAN });
    if (u.pathname === '/api/forge/pulls/40/build') return json(200, { ok: true, at, rate: '', plan: opts.buildPlan ?? BUILD_PLAN });
    if (u.pathname === '/api/forge/issues') return json(200, { ok: true, at, rate: '', items: [issue(7, SPEC_PLAN.issue.title), issue(5, 'Sign-in'), issue(2, 'Done', { state: 'closed', closedAt: '2026-10-15T09:00:00Z' })] });
    if (u.pathname === '/api/forge/pulls') return json(200, { ok: true, at, rate: '', items: [pull40] });
    if (u.pathname === '/api/forge/pulls/40') return json(200, { ok: true, at, rate: '', stale: opts.stale, ...detail40(specs) });
    return json(404, { ok: false, error: 'GitHub has no such thing.', code: 'not-found' });
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock, urls: () => calls.map((c) => c.url), posts: () => calls.filter((c) => c.init.method === 'POST'), plans: () => calls.filter((c) => /\/spec$|\/build\?/.test(c.url) && c.init.method !== 'POST') };
}

function mount() {
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
  return initForgePanel({ forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' }, signIn: { login: 'maintainer-one' } }, { clock: () => NOW });
}

const openIssues = async () => {
  openForge();
  await settle();
  click(q('[data-forge-kind="issues"]'));
  await settle();
};
const openSpec = async () => {
  openForge();
  await settle();
  click(q('[data-forge-pr="40"]'));
  await settle();
};

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { closeForge({ restoreFocus: false }); closeDrawer(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('step 1: Start a spec, on an issue', () => {
  it('an open issue has the button, named for its issue; a closed one has none', async () => {
    fakeServer();
    mount();
    await openIssues();
    click(q('[data-forge-kind="issues"]'));
    const state_ = q('#forge-state');
    state_.value = 'all';
    state_.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    const buttons = qa('[data-forge-spec]');
    expect(buttons.map((b) => b.dataset.forgeSpec)).toEqual(['7', '5']);
    expect(buttons[0].textContent).toBe('Start a spec …');
    expect(buttons[0].getAttribute('aria-label')).toBe('Start a spec for issue 7');
    expect(qa('#forge-list .hx-forge-item').length).toBe(3);
    expect(q('#forge-list .hx-forge-item:last-child [data-forge-spec]')).toBe(null);
  });

  it('shows the plan the server read, exactly: the issue, the branch, the file, the draft pull request, with the file and the description in full', async () => {
    const server = fakeServer();
    mount();
    await openIssues();
    click(q('[data-forge-spec="7"]'));
    await settle();
    expect(server.plans().map((c) => c.url)).toEqual(['/api/forge/issues/7/spec']);
    expect(server.plans()[0].init.cache).toBe('reload');
    expect(server.posts()).toEqual([]);
    const dialog = q('#forge-confirm [role="dialog"]');
    expect($('forge-confirm').hidden).toBe(false);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect($('forge-confirm-title').textContent).toBe('Start a spec for issue #7?');
    const facts = Object.fromEntries(qa('#forge-confirm-body dt').map((dt) => [dt.textContent, dt.nextElementSibling.textContent]));
    expect(facts).toEqual({
      Issue: '#7 Meals <img src=x onerror=alert(1)> page', Branch: 'spec/7-meals-page', 'Starts from': 'main', File: 'docs/specs/proposals/7-meals-page.json',
      'Pull request': 'Spec: Meals <img src=x onerror=alert(1)> page', Draft: 'Yes',
    });
    expect(qa('#forge-confirm-body pre').map((p) => p.textContent)).toEqual([SPEC_PLAN.content, SPEC_PLAN.body]);
    expect(q('#forge-confirm-body img')).toBe(null);
    expect(qa('#forge-confirm-body pre').every((p) => p.tabIndex === 0 && p.getAttribute('aria-label'))).toBe(true);
    expect(q('.hx-confirm-note').textContent).toMatch(/no agent is started/);
    expect(q('[data-action="forge-confirm-go"]').textContent).toBe('Start the spec');
    expect(document.activeElement).toBe(q('[data-action="forge-confirm-cancel"]'));
    expect(await said()).toMatch(/^Start a spec for issue #7\? Issue: #7 .*Draft: Yes\. Makes this branch.* Cancel or Start the spec\.$/);
  });

  it('Cancel or Escape makes nothing and gives the focus back to the button; Tab stays in the dialog', async () => {
    const server = fakeServer();
    mount();
    await openIssues();
    click(q('[data-forge-spec="7"]'));
    await settle();
    const cancel = q('[data-action="forge-confirm-cancel"]');
    const go = q('[data-action="forge-confirm-go"]');
    const tab = (el, shiftKey = false) => { const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };
    expect(tab(cancel).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(go);
    tab(go);
    expect(document.activeElement).toBe(cancel);
    $('forge-btn').focus();
    expect(document.activeElement).toBe(cancel);
    key(cancel, 'Escape');
    expect($('forge-confirm').hidden).toBe(true);
    expect(document.activeElement).toBe(q('[data-forge-spec="7"]'));
    click(q('[data-forge-spec="7"]'));
    await settle();
    click(q('[data-action="forge-confirm-cancel"]'));
    expect($('forge-confirm').hidden).toBe(true);
    expect(server.posts()).toEqual([]);
  });

  it('confirming posts the plan\'s digest and nothing else, says what it made with a link, and reads the lists again', async () => {
    const server = fakeServer({ posts: { '/api/forge/issues/7/spec': { status: 201, body: { ok: true, action: 'spec', created: true, number: 7, branch: 'spec/7-meals-page', path: SPEC_PLAN.path, pull: { number: 50, title: SPEC_PLAN.title, url: 'https://git.example.test/owner/name/pull/50', draft: true } } } } });
    mount();
    await openIssues();
    click(q('[data-forge-spec="7"]'));
    await settle();
    click(q('[data-action="forge-confirm-go"]'));
    await settle();
    expect(server.posts()).toHaveLength(1);
    expect(server.posts()[0].url).toBe('/api/forge/issues/7/spec');
    expect(JSON.parse(server.posts()[0].init.body)).toEqual({ digest: 'a'.repeat(32) });
    expect(server.posts()[0].init.headers['Content-Type']).toBe('application/json');
    expect($('forge-confirm').hidden).toBe(true);
    const note = $('forge-act-note');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('Spec started for issue #7: draft pull request #50. Open on GitHub ↗');
    expect(note.querySelector('a').href).toBe('https://git.example.test/owner/name/pull/50');
    expect(note.classList.contains('hx-forge-notice--ok')).toBe(true);
    expect(await said()).toBe('Spec started for issue #7: draft pull request #50.');
    expect(server.urls().filter((u) => u.startsWith('/api/forge/issues?'))).toHaveLength(2);
    expect(document.activeElement).toBe(q('[data-forge-spec="7"]'));
  });

  it('three clicks on the button send one plan request, and three on confirm send one post', async () => {
    const server = fakeServer({ posts: { '/api/forge/issues/7/spec': { status: 201, body: { ok: true, created: true, number: 7, pull: { number: 50, url: null } } } } });
    mount();
    await openIssues();
    const btn = q('[data-forge-spec="7"]');
    click(btn);
    click(btn);
    click(btn);
    await settle();
    expect(server.plans()).toHaveLength(1);
    const go = q('[data-action="forge-confirm-go"]');
    click(go);
    click(go);
    click(go);
    await settle();
    expect(server.posts()).toHaveLength(1);
  });

  it('a step done before is found: it says so, shows no dialog, and posts nothing', async () => {
    const server = fakeServer({ specPlan: { ...SPEC_PLAN, existing: { number: 50, title: 'Spec', url: 'https://git.example.test/owner/name/pull/50', draft: true, headRef: 'spec/7-meals-page' } } });
    mount();
    await openIssues();
    click(q('[data-forge-spec="7"]'));
    await settle();
    expect($('forge-confirm').hidden).toBe(true);
    expect($('forge-act-note').textContent).toBe('Issue #7 has its spec already: pull request #50 (a draft). Nothing new is made. Open on GitHub ↗');
    expect(server.posts()).toEqual([]);
    expect(document.activeElement).toBe(q('[data-forge-spec="7"]'));
  });

  it('a refused plan or action is said in the server\'s words, and the panel does not claim it made anything', async () => {
    fakeServer({ answers: { '/api/forge/issues/7/spec': { status: 409, body: { ok: false, code: 'conflict', error: 'Issue #7 is closed, so no spec is started for it.' } } } });
    mount();
    await openIssues();
    click(q('[data-forge-spec="7"]'));
    await settle();
    expect($('forge-confirm').hidden).toBe(true);
    expect($('forge-act-note').textContent).toBe('No spec was started for issue #7: Issue #7 is closed, so no spec is started for it.');
    expect($('forge-act-note').classList.contains('hx-forge-notice--ok')).toBe(false);
  });

  it('a stale plan is refused on confirm and said; a server that is gone is said', async () => {
    const server = fakeServer({ posts: { '/api/forge/issues/7/spec': { status: 409, body: { ok: false, code: 'conflict', error: 'What starting a spec for #7 would make has changed since it was shown (the issue was edited); look again.' } } } });
    mount();
    await openIssues();
    click(q('[data-forge-spec="7"]'));
    await settle();
    click(q('[data-action="forge-confirm-go"]'));
    await settle();
    expect($('forge-act-note').textContent).toBe('No spec was started for issue #7: What starting a spec for #7 would make has changed since it was shown (the issue was edited); look again.');
    click(q('[data-forge-spec="7"]'));
    await settle();
    server.mock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    click(q('[data-action="forge-confirm-go"]'));
    await settle();
    expect($('forge-act-note').textContent).toBe('No spec was started for issue #7: cornfield could not be reached. Look at the forge before trying again.');
  });
});

describe('step 2: Open the build issue, on an approved spec pull request', () => {
  it('an approved proposal has the button; one without an approval says why and has none', async () => {
    fakeServer({ specs: [{ slug: '0040-meals', path: 'p/0040-meals.json', approved: true }, { slug: '0041-other', path: 'p/0041-other.json', approved: false }] });
    mount();
    await openSpec();
    const buttons = qa('[data-forge-build]');
    expect(buttons.map((b) => b.dataset.forgeBuild)).toEqual(['0040-meals']);
    expect(buttons[0].textContent).toBe('Open the build issue …');
    expect(buttons[0].getAttribute('aria-label')).toBe('Open the build issue for 0040-meals');
    const text = q('.hx-forge-detail').textContent;
    expect(text).toContain('0041-other: No approval yet: a maintainer approves it in the proposal\'s review first.');
    expect(text).toContain('0040-meals is approved. Opens a confirm step that shows the issue. Nothing is built.');
  });

  it('a pull request that holds no proposal has no such section', async () => {
    fakeServer({ specs: [] });
    mount();
    await openSpec();
    expect(q('[data-forge-build]')).toBe(null);
    expect(q('.hx-forge-detail').textContent).not.toMatch(/Build issue/);
  });

  it('an older answer from the forge offers nothing and says to refresh', async () => {
    fakeServer({ stale: 'GitHub did not answer.' });
    mount();
    await openSpec();
    expect(q('[data-forge-build]')).toBe(null);
    expect(q('.hx-forge-detail').textContent).toContain('This is an older answer from the forge: refresh first.');
  });

  it('shows the issue that will be made, exactly, and posts the proposal, the commit shown and the digest', async () => {
    const server = fakeServer({ posts: { '/api/forge/pulls/40/build': { status: 201, body: { ok: true, action: 'build', created: true, number: 40, slug: '0040-meals', issue: { number: 60, url: 'https://git.example.test/owner/name/issues/60', state: 'open' } } } } });
    mount();
    await openSpec();
    click(q('[data-forge-build="0040-meals"]'));
    await settle();
    expect(server.plans().map((c) => c.url)).toEqual(['/api/forge/pulls/40/build?slug=0040-meals']);
    expect($('forge-confirm').hidden).toBe(false);
    expect($('forge-confirm-title').textContent).toBe('Open the build issue for 0040-meals?');
    const facts = Object.fromEntries(qa('#forge-confirm-body dt').map((dt) => [dt.textContent, dt.nextElementSibling.textContent]));
    expect(facts).toEqual({ 'Spec pull request': '#40 Meals spec', Proposal: BUILD_PLAN.path, 'At commit': BUILD_PLAN.sha, 'Approved by': 'maintainer-one', Issue: 'Build: Meals', Checklist: '1 item' });
    expect(q('#forge-confirm-body pre').textContent).toBe(BUILD_PLAN.body);
    expect(q('[data-action="forge-confirm-go"]').textContent).toBe('Open the issue');
    expect(document.activeElement).toBe(q('[data-action="forge-confirm-cancel"]'));
    click(q('[data-action="forge-confirm-go"]'));
    await settle();
    expect(server.posts()).toHaveLength(1);
    expect(server.posts()[0].url).toBe('/api/forge/pulls/40/build');
    expect(JSON.parse(server.posts()[0].init.body)).toEqual({ slug: '0040-meals', sha: BUILD_PLAN.sha, digest: 'b'.repeat(32) });
    expect($('forge-act-note').textContent).toBe('Build issue #60 opened for 0040-meals. Open on GitHub ↗');
    expect(await said()).toBe('Build issue #60 opened for 0040-meals.');
    expect(server.urls().filter((u) => u === '/api/forge/pulls/40')).toHaveLength(2); // the detail is read again
    expect(document.activeElement).toBe(q('[data-forge-build="0040-meals"]'));
  });

  it('an issue made before is found: said, with a link, and nothing is posted', async () => {
    const server = fakeServer({ buildPlan: { ...BUILD_PLAN, existing: { number: 60, url: 'https://git.example.test/owner/name/issues/60', state: 'open' } } });
    mount();
    await openSpec();
    click(q('[data-forge-build="0040-meals"]'));
    await settle();
    expect($('forge-confirm').hidden).toBe(true);
    expect($('forge-act-note').textContent).toBe('0040-meals has its build issue already: #60. Nothing new is made. Open on GitHub ↗');
    expect(server.posts()).toEqual([]);
  });

  it('a spec that lost its approval is refused in the server\'s words', async () => {
    fakeServer({ answers: { '/api/forge/pulls/40/build?slug=0040-meals': { status: 409, body: { ok: false, code: 'conflict', error: 'The latest review of 0040-meals by a maintainer (maintainer-one) sent it back; the build issue waits for an approval.' } } } });
    mount();
    await openSpec();
    click(q('[data-forge-build="0040-meals"]'));
    await settle();
    expect($('forge-confirm').hidden).toBe(true);
    expect($('forge-act-note').textContent).toMatch(/^No build issue was opened for pull request #40: The latest review of 0040-meals by a maintainer \(maintainer-one\) sent it back/);
  });
});

describe('step 3 and the rest of the panel are as they were', () => {
  it('the buttons are real buttons in the tab order, and nothing says an agent is launched', async () => {
    fakeServer();
    mount();
    await openIssues();
    const buttons = qa('[data-forge-spec]');
    expect(buttons.every((b) => b.tagName === 'BUTTON' && b.type === 'button' && b.tabIndex >= 0)).toBe(true);
    expect(q('#forge-panel').textContent).not.toMatch(/launch|agent run|start an agent/i);
  });

  it('the confirm dialog is the one Land it uses, set up again for each step', async () => {
    fakeServer({ posts: { '/api/forge/issues/7/spec': { status: 201, body: { ok: true, created: true, number: 7, pull: { number: 50, url: null } } } } });
    mount();
    await openIssues();
    click(q('[data-forge-spec="7"]'));
    await settle();
    click(q('[data-action="forge-confirm-cancel"]'));
    expect($('forge-confirm').hidden).toBe(true);
    click(q('[data-forge-kind="pulls"]'));
    await settle();
    click(q('[data-forge-pr="40"]'));
    await settle();
    click(q('[data-forge-build="0040-meals"]'));
    await settle();
    expect($('forge-confirm-title').textContent).toBe('Open the build issue for 0040-meals?');
    expect(q('[data-action="forge-confirm-go"]').disabled).toBe(false);
  });
});

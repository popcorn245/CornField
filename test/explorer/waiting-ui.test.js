// @vitest-environment happy-dom
/**
 * What is waiting on you (spec 0010), through the page's own markup with a fake server behind `fetch`: the number on the Work button and the tabs,
 * the tab title, opening on the oldest, the Specs groups with each row's review state and the search, the Runs groups, and what idle costs.
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
import { closeDrawer, copySpec } from '../../explorer/panels.js';
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
// @ts-expect-error plain JS modules, no declarations
import { resetFeedbackForTests } from '../../explorer/feedback.js';
import { explorerPage } from '../helpers.js';

const EXPLORER = path.resolve(__dirname, '../../explorer');
const page = explorerPage({ pieces: ['map'] });
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const css = ['tokens.css', 'explorer.css', 'house.css'].map((f) => fs.readFileSync(path.join(EXPLORER, f), 'utf8')).join('\n');
const NOW = Date.parse('2026-11-05T12:00:00Z');
const MAP = { nodes: [{ id: 'root', type: 'root', x: 0, y: 0, r: 20, color: '#336699', label: 'root', degree: 0 }], edges: [] };
const $ = (id) => document.getElementById(id);
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const said = async () => { await new Promise((r) => setTimeout(r, 600)); return $('map-announcer').textContent; }; // past the search's own 500 ms wait
const notice = () => { const el = $('forge-notice').cloneNode(true); el.querySelector('button')?.remove(); return el.textContent.trim(); };


const NOWMS = NOW;
const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();
const ID = (n) => `run-01JC8Z3Q5M7VXK2RT9N4B6HD${String(n).padStart(2, '0')}`;
const RUN = (n, status, extra = {}) => ({ kind: 'code', profile: null, refs: { issue: n }, open: !['done', 'failed', 'stopped'].includes(status), requestedBy: 'maintainer-one', requestedAt: ago(5), via: 'dashboard', limits: null, stopRequested: null, checks: null, pull: null, nodes: [], timeline: [], report: null, answer: null, runId: ID(n), status, ...extra });
const spec = (n, slug, { draft = false, review = null, pushed = 5, summary = '' } = {}) => ({
  slug, title: `Title of ${slug}`, summary, spec: null, source: `pull/${n}`, counts: { added: 1, changed: 0, removed: 0, scenarios: 1 }, errors: 0, review,
  pull: { number: n, title: 't', url: 'https://git.example.test/pull', draft, author: 'agent-four', createdAt: ago(pushed + 5), updatedAt: ago(pushed), pushedAt: ago(pushed) },
});
const local = (slug) => ({ slug, title: `Title of ${slug}`, summary: '', spec: null, source: 'checkout', counts: { added: 1, changed: 0, removed: 0, scenarios: 0 }, errors: 0, review: null });
const OK = (verdict, h, current = true, by = 'maintainer-one') => ({ verdict, by, at: ago(h), current });
/** Two to decide (21 waited longer), one changed since approved is #25 (third to decide), a sent back, an approved, a draft PR, and drafts */
const SPECS = [
  spec(21, '0021-old', { pushed: 50 }), spec(22, '0022-new', { pushed: 2 }), spec(23, '0023-approved', { review: OK('approved', 2) }),
  spec(24, '0024-sent', { review: OK('notes', 26) }), spec(25, '0025-changed', { review: OK('approved', 70, false), pushed: 20 }),
  spec(26, '0026-draftpr', { draft: true }), local('0030-local-a'), local('0031-local-b'),
];

function fakeServer(opts = {}) {
  const calls = [];
  let runs = opts.runs ?? [];
  let proposals = opts.proposals ?? SPECS;
  const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url, 'http://localhost');
    if (u.pathname === '/api/agent-runs') return json(200, { ok: true, runs, open: runs.filter((r) => r.open).length, maxOpen: 10, profiles: [], limits: {} });
    if (u.pathname === '/proposals') return json(200, proposals);
    if (['/api/forge/issues', '/api/forge/pulls', '/api/forge/threads', '/api/forge/deploys'].includes(u.pathname)) return json(200, { ok: true, at: ago(0.01), rate: '', items: [] });
    if (u.pathname === '/api/forge/work') return json(200, { ok: true, at: ago(0.01), rate: '', pulls: [], issues: [], branches: [], specs: [], agents: {} });
    return json(404, { ok: false, error: 'No such thing.', code: 'not-found' });
  }));
  return { calls, urls: () => calls.map((c) => c.url), setRuns: (r) => { runs = r; }, setProposals: (p) => { proposals = p; } };
}

function mount(clock = () => NOW) {
  document.head.innerHTML = `<title>cornfield</title><style>${css}</style>`;
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
  resetForgePanelForTests(clock);
  return initForgePanel({ forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' }, signIn: { login: 'maintainer-one' }, agents: { runs: true } }, { clock });
}
const groupTitles = () => qa('#forge-list .hx-spec-group > h3').map((h) => h.textContent);
const typeInto = (id, value) => { const el = $(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); resetFeedbackForTests(); });
afterEach(() => { closeForge({ restoreFocus: false }); if (document.getElementById('spec-drawer')) closeDrawer(); resetConnectionForTests(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = ''; });

describe('D1, D2: one number, the same everywhere', () => {
  it('counts the specs to decide and the runs that wait, on the Work button, the tabs and the tab title', async () => {
    fakeServer({ runs: [RUN(1, 'waiting', { timeline: [{ kind: 'report', at: ago(3) }] }), RUN(2, 'working')] });
    mount();
    await settle();
    // specs to decide: 21, 22, and 25 (approved, then changed) = 3; plus the run waiting = 4
    expect($('forge-btn-waiting').hidden).toBe(false);
    expect($('forge-btn-waiting').textContent).toBe('4');
    expect($('forge-btn-waiting').dataset.corn).toBe('waiting-badge');
    expect($('forge-btn').getAttribute('aria-label')).toBe('Work, 4 waiting on you');
    const specs = q('[data-forge-kind="specs"] .hx-forge-count');
    const runs = q('[data-forge-kind="work"] .hx-forge-count');
    expect([specs.textContent, specs.dataset.corn]).toEqual(['3', 'waiting-badge']);
    expect([runs.textContent, runs.dataset.corn]).toEqual(['1', 'waiting-badge']); // 2 are open, 1 waits: the badge says the share
    expect(q('[data-forge-kind="specs"]').getAttribute('aria-label')).toBe('Specs, 3 waiting on you');
    expect(q('[data-forge-kind="pulls"] .hx-forge-count').dataset.corn).toBe('count'); // the others keep their plain count
    expect(document.title).toBe('(4) cornfield'); // the page's own title, never a word of ours
    // a tab keeps its width when its count becomes a badge: the fill's padding is added to the count's 2ch (content-box) and the margin takes it back
    // (with the page's border-box the padding came out of the 2ch and the tab shrank by 7px; measured in a browser, under 1px now)
    const css = fs.readFileSync(path.join(__dirname, '../../explorer/explorer.css'), 'utf8');
    expect(css).toMatch(/\.hx-forge-count\.hx-forge-count--waiting \{ box-sizing: content-box; padding: 0 var\(--corn-space-1\); margin: 0 calc\(var\(--corn-space-1\) \* -2\) 0 0;/);
  });

  it('shows no badge at 0, a plain total on the tabs, and the title as it was', async () => {
    fakeServer({ runs: [RUN(2, 'working')], proposals: [spec(23, '0023-approved', { review: OK('approved', 2) }), spec(24, '0024-sent', { review: OK('notes', 26) }), spec(26, '0026-d', { draft: true })] });
    mount();
    await settle();
    expect($('forge-btn-waiting').hidden).toBe(true);
    expect($('forge-btn').getAttribute('aria-label')).toBe('Work');
    expect(q('[data-forge-kind="specs"] .hx-forge-count').dataset.corn).toBe('count');
    expect(q('[data-forge-kind="specs"] .hx-forge-count').textContent).toBe('3');
    expect(q('[data-forge-kind="work"] .hx-forge-count').textContent).toBe('1');
    expect(document.title).toBe('cornfield');
  });

  it('follows the app\'s own name, and drops the number when it falls to 0', async () => {
    const server = fakeServer({ proposals: [spec(21, '0021-old')] });
    mount();
    document.title = 'Bucket'; // what the server wrote from the config's title
    await settle();
    expect(document.title).toBe('(1) Bucket');
    server.setProposals([spec(21, '0021-old', { review: OK('approved', 1) })]);
    click(q('[data-action="toggle-forge"]'));
    await settle();
    expect($('forge-btn-waiting').hidden).toBe(true);
    expect(document.title).toBe('Bucket');
  });

  it('opens on the tab with the oldest thing waiting, else on the tab used last', async () => {
    fakeServer({ runs: [RUN(1, 'waiting', { requestedAt: ago(90), timeline: [{ kind: 'report', at: ago(80) }] })] }); // older than the oldest spec (50 h)
    mount();
    await settle();
    click($('forge-btn'));
    await settle();
    expect(q('[data-forge-kind="work"]').getAttribute('aria-pressed')).toBe('true');
    closeForge({ restoreFocus: false });
    resetForgePanelForTests();
    fakeServer({ runs: [RUN(1, 'waiting', { timeline: [{ kind: 'report', at: ago(1) }] })] }); // the run is newer than the oldest spec
    mount();
    await settle();
    click($('forge-btn'));
    await settle();
    expect(q('[data-forge-kind="specs"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('says a run waiting is found in one click: the Runs tab lists it under Needs you', async () => {
    fakeServer({ runs: [RUN(1, 'waiting', { requestedAt: ago(90), timeline: [{ kind: 'report', at: ago(80) }] })] });
    mount();
    await settle();
    click($('forge-btn'));
    await settle();
    expect(q('#forge-runs-list [data-corn="run-group"]').textContent).toBe('Needs you · 1');
    expect(q('#forge-runs-list [data-run] [data-run-answer="continue"]')).not.toBe(null);
  });
});

describe('D3, D4: the Specs groups and each row\'s review state', () => {
  const open = async (extra = {}) => { const s = fakeServer(extra); mount(); openForge({ tab: 'specs' }); await settle(); return s; };

  it('groups by who must act, in order, and leaves out an empty group', async () => {
    await open();
    expect(groupTitles()).toEqual(['To decide · 3', 'With the agent · 2', 'Approved · 1', 'Drafts · 2']);
    expect(qa('#forge-list .hx-spec-group').map((g) => g.dataset.corn)).toEqual(['spec-group', 'spec-group', 'spec-group', 'spec-group']);
    const decide = qa('#forge-list [data-group="decide"] .hx-forge-title').map((t) => t.textContent);
    expect(decide).toEqual(['Title of 0021-old', 'Title of 0025-changed', 'Title of 0022-new']); // waiting longest first
    fakeServer({ proposals: [spec(21, '0021-old')] });
    resetForgePanelForTests();
    mount();
    openForge({ tab: 'specs' });
    await settle();
    expect(groupTitles()).toEqual(['To decide · 1']);
  });

  it('says each row\'s state in words, with who and when, and a state a theme can style', async () => {
    await open();
    const pill = (slug) => q(`#forge-list [data-slug="${slug}"] [data-corn="review-state"]`);
    expect(pill('0021-old').textContent).toBe('To decide');
    expect(pill('0021-old').dataset.cornState).toBe('waiting');
    expect(pill('0025-changed').textContent).toBe('Changed since approved');
    expect(pill('0024-sent').textContent).toBe('Sent back');
    expect(pill('0024-sent').dataset.cornState).toBe('sent-back');
    expect(pill('0023-approved').textContent).toBe('Approved');
    expect(pill('0023-approved').dataset.cornState).toBe('success');
    expect(pill('0026-draftpr').textContent).toBe('Draft PR');
    expect(pill('0030-local-a').textContent).toBe('Local');
    const facts = (slug) => q(`#forge-list [data-slug="${slug}"] .hx-forge-facts`).textContent;
    expect(facts('0023-approved')).toContain('Approved by maintainer-one · 2 hours ago');
    expect(facts('0024-sent')).toContain('Sent back by maintainer-one · 1 day ago');
    expect(facts('0021-old')).toContain('Waiting 2 days');
    for (const p of qa('[data-corn="review-state"]')) expect(p.querySelector('svg, .hx-state-icon') !== null || p.dataset.cornState === 'draft').toBe(true); // a shape as well as a word
  });

  it('escapes a login and a title from the forge, and takes the pill\'s state from a fixed list', async () => {
    await open({ proposals: [{ ...spec(21, '0021-x', { review: { verdict: 'approved', by: '<img src=x onerror=alert(1)>', at: ago(1), current: true } }), title: '<b>bold</b>' }] });
    expect(q('#forge-list img')).toBe(null);
    expect(q('#forge-list b')).toBe(null);
    expect(q('#forge-list [data-slug="0021-x"]').textContent).toContain('<img src=x onerror=alert(1)>');
    const hostile = { ...spec(22, '0022-y'), review: { verdict: 'approved"><i>', by: 'x', at: ago(1), current: 'yes' } };
    fakeServer({ proposals: [hostile] });
    resetForgePanelForTests();
    mount();
    openForge({ tab: 'specs' });
    await settle();
    expect(q('#forge-list i')).toBe(null);
    expect(['waiting', 'sent-back', 'success', 'draft', 'failure']).toContain(q('[data-corn="review-state"]').dataset.cornState);
  });

  it('says when a review could not be read, never makes the row look unreviewed, and does not count it', async () => {
    const server = await open({ proposals: [spec(21, '0021-x', { review: { error: 'GitHub did not answer.' } }), spec(22, '0022-y')] });
    const row = q('#forge-list [data-slug="0021-x"]');
    expect(row.querySelector('[data-corn="review-state"]').textContent).toBe('Review state unknown');
    expect(row.closest('li').textContent).toContain('GitHub did not answer.');
    expect(row.closest('li').querySelector('[data-action="retry-forge"]').textContent).toBe('Try again');
    expect($('forge-btn-waiting').textContent).toBe('1'); // only the one that is known to wait
    server.setProposals([spec(21, '0021-x', { review: OK('approved', 1) }), spec(22, '0022-y')]);
    click(row.closest('li').querySelector('[data-action="retry-forge"]'));
    await settle();
    expect(q('#forge-list [data-slug="0021-x"] [data-corn="review-state"]').textContent).toBe('Approved');
  });

  it('folds Drafts past ten rows behind their heading, and opens them with the keyboard\'s own button', async () => {
    await open({ proposals: Array.from({ length: 12 }, (_, i) => local(`00${40 + i}-d`)) });
    const toggle = q('[data-spec-group-toggle="drafts"]');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(q('#spec-group-drafts-list').hidden).toBe(true);
    toggle.focus();
    click(toggle);
    expect(q('#spec-group-drafts-list').hidden).toBe(false);
    expect(q('[data-spec-group-toggle="drafts"]').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(q('[data-spec-group-toggle="drafts"]')); // the focus stays on the heading
  });
});

describe('D5: the search field', () => {
  it('filters titles, slugs and summaries as you type, says "2 of 6" in a group, and says when nothing matches', async () => {
    fakeServer({ proposals: [spec(21, '0021-export', { summary: 'Retire the old export' }), spec(22, '0022-login'), spec(23, '0023-exportish'), spec(24, '0024-x'), spec(25, '0025-y'), spec(26, '0026-z')] });
    mount();
    openForge({ tab: 'specs' });
    await settle();
    expect($('forge-specs-search').hidden).toBe(false);
    expect($('forge-specs-search').dataset.corn).toBe('specs-search');
    typeInto('specs-search', 'export');
    expect(groupTitles()).toEqual(['To decide · 2 of 6']);
    expect(qa('#forge-list .hx-forge-item')).toHaveLength(2);
    expect(await said()).toBe('2 specs shown, 6 to decide');
    typeInto('specs-search', 'RETIRE');
    expect(qa('#forge-list .hx-forge-item')).toHaveLength(1); // the summary matches too
    typeInto('specs-search', 'zzz');
    expect(q('#forge-list .hx-forge-empty').textContent).toContain('No spec matches \u201czzz\u201d');
    expect(await said()).toBe('No spec matches zzz');
    expect(document.activeElement).not.toBe(q('#forge-list')); // nothing took the focus from the field
    click(q('[data-action="clear-specs-search"]'));
    expect($('specs-search').value).toBe('');
    expect(qa('#forge-list .hx-forge-item')).toHaveLength(6);
    expect(document.activeElement).toBe($('specs-search'));
  });

  it('is only on the Specs tab, and the Filter chip stays off there', async () => {
    fakeServer();
    mount();
    openForge({ tab: 'specs' });
    await settle();
    expect($('forge-filter-chip').hidden).toBe(true);
    click(q('[data-forge-kind="pulls"]'));
    await settle();
    expect($('forge-specs-search').hidden).toBe(true);
  });
});

describe('D6: the Runs groups', () => {
  it('lists Needs you (oldest question first), In motion and Finished, each with its heading and count', async () => {
    fakeServer({ runs: [
      RUN(1, 'waiting', { timeline: [{ kind: 'report', at: ago(2) }] }), RUN(2, 'waiting', { timeline: [{ kind: 'report', at: ago(9) }] }),
      RUN(3, 'working', { requestedAt: ago(4) }), RUN(4, 'requested', { requestedAt: ago(1) }),
      RUN(5, 'done', { requestedAt: ago(30) }), RUN(6, 'failed', { requestedAt: ago(10) }),
    ] });
    mount();
    openForge({ tab: 'work' });
    await settle();
    const order = qa('#forge-runs-list > li').map((li) => (li.dataset.corn === 'run-group' ? `# ${li.textContent}` : li.dataset.run.slice(-2)));
    expect(order).toEqual(['# Needs you · 2', '02', '01', '# In motion · 2', '04', '03', '# Finished · 2', '06', '05']);
    expect(q('[data-corn="run-group"]').dataset.group).toBe('needs');
    expect(q('[data-forge-kind="work"] .hx-forge-count').textContent).toBe('2');
  });
});

describe('the proposal bar\'s line', () => {
  const waitingRun = RUN(1, 'waiting', { refs: { proposal: '0042-x' }, report: { state: 'waiting', at: ago(1), by: 'r', note: 'Plan ready <b>approve</b> to build', url: null, tokens: null, cost: null }, timeline: [{ kind: 'report', at: ago(1) }] });
  const showBar = async () => {
    const { hooks } = await import('../../explorer/proposal.js');
    Object.assign(state, { proposal: {}, proposalSlug: '0042-x', proposalSource: 'pull/42' });
    hooks.bar(true);
    return hooks;
  };
  it('says a run is waiting on the open proposal, escapes the runner\'s words, and Answer opens Runs at it with the reply field focused', async () => {
    fakeServer({ runs: [waitingRun], proposals: [] });
    mount();
    await settle();
    const hooks = await showBar();
    const line = q('[data-corn="waiting-line"]');
    expect(line.hidden).toBe(false);
    expect(line.textContent).toContain('A run is waiting on you: Plan ready <b>approve</b> to build');
    expect(line.querySelector('b')).toBe(null);
    expect(line.querySelector('[data-waiting-answer]').textContent).toBe('Answer');
    expect(line.closest('#proposal-body')).not.toBe(null);
    click(line.querySelector('[data-waiting-answer]'));
    await settle();
    expect(q('[data-forge-kind="work"]').getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(q(`[data-run-reply="${ID(1)}"]`));
    hooks.bar(false);
    expect(line.hidden).toBe(true);
    Object.assign(state, { proposal: null, proposalSlug: null, proposalSource: null });
  });

  it('is not there for another proposal', async () => {
    fakeServer({ runs: [waitingRun], proposals: [] });
    mount();
    await settle();
    const { hooks } = await import('../../explorer/proposal.js');
    Object.assign(state, { proposal: {}, proposalSlug: '0099-other', proposalSource: 'pull/99' });
    hooks.bar(true);
    expect(q('[data-corn="waiting-line"]').hidden).toBe(true);
    Object.assign(state, { proposal: null, proposalSlug: null, proposalSource: null });
  });
});

describe('what idle costs', () => {
  it('reads the proposals once at load, the runs once, and then only the runs each 60 s and the proposals each 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = fakeServer({ runs: [RUN(1, 'waiting')] });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    const count = (path) => server.urls().filter((u) => u === path).length;
    expect([count('/proposals'), count('/api/agent-runs')]).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(59_000);
    expect([count('/proposals'), count('/api/agent-runs')]).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(2_000); // 61 s
    expect([count('/proposals'), count('/api/agent-runs')]).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(4 * 60_000); // past 5 minutes
    expect(count('/proposals')).toBe(2);
    expect(server.urls().filter((u) => u !== '/proposals' && u !== '/api/agent-runs')).toEqual([]); // nothing else is asked while idle
  });

  it('asks nothing at all when nobody is signed in', async () => {
    const server = fakeServer();
    document.body.innerHTML = body;
    resetForgePanelForTests();
    expect(initForgePanel({ forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' }, signIn: false })).toBe(false);
    await settle();
    expect(server.urls()).toEqual([]);
  });

  it('reads the proposals again when a review is sent (Approve or Send back)', async () => {
    const server = fakeServer();
    mount();
    await settle();
    const before = server.urls().filter((u) => u === '/proposals').length;
    const { hooks } = await import('../../explorer/proposal.js');
    hooks.reviewed();
    await settle();
    expect(server.urls().filter((u) => u === '/proposals').length).toBe(before + 1);
  });
});

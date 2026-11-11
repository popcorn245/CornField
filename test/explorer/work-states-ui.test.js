// @vitest-environment happy-dom
/**
 * The Work panel's feedback and state (the 0.34 design review, batch C), through the page's own markup with a fake server behind `fetch`:
 * a refresh that does not disturb a reply being typed (F03), run states that differ without colour (F34), one row for each proposal (F36),
 * plain errors with Retry (F37), offline said once (F38), results by the control and announced (F39), formatted cost and tokens (F40),
 * a phone's tabs and fixed top (F42), runs named by what the card shows (F43), loading and empty lists (F44) and the focus after Stop (F12).
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
import { runsHtml, loadingRowsHtml, loadingLinesHtml } from '../../explorer/runs-view.js';
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
import { resetFeedbackForTests, RESULT_MS } from '../../explorer/feedback.js';

const EXPLORER = path.resolve(__dirname, '../../explorer');
const page = fs.readFileSync(path.join(EXPLORER, 'index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const css = ['tokens.css', 'explorer.css', 'house.css'].map((f) => fs.readFileSync(path.join(EXPLORER, f), 'utf8')).join('\n');
const NOW = Date.parse('2026-11-05T12:00:00Z');
const MAP = { nodes: [{ id: 'root', type: 'root', x: 0, y: 0, r: 20, color: '#336699', label: 'root', degree: 0 }], edges: [] };
const $ = (id) => document.getElementById(id);
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const said = async () => { await new Promise((r) => setTimeout(r, 50)); return $('map-announcer').textContent; };
const notice = () => { const el = $('forge-notice').cloneNode(true); el.querySelector('button')?.remove(); return el.textContent.trim(); };

const ID = (n) => `run-01JC8Z3Q5M7VXK2RT9N4B6HD${String(n).padStart(2, '0')}`;
const base = { kind: 'code', profile: null, refs: { issue: 7 }, open: true, requestedBy: 'maintainer-one', requestedAt: '2026-11-05T11:00:00Z', via: 'dashboard', limits: null, stopRequested: null, checks: null, pull: null, nodes: [], timeline: [], report: null };
const RUN = (n, status, extra = {}) => ({ ...base, runId: ID(n), status, ...extra });
/** One run in each of the seven states, each about its own issue */
const SEVEN = [
  RUN(1, 'requested', { refs: { issue: 1 } }),
  RUN(2, 'claimed', { refs: { issue: 2 } }),
  RUN(3, 'working', { refs: { issue: 3 }, nodes: ['root'], report: { state: 'working', at: '2026-11-05T11:30:00Z', by: 'runner-bot', note: '', url: null, tokens: 47000, cost: 1.4499999999999997 } }),
  RUN(4, 'waiting', { refs: { issue: 4 }, report: { state: 'waiting', at: '2026-11-05T11:40:00Z', by: 'runner-bot', note: 'Plan ready', url: null, tokens: null, cost: null }, answer: null }),
  RUN(5, 'done', { refs: { issue: 5 }, open: false }),
  RUN(6, 'failed', { refs: { issue: 6 }, open: false }),
  RUN(7, 'stopped', { refs: { issue: 7 }, open: false }),
];
const proposal = (slug, source, extra = {}) => ({ slug, title: `Title of ${slug}`, summary: '', spec: null, source, counts: { added: 1, changed: 0, removed: 0, scenarios: 1 }, errors: 0, review: null, ...extra });

/** A fake server. `opts`: runs, proposals, issues (items or a status), hang (urls that never answer), fail (url -> { status, body } or 'down') */
function fakeServer(opts = {}) {
  const calls = [];
  const held = {}; // requests held by `hang`, by path: `release` answers them (with an empty work answer; only /api/forge/work is released)
  let runs = opts.runs ?? SEVEN;
  const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url, 'http://localhost');
    const failure = opts.fail && opts.fail[u.pathname];
    if (failure === 'down') throw new TypeError('Failed to fetch');
    if (failure === 'badjson') return { ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError('Unterminated string in JSON at position 25'); } };
    if (failure) return json(failure.status, failure.body);
    if (opts.hang && opts.hang.includes(u.pathname)) return new Promise((resolve) => { (held[u.pathname] ||= []).push(() => resolve(json(200, { ok: true, at: '2026-11-05T11:58:00Z', rate: '', pulls: [], issues: [], branches: [], specs: [], agents: {} }))); });
    if (init.method === 'POST' && /\/answer$/.test(u.pathname)) {
      const sent = JSON.parse(init.body);
      runs = runs.map((r) => (u.pathname.includes(r.runId) ? { ...r, answer: { ...sent, at: '2026-11-05T11:58:00Z', by: 'maintainer-one' } } : r));
      return json(200, { ok: true });
    }
    if (init.method === 'POST' && /\/stop$/.test(u.pathname)) {
      runs = runs.map((r) => (u.pathname.includes(r.runId) ? { ...r, status: 'stop-requested', stopRequested: { at: '2026-11-05T11:58:00Z', by: 'maintainer-one' } } : r));
      return json(200, { ok: true });
    }
    if (u.pathname === '/api/agent-runs') return json(200, { ok: true, runs, open: runs.filter((r) => r.open).length, maxOpen: 10, profiles: [], limits: {} });
    if (u.pathname === '/api/forge/issues') return json(200, { ok: true, at: '2026-11-05T11:58:00Z', rate: '', items: opts.issues ?? [] });
    if (u.pathname === '/api/forge/pulls') return json(200, { ok: true, at: '2026-11-05T11:58:00Z', rate: '', items: opts.pulls ?? [] });
    if (u.pathname === '/api/forge/threads') return json(200, { ok: true, at: '2026-11-05T11:58:00Z', rate: '', items: [] });
    if (u.pathname === '/api/forge/deploys') return json(200, { ok: true, at: '2026-11-05T11:58:00Z', rate: '', items: [] });
    if (u.pathname === '/api/forge/work') return json(200, { ok: true, at: '2026-11-05T11:58:00Z', rate: '', pulls: [], issues: [], branches: [], specs: [], agents: {} });
    if (u.pathname === '/proposals') return json(200, opts.proposals ?? []);
    return json(404, { ok: false, error: 'No such thing.', code: 'not-found' });
  }));
  return { calls, urls: () => calls.map((c) => c.url), setRuns: (r) => { runs = r; }, release: (p) => { opts.hang = opts.hang.filter((h) => h !== p); (held[p] || []).splice(0).forEach((f) => f()); } };
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
  return initForgePanel({ forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' }, signIn: { login: 'maintainer-one' } }, { clock });
}
const openTab = async (tab) => { openForge({ tab: 'pulls' }); await settle(); if (tab !== 'pulls') { click(q(`[data-forge-kind="${tab}"]`)); await settle(); } };
const setOnline = (on) => Object.defineProperty(navigator, 'onLine', { value: on, configurable: true });

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); resetFeedbackForTests(); });
afterEach(() => { closeForge({ restoreFocus: false }); if (document.getElementById('spec-drawer')) closeDrawer(); resetConnectionForTests(); setOnline(true); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = ''; });

describe('a refresh does not disturb a reply being typed (F03)', () => {
  it('keeps the same field, the caret and the focus, so text typed after a refresh goes where the caret was', async () => {
    fakeServer({ runs: [SEVEN[3]] });
    mount();
    await openTab('work');
    const field = q('[data-run-reply]');
    field.focus();
    field.value = 'Keep the old page ';
    field.setSelectionRange(18, 18);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    // the runs are read again (what the 60 s poll does) and the list is drawn again
    click(q('[data-action="refresh-forge"]'));
    await settle();
    expect(q('[data-run-reply]')).toBe(field); // not a new input
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([18, 18]);
    field.setRangeText('until Friday.', field.selectionStart, field.selectionEnd, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    click(q('[data-action="refresh-forge"]'));
    await settle();
    expect(q('[data-run-reply]').value).toBe('Keep the old page until Friday.');
  });

  it('keeps a selection, and a reply typed but not focused, and still brings the other cards up to date', async () => {
    const server = fakeServer({ runs: [SEVEN[3], SEVEN[2]] });
    mount();
    await openTab('work');
    const field = q('[data-run-reply]');
    field.focus();
    field.value = 'Use the second plan';
    field.setSelectionRange(4, 10);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    server.setRuns([SEVEN[3], { ...SEVEN[2], status: 'done', open: false }]);
    click(q('[data-action="refresh-forge"]'));
    await settle();
    expect([field.selectionStart, field.selectionEnd]).toEqual([4, 10]);
    expect(q(`[data-run="${ID(3)}"] [data-corn="state-pill"]`).textContent).toContain('Done'); // the card without a field follows the runs
    field.blur();
    click(q('[data-action="refresh-forge"]'));
    await settle();
    expect(q('[data-run-reply]').value).toBe('Use the second plan'); // unsent text survives a draw too
  });

  it('lets go of a field the run no longer asks for', async () => {
    const server = fakeServer({ runs: [SEVEN[3]] });
    mount();
    await openTab('work');
    q('[data-run-reply]').focus();
    server.setRuns([{ ...SEVEN[3], status: 'stop-requested', stopRequested: { at: 'x', by: 'y' } }]);
    click(q('[data-action="refresh-forge"]'));
    await settle();
    expect(q('[data-run-reply]')).toBe(null);
  });

  it('brings the rest of a card being typed in up to date, and keeps the field', async () => {
    const server = fakeServer({ runs: [SEVEN[3]] });
    mount();
    await openTab('work');
    const field = q('[data-run-reply]');
    field.focus();
    field.value = 'Plan B';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    server.setRuns([{ ...SEVEN[3], report: { ...SEVEN[3].report, note: 'Plan ready, second version' } }]);
    click(q('[data-action="refresh-forge"]'));
    await settle();
    expect(q('[data-run-reply]')).toBe(field);
    expect(q(`[data-run="${ID(4)}"]`).textContent).toContain('Plan ready, second version');
  });

  it('keeps what was typed, and says so, when the run stops waiting while a reply is typed', async () => {
    const server = fakeServer({ runs: [SEVEN[3]] });
    mount();
    await openTab('work');
    const field = q('[data-run-reply]');
    field.focus();
    field.value = 'Keep the old page';
    field.setSelectionRange(5, 8);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    server.setRuns([{ ...SEVEN[3], status: 'working' }]);
    click(q('[data-action="refresh-forge"]'));
    await settle();
    // the same field, focused, with its text and selection: a phone's keyboard does not close, nothing typed is lost
    expect(q('[data-run-reply]')).toBe(field);
    expect(document.activeElement).toBe(field);
    expect([field.value, field.selectionStart, field.selectionEnd]).toEqual(['Keep the old page', 5, 8]);
    // and the change is not hidden: the card says Working, says the reply was not sent, and has no Reply button
    const card = q(`[data-run="${ID(4)}"]`);
    expect(card.dataset.cornState).toBe('working');
    expect(card.querySelector('[data-corn="state-pill"]').textContent).toBe('Working');
    expect(card.querySelector('[data-corn="message"]').textContent).toMatch(/now working and no longer waits for a reply, so what you typed was not sent/);
    expect(card.querySelector('[data-run-answer]')).toBe(null);
    // Discard lets it go, and the focus goes to the card
    click(card.querySelector('[data-run-discard]'));
    await settle();
    expect(q('[data-run-reply]')).toBe(null);
    expect(document.activeElement).toBe(q(`[data-run="${ID(4)}"]`));
  });

  it('puts the focus on the card, not the page, when a field with nothing typed goes', async () => {
    const server = fakeServer({ runs: [SEVEN[3]] });
    mount();
    await openTab('work');
    q('[data-run-reply]').focus();
    server.setRuns([{ ...SEVEN[3], status: 'working' }]);
    click(q('[data-action="refresh-forge"]'));
    await settle();
    expect(document.activeElement).toBe(q(`[data-run="${ID(4)}"]`));
  });
});

describe('the seven run states differ without colour (F34)', () => {
  it('give each its own state value, word and icon, and the waiting one the solid pill', () => {
    const host = document.createElement('ul');
    const ctx = { esc: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`), safeUrl: () => null, forgeName: 'GitHub', forgeType: 'github', repoUrl: null, now: NOW, nodes: [], selected: null, timelines: new Set(), replies: new Map(), busy: false };
    host.innerHTML = runsHtml(ctx, SEVEN);
    const pills = [...host.querySelectorAll('.hx-run-head [data-corn="state-pill"]')];
    expect(pills.map((p) => p.dataset.cornState)).toEqual(['requested', 'claimed', 'working', 'waiting', 'done', 'failed', 'stopped']);
    expect(new Set(pills.map((p) => p.dataset.cornState)).size).toBe(7);
    expect(pills.map((p) => p.textContent.trim())).toEqual(['Requested', 'Claimed', 'Working', 'Waiting', 'Done', 'Failed', 'Stopped']); // a word always
    const shapes = pills.map((p) => p.querySelector('[data-corn="state-icon"]').innerHTML);
    expect(new Set(shapes).size).toBe(7); // a distinct icon each
    for (const p of pills) expect(p.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
    expect(pills.map((p) => p.className.match(/hx-forge-state--(\w+)/)[1])).toEqual(['requested', 'claimed', 'working', 'waiting', 'done', 'failed', 'stopped']);
    // the card carries the same state as its pill
    expect([...host.querySelectorAll('[data-corn="run"]')].map((c) => c.dataset.cornState)).toEqual(pills.map((p) => p.dataset.cornState));
  });

  it('keep the public list, the tones and the quiet and stop-requested words consistent', () => {
    expect([...RUN_STATES]).toEqual(['requested', 'claimed', 'working', 'waiting', 'done', 'failed', 'stopped']);
    for (const s of RUN_STATES) { expect(CORN_STATES).toContain(s); expect(runTone({ status: s })).toBe(s); expect(cornState(s)).toBe(s); }
    expect(runTone({ status: 'quiet' })).toBe('waiting');
    expect(runTone({ status: 'stop-requested' })).toBe('stopped'); // asked to stop is not in motion
    expect(runTone({ status: 'merged' })).toBe('done');
    expect(RUN_TONE.stopped).toBeUndefined();
  });

  it('give the check states their own shapes too, and no two of the five that can be told apart share one', () => {
    const icons = ['success', 'failure', 'running', 'queued', 'neutral', 'cancelled'].map((s) => stateIconHtml(s));
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(6);
    expect(stateIconHtml('open')).toBe(''); // a word with no icon draws none
  });

  it('have a colour token each, read by the pill, in docs/theming.md and tokens.css, and the waiting pill is solid', () => {
    const docs = fs.readFileSync(path.resolve(__dirname, '../../docs/theming.md'), 'utf8');
    for (const s of RUN_STATES) {
      expect(css).toContain(`--corn-run-${s}:`);
      expect(docs).toContain(`\`--corn-run-${s}\``);
      expect(css).toMatch(new RegExp(`\\.hx-forge-state--${s} \\{[^}]*var\\(--corn-run-${s}`));
    }
    expect(css).toMatch(/\.hx-forge-state--waiting \{[^}]*background: var\(--corn-run-waiting\)/);
    expect(docs).toContain('`--corn-run-waiting-ink`');
    // the section is whole: no merge marker or comment cut in two swallows the first rule after it
    expect(css).not.toMatch(/^(<{7}|={7}|>{7})/m);
    expect(css).toMatch(/\/\* =+\n {3}The Work panel's states/);
    // a node button is not drawn as a pill, and nothing animates under reduced motion
    expect(css).toMatch(/\.hx-forge-node \{[^}]*border-radius: var\(--corn-radius-sm\)/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.hx-state-spin \{ animation: none/);
  });

  it('draw the state in the thread row and the pull request detail too', async () => {
    fakeServer({ runs: [SEVEN[2]] });
    mount();
    await openTab('work');
    expect(q(`[data-run="${ID(3)}"] [data-corn="state-pill"] [data-corn="state-icon"]`)).not.toBe(null);
  });
});

describe('one row for each proposal (F36)', () => {
  const LIST = [
    proposal('0100-a', 'checkout'), proposal('0101-b', 'checkout'), proposal('0102-c', 'w-1'),
    proposal('0100-a', 'pull/21', { pull: { number: 21, draft: false } }), proposal('0101-b', 'pull/22', { pull: { number: 22, draft: true } }),
  ];

  it('merges the PR\'s entry and the local copy into the PR\'s row, which says both', () => {
    const rows = mergeSpecs(LIST);
    expect(rows.map((r) => r.slug)).toEqual(['0100-a', '0101-b', '0102-c']);
    expect(rows[0].source).toBe('pull/21');
    expect(specWhere(rows[0])).toBe('PR #21, and a copy in the checkout');
    expect(specWhere(rows[2])).toBe('in worktree w-1');
    expect(mergeSpecs([proposal('x', 'checkout'), proposal('x', 'w-1')]).map((r) => specWhere(r))).toEqual(['in the checkout, and in worktree w-1']);
    // an entry that could not be read is never hidden behind another
    expect(mergeSpecs([proposal('y', 'checkout'), { slug: 'y', source: 'pull/5', pull: { number: 5 }, error: 'It is not valid JSON.' }]).map((r) => r.source)).toEqual(['pull/5', 'checkout']);
    // the ones that can be reviewed come first, whatever their number: open spec PRs, then drafts on a PR, then local drafts
    expect(mergeSpecs([proposal('0001-l', 'checkout'), proposal('0090-d', 'pull/8', { pull: { number: 8, draft: true } }), proposal('0099-o', 'pull/9', { pull: { number: 9 } })]).map((r) => r.slug)).toEqual(['0099-o', '0090-d', '0001-l']);
    // nor a local copy that could not be read behind its PR's row
    const z = mergeSpecs([{ slug: 'z', source: 'checkout', error: 'It is not valid JSON.' }, proposal('z', 'pull/6', { pull: { number: 6 } })]);
    expect(z.map((r) => [r.source, r.error || '', r.also || []])).toEqual([['pull/6', '', []], ['checkout', 'It is not valid JSON.', []]]);
  });

  it('lists the Specs tab with one row for each, and the count matches the rows', async () => {
    fakeServer({ proposals: LIST });
    mount();
    openForge();
    await settle();
    const rows = qa('#forge-list > li');
    expect(rows).toHaveLength(3);
    expect(q('[data-forge-kind="specs"] .hx-forge-count').textContent).toBe('3');
    expect($('forge-status').textContent).toMatch(/^3 proposals/);
    expect(rows[0].textContent).toContain('PR #21, and a copy in the checkout');
  });
});

describe('errors are plain and offer Retry (F37)', () => {
  it('says what could not be loaded, offers Retry, and asks again when it is pressed', async () => {
    const server = fakeServer({ fail: { '/api/forge/pulls': { status: 500, body: null } } });
    mount();
    openForge({ tab: 'pulls' });
    await settle();
    expect(notice()).toBe('Could not load the pull requests. The server had a problem (error 500). Try again in a minute.');
    expect(notice()).not.toMatch(/cornfield answered/);
    const retry = q('#forge-notice [data-action="retry-forge"]');
    expect(retry.textContent).toBe('Retry');
    retry.focus();
    const before = server.urls().filter((u) => u.startsWith('/api/forge/pulls')).length;
    click(retry);
    await settle();
    expect(server.urls().filter((u) => u.startsWith('/api/forge/pulls')).length).toBeGreaterThan(before);
    expect(document.activeElement).not.toBe(document.body); // the focus is not dropped on the page
  });

  it('does not let an unreadable answer read as success, and never echoes a parser\'s words', async () => {
    fakeServer({ fail: { '/api/forge/pulls': 'badjson' } });
    mount();
    openForge({ tab: 'pulls' });
    await settle();
    expect(notice()).toBe('Could not load the pull requests. cornfield sent an answer this page could not read. Try again.');
    expect($('forge-notice').textContent).not.toMatch(/Unterminated|JSON|200/);
  });

  it('words a Specs list that cannot be read plainly, with Retry', async () => {
    fakeServer({ fail: { '/proposals': 'badjson' } });
    mount();
    openForge();
    await settle();
    expect(notice()).toBe('Could not load the proposals. cornfield sent a list this page could not read.');
    expect(q('#forge-notice [data-action="retry-forge"]')).not.toBe(null);
  });

  it('gives the runs list its own failure line with Retry', async () => {
    fakeServer({ fail: { '/api/agent-runs': { status: 502, body: { ok: false, error: 'cornfield could not read its runs.' } } } });
    mount();
    await openTab('work');
    expect($('forge-runs-note').textContent).toMatch(/^Could not load the runs\. cornfield could not read its runs\./);
    expect(q('#forge-runs-note [data-action="retry-forge"]')).not.toBe(null);
  });
});

describe('offline is said once, in one place (F38)', () => {
  it('shows the banner and announces once when the browser goes offline, and says when it is back', async () => {
    fakeServer({ runs: [] });
    mount();
    expect($('offline-banner').hidden).toBe(true);
    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    expect($('offline-banner').hidden).toBe(false);
    expect($('offline-banner').textContent).toBe(OFFLINE_WORDS);
    expect(await said()).toBe(OFFLINE_WORDS);
    setOnline(true);
    window.dispatchEvent(new Event('online'));
    expect($('offline-banner').textContent).toBe(ONLINE_WORDS);
    expect(await said()).toBe(ONLINE_WORDS);
  });

  it('does not blame the server for a failed fetch while offline, and keeps a reply that was not sent', async () => {
    const server = fakeServer({ runs: [SEVEN[3]] });
    mount();
    await openTab('work');
    const field = q('[data-run-reply]');
    field.value = 'Keep the old page';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    setOnline(false);
    server.setRuns([SEVEN[3]]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    click(q('[data-run-answer="reply"]'));
    await settle();
    expect(q(`[data-run-result="${ID(4)}"]`).textContent).toBe('You are offline. Your reply was not sent; what you typed is kept. Try again when you are back.');
    expect(q('[data-run-reply]').value).toBe('Keep the old page');
    expect($('forge-notice').textContent).not.toMatch(/could not be reached/);
    // and a list that cannot be read says offline, not "cornfield could not be reached"
    click(q('[data-action="refresh-forge"]'));
    await settle();
    expect($('forge-runs-note').textContent + $('forge-notice').textContent).toMatch(/You are offline/);
    expect($('forge-runs-note').textContent + $('forge-notice').textContent).not.toMatch(/could not be reached/);
  });

  it('reads a tab that failed again once the browser is back online, so its error goes with the cause', async () => {
    mount();
    setOnline(false);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    openForge({ tab: 'pulls' });
    await settle();
    expect($('forge-notice').hidden).toBe(false);
    setOnline(true);
    fakeServer({ pulls: [] });
    window.dispatchEvent(new Event('online'));
    await settle();
    expect($('forge-notice').hidden).toBe(true);
  });
});

describe('a result lands by the control, stays, and is announced (F39)', () => {
  it('puts the result of Reply in the run\'s card, below its button, announced, and keeps it through a refresh', async () => {
    fakeServer({ runs: [SEVEN[3]] });
    mount();
    await openTab('work');
    const field = q('[data-run-reply]');
    field.value = 'Plan B';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    click(q('[data-run-answer="reply"]'));
    await settle();
    const result = q(`[data-run-result="${ID(4)}"]`);
    expect(result.hidden).toBe(false);
    expect(result.textContent).toMatch(/^Sent your reply to this run\./);
    expect(result.dataset.cornState).toBe('success');
    expect(q(`[data-run="${ID(4)}"]`).contains(result)).toBe(true);
    expect(result.closest('li').querySelector('[data-run-answer="reply"]').compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await said()).toBe(result.textContent);
    click(q('[data-action="refresh-forge"]'));
    await settle();
    expect(q(`[data-run-result="${ID(4)}"]`).textContent).toBe(result.textContent); // it stays until the next action
    // the next action on the run clears it
    click(q('[data-run-answer="reply"]'));
    await settle();
    expect(q(`[data-run-result="${ID(4)}"]`).textContent).toBe('Write a reply first.');
    // and a refusal does not outlive what it was about: it goes once something is typed
    q('[data-run-reply]').value = 'Plan C';
    q('[data-run-reply]').dispatchEvent(new Event('input', { bubbles: true }));
    expect(q(`[data-run-result="${ID(4)}"]`).hidden).toBe(true);
    expect(q('#forge-runs-note').hidden).toBe(true); // the top of the list is for what concerns the whole list
  });

  it('says the result of Stop in the card of a run that is not waiting', async () => {
    fakeServer({ runs: [SEVEN[2]] });
    mount();
    await openTab('work');
    click(q('[data-forge-stop]'));
    await settle();
    expect(q(`[data-run-result="${ID(3)}"]`).textContent).toMatch(/to stop\. The runner decides/);
    expect(await said()).toMatch(/to stop/);
  });

  it('says Copy Spec\'s result under its button, announces it, and keeps it for at least five seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    document.body.innerHTML = '<div id="map-announcer"></div><p id="copy-spec-result" hidden></p><button id="b">Copy Spec</button>';
    state.selectedNode = { id: 'n', label: 'Orders' };
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) }, onLine: true });
    await copySpec($('b'));
    expect($('copy-spec-result').hidden).toBe(false);
    expect($('copy-spec-result').textContent).toBe('Copied the spec of Orders to the clipboard.');
    await vi.advanceTimersByTimeAsync(100);
    expect($('map-announcer').textContent).toBe('Copied the spec of Orders to the clipboard.');
    expect(RESULT_MS).toBeGreaterThanOrEqual(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect($('copy-spec-result').hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(RESULT_MS);
    expect($('copy-spec-result').hidden).toBe(true);
    // a refusal says what to do next
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, onLine: true });
    await copySpec($('b'));
    expect($('copy-spec-result').textContent).toMatch(/did not allow copying.*press Copy Spec again/);
    expect($('copy-spec-result').dataset.cornState).toBe('failure');
    state.selectedNode = null;
  });
});

describe('cost and tokens are formatted (F40)', () => {
  it('formats cost with a unit and two decimals, and tokens with separators', () => {
    expect(formatCost(1.4499999999999997)).toBe('1.45');
    expect(formatCost(1.7999999999999998)).toBe('1.80');
    expect(formatCost(0)).toBe('0.00');
    expect(formatCost(1234567.891)).toBe('1,234,567.89'); // very large: grouped, never "1.23e+6"
    for (const none of [null, undefined, NaN, '1.5']) expect(formatCost(none)).toBe('');
    expect(formatTokens(47000)).toBe('47,000 tokens');
    expect(formatTokens(1)).toBe('1 token');
    expect(formatTokens(1234567)).toBe('1,234,567 tokens');
    expect(formatTokens(null)).toBe('');
  });

  it('is what a run\'s meta line, its limits list and a pull request\'s run line show', () => {
    const run = { ...SEVEN[2], limits: { cost: 2.4999999999999996 } };
    expect(runMeta(run, NOW)).toContain('limits cost 2.50');
    expect(runMeta(run, NOW)).toContain('reported 47,000 tokens, cost 1.45');
    expect(runMeta(run, NOW)).not.toMatch(/1\.4499/);
    expect(limitRows(run).find((r) => r.name === 'Cost')).toEqual({ name: 'Cost', limit: '2.50', reported: '1.45' });
    expect(limitRows(run).find((r) => r.name === 'Tokens').reported).toBe('47,000');
    expect(pullRunWords({ ...run, pull: { number: 1 } }, NOW)).toContain('cost 1.45');
  });
});

describe('Can\'t land yet says what to do next (F41)', () => {
  const pull = (extra = {}) => ({ number: 12, state: 'open', draft: false, ...extra });
  it('warns of a spec whose proposal is not approved, in words only', () => {
    expect(approvalWarning({ pull: pull(), specs: [{ slug: '0013-meals', approved: false }] })).toBe('Its proposal 0013-meals is not approved yet. Next: approve it first (Specs, open the proposal, Approve), then land this.');
    expect(approvalWarning({ pull: pull(), specs: [{ slug: 'a', approved: true }] })).toBe('');
    expect(approvalWarning({ pull: pull(), specs: [] })).toBe('');
    expect(approvalWarning({ pull: pull({ state: 'merged' }), specs: [{ slug: 'a', approved: false }] })).toBe('');
  });
});

describe('the panel\'s top stays, and a phone shows the tabs run on (F42)', () => {
  it('has the title row and the tabs together in one fixed top, in the markup and the CSS', () => {
    document.body.innerHTML = body;
    const top = q('[data-corn="work-top"]');
    expect(top.classList.contains('hx-forge-top')).toBe(true);
    expect(top.contains(q('.hx-forge-head'))).toBe(true);
    expect(top.contains(q('.hx-forge-tabs'))).toBe(true);
    expect(top.parentElement.classList.contains('hx-forge-body')).toBe(true);
    expect(css).toMatch(/\.hx-forge-top \{[^}]*position: sticky; top: calc\(var\(--hx-forge-pad\) \* -1\)/);
    expect(css).toMatch(/\.hx-forge-top\[data-more~="end"\] \{ --hx-fade-r: /); // a fade on the side the tabs run on, a mask drawn from the spacing token
    expect(css).toMatch(/\.hx-forge-top \.hx-forge-tabs \{ mask-image: linear-gradient/);
    expect(css).toMatch(/\.hx-forge-top \{[^}]*background: linear-gradient\(var\(--corn-surface-1\), var\(--corn-surface-1\)\), var\(--corn-ground\)/); // opaque, so a list scrolls under it
  });

  it('says on the top which edge the tabs run past, and not when they fit', async () => {
    fakeServer({ runs: [] });
    mount();
    openForge();
    await settle();
    const tabs = q('.hx-forge-tabs');
    const top = q('.hx-forge-top');
    expect(top.dataset.more).toBeUndefined();
    Object.defineProperty(tabs, 'scrollWidth', { value: 477, configurable: true });
    Object.defineProperty(tabs, 'clientWidth', { value: 380, configurable: true });
    tabs.scrollLeft = 0;
    tabs.dispatchEvent(new Event('scroll'));
    expect(top.dataset.more).toBe('end');
    tabs.scrollLeft = 50;
    tabs.dispatchEvent(new Event('scroll'));
    expect(top.dataset.more).toBe('start end');
    tabs.scrollLeft = 97;
    tabs.dispatchEvent(new Event('scroll'));
    expect(top.dataset.more).toBe('start');
  });
});

describe('a run is named by what the card shows (F43)', () => {
  it('names it by its subject and who asked, never by its id', () => {
    expect(runName(SEVEN[2])).toBe('code on issue #3, asked by maintainer-one');
    expect(runName({ ...SEVEN[2], profile: 'claude' }, NOW)).toBe('code on issue #3, profile claude, asked by maintainer-one, 1 hour ago');
    expect(changeWords([SEVEN[0]], [{ ...SEVEN[0], status: 'claimed' }])).toEqual(['Run code on issue #1, asked by maintainer-one is now claimed']);
    expect(changeWords([], [SEVEN[0]])).toEqual(['New run: code on issue #1, asked by maintainer-one, requested']);
    for (const text of [...changeWords([SEVEN[0]], [{ ...SEVEN[0], status: 'working' }]), runName(SEVEN[0])]) expect(text).not.toContain(ID(1));
  });

  it('gives every button of a card a name that starts with its visible label, and shows no id', async () => {
    fakeServer({ runs: SEVEN });
    mount();
    await openTab('work');
    const buttons = qa('#forge-runs-list button').filter((b) => b.getAttribute('aria-label'));
    expect(buttons.length).toBeGreaterThan(10);
    for (const b of buttons) {
      const visible = b.textContent.trim().replace(/\s+/g, ' ');
      expect(b.getAttribute('aria-label').startsWith(visible), `${b.getAttribute('aria-label')} vs ${visible}`).toBe(true);
    }
    expect(q('#forge-runs-list').textContent).not.toContain('run-01JC8Z3Q5M7VXK2RT9N4B6HD');
    expect(qa('#forge-runs-list [aria-label]').map((e) => e.getAttribute('aria-label')).join(' ')).not.toContain('run-01JC8Z3Q5M7VXK2RT9N4B6HD');
  });

  it('makes a disabled Light on the map look disabled and say why', async () => {
    fakeServer({ runs: [SEVEN[3], SEVEN[2]] });
    mount();
    await openTab('work');
    const off = q(`[data-run="${ID(4)}"] [data-run-select]`);
    const on = q(`[data-run="${ID(3)}"] [data-run-select]`);
    expect(off.disabled).toBe(true);
    expect(off.title).toMatch(/No node on the map yet/);
    expect($(off.getAttribute('aria-describedby')).textContent).toBe('No node on the map yet.');
    expect(on.disabled).toBe(false);
    expect(on.hasAttribute('title')).toBe(false);
    expect(on.getAttribute('aria-label')).toMatch(/^Light on the map: /);
    expect(css).toMatch(/\.hx-forge \.hx-btn:disabled[^{]*\{[^}]*border-style: dashed[^}]*cursor: not-allowed/);
  });
});

describe('loading and empty lists (F44)', () => {
  it('holds a list\'s space with placeholder rows while it loads, and replaces them with the rows', async () => {
    fakeServer({ hang: ['/api/forge/issues'] });
    mount();
    openForge({ tab: 'issues' });
    await settle();
    expect($('forge-list').getAttribute('aria-busy')).toBe('true');
    expect(qa('#forge-list .hx-forge-skeleton').length).toBeGreaterThanOrEqual(3);
    expect(q('.hx-forge-skeleton').getAttribute('aria-hidden')).toBe('true');
    expect($('forge-status').textContent).toMatch(/Loading/);
    expect(loadingRowsHtml(2).match(/hx-forge-skeleton/g)).toHaveLength(2);
    expect(css).toMatch(/\.hx-forge-skeleton \{[^}]*min-height: 64px/);
  });

  it('holds the Runs tab\'s status, runner and totals lines while the runs load, so the list does not jump (F44)', async () => {
    fakeServer({ hang: ['/api/agent-runs'] });
    mount();
    openForge({ tab: 'work' });
    await settle();
    const runner = $('forge-runs-runner');
    const totals = $('forge-runs-totals');
    expect(runner.hidden).toBe(false);
    expect(runner.querySelectorAll('[data-corn="skeleton"]')).toHaveLength(1);
    expect(totals.hidden).toBe(false);
    expect(totals.querySelectorAll('[data-corn="skeleton"]')).toHaveLength(3);
    expect(runner.querySelector('[data-corn="skeleton"]').getAttribute('aria-hidden')).toBe('true');
    expect($('forge-runs-status').textContent).toMatch(/Loading the runs/);
    expect(qa('#forge-runs-list .hx-forge-skeleton')).toHaveLength(3);
    // rows under the runs wait: their place moves when the runs arrive
    expect(qa('#forge-list .hx-forge-skeleton')).toHaveLength(0);
    // the placeholder line is one meta line, like the line it stands for
    expect(loadingLinesHtml(2).match(/hx-forge-meta hx-forge-skeleton-line/g)).toHaveLength(2);
    expect(css).toMatch(/\.hx-forge-skeleton-line > span \{[^}]*height: 10px/);
  });

  it('holds no runner or totals lines beside a failed runs read, and the grouped work still comes with its answer (F44)', async () => {
    const server = fakeServer({ fail: { '/api/agent-runs': { status: 502, body: { ok: false, error: 'cornfield could not read its runs.' } } }, hang: ['/api/forge/work'] });
    mount();
    openForge({ tab: 'work' });
    await settle(); // the runs read fails; the work is still being read
    click(q('[data-action="refresh-forge"]')); // read again: drawn while the work and the runs are being read, after a failed runs read
    await settle();
    expect($('forge-runs-note').textContent).toMatch(/^Could not load the runs\./);
    expect(q('#forge-runs-note [data-action="retry-forge"]')).not.toBe(null);
    expect(qa('#forge-runs-runner [data-corn="skeleton"], #forge-runs-totals [data-corn="skeleton"]')).toHaveLength(0);
    expect($('forge-runs-totals').hidden).toBe(true);
    // the work answers: its rows are drawn under the failure line, which keeps its Retry
    server.release('/api/forge/work');
    await settle();
    expect(qa('#forge-list [data-corn="empty"]')).toHaveLength(1);
    expect(qa('#forge-list .hx-forge-skeleton')).toHaveLength(0);
    expect(q('#forge-runs-note [data-action="retry-forge"]')).not.toBe(null);
  });

  it('keeps a width for each tab\'s count before it is read, so the tabs do not move (F44)', async () => {
    fakeServer({ hang: ['/api/forge/issues', '/api/agent-runs'] });
    mount();
    openForge({ tab: 'issues' });
    await settle();
    for (const kind of ['specs', 'pulls', 'issues', 'threads', 'work']) {
      const count = q(`[data-forge-kind="${kind}"] .hx-forge-count`);
      expect(count, kind).toBeTruthy();
      expect(count.hidden, kind).toBe(false);
    }
    expect(css).toMatch(/\.hx-forge-tab \.hx-forge-count \{[^}]*display: inline-block; min-width: 2ch/);
  });

  it('says in each empty list what would appear and how to make one', async () => {
    fakeServer({ runs: [], issues: [], pulls: [], proposals: [] });
    mount();
    openForge();
    await settle();
    expect(q('#forge-list .hx-forge-empty').textContent).toBe(emptyWords('specs'));
    expect(emptyWords('specs')).toMatch(/Start one from an issue/);
    for (const tab of ['pulls', 'issues', 'threads', 'deploys']) {
      click(q(`[data-forge-kind="${tab}"]`));
      await settle();
      const text = q('#forge-list .hx-forge-empty').textContent;
      expect(text, tab).toBe(emptyWords(tab, 'GitHub'));
      expect(text.length, tab).toBeGreaterThan(40);
    }
    click(q('[data-forge-kind="work"]'));
    await settle();
    expect(q('#forge-runs-list .hx-forge-empty').textContent).toMatch(/No agent has been asked for yet\. Start one from an issue or a proposal/);
  });
});

describe('the focus after Stop (F12)', () => {
  it('goes to the run\'s row, not the page, once the Stop button is gone', async () => {
    fakeServer({ runs: [SEVEN[2]] });
    mount();
    await openTab('work');
    q('[data-forge-stop]').focus();
    click(q('[data-forge-stop]'));
    await settle();
    expect(q('[data-forge-stop]')).toBe(null);
    const card = q(`[data-run="${ID(3)}"]`);
    expect(document.activeElement).not.toBe(document.body);
    expect(card.contains(document.activeElement)).toBe(true);
  });
});

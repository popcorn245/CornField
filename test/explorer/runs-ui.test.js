// @vitest-environment happy-dom
/**
 * Agent runs in the issues and PRs panel (issue #80, explorer/runs-model.js and forge-panel.js), through the page's own markup with a
 * fake server behind `fetch`: an open issue and an issue or proposal group have "Start an agent"; the dialog (kind, a profile when the
 * config lists any, a brief, in words what it will do) keeps the focus in, posts once, says a refusal in the server's words and offers to ask
 * on purpose only where the rule allows it; the Agents tab lists the runs with their state and links and a Stop that asks once. Everything is
 * said through the live region, escaped, and the page passes axe in both themes with the dialog open.
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
import { aboutWords, statusWords, runMeta, canStop, canAnswer, answerBody, answerWords, answerWordsFor, timelineWords, canRetry, retryRefs, retryWords, limitsFromFields, runsStatus, runnerState, runnerWords, triggerNotice, totalsLines, defaultLimits, startBody, startWords, stopWords, confirmStartWords } from '../../explorer/runs-model.js';

// @ts-expect-error plain JS modules, no declarations
import { tokensUrl, revokeUrl } from '../../explorer/review-tokens-model.js';

const EXPLORER = path.resolve(__dirname, '../../explorer');
const page = fs.readFileSync(path.join(EXPLORER, 'index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const css = ['explorer.css', 'house.css'].map((f) => fs.readFileSync(path.join(EXPLORER, f), 'utf8')).join('\n');
const NOW = Date.parse('2026-11-05T12:00:00Z');
const MAP = { nodes: [{ id: 'root', type: 'root', x: 0, y: 0, r: 20, color: '#336699', label: 'root', degree: 0 }], edges: [] };
const user = (login) => ({ login, url: `https://git.example.test/${login}` });
const issue = (number, title) => ({ number, title, state: 'open', author: user('maintainer-one'), labels: [], comments: 0, url: `https://git.example.test/owner/name/issues/${number}`, createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-01T09:00:00Z', closedAt: null, body: '' });
const pr = (number, title, text, ref) => ({ number, title, body: text, state: 'open', draft: false, author: user('runner-bot'), labels: [], head: { ref, sha: 'a'.repeat(40) }, base: { ref: 'main' }, url: `https://git.example.test/owner/name/pull/${number}`, createdAt: '2026-11-04T09:00:00Z', updatedAt: '2026-11-04T09:00:00Z', mergedAt: null });
const RUN = {
  runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEF', kind: 'code', profile: 'claude', refs: { issue: 7 }, status: 'working', open: true, requestedBy: 'maintainer-one', requestedAt: '2026-11-05T11:00:00Z', via: 'dashboard',
  comment: { id: '9', url: 'https://git.example.test/owner/name/issues/7#issuecomment-9' }, limits: { minutes: 30 }, stopRequested: null, checks: 'running',
  report: { state: 'working', at: '2026-11-05T11:30:00Z', by: 'runner-bot', note: 'tests <img src=x onerror=alert(1)> failing', url: 'https://ci.example.org/1', tokens: 1200, cost: 0.4 },
  pull: { number: 50, state: 'open', url: 'https://git.example.test/owner/name/pull/50', by: 'runner-bot', trusted: true, via: 'body' },
};
const WAITING = {
  ...RUN, runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEW', status: 'waiting', profile: null, refs: { issue: 9 }, pull: null, checks: null, answer: null,
  report: { state: 'waiting', at: '2026-11-05T11:40:00Z', by: 'runner-bot', note: 'Plan ready <b>approve</b> to build', url: 'https://plans.example.org/42', tokens: null, cost: null },
};
const QUIET = { ...RUN, runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEG', status: 'quiet', open: false, profile: null, report: null, pull: null, refs: { proposal: '0040-meals' } };
const $ = (id) => document.getElementById(id);
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (el, k, opts = {}) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }); el.dispatchEvent(e); return e; };
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const said = async () => { await new Promise((r) => setTimeout(r, 50)); return $('map-announcer').textContent; };

function fakeServer(opts = {}) {
  const calls = [];
  const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });
  let runs = opts.runs ?? [RUN, QUIET];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url, 'http://localhost');
    const at = '2026-11-05T11:58:00.000Z';
    if (init.method === 'POST' && u.pathname === '/api/agent-runs') return opts.start ? json(opts.start.status, opts.start.body) : json(201, { ok: true, request: { runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEH' }, run: RUN });
    if (init.method === 'POST' && /\/answer$/.test(u.pathname)) {
      const sent = JSON.parse(init.body);
      if (opts.answer) return json(opts.answer.status, opts.answer.body);
      runs = runs.map((r) => (u.pathname.includes(r.runId) ? { ...r, answer: { ...sent, at, by: 'maintainer-one' } } : r));
      return json(200, { ok: true });
    }
    if (/\/brief$/.test(u.pathname)) return opts.brief ? json(opts.brief.status, opts.brief.body) : json(200, { ok: true, runId: u.pathname.split('/')[3], brief: `${'x'.repeat(2000)} and the rest of it` });
    if (init.method === 'POST' && /\/stop$/.test(u.pathname)) { runs = runs.map((r) => (r.runId === RUN.runId ? { ...r, status: 'stop-requested', stopRequested: { at, by: 'maintainer-one' } } : r)); return opts.stop ? json(opts.stop.status, opts.stop.body) : json(200, { ok: true }); }
    if (u.pathname === '/api/agent-runs') return opts.runsDown ? json(502, { ok: false, error: 'cornfield could not read its runs.', code: 'unavailable' }) : json(200, { ok: true, runs, open: runs.filter((r) => r.open).length, maxOpen: 3, profiles: opts.profiles ?? ['claude', 'local-qwen'], limits: opts.limits ?? {}, ...(opts.presence ? { runnerPresence: opts.presence } : {}), ...(opts.totals ? { totals: opts.totals } : {}), ...(opts.triggerSkipped ? { triggerSkipped: opts.triggerSkipped } : {}), ...(opts.handWritten ? { handWritten: opts.handWritten } : {}) });
    if (u.pathname === '/api/forge/issues') return json(200, { ok: true, at, rate: '', items: [issue(7, 'Meals <b>page</b>'), issue(5, 'Sign-in')] });
    if (u.pathname === '/api/forge/pulls') return json(200, { ok: true, at, rate: '', items: [] });
    if (u.pathname === '/api/forge/work') return json(200, { ok: true, at, rate: '', pulls: [pr(50, 'Meals page', 'Closes #7', 'agent/meals'), pr(40, 'Meals spec', '', 'spec/0040-meals')], issues: [issue(7, 'Meals page')], branches: [], specs: [{ pull: 40, slug: '0040-meals' }], agents: {} });
    return json(404, { ok: false, error: 'No such thing.', code: 'not-found' });
  }));
  return { calls, posts: () => calls.filter((c) => c.init.method === 'POST'), urls: () => calls.map((c) => c.url) };
}

function mount(clock = () => NOW, extra = {}) {
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
  return initForgePanel({ forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' }, signIn: { login: 'maintainer-one' }, ...extra }, { clock });
}
const openIssues = async () => { openForge(); await settle(); click(q('[data-forge-kind="issues"]')); await settle(); };
const openAgents = async () => { openForge(); await settle(); click(q('[data-forge-kind="work"]')); await settle(); };
const audit = async () => {
  const r = await axe.run({ include: [document.documentElement] }, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }, rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
};

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { closeForge({ restoreFocus: false }); closeDrawer(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('the words (runs-model.js)', () => {
  it('say what a run is about, its state, and the limits beside what the runner reported', () => {
    document.body.innerHTML = body;
    expect(aboutWords({ issue: 12 })).toBe('issue #12');
    expect(aboutWords({ proposal: '0040-meals' })).toBe('proposal 0040-meals');
    expect(statusWords({ status: 'stop-requested' })).toBe('Stop requested');
    expect(runMeta(RUN, NOW)).toBe('asked 1 hour ago by maintainer-one · profile claude · limits 30 min · reported 1200 tokens, cost 0.4 · checks running');
    expect(canStop(RUN)).toBe(true);
    expect(canStop({ ...RUN, stopRequested: { by: 'x' } })).toBe(false);
    expect(canStop(QUIET)).toBe(false);
    expect(runsStatus({ runs: [RUN], open: 1, maxOpen: 3 })).toBe('1 open of 3 allowed, 1 run');
    expect(startBody({ kind: 'code', profile: '', brief: '  hi  ', refs: { issue: 1 }, force: false })).toEqual({ kind: 'code', refs: { issue: 1 }, brief: 'hi' });
    expect(startBody({ kind: 'code', profile: 'claude', brief: '', refs: { issue: 1 }, force: true })).toEqual({ kind: 'code', refs: { issue: 1 }, brief: '', profile: 'claude', force: true });
    expect(startWords(null)).toMatch(/did not answer/);
    expect([tokensUrl('review'), tokensUrl('agent'), revokeUrl(3, 'agent'), revokeUrl(3)]).toEqual(['/api/review-tokens', '/api/agent-tokens', '/api/agent-tokens/3/revoke', '/api/review-tokens/3/revoke']);
    expect(startWords(401)).toMatch(/Sign in again/);
    expect(stopWords(200, { ok: true }, 'run-1')).toMatch(/decides/);
    expect(confirmStartWords({ proposal: 'x' }, 'GitHub')).toMatch(/spec pull request of proposal x on GitHub, as you/);
  });
});

describe('Start an agent', () => {
  it('is on an open issue, named for it, and opens a dialog with the focus in it', async () => {
    fakeServer();
    expect(mount()).toBe(true);
    await openIssues();
    const buttons = qa('[data-forge-agent]');
    expect(buttons.map((b) => b.dataset.forgeAgent)).toEqual(['issue:7', 'issue:5']);
    expect(buttons[0].getAttribute('aria-label')).toBe('Start an agent on issue 7');
    click(buttons[0]);
    await settle();
    expect($('agent-start').hidden).toBe(false);
    expect(document.activeElement).toBe($('agent-kind'));
    expect(q('#agent-start [role="dialog"]').getAttribute('aria-modal')).toBe('true');
    expect($('agent-start-about').textContent).toBe('About issue #7');
    expect($('agent-start-words').textContent).toMatch(/posts a request as a comment on issue #7 on GitHub, as you.*starts nothing and sends no credentials/);
    expect(qa('#agent-kind option').map((o) => o.value)).toEqual(['code', 'summary', 'brief', 'proposal']);
    expect(qa('#agent-profile option').map((o) => o.value)).toEqual(['', 'claude', 'local-qwen']);
    expect($('agent-profile-field').hidden).toBe(false);
    expect($('agent-force-field').hidden).toBe(true);
    expect(await said()).toMatch(/Start an agent on issue #7/);
  });

  it('has no profile choice when the config lists none', async () => {
    fakeServer({ profiles: [] });
    mount();
    await openIssues();
    click(q('[data-forge-agent="issue:7"]'));
    await settle();
    expect($('agent-profile-field').hidden).toBe(true);
  });

  it('fills the limit fields with what the config gives the chosen profile, all editable, and sends what they hold (CF-27, CF-25)', async () => {
    expect(defaultLimits({}, 'claude')).toEqual({});
    expect(defaultLimits(undefined, '')).toEqual({});
    expect(defaultLimits({ claude: { cost: 5 } }, '')).toEqual({});
    expect(defaultLimits({ minutes: 1, turns: 40, cost: 0.5, tokens: 1000 }, 'cost')).toEqual({ minutes: 1, turns: 40, cost: 0.5, tokens: 1000 });
    expect(defaultLimits({ minutes: 30, claude: { cost: 5, minutes: 60 } }, 'claude')).toEqual({ minutes: 60, cost: 5 });
    const fields = () => ['minutes', 'turns', 'cost', 'tokens'].map((k) => $(`agent-limit-${k}`).value);
    const server = fakeServer({ limits: { minutes: 30, claude: { cost: 5, minutes: 60 } } });
    mount();
    await openIssues();
    click(q('[data-forge-agent="issue:7"]'));
    await settle();
    expect($('agent-limits-edit').hidden).toBe(false);
    expect(fields()).toEqual(['30', '', '', '']);
    $('agent-profile').value = 'claude';
    $('agent-profile').dispatchEvent(new Event('change', { bubbles: true }));
    expect(fields()).toEqual(['60', '', '5', '']);
    // typed in: another profile leaves them as they are
    $('agent-limit-turns').value = '12';
    $('agent-profile').value = '';
    $('agent-profile').dispatchEvent(new Event('change', { bubbles: true }));
    expect(fields()).toEqual(['60', '12', '5', '']);
    $('agent-limit-cost').value = '';
    q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    // a blank field is left out: the server fills it from the config
    expect(JSON.parse(server.posts()[0].init.body).limits).toEqual({ minutes: 60, turns: 12 });
  });

  it('leaves the limit fields blank and sends no limits when the config sets none', async () => {
    const server = fakeServer();
    mount();
    await openIssues();
    click(q('[data-forge-agent="issue:7"]'));
    await settle();
    expect($('agent-limits-edit').hidden).toBe(false);
    expect(['minutes', 'turns', 'cost', 'tokens'].map((k) => $(`agent-limit-${k}`).value)).toEqual(['', '', '', '']);
    q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(JSON.parse(server.posts()[0].init.body)).not.toHaveProperty('limits');
  });

  it('is also on an issue group and a proposal group of the Agents tab', async () => {
    fakeServer();
    mount();
    await openAgents();
    expect(qa('#forge-list [data-forge-agent]').map((b) => b.dataset.forgeAgent).sort()).toEqual(['issue:7', 'proposal:0040-meals']);
    click(q('[data-forge-agent="proposal:0040-meals"]'));
    await settle();
    expect($('agent-start-about').textContent).toBe('About proposal 0040-meals');
  });

  it('posts once what was chosen, and nothing the person did not choose; the focus goes back to the button', async () => {
    const server = fakeServer();
    mount();
    await openIssues();
    click(q('[data-forge-agent="issue:7"]'));
    await settle();
    $('agent-kind').value = 'summary';
    $('agent-profile').value = 'local-qwen';
    $('agent-brief').value = '  Summarise the thread.  ';
    q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(server.posts()).toHaveLength(1);
    expect(server.posts()[0].url).toBe('/api/agent-runs');
    expect(JSON.parse(server.posts()[0].init.body)).toEqual({ kind: 'summary', refs: { issue: 7 }, brief: 'Summarise the thread.', profile: 'local-qwen' });
    expect($('agent-start').hidden).toBe(true);
    expect(document.activeElement).toBe(q('[data-forge-agent="issue:7"]'));
    expect(await said()).toMatch(/Asked\. The request is posted on the forge as run run-01JC8Z3Q5M7VXK2RT9N4B6HDEH/);
  });

  it('says a refusal in the server\'s words and keeps the dialog; a run already open offers to ask on purpose, the cap does not', async () => {
    fakeServer({ start: { status: 409, body: { ok: false, code: 'run-open', error: 'issue #7 already has an open run: run-01JC (working).' } } });
    mount();
    await openIssues();
    click(q('[data-forge-agent="issue:7"]'));
    await settle();
    q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect($('agent-start').hidden).toBe(false);
    expect($('agent-start-msg').hidden).toBe(false);
    expect($('agent-start-msg').textContent).toBe('issue #7 already has an open run: run-01JC (working).');
    expect($('agent-start-msg').getAttribute('role')).toBe('alert');
    expect($('agent-force-field').hidden).toBe(false);
    expect($('agent-start-go').disabled).toBe(false);
    $('agent-force').checked = true;
    const server = fakeServer({ start: { status: 409, body: { ok: false, code: 'cap-reached', error: 'owner/name already has 3 open runs.' } } });
    q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(JSON.parse(server.posts()[0].init.body).force).toBe(true);
    expect($('agent-start-msg').textContent).toBe('owner/name already has 3 open runs.');
  });

  it('keeps the focus in the dialog, closes on Escape and Cancel, and gives the focus back', async () => {
    fakeServer();
    mount();
    await openIssues();
    const opener = q('[data-forge-agent="issue:7"]');
    opener.focus();
    click(opener);
    await settle();
    const fields = ['agent-kind', 'agent-profile', 'agent-brief'].map($);
    const last = $('agent-start-go');
    last.focus();
    const tab = key(last, 'Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(fields[0]);
    key(fields[0], 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
    q('#forge-panel').focus();
    document.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    key($('agent-brief'), 'Escape');
    expect($('agent-start').hidden).toBe(true);
    expect(document.activeElement).toBe(opener);
    click(opener);
    await settle();
    click(q('[data-action="agent-start-cancel"]'));
    expect($('agent-start').hidden).toBe(true);
    expect(qa('[data-forge-agent]').length).toBeGreaterThan(0);
  });
});

describe('the runs on the Agents tab', () => {
  it('lists each run with its state, what it is about, the runner\'s words escaped, links, and Stop only where it can be asked', async () => {
    fakeServer();
    mount();
    await openAgents();
    expect(q('#forge-runs').hidden).toBe(false);
    expect($('forge-runs-status').textContent).toBe('1 open of 3 allowed, 2 runs');
    const rows = qa('#forge-runs-list > li');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Working');
    expect(rows[0].textContent).toContain('code on issue #7');
    expect(rows[0].textContent).toContain('Runner: tests <img src=x onerror=alert(1)> failing');
    expect(rows[0].querySelector('img')).toBe(null);
    expect([...rows[0].querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://git.example.test/owner/name/issues/7#issuecomment-9', 'https://github.com/owner/name/issues/7', 'https://git.example.test/owner/name/pull/50', 'https://ci.example.org/1']);
    expect(rows[0].querySelector('[data-forge-stop]').getAttribute('aria-label')).toBe(`Stop run ${RUN.runId}`);
    expect(rows[1].textContent).toContain('Quiet');
    expect(rows[1].textContent).toMatch(/no longer counts toward the limit/);
    expect(rows[1].querySelector('[data-forge-stop]')).toBe(null);
    // the section is only on the Agents tab
    click(q('[data-forge-kind="issues"]'));
    await settle();
    expect(q('#forge-runs').hidden).toBe(true);
  });

  it('shows the notice for a skipped trigger, from the server\'s count of the last day, and none when nothing was skipped', async () => {
    expect(triggerNotice({})).toBe('');
    expect(triggerNotice({ triggerSkipped: null })).toBe('');
    expect(triggerNotice({ triggerSkipped: { count: 2, reasons: { 'no-session': 2 } } })).toBe('A trigger was skipped: sign in to let triggers request runs.');
    expect(triggerNotice({ triggerSkipped: { count: 3, reasons: { 'no-session': 1, 'cap-reached': 2 } } })).toBe('A trigger was skipped: sign in to let triggers request runs. 2 triggers were refused in the last day (cap-reached 2), so nothing was asked.');
    fakeServer({ triggerSkipped: { count: 1, last: '2026-11-05T11:00:00Z', reasons: { 'no-session': 1 } } });
    mount();
    await openAgents();
    expect($('forge-runs-trigger').hidden).toBe(false);
    expect($('forge-runs-trigger').textContent).toBe('A trigger was skipped: sign in to let triggers request runs.');
    expect(await audit()).toEqual([]);
    closeForge({ restoreFocus: false });
    fakeServer();
    mount();
    await openAgents();
    expect($('forge-runs-trigger').hidden).toBe(true);
  });

  it('asks a run to stop once, says so, and shows stop requested', async () => {
    const server = fakeServer();
    mount();
    await openAgents();
    click(q('[data-forge-stop]'));
    await settle();
    expect(server.posts().map((p) => p.url)).toEqual([`/api/agent-runs/${RUN.runId}/stop`]);
    expect($('forge-runs-note').hidden).toBe(false);
    expect($('forge-runs-note').textContent).toMatch(/Asked run-01JC8Z3Q5M7VXK2RT9N4B6HDEF to stop\. The runner decides/);
    expect(qa('#forge-runs-list > li')[0].textContent).toContain('Stop requested');
    expect(q('[data-forge-stop]')).toBe(null);
    expect(await said()).toMatch(/to stop/);
  });

  it('says in words when the runs cannot be read, and Refresh asks the server to look at the forge first', async () => {
    const server = fakeServer({ runsDown: true });
    mount();
    await openAgents();
    expect($('forge-runs-note').hidden).toBe(false);
    click(q('[data-action="refresh-forge"]'));
    await settle();
    expect(server.urls()).toContain('/api/agent-runs?follow=1');
  });

  it('says there are none yet', async () => {
    fakeServer({ runs: [] });
    mount();
    await openAgents();
    expect($('forge-runs-list').textContent).toMatch(/No agent has been asked for yet/);
  });
});

describe('a run that waits for an answer (issue #101)', () => {
  const waiting = (extra = {}) => ({ runs: [{ ...WAITING, ...extra }], profiles: [] });

  it('says it is waiting, with the runner\'s note escaped and its link, and offers Continue, Stop and a reply field, not the plain Stop', async () => {
    fakeServer(waiting());
    mount();
    await openAgents();
    const row = q('#forge-runs-list > li');
    expect(row.textContent).toContain('Waiting');
    expect(row.textContent).toContain('Runner: Plan ready <b>approve</b> to build');
    expect(row.querySelector('b')).toBe(null);
    expect(row.textContent).toMatch(/goes on once a maintainer answers/);
    expect([...row.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toContain('https://plans.example.org/42');
    expect(row.textContent).toContain('Runner\'s link');
    expect(qa('[data-run-answer]').map((b) => [b.dataset.runAnswer, b.textContent])).toEqual([['continue', 'Continue'], ['stop', 'Stop'], ['reply', 'Reply']]);
    expect(q('[data-forge-stop]')).toBe(null);
    expect(q('[data-run-reply]').closest('label').textContent).toContain('Reply to run');
    // an ordinary working run keeps its Stop and has no answers
    expect(canAnswer({ ...RUN })).toBe(false);
  });

  it('sends Continue, Stop and a reply as one answer each, says what it came to, and shows the answer', async () => {
    const server = fakeServer(waiting());
    mount();
    await openAgents();
    click(q('[data-run-answer="continue"]'));
    await settle();
    expect(server.posts().map((p) => [p.url, JSON.parse(p.init.body)])).toEqual([[`/api/agent-runs/${WAITING.runId}/answer`, { action: 'continue' }]]);
    expect($('forge-runs-note').textContent).toMatch(/Answered run-01JC8Z3Q5M7VXK2RT9N4B6HDEW: continue\. The runner picks it up/);
    expect(q('#forge-runs-list > li').textContent).toMatch(/maintainer-one answered: continue\. The runner picks the answer up/);
    expect(await said()).toMatch(/Answered/);
    // the reply: empty is not sent; typed text is, once, and the field is empty again
    click(q('[data-run-answer="reply"]'));
    await settle();
    expect(server.posts()).toHaveLength(1);
    expect($('forge-runs-note').textContent).toBe('Write a reply first.');
    const field = q('[data-run-reply]');
    field.value = '  Use the second <i>plan</i>.  ';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    click(q('[data-run-answer="reply"]'));
    await settle();
    expect(JSON.parse(server.posts()[1].init.body)).toEqual({ action: 'reply', text: 'Use the second <i>plan</i>.' });
    expect(q('[data-run-reply]').value).toBe('');
    expect(q('#forge-runs-list > li').textContent).toContain('answered: reply: Use the second <i>plan</i>.');
    expect(q('#forge-runs-list i')).toBe(null);
    click(q('[data-run-answer="stop"]'));
    await settle();
    expect(JSON.parse(server.posts()[2].init.body)).toEqual({ action: 'stop' });
  });

  it('keeps a half-typed reply when the runs are drawn again, and sends it on Enter', async () => {
    const server = fakeServer(waiting());
    mount();
    await openAgents();
    const field = q('[data-run-reply]');
    field.focus();
    field.value = 'half a thou';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    click(q('[data-action="refresh-forge"]'));
    await settle();
    expect(q('[data-run-reply]').value).toBe('half a thou');
    key(q('[data-run-reply]'), 'Enter');
    await settle();
    expect(JSON.parse(server.posts().at(-1).init.body)).toEqual({ action: 'reply', text: 'half a thou' });
  });

  it('puts the focus back after an answer is sent: on the button, on the emptied reply field, on the Timeline once the run asks no more', async () => {
    fakeServer(waiting());
    mount();
    await openAgents();
    q('[data-run-answer="continue"]').focus();
    click(q('[data-run-answer="continue"]'));
    await settle();
    expect(document.activeElement).toBe(q(`[data-run-answer="continue"][data-run-id="${WAITING.runId}"]`));
    const field = q('[data-run-reply]');
    field.focus();
    field.value = 'Plan B';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    key(field, 'Enter');
    await settle();
    expect(document.activeElement).toBe(q('[data-run-reply]'));
    expect(q('[data-run-reply]').value).toBe('');
    // a Stop that ends the asking: the controls go, the focus does not fall to the page
    fakeServer({ runs: [{ ...WAITING, status: 'stop-requested', stopRequested: { at: 'x', by: 'maintainer-one' } }], profiles: [] });
    q('[data-run-answer="stop"]').focus();
    click(q('[data-run-answer="stop"]'));
    await settle();
    expect(q('[data-run-answer]')).toBe(null);
    expect(document.activeElement).toBe(q(`[data-run-timeline="${WAITING.runId}"]`));
  });

  it('says a refusal in the server\'s words', async () => {
    fakeServer({ ...waiting(), answer: { status: 409, body: { ok: false, code: 'conflict', error: 'Run is not waiting for an answer.' } } });
    mount();
    await openAgents();
    click(q('[data-run-answer="continue"]'));
    await settle();
    expect($('forge-runs-note').textContent).toBe('Run is not waiting for an answer.');
  });

  it('words the state, the answers and the timeline', () => {
    document.body.innerHTML = body;
    expect(statusWords(WAITING)).toBe('Waiting');
    expect(canAnswer(WAITING)).toBe(true);
    expect(canAnswer({ ...WAITING, stopRequested: { at: 'x', by: 'y' }, status: 'stop-requested' })).toBe(false);
    expect(answerBody('continue', 'ignored')).toEqual({ action: 'continue' });
    expect(answerBody('reply', ' hi ')).toEqual({ action: 'reply', text: 'hi' });
    expect(answerWords({ action: 'reply', text: 'plan B' })).toBe('reply: plan B');
    expect(answerWords({ action: 'stop' })).toBe('stop');
    expect(answerWordsFor(null, null, 'r', 'stop')).toMatch(/did not answer/);
    expect(answerWordsFor(401, null, 'r', 'stop')).toMatch(/sign-in has ended/);
    expect(answerWordsFor(200, { ok: true }, 'r', 'stop')).toMatch(/to stop/);
    expect(timelineWords({ kind: 'answered', ref: 'reply', actor: 'maintainer-one', note: 'plan B' })).toEqual({ what: 'Answered reply by maintainer-one', note: 'plan B' });
  });
});

describe.each(['dark', 'light'])('accessibility, %s theme, a waiting run', (theme) => {
  it('passes axe with a waiting run, with its answer showing, and its timeline open', async () => {
    document.documentElement.dataset.theme = theme;
    fakeServer({ runs: [{ ...WAITING, answer: { action: 'reply', text: 'plan B', at: '2026-11-05T11:45:00Z', by: 'maintainer-one' }, timeline: [{ at: '2026-11-05T11:40:00Z', kind: 'report', actor: 'runner-bot', ref: 'waiting', note: 'Plan ready', url: null }] }, WAITING.runId && { ...WAITING, runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEZ', refs: { issue: 11 } }], profiles: [] });
    mount();
    document.documentElement.dataset.theme = theme;
    await openAgents();
    expect(qa('[data-run-answer="continue"]')).toHaveLength(2);
    expect(await audit()).toEqual([]);
    click(q('[data-run-timeline]'));
    await settle();
    expect(await audit()).toEqual([]);
    delete document.documentElement.dataset.theme;
  });
});

const TOTALS = {
  all: { runs: 3, tokens: 2107, cost: 1.3 },
  byProposal: [{ proposal: '0040-meals <b>', runs: 2, tokens: 2000, cost: 0.3 }],
  byDay: [{ day: '2026-11-05', runs: 1, tokens: 7, cost: 1 }, { day: '2026-11-04', runs: 2, tokens: 2100, cost: 0.3 }],
};

describe('the totals of tokens and cost (CF-27)', () => {
  it('say what runners reported as sent, in plain lines: all, per proposal, per day', () => {
    document.body.innerHTML = body;
    expect(totalsLines(null)).toEqual([]);
    expect(totalsLines({ all: null, byProposal: [], byDay: [] })).toEqual([]);
    expect(totalsLines({ all: { runs: 1, tokens: 50, cost: null }, byProposal: [], byDay: [{ day: '2026-11-05', runs: 1, tokens: 50, cost: null }] })).toEqual(['Reported in all: 50 tokens over 1 run.', 'Per day (UTC): 2026-11-05 50 tokens (1 run).']);
    expect(totalsLines({ all: { runs: 2, tokens: null, cost: 0.123456789 } })).toEqual(['Reported in all: cost 0.12 over 2 runs.']);
    expect(totalsLines(TOTALS)).toEqual([
      'Reported in all: 2107 tokens, cost 1.30 over 3 runs.',
      'Per proposal: 0040-meals <b> 2000 tokens, cost 0.30 (2 runs).',
      'Per day (UTC): 2026-11-05 7 tokens, cost 1.00 (1 run); 2026-11-04 2100 tokens, cost 0.30 (2 runs).',
    ]);
  });

  it('show in the Runs view, escaped, and stay hidden when nothing was reported', async () => {
    fakeServer({ totals: TOTALS });
    mount();
    await openAgents();
    expect($('forge-runs-totals').hidden).toBe(false);
    expect([...$('forge-runs-totals').querySelectorAll('p')].map((p) => p.textContent)).toEqual(totalsLines(TOTALS));
    expect($('forge-runs-totals').querySelector('b')).toBe(null);
    closeForge({ restoreFocus: false });
    fakeServer();
    mount();
    await openAgents();
    expect($('forge-runs-totals').hidden).toBe(true);
  });
});

describe.each(['dark', 'light'])('accessibility, %s theme, totals', (theme) => {
  it('passes axe with the totals showing', async () => {
    document.documentElement.dataset.theme = theme;
    fakeServer({ totals: TOTALS });
    mount();
    document.documentElement.dataset.theme = theme;
    await openAgents();
    expect($('forge-runs-totals').hidden).toBe(false);
    expect(await audit()).toEqual([]);
    delete document.documentElement.dataset.theme;
  });
});

describe.each(['dark', 'light'])('accessibility, %s theme', (theme) => {
  it('passes axe with the runs listed and with the dialog open, a refusal showing', async () => {
    document.documentElement.dataset.theme = theme;
    fakeServer({ limits: { minutes: 30, claude: { cost: 5 } }, presence: { transport: 'pull', online: false, lastSeen: null, quietAfterMs: 180_000, runners: [] }, start: { status: 409, body: { ok: false, code: 'run-open', error: 'issue #7 already has an open run.' } } });
    mount();
    document.documentElement.dataset.theme = theme;
    await openAgents();
    expect($('forge-runs-runner').hidden).toBe(false);
    expect(await audit()).toEqual([]);
    click(q('[data-forge-agent="issue:7"]'));
    await settle();
    expect($('agent-limit-minutes').value).toBe('30');
    q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(await audit()).toEqual([]);
    delete document.documentElement.dataset.theme;
  });

  it('passes axe with a run written by hand and the requests by hand that started nothing (issue #98)', async () => {
    document.documentElement.dataset.theme = theme;
    const refused = [
      { at: '2026-11-05T11:00:00Z', by: 'stranger', number: 7, runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEJ', url: 'https://github.com/owner/name/issues/7#c1', why: 'author', reason: 'stranger is not a maintainer now, and only a maintainer\'s request starts a run' },
      { at: '2026-11-05T10:00:00Z', by: 'maintainer-one', number: 5, runId: null, url: null, why: 'malformed', reason: 'The block is not JSON <b>(it holds exactly one object)</b>.' },
    ];
    fakeServer({ runs: [{ ...RUN, via: 'hand', byHand: true }], handWritten: { mode: 'all', refused } });
    mount();
    document.documentElement.dataset.theme = theme;
    await openAgents();
    const hand = $('forge-runs-hand');
    expect(hand.hidden).toBe(false);
    expect(hand.getAttribute('aria-label')).toMatch(/written by hand/);
    expect(qa('#forge-runs-hand > li')).toHaveLength(2);
    // escaped, as every forge text is
    expect(hand.querySelector('b')).toBeNull();
    expect($('forge-runs-list').textContent).toContain('(by hand)');
    expect(await audit()).toEqual([]);
    delete document.documentElement.dataset.theme;
  });
});

describe('whether a runner is online (issue #99)', () => {
  const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();
  const presence = (secondsAgo, extra = {}) => ({ transport: 'pull', online: secondsAgo !== null && secondsAgo < 180, lastSeen: secondsAgo === null ? null : at(secondsAgo), quietAfterMs: 180_000, runners: [], ...extra });

  it('says the state in words, only on the pull transport', () => {
    document.body.innerHTML = body;
    expect(runnerWords(presence(20), NOW)).toBe('Runner online \u00b7 last seen 20 s ago');
    expect(runnerWords(presence(300), NOW)).toBe('No runner has polled for 5 min: a queued run will wait');
    expect(runnerWords(presence(null), NOW)).toBe('No runner has polled yet: a queued run will wait');
    expect(runnerState(presence(20), NOW)).toBe('online');
    expect(runnerState(presence(300), NOW)).toBe('offline');
    expect(runnerWords({ ...presence(20), transport: 'forge' }, NOW)).toBe('');
    expect(runnerWords(undefined, NOW)).toBe('');
  });

  it('shows one line in the Agents tab when a runner is online', async () => {
    fakeServer({ presence: presence(20) });
    mount();
    await openAgents();
    expect($('forge-runs-runner').hidden).toBe(false);
    expect($('forge-runs-runner').textContent).toBe('Runner online \u00b7 last seen 20 s ago');
  });

  it('shows the warning on the Start dialog when none has polled lately', async () => {
    fakeServer({ presence: presence(360) });
    mount();
    await openIssues();
    click(q('[data-forge-agent="issue:7"]'));
    await settle();
    expect($('agent-start').hidden).toBe(false);
    expect($('agent-start-runner').hidden).toBe(false);
    expect($('agent-start-runner').textContent).toBe('No runner has polled for 6 min: a queued run will wait');
  });

  it.each(['forge', 'push'])('shows nothing on the %s transport, in the Agents tab or the Start dialog', async (transport) => {
    fakeServer({ presence: presence(20, { transport }) });
    mount();
    await openAgents();
    expect($('forge-runs-runner').hidden).toBe(true);
    await openIssues();
    click(q('[data-forge-agent="issue:7"]'));
    await settle();
    expect($('agent-start-runner').hidden).toBe(true);
  });

  it('says once, as the runs are looked at again, when the runner goes quiet though the listing has not changed, and once when it is back', async () => {
    let clock = NOW;
    const p = presence(20);
    fakeServer({ presence: p });
    vi.useFakeTimers();
    try {
      // with runs on, the page reads them at once and again every minute while one is open, whether or not the panel is
      mount(() => clock, { agents: { runs: true } });
      await vi.advanceTimersByTimeAsync(100);
      const poll = async () => { $('map-announcer').textContent = ''; await vi.advanceTimersByTimeAsync(60_000); await vi.advanceTimersByTimeAsync(100); return $('map-announcer').textContent; };
      clock += 5 * 60_000;
      expect(await poll()).toMatch(/No runner has polled for 5 min: a queued run will wait/);
      clock += 60_000;
      expect(await poll()).not.toMatch(/runner/i);
      p.lastSeen = new Date(clock - 5_000).toISOString();
      expect(await poll()).toMatch(/Runner online · last seen 5 s ago/);
      expect(await poll()).not.toMatch(/runner/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

const FAILED = { ...RUN, runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDF1', status: 'failed', open: false, kind: 'summary', profile: 'local-qwen', refs: { issue: 7 }, brief: 'Summarise <b>this</b>.', limits: { minutes: 30, cost: 2.5 }, pull: null, checks: null, report: { state: 'failed', at: '2026-11-05T11:30:00Z', by: 'runner-bot', note: 'unknown profile', url: null, tokens: null, cost: null }, retryOf: null, retriedBy: [] };
const STOPPED = { ...FAILED, runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDF2', status: 'stopped', kind: 'code', profile: null, refs: { proposal: '0040-meals' }, brief: 'x'.repeat(2000), briefCut: true, limits: null };
const DONE = { ...FAILED, runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDF3', status: 'done', refs: { issue: 5 } };

describe('Start again', () => {
  it('words it: only failed and stopped runs can, with their own refs, and limits as numbers', () => {
    document.body.innerHTML = body;
    expect([FAILED, STOPPED, DONE, RUN, QUIET, WAITING].map(canRetry)).toEqual([true, true, false, false, false, false]);
    expect(retryRefs({ refs: { issue: 7, thread: 8, pull: 3 } })).toEqual({ issue: 7, thread: 8 });
    expect(retryWords(FAILED)).toBe(`Starts again on ${FAILED.runId}.`);
    expect(limitsFromFields({ minutes: '30', turns: '', cost: ' 2.5 ', tokens: '' })).toEqual({ minutes: 30, cost: 2.5 });
    expect(limitsFromFields({ minutes: '0' })).toBeNull();
    expect(limitsFromFields({ turns: 'x' })).toBeNull();
    expect(startBody({ kind: 'code', refs: { issue: 1 }, brief: '', limits: {}, retryOf: 'run-1' })).toEqual({ kind: 'code', refs: { issue: 1 }, brief: '', retryOf: 'run-1' });
    expect(timelineWords({ kind: 'retry-of', ref: 'run-A' }).what).toBe('Starts again on run-A');
    expect(timelineWords({ kind: 'retried-by', ref: 'run-B' }).what).toBe('Started again as run-B');
  });

  it('is a button on failed and stopped runs only', async () => {
    fakeServer({ runs: [FAILED, STOPPED, DONE, RUN, QUIET, WAITING] });
    mount();
    await openAgents();
    expect(qa('[data-forge-retry]').map((b) => b.dataset.forgeRetry).sort()).toEqual([FAILED.runId, STOPPED.runId]);
    expect(q(`[data-forge-retry="${FAILED.runId}"]`).textContent).toBe('Start again');
  });

  it('opens the Start dialog prefilled with the kind, profile, brief and limits, all editable, and posts retryOf', async () => {
    const server = fakeServer({ runs: [FAILED, STOPPED] });
    mount();
    await openAgents();
    click(q(`[data-forge-retry="${FAILED.runId}"]`));
    await settle();
    expect($('agent-start').hidden).toBe(false);
    expect($('agent-start-title').textContent).toBe('Start again');
    expect($('agent-start-about').textContent).toBe('About issue #7');
    expect($('agent-retry-note').hidden).toBe(false);
    expect($('agent-retry-note').textContent).toBe(`Starts again on ${FAILED.runId}.`);
    expect($('agent-kind').value).toBe('summary');
    expect($('agent-profile').value).toBe('local-qwen');
    expect($('agent-brief').value).toBe('Summarise <b>this</b>.');
    expect($('agent-limits-edit').hidden).toBe(false);
    expect([$('agent-limit-minutes').value, $('agent-limit-turns').value, $('agent-limit-cost').value, $('agent-limit-tokens').value]).toEqual(['30', '', '2.5', '']);
    // editable
    $('agent-brief').value = 'Summarise it differently.';
    $('agent-limit-minutes').value = '45';
    q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    const post = server.posts().find((c) => new URL(c.url, 'http://x').pathname === '/api/agent-runs');
    expect(JSON.parse(post.init.body)).toEqual({ kind: 'summary', profile: 'local-qwen', refs: { issue: 7 }, brief: 'Summarise it differently.', limits: { minutes: 45, cost: 2.5 }, retryOf: FAILED.runId });
    expect($('agent-start').hidden).toBe(true);
    expect(document.activeElement).toBe(q(`[data-forge-retry="${FAILED.runId}"]`));
  });

  it('prefills a proposal run with its whole brief, read when the list\'s was cut, and a plain Start an agent afterwards is clean again', async () => {
    const server = fakeServer({ runs: [STOPPED], profiles: ['claude'], limits: { turns: 9 } });
    mount();
    await openAgents();
    click(q(`[data-forge-retry="${STOPPED.runId}"]`));
    await settle();
    expect(server.urls()).toContain(`/api/agent-runs/${STOPPED.runId}/brief`);
    expect($('agent-start-about').textContent).toBe('About proposal 0040-meals');
    expect($('agent-kind').value).toBe('code');
    expect($('agent-profile').value).toBe('');
    expect($('agent-brief').value).toBe(`${'x'.repeat(2000)} and the rest of it`);
    expect($('agent-retry-note').textContent).toBe(`Starts again on ${STOPPED.runId}.`);
    // the run asked for no limits: none are filled in, and the server gives a blank one the config's
    expect($('agent-limit-turns').value).toBe('');
    click(q('[data-action="agent-start-cancel"]'));
    await settle();
    click(q('[data-forge-agent="proposal:0040-meals"]'));
    await settle();
    expect($('agent-start-title').textContent).toBe('Start an agent');
    expect($('agent-retry-note').hidden).toBe(true);
    expect($('agent-limit-turns').value).toBe('9');
    expect($('agent-brief').value).toBe('');
    q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(JSON.parse(server.posts().at(-1).init.body)).not.toHaveProperty('retryOf');
  });

  it('keeps an old profile the config no longer lists, so the server says so', async () => {
    const server = fakeServer({ runs: [FAILED], profiles: ['claude'], start: { status: 400, body: { ok: false, code: 'invalid', error: '"profile" "local-qwen" is not one of the configured profiles (claude).' } } });
    mount();
    await openAgents();
    click(q(`[data-forge-retry="${FAILED.runId}"]`));
    await settle();
    expect($('agent-profile').value).toBe('local-qwen');
    q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect($('agent-start-msg').textContent).toMatch(/not one of the configured profiles/);
    expect(server.posts()).toHaveLength(1);
  });

  it('says the cap, the open-run and the bad-retryOf refusals in the server\'s words and offers force only for run-open', async () => {
    for (const [code, error, force] of [['cap-reached', 'owner/name already has 3 open runs.', true], ['run-open', 'issue #7 already has an open run.', false], ['retry-open', '"retryOf" names run-X, which is still open (working).', true], ['not-found', '"retryOf" names run-X, which is not a run of owner/name.', true]]) {
      fakeServer({ runs: [FAILED], start: { status: 409, body: { ok: false, code, error } } });
      mount();
      await openAgents();
      click(q(`[data-forge-retry="${FAILED.runId}"]`));
      await settle();
      q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await settle();
      expect($('agent-start-msg').textContent).toBe(error);
      expect($('agent-force-field').hidden).toBe(force);
      expect($('agent-start').hidden).toBe(false);
      closeForge({ restoreFocus: false });
    }
  });

  it('does not post a limit that is not a number above zero', async () => {
    const server = fakeServer({ runs: [FAILED] });
    mount();
    await openAgents();
    click(q(`[data-forge-retry="${FAILED.runId}"]`));
    await settle();
    $('agent-limit-turns').value = '0';
    q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect($('agent-start-msg').textContent).toBe('A limit is a number above zero, or blank for the config\'s (turns).');
    expect($('agent-limit-turns').getAttribute('aria-invalid')).toBe('true');
    expect($('agent-limit-turns').getAttribute('aria-describedby')).toBe('agent-start-msg');
    expect($('agent-limit-minutes').hasAttribute('aria-invalid')).toBe(false);
    expect(document.activeElement).toBe($('agent-limit-turns'));
    expect(server.posts()).toHaveLength(0);
    $('agent-limit-turns').value = '3';
    q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect($('agent-limit-turns').hasAttribute('aria-invalid')).toBe(false);
    expect(JSON.parse(server.posts()[0].init.body).limits).toEqual({ minutes: 30, turns: 3, cost: 2.5 });
  });

  it('reads the whole brief only when the list\'s was cut, and opens nothing when it cannot be read', async () => {
    const server = fakeServer({ runs: [FAILED, STOPPED], brief: { status: 404, body: { ok: false, error: 'cornfield has no such run.', code: 'not-found' } } });
    mount();
    await openAgents();
    click(q(`[data-forge-retry="${FAILED.runId}"]`));
    await settle();
    expect(server.urls().some((u) => u.endsWith('/brief'))).toBe(false);
    click(q('[data-action="agent-start-cancel"]'));
    await settle();
    click(q(`[data-forge-retry="${STOPPED.runId}"]`));
    await settle();
    expect(server.urls()).toContain(`/api/agent-runs/${STOPPED.runId}/brief`);
    expect($('agent-start').hidden).toBe(true);
    expect($('forge-runs-note').textContent).toMatch(new RegExp(`The brief of ${STOPPED.runId} could not be read, so Start again did not open`));
    expect(await said()).toMatch(/could not be read/);
  });
});

describe('the Runs view links a run to the one it retries', () => {
  const OLD = { ...FAILED, retriedBy: ['run-01JC8Z3Q5M7VXK2RT9N4B6HDF9'], timeline: [{ at: '2026-11-05T11:00:00Z', kind: 'requested', actor: 'maintainer-one', ref: null, note: null, url: null }, { at: '2026-11-05T11:50:00Z', kind: 'retried-by', actor: null, ref: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDF9', note: null, url: null }] };
  const NEW = { ...RUN, runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDF9', retryOf: FAILED.runId, retriedBy: [], timeline: [{ at: '2026-11-05T11:50:00Z', kind: 'requested', actor: 'maintainer-one', ref: null, note: null, url: null }, { at: '2026-11-05T11:50:00Z', kind: 'retry-of', actor: null, ref: FAILED.runId, note: null, url: null }] };

  it('shows both ways, with a button that goes to the other run, and in the timeline', async () => {
    fakeServer({ runs: [NEW, OLD] });
    mount();
    await openAgents();
    const newRow = q(`[data-run="${NEW.runId}"]`);
    const oldRow = q(`[data-run="${OLD.runId}"]`);
    expect(newRow.textContent).toContain(`Starts again on ${FAILED.runId}`);
    expect(oldRow.textContent).toContain(`Started again as ${NEW.runId}`);
    click(newRow.querySelector('[data-run-goto]'));
    expect(document.activeElement).toBe(oldRow);
    click(oldRow.querySelector('[data-run-goto]'));
    expect(document.activeElement).toBe(newRow);
    click(newRow.querySelector('[data-run-timeline]'));
    await settle();
    const tl = q(`#run-tl-${NEW.runId}`);
    expect(tl.textContent).toContain(`Starts again on ${FAILED.runId}`);
    expect(tl.querySelector(`[data-run-goto="${FAILED.runId}"]`)).not.toBeNull();
  });

  it('names a run that is not in the list as text, with no button', async () => {
    fakeServer({ runs: [NEW] });
    mount();
    await openAgents();
    expect(q(`[data-run="${NEW.runId}"]`).textContent).toContain(`Starts again on ${FAILED.runId}`);
    expect(q('[data-run-goto]')).toBeNull();
  });
});

describe.each(['dark', 'light'])('accessibility, %s theme, Start again', (theme) => {
  it('passes axe with Start again listed, the dialog open and prefilled, a refusal showing, and the links', async () => {
    document.documentElement.dataset.theme = theme;
    const NEW = { ...RUN, runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDF9', refs: { issue: 11 }, retryOf: FAILED.runId, retriedBy: [], timeline: [{ at: '2026-11-05T11:50:00Z', kind: 'retry-of', actor: null, ref: FAILED.runId, note: null, url: null }] };
    fakeServer({ runs: [NEW, { ...FAILED, retriedBy: [NEW.runId] }, STOPPED], start: { status: 409, body: { ok: false, code: 'cap-reached', error: 'owner/name already has 3 open runs.' } } });
    mount();
    document.documentElement.dataset.theme = theme;
    await openAgents();
    click(q(`[data-run="${NEW.runId}"] [data-run-timeline]`));
    await settle();
    expect(await audit()).toEqual([]);
    click(q(`[data-forge-retry="${FAILED.runId}"]`));
    await settle();
    expect($('agent-limits-edit').hidden).toBe(false);
    expect(await audit()).toEqual([]);
    q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect($('agent-start-msg').hidden).toBe(false);
    expect(await audit()).toEqual([]);
    delete document.documentElement.dataset.theme;
  });
});

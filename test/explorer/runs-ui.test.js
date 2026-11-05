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
import { aboutWords, statusWords, runMeta, canStop, runsStatus, startBody, startWords, stopWords, confirmStartWords } from '../../explorer/runs-model.js';

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
    if (init.method === 'POST' && /\/stop$/.test(u.pathname)) { runs = runs.map((r) => (r.runId === RUN.runId ? { ...r, status: 'stop-requested', stopRequested: { at, by: 'maintainer-one' } } : r)); return opts.stop ? json(opts.stop.status, opts.stop.body) : json(200, { ok: true }); }
    if (u.pathname === '/api/agent-runs') return opts.runsDown ? json(502, { ok: false, error: 'cornfield could not read its runs.', code: 'unavailable' }) : json(200, { ok: true, runs, open: runs.filter((r) => r.open).length, maxOpen: 3, profiles: opts.profiles ?? ['claude', 'local-qwen'], limits: {} });
    if (u.pathname === '/api/forge/issues') return json(200, { ok: true, at, rate: '', items: [issue(7, 'Meals <b>page</b>'), issue(5, 'Sign-in')] });
    if (u.pathname === '/api/forge/pulls') return json(200, { ok: true, at, rate: '', items: [] });
    if (u.pathname === '/api/forge/work') return json(200, { ok: true, at, rate: '', pulls: [pr(50, 'Meals page', 'Closes #7', 'agent/meals'), pr(40, 'Meals spec', '', 'spec/0040-meals')], issues: [issue(7, 'Meals page')], branches: [], specs: [{ pull: 40, slug: '0040-meals' }], agents: {} });
    return json(404, { ok: false, error: 'No such thing.', code: 'not-found' });
  }));
  return { calls, posts: () => calls.filter((c) => c.init.method === 'POST'), urls: () => calls.map((c) => c.url) };
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
    expect([...rows[0].querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://git.example.test/owner/name/issues/7#issuecomment-9', 'https://git.example.test/owner/name/pull/50', 'https://ci.example.org/1']);
    expect(rows[0].querySelector('[data-forge-stop]').getAttribute('aria-label')).toBe(`Stop run ${RUN.runId}`);
    expect(rows[1].textContent).toContain('Quiet');
    expect(rows[1].textContent).toMatch(/no longer counts toward the limit/);
    expect(rows[1].querySelector('[data-forge-stop]')).toBe(null);
    // the section is only on the Agents tab
    click(q('[data-forge-kind="issues"]'));
    await settle();
    expect(q('#forge-runs').hidden).toBe(true);
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

describe.each(['dark', 'light'])('accessibility, %s theme', (theme) => {
  it('passes axe with the runs listed and with the dialog open, a refusal showing', async () => {
    document.documentElement.dataset.theme = theme;
    fakeServer({ start: { status: 409, body: { ok: false, code: 'run-open', error: 'issue #7 already has an open run.' } } });
    mount();
    document.documentElement.dataset.theme = theme;
    await openAgents();
    expect(await audit()).toEqual([]);
    click(q('[data-forge-agent="issue:7"]'));
    await settle();
    q('#agent-start form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(await audit()).toEqual([]);
    delete document.documentElement.dataset.theme;
  });
});

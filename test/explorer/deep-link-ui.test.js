// @vitest-environment happy-dom
/**
 * Deep links (issue #103, explorer/deep-link.js, spec 0012 D8), through the page's own markup with a fake server behind `fetch`:
 * `?proposal=…&start=1` opens the Start dialog; `?run=` and `?issue=` are the Work view's addresses now (work-view.js), and work the
 * graph does not draw (older than its 14 days) is shown in the node panel by `showWorkRef`, which is what they come to here: a run's
 * card, an issue's Start an agent, a closed issue as closed; each on a desktop and on a phone; a name that is not there is a line in the
 * Work list said through the live region. A followed link is taken out of the address so a reload does not open it again, `?proposal=` stays.
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
import { initForgePanel, resetForgePanelForTests, closeForge, openForge, showWorkRef } from '../../explorer/forge-panel.js';
// @ts-expect-error plain JS modules, no declarations
import { initWorkView, resetWorkViewForTests } from '../../explorer/work-view.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard, resetKeyboardForTests } from '../../explorer/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { initSheets, sheetState } from '../../explorer/sheets.js';
// @ts-expect-error plain JS modules, no declarations
import { closeDrawer, selectNode, startRun } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { parseDeepLink, followDeepLink } from '../../explorer/deep-link.js';
import { explorerPage } from '../helpers.js';

import { explorerCss } from './stylesheets.js';
const EXPLORER = path.resolve(__dirname, '../../explorer');
const page = explorerPage({ pieces: ['map'] });
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const css = explorerCss(['explorer.css', 'house.css']);
const NOW = Date.parse('2026-11-05T12:00:00Z');
const MAP = { nodes: [{ id: 'root', type: 'root', x: 0, y: 0, r: 20, color: '#336699', label: 'root', degree: 0 }], edges: [] };
const user = (login) => ({ login, url: `https://git.example.test/${login}` });
const issue = (number, title) => ({ number, title, state: 'open', author: user('maintainer-one'), labels: [], comments: 0, url: `https://git.example.test/owner/name/issues/${number}`, createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-01T09:00:00Z', closedAt: null, body: '' });
const RUN_ID = 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEF';
const OTHER_ID = 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEG';
const RUN = {
  runId: RUN_ID, kind: 'code', profile: 'claude', refs: { issue: 7 }, status: 'working', open: true, requestedBy: 'maintainer-one', requestedAt: '2026-11-05T11:00:00Z', via: 'dashboard',
  comment: { id: '9', url: 'https://git.example.test/owner/name/issues/7#issuecomment-9' }, limits: {}, stopRequested: null, checks: null, report: null, pull: null, nodes: ['root'],
};
const $ = (id) => document.getElementById(id);
const q = (sel) => document.querySelector(sel);
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const said = async () => { await new Promise((r) => setTimeout(r, 50)); return $('map-announcer').textContent; };
const phone = (matches) => vi.stubGlobal('matchMedia', (query) => ({ matches: matches && /max-width: 767px/.test(query), media: query, addEventListener() {}, removeEventListener() {} }));

function fakeServer() {
  const calls = [];
  const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url, 'http://localhost');
    const at = '2026-11-05T11:58:00.000Z';
    if (u.pathname === '/api/agent-runs') return json(200, { ok: true, runs: [RUN], open: 1, maxOpen: 3, profiles: ['claude'], limits: {} });
    if (u.pathname === '/api/forge/issues') return json(200, { ok: true, at, rate: '', items: [issue(7, 'Meals page'), issue(5, 'Sign-in')] });
    // One issue, whatever its state: 12 is closed (its title is markup, to be shown as text), 40 open past the list, the rest not there
    if (u.pathname === '/api/forge/issues/12') return json(200, { ok: true, at, rate: '', issue: { ...issue(12, '<img src=x onerror="window.pwned=1">Old'), state: 'closed', closedAt: at } });
    if (u.pathname === '/api/forge/issues/40') return json(200, { ok: true, at, rate: '', issue: issue(40, 'Far down') });
    if (u.pathname === '/api/forge/pulls') return json(200, { ok: true, at, rate: '', items: [] });
    if (u.pathname === '/api/forge/work') return json(200, { ok: true, at, rate: '', pulls: [], issues: [issue(7, 'Meals page')], branches: [], specs: [], agents: {} });
    return json(404, { ok: false, error: 'No such thing.', code: 'not-found' });
  }));
  return { urls: () => calls.map((c) => c.url) };
}

function mount(extra = {}) {
  document.head.innerHTML = `<title>cornfield</title><style>${css}</style>`;
  document.body.innerHTML = body;
  document.documentElement.lang = 'en';
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = $('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, labelCanvas: null, proposal: null, view: 'orbit', selectedNode: null, isFreeform: false, scenario: null, searchQuery: '' });
  state.camera = { x: 0, y: 0, zoom: 1 };
  render.resize();
  state.baseNodes = MAP.nodes.map((n) => ({ ...n }));
  state.baseEdges = MAP.edges;
  setMap(MAP.nodes.map((n) => ({ ...n })), MAP.edges);
  resetKeyboardForTests();
  initKeyboard();
  initSheets();
  resetForgePanelForTests(() => NOW);
  resetWorkViewForTests();
  const forgeOn = initForgePanel({ forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' }, signIn: { login: 'maintainer-one' }, ...extra }, { clock: () => NOW });
  initWorkView({ offered: true }); // answers the node panel for a piece of work (work:panel): the actions are in it
  return forgeOn;
}
const follow = async (search, opts = {}) => {
  history.replaceState(null, '', `/${search}`);
  const done = await followDeepLink({ forgeOn: true, ...opts });
  await settle();
  return done;
};

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { closeForge({ restoreFocus: false }); closeDrawer(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('what a query asks for (parseDeepLink)', () => {
  beforeEach(() => { document.body.innerHTML = body; });
  it('reads only the link that starts an agent on a proposal, and calls a value that cannot be a name bad', () => {
    expect(parseDeepLink('')).toBeNull();
    expect(parseDeepLink('?view=dataflow')).toBeNull();
    expect(parseDeepLink(`?run=${RUN_ID}&issue=3`)).toBeNull(); // the Work view's addresses (work-model.js workAddress)
    expect(parseDeepLink('?issue=12')).toBeNull();
    expect(parseDeepLink('?proposal=0040-meals&start=1')).toEqual({ kind: 'proposal', slug: '0040-meals' });
    expect(parseDeepLink('?proposal=0040-meals')).toBeNull(); // opening a proposal is proposal.js's, with no Start
    expect(parseDeepLink('?proposal=../x&start=1')).toMatchObject({ kind: 'proposal', bad: expect.stringMatching(/not a proposal name/) });
  });
});

describe.each([['a desktop', false], ['a phone', true]])('on %s', (_name, onPhone) => {
  beforeEach(() => phone(onPhone));

  it('a run the graph does not draw is shown in the node panel with its card, and said', async () => {
    fakeServer();
    mount();
    expect(await showWorkRef('run', RUN_ID)).toBe(true);
    await settle();
    expect($('spec-drawer').classList.contains('drawer-open')).toBe(true);
    expect($('drawer-badge').textContent).toBe('Agent run');
    expect(q(`#forge-run-card [data-run="${RUN_ID}"]`)).not.toBeNull();
    expect(await said()).toBe(`Run ${RUN_ID}`);
  });

  it('a run that is not there says so in the list and through the live region, never a blank', async () => {
    const server = fakeServer();
    mount();
    openForge({ tab: 'work' });
    expect(await showWorkRef('run', OTHER_ID)).toBe(false);
    expect($('forge-act-note').hidden).toBe(false);
    expect($('forge-act-note').textContent).toBe(`There is no run ${OTHER_ID}.`);
    expect(await said()).toBe(`There is no run ${OTHER_ID}.`);
    expect(server.urls()).toContain('/api/agent-runs?follow=1'); // asked once more, past the cache
    expect($('spec-drawer').classList.contains('drawer-open')).toBe(false);
  });

  it('an issue the graph does not draw is shown with its Start an agent, which is not opened for you', async () => {
    fakeServer();
    mount();
    expect(await showWorkRef('issue', '7')).toBe(true);
    await settle();
    expect($('drawer-badge').textContent).toBe('Issue');
    expect(q('#forge-detail [data-forge-agent="issue:7"]')).not.toBeNull();
    expect($('agent-start').hidden).toBe(true);
  });

  it('an issue that is not listed asks for it once: no such issue is said so', async () => {
    const srv = fakeServer();
    mount();
    openForge({ tab: 'issues' });
    expect(await showWorkRef('issue', '99')).toBe(false);
    expect($('forge-act-note').textContent).toBe('There is no issue 99.');
    expect(await said()).toBe('There is no issue 99.');
    expect(srv.urls().filter((u) => u === '/api/forge/issues/99')).toHaveLength(1);
    expect($('agent-start').hidden).toBe(true);
  });

  it('a closed issue is shown as closed, with its title as text and a link to it, and nothing to start', async () => {
    const srv = fakeServer();
    mount();
    expect(await showWorkRef('issue', '12')).toBe(true);
    await settle();
    expect($('drawer-title').textContent).toBe('<img src=x onerror="window.pwned=1">Old');
    expect(q('#spec-drawer img')).toBeNull();
    expect(q('#forge-detail [data-forge-agent]')).toBeNull();
    expect(q('#forge-detail').textContent).toContain('closed');
    expect(q('#spec-drawer a[href="https://git.example.test/owner/name/issues/12"]')).not.toBeNull();
    expect(srv.urls().filter((u) => u.startsWith('/api/forge/issues/'))).toEqual(['/api/forge/issues/12']);
    // An open issue the list does not reach is shown as open, with its Start an agent
    expect(await showWorkRef('issue', '40')).toBe(true);
    await settle();
    expect(q('#forge-detail [data-forge-agent="issue:40"]')).not.toBeNull();
  });

  it('?proposal=&start=1 opens the Start dialog on that proposal, and leaves ?proposal= in the address', async () => {
    fakeServer();
    mount();
    $('proposal-bar').hidden = false; // proposalOpened: the bar is showing (a sheet that is not open cannot be expanded)
    expect(await follow('?proposal=0040-meals&start=1&view=dataflow', { proposalOpened: true })).toBe(true);
    if (onPhone) expect(sheetState('proposal')).toBe('expanded');
    expect($('agent-start').hidden).toBe(false);
    expect($('agent-start-about').textContent).toBe('About proposal 0040-meals');
    expect(document.activeElement).toBe($('agent-kind'));
    expect(window.location.search).toBe('?proposal=0040-meals&view=dataflow');
  });

  it('?proposal=&start=1 for a proposal that does not exist says so and opens no dialog', async () => {
    fakeServer();
    mount();
    $('proposal-message').textContent = 'No proposal called nope.';
    expect(await follow('?proposal=nope&start=1', { proposalOpened: false })).toBe(false);
    expect($('agent-start').hidden).toBe(true);
    expect(await said()).toBe('No proposal called nope.');
    expect(window.location.search).toBe('?proposal=nope');
  });
});

describe("the node panel's Start a run (#138)", () => {
  afterEach(() => { state.proposalSlug = null; });

  it('shows with a proposal open, opens the Start dialog on it, and Cancel puts the focus back on the button', async () => {
    fakeServer();
    mount({ agents: { runs: true } }); // what the server adds with a forge and sign-in (server.js)
    state.proposalSlug = null;
    await selectNode(state.nodes[0]);
    expect($('drawer-run-btn').hidden).toBe(true); // no proposal: nothing to hand an agent
    state.proposalSlug = '0040-meals';
    await selectNode(state.nodes[0]);
    const run = $('drawer-run-btn');
    expect(run.hidden).toBe(false);
    run.focus();
    startRun(); // what its data-action does (main.js)
    await settle();
    expect($('agent-start').hidden).toBe(false);
    expect($('agent-start-about').textContent).toBe('About proposal 0040-meals');
    expect(document.activeElement).toBe($('agent-kind'));
    q('#agent-start [data-action="agent-start-cancel"]').click();
    expect($('agent-start').hidden).toBe(true);
    expect(document.activeElement).toBe(run);
  });
});

describe('after the link', () => {
  it('a reload does not open the dialog again: start is gone from the address, ?proposal= stays', async () => {
    fakeServer();
    mount();
    $('proposal-bar').hidden = false;
    history.replaceState(null, '', '/?proposal=0040-meals&start=1&x=1');
    await followDeepLink({ forgeOn: true, proposalOpened: true });
    expect(window.location.search).toBe('?proposal=0040-meals&x=1');
    expect(parseDeepLink(window.location.search)).toBeNull(); // a reload reads the address: nothing is asked for
  });

  it('with no forge in the config it still says why, and still cleans the address', async () => {
    fakeServer();
    history.replaceState(null, '', '/?proposal=0040-meals&start=1');
    document.body.innerHTML = body;
    expect(await followDeepLink({ forgeOn: false, proposalOpened: true })).toBe(false);
    expect(await said()).toBe('Start an agent needs a forge in the config.');
    expect(window.location.search).toBe('?proposal=0040-meals');
  });
});

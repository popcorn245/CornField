// @vitest-environment happy-dom
/**
 * Spec 0011 D4, D5, D6: the review's sections as tags of their own (`<corn-proposal>`, `<corn-changes>`, `<corn-decision>`) on a scope's instance. The scope holds the
 * proposal (pieces/scope-proposal.js: the same opening `corn-review` does, once), and each section is a piece in a root of its own (pieces/around.js with `exclusive`):
 * the proposal opens when there is a map and not before, the host hears one `navigate` and one `decision` whatever the sections do, a section says what it needs, a
 * second of one says so and takes over, a refused read is the card in the section's own root, and what lay over the map in the page's layout (the bar, the column, the
 * player, the dock) is asked for by an event and answered by whoever has it, never found by an id in a root that is not its own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { loadSample, SAMPLE } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { mountScope } from '../../explorer/pieces/scope.js';
// @ts-expect-error plain JS modules, no declarations
import { mount as mountMap } from '../../explorer/pieces/map.js';
// @ts-expect-error plain JS modules, no declarations
import { mountAround } from '../../explorer/pieces/around.js';
// @ts-expect-error plain JS modules, no declarations
import * as proposalPiece from '../../explorer/pieces/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import * as changesPiece from '../../explorer/pieces/changes.js';
// @ts-expect-error plain JS modules, no declarations
import * as decisionPiece from '../../explorer/pieces/decision.js';
// @ts-expect-error plain JS modules, no declarations
import { visibleMapRect } from '../../explorer/engine/map-rect.js';
// @ts-expect-error plain JS modules, no declarations
import { setProposalView } from '../../explorer/engine/proposal.js';
// The chunk a scope loads the first time it has a proposal (`import()` in pieces/scope.js), loaded here first: with the clock faked, a first load that takes long
// on a busy machine would land after the steps that wait for it
// @ts-expect-error plain JS modules, no declarations
import '../../explorer/pieces/scope-proposal.js';

const sample = loadSample();
const checkout = JSON.parse(fs.readFileSync(`${SAMPLE}/docs/specs/proposals/0002-checkout.json`, 'utf8'));
const topology = () => structuredClone({ nodes: sample.nodes, edges: sample.edges });
const ctx2d = new Proxy({}, { get: (t, k) => (k === 'measureText' ? (text) => ({ width: String(text).length * 6 }) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const BASE = 'https://map.example.com';
const SHA = 'a'.repeat(64);

let restore = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  const realGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) { return type === '2d' ? ctx2d : null; };
  restore.push(() => { HTMLCanvasElement.prototype.getContext = realGet; });
});
afterEach(() => {
  restore.forEach((fn) => fn());
  restore = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const shadowOf = (name) => {
  const host = document.createElement('div');
  host.id = name;
  document.body.append(host);
  return host.attachShadow({ mode: 'open' });
};
const flush = async (ms = 50) => { await vi.advanceTimersByTimeAsync(ms); };
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Proposal-Source': 'pull%2F31', 'X-Proposal-Sha256': SHA, ...(init.headers || {}) }, ...init });

/** A scope with a map, as the page of a host app has it: the scope's element, its map piece in a shadow root of its own, and what the host hears */
async function setup({ proposal = null, source = null, view = null, withMap = true, fetchImpl } = {}) {
  const calls = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    if (fetchImpl) { const answer = await fetchImpl(String(url), init); if (answer) return answer; }
    if (/\/proposals\/[^/]+\.json/.test(String(url))) return json(checkout);
    if (/\/review/.test(String(url)) && (init.method || 'GET') === 'GET') return new Response('{}', { status: 404 });
    if (/\/decision/.test(String(url))) return new Response('{}', { status: 404 });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const el = document.createElement('div');
  document.body.append(el);
  const heard = { navigate: [], decision: [], auth: [], error: [] };
  const scope = mountScope(el, {
    src: BASE, topology: topology(), config: {}, proposal, source, view, version: '0.0.0', pageUrl: () => 'https://tasks.example.com/board',
    onNavigate: (d) => heard.navigate.push(d), onDecision: (d) => heard.decision.push(d), onAuth: (d) => heard.auth.push(d), onError: (d) => heard.error.push(d),
  });
  const inst = scope.instance;
  let map = null;
  if (withMap) {
    map = mountMap(shadowOf('map'), inst, { renderer: 'canvas2d' });
    await flush();
  }
  return { el, scope, inst, map, heard, calls, fetchMock };
}

/** A section in a root of its own, as its tag mounts it */
const section = (kind, inst, name = kind) => {
  const root = shadowOf(name);
  const piece = { proposal: proposalPiece, changes: changesPiece, decision: decisionPiece }[kind];
  const options = { proposal: { exclusive: 'corn-proposal', signIn: { during: ['proposal'], clear: 'proposal' }, piece: { inline: true, edit: false } }, changes: { exclusive: 'corn-changes', piece: { inline: true } }, decision: { exclusive: 'corn-decision', signIn: { during: ['facts', 'review', 'send', 'landing'], clear: 'decision' }, piece: { inline: true } } }[kind];
  return { root, around: mountAround(piece, root, inst, options) };
};
const says = (root) => (root.querySelector('[data-corn="empty"]') || {}).textContent;

describe('the scope holds the proposal for every piece in it (pieces/scope-proposal.js)', () => {
  it('opens a name once there is a map with nodes, reading it the way the review does, and tells the host once: opened, from the scope', async () => {
    const t = await setup({ proposal: '0002-checkout', source: 'pull/31' });
    await flush(200);
    expect(t.calls.filter((c) => /\/proposals\/0002-checkout\.json/.test(c.url))).toHaveLength(1);
    expect(t.calls.find((c) => /\.json/.test(c.url)).url).toBe(`${BASE}/proposals/0002-checkout.json?source=pull%2F31`);
    expect(t.inst.state.proposal).toBeTruthy();
    expect(t.inst.state.proposalSlug).toBe('0002-checkout');
    expect(t.inst.state.proposalSha256).toBe(SHA);
    expect(t.inst.state.nodes.some((n) => n.mark === 'added')).toBe(true); // the map has the proposal's marks laid over it
    expect(t.heard.navigate).toEqual([{ proposal: '0002-checkout', source: 'pull/31', view: 'diff', change: 'opened' }]);
    t.scope.update({ proposal: '0002-checkout', source: 'pull/31' });
    await flush(200);
    expect(t.calls.filter((c) => /\/proposals\/0002-checkout\.json/.test(c.url))).toHaveLength(1); // the same ask opens nothing again
    expect(t.heard.navigate).toHaveLength(1);
    t.scope.destroy();
  });

  it('takes a host\'s `source` and `proposal` (or `proposal` and `view`) set one after the other as one ask: the old proposal is never read under the new source', async () => {
    const t = await setup({ proposal: '0002-checkout', source: 'pull/31' });
    await flush(200);
    // as <corn-scope>'s watchers hand them over: one key at a time, in the order the host's script set them
    t.scope.update({ source: 'pull/32' });
    t.scope.update({ proposal: '0003-other' });
    t.scope.update({ view: 'before' });
    await flush(300);
    const reads = t.calls.filter((c) => /\/proposals\/[^/]+\.json/.test(c.url)).map((c) => c.url.replace(BASE, ''));
    expect(reads).toEqual(['/proposals/0002-checkout.json?source=pull%2F31', '/proposals/0003-other.json?source=pull%2F32']);
    expect(t.heard.error).toEqual([]);
    // opened, then the view the host asked for (as <corn-review> says them: the proposal opens on Diff, and the view follows)
    expect(t.heard.navigate.slice(1)).toEqual([{ proposal: '0003-other', source: 'pull/32', view: 'diff', change: 'opened' }, { proposal: '0003-other', source: 'pull/32', view: 'before', change: 'view' }]);
    expect(t.inst.state.proposalView).toBe('before');
    t.scope.destroy();
  });

  it('waits for the map: a proposal asked for before the map has nodes is not fetched, and opens when the map comes', async () => {
    const t = await setup({ proposal: '0002-checkout', source: 'pull/31', withMap: false });
    await flush(200);
    expect(t.calls.filter((c) => /\.json/.test(c.url))).toHaveLength(0);
    mountMap(shadowOf('late-map'), t.inst, { renderer: 'canvas2d' });
    await flush(300);
    expect(t.calls.filter((c) => /\/proposals\//.test(c.url) && /\.json/.test(c.url))).toHaveLength(1);
    expect(t.inst.state.proposal).toBeTruthy();
    t.scope.destroy();
  });

  it('switches Before, Diff and After by the property and by the reviewer, and the host hears each change once (the property handed back changes nothing)', async () => {
    const t = await setup({ proposal: '0002-checkout', source: 'pull/31' });
    await flush(200);
    t.scope.update({ view: 'before' });
    await flush(50);
    expect(t.inst.state.proposalView).toBe('before');
    expect(t.heard.navigate.map((d) => `${d.change}:${d.view}`)).toEqual(['opened:diff', 'view:before']);
    setProposalView(t.inst, 'after'); // the reviewer's button
    expect(t.heard.navigate.map((d) => `${d.change}:${d.view}`)).toEqual(['opened:diff', 'view:before', 'view:after']);
    t.scope.update({ view: 'after' }); // what the shell hands back after `cornNavigate`: nothing
    expect(t.heard.navigate).toHaveLength(3);
    t.scope.destroy();
  });

  it('closes by null, and by the reviewer; closing says `closed` once, and the same name asked for again opens it again', async () => {
    const t = await setup({ proposal: '0002-checkout', source: 'pull/31' });
    await flush(200);
    t.scope.update({ proposal: null });
    await flush(50);
    expect(t.inst.state.proposal).toBe(null);
    expect(t.heard.navigate.at(-1)).toEqual({ proposal: null, source: null, view: null, change: 'closed' });
    expect(t.heard.navigate).toHaveLength(2);
    t.scope.update({ proposal: '0002-checkout' });
    await flush(200);
    expect(t.inst.state.proposal).toBeTruthy();
    expect(t.calls.filter((c) => /\.json/.test(c.url))).toHaveLength(2);
    t.scope.destroy();
  });

  it('shows a proposal handed in as an object without a request, and a name that is not a proposal\'s name is said, never put in a request', async () => {
    const t = await setup({ proposal: checkout });
    await flush(100);
    expect(t.inst.state.proposal).toBeTruthy();
    expect(t.calls.filter((c) => /\/proposals\//.test(c.url) && /\.json/.test(c.url))).toHaveLength(0);
    expect(t.heard.navigate[0]).toMatchObject({ proposal: null, change: 'opened' });
    t.scope.update({ proposal: '../review' });
    await flush(100);
    expect(t.calls.some((c) => /\.\./.test(c.url))).toBe(false);
    expect(t.heard.error.some((e) => e.kind === 'proposal')).toBe(true);
    t.scope.destroy();
  });

  it('with no `src` a name is asked of nobody: it is said in the bar, as the review says it, and the host hears cornError', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const el = document.createElement('div');
    document.body.append(el);
    const errors = [];
    const scope = mountScope(el, { topology: topology(), config: {}, proposal: '0002-checkout', onError: (d) => errors.push(d) });
    mountMap(shadowOf('map'), scope.instance, { renderer: 'canvas2d' });
    await flush(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors.some((e) => e.kind === 'proposal' && /no cornfield server/.test(e.message))).toBe(true);
    scope.destroy();
  });

  it('lays a proposal over a new base map (a topology the host hands in later), and answers `map:set` and `proposal:specs-list` for the pieces', async () => {
    const t = await setup({ proposal: '0002-checkout', source: 'pull/31' });
    await flush(200);
    expect(t.inst.ask('proposal:specs-list')).toBe(false);
    expect(t.inst.ask('map:set', { nodes: t.inst.state.nodes, edges: t.inst.state.edges })).toBe(true);
    const next = topology();
    t.scope.update({ topology: next });
    await flush(100);
    expect(t.inst.state.proposal).toBeTruthy();
    expect(t.inst.state.nodes.some((n) => n.mark === 'added')).toBe(true);
    t.scope.destroy();
  });

  it('a scope that never has a proposal loads nothing of this, and `src` changed makes a new instance that holds it again', async () => {
    const t = await setup({});
    await flush(100);
    expect(t.inst.ask('proposal:specs-list')).toBe(undefined); // nobody holds one
    t.scope.update({ proposal: '0002-checkout', source: 'pull/31' });
    await flush(300);
    expect(t.inst.state.proposal).toBeTruthy();
    expect(t.inst.ask('proposal:specs-list')).toBe(false);
    t.scope.destroy();
  });
});

describe('the sections in roots of their own', () => {
  it('each mounts when there is a map with data and not before, and draws what the instance has: the bar, the list, the decision', async () => {
    const t = await setup({ proposal: '0002-checkout', source: 'pull/31', withMap: false });
    const s = { proposal: section('proposal', t.inst), changes: section('changes', t.inst), decision: section('decision', t.inst) };
    for (const k of Object.keys(s)) expect(says(s[k].root), k).toBe('This needs a corn-map in the same corn-scope');
    mountMap(shadowOf('map'), t.inst, { renderer: 'canvas2d' });
    await flush(300);
    expect(s.proposal.root.querySelector('[data-corn="proposal-title"]').textContent).toBeTruthy();
    expect(s.proposal.root.querySelector('[data-corn="proposal-bar"]').hidden).toBe(false);
    expect(s.changes.root.querySelectorAll('[data-corn="row"]').length).toBeGreaterThan(0);
    expect(s.decision.root.querySelector('[data-review="approved"]')).toBeTruthy();
    expect(s.decision.root.querySelector('[data-corn="decision"]').hidden).toBe(false);
    t.scope.destroy();
  });

  it('are the box and nothing of a phone: no sheet handle, no tabs and no Proposals menu, whatever the window\'s width says', async () => {
    vi.stubGlobal('matchMedia', (query) => ({ matches: query.includes('767px'), addEventListener() {}, removeEventListener() {} }));
    window.matchMedia = globalThis.matchMedia;
    const t = await setup({ proposal: '0002-checkout', source: 'pull/31' });
    await flush(200);
    const s = { proposal: section('proposal', t.inst), changes: section('changes', t.inst), decision: section('decision', t.inst) };
    await flush(100);
    for (const k of Object.keys(s)) {
      expect(s[k].root.querySelector('.hx-sheet-handle, [data-corn="sheet-handle"]'), `${k}: a sheet handle`).toBe(null);
      expect(s[k].root.querySelector('.hx-sheet'), `${k}: a sheet`).toBe(null);
    }
    expect(s.changes.root.querySelector('[data-corn="tabs"]').hidden).toBe(true);
    expect(s.proposal.root.querySelector('[data-corn="proposals-button"]')).toBe(null);
    expect(s.proposal.root.querySelector('#proposal-wrap')).toBe(null);
    expect(s.proposal.root.querySelector('[data-corn-string="myEdits"], #proposal-edit')).toBe(null); // the what-if editor is not a section's
    // and what lay over the map in the page's layout lies over nothing here: the map frames into its whole box
    expect(t.inst.ask('proposal:covers')).toBe(undefined);
    expect(t.inst.ask('changes:covers')).toBe(undefined);
    expect(t.inst.ask('player:covers')).toBe(undefined);
    expect(t.inst.ask('proposal:seat-column', { column: document.createElement('div'), phone: true })).toBe(undefined);
    expect(visibleMapRect(t.inst)).toMatchObject({ x: 0, y: 0 });
    t.scope.destroy();
  });

  it('a click on a change selects it on the map; the click is heard by the list\'s own root, not the map\'s', async () => {
    const t = await setup({ proposal: '0002-checkout', source: 'pull/31' });
    await flush(200);
    const list = section('changes', t.inst);
    await flush(100);
    const row = list.root.querySelector('[data-action="proposal-focus"][data-kind="node"]');
    expect(row).toBeTruthy();
    row.click();
    await flush(50);
    expect(t.inst.state.selectedNode && t.inst.state.selectedNode.id).toBe(row.dataset.key);
    t.scope.destroy();
  });

  it('the scenario player is a part of the list\'s own box (its seat), with the keys of that root, and closing it gives the focus back to the step', async () => {
    const t = await setup({ proposal: '0002-checkout', source: 'pull/31' });
    await flush(200);
    const list = section('changes', t.inst);
    await flush(100);
    const open = list.root.querySelector('[data-action="scenario-open"]');
    if (!open) return; // the fixture proposal has no scenario: nothing to play
    open.click();
    await flush(20);
    const step = list.root.querySelector('[data-action="scenario-step"]');
    step.focus();
    step.click();
    await flush(100);
    const bar = list.root.querySelector('[data-corn="scenario-player"]');
    expect(bar).toBeTruthy();
    expect(bar.parentElement.classList.contains('hx-player-seat')).toBe(true);
    expect(bar.classList.contains('hx-sheet')).toBe(false);
    bar.querySelector('[data-action="scenario-next"]').click();
    await flush(20);
    list.root.querySelector('[data-action="scenario-step"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true }));
    await flush(50);
    expect(list.root.querySelector('[data-corn="scenario-player"]')).toBe(null);
    t.scope.destroy();
  });
});

describe('one of each section in a scope', () => {
  it('a second says so in its own place, tells the scope once (cornError second-section), draws nothing else, and takes over when the first leaves', async () => {
    const t = await setup({ proposal: '0002-checkout', source: 'pull/31' });
    await flush(200);
    const first = section('decision', t.inst, 'one');
    const second = section('decision', t.inst, 'two');
    await flush(100);
    expect(first.root.querySelector('[data-review="approved"]')).toBeTruthy();
    expect(says(second.root)).toBe('This scope already has one of these');
    expect(second.root.querySelector('[data-review="approved"]')).toBe(null);
    expect(t.heard.error.filter((e) => e.kind === 'second-section')).toHaveLength(1);
    // the decision's requests are made by the first, and only once
    const reads = t.calls.filter((c) => /\/review/.test(c.url)).length;
    expect(reads).toBeLessThanOrEqual(1);
    first.around.destroy();
    await flush(50);
    expect(second.root.querySelector('[data-review="approved"]')).toBeTruthy();
    expect(says(second.root)).toBe(undefined);
    second.around.destroy();
    t.scope.destroy();
  });

  it('the three are held apart: a second bar does not refuse a first list', async () => {
    const t = await setup({ proposal: '0002-checkout', source: 'pull/31' });
    await flush(200);
    const a = section('proposal', t.inst, 'bar-a');
    const b = section('changes', t.inst, 'list-a');
    const c = section('decision', t.inst, 'foot-a');
    const d = section('proposal', t.inst, 'bar-b');
    await flush(100);
    for (const x of [a, b, c]) expect(says(x.root)).toBe(undefined);
    expect(says(d.root)).toBe('This scope already has one of these');
    t.scope.destroy();
  });
});

describe('a refused read or press (the scope\'s card, in the section where the person is)', () => {
  it('the host hears cornAuth once with `during`, and the decision shows the card with the link to the server\'s sign-in; a decision taken takes it away', async () => {
    const t = await setup({ proposal: '0002-checkout', source: 'pull/31' });
    await flush(200);
    const foot = section('decision', t.inst);
    await flush(100);
    t.inst.emit('auth', { status: 401, during: 'send' });
    expect(t.heard.auth).toEqual([{ status: 401, signIn: `${BASE}/auth/start?returnTo=${encodeURIComponent('https://tasks.example.com/board')}`, during: 'send' }]);
    const link = foot.root.querySelector('[data-corn="source-sign-in"]');
    expect(link.getAttribute('href')).toBe(t.heard.auth[0].signIn);
    expect(foot.root.querySelector('[data-corn="source-title"]').textContent).toBe('You are not signed in to cornfield');
    t.inst.emit('decision', { outcome: 'approved', review: {}, slug: '0002-checkout', source: 'pull/31', open: true });
    expect(foot.root.querySelector('[data-corn="source-status"]').hidden).toBe(true);
    expect(t.heard.decision).toEqual([{ outcome: 'approved', proposal: '0002-checkout', source: 'pull/31', open: true, review: {} }]);
    t.scope.destroy();
  });

  it('a read of the facts that is still refused is said once, not every half minute; a press is said each time', async () => {
    const t = await setup({ proposal: '0002-checkout', source: 'pull/31' });
    await flush(200);
    t.inst.emit('auth', { status: 401, during: 'facts' });
    t.inst.emit('auth', { status: 401, during: 'facts' });
    t.inst.emit('auth', { status: 401, during: 'send' });
    t.inst.emit('auth', { status: 401, during: 'send' });
    expect(t.heard.auth.map((a) => a.during)).toEqual(['facts', 'send', 'send']);
    t.scope.destroy();
  });
});

describe('what lay over the map is asked for, not found by an id (the page\'s layout answers)', () => {
  it('the bar, the column and the player in one root answer for themselves; a piece in a root of its own answers none', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const inst = (await import('../../explorer/instance.js')).createInstance({ root });
    inst.on('proposal:covers', () => ({ bottom: 120 }));
    inst.on('changes:covers', () => ({ right: 300 }));
    inst.on('player:covers', () => ({ top: 700 }));
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 });
    inst.state.canvas = canvas;
    inst.state.width = 1200;
    inst.state.height = 800;
    const rect = visibleMapRect(inst);
    expect(rect).toMatchObject({ x: 308, y: 128, width: 892, height: 564 }); // the bar's 120 + 8 from the top, the column's 300 + 8 from the left, the player's 100 + 8 from the bottom
    inst.destroy();
  });

  it('the player asks the dock\'s owner to seat its bar; a menu with its own Escape is asked for the same way', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const inst = (await import('../../explorer/instance.js')).createInstance({ root });
    const bar = document.createElement('div');
    expect(inst.ask('player:seat', bar)).toBe(undefined);
    expect(inst.ask('popup:open')).toBe(undefined);
    inst.on('popup:open', () => true);
    expect(inst.ask('popup:open')).toBe(true);
    inst.destroy();
  });
});

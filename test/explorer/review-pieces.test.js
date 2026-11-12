// @vitest-environment happy-dom
/**
 * Spec 0011 D2 and D3, step 5: the proposal's bar, the change list with the player and the decision as pieces on an instance. What a host needs of them:
 * a proposal opens by name (fetched through the instance, so a base address applies, with the maintainer's session) or by object (nothing is fetched);
 * the instance says when it opened, changed view or closed; the decision says what the server answered, and when sign-in is needed, and navigates nothing;
 * an edge is the node panel's to show; the address bar is the page's. Each test fails without the thing it holds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadSample } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { createInstance } from '../../explorer/instance.js';
// @ts-expect-error plain JS modules, no declarations
import { createMap } from '../../explorer/engine/render.js';
// @ts-expect-error plain JS modules, no declarations
import { computeDegreeCentrality, layoutOrbit } from '../../explorer/engine/layout.js';
// @ts-expect-error plain JS modules, no declarations
import * as nodePanel from '../../explorer/pieces/node-panel.js';
// @ts-expect-error plain JS modules, no declarations
import * as proposalPiece from '../../explorer/pieces/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import * as changesPiece from '../../explorer/pieces/changes.js';
// @ts-expect-error plain JS modules, no declarations
import * as decisionPiece from '../../explorer/pieces/decision.js';
// @ts-expect-error plain JS modules, no declarations
import { markedEdgeAt, showEdge } from '../../explorer/engine/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { keepAddress, openFromAddress } from '../../explorer/page-address.js';
// @ts-expect-error plain JS modules, no declarations
import { HOLD_MS } from '../../explorer/decision-model.js';

const sample = loadSample();
const SIZE = { width: 800, height: 600 };
const res = (status, data, headers = {}) => ({ ok: status < 400, status, redirected: false, headers: new Headers(headers), json: async () => data });
const facts = (head = 'a'.repeat(40)) => ({ pull: { number: 21, draft: false, head }, checks: { total: 1, passed: 1, running: 0, failed: [] }, lands: false, landing: null, run: null });

let root;
let inst;
let map;
let calls;
let parent;

/** An instance over a root of its own, the sample map laid out, a stub renderer, and a fetch that records what it was asked */
function make(options = {}) {
  root = document.createElement('div');
  root.innerHTML = '<div class="hx-stage"><canvas id="graph-canvas"></canvas><canvas id="label-canvas"></canvas><div id="sheet-dock" class="hx-dock"></div></div>';
  document.body.append(root);
  inst = createInstance({ root, ...options });
  const canvas = inst.el('graph-canvas');
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: SIZE.width });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: SIZE.height });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: SIZE.width, bottom: SIZE.height, width: SIZE.width, height: SIZE.height, x: 0, y: 0, toJSON() {} });
  const nodes = structuredClone(sample.nodes);
  const edges = structuredClone(sample.edges);
  Object.assign(inst.state, { canvas, ctx: { save() {}, restore() {}, font: '', measureText: (s) => ({ width: String(s).length * 6 }) }, nodes, edges, baseNodes: nodes.map((n) => ({ ...n })), baseEdges: edges });
  map = createMap(inst);
  map.setRenderer({ kind: 'stub', draw() {}, resize() {}, destroy() {} });
  computeDegreeCentrality(inst);
  layoutOrbit(inst);
  map.resize();
  map.fitGraphToViewport(40);
  parent = nodes.find((n) => n.type === 'app').id;
  return inst;
}

const proposal = () => ({
  version: 1, spec: '0099', title: 'A new page', summary: 'Adds /new.',
  nodes: { add: [{ id: 'page-new', label: '/new', type: 'page', parent }] },
  edges: { add: [{ from: 'page-new', to: parent, kind: 'calls', label: 'asks' }] },
  scenarios: [{ id: 's1', title: 'Opening it', stepMs: 1000, steps: [{ node: 'page-new', text: 'It opens.' }] }],
});

/** A fetch for the routes the pieces read; `over` replaces an answer by path prefix */
function server(over = {}) {
  calls = [];
  const mock = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url: String(url), init });
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    for (const [prefix, answer] of Object.entries(over)) if (path.startsWith(prefix)) return typeof answer === 'function' ? answer(method, init) : answer;
    if (path.startsWith('/proposals/0099-new.json')) return res(200, proposal(), { 'X-Proposal-Source': 'pull%2F21', 'X-Proposal-Sha256': 'c'.repeat(64) });
    if (path.includes('/decision')) return res(200, facts());
    if (path.includes('/review')) return method === 'PUT' ? res(200, { verdict: 'approved', at: new Date().toISOString(), by: 'maintainer-one' }) : res(404, { error: 'No review yet' });
    if (path.startsWith('/api/forge/pulls/')) return res(200, { pull: { number: 21, state: 'open', head: { sha: 'a'.repeat(40) } }, checks: [] });
    return res(404, { error: 'no' });
  });
  return mock;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
});
afterEach(() => {
  inst.destroy();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mountAll = () => ({ bar: proposalPiece.mount(root, inst), column: changesPiece.mount(root, inst), decision: decisionPiece.mount(root, inst) });

describe('opening a proposal on an instance', () => {
  it('by name fetches it through the instance: a base address applies, and the maintainer\'s session goes with it', async () => {
    const fetch = server();
    make({ base: 'https://map.example.test', fetch });
    const { bar } = mountAll();
    const said = [];
    inst.on('proposal', (d) => said.push(d.change));
    await bar.update({ proposal: '0099-new', source: 'pull/21' });
    const open = calls.find((c) => c.url.includes('0099-new.json'));
    expect(open.url).toBe('https://map.example.test/proposals/0099-new.json?source=pull%2F21');
    expect(open.init).toMatchObject({ credentials: 'include', cache: 'no-store' });
    // every read the decision and the bar make goes to the same base, with credentials
    await vi.advanceTimersByTimeAsync(0);
    for (const c of calls) { expect(c.url.startsWith('https://map.example.test/'), c.url).toBe(true); expect(c.init.credentials, c.url).toBe('include'); }
    expect(calls.some((c) => c.url.includes('/decision'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/api/forge/pulls/21'))).toBe(true);
    expect(inst.state.proposal.title).toBe('A new page');
    expect(inst.state.proposalSha256).toBe('c'.repeat(64));
    expect(said).toEqual(['opened']);
  });

  it('on the page\'s own origin the requests are the plain paths, as they always were', async () => {
    make({ fetch: server() });
    const { bar } = mountAll();
    await bar.update({ proposal: '0099-new', source: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /proposals/0099-new.json',
      'GET /api/forge/pulls/21',
      'GET /proposals/0099-new/review?source=pull%2F21',
      'GET /proposals/0099-new/decision?source=pull%2F21',
    ]);
    for (const c of calls) expect(c.init.credentials, c.url).toBeUndefined();
  });

  it('by object needs no fetch for the proposal, and an update to null closes it, each said as an event', async () => {
    make({ fetch: server() });
    const { bar } = mountAll();
    const said = [];
    inst.on('proposal', (d) => said.push([d.change, d.slug, d.source, d.view]));
    bar.update({ proposal: proposal(), slug: '0099-new', source: 'pull/21' });
    expect(calls.some((c) => c.url.includes('0099-new.json'))).toBe(false);
    expect(inst.state.proposalSlug).toBe('0099-new');
    expect(root.querySelector('#proposal-title').textContent).toBe('A new page');
    expect(root.querySelector('#proposal-bar').hidden).toBe(false);
    bar.update({ view: 'after' });
    expect(inst.state.proposalView).toBe('after');
    bar.update({ proposal: null });
    expect(inst.state.proposal).toBeNull();
    expect(root.querySelector('#proposal-bar').hidden).toBe(true);
    expect(said).toEqual([['opened', '0099-new', 'pull/21', 'diff'], ['view', '0099-new', 'pull/21', 'after'], ['closed', null, null, 'after']]);
  });

  it('asks the what-if editor and the others by event, not by a hook they overwrite: the effective proposal, the mark, the question before closing', () => {
    make({ fetch: server() });
    const { bar } = mountAll();
    const seen = [];
    inst.on('proposal:effective', (p) => { seen.push('effective'); return { ...p, title: 'Edited' }; });
    inst.on('proposal:mark', ({ applied }) => { seen.push(`mark:${applied.nodes.length > 0}`); });
    bar.update({ proposal: proposal(), slug: '0099-new', source: 'pull/21' });
    expect(seen).toContain('effective');
    expect(seen).toContain('mark:true');
    expect(inst.state.effectiveProposal.title).toBe('Edited');
    expect(inst.state.proposal.title).toBe('A new page'); // the robot's own stays
    const keep = inst.on('proposal:before-close', () => false);
    bar.update({ proposal: null });
    expect(inst.state.proposal).not.toBeNull(); // someone asked to keep it open
    keep();
    bar.update({ proposal: null });
    expect(inst.state.proposal).toBeNull();
  });

  it('a missing proposal is one line in the bar with its ways on, and nothing is opened', async () => {
    make({ fetch: server() });
    const { bar } = mountAll();
    const ok = await bar.update({ proposal: 'nope', source: null });
    expect(ok).toBe(false);
    expect(inst.state.proposal).toBeFalsy();
    expect(root.querySelector('#proposal-message').textContent).toMatch(/nope/);
    expect(root.querySelector('#proposal-bar').hidden).toBe(false);
    expect(root.querySelectorAll('#proposal-ways [data-action="proposal-way"]').length).toBeGreaterThan(0);
  });
});

describe('the decision says what happened, and navigates nothing', () => {
  const open = async (opts = {}) => {
    make({ fetch: server(opts) });
    const pieces = mountAll();
    pieces.bar.update({ proposal: proposal(), slug: '0099-new', source: 'pull/21', sha256: 'c'.repeat(64) });
    await vi.advanceTimersByTimeAsync(0);
    return pieces;
  };
  const approve = () => root.querySelector('[data-review="approved"]');

  it('announces the outcome as an event, after the server answered, with what it said', async () => {
    await open();
    const heard = [];
    inst.on('decision', (d) => heard.push(d));
    approve().click();
    await vi.advanceTimersByTimeAsync(HOLD_MS - 100);
    expect(heard).toEqual([]); // the hold is not an answer
    await vi.advanceTimersByTimeAsync(300);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ outcome: 'approved', slug: '0099-new', source: 'pull/21', review: { verdict: 'approved', by: 'maintainer-one' } });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.url).toBe('/proposals/0099-new/review?source=pull%2F21');
    expect(JSON.parse(put.init.body)).toMatchObject({ verdict: 'approved', sha256: 'c'.repeat(64), headSha: 'a'.repeat(40) });
  });

  it('a send back says so too, and asks the editor to drop the edits that went with the note', async () => {
    await open();
    const heard = [];
    inst.on('decision', (d) => heard.push(d.outcome));
    const cleared = vi.fn();
    inst.on('whatif:clear', cleared);
    root.querySelector('[data-review="notes"]').click();
    const note = root.querySelector('#review-note');
    note.value = 'Name the provider.';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('[data-review="notes"]').click();
    await vi.advanceTimersByTimeAsync(HOLD_MS + 300);
    expect(heard).toEqual(['notes']);
    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it('says nothing of a refusal as an outcome, and asks for a sign-in on a refused read (401 and 403) and on a refused press', async () => {
    await open({ '/proposals/0099-new/decision': res(401, { error: 'Sign in' }), '/proposals/0099-new/review': (method) => (method === 'PUT' ? res(403, { error: 'No' }) : res(403, { error: 'No' })) });
    const heard = [];
    inst.on('decision', (d) => heard.push(['decision', d.outcome]));
    inst.on('auth', (d) => heard.push(['auth', d.status, d.during]));
    // the reads at opening were refused already: a fresh read is refused the same way
    inst.state.proposalSlug = '0099-new';
    await decisionPieceReads();
    expect(heard).toContainEqual(['auth', 401, 'facts']);
    expect(heard).toContainEqual(['auth', 403, 'review']);
    expect(heard.some(([k]) => k === 'decision')).toBe(false);
  });

  /** Opens the proposal again, so the reads are asked and refused while a listener is there */
  async function decisionPieceReads() {
    const heardBefore = calls.length;
    inst.state.proposalSlug = null;
    inst.state.proposal = null;
    inst.emit('proposal:bar', { open: false });
    inst.state.proposal = proposal();
    inst.state.proposalSlug = '0099-new';
    inst.emit('proposal:bar', { open: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBeGreaterThan(heardBefore);
  }

  it('a 401 at the press is said in the foot and as an auth event; the page is not navigated', async () => {
    await open({ '/proposals/0099-new/review': (method) => (method === 'PUT' ? res(401, { error: 'Sign in' }) : res(404, { error: 'none' })) });
    const heard = [];
    inst.on('auth', (d) => heard.push([d.status, d.during]));
    const href = window.location.href;
    approve().click();
    await vi.advanceTimersByTimeAsync(HOLD_MS + 300);
    expect(heard).toContainEqual([401, 'send']);
    expect(root.querySelector('[data-review-msg]').hidden).toBe(false);
    expect(window.location.href).toBe(href);
  });

  it('a stale version is refused by the server and the foot reads the facts again', async () => {
    await open({ '/proposals/0099-new/review': (method) => (method === 'PUT' ? res(409, { error: 'The proposal changed since you read it.' }) : res(404, { error: 'none' })) });
    const heard = [];
    inst.on('decision', () => heard.push('decision'));
    const reads = () => calls.filter((c) => c.url.includes('/decision')).length;
    const before = reads();
    approve().click();
    await vi.advanceTimersByTimeAsync(HOLD_MS + 600);
    expect(heard).toEqual([]);
    expect(root.querySelector('[data-review-msg]').textContent).not.toBe('');
    expect(reads()).toBeGreaterThan(before);
  });

  it('works with the what-if editor and the mockups absent: nobody answering is no edits, no open form', async () => {
    await open();
    approve().click();
    await vi.advanceTimersByTimeAsync(HOLD_MS + 300);
    const put = calls.find((c) => c.method === 'PUT');
    expect(JSON.parse(put.init.body).edits).toEqual([]);
  });
});

describe('an edge is the node panel\'s', () => {
  it('node:show-edge fills and opens the panel, makes it reachable, and an edge alone gets no sheet on a phone, as before', () => {
    make({ fetch: server() });
    vi.stubGlobal('matchMedia', (q) => ({ matches: q.includes('767px'), addEventListener() {}, removeEventListener() {} }));
    window.matchMedia = globalThis.matchMedia;
    const panel = nodePanel.mount(root, inst);
    const { bar } = mountAll();
    bar.update({ proposal: proposal(), slug: '0099-new', source: 'pull/21' });
    const edge = inst.state.edges.find((e) => e.from === 'page-new');
    const drawer = root.querySelector('#spec-drawer');
    expect(drawer.inert).toBe(true);
    const sheetBefore = { ...drawer.dataset };
    showEdge(inst, edge);
    expect(inst.state.selectedEdge).toBe(edge);
    expect(inst.state.selectedNode).toBeNull();
    expect(drawer.classList.contains('drawer-open')).toBe(true);
    expect(drawer.inert).toBe(false);
    expect(root.querySelector('#drawer-badge').textContent).toBe('Edge');
    expect(root.querySelector('#drawer-title').textContent).toMatch(/→/);
    expect(root.querySelector('#drawer-backdrop').hidden).toBe(false);
    expect(root.querySelector('#drawer-title').getAttribute('data-corn')).toBe('node-title');
    expect({ ...drawer.dataset }).toEqual(sheetBefore); // the sheet is not shown for an edge-only selection (as on main): nothing about it moved
    // the panel shows the edge by its own markup: the parts are on it
    for (const el of drawer.querySelectorAll('[data-corn]')) expect(el.getAttribute('part'), el.outerHTML.slice(0, 80)).toBe(el.getAttribute('data-corn'));
    // a node chosen after it takes the panel over; closing it makes the panel inert again
    inst.emit('node:close');
    expect(drawer.inert).toBe(true);
    panel.destroy();
    expect(markedEdgeAt).toBeTypeOf('function');
  });
});

describe('the address bar is the page\'s', () => {
  it('writes ?proposal= when the instance says a proposal opened or changed view, and takes it out when it closed; other parameters stay', () => {
    make({ fetch: server() });
    const { bar } = mountAll();
    window.history.replaceState(null, '', '/?x=1&proposal=old');
    const stop = keepAddress(inst);
    bar.update({ proposal: proposal(), slug: '0099-new', source: 'pull/21' });
    expect(window.location.search).toBe('?x=1&proposal=0099-new&source=pull%2F21');
    bar.update({ view: 'after' });
    expect(window.location.search).toBe('?x=1&proposal=0099-new&source=pull%2F21&proposalView=after');
    bar.update({ proposal: null });
    expect(window.location.search).toBe('?x=1');
    stop();
    bar.update({ proposal: proposal(), slug: '0099-new', source: null });
    expect(window.location.search).toBe('?x=1'); // nobody keeps the address now
    window.history.replaceState(null, '', '/');
  });

  it('turns ?proposal=, ?source= and ?proposalView= into the calls a host would make, and says a bad link in words', async () => {
    make({ fetch: server() });
    mountAll();
    const ok = await openFromAddress(inst, '?proposal=0099-new&source=pull/21&proposalView=after');
    expect(ok).toBe(true);
    expect(inst.state.proposalView).toBe('after');
    expect(calls.find((c) => c.url.includes('0099-new.json')).url).toBe('/proposals/0099-new.json?source=pull%2F21');
    inst.state.proposal = null;
    const bad = await openFromAddress(inst, '?proposal=../x');
    expect(bad).toBe(false);
    expect(root.querySelector('#proposal-message').textContent.length).toBeGreaterThan(0);
  });
});

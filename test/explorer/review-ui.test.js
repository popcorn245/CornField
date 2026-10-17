// @vitest-environment happy-dom
/**
 * Approve and send back in a page (TOPO-12): the two buttons and the note under the proposal bar, driven through
 * the page's own markup (explorer/index.html) with a fake hub and API behind `fetch` and a recording canvas. What a
 * click sends, what the bar says afterwards, what happens to the maintainer's edits, and when the pipeline is told.
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
import { initProposals, showProposal, renderBar, proposalRowHtml } from '../../explorer/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { initScenarioUi, clearScenario } from '../../explorer/scenario-ui.js';
// @ts-expect-error plain JS modules, no declarations
import { initWhatIf, resetWhatIfForTests, getEdits } from '../../explorer/whatif.js';
// @ts-expect-error plain JS modules, no declarations
import { initReview, resetReviewForTests, sendReview, TOKEN_KEY } from '../../explorer/review.js';

const page = fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(page) [1].replace(/<script[\s\S]*?<\/script>/g, '');

const node = (id        , type        , extra         = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, ...extra });
const base = {
  nodes: [node('root', 'root'), node('app-a', 'app', { label: 'tasks' }), node('page-old', 'page', { label: '/old' }), node('table-t', 'table', { label: 'meals' })],
  edges: [{ from: 'root', to: 'app-a' }, { from: 'app-a', to: 'page-old' }, { from: 'page-old', to: 'table-t', kind: 'reads', keys: ['a'], status: 'live', label: 'renders rows' }],
};
const robot = (extra         = {}) => ({
  version: 1, spec: '0013', title: 'Meals', summary: 'Adds /meals.',
  nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }] },
  edges: { add: [{ from: 'page-meals', to: 'table-t', kind: 'writes', label: 'meals.add' }] },
  ...extra,
});

const T0 = Date.parse('2026-10-06T12:00:00.000Z');
let clock = T0;


/** A fake hub and API: what the review routes hold, what the board says, and a record of every call */
function fakeServer(opts                                                                                                                                             = {}) {
  const calls         = [];
  let review      = opts.review ?? null;
  const json = (status        , data         ) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });
  const mock = vi.fn(async (url        , init              = {}) => {
    const method = init.method || 'GET';
    const headers = (init.headers || {})                          ;
    const parsed = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, headers, body: parsed });
    const u = new URL(url, 'http://localhost');
    if (u.pathname === '/proposals' && method === 'GET') {
      const entry = (slug        , source        , r     ) => ({ slug, source, title: slug, summary: '', spec: '0013', counts: null, errors: 0, review: r ? { verdict: r.verdict, at: r.at } : null });
      return json(200, [entry('0013-meals', 'topo-09', review), entry('0013-meals', 'checkout', review), entry('0013-meals', 'worktree-x', null), entry('0014-other', 'checkout', null)]);
    }
    if (u.pathname === '/proposals/0013-meals/review') {
      if (opts.putStatus && opts.putStatus >= 400) return json(opts.putStatus, { error: opts.putError || 'Nope' });
      review = { version: 1, ...parsed, at: new Date(clock).toISOString() };
      return json(200, review);
    }
    if (u.pathname === '/api/v1/pipeline' && method === 'GET') {
      if (opts.board === 'down') throw new TypeError('Failed to fetch');
      return opts.board === null ? json(401, { ok: false, error: 'Sign in' }) : json(200, { ok: true, data: opts.board ?? { specs: [] } });
    }
    if (/^\/api\/v1\/pipeline\/specs\/\d+\/(approve|notes)$/.test(u.pathname) && method === 'POST') {
      return opts.postStatus && opts.postStatus >= 400 ? json(opts.postStatus, { ok: false, error: opts.postError || 'Only the maintainer can do that' }) : json(200, { ok: true, data: { state: {} } });
    }
    return json(404, { error: 'unexpected' });
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock, puts: () => calls.filter((c) => c.method === 'PUT'), api: () => calls.filter((c) => c.url.startsWith('/api/')) };
}

const $ = (id        ) => document.getElementById(id)               ;
const q = (sel        ) => document.querySelector(sel)               ;
const click = (el         ) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const approveBtn = () => q('#review [data-review="approved"]')                     ;
const sendBackBtn = () => q('#review [data-review="notes"]')                     ;
const noteBox = () => $('review-note')                       ;
const status = () => q('#review [data-review-status]').textContent ;
const msg = () => q('#review [data-review-msg]');
const hint = () => q('#review [data-review-hint]');
const pipelineLine = () => q('#review [data-review-pipeline]');
const typeNote = (text        ) => { noteBox().value = text; noteBox().dispatchEvent(new Event('input', { bubbles: true })); };
const tool = (name        ) => q(`#whatif [data-whatif="${name}"]`)                     ;

/** Adds a node through the what-if form, so there is an edit to send */
function addNode(label        ) {
  click(tool('add-node'));
  const form = q('[data-form="node"]')                   ;
  const set = (name        , value        ) => { (form.elements.namedItem(name)                    ).value = value; };
  set('nodeType', 'page');
  set('label', label);
  set('parent', 'app-a');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

async function mount() {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  resetWhatIfForTests();
  resetReviewForTests(() => clock);
  document.body.innerHTML = body;
  localStorage.clear();
  const ctx      = new Proxy({}, { get: (_t, k        ) => (k === 'measureText' ? (t        ) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas      = document.getElementById('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  state.canvas = canvas;
  state.ctx = ctx;
  state.proposal = null;
  state.effectiveProposal = null;
  state.proposalSlug = null;
  state.proposalSource = null;
  state.proposalView = 'diff';
  state.proposalErrors = [];
  state.view = 'orbit';
  state.selectedNode = null;
  state.selectedEdge = null;
  state.scenario = null;
  state.baseNodes = base.nodes.map((n) => ({ ...n }));
  state.baseEdges = base.edges;
  render.resize();
  setMap(state.baseNodes.map((n     ) => ({ ...n })), state.baseEdges);
  history.replaceState(null, '', '/');
  initScenarioUi();
  clearScenario();
  await initProposals();
  initWhatIf();
  initReview();
}

const open = (proposal         = robot(), slug                = '0013-meals', source                = 'checkout') => showProposal(proposal, { slug, source, view: 'diff', fit: true });

let alerts                          ;
beforeEach(async () => {
  clock = T0;
  alerts = vi.fn();
  vi.stubGlobal('alert', alerts);
  vi.stubGlobal('confirm', alerts);
  vi.stubGlobal('prompt', alerts);
  fakeServer();
  await mount();
});
afterEach(() => {
  resetReviewForTests();
  clearScenario();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('the buttons', () => {
  it('are on the proposal bar, under the edit controls, in plain words, and not there with no proposal', () => {
    expect($('review').hidden).toBe(true);
    open();
    expect($('review').hidden).toBe(false);
    expect($('review').closest('#proposal-body')).not.toBeNull();
    expect($('whatif').compareDocumentPosition($('review')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(approveBtn().textContent .trim()).toBe('Approve');
    expect(sendBackBtn().textContent .trim()).toBe('Send back');
    expect(q('label[for="review-note"]').textContent).toMatch(/note/i);
    expect(status()).toBe('');
  });

  it('go away with the proposal, and a proposal with no name from the hub cannot be reviewed', () => {
    open();
    showProposal(robot(), { slug: null, source: null });
    expect($('review').hidden).toBe(true);
    open();
    expect($('review').hidden).toBe(false);
    (q('[data-action="close-proposal"]')               ).click();
    expect($('review').hidden).toBe(true);
  });
});

describe('Send back', () => {
  it('needs a note: an empty one is refused on the bar, nothing is sent, and no dialog opens', async () => {
    const s = fakeServer();
    open();
    await settle();
    s.calls.length = 0;
    click(sendBackBtn());
    await settle();
    expect(msg().hidden).toBe(false);
    expect(msg().textContent).toMatch(/what should change/i);
    expect(s.calls).toEqual([]);
    expect(alerts).not.toHaveBeenCalled();
    typeNote('   \n ');
    click(sendBackBtn());
    await settle();
    expect(msg().hidden).toBe(false);
    expect(s.puts()).toEqual([]);
  });

  it('clears the refusal when the maintainer starts typing', async () => {
    open();
    click(sendBackBtn());
    await settle();
    expect(msg().hidden).toBe(false);
    typeNote('Smaller.');
    expect(msg().hidden).toBe(true);
  });

  it('sends the verdict, the note and the edits to the hub, shows "Sent back just now", and empties the edits', async () => {
    const s = fakeServer();
    open();
    await settle();
    addNode('/extra');
    const sent = getEdits();
    expect(sent).toHaveLength(1);
    typeNote('  Drop the cache.  ');
    click(sendBackBtn());
    await settle();
    expect(s.puts()).toHaveLength(1);
    const put = s.puts()[0];
    expect(put.url).toBe('/proposals/0013-meals/review?source=checkout');
    expect(put.headers['Content-Type']).toBe('application/json');
    expect(put.body).toEqual({ verdict: 'notes', note: 'Drop the cache.', edits: sent });
    expect(status()).toBe('Sent back just now');
    expect(getEdits()).toEqual([]); // they went with the note
    expect(noteBox().value).toBe('');
    expect(msg().hidden).toBe(true);
    expect(hint().textContent).toMatch(/1 edit/);
    expect(hint().textContent).toMatch(/drafting agent/);
    expect(alerts).not.toHaveBeenCalled();
  });

  it('sends with no edits as an empty list', async () => {
    const s = fakeServer();
    open();
    typeNote('Smaller.');
    click(sendBackBtn());
    await settle();
    expect(s.puts()[0].body).toEqual({ verdict: 'notes', note: 'Smaller.', edits: [] });
    expect(hint().hidden).toBe(true);
  });
});

describe('Approve', () => {
  it('takes no note, sends the edits, shows "Approved just now", and keeps the edits with a word about the drafting agent', async () => {
    const s = fakeServer();
    open();
    await settle();
    addNode('/extra');
    addNode('/more');
    click(approveBtn());
    await settle();
    expect(s.puts()[0].body).toEqual({ verdict: 'approved', note: '', edits: getEdits() });
    expect(s.puts()[0].body.edits).toHaveLength(2);
    expect(status()).toBe('Approved just now');
    expect(getEdits()).toHaveLength(2); // they are in the file now; the list stays
    expect(hint().hidden).toBe(false);
    expect(hint().textContent).toBe('Your 2 edits are in the review file. The drafting agent will fold them into the proposal.');
  });

  it('takes a note when there is one', async () => {
    const s = fakeServer();
    open();
    typeNote('Looks right to me.');
    click(approveBtn());
    await settle();
    expect(s.puts()[0].body).toMatchObject({ verdict: 'approved', note: 'Looks right to me.' });
  });

  it('says nothing about edits when there are none', async () => {
    fakeServer();
    open();
    click(approveBtn());
    await settle();
    expect(status()).toBe('Approved just now');
    expect(hint().hidden).toBe(true);
  });
});

describe('the time', () => {
  it('shows the last review when the proposal opens, from the hub, as how long ago', async () => {
    fakeServer({ review: { version: 1, verdict: 'approved', note: '', edits: [], at: new Date(T0 - 3 * 60_000).toISOString() } });
    open();
    await settle();
    expect(status()).toBe('Approved 3 minutes ago');
    clock = T0 + 2 * 3600_000;
    renderBar(); // the bar is drawn again (an edit, a view change): the words move on
    expect(status()).toBe('Approved 2 hours ago');
  });

  it('shows nothing when there is no review yet, or the hub has no answer', async () => {
    fakeServer({ review: null });
    open();
    await settle();
    expect(status()).toBe('');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    open(robot(), '0013-meals', 'worktree-x');
    await settle();
    expect(status()).toBe('');
  });

  it('reads it from the hub listing, for the source the proposal is open from', async () => {
    const s = fakeServer({ review: { version: 1, verdict: 'approved', at: new Date(T0 - 60_000).toISOString() } });
    open(robot(), '0013-meals', 'topo-09');
    await settle();
    expect(s.calls[0].url).toBe('/proposals');
    expect(status()).toBe('Approved 1 minute ago');
    open(robot(), '0013-meals', 'worktree-x'); // the listing says this copy has none
    await settle();
    expect(status()).toBe('');
  });

  it('does not carry one proposal\'s review, note or messages to another', async () => {
    fakeServer({ review: { version: 1, verdict: 'notes', at: new Date(T0).toISOString() } });
    open();
    await settle();
    typeNote('half a thought');
    click(sendBackBtn());
    expect(status()).not.toBe('');
    fakeServer({ review: null });
    showProposal(robot(), { slug: '0014-other', source: 'checkout', view: 'diff' });
    await settle();
    expect(status()).toBe('');
    expect(noteBox().value).toBe('');
    expect(msg().hidden).toBe(true);
  });

  it('is in the picker too: the listing\'s review beside the counts', () => {
    const entry = { slug: '0013-meals', title: 'Meals', summary: '', spec: '0013', source: 'checkout', counts: { added: 1, changed: 0, removed: 0, scenarios: 0 }, errors: 0, review: { verdict: 'notes', at: new Date(Date.now() - 5 * 60_000).toISOString() } };
    expect(proposalRowHtml(entry, null)).toContain('Sent back 5 minutes ago');
    expect(proposalRowHtml({ ...entry, review: null }, null)).not.toMatch(/Approved|Sent back/);
  });
});

describe('when the server says no', () => {
  it('shows why on the bar, keeps the note and the edits, lets the maintainer try again, and opens no dialog', async () => {
    const s = fakeServer({ putStatus: 403, putError: 'A review is only taken from the hub\'s own page' });
    open();
    await settle();
    addNode('/extra');
    typeNote('Smaller.');
    click(sendBackBtn());
    await settle();
    expect(msg().hidden).toBe(false);
    expect(msg().textContent).toContain('The review was not saved.');
    expect(msg().textContent).toContain('only taken from the hub');
    expect(status()).toBe('');
    expect(noteBox().value).toBe('Smaller.');
    expect(getEdits()).toHaveLength(1);
    expect(sendBackBtn().disabled).toBe(false);
    expect(approveBtn().disabled).toBe(false);
    expect(s.api()).toEqual([]); // the pipeline is not told of a review that was not written
    expect(alerts).not.toHaveBeenCalled();
  });

  it('says so when the hub cannot be reached', async () => {
    open();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    click(approveBtn());
    await settle();
    expect(msg().textContent).toMatch(/not saved.*Failed to fetch/);
    expect(approveBtn().disabled).toBe(false);
  });

  it('answers with the status when the hub says nothing more', async () => {
    open();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, headers: new Headers(), json: async () => { throw new Error('no body'); } })));
    click(approveBtn());
    await settle();
    expect(msg().textContent).toContain('The server answered 500.');
  });

  it('holds the buttons while it is being saved, so a double click sends one review', async () => {
    const s = fakeServer();
    open();
    click(approveBtn());
    expect(approveBtn().disabled).toBe(true);
    expect(sendBackBtn().disabled).toBe(true);
    click(approveBtn());
    await settle();
    expect(s.puts()).toHaveLength(1);
    expect(approveBtn().disabled).toBe(false);
  });
});

describe('sendReview', () => {
  it('does nothing with no proposal open', async () => {
    const s = fakeServer();
    expect(await sendReview('approved')).toBe(false);
    expect(s.calls).toEqual([]);
  });
});

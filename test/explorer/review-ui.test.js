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
// @ts-expect-error plain JS modules, no declarations
import { HOLD_MS } from '../../explorer/decision-model.js';
import { explorerPage } from '../helpers.js';

const page = explorerPage({ pieces: ['map'] });
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
    if (u.pathname === '/proposals/0013-meals/review') {
      if (method === 'GET' && opts.reviewGet) return json(opts.reviewGet, { error: 'The forge did not answer.' });
      if (method === 'GET') return review ? json(200, review) : json(404, { error: 'No review yet' });
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
  return { calls, mock, puts: () => calls.filter((c) => c.method === 'PUT'), api: () => calls.filter((c) => c.url.startsWith('/api/v1/')) };
}

const $ = (id        ) => document.getElementById(id)               ;
const q = (sel        ) => document.querySelector(sel)               ;
const click = (el         ) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
// Timers are the test's (the hold is HOLD_MS long): `settle` lets what is waiting run; `send` presses, and waits the hold out
const settle = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0); };
const send = async (btn         ) => { click(btn); await vi.advanceTimersByTimeAsync(HOLD_MS); await settle(); };
const approveBtn = () => q('#review-decision [data-review="approved"]')                     ;
const sendBackBtn = () => q('#review-decision [data-review="notes"]')                     ;
const noteBox = () => $('review-note')                       ;
const status = () => q('#review [data-review-status]').textContent ;
const msg = () => q('#review [data-review-msg]');
const hint = () => q('#review [data-review-hint]');
const pipelineLine = () => q('#review [data-review-pipeline]');
const noteOpen = () => !q('#review [data-review-form]').hidden;
const typeNote = (text        ) => { if (!noteOpen()) click(sendBackBtn()); noteBox().value = text; noteBox().dispatchEvent(new Event('input', { bubbles: true })); };
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

const open = (proposal         = robot(), slug                = '0013-meals', source                = 'pull/23') => showProposal(proposal, { slug, source, view: 'diff', fit: true });

let alerts                          ;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
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
  vi.useRealTimers();
  clearScenario();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('the buttons', () => {
  it('are the review column\'s foot (the decision), in plain words, with the note just before them, and not there with no proposal', () => {
    expect($('review').hidden).toBe(true);
    open();
    expect($('review').hidden).toBe(false);
    expect($('review').closest('#review-decision')).not.toBeNull();
    // in the decision, just before Send back: Tab goes from the note to Cancel, then to "Send back with this note"
    expect($('review').nextElementSibling).toBe(q('.hx-proposal-actions'));
    expect($('review').compareDocumentPosition(sendBackBtn()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect($('review-decision').contains(approveBtn())).toBe(true);
    expect($('review-decision').contains(sendBackBtn())).toBe(true);
    expect(q('.hx-proposal-head').contains(approveBtn())).toBe(false);
    expect(noteOpen()).toBe(false); // the note opens only when Send back is pressed
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

describe('a draft that is not on a PR', () => {
  it('has the buttons and the note off, says to push it as a spec PR, sends nothing, and asks the server for no review', async () => {
    const s = fakeServer();
    for (const source of ['checkout', 'topo-09']) {
      open(robot(), '0013-meals', source);
      await settle();
      expect($('review').hidden).toBe(false);
      // both buttons are refused but stay focusable (aria-disabled), and the reason is the line, which each points at (spec 0007 D1)
      expect(approveBtn().getAttribute('aria-disabled')).toBe('true');
      expect(sendBackBtn().getAttribute('aria-disabled')).toBe('true');
      expect(noteBox().disabled).toBe(true);
      expect(q('#review-line').textContent).toBe(source === 'checkout' ? 'Draft in the checkout: push it as a spec PR to review it here.' : `Draft in worktree ${source}: push it as a spec PR to review it here.`);
      expect(approveBtn().getAttribute('aria-describedby')).toBe('review-line');
      expect(sendBackBtn().getAttribute('aria-describedby')).toBe('review-line');
      click(approveBtn());
      expect(await sendReview('approved')).toBe(false);
    }
    expect(s.calls).toEqual([]);
  });

  it('turns them on again for a proposal that is on a PR', async () => {
    fakeServer();
    open(robot(), '0013-meals', 'checkout');
    open(robot(), '0013-meals', 'pull/23');
    await settle();
    expect(approveBtn().getAttribute('aria-disabled')).toBeNull();
    expect(noteBox().disabled).toBe(false);
    expect(hint().hidden).toBe(true);
  });
});

describe('Send back', () => {
  it('needs a note: an empty one is refused on the bar, nothing is sent, and no dialog opens', async () => {
    const s = fakeServer();
    open();
    await settle();
    s.calls.length = 0;
    click(sendBackBtn()); // the first press opens the note
    expect(noteOpen()).toBe(true);
    expect(sendBackBtn().textContent.trim()).toBe('Send back with this note');
    expect(document.activeElement).toBe(noteBox());
    expect(msg().hidden).toBe(true);
    await send(sendBackBtn());
    expect(msg().hidden).toBe(false);
    expect(msg().textContent).toMatch(/what should change/i);
    expect(s.calls).toEqual([]);
    expect(alerts).not.toHaveBeenCalled();
    typeNote('   \n ');
    await send(sendBackBtn());
    expect(msg().hidden).toBe(false);
    expect(s.puts()).toEqual([]);
  });

  it('clears the refusal when the maintainer starts typing', async () => {
    open();
    click(sendBackBtn());
    await send(sendBackBtn());
    expect(msg().hidden).toBe(false);
    typeNote('Smaller.');
    expect(msg().hidden).toBe(true);
  });

  it('opens a note that Cancel closes, with focus back on Send back and what was typed gone', async () => {
    const s = fakeServer();
    open();
    await settle();
    s.calls.length = 0;
    click(sendBackBtn());
    typeNote('Not now.');
    click(q('#review [data-review-cancel]'));
    expect(noteOpen()).toBe(false);
    expect(sendBackBtn().textContent.trim()).toBe('Send back');
    expect(sendBackBtn().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(sendBackBtn());
    expect(noteBox().value).toBe('');
    expect(s.calls).toEqual([]);
  });

  it('sends the verdict, the note and the edits to the hub, shows "Sent back just now", and empties the edits', async () => {
    const s = fakeServer();
    open();
    await settle();
    addNode('/extra');
    const sent = getEdits();
    expect(sent).toHaveLength(1);
    typeNote('  Drop the cache.  ');
    await send(sendBackBtn());
    expect(s.puts()).toHaveLength(1);
    const put = s.puts()[0];
    expect(put.url).toBe('/proposals/0013-meals/review?source=pull%2F23');
    expect(put.headers['Content-Type']).toBe('application/json');
    expect(put.body).toEqual({ verdict: 'notes', note: 'Drop the cache.', edits: sent });
    expect(status()).toBe('Sent back just now');
    expect(getEdits()).toEqual([]); // they went with the note
    expect(noteBox().value).toBe('');
    expect(noteOpen()).toBe(false);
    expect(document.activeElement).toBe(sendBackBtn());
    expect(msg().hidden).toBe(true);
    // the edits went with the note and stay readable, read-only (spec 0007 D4)
    expect(hint().hidden).toBe(true);
    expect(q('#review [data-review-sent-summary]').textContent).toBe('Sent with 1 edit');
    expect(q('#review [data-review-sent]').hidden).toBe(false);
    expect(q('#review [data-review-sent-list]').children).toHaveLength(1);
    expect(alerts).not.toHaveBeenCalled();
  });

  it('sends with no edits as an empty list', async () => {
    const s = fakeServer();
    open();
    await settle();
    typeNote('Smaller.');
    await send(sendBackBtn());
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
    await send(approveBtn());
    expect(s.puts()[0].body).toEqual({ verdict: 'approved', note: '', edits: getEdits() });
    expect(s.puts()[0].body.edits).toHaveLength(2);
    expect(status()).toBe('Approved just now');
    expect(getEdits()).toHaveLength(2); // they are in the file now; the list stays
    expect(hint().hidden).toBe(false);
    expect(hint().textContent).toBe('Your 2 edits are in the review comment on the PR. The drafting agent will fold them into the proposal.');
  });

  it('takes no note, even with the note field open', async () => {
    const s = fakeServer();
    open();
    await settle();
    typeNote('Looks right to me.');
    await send(approveBtn());
    expect(s.puts()[0].body).toMatchObject({ verdict: 'approved', note: '' });
    expect(noteOpen()).toBe(false);
  });

  it('says nothing about edits when there are none', async () => {
    fakeServer();
    open();
    await settle();
    await send(approveBtn());
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

  it('says the verdict once: the time ticks beside the live region, which is not rewritten while the verdict stays', async () => {
    fakeServer({ review: { version: 1, verdict: 'approved', note: '', edits: [], at: new Date(T0 - 3 * 60_000).toISOString() } });
    open();
    await settle();
    const live = q('#review [data-review-status] [role=status]');
    expect(live.textContent).toBe('Approved');
    expect(q('#review [data-review-status]').getAttribute('role')).toBeNull(); // the line itself is not live: its time is not said again
    const mo = new MutationObserver(() => {});
    mo.observe(live, { subtree: true, childList: true, characterData: true });
    for (const later of [1, 2, 60]) { clock = T0 + later * 60_000; renderBar(); }
    expect(status()).toBe('Approved 1 hour ago');
    expect(mo.takeRecords()).toHaveLength(0);
    mo.disconnect();
  });

  it('shows nothing when there is no review yet, or the hub has no answer', async () => {
    fakeServer({ review: null });
    open();
    await settle();
    expect(status()).toBe('');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    open(robot(), '0013-meals', 'pull/24');
    await settle();
    expect(status()).toBe('');
  });

  it('reads it from the PR through the hub, for the source the proposal is open from', async () => {
    const s = fakeServer({ review: { version: 1, verdict: 'approved', at: new Date(T0 - 60_000).toISOString() } });
    open(robot(), '0013-meals', 'pull/24');
    await settle();
    expect(s.calls[0].method).toBe('GET');
    expect(s.calls[0].url).toBe('/proposals/0013-meals/review?source=pull%2F24');
    expect(status()).toBe('Approved 1 minute ago');
  });

  it('does not carry one proposal\'s review, note or messages to another', async () => {
    fakeServer({ review: { version: 1, verdict: 'notes', at: new Date(T0).toISOString() } });
    open();
    await settle();
    typeNote('half a thought');
    click(sendBackBtn());
    expect(status()).not.toBe('');
    fakeServer({ review: null });
    showProposal(robot(), { slug: '0014-other', source: 'pull/23', view: 'diff' });
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
    await send(sendBackBtn());
    expect(msg().hidden).toBe(false);
    expect(msg().textContent).toBe('A review is only taken from the hub\'s own page'); // a 403 says the server's own words
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
    await settle();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await send(approveBtn());
    expect(msg().textContent).toBe('cornfield did not answer. Your approval was not sent; what you typed is kept.'); // no answer is said as such, never as the runtime's own words
    expect(approveBtn().disabled).toBe(false);
  });

  it('answers with the status when the hub says nothing more', async () => {
    open();
    await settle();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, headers: new Headers(), json: async () => { throw new Error('no body'); } })));
    await send(approveBtn());
    expect(msg().textContent).toContain('The server answered 500.');
  });

  it('holds the buttons while it is being saved, so a double click sends one review', async () => {
    const s = fakeServer();
    open();
    await settle();
    click(approveBtn());
    expect(approveBtn().getAttribute('aria-disabled')).toBe('true'); // not `disabled`: the pressed button keeps the focus while it posts
    expect(sendBackBtn().getAttribute('aria-disabled')).toBe('true');
    await send(approveBtn());
    expect(s.puts()).toHaveLength(1);
    expect(sendBackBtn().getAttribute('aria-disabled')).toBeNull();
    expect(approveBtn().textContent.trim()).toBe('Approved'); // and an approval that stands is not pressed again (spec 0007 D2)
    expect(approveBtn().getAttribute('aria-disabled')).toBe('true');
  });
});

describe('sendReview', () => {
  it('does nothing with no proposal open', async () => {
    const s = fakeServer();
    expect(await sendReview('approved')).toBe(false);
    expect(s.calls).toEqual([]);
  });
});

describe('a failed read of the past reviews (F04)', () => {
  const failLine = () => q('#review [data-review-loadfail]');
  const APPROVED = { version: 1, verdict: 'approved', note: '', edits: [], at: new Date(T0 - 60 * 60_000).toISOString() };

  it('says so with Retry, and never shows an approved proposal as unreviewed', async () => {
    const s = fakeServer({ review: APPROVED, reviewGet: 500 });
    open();
    await settle();
    expect(failLine().hidden).toBe(false);
    expect(failLine().textContent).toMatch(/^Could not load this proposal's reviews\./);
    expect(failLine().textContent).toMatch(/may already be approved or sent back/);
    expect(q('#review [data-review-retry]').textContent).toBe('Retry');
    expect(status()).toBe(''); // it says nothing of a review it could not read, rather than "no review"
    // Retry asks again; once the read works the line goes and the review shows
    s.mock.mockClear();
    fakeServer({ review: APPROVED });
    q('#review [data-review-retry]').focus();
    click(q('#review [data-review-retry]'));
    await settle();
    expect(failLine().hidden).toBe(true);
    expect(status()).toBe('Approved 1 hour ago');
    // Retry is gone with its line: the focus goes to the proposal's name, never to the page
    expect(document.activeElement).toBe(document.getElementById('proposal-title'));
  });

  it('reads them again when the browser is back online', async () => {
    fakeServer({ review: APPROVED, reviewGet: 500 });
    open();
    await settle();
    expect(failLine().hidden).toBe(false);
    fakeServer({ review: APPROVED });
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(failLine().hidden).toBe(true);
    expect(status()).toBe('Approved 1 hour ago');
  });

  it('says so when the server cannot be reached at all, and not at a 404, which is "no review yet"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    open();
    await settle();
    expect(failLine().hidden).toBe(false);
    fakeServer({ review: null });
    open(robot(), '0013-meals', 'pull/24');
    await settle();
    expect(failLine().hidden).toBe(true); // a 404 is "none yet", not a failure
  });
});

describe('offline (F38)', () => {
  const setOnline = (on         ) => Object.defineProperty(navigator, 'onLine', { value: on, configurable: true });
  afterEach(() => setOnline(true));

  it('keeps the note when Send back gets no answer, says it was not sent and that you are offline, and does not blame the server', async () => {
    open();
    await settle();
    setOnline(false);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    typeNote('Smaller, please.');
    await send(sendBackBtn());
    expect(msg().textContent).toBe('You are offline. Your send back was not sent; what you typed is kept. Try again when you are back.');
    expect(noteBox().value).toBe('Smaller, please.');
    // Approve next: the line is about Approve, not left over from Send back
    await send(approveBtn());
    expect(msg().textContent).toMatch(/^You are offline\. Your approval was not sent/);
  });
});

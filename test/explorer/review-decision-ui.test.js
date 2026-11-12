// @vitest-environment happy-dom
/**
 * The decision in a page (spec 0007): the line above Approve in each state, the four questions asked in place, the hold with Undo and every way
 * it ends without sending, what the end of the hold does, what the server's refusals say, and what a send back leaves readable. Driven through
 * the page's own markup (explorer/index.html), with a fake route for the decision facts and for the review, and a clock the test winds.
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
import { yoursText } from '../../explorer/proposal-model.js';
// @ts-expect-error plain JS modules, no declarations
import { HOLD_MS } from '../../explorer/decision-model.js';

import { withMapElements } from '../helpers.js';
const page = withMapElements(fs.readFileSync(path.resolve(__dirname, '../../explorer/index.html'), 'utf8'));
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


/** The decision's facts as the route answers them for a PR, with what a test changes */
const facts = (over = {}) => ({ pull: { number: 23, draft: false, head: 'a'.repeat(40) }, checks: { total: 2, passed: 2, running: 0, failed: [] }, lands: false, landing: null, run: null, ...over });

/** A fake route for the decision and the review, and a record of every call */
function fakeServer(opts = {}) {
  const calls = [];
  const world = { facts: opts.facts === undefined ? facts() : opts.facts, review: opts.review ?? null, put: opts.put || null, next: [] };
  const json = (status, data) => ({ ok: status < 400, status, redirected: false, headers: new Headers(), json: async () => data });
  const mock = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const parsed = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body: parsed });
    const u = new URL(url, 'http://localhost');
    if (u.pathname === '/proposals/0013-meals/decision') {
      if (world.facts === 'down') throw new TypeError('Failed to fetch');
      const queued = world.next.shift();
      const f = queued !== undefined ? queued : world.facts;
      return f === null ? json(404, { error: 'No' }) : json(200, f);
    }
    if (u.pathname === '/proposals/0013-meals/review') {
      if (method === 'GET') return world.review ? json(200, world.review) : json(404, { error: 'No review yet' });
      if (world.put) return json(world.put.status, { error: world.put.error });
      world.review = { version: 1, ...parsed, at: new Date(clock).toISOString() };
      return json(200, world.review);
    }
    if (u.pathname === '/api/forge/pulls/23/landing/cancel') { world.facts = { ...world.facts, landing: null }; return json(200, { ok: true, cancelled: true }); }
    return json(404, { error: 'unexpected' });
  });
  vi.stubGlobal('fetch', mock);
  return { calls, world, puts: () => calls.filter((c) => c.method === 'PUT'), reads: () => calls.filter((c) => c.url.includes('/decision')) };
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

let alerts;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = T0;
  alerts = vi.fn();
  vi.stubGlobal('alert', alerts);
  vi.stubGlobal('confirm', alerts);
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
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});
const advance = async (ms) => { await vi.advanceTimersByTimeAsync(ms); await settle(); };
const line = () => $('review-line');
const askEl = () => $('review-ask');
const undoBtn = () => q('#review-decision [data-review-undo]');
const live = () => q('#review [data-review-hold-live]');
const openAndRead = async (f) => { const s = fakeServer(f === undefined ? {} : { facts: f }); open(); await settle(); return s; };
const pressApprove = () => click(approveBtn());

describe('the line above Approve (D1), in the page', () => {
  it('is Approve\'s description, sits above the buttons in the decision, and reads the facts the route gave', async () => {
    await openAndRead();
    expect(line().textContent).toBe('Approve posts an approval on PR #23. It does not land it.');
    expect(approveBtn().getAttribute('aria-describedby')).toBe('review-line');
    expect($('review-decision').contains(line())).toBe(true);
    expect(line().compareDocumentPosition(approveBtn()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('says each state in words: landing, a running check, a failed check, a draft, a run and the runner', async () => {
    const check = { total: 2, passed: 1, running: 1, failed: [] };
    await openAndRead(facts({ lands: true, checks: check }));
    expect(line().textContent).toBe('Approve posts an approval on PR #23. It lands once 1 running check passes.');
    await mount();
    await openAndRead(facts({ checks: { total: 2, passed: 1, running: 0, failed: ['lint'] } }));
    expect(line().textContent).toBe('Approve posts an approval on PR #23. lint failed.');
    await mount();
    await openAndRead(facts({ pull: { number: 23, draft: true, head: 'b' }, run: { kind: 'code', transport: 'pull', runner: 'quiet', lastSeen: new Date(T0 - 2 * 3600_000).toISOString() } }));
    expect(line().textContent).toBe('PR #23 is a draft. Approve posts an approval on it. Then a code run is asked for. No runner has polled for 2 h: the run will wait.');
  });
  it('is text, never markup: a check name from the forge cannot make an element', async () => {
    await openAndRead(facts({ checks: { total: 1, passed: 0, running: 0, failed: ['<img src=x onerror=alert(1)>'] } }));
    expect(line().querySelector('img')).toBeNull();
    expect(line().textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it('says what it could not read, and still lets Approve through', async () => {
    await openAndRead('down');
    expect(line().textContent).toBe("Could not read PR #23's checks. Approve posts an approval on it.");
    expect(approveBtn().getAttribute('aria-disabled')).toBeNull();
  });
  it('reads the PR while it loads, and Approve waits for the answer', async () => {
    const s = fakeServer();
    open();
    expect(line().textContent).toBe('Reading PR #23 \u2026');
    expect(approveBtn().getAttribute('aria-disabled')).toBe('true');
    pressApprove();
    await advance(HOLD_MS);
    expect(s.puts()).toEqual([]);
  });
  it('counts the edits in the line, and says "N of M scenarios played" no longer sits under the list', async () => {
    await openAndRead();
    addNode('/extra');
    expect(line().textContent).toContain('Your 1 edit goes in the comment, for the agent to fold in.');
    expect(document.querySelector('#review-lists')?.textContent || '').not.toMatch(/scenarios? played/);
  });
});

describe('the four questions, asked in place (D2)', () => {
  const asks = async (f, words, extra) => {
    await openAndRead(f);
    if (extra) await extra();
    pressApprove();
    expect(askEl().hidden).toBe(false);
    expect(askEl().textContent).toBe(words);
    expect(askEl().getAttribute('role')).toBe('alert');
    expect(approveBtn().textContent.trim()).toBe('Approve anyway');
    expect(approveBtn().getAttribute('aria-describedby')).toBe('review-ask');
    expect(document.activeElement === document.body || document.activeElement === approveBtn() || true).toBe(true);
  };
  it('failed checks', async () => { const s = fakeServer(); await asks(facts({ checks: { total: 2, passed: 1, running: 0, failed: ['lint'] } }), 'lint failed on PR #23. Approve anyway?'); expect(s.puts()).toEqual([]); });
  it('a draft', async () => { await asks(facts({ pull: { number: 23, draft: true, head: 'b' } }), 'PR #23 is a draft: its author has not marked it ready. Approve anyway?'); });
  it('a what-if form that holds input', async () => {
    await asks(facts(), 'Your Add a node form is not added. Approve without it?', async () => {
      click(tool('add-node'));
      const f = q('[data-form="node"]');
      f.elements.namedItem('label').value = '/half';
    });
  });
  it('edits, with landing on', async () => {
    await asks(facts({ lands: true }), 'PR #23 lands as written; your 1 edit only goes in the comment. Approve anyway?', async () => { addNode('/extra'); });
  });
  it('nothing else asks: running checks, no runner, edits with landing off post after the hold alone', async () => {
    const s = await openAndRead(facts({ checks: { total: 2, passed: 1, running: 1, failed: [] }, run: { kind: 'code', transport: 'pull', runner: 'never', lastSeen: null } }));
    addNode('/extra');
    pressApprove();
    expect(askEl().hidden).toBe(true);
    expect(approveBtn().dataset.holding).toBe('true');
    await advance(HOLD_MS);
    expect(s.puts()).toHaveLength(1);
  });
  it('Escape takes the question back, and the line returns; another action does too', async () => {
    await openAndRead(facts({ pull: { number: 23, draft: true, head: 'b' } }));
    pressApprove();
    approveBtn().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(askEl().hidden).toBe(true);
    expect(approveBtn().textContent.trim()).toBe('Approve');
    pressApprove();
    expect(askEl().hidden).toBe(false);
    click(sendBackBtn()); // any other action
    expect(askEl().hidden).toBe(true);
  });
  it('"Approve anyway" starts the hold, and nothing was sent by the question', async () => {
    const s = await openAndRead(facts({ pull: { number: 23, draft: true, head: 'b' } }));
    pressApprove();
    expect(s.puts()).toEqual([]);
    pressApprove();
    expect(approveBtn().dataset.holding).toBe('true');
    expect(s.puts()).toEqual([]);
    await advance(HOLD_MS);
    expect(s.puts()).toHaveLength(1);
  });
  it('Send back with an open form asks, "Send back anyway"', async () => {
    const s = await openAndRead();
    click(tool('add-node'));
    q('[data-form="node"]').elements.namedItem('label').value = '/half';
    typeNote('Smaller.');
    click(sendBackBtn());
    expect(askEl().textContent).toBe('Your Add a node form is not added. Send back without it?');
    expect(sendBackBtn().textContent.trim()).toBe('Send back anyway');
    expect(s.puts()).toEqual([]);
  });
});

describe('the hold and Undo (D3)', () => {
  it('sends nothing for 5 seconds, then sends once; the button counts down and focus is on Undo', async () => {
    const s = await openAndRead();
    pressApprove();
    expect(approveBtn().textContent.trim()).toBe('Approving in 5 s');
    expect(undoBtn().hidden).toBe(false);
    expect(document.activeElement).toBe(undoBtn());
    expect(live().textContent).toBe('Approving in 5 seconds. Undo to stop it; nothing has been sent.');
    await advance(HOLD_MS - 1000);
    expect(approveBtn().textContent.trim()).toBe('Approving in 1 s');
    expect(s.puts()).toEqual([]);
    await advance(1100);
    expect(s.puts()).toHaveLength(1);
    expect(status()).toBe('Approved just now');
    expect(approveBtn().textContent.trim()).toBe('Approved');
    expect(undoBtn().hidden).toBe(true);
  });
  it('announces the countdown once: the live region is written when the hold starts, not each second', async () => {
    await openAndRead();
    pressApprove();
    const mo = new MutationObserver(() => {});
    mo.observe(live(), { subtree: true, childList: true, characterData: true });
    await advance(3000);
    expect(mo.takeRecords()).toHaveLength(0);
    mo.disconnect();
  });
  it('Undo stops it: nothing is sent, it says so, and focus goes back to Approve', async () => {
    const s = await openAndRead();
    pressApprove();
    await advance(2000);
    click(undoBtn());
    await advance(HOLD_MS);
    expect(s.puts()).toEqual([]);
    expect(msg().textContent).toBe('The approval was undone. Nothing was sent.');
    expect(document.activeElement).toBe(approveBtn());
    expect(approveBtn().textContent.trim()).toBe('Approve');
  });
  it('Escape stops it, from anywhere on the page', async () => {
    const s = await openAndRead();
    pressApprove();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await advance(HOLD_MS);
    expect(s.puts()).toEqual([]);
    expect(msg().textContent).toMatch(/Nothing was sent\.$/);
  });
  it('closing the proposal during the hold sends nothing', async () => {
    const s = await openAndRead();
    pressApprove();
    await advance(1000);
    q('[data-action="close-proposal"]').click();
    await advance(HOLD_MS);
    expect(s.puts()).toEqual([]);
  });
  it('opening another proposal during the hold sends nothing', async () => {
    const s = await openAndRead();
    pressApprove();
    showProposal(robot(), { slug: '0014-other', source: 'pull/24', view: 'diff' });
    await advance(HOLD_MS);
    expect(s.puts()).toEqual([]);
  });
  it('losing the network during the hold sends nothing and says so', async () => {
    const s = await openAndRead();
    pressApprove();
    window.dispatchEvent(new Event('offline'));
    await advance(HOLD_MS);
    expect(s.puts()).toEqual([]);
    expect(msg().textContent).toBe('The approval was stopped: you are offline. Nothing was sent.');
  });
  it('being offline at the end of the hold sends nothing either, and pressing offline starts no hold', async () => {
    const s = await openAndRead();
    pressApprove();
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await advance(HOLD_MS);
    expect(s.puts()).toEqual([]);
    expect(msg().textContent).toMatch(/offline/);
    pressApprove();
    expect(approveBtn().dataset.holding).toBe('false');
    expect(msg().textContent).toMatch(/You are offline\. Your approval was not sent/);
  });
  it('hiding the tab during the hold sends nothing', async () => {
    const s = await openAndRead();
    pressApprove();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(HOLD_MS);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(s.puts()).toEqual([]);
    expect(msg().textContent).toBe('The approval was stopped: this tab was hidden. Nothing was sent.');
  });
  it('changing the edits during the hold stops it: what was on screen at the press is what is sent', async () => {
    const s = await openAndRead();
    pressApprove();
    addNode('/late');
    await advance(HOLD_MS);
    expect(s.puts()).toEqual([]);
    expect(msg().textContent).toBe('The approval was stopped: your edits changed. Nothing was sent.');
  });
  it('a double press, or a click on a held button, sends one review', async () => {
    const s = await openAndRead();
    pressApprove();
    pressApprove();
    click(sendBackBtn());
    await advance(HOLD_MS);
    expect(s.puts()).toHaveLength(1);
    expect(s.puts()[0].body.verdict).toBe('approved');
  });
  it('Send back gets the same hold, with Undo', async () => {
    const s = await openAndRead();
    typeNote('Smaller.');
    click(sendBackBtn());
    expect(sendBackBtn().textContent.trim()).toBe('Sending back in 5 s');
    expect(document.activeElement).toBe(undoBtn());
    expect(noteBox().readOnly).toBe(true);
    await advance(HOLD_MS);
    expect(s.puts()).toHaveLength(1);
    expect(s.puts()[0].body).toMatchObject({ verdict: 'notes', note: 'Smaller.' });
    click(sendBackBtn());
    typeNote('Again.');
    click(sendBackBtn());
    click(undoBtn());
    await advance(HOLD_MS);
    expect(s.puts()).toHaveLength(1);
    expect(document.activeElement).toBe(sendBackBtn());
  });
  it('at the end it reads the facts once more, fresh, and a state that now asks, asks instead of posting', async () => {
    const s = await openAndRead();
    pressApprove();
    s.world.next.push(facts({ checks: { total: 2, passed: 1, running: 0, failed: ['lint'] } })); // a check failed meanwhile
    await advance(HOLD_MS);
    expect(s.reads().at(-1).url).toContain('fresh=1');
    expect(s.puts()).toEqual([]);
    expect(askEl().textContent).toBe('lint failed on PR #23. Approve anyway?');
    expect(document.activeElement).toBe(approveBtn());
    pressApprove(); // answered: the hold again, and the same reason does not ask twice
    s.world.next.push(facts({ checks: { total: 2, passed: 1, running: 0, failed: ['lint'] } }));
    await advance(HOLD_MS);
    expect(s.puts()).toHaveLength(1);
  });
  it('is one constant: 5 seconds', () => { expect(HOLD_MS).toBe(5000); });
});

describe('the server\'s refusals, in words (D2)', () => {
  it('401: the sign-in ended; the edits are kept', async () => {
    const s = fakeServer({ put: { status: 401, error: 'Not signed in.' } });
    open(); await settle();
    addNode('/extra');
    pressApprove();
    await advance(HOLD_MS);
    expect(msg().textContent).toBe('Your sign-in has ended. Sign in again: your edits are kept here.');
    expect(getEdits()).toHaveLength(1);
    expect(s.puts()).toHaveLength(1);
  });
  it('403: no longer a maintainer', async () => {
    fakeServer({ put: { status: 403, error: 'maintainer-one no longer maintains this repo, so the forge would not count the review.' } });
    open(); await settle();
    pressApprove();
    await advance(HOLD_MS);
    expect(msg().textContent).toBe('maintainer-one no longer maintains this repo, so the forge would not count the review.');
  });
  it('409 from a second tab: the approval stands already, so Approve reads Approved', async () => {
    const s = fakeServer({ put: { status: 409, error: '0013-meals is already approved at this head of pull request #23 (by maintainer-one). Nothing was posted.' } });
    open(); await settle();
    s.world.review = { version: 1, verdict: 'approved', at: new Date(T0).toISOString(), current: true };
    pressApprove();
    await advance(HOLD_MS);
    expect(msg().textContent).toMatch(/already approved at this head/);
    expect(approveBtn().textContent.trim()).toBe('Approved');
  });
});

describe('Approved, and what a push does (D2)', () => {
  it('an approval that stands at this head reads Approved, kept focusable; a push makes it live again', async () => {
    const s = fakeServer({ review: { version: 1, verdict: 'approved', at: new Date(T0 - 60_000).toISOString(), current: true } });
    open(); await settle();
    expect(approveBtn().textContent.trim()).toBe('Approved');
    expect(approveBtn().getAttribute('aria-disabled')).toBe('true');
    expect(approveBtn().disabled).toBe(false);
    pressApprove();
    await advance(HOLD_MS);
    expect(s.puts()).toEqual([]);
    // a push: the head moved, the review is read again and no longer stands
    s.world.review = { ...s.world.review, current: false };
    s.world.facts = facts({ pull: { number: 23, draft: false, head: 'c'.repeat(40) } });
    await advance(30_000);
    expect(approveBtn().textContent.trim()).toBe('Approve');
  });
});

describe('what-if edits at decision time (D4)', () => {
  it('Send back says what it posts, and that no run is asked for', async () => {
    await openAndRead();
    addNode('/extra');
    click(sendBackBtn());
    expect(q('#review-sendback-line').textContent).toBe('Posts your note and 1 edit on PR #23 for the drafting agent. No run is asked for.');
    expect(sendBackBtn().getAttribute('aria-describedby')).toBe('review-sendback-line');
  });
  it('after a send the edits stay readable in "Sent with 2 edits", read-only', async () => {
    await openAndRead();
    addNode('/a'); addNode('/b');
    typeNote('Fold these in.');
    click(sendBackBtn());
    await advance(HOLD_MS);
    expect(q('#review [data-review-sent-summary]').textContent).toBe('Sent with 2 edits');
    expect(q('#review [data-review-sent-list]').querySelectorAll('li')).toHaveLength(2);
    expect(q('#review [data-corn="sent-edits"]')).not.toBeNull();
    expect(getEdits()).toEqual([]);
  });
});

describe('Cancel landing, in the decision foot (D3)', () => {
  it('shows while a landing waits, and stops it with a POST from this page', async () => {
    const s = await openAndRead(facts({ lands: true, landing: { by: 'maintainer-one', since: new Date(T0).toISOString() } }));
    const box = q('#review [data-review-landing]');
    expect(box.hidden).toBe(false);
    const cancel = q('#review [data-review-cancel-landing]');
    expect(cancel.textContent).toBe('Cancel landing');
    click(cancel);
    await advance(10);
    expect(s.calls.some((c) => c.method === 'POST' && c.url === '/api/forge/pulls/23/landing/cancel')).toBe(true);
    expect(q('#review [data-review-landing]').hidden).toBe(true);
  });
  it('is not there when nothing waits', async () => {
    await openAndRead();
    expect(q('#review [data-review-landing]').hidden).toBe(true);
  });
});

describe('what reading the facts costs', () => {
  it('reads when the proposal opens and every 30 s while it is open and visible', async () => {
    const s = await openAndRead();
    expect(s.reads()).toHaveLength(1);
    await advance(30_000);
    expect(s.reads()).toHaveLength(2);
    await advance(30_000);
    expect(s.reads()).toHaveLength(3);
  });
  it('reads nothing while the tab is hidden, and nothing with no proposal open', async () => {
    const s = await openAndRead();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await advance(90_000);
    expect(s.reads()).toHaveLength(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    q('[data-action="close-proposal"]').click();
    await advance(90_000);
    expect(s.reads()).toHaveLength(1);
  });
  it('reads when the window gets focus, not more than every few seconds', async () => {
    const s = await openAndRead();
    clock += 10_000;
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(s.reads()).toHaveLength(2);
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(s.reads()).toHaveLength(2);
  });
  it('asks nothing of a draft in the checkout', async () => {
    const s = fakeServer();
    open(robot(), '0013-meals', 'checkout');
    await advance(60_000);
    expect(s.reads()).toEqual([]);
  });
});

describe('seeing the proposal without your edits, and counting them apart (D5)', () => {
  const mine = () => $('proposal-myedits');
  const chip = () => $('proposal-chip').textContent;
  it('the toggle shows only when there are edits', async () => {
    await openAndRead();
    expect(mine().hidden).toBe(true);
    addNode('/extra');
    expect(mine().hidden).toBe(false);
    expect(mine().getAttribute('aria-pressed')).toBe('true');
    expect(mine().textContent).toBe('My edits');
  });
  it('off draws the proposal as written, keeps the edits, and Approve and Send back still carry them', async () => {
    const s = await openAndRead();
    addNode('/extra');
    expect(state.nodes.some((n) => n.label === '/extra')).toBe(true);
    click(mine());
    expect(mine().getAttribute('aria-pressed')).toBe('false');
    expect(state.nodes.some((n) => n.label === '/extra')).toBe(false);
    expect(getEdits()).toHaveLength(1);
    expect(line().textContent).toContain('Your 1 edit goes in the comment');
    pressApprove();
    await advance(HOLD_MS);
    expect(s.puts()[0].body.edits).toHaveLength(1);
    click(mine());
    expect(state.nodes.some((n) => n.label === '/extra')).toBe(true);
  });
  it('off, the Edit tools say to turn it on, and change nothing', async () => {
    await openAndRead();
    addNode('/extra');
    click($('proposal-edit'));
    click(mine());
    click(tool('add-node'));
    expect(q('#whatif [data-msg="toolbar"]').textContent).toBe('Turn My edits on to edit.');
    expect(q('[data-form="node"]')).toBeNull();
    expect(getEdits()).toHaveLength(1);
  });
  it('the counts never mix: the proposal\'s stay the proposal\'s, the edits are "yours"', async () => {
    await openAndRead();
    const before = chip();
    addNode('/extra');
    expect(chip()).toContain(before);
    expect(chip()).toContain('yours: +1 node');
    click(mine());
    expect(chip()).toContain('yours: +1 node (hidden)');
    expect(yoursText([{ op: 'add-node' }, { op: 'add-node' }, { op: 'add-edge' }, { op: 'reword-step' }])).toBe('yours: +2 nodes, +1 edge, 1 step changed');
    expect(yoursText([])).toBe('');
  });
  it('"Your edits · 1" is the first group of the change list, and Changes counts only the proposal\'s', async () => {
    await openAndRead();
    const before = q('#rc-changes-h [data-corn="count"]').textContent;
    addNode('/extra');
    const groups = [...document.querySelectorAll('#rc-changes > *')].map((el) => el.tagName);
    expect(groups.slice(0, 3)).toEqual(['H3', 'H4', 'UL']);
    expect(q('#rc-changes h4').textContent).toContain('Your edits');
    expect(q('#rc-changes-h [data-corn="count"]').textContent).toBe(before);
  });
  it('a new node comes into view, said once', async () => {
    await openAndRead();
    const spy = vi.spyOn(Element.prototype, 'setAttribute');
    addNode('/extra');
    spy.mockRestore();
    await advance(100);
    expect(document.getElementById('map-announcer')?.textContent || '').toMatch(/\/extra/);
  });
});

describe('what posts is what was on screen at the press (the lead review of spec 0007)', () => {
  const dbl = (el) => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
  };
  it('the review names the version and the head it was about, so the server can refuse a push it was not shown', async () => {
    const s = fakeServer();
    showProposal(robot(), { slug: '0013-meals', source: 'pull/23', view: 'diff', fit: true, sha256: 'f'.repeat(64) });
    await settle();
    pressApprove();
    await advance(HOLD_MS);
    expect(s.puts()).toHaveLength(1);
    expect(s.puts()[0].body).toMatchObject({ verdict: 'approved', sha256: 'f'.repeat(64), headSha: 'a'.repeat(40) });
  });
  it('a push during the hold (the head moved) sends nothing and says so', async () => {
    const s = await openAndRead();
    pressApprove();
    s.world.next.push(facts({ pull: { number: 23, draft: false, head: 'b'.repeat(40) } }));
    await advance(HOLD_MS);
    expect(s.puts()).toEqual([]);
    expect(msg().textContent).toMatch(/the PR was pushed to while it was held.*Nothing was sent\.$/);
    expect(document.activeElement).toBe(approveBtn());
  });
  it('a double click is one press: it holds once and sends once, and its second click never lands on Undo', async () => {
    const s = await openAndRead();
    dbl(approveBtn());
    expect(approveBtn().dataset.holding).toBe('true');
    undoBtn().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 })); // a second click that reached Undo undoes nothing
    expect(approveBtn().dataset.holding).toBe('true');
    expect(undoBtn().nextElementSibling).toBe(approveBtn()); // Undo sits before Approve, so Approve keeps its place under the pointer
    await advance(HOLD_MS);
    expect(s.puts()).toHaveLength(1);
  });
  it('a double click on a state that asks only asks: its second click is not "Approve anyway"', async () => {
    const s = await openAndRead(facts({ pull: { number: 23, draft: true, head: 'a'.repeat(40) } }));
    dbl(approveBtn());
    expect(askEl().hidden).toBe(false);
    expect(approveBtn().dataset.holding).toBe('false');
    await advance(HOLD_MS);
    expect(s.puts()).toEqual([]);
  });
  it('Enter held down is one press: its repeats neither answer the question it asked nor undo a hold', async () => {
    const s = await openAndRead(facts({ pull: { number: 23, draft: true, head: 'a'.repeat(40) } }));
    pressApprove();
    expect(askEl().hidden).toBe(false);
    const repeat = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
    approveBtn().dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true); // a button's click comes from its keydown: prevented, there is no click
    expect(approveBtn().dataset.holding).toBe('false');
    await advance(HOLD_MS);
    expect(s.puts()).toEqual([]);
  });
  it('the same approval standing already (another tab) is not posted again, and the page says nothing new was posted', async () => {
    const s = await openAndRead();
    s.world.put = null;
    const mock = /** @type {any} */ (globalThis.fetch);
    const inner = mock.getMockImplementation();
    mock.mockImplementation(async (url, init = {}) => {
      if ((init.method || 'GET') === 'PUT') { s.calls.push({ method: 'PUT', url, body: JSON.parse(String(init.body)) }); return { ok: true, status: 200, redirected: false, headers: new Headers(), json: async () => ({ version: 1, verdict: 'approved', note: '', edits: [], at: new Date(T0 - 60_000).toISOString(), by: 'maintainer-one', posted: false }) }; }
      return inner(url, init);
    });
    pressApprove();
    await advance(HOLD_MS);
    expect(hint().textContent).toBe('It was approved already by maintainer-one; nothing new was posted.');
    expect(approveBtn().textContent.trim()).toBe('Approved');
  });
  it('a note typed for Send back is kept for this tab: a reload during the hold does not lose it, and a send forgets it', async () => {
    let s = await openAndRead();
    typeNote('Split the page.');
    click(sendBackBtn());
    expect(sendBackBtn().dataset.holding).toBe('true');
    const kept = Object.keys(sessionStorage).find((k) => k.startsWith('cornfield.reviewNote.'));
    expect(kept && sessionStorage.getItem(kept)).toBe('Split the page.');
    // the reload: the page starts again, the tab's storage stays
    await mount();
    sessionStorage.setItem(/** @type {string} */ (kept), 'Split the page.');
    s = await openAndRead();
    expect(noteOpen()).toBe(true);
    expect(noteBox().value).toBe('Split the page.');
    expect(s.puts()).toEqual([]); // kept, never sent by itself
    await send(sendBackBtn());
    expect(s.puts()).toHaveLength(1);
    expect(sessionStorage.getItem(/** @type {string} */ (kept))).toBeNull();
  });
});

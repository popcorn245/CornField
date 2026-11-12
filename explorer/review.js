/**
 * @module explorer/review
 *
 * Approving a proposal and sending it back: the two buttons on the proposal toolbar (index.html), the note that opens
 * under it, and what a click does. "Approve" takes no note. "Send back" opens the note field (focus moves to it; Cancel
 * closes it and gives focus back to Send back); the button then reads "Send back with this note" and a note is needed.
 * Both put the maintainer's what-if
 * edits (`getEdits()`, whatif.js) in the review, which the server posts as a comment on the spec PR, as the
 * signed-in maintainer (`PUT /proposals/<slug>/review`, server/proposals.js, server/reviews.js). The agent drafting
 * the spec reads it (`cornfield review <slug>`) and folds the edits into the proposal. Only a proposal of a spec PR
 * (source `pull/<n>`) has a PR to hold a review: for a draft in the checkout or a worktree the buttons are off and
 * the bar says to push it as a spec PR (docs/specs/0001-v1.md).
 *
 *   state.proposalSlug / proposalSource   which proposal the review is for (the server matches them against what it listed)
 *   GET  /proposals/<slug>/review         the latest admin review on the PR, when it opens: "Approved 3 minutes ago"
 *   PUT  /proposals/<slug>/review         { verdict, note, edits } -> the review as posted
 *
 * An approval of a spec PR's proposal also records its mockup files' hashes in the review comment (server/mockups.js); the panel's mockups then read "Reviewed" (mockups.js).
 *
 * After a send back the edits are emptied (`clearEdits()`: they went with the note); after an approval they stay, as they are
 * in the comment. Nothing here uses `alert`: every refusal and failure is a line on the bar.
 *
 * The words and the choices (what is sent, what to say) are review-model.js, tested without a page.
 *
 * **The decision (spec 0007).** Above the buttons, one line says what Approve does in this exact state (the PR, its checks, landing, a run, the runner,
 * the maintainer's edits): Approve's `aria-describedby`. The facts are `GET /proposals/<slug>/decision` (server/decision.js), read when the proposal
 * opens, every `FACTS_MS` while it is open and the tab is visible, when the window gets focus, and at the end of the hold; the words and the choices are
 * decision-model.js. Four states ask first, in place (the line becomes the question, the button "Approve anyway", Escape takes it back); a press then
 * starts a hold of `HOLD_MS` with Undo (focus on it) before anything leaves the page, and the end of the hold reads the facts once more. Closing the
 * proposal, opening another, hiding the tab, going offline, changing the edits, a push seen at the end of the hold, Undo and Escape each stop it, and
 * say so. What is sent is what was on screen at the press, with the version it was about (`sha256`, `headSha`). The server is the rule: it refuses a
 * version or a head the page was not shown (409), a maintainer who is one no longer (403) and a missing sign-in (401), and answers a repeat of an
 * approval that stands with that one, posting nothing, whatever this page did.
 */

import { state } from './state.js';
import { expandSheet, isPhone } from './sheets.js';
import { hooks } from './proposal.js';
import { refreshMockups } from './mockups.js';
import { getEdits, clearEdits, onEditsChange, openFormInfo, describeEditsNow } from './whatif.js';
import { reviewParts, sendBackProblem, reviewBody, editsHint, isReviewable } from './review-model.js';
import {
  HOLD_MS, decide, askReasons, askWords, newReasons, sendBackLine, sendBackDecision, refusalWords, holdWords, holdStartWords, holdCancelledWords, editsSentWords,
} from './decision-model.js';
import { pullNumberOf } from './proposal-model.js';
import { playedLine, onReviewColumnPaint } from './review-column.js';
import { announce } from './keyboard.js';
import { t } from './strings.js';
import { isOffline, notSentWords } from './connection.js';

const $ = (id) => document.getElementById(id);

const TICK_MS = 30_000;
/** How often the facts of the decision are read again while a proposal with a PR is open and the tab is visible (spec 0007 D1) */
export const FACTS_MS = 30_000;

/** What is shown: the review of the proposal that is open, and the lines under the buttons */
const ui = {
  key: null, // `${source}/${slug}` of the proposal the review below belongs to
  reviewable: false, // whether it is on a spec PR
  review: null, // { verdict, at } | null: the last review of it
  loadFailed: false, // the past reviews could not be read: the bar must not look as if there were none
  busy: false,
  noting: false, // the note field is open (Send back was pressed)
  message: '', // an inline refusal or failure
  hint: '', // what happens to the edits
  facts: null, // the decision route's answer for the open proposal
  factsState: 'loading', // 'loading' | 'ready' | 'unread'
  factsAt: 0,
  asking: null, // { verdict, answered }: the first press asked, and the button reads "Approve anyway"
  hold: null, // { verdict, body, answered, left, tick, end }: pressed, not yet sent (D3)
  sent: null, // { count, lines }: the edits a send back carried, kept readable (D4)
};

let root = null;
let wired = false;
let barBefore = null; // the hook that was on the bar before this one
let timer = null;
let factsTimer = null;
let now = () => Date.now();

const slugOf = () => state.proposalSlug || null;
const keyOf = () => (state.proposal && slugOf() ? `${state.proposalSource || ''}/${slugOf()}` : null);
const enc = () => (state.proposalSource ? `?source=${encodeURIComponent(state.proposalSource)}` : '');
const reviewUrl = () => `/proposals/${encodeURIComponent(slugOf())}/review${enc()}`;
const decisionUrl = (fresh) => `/proposals/${encodeURIComponent(slugOf())}/decision${enc()}${fresh ? '&fresh=1' : ''}`;
const q = (sel) => (root ? root.querySelector(sel) : null);
/** The decision's buttons, in the review column's foot: Send back and Approve (index.html) */
const button = (verdict) => document.querySelector(`#review-decision [data-review="${verdict}"]`);
const undoButton = () => document.querySelector('#review-decision [data-review-undo]');

/** The status line, the note field, the line above the buttons and the hold; added to the decision (the review column's foot) once, just before Send back and Approve, so Tab goes from the note to Cancel and then to "Send back with this note" */
function mount() {
  const body = $('proposal-body');
  if (!body) return null;
  if (!root) {
    root = document.createElement('div');
    root.id = 'review';
    root.className = 'hx-review';
    root.dataset.corn = 'review-bar';
    root.innerHTML = `
      <p class="hx-review-status" data-review-status hidden><span data-review-verdict role="status"></span><span data-review-when></span></p>
      <div class="hx-review-form" id="review-form" data-review-form hidden>
        <label class="hx-review-label" for="review-note" data-corn="review-label"></label>
        <textarea data-corn="review-note" id="review-note" class="hx-review-note" rows="2" maxlength="20000"></textarea>
        <p class="hx-review-line" id="review-sendback-line" data-review-sendback-line></p>
        <div class="hx-review-row">
          <button type="button" class="hx-btn hx-btn--quiet" data-review-cancel data-corn-kind="quiet">Cancel</button>
        </div>
      </div>
      <p class="hx-review-msg" data-review-loadfail role="alert" hidden data-corn="message" data-corn-state="failure"><span data-review-loadfail-text></span> <button type="button" class="hx-btn hx-btn--quiet" data-review-retry data-corn-kind="quiet">Retry</button></p>
      <p class="hx-review-msg" data-review-msg role="alert" hidden></p>
      <p class="hx-review-line" id="review-hint" data-review-hint role="status" hidden></p>
      <details class="hx-sent-edits" data-corn="sent-edits" data-review-sent hidden><summary data-corn="summary" data-review-sent-summary></summary><ul class="hx-whatif-list" data-review-sent-list></ul></details>
      <div class="hx-review-landing" data-corn="notice" data-corn-state="waiting" data-review-landing hidden><p data-review-landing-text></p><button type="button" class="hx-btn hx-btn--quiet" data-review-cancel-landing data-corn-kind="quiet"></button></div>
      <p class="hx-review-ask" id="review-ask" data-corn="message" data-corn-state="waiting" data-review-ask role="alert" hidden></p>
      <p class="hx-decision-line" id="review-line" data-review-line></p>
      <div class="hx-hold" data-review-hold hidden aria-hidden="true"><span class="hx-hold-fill" data-review-hold-fill></span></div>
      <p class="hx-sr-only" data-review-hold-live role="status"></p>
`;
    // The words are set as text and attributes, never parsed as HTML (a brand's `strings`, explorer/strings.js)
    q('.hx-review-label').textContent = t('reviewNoteLabel');
    q('#review-note').setAttribute('placeholder', t('reviewNotePlaceholder'));
    q('[data-review-cancel-landing]').textContent = t('cancelLanding');
    // In the decision, the column's foot: the status and the note above Send back and Approve
    const actions = document.querySelector('#review-decision .hx-proposal-actions');
    if (actions) {
      actions.before(root);
      if (!actions.querySelector('[data-review-undo]')) {
        const undo = document.createElement('button');
        undo.type = 'button';
        undo.className = 'hx-btn hx-review-undo';
        undo.dataset.reviewUndo = '';
        undo.dataset.cornKind = 'secondary';
        undo.hidden = true;
        undo.textContent = t('undo');
        // Before Approve, not after it: Approve keeps its place under the pointer, so the second click of a double click lands on the held
        // button (which ignores it), never on Undo; on a phone Undo takes a row of its own under the two (css/decision.css)
        const approve = actions.querySelector('[data-review="approved"]');
        if (approve) approve.before(undo); else actions.append(undo);
      }
    } else body.prepend(root);
    ($('review-decision') || $('proposal-bar') || root).addEventListener('click', onClick);
    root.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'review-note') keepNote(ui.key, e.target.value);
      if (ui.message) { ui.message = ''; paint(); }
    });
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.noting && !ui.asking && !ui.hold) { e.stopPropagation(); closeNote(); } });
  }
  return root;
}

/** What the decision says now: the line and what a press of Approve does (decision-model.js) */
function decision() {
  return decide({
    source: state.proposalSource, facts: ui.facts, factsState: ui.factsState, review: ui.review, edits: state.whatIf ? state.whatIf.edits.length : 0,
    form: openFormInfo(), played: playedLine(), now: now(),
  });
}

/** Everything the review shows, from `ui` */
function paint() {
  if (!root) return;
  // Only the verdict is a live region, written when it changes: the time beside it ticks every TICK_MS and is never said again
  const status = q('[data-review-status]');
  const { verdict, when } = reviewParts(ui.review, now());
  const said = q('[data-review-verdict]');
  if (said.textContent !== verdict) said.textContent = verdict;
  q('[data-review-when]').textContent = when ? ` ${when}` : '';
  status.hidden = !verdict;
  // A failed read of the past reviews says so: an approved proposal must not look as if nobody had reviewed it
  const failed = q('[data-review-loadfail]');
  failed.hidden = !ui.loadFailed;
  q('[data-review-loadfail-text]').textContent = ui.loadFailed ? `Could not load this proposal's reviews.${isOffline() ? ' You are offline.' : ''} It may already be approved or sent back; try again before you decide.` : '';

  const d = decision();
  // What asks now. An ask that has nothing left to ask about (the check passed since, the form was added) goes by itself
  let askText = '';
  if (ui.asking && !ui.hold) {
    if (ui.asking.verdict === 'approved') askText = d.reasons.length ? askWords(d.reasons) : '';
    else { const sb = sendBackDecision({ form: openFormInfo() }); askText = sb.asks ? sb.ask : ''; }
    if (!askText) ui.asking = null;
  }
  const holding = ui.hold;
  const approveBtn = button('approved');
  const sendBtn = button('notes');
  const approveMode = ui.asking && ui.asking.verdict === 'approved' ? 'anyway' : holding && holding.verdict === 'approved' ? 'hold' : d.approve === 'done' ? 'done' : 'plain';
  const sendMode = ui.asking && ui.asking.verdict === 'notes' ? 'anyway' : holding && holding.verdict === 'notes' ? 'hold' : 'plain';

  // The line is Approve's description (the question while one is asked); not on a PR it is the reason for both buttons
  const line = q('[data-review-line]');
  line.textContent = ui.key ? d.line : '';
  line.hidden = !ui.key || !!askText; // the question takes the line's place while one is asked
  const ask = q('[data-review-ask]');
  if (ask.textContent !== askText) ask.textContent = askText;
  ask.hidden = !askText;
  q('[data-review-sendback-line]').textContent = sendBackLine({ source: state.proposalSource, edits: state.whatIf ? state.whatIf.edits.length : 0 });

  const refused = ui.key && d.approve === 'refused';
  for (const btn of document.querySelectorAll('#review-decision [data-review]')) {
    // Never `disabled` while a verdict is in flight, a press is held, or one is refused: those keep the focus and say why (the line); aria-disabled only
    const off = !ui.reviewable || ui.busy || !!holding || (btn === approveBtn && (d.approve === 'done' || d.approve === 'reading'));
    if (off) btn.setAttribute('aria-disabled', 'true'); else btn.removeAttribute('aria-disabled');
    btn.disabled = false;
    if (ui.key && btn === approveBtn) btn.setAttribute('aria-describedby', askText ? 'review-ask' : 'review-line');
    else if (ui.key && !ui.noting && btn === sendBtn && refused) btn.setAttribute('aria-describedby', 'review-line');
    else if (ui.key && ui.noting && btn === sendBtn) btn.setAttribute('aria-describedby', 'review-sendback-line');
    else btn.removeAttribute('aria-describedby');
  }
  if (approveBtn) {
    approveBtn.textContent = approveMode === 'hold' ? holdWords('approved', holding.left) : approveMode === 'anyway' ? t('approveAnyway') : approveMode === 'done' ? t('approved') : t('approve');
    approveBtn.dataset.holding = approveMode === 'hold' ? 'true' : 'false';
  }
  if (sendBtn) {
    sendBtn.textContent = sendMode === 'hold' ? holdWords('notes', holding.left) : sendMode === 'anyway' ? t('sendBackAnyway') : ui.noting ? t('sendBackWithNote') : t('sendBack');
    sendBtn.setAttribute('aria-expanded', String(ui.noting));
    sendBtn.setAttribute('aria-controls', 'review-form');
    sendBtn.dataset.holding = sendMode === 'hold' ? 'true' : 'false';
  }
  const undo = undoButton();
  if (undo) { undo.hidden = !holding; undo.textContent = t('undo'); }
  const bar = q('[data-review-hold]');
  bar.hidden = !holding;
  q('[data-review-form]').hidden = !ui.noting;
  q('[data-review-cancel]').disabled = ui.busy || !!holding;
  const note = q('#review-note');
  note.disabled = !ui.reviewable;
  note.readOnly = !!holding; // what was on screen at the press is what is sent
  for (const [sel, text] of [['[data-review-msg]', ui.message], ['[data-review-hint]', ui.reviewable ? ui.hint : '']]) {
    const el = q(sel);
    el.hidden = !text;
    el.textContent = text;
  }
  // The edits a send back carried: kept readable, read-only (D4)
  const sent = q('[data-review-sent]');
  sent.hidden = !ui.sent;
  if (ui.sent) {
    q('[data-review-sent-summary]').textContent = editsSentWords(ui.sent.lines.length);
    const list = q('[data-review-sent-list]');
    if (list.dataset.for !== ui.sent.key) {
      list.dataset.for = ui.sent.key;
      list.replaceChildren(...ui.sent.lines.map((text) => { const li = document.createElement('li'); li.className = 'hx-whatif-edit'; li.textContent = text; return li; }));
    }
  }
  // A landing that waits on this PR: Cancel landing, brought here from the Work panel (D3)
  const landing = q('[data-review-landing]');
  const landingNow = ui.reviewable && ui.facts && ui.facts.landing ? ui.facts.landing : null;
  landing.hidden = !landingNow;
  if (landingNow) q('[data-review-landing-text]').textContent = `Landing on approval waits for PR #${ui.facts.pull.number} to be ready and green.`;
}

/** Send back was pressed: the note field opens and takes focus (on a phone the sheet opens to hold it) */
function openNote() {
  ui.noting = true;
  ui.message = '';
  paint();
  if (isPhone()) expandSheet('proposal');
  q('#review-note').focus();
  // On a phone the keyboard is about to take half the screen: the note and the button that sends it stay in view above it
  const send = button('notes');
  if (isPhone() && send && typeof send.scrollIntoView === 'function') send.scrollIntoView({ block: 'nearest' });
}

/** Cancel: the field closes, what was typed goes, and focus goes back to Send back */
function closeNote() {
  ui.noting = false;
  ui.asking = null;
  ui.message = '';
  q('#review-note').value = '';
  forgetNote(ui.key);
  paint();
  const sendBack = button('notes');
  if (sendBack) sendBack.focus();
}

/** hooks.bar: the bar was drawn. Mount, and when it is another proposal than the one shown, start again for it. */
function onBar(open) {
  if (!mount()) return;
  const key = open ? keyOf() : null;
  root.hidden = !key;
  if (key === ui.key) { paint(); return; }
  if (ui.hold) stopHold(open ? 'other' : 'closed', { quiet: false });
  ui.key = key;
  ui.reviewable = !!key && isReviewable(state.proposalSource);
  ui.review = null;
  ui.loadFailed = false;
  ui.busy = false;
  ui.noting = false;
  ui.asking = null;
  ui.sent = null;
  ui.facts = null;
  ui.factsState = ui.reviewable ? 'loading' : 'ready';
  ui.message = ui.hint = '';
  const note = q('#review-note');
  // A note typed for Send back and not sent survives a reload or a way back to this proposal (in this tab only); it is never sent by itself
  const kept = key && ui.reviewable ? keptNote(key) : '';
  if (note) note.value = kept;
  if (kept) ui.noting = true;
  paint();
  if (key && ui.reviewable) { loadReview(key); loadFacts(); }
}

// ---------------------------------------------------------------------------
//  The facts of the decision (D1)
// ---------------------------------------------------------------------------

/**
 * Reads what Approve would do in this state. The server keeps the read for every tab, so this is cheap; `fresh` (the end of the hold) skips what is kept.
 * @returns {Promise<void>}
 */
export async function loadFacts({ fresh = false } = {}) {
  const key = ui.key;
  if (!key || !ui.reviewable || !pullNumberOf(state.proposalSource)) return;
  ui.factsAt = now();
  let facts = null;
  try {
    const res = await fetch(decisionUrl(fresh), { cache: 'no-store' });
    if (res.ok) facts = await res.json();
  } catch { facts = null; }
  if (key !== ui.key) return; // another proposal has opened since
  const head = facts && facts.pull ? facts.pull.head : null;
  const before = ui.facts && ui.facts.pull ? ui.facts.pull.head : null;
  ui.facts = facts && facts.pull ? facts : null;
  ui.factsState = ui.facts ? 'ready' : 'unread';
  // A push since the review was read: what stood is not what stands, so it is read again ("a push makes it live again")
  if (head && before && head !== before) loadReview(key);
  paint();
}

// ---------------------------------------------------------------------------
//  The note, kept for this tab (a reload during a hold, or by mistake, does not lose what was typed)
// ---------------------------------------------------------------------------

const NOTE_KEY = 'cornfield.reviewNote.';
function keepNote(key, text) {
  if (!key) return;
  try { if (text && text.trim()) sessionStorage.setItem(NOTE_KEY + key, text.slice(0, 20000)); else sessionStorage.removeItem(NOTE_KEY + key); } catch { /* storage off: nothing kept */ }
}
function keptNote(key) {
  try { return sessionStorage.getItem(NOTE_KEY + key) || ''; } catch { return ''; }
}
function forgetNote(key) {
  if (!key) return;
  try { sessionStorage.removeItem(NOTE_KEY + key); } catch { /* storage off */ }
}

/** The read repeats while a proposal with a PR is open and the tab is visible: nothing when hidden or with none open */
function readFactsAgain(min = 0) {
  if (!ui.key || !ui.reviewable || ui.hold || ui.busy) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (now() - ui.factsAt < min) return;
  loadFacts();
}

/** The latest admin review on the proposal's PR, as the server reads it from the comments (none yet is a 404) */
/** The reviews were read: the failure line goes, and Retry, if it had the focus, hands it to the proposal's name (the status line is a live region: it says the review itself, and is not a place for the focus) */
function readAgain() {
  const retried = !!root && root.contains(document.activeElement) && document.activeElement.matches('[data-review-retry]');
  ui.loadFailed = false;
  paint();
  const title = $('proposal-title');
  if (!retried || !title) return;
  title.tabIndex = -1;
  title.focus();
}

function readOnline() {
  if (ui.loadFailed && ui.key) loadReview(ui.key);
}

async function loadReview(key) {
  try {
    const res = await fetch(reviewUrl(), { cache: 'no-store' });
    if (key !== ui.key) return; // another proposal has opened since
    if (res.status === 404) { ui.review = null; readAgain(); return; } // none yet: the server says so with a 404
    if (!res.ok) throw new Error(`The server answered ${res.status}.`);
    const found = await res.json();
    if (key !== ui.key) return;
    if (found && typeof found.verdict === 'string') ui.review = { verdict: found.verdict, at: found.at, current: found.current === true };
    readAgain();
  } catch {
    // Not "no review": the read failed, so the bar says it could not look (with Retry), and the buttons stay as they were
    if (key === ui.key) { ui.loadFailed = true; paint(); }
  }
}

// ---------------------------------------------------------------------------
//  The presses
// ---------------------------------------------------------------------------

function onClick(e) {
  if (!e.target.closest) return;
  // The second click of a double click (or a double tap) is not a second decision: it must not answer the question the first one asked, nor undo
  // the hold it started (keyboard presses have a detail of 0)
  if (e.detail > 1 && e.target.closest('[data-review], [data-review-undo]')) return;
  if (e.target.closest('[data-review-undo]')) { if (ui.hold) stopHold('undo'); return; }
  if (ui.hold || ui.busy) return; // a double press: the first one is being held or sent, a second starts nothing
  if (e.target.closest('[data-review-cancel-landing]')) { cancelLanding(); return; }
  if (e.target.closest('[data-review-cancel]')) { closeNote(); return; }
  if (e.target.closest('[data-review-retry]')) { q('[data-review-loadfail-text]').textContent = 'Reading the reviews again …'; loadReview(ui.key); return; }
  const btn = e.target.closest('[data-review]');
  if (!btn) return;
  const verdict = btn.dataset.review;
  // Any other action takes an open question back
  if (ui.asking && ui.asking.verdict !== verdict) { ui.asking = null; paint(); }
  if (btn.getAttribute('aria-disabled') === 'true' || !ui.reviewable) return;
  if (verdict === 'notes' && !ui.noting) { openNote(); return; } // the first press opens the field, the second sends
  press(verdict);
}

/** A press of Approve or of "Send back with this note": it needs a note, may ask first, and then holds */
function press(verdict) {
  ui.message = '';
  ui.hint = '';
  ui.sent = null;
  // Offline there is nothing to hold: it says so now, and what was typed and edited is kept
  if (isOffline()) { ui.asking = null; ui.message = notSentWords(verdict === 'approved' ? 'Your approval' : 'Your send back'); paint(); return; }
  let answered = [];
  if (verdict === 'notes') {
    const problem = sendBackProblem(q('#review-note').value);
    if (problem) {
      ui.message = problem;
      ui.noting = true; // the refusal is about the note: show it
      paint();
      if (isPhone()) expandSheet('proposal');
      q('#review-note').focus();
      return;
    }
    const sb = sendBackDecision({ form: openFormInfo() });
    if (sb.asks && !(ui.asking && ui.asking.verdict === 'notes')) { ui.asking = { verdict: 'notes', answered: [] }; paint(); announce(sb.ask); return; }
    answered = sb.reasons.map((r) => r.key);
  } else {
    const d = decision();
    if (d.approve === 'refused' || d.approve === 'done' || d.approve === 'reading') { paint(); return; }
    if (d.approve === 'asks' && !(ui.asking && ui.asking.verdict === 'approved')) { ui.asking = { verdict: 'approved', answered: [] }; paint(); return; } // the question is a role=alert: said once
    answered = d.reasons.map((r) => r.key);
  }
  startHold(verdict, answered);
}

// ---------------------------------------------------------------------------
//  The hold (D3)
// ---------------------------------------------------------------------------

/** Starts the hold: what was on screen at the press is what will be sent; nothing leaves the page until it ends */
function startHold(verdict, answered) {
  // What was on screen at the press, and only that, is sent: the note, the edits, and which version they were about (the proposal file's SHA-256 and
  // the PR's head commit). The server refuses (409) a review whose version or head is not the PR's any more, so a push during the hold, or before
  // the press on a page opened earlier, is never approved unseen
  const shown = { ...(state.proposalSha256 ? { sha256: state.proposalSha256 } : {}), ...(ui.facts && ui.facts.pull && ui.facts.pull.head ? { headSha: ui.facts.pull.head } : {}) };
  const body = { ...reviewBody(verdict, verdict === 'notes' ? q('#review-note').value : '', getEdits()), ...shown };
  ui.asking = null;
  const hold = { verdict, body, answered, left: HOLD_MS / 1000, tick: null, end: null };
  ui.hold = hold;
  hold.tick = setInterval(() => { hold.left = Math.max(0, hold.left - 1); paint(); }, 1000);
  hold.end = setTimeout(() => { endHold(hold); }, HOLD_MS);
  q('[data-review-hold-fill]').style.animationDuration = `${HOLD_MS}ms`;
  paint();
  q('[data-review-hold-live]').textContent = holdStartWords(verdict, HOLD_MS / 1000); // said once, not every second
  const undo = undoButton();
  if (undo) undo.focus();
}

/** Ends a hold without sending, and says why: nothing was sent. `quiet`: no announcement (the page it was on is gone) */
function stopHold(why, { quiet = false } = {}) {
  const hold = ui.hold;
  if (!hold) return;
  clearInterval(hold.tick);
  clearTimeout(hold.end);
  ui.hold = null;
  const words = holdCancelledWords(hold.verdict, why);
  if (why === 'closed' || why === 'other') {
    if (!quiet) announce(words); // the review is not on this proposal any more: the page-wide announcer says it
  } else ui.message = words;
  paint();
  const live = q('[data-review-hold-live]');
  if (live) live.textContent = why === 'closed' || why === 'other' ? '' : words;
  // Undo went; the focus goes back to the button that started it
  if (why !== 'closed' && why !== 'other') button(hold.verdict)?.focus();
}

/** The end of the hold: the facts are read once more; a state that now asks, asks instead of sending */
async function endHold(hold) {
  if (ui.hold !== hold) return;
  clearInterval(hold.tick);
  if (isOffline()) { stopHold('offline'); return; }
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { stopHold('hidden'); return; }
  const key = ui.key;
  if (hold.verdict === 'approved' && ui.reviewable) await loadFacts({ fresh: true });
  if (ui.hold !== hold || key !== ui.key) return; // undone, or another proposal opened, while the facts were read
  // Pushed to during the hold: what was looked at is not the PR any more. Nothing is sent (the server would refuse it as well) and the page says so
  const headNow = ui.facts && ui.facts.pull ? ui.facts.pull.head : null;
  if (hold.verdict === 'approved' && hold.body.headSha && headNow && headNow !== hold.body.headSha) { stopHold('pushed'); return; }
  if (hold.verdict === 'approved') {
    const fresh = newReasons(askReasons({ facts: ui.facts, edits: hold.body.edits.length, form: openFormInfo() }), hold.answered);
    if (fresh.length) {
      ui.hold = null;
      ui.asking = { verdict: 'approved', answered: hold.answered };
      paint();
      button('approved')?.focus();
      return;
    }
  }
  ui.hold = null;
  const live = q('[data-review-hold-live]');
  if (live) live.textContent = ''; // the hold is over: what happened is said by the status line (or the refusal), not by "Approving in 5 seconds"
  await sendReview(hold.verdict, { body: hold.body });
}

/** Cancel landing (D3): the Work panel's Cancel, here; a POST from this page, then the facts are read again */
async function cancelLanding() {
  const n = pullNumberOf(state.proposalSource);
  if (!n) return;
  ui.busy = true;
  paint();
  let words = '';
  try {
    const res = await fetch(`/api/forge/pulls/${n}/landing/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) { let why = ''; try { why = (await res.json()).error || ''; } catch { /* no body */ } words = refusalWords(res.status, why); }
  } catch { words = notSentWords('Cancelling the landing'); }
  ui.busy = false;
  ui.message = words;
  await loadFacts({ fresh: true });
  paint();
  if (!words) announce('Landing cancelled. The approval stands and the PR stays open.');
  (button('approved') || button('notes'))?.focus();
}

/**
 * Approve or send back the open proposal, now (the hold is over; tests and scripts call this directly).
 * @param {'approved'|'notes'} verdict
 * @param {{ body?: object }} [frozen] the body held at the press; without it, what is on screen now
 * @returns {Promise<boolean>} whether the server took the review
 */
export async function sendReview(verdict, frozen = {}) {
  if (!state.proposal || !slugOf() || !mount() || !ui.reviewable) return false;
  const noteEl = q('#review-note');
  const note = verdict === 'notes' ? noteEl.value : ''; // an approval takes no note
  ui.hint = '';
  if (verdict === 'notes' && !frozen.body) {
    const problem = sendBackProblem(note);
    if (problem) {
      ui.message = problem;
      ui.noting = true; // the refusal is about the note: show it
      paint();
      if (isPhone()) expandSheet('proposal');
      noteEl.focus();
      return false;
    }
  }
  ui.message = '';
  ui.busy = true;
  paint();
  const key = ui.key;
  const body = frozen.body || reviewBody(verdict, note, getEdits());
  const sentLines = verdict === 'notes' ? describeEditsNow() : [];
  let saved;
  const what = verdict === 'approved' ? 'Your approval' : 'Your send back';
  let res;
  try {
    res = await fetch(reviewUrl(), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    // No answer at all: offline, or the server is not there. Said so, not as a server's error; the note and the edits are kept, and it says it was not sent
    ui.busy = false;
    ui.message = notSentWords(what);
    paint();
    return false;
  }
  try {
    let answer = null;
    try { answer = await res.json(); } catch { /* no body */ }
    // A sign-in that ended answers 401 (or sends the page to the sign-in): said in words, and what was typed and edited is kept
    if (res.status === 401 || res.redirected) throw Object.assign(new Error(''), { status: 401 });
    if (!res.ok) throw Object.assign(new Error((answer && answer.error) || ''), { status: res.status });
    saved = answer;
  } catch (err) {
    ui.busy = false;
    ui.message = refusalWords(err.status || res.status, err.message);
    paint();
    // Refused because something changed (a push: 409) or another tab sent one just now (429): the bar is brought up to date
    if ((res.status === 409 || res.status === 429) && key === ui.key) { loadReview(key); loadFacts({ fresh: true }); }
    return false;
  }
  ui.busy = false;
  if (key !== ui.key) return true; // another proposal opened while it was being saved: it is saved, the bar is not this one's any more
  ui.review = { verdict: saved.verdict, at: saved.at, current: saved.verdict === 'approved' };
  ui.hint = verdict === 'approved' ? editsHint(verdict, body.edits.length) : '';
  // The same approval stood already (another tab, or a send that was retried): the server posted nothing, and the page says so
  if (saved.posted === false) ui.hint = `It was approved already${saved.by ? ` by ${saved.by}` : ''}; nothing new was posted.`;
  forgetNote(key);
  if (verdict === 'notes' && sentLines.length) ui.sent = { key: `${saved.at}`, lines: sentLines };
  noteEl.value = '';
  const wasNoting = ui.noting;
  ui.noting = false;
  paint();
  // The buttons were busy while it posted, not `disabled`, so the focus stayed where it was. Approve keeps it (the status line, a live region,
  // says "Approved" once; moving the focus onto it would say it twice); when it was lost (Undo went with the hold) it goes back to Approve. Send back: the button that opened the note.
  const lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected || document.activeElement.hidden;
  if (verdict === 'approved') { if (lost) button('approved')?.focus(); }
  else if (wasNoting || lost) button('notes')?.focus();
  if (hooks.reviewed) hooks.reviewed(); // what waits on you changed: the count is read again (spec 0010)
  refreshMockups(); // an approval covers the screens as they are now; a send back leaves them not reviewed
  if (verdict === 'notes') clearEdits(); // the edits went with the note; an approval keeps them, they are in the review
  loadFacts({ fresh: true }); // an approval can have started a landing: Cancel landing shows
  return true;
}

// ---------------------------------------------------------------------------
//  Wiring
// ---------------------------------------------------------------------------

/** Escape takes an open question back, or ends a hold, before anything else on the page hears it; a held key's repeats do nothing here */
function onEscape(e) {
  // A key held down repeats: its repeats are not more decisions (Enter held on Approve would answer its own question, then undo the hold)
  if (e.repeat && (e.key === 'Enter' || e.key === ' ') && e.target && e.target.closest && e.target.closest('#review-decision [data-review], #review-decision [data-review-undo]')) { e.preventDefault(); e.stopPropagation(); return; }
  if (e.key !== 'Escape' || !ui.key) return;
  if (ui.hold) { e.stopPropagation(); e.preventDefault(); stopHold('escape'); return; }
  if (ui.asking) { e.stopPropagation(); e.preventDefault(); ui.asking = null; paint(); }
}

const onVisible = () => {
  if (document.visibilityState === 'hidden') { if (ui.hold) stopHold('hidden'); return; }
  readFactsAgain(5_000);
};

/**
 * Wires the review to the proposal bar (main.js calls this once, after whatif.js is wired, so the controls come
 * in order). The bar keeps whatever hook was there before.
 */
export function initReview() {
  if (wired) return;
  wired = true;
  barBefore = hooks.bar;
  hooks.bar = (open) => {
    if (barBefore) barBefore(open);
    onBar(open);
  };
  if (typeof window !== 'undefined') {
    // Back online after a failed read: the reviews are read again (the same function each time, so it is added once)
    window.addEventListener('online', readOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('keydown', onEscape, true);
  }
  stopEdits = onEditsChange(() => { if (ui.hold) stopHold('edits'); paint(); });
  stopColumn = onReviewColumnPaint(paint);
  // "3 minutes ago" moves on without the bar being drawn again
  timer = setInterval(() => { if (ui.review) paint(); }, TICK_MS);
  factsTimer = setInterval(() => readFactsAgain(), FACTS_MS);
  onBar(!!state.proposal);
}

let stopEdits = null;
let stopColumn = null;
const onOffline = () => { if (ui.hold) stopHold('offline'); };
const onFocus = () => readFactsAgain(5_000);
const onPageHide = () => { if (ui.hold) stopHold('closed', { quiet: true }); }; // the page is going: nothing was sent, and nothing will be

/** For tests: forget the page this was wired to, and use `clock` for the time shown */
export function resetReviewForTests(clock = () => Date.now()) {
  if (timer) clearInterval(timer);
  if (factsTimer) clearInterval(factsTimer);
  timer = null;
  factsTimer = null;
  if (ui.hold) { clearInterval(ui.hold.tick); clearTimeout(ui.hold.end); }
  if (wired) {
    hooks.bar = barBefore;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', readOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('keydown', onEscape, true);
    }
    if (stopEdits) stopEdits();
    if (stopColumn) stopColumn();
  }
  wired = false;
  root = null;
  now = clock;
  try { for (const k of Object.keys(sessionStorage)) if (k.startsWith(NOTE_KEY)) sessionStorage.removeItem(k); } catch { /* none */ }
  Object.assign(ui, { key: null, reviewable: false, review: null, loadFailed: false, busy: false, noting: false, message: '', hint: '', facts: null, factsState: 'loading', factsAt: 0, asking: null, hold: null, sent: null });
}

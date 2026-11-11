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
 */

import { state } from './state.js';
import { expandSheet, isPhone } from './sheets.js';
import { hooks } from './proposal.js';
import { refreshMockups } from './mockups.js';
import { getEdits, clearEdits } from './whatif.js';
import { reviewWords, sendBackProblem, reviewBody, editsHint, isReviewable, NOT_ON_A_PR } from './review-model.js';
import { t } from './strings.js';
import { isOffline, notSentWords } from './connection.js';

const $ = (id) => document.getElementById(id);

const TICK_MS = 30_000;

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
};

let root = null;
let wired = false;
let barBefore = null; // the hook that was on the bar before this one
let timer = null;
let now = () => Date.now();

const slugOf = () => state.proposalSlug || null;
const keyOf = () => (state.proposal && slugOf() ? `${state.proposalSource || ''}/${slugOf()}` : null);
const reviewUrl = () => `/proposals/${encodeURIComponent(slugOf())}/review${state.proposalSource ? `?source=${encodeURIComponent(state.proposalSource)}` : ''}`;
const q = (sel) => (root ? root.querySelector(sel) : null);
/** The toolbar's own buttons: Send back and Approve (index.html) */
const button = (verdict) => document.querySelector(`#proposal-bar [data-review="${verdict}"]`);

/** The status line, the note field and the lines under them; added to the toolbar once, just before Send back and Approve, so Tab goes from the note to Cancel and then to "Send back with this note" (on a phone it sits under the counts, above the two buttons; from 768px CSS gives it a row under the toolbar) */
function mount() {
  const body = $('proposal-body');
  if (!body) return null;
  if (!root) {
    root = document.createElement('div');
    root.id = 'review';
    root.className = 'hx-review';
    root.dataset.corn = 'review-bar';
    root.innerHTML = `
      <p class="hx-review-status" data-review-status role="status" hidden></p>
      <div class="hx-review-form" id="review-form" data-review-form hidden>
        <label class="hx-review-label" for="review-note"></label>
        <textarea id="review-note" class="hx-review-note" rows="2" maxlength="20000"></textarea>
        <div class="hx-review-row">
          <button type="button" class="hx-btn hx-btn--quiet" data-review-cancel data-corn-kind="quiet">Cancel</button>
        </div>
      </div>
      <p class="hx-review-msg" data-review-loadfail role="alert" hidden data-corn="message" data-corn-state="failure"><span data-review-loadfail-text></span> <button type="button" class="hx-btn hx-btn--quiet" data-review-retry data-corn-kind="quiet">Retry</button></p>
      <p class="hx-review-msg" data-review-msg role="alert" hidden></p>
      <p class="hx-review-line" id="review-hint" data-review-hint role="status" hidden></p>
`;
    // The words are set as text and attributes, never parsed as HTML (a brand's `strings`, explorer/strings.js)
    q('.hx-review-label').textContent = t('reviewNoteLabel');
    q('#review-note').setAttribute('placeholder', t('reviewNotePlaceholder'));
    const actions = body.querySelector('.hx-proposal-actions');
    if (actions) actions.before(root); else body.prepend(root);
    const bar = $('proposal-bar');
    (bar || root).addEventListener('click', onClick);
    root.addEventListener('input', () => { if (ui.message) { ui.message = ''; paint(); } });
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.noting) { e.stopPropagation(); closeNote(); } });
  }
  return root;
}

/** Everything the review shows, from `ui` */
function paint() {
  if (!root) return;
  const status = q('[data-review-status]');
  status.textContent = reviewWords(ui.review, now());
  status.hidden = !status.textContent;
  // A failed read of the past reviews says so: an approved proposal must not look as if nobody had reviewed it
  const failed = q('[data-review-loadfail]');
  failed.hidden = !ui.loadFailed;
  q('[data-review-loadfail-text]').textContent = ui.loadFailed ? `Could not load this proposal's reviews.${isOffline() ? ' You are offline.' : ''} It may already be approved or sent back; try again before you decide.` : '';
  // Off for good (not a spec PR's copy) is `disabled`, and the reason is the line next to it, which the buttons point at. While a review is being posted the button
  // only says it is busy (`aria-disabled`): a `disabled` button drops the focus to the page.
  for (const btn of document.querySelectorAll('#proposal-bar [data-review]')) {
    btn.disabled = !ui.reviewable;
    if (ui.busy) btn.setAttribute('aria-disabled', 'true'); else btn.removeAttribute('aria-disabled');
    if (!ui.reviewable && ui.key) btn.setAttribute('aria-describedby', 'review-hint'); else btn.removeAttribute('aria-describedby');
  }
  const approve = button('approved');
  if (approve) approve.textContent = t('approve');
  const sendBack = button('notes');
  if (sendBack) {
    sendBack.textContent = ui.noting ? t('sendBackWithNote') : t('sendBack');
    sendBack.setAttribute('aria-expanded', String(ui.noting));
    sendBack.setAttribute('aria-controls', 'review-form');
  }
  q('[data-review-form]').hidden = !ui.noting;
  q('[data-review-cancel]').disabled = ui.busy;
  q('#review-note').disabled = !ui.reviewable;
  for (const [sel, text] of [['[data-review-msg]', ui.message], ['[data-review-hint]', ui.reviewable ? ui.hint : ui.key ? NOT_ON_A_PR : '']]) {
    const el = q(sel);
    el.hidden = !text;
    el.textContent = text;
  }
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
  ui.message = '';
  q('#review-note').value = '';
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
  ui.key = key;
  ui.reviewable = !!key && isReviewable(state.proposalSource);
  ui.review = null;
  ui.loadFailed = false;
  ui.busy = false;
  ui.noting = false;
  ui.message = ui.hint = '';
  const note = q('#review-note');
  if (note) note.value = '';
  paint();
  if (key && ui.reviewable) loadReview(key);
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
    if (res.status === 404) { readAgain(); return; } // none yet: the server says so with a 404
    if (!res.ok) throw new Error(`The server answered ${res.status}.`);
    const found = await res.json();
    if (key !== ui.key) return;
    if (found && typeof found.verdict === 'string') ui.review = { verdict: found.verdict, at: found.at };
    readAgain();
  } catch {
    // Not "no review": the read failed, so the bar says it could not look (with Retry), and the buttons stay as they were
    if (key === ui.key) { ui.loadFailed = true; paint(); }
  }
}

function onClick(e) {
  if (ui.busy || !e.target.closest) return;
  if (e.target.closest('[data-review-cancel]')) { closeNote(); return; }
  if (e.target.closest('[data-review-retry]')) { q('[data-review-loadfail-text]').textContent = 'Reading the reviews again …'; loadReview(ui.key); return; }
  const btn = e.target.closest('[data-review]');
  if (!btn || btn.disabled) return;
  if (btn.dataset.review === 'notes' && !ui.noting) openNote(); // the first press opens the field, the second sends
  else sendReview(btn.dataset.review);
}

/**
 * Approve or send back the open proposal.
 * @param {'approved'|'notes'} verdict
 * @returns {Promise<boolean>} whether the server took the review
 */
export async function sendReview(verdict) {
  if (!state.proposal || !slugOf() || !mount() || !ui.reviewable) return false;
  const noteEl = q('#review-note');
  const note = verdict === 'notes' ? noteEl.value : ''; // an approval takes no note
  ui.hint = '';
  if (verdict === 'notes') {
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
  const body = reviewBody(verdict, note, getEdits());
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
    if (!res.ok) throw new Error((answer && answer.error) || `The server answered ${res.status}.`);
    saved = answer;
  } catch (err) {
    ui.busy = false;
    ui.message = `The review was not posted. ${err.message || String(err)}`;
    paint();
    return false;
  }
  ui.busy = false;
  if (key !== ui.key) return true; // another proposal opened while it was being saved: it is saved, the bar is not this one's any more
  ui.review = { verdict: saved.verdict, at: saved.at };
  ui.hint = editsHint(verdict, body.edits.length);
  noteEl.value = '';
  const wasNoting = ui.noting;
  ui.noting = false;
  paint();
  // The buttons were busy while it posted, not `disabled`, so the focus stayed where it was. Approve keeps it (the status line, a live region,
  // says "Approved" once; moving the focus onto it would say it twice); when it was lost it goes back to Approve. Send back: the button that opened the note.
  const lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
  if (verdict === 'approved') { if (lost) button('approved')?.focus(); }
  else if (wasNoting || lost) button('notes')?.focus();
  refreshMockups(); // an approval covers the screens as they are now; a send back leaves them not reviewed
  if (verdict === 'notes') clearEdits(); // the edits went with the note; an approval keeps them, they are in the review
  return true;
}

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
  // Back online after a failed read: the reviews are read again (the same function each time, so it is added once)
  if (typeof window !== 'undefined') window.addEventListener('online', readOnline);
  // "3 minutes ago" moves on without the bar being drawn again
  timer = setInterval(() => { if (ui.review) paint(); }, TICK_MS);
  onBar(!!state.proposal);
}

/** For tests: forget the page this was wired to, and use `clock` for the time shown */
export function resetReviewForTests(clock = () => Date.now()) {
  if (timer) clearInterval(timer);
  timer = null;
  if (wired) hooks.bar = barBefore;
  wired = false;
  root = null;
  now = clock;
  Object.assign(ui, { key: null, reviewable: false, review: null, loadFailed: false, busy: false, noting: false, message: '', hint: '' });
}

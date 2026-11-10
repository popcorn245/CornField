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

const $ = (id) => document.getElementById(id);

const TICK_MS = 30_000;

/** What is shown: the review of the proposal that is open, and the lines under the buttons */
const ui = {
  key: null, // `${source}/${slug}` of the proposal the review below belongs to
  reviewable: false, // whether it is on a spec PR
  review: null, // { verdict, at } | null: the last review of it
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

/** The status line, the note field and the lines under the toolbar; added to the bar once, right under the toolbar */
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
      <p class="hx-review-msg" data-review-msg role="alert" hidden></p>
      <p class="hx-review-line" data-review-hint role="status" hidden></p>
`;
    // The words are set as text and attributes, never parsed as HTML (a brand's `strings`, explorer/strings.js)
    q('.hx-review-label').textContent = t('reviewNoteLabel');
    q('#review-note').setAttribute('placeholder', t('reviewNotePlaceholder'));
    const head = body.querySelector('.hx-proposal-head');
    if (head) head.after(root); else body.prepend(root);
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
  for (const btn of document.querySelectorAll('#proposal-bar [data-review]')) btn.disabled = ui.busy || !ui.reviewable;
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
  ui.busy = false;
  ui.noting = false;
  ui.message = ui.hint = '';
  const note = q('#review-note');
  if (note) note.value = '';
  paint();
  if (key && ui.reviewable) loadReview(key);
}

/** The latest admin review on the proposal's PR, as the server reads it from the comments (none yet is a 404) */
async function loadReview(key) {
  try {
    const res = await fetch(reviewUrl(), { cache: 'no-store' });
    if (!res.ok) return;
    const found = await res.json();
    if (key !== ui.key || !found || typeof found.verdict !== 'string') return; // none, or another proposal has opened since
    ui.review = { verdict: found.verdict, at: found.at };
    paint();
  } catch { /* the server is not there: no review shown */ }
}

function onClick(e) {
  if (ui.busy || !e.target.closest) return;
  if (e.target.closest('[data-review-cancel]')) { closeNote(); return; }
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
  try {
    const res = await fetch(reviewUrl(), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
  if (wasNoting && verdict === 'notes') { const sendBack = button('notes'); if (sendBack) sendBack.focus(); }
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
  Object.assign(ui, { key: null, reviewable: false, review: null, busy: false, noting: false, message: '', hint: '' });
}

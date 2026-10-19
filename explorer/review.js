/**
 * @module explorer/review
 *
 * Approving a proposal and sending it back: the two buttons and the note under the proposal bar, and what a
 * click does. "Approve" (a note is optional) and "Send back" (a note is needed) both put the maintainer's what-if
 * edits (`getEdits()`, whatif.js) in the review, which the server keeps in its data folder
 * (`PUT /proposals/<slug>/review`, server/proposals.js). The agent drafting the spec reads it
 * (`cornfield review <slug>`) and folds the edits into the proposal. In v1 the same review is posted as a
 * comment on the spec PR instead (docs/specs/0001-v1.md).
 *
 *   state.proposalSlug / proposalSource   which proposal the review is for (the server matches them against what it listed)
 *   GET  /proposals                       the listing's `review` of this proposal, when it opens: "Approved 3 minutes ago"
 *   PUT  /proposals/<slug>/review         { verdict, note, edits } -> the file as written
 *
 * An approval also records the proposal's mockup files (server/mockups.js); the panel's mockups then read "Reviewed" (mockups.js).
 *
 * After a send back the edits are emptied (`clearEdits()`: they went with the note); after an approval they stay, as they are
 * in the file. Nothing here uses `alert`: every refusal and failure is a line on the bar.
 *
 * The words and the choices (what is sent, what to say) are review-model.js, tested without a page.
 */

import { state } from './state.js';
import { hooks } from './proposal.js';
import { refreshMockups } from './mockups.js';
import { getEdits, clearEdits } from './whatif.js';
import { reviewWords, sendBackProblem, reviewBody, editsHint } from './review-model.js';

const $ = (id) => document.getElementById(id);

const TICK_MS = 30_000;

/** What is shown: the review of the proposal that is open, and the lines under the buttons */
const ui = {
  key: null, // `${source}/${slug}` of the proposal the review below belongs to
  review: null, // { verdict, at } | null: the last review of it
  busy: false,
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
const same = (entry) => entry && entry.slug === slugOf() && (!state.proposalSource || entry.source === state.proposalSource);
const q = (sel) => (root ? root.querySelector(sel) : null);

/** The note box, the two buttons, and the lines under them; added to the bar once */
function mount() {
  const body = $('proposal-body');
  if (!body) return null;
  if (!root) {
    root = document.createElement('div');
    root.id = 'review';
    root.className = 'hx-review';
    root.setAttribute('aria-label', 'Approve or send back');
    root.innerHTML = `
      <label class="hx-review-label" for="review-note">Note for the drafting agent</label>
      <textarea id="review-note" class="hx-review-note" rows="2" maxlength="20000" placeholder="What should change? Needed to send it back, optional to approve."></textarea>
      <div class="hx-review-row">
        <button type="button" class="hx-btn hx-btn--approve" data-review="approved" title="Sign this proposal off">Approve</button>
        <button type="button" class="hx-btn" data-review="notes" title="Send it back to the drafting agent with the note and your edits">Send back</button>
        <span class="hx-review-status" data-review-status role="status"></span>
      </div>
      <p class="hx-review-msg" data-review-msg role="alert" hidden></p>
      <p class="hx-review-line" data-review-hint role="status" hidden></p>
`;
    body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('input', () => { if (ui.message) { ui.message = ''; paint(); } });
  }
  return root;
}

/** Everything the review shows, from `ui` */
function paint() {
  if (!root) return;
  const status = q('[data-review-status]');
  status.textContent = reviewWords(ui.review, now());
  status.hidden = !status.textContent;
  for (const btn of root.querySelectorAll('[data-review]')) btn.disabled = ui.busy;
  for (const [sel, text] of [['[data-review-msg]', ui.message], ['[data-review-hint]', ui.hint]]) {
    const el = q(sel);
    el.hidden = !text;
    el.textContent = text;
  }
}

/** hooks.bar: the bar was drawn. Mount, and when it is another proposal than the one shown, start again for it. */
function onBar(open) {
  if (!mount()) return;
  const key = open ? keyOf() : null;
  root.hidden = !key;
  if (key === ui.key) { paint(); return; }
  ui.key = key;
  ui.review = null;
  ui.busy = false;
  ui.message = ui.hint = '';
  const note = q('#review-note');
  if (note) note.value = '';
  paint();
  if (key) loadReview(key);
}

/** The last review of the proposal that just opened: the `review` the server's listing carries for it (none yet is null) */
async function loadReview(key) {
  try {
    const res = await fetch('/proposals', { cache: 'no-store' });
    if (!res.ok) return;
    const list = await res.json();
    const found = Array.isArray(list) ? list.find(same) : null;
    if (key !== ui.key || !found || !found.review || typeof found.review.verdict !== 'string') return; // none, or another proposal has opened since
    ui.review = { verdict: found.review.verdict, at: found.review.at };
    paint();
  } catch { /* the server is not there: no review shown */ }
}

function onClick(e) {
  const btn = e.target.closest ? e.target.closest('[data-review]') : null;
  if (btn && !ui.busy) sendReview(btn.dataset.review);
}

/**
 * Approve or send back the open proposal.
 * @param {'approved'|'notes'} verdict
 * @returns {Promise<boolean>} whether the server took the review
 */
export async function sendReview(verdict) {
  if (!state.proposal || !slugOf() || !mount()) return false;
  const noteEl = q('#review-note');
  const note = noteEl.value;
  ui.hint = '';
  if (verdict === 'notes') {
    const problem = sendBackProblem(note);
    if (problem) {
      ui.message = problem;
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
    ui.message = `The review was not saved. ${err.message || String(err)}`;
    paint();
    return false;
  }
  ui.busy = false;
  if (key !== ui.key) return true; // another proposal opened while it was being saved: it is saved, the bar is not this one's any more
  ui.review = { verdict: saved.verdict, at: saved.at };
  ui.hint = editsHint(verdict, body.edits.length);
  noteEl.value = '';
  paint();
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
  Object.assign(ui, { key: null, review: null, busy: false, message: '', hint: '' });
}

/**
 * @module explorer/review
 *
 * A bridge (spec 0011 D2 and D3, step 5): approving a proposal and sending it back is now the decision piece (pieces/decision.js). This file keeps the old
 * names for page.js and tests, bound to the page's instance, and answers for the what-if editor and the mockups, which are not on an instance yet: what the
 * decision asks of them (their edits, an open form, the lines of the edits sent) and what it tells them (the edits went, the screens were reviewed). It goes
 * when those two are converted.
 */

import { pageInstance } from './state.js';
import { pagePiece, setPagePieceOptions } from './page-pieces.js';
import { getEdits, clearEdits, onEditsChange, openFormInfo, describeEditsNow } from './whatif.js';
import { refreshMockups } from './mockups.js';
export { FACTS_MS } from './pieces/decision.js';

// What the decision asks of the neighbours that are not on an instance yet, answered for the page's instance
const page = pageInstance();
page.on('whatif:edits', () => (page.state.whatIf ? getEdits() : []));
page.on('whatif:form', () => openFormInfo());
page.on('whatif:describe', () => (page.state.whatIf ? describeEditsNow() : []));
page.on('whatif:clear', () => clearEdits());
page.on('mockups:refresh', () => refreshMockups());
let stopEdits = null;

/** Wires the what-if editor's edits to the decision (page.js calls this once the editor is started; the editor forgets its listeners when a test resets it) */
export function initReview() {
  if (stopEdits) stopEdits();
  stopEdits = onEditsChange(() => page.emit('whatif:edits-changed'));
  pagePiece('decision');
}

/** Approve or send back the open proposal, now (the hold is over; tests and scripts call this directly) */
export async function sendReview(verdict, frozen) { const p = pagePiece('decision'); return p ? p.sendReview(verdict, frozen) : false; }
export async function loadFacts(opts) { const p = pagePiece('decision'); if (p) await p.loadFacts(opts); }

/** For tests: the decision is made again for the page it was on, and uses `clock` for the time shown */
export function resetReviewForTests(clock = () => Date.now()) {
  try { for (const k of Object.keys(sessionStorage)) if (k.startsWith('cornfield.reviewNote.')) sessionStorage.removeItem(k); } catch { /* none */ }
  setPagePieceOptions('decision', { now: clock });
}

/**
 * @module explorer/waiting-line
 *
 * A bridge (spec 0011 D3, step 5): the one line under the proposal bar's buttons when a run is waiting on the open proposal (spec 0010 D2) is part of the
 * proposal's bar (pieces/proposal.js). This file keeps the old names for the Work panel, bound to the page's instance.
 */

import { pageInstance } from './state.js';
import { ensurePagePieces } from './page-pieces.js';

/** Shows the line for `run` (the run waiting on the open proposal), or hides it for null; `key` is what the line is about (the proposal), so a run is said once for it */
export function paintWaitingLine(run, key) { ensurePagePieces(); pageInstance().emit('proposal:waiting', { run, key }); }
/** For tests: forget the line */
export function resetWaitingLineForTests() { pageInstance().emit('proposal:waiting-reset'); }

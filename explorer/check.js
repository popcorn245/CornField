/**
 * @module explorer/check
 *
 * A bridge (spec 0011 D2 and D3, step 5): the checked scenarios are now the instance's (engine/checks.js), part of the changes piece
 * (pieces/changes.js), and the checker is the piece's option. This file keeps the old names for page.js and tests, bound to the page's instance.
 */

import { pagePiece, mergePagePieceOptions } from './page-pieces.js';

/** Hands the page's changes piece its checker (a plugin's adapter); none means every checked step reads "Not checked" */
export function initChecks(opts = {}) { mergePagePieceOptions('changes', { checker: opts.checker || null }); }
/** The verdict for each step of the scenario on the map */
export const scenarioVerdicts = () => { const p = pagePiece('changes'); return p ? p.checks.verdicts() : []; };

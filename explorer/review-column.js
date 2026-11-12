/**
 * @module explorer/review-column
 *
 * A bridge (spec 0011 D2 and D3, step 5): the review column is now a piece (pieces/changes.js). This file keeps the old names for the modules that are
 * not yet on an instance (forge-panel.js, tests), bound to the page's instance and to the piece the page mounts. It goes when the last of those callers
 * is converted.
 */

import { pageInstance } from './state.js';
import { pagePiece, setPagePieceOptions } from './page-pieces.js';

const piece = () => pagePiece('changes');

/** Mounts the column where the page has its place (page.js does; a second call does nothing) */
export function initReviewColumn() { piece(); }
/** Draws the column for the open proposal, or hides it when none is open */
export function renderReviewColumn() { const p = piece(); if (p) p.renderColumn(); }
export function shareRoom() { const p = piece(); if (p) p.shareRoom(); }
/** The PR head the record is keyed by */
export function setPullHead(sha) { const p = piece(); if (p) p.setPullHead(sha); }
/** The counts' parts open their section */
export function showSection(which) { pageInstance().emit('changes:show', which); }
/** What opening a proposal says: "Opened Checkout: 6 changes, 3 scenarios for 2 personas." */
export function reviewOpenedLine(title) { const p = piece(); return p ? p.openedLine(title) : ''; }
/** The phone's peek line: "6 changes · 3 scenarios for 2 personas" */
export function reviewPeekLine() { const p = piece(); return p ? p.peekLine() : ''; }
/** "2 of 3 scenarios played", or '' */
export const playedLine = () => { const a = pageInstance().ask('changes:played-line'); return typeof a === 'string' ? a : ''; };
/** `fn()` after the lists are drawn again. Returns how to stop. */
export const onReviewColumnPaint = (fn) => pageInstance().on('changes:paint', fn);

/** For tests: forget what the column remembered (the piece is made again) */
export function resetReviewColumnForTests() { setPagePieceOptions('changes', undefined); }

/**
 * @module explorer/sheets
 *
 * A bridge (spec 0011 D2, step 4): the phone's bottom sheets now live in engine/sheets.js, one set per instance (the node panel registers its
 * own, pieces/node-panel.js, and so does the proposal's bar, pieces/proposal.js). This file keeps the old names for the modules that are not yet on an
 * instance (the Work list, deep links, the House), bound to the page's instance. It goes when the last of them is converted.
 */

import { pageInstance } from './state.js';
import { ensurePagePieces, pagePiece } from './page-pieces.js';
import * as S from './engine/sheets.js';

export { PHONE_QUERY } from './engine/sheets.js';

const page = () => pageInstance();
export const isPhone = () => S.isPhone(page());
export const sheetState = (id) => S.sheetState(page(), id);
export const expandedSheet = () => S.expandedSheet(page());
export const onCoveredChange = (fn) => S.onCoveredChange(page(), fn);
export const refreshStubs = () => S.refreshStubs(page());
export const showSheet = (id) => S.showSheet(page(), id);
export const measureCovered = () => S.measureCovered(page());
export const visibleMapRect = () => S.visibleMapRect(page());
export const registerSheet = (id, el, opts) => S.registerSheet(page(), id, el, opts);
export const unregisterSheet = (id, redraw) => S.unregisterSheet(page(), id, redraw);
export const expandSheet = (id) => S.expandSheet(page(), id);
export const collapseSheet = (id) => S.collapseSheet(page(), id);
export const collapseAllSheets = () => S.collapseAllSheets(page());
export const toggleSheet = (id) => S.toggleSheet(page(), id);

/** Watches the page's dock (the node panel and the proposal's bar register their sheets as they mount) */
export function initSheets() {
  const inst = page();
  S.initSheets(inst);
  ensurePagePieces(); // the node panel's and the proposal's sheets, if the page has their places
  // A bar the proposal piece did not make (a test's own markup) is a sheet all the same
  const bar = inst.el('proposal-bar');
  if (bar && !pagePiece('proposal')) S.registerSheet(inst, 'proposal', bar, { stub: () => ({ title: (inst.el('proposal-title') && inst.el('proposal-title').textContent) || 'Proposal' }) });
}

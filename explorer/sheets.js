/**
 * @module explorer/sheets
 *
 * A bridge (spec 0011 D2, step 4): the phone's bottom sheets now live in engine/sheets.js, one set per instance (the node panel registers its
 * own, pieces/node-panel.js). This file keeps the old names for the modules that are not yet on an instance (the proposal bar, the review
 * column, the Work panel, the scenario player, deep links, the House), bound to the page's instance, and registers the proposal bar's sheet,
 * which is not a piece yet. It goes when the last of them is converted.
 */

import { pageInstance } from './state.js';
import { ensurePagePieces } from './page-pieces.js';
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

/** Watches the page's dock and registers the proposal bar's sheet (the node panel registers its own as it mounts) */
export function initSheets() {
  const inst = page();
  S.initSheets(inst);
  ensurePagePieces(); // the node panel's sheet, if the page has its place
  S.registerSheet(inst, 'proposal', inst.el('proposal-bar'), { stub: () => ({ title: (inst.el('proposal-title') && inst.el('proposal-title').textContent) || 'Proposal' }) });
}

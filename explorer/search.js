/**
 * @module explorer/search
 *
 * A bridge (spec 0011 D2 and D3, step 4): search is now a piece (pieces/search.js). This file keeps the old names for the modules that are not
 * yet on an instance (page.js, tests), bound to the page's instance and to the piece the page mounts. It goes when page.js is converted.
 */

import { pageInstance } from './state.js';
import { pagePiece } from './page-pieces.js';
import { visibleMapRect } from './engine/sheets.js';
import { MATCH_ZOOM as ZOOM, resultsHtml as html } from './pieces/search.js';
import { noMatchText } from './search-status.js';

export const MATCH_ZOOM = ZOOM;
export { noMatchText };

const piece = () => pagePiece('search');
/** What the current query finds */
export const currentResult = () => piece().currentResult();
export const searchActive = () => { const p = piece(); return !!p && p.searchActive(); };
export const resultsHtml = (result, listId) => html(pageInstance().state, result, listId);
export const paintSearch = (opts) => piece().paintSearch(opts);
export const setQuery = (value) => piece().setQuery(value);
export const chooseMatch = (match, opts) => piece().chooseMatch(match, opts);
export const stepMatch = (by) => { const p = piece(); return !!p && p.stepMatch(by); };
export const frameAll = () => piece().frameAll();
/** The camera that puts `node` in the middle of the part of the map nothing covers */
export function matchTarget(node, zoom) {
  const r = visibleMapRect(pageInstance());
  return { x: r.x + r.width / 2 - node.x * zoom, y: r.y + r.height / 2 - node.y * zoom, zoom };
}
/** Opens or shuts the phone's search bar */
export const toggleMobileSearch = (open) => piece().toggleMobileSearch(open);
/** Mounts the search where the page has its place (page.js calls it once; a second call does nothing) */
export function initSearch() { pagePiece('search'); }
/** For tests: forget what was found */
export function resetSearchForTests() { const p = piece(); if (p) p.reset(); else { const { state } = pageInstance(); state.searchQuery = ''; state.searchCurrent = null; } }

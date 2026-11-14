/**
 * @module explorer/proposal
 *
 * A bridge (spec 0011 D2 and D3, step 5): opening a proposal is the instance's (engine/proposal.js) and the proposal's bar is a piece
 * (pieces/proposal.js). This file keeps the old names for the modules that are not yet on an instance (whatif.js, forge-panel.js, mockups.js, tests),
 * bound to the page's instance and to the pieces the page mounts. It goes when the last of those callers is converted.
 *
 * The `hooks` object is the old chain a module assigned to, each overwriting or wrapping the last. It is kept as accessors that register the function
 * as a listener of the instance (one registration per hook: assigning again takes the last one back), so a chain that wraps `hooks.bar` still works:
 *
 *   hooks.effective  -> ask proposal:effective       hooks.mark -> event proposal:mark           hooks.beforeClose -> ask proposal:before-close
 *   hooks.closed     -> event proposal {closed}      hooks.bar  -> event proposal:bar
 *   hooks.reviewed   -> event decision
 */

import { pageInstance } from './state.js';
import { pageMap } from './render.js';
import { ensurePagePieces, pagePiece } from './page-pieces.js';
import * as E from './engine/proposal.js';
import { problemsHtml as problems, proposalRowHtml as row } from './pieces/proposal.js';
import { openFromAddress, keepAddress } from './page-address.js';

/** The page's instance, with its map and its pieces there */
const page = () => { pageMap(); ensurePagePieces(); return pageInstance(); };

// The old hooks: each is a function a module assigned, registered as a listener of the page instance
const ADAPT = {
  effective: (fn) => ['proposal:effective', (proposal) => fn(proposal)],
  mark: (fn) => ['proposal:mark', ({ applied, effective, proposal }) => { fn(applied, effective, proposal); }],
  beforeClose: (fn) => ['proposal:before-close', () => fn()],
  closed: (fn) => ['proposal', ({ change }) => { if (change === 'closed') fn(); }],
  bar: (fn) => ['proposal:bar', ({ open }) => { fn(open); }],
  reviewed: (fn) => ['decision', ({ open }) => { if (open !== false) fn(); }], // as before: not when another proposal was opened while it was sent
};
const kept = {};
const stops = {};
export const hooks = {};
for (const name of Object.keys(ADAPT)) {
  kept[name] = null;
  Object.defineProperty(hooks, name, {
    enumerable: true,
    get: () => kept[name],
    set(fn) {
      if (stops[name]) { stops[name](); stops[name] = null; }
      kept[name] = typeof fn === 'function' ? fn : null;
      if (kept[name]) { const [event, listener] = ADAPT[name](kept[name]); stops[name] = pageInstance().on(event, listener); }
    },
  });
}

/** What the server listed last, for the Work list's Specs tab: the entries (null before the first answer), why the list could not be read, why the spec PRs are missing, and when */
export const proposalListing = () => E.proposalListing(pageInstance());
/** Calls `fn` each time the list is read again; returns the way to stop */
export const onProposalListing = (fn) => E.onProposalListing(pageInstance(), fn);
export const loadProposalList = () => E.loadProposalList(page());
export const openProposal = (slug, source = null) => E.openProposal(page(), slug, source);
export const showProposal = (proposal, opts) => E.showProposal(page(), proposal, opts);
export const rebuildProposalMap = (effective, opts) => E.rebuildProposalMap(page(), effective, opts);
export const closeProposal = () => E.closeProposal(page());
export const setProposalView = (view, opts) => E.setProposalView(page(), view, opts);
export const focusChange = (kind, key, opts) => E.focusChange(page(), kind, key, opts);
export const markedEdgeAt = (x, y, tolerance) => E.markedEdgeAt(page(), x, y, tolerance);
export const showEdgePanel = (edge) => E.showEdge(page(), edge);
export const renderBar = () => E.drawBar(page());
export const problemsHtml = problems;
export const proposalRowHtml = row;

/**
 * Starts the overlay on the page: the pieces are mounted, and `/?proposal=<slug>` (and `&source=`, `&proposalView=`) opens one, as page.js does.
 * @returns {Promise<boolean>} whether a proposal from the address opened (false when it asked for none)
 */
export async function initProposals() {
  const inst = page();
  keepAddress(inst);
  E.drawBar(inst);
  return openFromAddress(inst, typeof location === 'undefined' ? '' : location.search);
}

/** The bar piece the page mounted, or null */
export const proposalPiece = () => pagePiece('proposal');

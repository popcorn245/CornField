/**
 * @module explorer/forge-panel
 *
 * A bridge (spec 0011 D2 and D3, step 6): the Work panel is a piece on the instance (pieces/work.js, with a part per tab in pieces/work-*.js) and its
 * pure half is forge-panel-model.js. This file keeps the old names for the page (page.js, deep-link.js, panels.js) and for the tests that drive the
 * panel through cornfield's own page, bound to the page's instance and to the piece the page mounts at the places in index.html. It goes when
 * those callers are on the instance (the `corn-work` shell for a host, and a page shell that mounts the piece itself).
 */

import { pagePiece, setPagePieceOptions } from './page-pieces.js';
import { initConnection, resetConnectionForTests } from './connection.js';
import { pageInstance } from './state.js';
import { resetFeedback } from './engine/feedback.js';
import { RUNS_POLL_MS, SPECS_POLL_MS } from './pieces/work.js';

export { RUNS_POLL_MS, SPECS_POLL_MS };

const piece = () => pagePiece('work');

/**
 * Starts the panel (page.js calls this once the config is read). With no forge in the config, or nobody signed in, the button and the panel stay
 * hidden, and this returns false.
 * @param {{ forge?: { type: string, repo: string } | null, signIn?: false | { login: string } }} config what `/cornfield/config.json` said
 * @param {{ clock?: () => number }} [opts] `clock` for the times shown (tests)
 * @returns {boolean} whether the panel is on
 */
export function initForgePanel(config, opts = {}) {
  const p = piece();
  if (!p) return false;
  p.update(opts.clock ? { clock: opts.clock, config } : { config });
  const on = p.isOn();
  if (on) initConnection(); // the offline banner (explorer/connection.js) is the page's; it follows the Work panel, as it always has
  return on;
}

/** For tests: forget the page this was wired to, and everything shown */
export function resetForgePanelForTests(clock) {
  setPagePieceOptions('work', clock ? { clock } : undefined);
  resetFeedback(pageInstance());
  resetConnectionForTests();
}

export const isForgeOpen = () => { const p = piece(); return !!p && p.isForgeOpen(); };
export const openForge = (opts) => { const p = piece(); if (p) p.openForge(opts); };
export const closeForge = (opts) => { const p = piece(); if (p) p.closeForge(opts); };
export const toggleForge = () => { const p = piece(); if (p) p.toggleForge(); };
export const refreshForge = (opts) => { const p = piece(); return p ? p.refreshForge(opts) : Promise.resolve(); };
export const clearPull = () => { const p = piece(); if (p) p.clearPull(); };
export const clearDeploy = () => { const p = piece(); if (p) p.clearDeploy(); };
export const clearThread = () => { const p = piece(); if (p) p.clearThread(); };
export const selectDeploy = (id) => { const p = piece(); if (p) p.selectDeploy(id); };
export const openRunLink = (id) => { const p = piece(); return p && p.isOn() ? p.openRunLink(id) : Promise.resolve(false); };
export const openIssueLink = (n) => { const p = piece(); return p && p.isOn() ? p.openIssueLink(n) : Promise.resolve(false); };
export const openProposalStart = (slug, opener) => { const p = piece(); return p && p.isOn() ? p.openProposalStart(slug, opener) : Promise.resolve(false); };
export const canStartAgent = () => { const p = piece(); return !!p && p.canStartAgent(); };

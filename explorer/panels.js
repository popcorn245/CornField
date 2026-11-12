/**
 * @module explorer/panels
 *
 * A bridge (spec 0011 D2 and D3, step 4): the node panel is now a piece (pieces/node-panel.js) and choosing a node is the instance's
 * (engine/selection.js). This file keeps the old names for the modules that are not yet on an instance (forge-panel.js, house.js, proposal.js,
 * review-column.js, page.js), bound to the page's instance, and answers for the unconverted neighbours the piece asks (the live layer's
 * block, the Start dialog). It goes when the last of those callers is converted.
 */

import { pageInstance } from './state.js';
import { liveSection, hydrateLivePhotos } from './live.js';
import { canStartAgent, openProposalStart } from './forge-panel.js';
import { selectNode as select, clearSelection } from './engine/selection.js';
import { diffPillWords as pill, LINES_CAP as CAP, copySpec as copy } from './pieces/node-panel.js';
import { pagePiece } from './page-pieces.js';

export const LINES_CAP = CAP;

// What the node panel asks of neighbours that are not on an instance yet, answered for the page's instance
const page = pageInstance();
page.on('live:section', (node) => liveSection(node));
page.on('live:hydrate', (el) => { hydrateLivePhotos(el); });
page.on('forge:can-start', () => canStartAgent());
page.on('forge:start', ({ slug, returnTo }) => { openProposalStart(slug, returnTo); });

/** Selects a node: lights what is one edge from it on the map and fills the side panel. `frame`: the camera follows (a search, a list, a link, the keyboard) */
export async function selectNode(node, { frame = false, source = frame ? 'link' : 'api' } = {}) {
  pagePiece('node-panel'); // the panel is mounted where the page has its place
  select(pageInstance(), node, { frame, source });
}

export function closeDrawer() {
  pagePiece('node-panel');
  clearSelection(pageInstance(), { source: 'api' });
}

/** "Added by Checkout": the pill for a node the open proposal touches; '' for one it leaves alone */
export const diffPillWords = (node) => pill(node, pageInstance().state.proposal);
export const repaintThreads = () => { const p = pagePiece('node-panel'); if (p) p.repaintThreads(); };
export const keepSelectedInView = () => { const p = pagePiece('node-panel'); if (p) p.keepSelectedInView(); };
export const startRun = () => { const p = pagePiece('node-panel'); if (p) p.startRun(); };
/** Copies the selected node as JSON (the Copy Spec button); `button` is kept for the old signature */
export const copySpec = () => copy(pageInstance(), pageInstance().el('copy-spec-result'));

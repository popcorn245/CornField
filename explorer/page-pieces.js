/**
 * @module explorer/page-pieces
 *
 * cornfield's page mounts the pieces (explorer/pieces/) into the document (spec 0011 D3). `index.html` keeps only the place of each: a comment
 * `<!--corn-piece:NAME/SLOT-->` where the piece's markup goes (the piece's elements are inserted before it). This module finds those places,
 * mounts the piece there on the page's instance, and keeps the handle (`pagePiece(name)`) for the bridges the modules that are not yet on an
 * instance still call (explorer/panels.js, layers.js, search.js).
 *
 * `ensurePagePieces()` is page.js's one call at start. The bridges call it too: where the document's markup was replaced (a test sets
 * `document.body.innerHTML` again), a piece whose places are gone is ended and mounted again at the new ones; where nothing changed it does
 * nothing. A piece whose places are not in the document is not mounted.
 *
 * This is page code, not a piece: it reads the page instance (state.js) and the document. It goes when the bridges do.
 */

import { pageInstance } from './state.js';
import { pageMap } from './render.js';
import * as nodePanel from './pieces/node-panel.js';
import * as layers from './pieces/layers.js';
import * as search from './pieces/search.js';
import * as proposal from './pieces/proposal.js';
import * as changes from './pieces/changes.js';
import * as decision from './pieces/decision.js';

/** The pieces of the page, in the order they are mounted (the node panel registers its sheet; search and the Layers menu follow the map) */
const PIECES = { 'node-panel': nodePanel, layers, search, proposal, changes, decision }; // (the decision's place is inside the changes piece's column: it follows it)
const mounted = new Map(); // name -> { handle, markers: Comment[] }
const optionsOf = new Map(); // name -> what the page tells a piece besides its places (a checker, a clock)

/** The marker comments of a piece in the document: { slot: Comment } */
function markersOf(doc, name) {
  const found = {};
  if (!doc || !doc.body) return found;
  const walker = doc.createTreeWalker(doc.body, 128 /* NodeFilter.SHOW_COMMENT */);
  const prefix = `corn-piece:${name}/`;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.data.startsWith(prefix)) found[node.data.slice(prefix.length)] = node;
  }
  return found;
}

/** The places of a piece the page mounts itself (the map: page.js), by slot: `{ stage: Comment }` */
export function pieceSlots(name) {
  return markersOf(pageInstance().doc, name);
}

/** Mounts each piece at its places in the document, or again where the places were replaced; ends one whose places are gone. Returns the handles by name. */
export function ensurePagePieces() {
  const inst = pageInstance();
  const doc = inst.doc;
  if (!doc) return {};
  for (const [name, piece] of Object.entries(PIECES)) {
    const have = mounted.get(name);
    if (have && (have.forced ? have.handle.elements.every((el) => el.isConnected) : have.markers.every((m) => m.isConnected))) continue;
    if (have) { have.handle.destroy(); mounted.delete(name); }
    const slots = markersOf(doc, name);
    const markers = Object.values(slots);
    if (!markers.length) continue;
    pageMap(); // the pieces follow the page's map: it is there before they are
    mounted.set(name, { handle: piece.mount(doc.body, inst, { ...(optionsOf.get(name) || {}), slots }), markers });
  }
  return Object.fromEntries([...mounted].map(([name, { handle }]) => [name, handle]));
}

/**
 * What the page tells a piece besides its places (`mount`'s options: the changes piece's checker, the decision's clock). A piece already mounted is
 * ended and mounted again with them, at its places.
 */
export function setPagePieceOptions(name, options) {
  if (options === undefined) optionsOf.delete(name); else optionsOf.set(name, options);
  const have = mounted.get(name);
  if (have) { have.handle.destroy(); mounted.delete(name); }
  ensurePagePieces();
}

/** Adds to what the page tells a piece without ending it: the piece hears it as `update(patch)` (and takes it when it is mounted next) */
export function mergePagePieceOptions(name, patch) {
  optionsOf.set(name, { ...(optionsOf.get(name) || {}), ...patch });
  const have = mounted.get(name);
  if (have) have.handle.update(patch);
}

/** The page's mounted piece by name ('node-panel', 'layers', 'search', 'proposal', 'changes', 'decision'), or null; `anywhere`: mounted at the end of the body when the page has no place for it */
export function pagePiece(name, { anywhere = false } = {}) {
  ensurePagePieces();
  // A caller that needs the piece whether or not the page has a place for it (a test drives the scenario player on a bare stage) has it at the end of the body
  if (anywhere && !mounted.has(name) && PIECES[name] && pageInstance().doc) {
    const inst = pageInstance();
    pageMap();
    mounted.set(name, { handle: PIECES[name].mount(inst.doc.body, inst, { ...(optionsOf.get(name) || {}), slots: {} }), markers: [], forced: true });
  }
  const have = mounted.get(name);
  return have ? have.handle : null;
}

/**
 * @module explorer/keyboard
 *
 * A bridge (spec 0011 D2, step 4): the map by keyboard and the screen reader's announcer now live in engine/keyboard.js, one per instance; the
 * keys of the node panel, the Layers menu and the search belong to those pieces. This file keeps the old names for the modules that are not
 * yet on an instance (they call `announce`), bound to the page's instance. It goes when the last of them is converted.
 */

import { pageInstance } from './state.js';
import { ensurePagePieces } from './page-pieces.js';
import * as K from './engine/keyboard.js';

export const announce = (text) => K.announce(pageInstance(), text);
export const centreTarget = (node, zoom) => K.centreTarget(pageInstance(), node, zoom);
export const centreOn = (node) => K.centreOn(pageInstance(), node);
export const frameThem = () => K.frameThem(pageInstance());
/** Wires the map's keys on the page, and the pieces' (the panel's Escape, the Layers menu's, the search's `/`) where the page has them */
export function initKeyboard() {
  ensurePagePieces();
  K.initKeyboard(pageInstance());
}
/** For tests: wire again on a fresh page */
export const resetKeyboardForTests = () => K.resetKeyboard(pageInstance());

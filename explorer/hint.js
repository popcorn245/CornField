/**
 * @module explorer/hint
 *
 * A bridge (spec 0011 D2, step 4): the hint at the map's corner now lives in engine/hint.js, one per instance. This file keeps the old names for
 * the modules that are not yet on an instance (page.js, view.js), bound to the page's instance. It goes when view.js and page.js are converted.
 */
import { pageInstance } from './state.js';
import * as H from './engine/hint.js';

export { HINT_STORAGE_KEY, hintWords } from './engine/hint.js';
export const coarsePointer = (win = typeof window !== 'undefined' ? window : null) => H.coarsePointer(win);
export const hintText = (coarse) => H.hintText(pageInstance(), coarse);
export const dismissHint = () => H.dismissHint(pageInstance());
export const resetHintForTests = () => H.resetHint(pageInstance());
/** @param {Document} [doc] kept for the old signature: the page instance is over the document */
export const mapCovered = (doc) => H.mapCovered(doc && doc !== pageInstance().root ? { el: (id) => doc.getElementById(id), root: doc } : pageInstance());
export const syncHint = () => H.syncHint(pageInstance());
/** @param {Document} [doc] kept for the old signature */
export const watchHint = () => H.watchHint(pageInstance());

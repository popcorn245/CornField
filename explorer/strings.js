/**
 * @module explorer/strings
 *
 * A bridge (spec 0011 D2, step 4): the words now live on the instance (`inst.strings`, read with `t(inst, key)` from engine/strings.js).
 * This file keeps the old names for the modules that are not yet on an instance, bound to the page's voice: `pageStrings`, the object the page
 * instance's `strings` is (state.js hands it over), so the two are one. It imports nothing of the page's state, because pure models read the words
 * through it (waiting-model.js) and the converted modules import those. It goes when the last caller (forge-panel.js, proposal.js, review.js,
 * review-column.js, whatif.js, scenario-ui.js, runs-view.js, waiting-*.js, plugins.js) is converted.
 */
import * as S from './engine/strings.js';

/** The overrides in force on cornfield's page: key -> text */
export const pageStrings = {};
const voice = { strings: pageStrings, root: null };

/** Takes the overrides the config carries (`config.strings`) */
export const setStrings = (strings) => S.setStrings(voice, strings);
/** Whether the config overrides this key */
export const isOverridden = (key) => S.isOverridden(voice, key);
/** The words for a key: the override, else the default */
export const t = (key) => S.t(voice, key);
/** Puts the overrides in the static markup under `root` */
export const applyStrings = (root) => S.applyStrings(voice, root);
/** For tests: forget the overrides */
export const resetStringsForTests = () => S.setStrings(voice, {});

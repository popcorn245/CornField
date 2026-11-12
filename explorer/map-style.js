/**
 * @module explorer/map-style
 *
 * A bridge (spec 0011 D2, step 1): the map's styling now lives in engine/map-style.js, one style per instance. This file keeps the
 * old names for the modules that are not yet on an instance (layers.js, theme.js, proposal.js, main.js's old callers), bound to the page's
 * instance. A module that is converted reads `mapStyleOf(inst)` from the engine and stops importing this file.
 */

import { pageInstance } from './state.js';
import { mapStyleOf, styledScene as styled, looksWith as looks } from './engine/map-style.js';

export * from './engine/map-style.js';

const style = () => mapStyleOf(pageInstance());

/** The page's map style */
export const getMapStyle = () => style().get();
export const onMapStyleChange = (fn) => style().onChange(fn);
export const setMapSubjects = (subjects) => style().setSubjects(subjects);
/** Reads the tokens again; `read` defaults to the page's computed style (`<html>`) */
export const refreshMapStyle = (read) => style().refresh(read);
export const setMapIcons = (theme, opts) => style().setIcons(theme, opts);
/** @param {Document} [doc] kept for the old signature: the page instance is over the document */
export const applyMapTheme = (doc, theme, opts) => style().applyTheme(theme, opts);
export const resetMapStyle = () => style().reset();
/** Keeps the page's style right as the theme changes; returns how to stop */
export const watchMapStyle = () => style().watch();
/** A reader of the page's computed custom properties, or null where there is no page */
export const pageReader = () => pageInstance().tokenReader();
export const styledScene = (scene, s = getMapStyle()) => styled(scene, s);
export const looksWith = (l, s = getMapStyle()) => looks(l, s);

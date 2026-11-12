/**
 * @module explorer/layout
 *
 * A bridge (spec 0011 D2, step 1): where every node sits is now laid out by engine/layout.js, on an instance. This file keeps the old
 * names for the modules that are not yet on one (view.js, keyboard.js), bound to the page's instance.
 */

import { pageInstance } from './state.js';
import * as L from './engine/layout.js';

export { STORAGE_KEY } from './engine/layout.js';

export const computeDegreeCentrality = () => L.computeDegreeCentrality(pageInstance());
export const labelWidth = (node) => L.labelWidth(pageInstance(), node);
export const computeOrbitalLayout = () => L.computeOrbitalLayout(pageInstance());
export const computeLaneLayout = (flow) => L.computeLaneLayout(pageInstance(), flow);
export const loadFreeformPositions = () => L.loadFreeformPositions(pageInstance());
export const saveFreeformPositions = () => L.saveFreeformPositions(pageInstance());
export const clearFreeformPositions = () => L.clearFreeformPositions(pageInstance());
export const applyFreeformPositions = () => L.applyFreeformPositions(pageInstance());
export const layoutOrbit = () => L.layoutOrbit(pageInstance());

/**
 * @module explorer/fly
 *
 * A bridge (spec 0011 D2, step 4): the camera's flight now lives in engine/fly.js, one per instance. This file keeps the old names for the
 * modules that are not yet on an instance (page.js). It goes when page.js is converted.
 */
import { pageInstance } from './state.js';
import { pageMap } from './render.js';
import * as F from './engine/fly.js';

export { FLY_MS } from './engine/fly.js';
const page = () => { pageMap(); return pageInstance(); }; // the flight joins the page map's loop, so the map is there first
export const flyTo = (target) => F.flyTo(page(), target);
export const stopFlight = () => F.stopFlight(page());
export const flying = () => F.flying(page());
export const tickFlight = (now) => F.tickFlight(page(), now);

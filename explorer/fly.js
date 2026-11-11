/**
 * @module explorer/fly
 *
 * The camera flying to a place: a short glide to `{ x, y, zoom }`, as the scenario player's steps do, so a match chosen in a search
 * is not a jump the eye has to find again. Under reduced motion the camera jumps. A new flight replaces the one in the air, and a
 * hand on the map (a pan, a wheel) is not fought: `stopFlight()` ends it (input.js calls it when the pointer takes the camera).
 * It is a frame client of render.js's loop, so it asks for frames only while it flies.
 */

import { state } from './state.js';
import { render, ensureFlowLoop, addFrameClient } from './render.js';
import { flowReduceMotion } from './flows.js';

/** How quickly the camera closes on the target: the time constant of the glide (ms) */
export const FLY_MS = 120;
let glide = null; // { to: {x, y, zoom}, last: nowMs|null }

/** Flies the camera to `target` (jumps there when motion is reduced) */
export function flyTo(target) {
  if (!target) return;
  if (flowReduceMotion || !state.width) { Object.assign(state.camera, target); glide = null; render(); return; }
  glide = { to: { ...target }, last: null };
  ensureFlowLoop();
}

/** Ends a flight where it is */
export function stopFlight() { glide = null; }

/** Whether the camera is in the air */
export const flying = () => !!glide;

/** One frame of the glide (exported so a test can be the loop) */
export function tickFlight(now) {
  if (!glide) return;
  const dt = glide.last === null ? 16 : Math.min(now - glide.last, 100);
  glide.last = now;
  const k = 1 - Math.exp(-dt / FLY_MS);
  const cam = state.camera;
  cam.x += (glide.to.x - cam.x) * k;
  cam.y += (glide.to.y - cam.y) * k;
  cam.zoom += (glide.to.zoom - cam.zoom) * k;
  if (Math.abs(glide.to.x - cam.x) < 0.5 && Math.abs(glide.to.y - cam.y) < 0.5 && Math.abs(glide.to.zoom - cam.zoom) < 0.002) {
    Object.assign(cam, glide.to);
    glide = null;
  }
}

addFrameClient({ wants: flying, tick: tickFlight });

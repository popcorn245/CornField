/**
 * @module explorer/engine/fly
 *
 * The camera flying to a place, on an instance: a short glide to `{ x, y, zoom }`, as the scenario player's steps do, so a match chosen in a
 * search is not a jump the eye has to find again. Under reduced motion the camera jumps. A new flight replaces the one in the air, and a
 * hand on the map (a pan, a wheel) is not fought: `stopFlight(inst)` ends it (the page calls it when the pointer takes the camera, on `grab`).
 * It is a frame client of the instance's map loop, so it asks for frames only while it flies. explorer/fly.js keeps the old names for the page.
 */

/** How quickly the camera closes on the target: the time constant of the glide (ms) */
export const FLY_MS = 120;

/** The flight of one instance: made on first use, joined to the map's frame loop */
function flightOf(inst) {
  return inst.slot('fly', () => {
    const f = { glide: null }; // { to: {x, y, zoom}, last: nowMs|null }
    f.tick = (now) => {
      if (!f.glide) return;
      const dt = f.glide.last === null ? 16 : Math.min(now - f.glide.last, 100);
      f.glide.last = now;
      const k = 1 - Math.exp(-dt / FLY_MS);
      const cam = inst.state.camera;
      cam.x += (f.glide.to.x - cam.x) * k;
      cam.y += (f.glide.to.y - cam.y) * k;
      cam.zoom += (f.glide.to.zoom - cam.zoom) * k;
      if (Math.abs(f.glide.to.x - cam.x) < 0.5 && Math.abs(f.glide.to.y - cam.y) < 0.5 && Math.abs(f.glide.to.zoom - cam.zoom) < 0.002) {
        Object.assign(cam, f.glide.to);
        f.glide = null;
      }
    };
    f.off = inst.map ? inst.map.addFrameClient({ wants: () => !!f.glide, tick: f.tick }) : null;
    if (f.off) inst.own(f.off);
    return f;
  });
}

/** Flies the camera to `target` (jumps there when motion is reduced) */
export function flyTo(inst, target) {
  if (!target) return;
  const f = flightOf(inst);
  const { state } = inst;
  if (inst.reducedMotion || !state.width) { Object.assign(state.camera, target); f.glide = null; inst.map.render(); return; }
  f.glide = { to: { ...target }, last: null };
  inst.map.ensureFlowLoop();
}

/** Ends a flight where it is */
export function stopFlight(inst) { flightOf(inst).glide = null; }

/** Whether the camera is in the air */
export const flying = (inst) => !!flightOf(inst).glide;

/** One frame of the glide (exported so a test can be the loop) */
export function tickFlight(inst, now) { flightOf(inst).tick(now); }

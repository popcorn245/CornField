/**
 * @module explorer/camera
 *
 * The camera maths input.js uses, as pure functions on `{ x, y, zoom }` (screen px of the world
 * origin, and the scale): `screen = camera.xy + world * zoom`. No DOM, no state.
 *
 * The rule for zooming by hand: the world point under the pointer (or between two fingers) stays
 * where it is on screen, so you zoom into what you are pointing at.
 *
 * @typedef {{ x: number, y: number, zoom: number }} Camera
 */

/** The floor of a map that fits above it; a bigger map (or a smaller screen) needs a lower one: render.js `getMinZoom()` */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 3.0;
/** Whatever the map, never below this (a bounding box of nothing, a map of a million px) */
export const ZOOM_FLOOR = 0.005;

/** `min` is the floor for this map and screen (`getMinZoom()`); it never rises above the default floor */
export const clampZoom = (zoom, min = ZOOM_MIN) => Math.max(Math.max(ZOOM_FLOOR, Math.min(min, ZOOM_MIN)), Math.min(ZOOM_MAX, zoom));

/** Zooming out is never zooming in: below the floor already (the layers changed), a step out stays where it is */
const stepZoom = (from, to, min) => (to < from ? Math.min(from, clampZoom(to, min)) : clampZoom(to, min));

/**
 * The camera after zooming by `factor` with the screen point (px, py) held still.
 * @param {Camera} camera
 * @param {number} factor
 * @param {number} [min] the floor for this map
 * @returns {Camera}
 */
export function zoomAbout(camera, factor, px, py, min = ZOOM_MIN) {
  const zoom = stepZoom(camera.zoom, camera.zoom * factor, min);
  const wx = (px - camera.x) / camera.zoom; // the world point under the pointer
  const wy = (py - camera.y) / camera.zoom;
  return { x: px - wx * zoom, y: py - wy * zoom, zoom };
}

/**
 * The start of a two-finger gesture: the camera, the distance between the fingers and their middle.
 * @param {Camera} camera
 * @param {number} dist
 * @param {{ x: number, y: number }} mid
 */
export const pinchStart = (camera, dist, mid) => ({ x: camera.x, y: camera.y, zoom: camera.zoom, dist, mid: { x: mid.x, y: mid.y } });

/**
 * The camera while two fingers are down: zoom by how far apart they are now, compared with the
 * start, and keep the world point that was under their middle at the start under their middle now
 * (so moving both fingers together pans, spreading them zooms into the point between them).
 * @param {ReturnType<typeof pinchStart>} start
 * @param {number} dist the distance between the fingers now
 * @param {{ x: number, y: number }} mid their middle now
 * @returns {Camera}
 */
export function pinchCamera(start, dist, mid, min = ZOOM_MIN) {
  const zoom = stepZoom(start.zoom, start.zoom * (dist / start.dist), min);
  const wx = (start.mid.x - start.x) / start.zoom;
  const wy = (start.mid.y - start.y) / start.zoom;
  return { x: mid.x - wx * zoom, y: mid.y - wy * zoom, zoom };
}

/**
 * The camera panned (never zoomed) so a world point is inside `box` (screen px), or null when it already is. A point
 * outside is put in the middle of the box, on the axis it is outside of. `pad` is the room it needs from the edge
 * (its disc and a little more); a box smaller than twice that is the centre only.
 * @param {Camera} camera
 * @param {{ x: number, y: number }} point world position
 * @param {{ left: number, top: number, right: number, bottom: number }} box the part of the screen that shows the map
 * @param {number} [pad]
 * @returns {Camera|null}
 */
export function panIntoView(camera, point, box, pad = 0) {
  const sx = camera.x + point.x * camera.zoom;
  const sy = camera.y + point.y * camera.zoom;
  const px = Math.min(pad, (box.right - box.left) / 2);
  const py = Math.min(pad, (box.bottom - box.top) / 2);
  const outX = sx < box.left + px || sx > box.right - px;
  const outY = sy < box.top + py || sy > box.bottom - py;
  if (!outX && !outY) return null;
  return {
    x: outX ? (box.left + box.right) / 2 - point.x * camera.zoom : camera.x,
    y: outY ? (box.top + box.bottom) / 2 - point.y * camera.zoom : camera.y,
    zoom: camera.zoom,
  };
}

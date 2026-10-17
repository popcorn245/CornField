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

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 3.0;

export const clampZoom = (zoom) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));

/**
 * The camera after zooming by `factor` with the screen point (px, py) held still.
 * @param {Camera} camera
 * @param {number} factor
 * @returns {Camera}
 */
export function zoomAbout(camera, factor, px, py) {
  const zoom = clampZoom(camera.zoom * factor);
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
export function pinchCamera(start, dist, mid) {
  const zoom = clampZoom(start.zoom * (dist / start.dist));
  const wx = (start.mid.x - start.x) / start.zoom;
  const wy = (start.mid.y - start.y) / start.zoom;
  return { x: mid.x - wx * zoom, y: mid.y - wy * zoom, zoom };
}

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

// ---------------------------------------------------------------------------
//  Framing: put these nodes in the part of the map nothing covers
// ---------------------------------------------------------------------------

/** The zoom at which a node's label is about 11px on screen (labels are 11px in world units from LABEL_ZOOM up, scene.js): where a step or a picked change is shown */
export const READ_ZOOM = 1.0;

/**
 * The part of a `width` × `height` map that nothing covers, given what covers it from each side (px).
 * Never smaller than `minSize` in either direction: when the covers leave less, they are eased until it fits.
 * @param {number} width
 * @param {number} height
 * @param {{ top?: number, bottom?: number, left?: number, right?: number }} [covers]
 * @param {number} [minSize]
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function freeRect(width, height, covers = {}, minSize = 120) {
  const take = (total, a = 0, b = 0) => {
    const lo = Math.max(0, a);
    const hi = Math.max(0, b);
    const room = Math.max(0, total - minSize);
    const scale = lo + hi > room && lo + hi > 0 ? room / (lo + hi) : 1;
    return [lo * scale, hi * scale];
  };
  const [top, bottom] = take(height, covers.top, covers.bottom);
  const [left, right] = take(width, covers.left, covers.right);
  return { x: left, y: top, width: Math.max(0, width - left - right), height: Math.max(0, height - top - bottom) };
}

/**
 * The camera that shows `items` (nodes with `x`, `y` and maybe `r`) inside `rect`, with their labels (room below each) and `padding` px to spare.
 * The zoom is the largest that fits, between `minZoom` and `maxZoom`; when even `minZoom` does not fit, `minZoom` wins and the nodes
 * are centred (the fit never goes under the map's own zoom limit, whatever that is).
 * @param {{ x: number, y: number, r?: number }[]} items
 * @param {{ x: number, y: number, width: number, height: number }} rect CSS px, in the canvas's own coordinates
 * @param {{ padding?: number, maxZoom?: number, minZoom?: number }} [opts]
 * @returns {Camera | null} null for no items
 */
export function frameNodes(items, rect, { padding = 40, maxZoom = 1, minZoom = ZOOM_MIN } = {}) {
  if (!items.length) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of items) {
    const r = n.r || 18;
    minX = Math.min(minX, n.x - r - 25);
    maxX = Math.max(maxX, n.x + r + 25);
    minY = Math.min(minY, n.y - r - 25);
    maxY = Math.max(maxY, n.y + r + 35); // room for the label below
  }
  const pad = Math.min(padding, rect.width / 4, rect.height / 4);
  const fit = Math.min((rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY));
  const zoom = Math.max(minZoom, Math.min(maxZoom, fit));
  return { x: rect.x + rect.width / 2 - ((minX + maxX) / 2) * zoom, y: rect.y + rect.height / 2 - ((minY + maxY) / 2) * zoom, zoom };
}

/** Whether every one of `items` is inside `rect` (with `margin` px to spare) under `camera` */
export function allInside(items, camera, rect, margin = 0) {
  return items.every((n) => {
    const sx = camera.x + n.x * camera.zoom;
    const sy = camera.y + n.y * camera.zoom;
    return sx >= rect.x + margin && sx <= rect.x + rect.width - margin && sy >= rect.y + margin && sy <= rect.y + rect.height - margin;
  });
}

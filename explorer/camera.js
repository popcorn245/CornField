/**
 * @module explorer/camera
 *
 * The camera maths input.js uses, as pure functions on `{ x, y, zoom }` (screen px of the world
 * origin, and the scale): `screen = camera.xy + world * zoom`. No DOM, no state.
 *
 * The rule for zooming by hand: the world point under the pointer (or between two fingers) stays
 * where it is on screen, so you zoom into what you are pointing at.
 *
 * Where a review's camera goes (a change opened, a scenario's step, a panel's node: `READ_ZOOM`, `largestGroup`, `allInside`, `panIntoView`) is
 * camera-frame.js's: a map alone does not carry it (the components' size budget, spec 0011 D11).
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

// ---------------------------------------------------------------------------
//  Framing: put these nodes in the part of the map nothing covers
// ---------------------------------------------------------------------------

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

/** The box a node needs on the map (world px): its disc, a little room round it and its label below */
export const boxOf = (n) => {
  const r = n.r || 18;
  return { left: n.x - r - 25, right: n.x + r + 25, top: n.y - r - 25, bottom: n.y + r + 35 };
};
/** The padding round a framed set, never more than a quarter of the rect */
export const padFor = (padding, rect) => Math.min(padding, rect.width / 4, rect.height / 4);

/**
 * The camera that shows `items` (nodes with `x`, `y` and maybe `r`) inside `rect`, with their labels (room below each) and `padding` px to spare.
 * The zoom is the largest that fits, between `minZoom` and `maxZoom`; when even `minZoom` does not fit, `minZoom` wins and the nodes
 * are centred (the fit never goes under the floor it is given; see camera-frame.js `largestGroup` for what to frame then).
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
    const b = boxOf(n);
    minX = Math.min(minX, b.left);
    maxX = Math.max(maxX, b.right);
    minY = Math.min(minY, b.top);
    maxY = Math.max(maxY, b.bottom);
  }
  const pad = padFor(padding, rect);
  const fit = Math.min((rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY));
  const zoom = Math.max(minZoom, Math.min(maxZoom, fit));
  return { x: rect.x + rect.width / 2 - ((minX + maxX) / 2) * zoom, y: rect.y + rect.height / 2 - ((minY + maxY) / 2) * zoom, zoom };
}

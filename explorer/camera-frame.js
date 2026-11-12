/**
 * @module explorer/camera-frame
 *
 * Where a review's camera goes, as pure functions on `{ x, y, zoom }` (camera.js's): the zoom a step or a picked change is read at
 * (`READ_ZOOM`), the lowest a change is framed at (`FRAME_ZOOM_MIN`) and the most of it that fits there (`largestGroup`), whether a set is all in
 * view (`allInside`), and the pan that brings a node out from under a panel (`panIntoView`). The proposal bar, the scenario player and the node
 * panel use them; a map alone does not (the components' size budget, spec 0011 D11). No DOM, no state.
 *
 * @typedef {import('./camera.js').Camera} Camera
 */

import { boxOf, padFor } from './camera.js';

/** The zoom at which a node's label is about 11px on screen (a label is never drawn under 11px, labels.js): where a step or a picked change is shown */
export const READ_ZOOM = 1.0;
/**
 * The lowest zoom a change is framed at when it opens (proposal.js `fitToChange`): below it node discs and marks run together, so a change
 * wider than this shows is framed where most of it is (`largestGroup`), not shrunk to a speck; the rest is a row of the change list away.
 * The map's own floor (render.js `getMinZoom()`, low enough for the whole map) is what hand zoom and Fit go down to.
 */
export const FRAME_ZOOM_MIN = 0.18;

/** Whether every one of `items` is inside `rect` (with `margin` px to spare) under `camera` */
export function allInside(items, camera, rect, margin = 0) {
  return items.every((n) => {
    const sx = camera.x + n.x * camera.zoom;
    const sy = camera.y + n.y * camera.zoom;
    return sx >= rect.x + margin && sx <= rect.x + rect.width - margin && sy >= rect.y + margin && sy <= rect.y + rect.height - margin;
  });
}

/**
 * The most of `items` that fit in `rect` together at `minZoom`: all of them when they fit, else the biggest group a window of that size
 * holds (so a change spread wider than the lowest zoom shows is framed where most of it is, not on the empty ground between).
 * @param {{ x: number, y: number, r?: number }[]} items
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {{ padding?: number, minZoom?: number }} [opts]
 */
export function largestGroup(items, rect, { padding = 40, minZoom = FRAME_ZOOM_MIN } = {}) {
  if (items.length < 2) return items;
  const pad = padFor(padding, rect);
  const w = (rect.width - pad * 2) / minZoom;
  const h = (rect.height - pad * 2) / minZoom;
  const boxes = items.map(boxOf);
  const holds = (left, top) => items.filter((_, i) => boxes[i].left >= left && boxes[i].right <= left + w && boxes[i].top >= top && boxes[i].bottom <= top + h);
  // Every window worth trying has its left edge on some node's box and its top edge on some node's (a big change: only each node's own corner)
  const lefts = boxes.map((b) => b.left);
  const tops = boxes.map((b) => b.top);
  let best = [];
  const pairs = items.length <= 120 ? lefts.flatMap((l) => tops.map((t) => [l, t])) : boxes.map((b) => [b.left, b.top]);
  for (const [l, t] of pairs) {
    if (best.length === items.length) break;
    const got = holds(l, t);
    if (got.length > best.length) best = got;
  }
  return best.length ? best : [items[0]];
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

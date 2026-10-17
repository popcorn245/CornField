/**
 * @module explorer/spatial
 *
 * Which node is under a point, without looking at every node (spec 0012 A4, TOPO-06).
 * Pure: no DOM, no `window`, no `state`. A uniform grid over the node centres:
 *
 *     createSpatialIndex(items, { cellSize }) -> { nodeAt(x, y, slop), nodesIn(rect), size }
 *
 * An item is anything with `{ id, x, y, r }` in world units: the scene's nodes (scene.js
 * SceneNode) are items as they are, and the index returns the very objects it was given. The
 * ORDER of the items is the draw order (later is on top), and `nodeAt` answers the topmost hit,
 * which is what a linear scan from the last node to the first would answer.
 *
 * Each item sits in exactly one cell (the one holding its centre). A query looks at the cells its
 * search radius touches, where the radius is the largest hit radius any node can have, so a big
 * node whose circle spans several cells is still found from any of them.
 *
 * A node's hit radius is `r + slop` for a number slop, or `max(r + slop.pad, slop.min)` for
 * `{ pad, min }`: input.js asks for "a few px more than the circle, and never less than a finger"
 * in world units, which depends on the zoom.
 *
 * The index is built once per scene (`createSpatialCache`), so the cost is paid when the picture
 * changes, not on every pointer move.
 *
 * @typedef {{ id: string, x: number, y: number, r: number }} SpatialItem
 * @typedef {number | { pad?: number, min?: number }} Slop
 * @typedef {{ minX: number, minY: number, maxX: number, maxY: number }} Rect
 */

export const DEFAULT_CELL_SIZE = 64;

/**
 * @template {SpatialItem} T
 * @param {T[]} items in draw order (later is on top)
 * @param {{ cellSize?: number }} [opts]
 */
export function createSpatialIndex(items, { cellSize = DEFAULT_CELL_SIZE } = {}) {
  const cells = new Map();
  let maxR = 0;
  // Cell coordinates are packed into one number: a Map keyed by a number is much faster than by a string
  const key = (cx, cy) => cx * 4194304 + cy; // 2^22: |cy| stays far below it for any map
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.r > maxR) maxR = item.r;
    const k = key(Math.floor(item.x / cellSize), Math.floor(item.y / cellSize));
    const cell = cells.get(k);
    if (cell) cell.push(i);
    else cells.set(k, [i]);
  }

  const padOf = (slop) => (typeof slop === 'number' ? slop : (slop && slop.pad) || 0);
  const minOf = (slop) => (typeof slop === 'number' ? 0 : (slop && slop.min) || 0);

  return {
    /** How many items are indexed */
    size: items.length,
    cellSize,

    /**
     * The topmost item whose hit circle holds the point, or null
     * @param {number} x world
     * @param {number} y
     * @param {Slop} [slop]
     * @returns {T|null}
     */
    nodeAt(x, y, slop = 0) {
      if (items.length === 0) return null;
      const pad = padOf(slop);
      const min = minOf(slop);
      const reach = Math.max(maxR + pad, min);
      const cx0 = Math.floor((x - reach) / cellSize);
      const cx1 = Math.floor((x + reach) / cellSize);
      const cy0 = Math.floor((y - reach) / cellSize);
      const cy1 = Math.floor((y + reach) / cellSize);
      let best = -1;
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const cell = cells.get(key(cx, cy));
          if (!cell) continue;
          for (let j = 0; j < cell.length; j++) {
            const i = cell[j];
            if (i <= best) continue;
            const item = items[i];
            const reachOfItem = Math.max(item.r + pad, min);
            if (Math.hypot(item.x - x, item.y - y) <= reachOfItem) best = i;
          }
        }
      }
      return best < 0 ? null : items[best];
    },

    /**
     * Every item whose circle touches the rectangle, in draw order
     * @param {Rect} rect world
     * @returns {T[]}
     */
    nodesIn(rect) {
      if (items.length === 0) return [];
      const { minX, minY, maxX, maxY } = rect;
      const cx0 = Math.floor((minX - maxR) / cellSize);
      const cx1 = Math.floor((maxX + maxR) / cellSize);
      const cy0 = Math.floor((minY - maxR) / cellSize);
      const cy1 = Math.floor((maxY + maxR) / cellSize);
      const found = [];
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const cell = cells.get(key(cx, cy));
          if (!cell) continue;
          for (let j = 0; j < cell.length; j++) {
            const i = cell[j];
            const item = items[i];
            const dx = item.x - Math.min(Math.max(item.x, minX), maxX);
            const dy = item.y - Math.min(Math.max(item.y, minY), maxY);
            if (dx * dx + dy * dy <= item.r * item.r) found.push(i);
          }
        }
      }
      return found.sort((a, b) => a - b).map((i) => items[i]);
    },
  };
}

/**
 * The hit test input.js makes, in screen pixels: a mouse gets 6 px beyond the circle and at least
 * 12 px, a finger 16 px and at least 32 px (the same numbers the linear scan used). Converted to
 * world units for the zoom, so the grid does the work.
 * @param {ReturnType<typeof createSpatialIndex>} index
 * @param {{ x: number, y: number, zoom: number }} camera
 * @param {number} sx screen
 * @param {number} sy
 * @param {boolean} [touch]
 */
export function hitTestScreen(index, camera, sx, sy, touch = false) {
  const z = camera.zoom;
  return index.nodeAt((sx - camera.x) / z, (sy - camera.y) / z, { pad: (touch ? 16 : 6) / z, min: (touch ? 32 : 12) / z });
}

/**
 * Remembers the index of the last scene it was given and builds a new one only for a different
 * scene (render.js hands over the same object until `state.sceneVersion` moves).
 * @param {{ cellSize?: number }} [opts]
 */
export function createSpatialCache(opts) {
  let scene = null;
  let index = null;
  const cache = {
    /** How many times an index was built */
    builds: 0,
    /** @param {{ nodes: SpatialItem[] }} next */
    get(next) {
      if (index && scene === next) return index;
      index = createSpatialIndex(next.nodes, opts);
      scene = next;
      cache.builds++;
      return index;
    },
  };
  return cache;
}

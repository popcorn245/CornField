/**
 * @module explorer/layout
 *
 * Where every node sits. topology.json stores no x/y, so this derives them:
 *  - the orbital layout of the whole map (data at the core, clusters that cannot overlap), and
 *  - the lane layout of the data-flow preset (one column per tier, left to right).
 * Positions are exact: no physics pass, so the same topology always draws the same map.
 * Plus the freeform mode, where the owner drags nodes and the positions are remembered.
 */

import { state, touchScene } from './state.js';

// ---------------------------------------------------------------------------
//  Degree centrality: hubs a little larger, leaves a little smaller
// ---------------------------------------------------------------------------
export function computeDegreeCentrality() {
  touchScene(); // node radii change
  const degreeMap = {};
  state.nodes.forEach((n) => {
    degreeMap[n.id] = 0;
    if (n.baseR === undefined) n.baseR = n.r;
  });
  state.edges.forEach((e) => {
    if (degreeMap[e.from] !== undefined) degreeMap[e.from]++;
    if (degreeMap[e.to] !== undefined) degreeMap[e.to]++;
  });
  state.nodes.forEach((n) => {
    const d = degreeMap[n.id] || 0;
    n.degree = d;
    // Leaf nodes slightly smaller (-3px), hub nodes slightly larger (up to +7px)
    const delta = Math.max(-3, Math.min(7, (Math.sqrt(d) - 1.4) * 2.2));
    n.r = Math.max(12, Math.round(n.baseR + delta));
    n.scaleDelta = delta;
  });
}

const FONT = '"Segoe UI", -apple-system, sans-serif';

/** The width a node's label takes on the canvas */
export function labelWidth(node) {
  const { ctx } = state;
  ctx.save();
  ctx.font = `${node.type === 'root' || node.type === 'app' ? 'bold 12px' : '11px'} ${FONT}`;
  const w = ctx.measureText(node.label || '').width;
  ctx.restore();
  return w;
}

// ---------------------------------------------------------------------------
//  Orbital layout
//  1. The data tier (stores, tables, ROM stages) rings the root, grouped by kind.
//  2. A hub's children fill concentric rings around it; the spacing along a ring
//     comes from that cluster's own label widths, so labels never collide.
//  3. Hubs with children share one ring around the core, each taking arc in
//     proportion to its cluster's size; the ring is sized so clusters never touch.
//  4. Childless hubs (leaf apps, tools, packages) sit on an outer ring.
// ---------------------------------------------------------------------------
const DATA_TYPES = ['store', 'table', 'rom'];
const CHILD_TYPE_ORDER = ['core', 'atom', 'molecule', 'token', 'page', 'service', 'external', 'stack', 'table', 'store', 'tool', 'app', 'pkg'];

/** Concentric rings of `items` around (0, 0): returns the offsets and the radii used */
function ringPack(items, { first = 110, gap = 76, spacing = 90 } = {}) {
  const offsets = [];
  const radii = [];
  let i = 0, ring = 0;
  while (i < items.length) {
    const r = first + ring * gap;
    const capacity = Math.max(1, Math.floor((2 * Math.PI * r) / spacing));
    const count = Math.min(capacity, items.length - i);
    // Keep the slot under the hub free for the hub's label: turn the ring half a step if one lands there
    const landsBelow = (s) => Array.from({ length: count }, (_, j) => -Math.PI / 2 + s + (j / count) * Math.PI * 2)
      .some((a) => Math.abs(Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2))) < 0.35);
    let shift = ring % 2 ? Math.PI / count : 0;
    if (landsBelow(shift)) shift += Math.PI / count;
    for (let j = 0; j < count; j++) {
      const a = -Math.PI / 2 + shift + (j / count) * Math.PI * 2;
      offsets.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    radii.push(r);
    i += count;
    ring++;
  }
  return { offsets, radii };
}

export function computeOrbitalLayout() {
  touchScene(); // positions and rings change
  const { nodes, edges } = state;
  if (nodes.length === 0) return;
  state.rings = { rings: [], clusters: [] };
  const LAYOUT = state.rings;

  const parentMap = {};
  edges.forEach((e) => {
    if (!e.dashed && !e.kind && e.from && e.to && !parentMap[e.to]) parentMap[e.to] = e.from;
  });

  // topology.json stores no positions; a node the passes below do not place starts at the centre
  nodes.forEach((n) => { n.x = 0; n.y = 0; });
  const root = nodes.find((n) => n.id === 'root');
  if (root) { root.x = 0; root.y = 0; }

  const isData = (n) => DATA_TYPES.includes(n.type);
  const hasChildren = new Set(Object.values(parentMap));
  // A data store with tables of its own is a cluster like an app; other data rings the root
  const isHub = (n) => n.id !== 'root' && (isData(n)
    ? n.type === 'store' && hasChildren.has(n.id) && !parentMap[n.id]
    : parentMap[n.id] === 'root' || (!parentMap[n.id] && ['app', 'pkg', 'tool', 'external', 'stack'].includes(n.type)));
  const hubs = nodes.filter(isHub);
  const hubIds = new Set(hubs.map((h) => h.id));
  const typeRank = (n) => { const i = CHILD_TYPE_ORDER.indexOf(n.type); return i < 0 ? 99 : i; };
  const byTypeThenLabel = (a, b) => typeRank(a) - typeRank(b) || String(a.label).localeCompare(String(b.label));

  // 1. Data core
  const data = nodes.filter((n) => isData(n) && !hubIds.has(n.id) && !hubIds.has(parentMap[n.id]))
    .sort((a, b) => DATA_TYPES.indexOf(a.type) - DATA_TYPES.indexOf(b.type) || String(a.label).localeCompare(String(b.label)));
  const dataSpacing = Math.max(110, ...data.map((n) => labelWidth(n) + 24));
  const dataR = Math.max(150, (data.length * dataSpacing) / (2 * Math.PI));
  data.forEach((n, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, data.length)) * Math.PI * 2;
    n.x = Math.cos(a) * dataR;
    n.y = Math.sin(a) * dataR;
  });
  const coreExtent = data.length ? dataR + 50 : 60;
  if (data.length) LAYOUT.rings.push({ x: 0, y: 0, r: dataR });

  // 2. Pack each hub's children (relative to the hub)
  const packs = new Map();
  hubs.forEach((hub) => {
    const children = nodes.filter((n) => parentMap[n.id] === hub.id && !hubIds.has(n.id)).sort(byTypeThenLabel);
    if (!children.length) return;
    const spacing = Math.min(170, Math.max(84, ...children.map((c) => labelWidth(c) * 0.8 + 26)));
    const pack = ringPack(children, { spacing });
    const extent = pack.radii[pack.radii.length - 1] + 40;
    packs.set(hub.id, { children, ...pack, extent });
  });

  // 3. Hubs with children around the core, arc proportional to cluster size
  const GAP = 70;
  const big = hubs.filter((h) => packs.has(h.id)).sort((a, b) => packs.get(b.id).extent - packs.get(a.id).extent);
  const maxExtent = big.length ? Math.max(...big.map((h) => packs.get(h.id).extent)) : 0;
  const need = big.reduce((s, h) => s + 2 * packs.get(h.id).extent + GAP, 0);
  const hubR = Math.max(coreExtent + maxExtent + GAP, need / (2 * Math.PI));
  let angle = -Math.PI / 2;
  big.forEach((hub) => {
    const { extent, children, offsets, radii } = packs.get(hub.id);
    const share = ((2 * extent + GAP) / need) * Math.PI * 2;
    const a = angle + share / 2;
    hub.x = Math.cos(a) * hubR;
    hub.y = Math.sin(a) * hubR;
    children.forEach((c, i) => { c.x = hub.x + offsets[i].x; c.y = hub.y + offsets[i].y; });
    LAYOUT.clusters.push({ x: hub.x, y: hub.y, radii });
    angle += share;
  });
  if (big.length) LAYOUT.rings.push({ x: 0, y: 0, r: hubR });

  // 4. Childless hubs on an outer ring
  const leaves = hubs.filter((h) => !packs.has(h.id)).sort(byTypeThenLabel);
  const leafSpacing = Math.max(120, ...leaves.map((n) => labelWidth(n) + 30));
  const leafR = Math.max(hubR + maxExtent + 90, (leaves.length * leafSpacing) / (2 * Math.PI));
  leaves.forEach((n, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, leaves.length)) * Math.PI * 2;
    n.x = Math.cos(a) * leafR;
    n.y = Math.sin(a) * leafR;
  });
  if (leaves.length) LAYOUT.rings.push({ x: 0, y: 0, r: leafR });

  // Anything left (a child of a non-hub) sits just outside its parent
  nodes.forEach((n) => {
    const p = parentMap[n.id] && nodes.find((x) => x.id === parentMap[n.id]);
    if (!p || hubIds.has(p.id) || p.id === 'root' || isData(n) || hubIds.has(n.id)) return;
    const d = Math.hypot(p.x, p.y) || 1;
    n.x = p.x + (p.x / d) * 70;
    n.y = p.y + (p.y / d) * 70;
  });
}

// ---------------------------------------------------------------------------
//  Lane layout: the data-flow preset, one column per tier, left to right
//  A tier with many nodes (tables, services) fills several sub-columns top to bottom.
// ---------------------------------------------------------------------------
const LANE_ROW = 50;     // vertical distance between two nodes in a column
const LANE_GAP = 110;     // between tiers
const LANE_MAX_ROWS = 15; // a tall tier wraps into another sub-column

/**
 * Places the nodes of `flow.tiers` and sets `flow.headers` (one title per tier, with the x range
 * it spans). Tiers are `{ key, title, nodes }`; the nodes get their x and y.
 */
export function computeLaneLayout(flow) {
  touchScene(); // positions and headers change
  let x = 0;
  flow.headers = [];
  const placed = [];
  flow.tiers.forEach((tier) => {
    if (!tier.nodes.length) return;
    const subCols = Math.ceil(tier.nodes.length / LANE_MAX_ROWS);
    const rows = Math.ceil(tier.nodes.length / subCols);
    const colWidth = Math.max(70, ...tier.nodes.map((n) => labelWidth(n) + 30));
    const start = x;
    tier.nodes.forEach((n, i) => {
      const col = Math.floor(i / rows);
      const row = i % rows;
      n.x = start + col * colWidth + colWidth / 2;
      n.y = (row - (rows - 1) / 2) * LANE_ROW;
      placed.push(n);
    });
    const span = subCols * colWidth;
    flow.headers.push({ title: tier.title, note: tier.note, x: start + span / 2, left: start, right: start + span, rows });
    x += span + LANE_GAP;
  });
  // Where the tier titles sit: just above the tallest tier
  flow.top = -((Math.max(1, ...flow.headers.map((h) => h.rows)) - 1) / 2) * LANE_ROW - 70;
  // Centre the whole thing on x = 0
  const shift = (x - LANE_GAP) / 2;
  placed.forEach((n) => { n.x -= shift; });
  flow.headers.forEach((h) => { h.x -= shift; h.left -= shift; h.right -= shift; });
}

// ---------------------------------------------------------------------------
//  Freeform mode: dragged positions, remembered between visits
// ---------------------------------------------------------------------------
export const STORAGE_KEY = 'cornfield-freeform-positions';

export function loadFreeformPositions() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) state.freeformPositions = JSON.parse(saved);
  } catch { /* storage blocked: start with none */ }
}

export function saveFreeformPositions() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.freeformPositions));
  } catch { /* storage blocked: the drag still works for this visit */ }
}

export function clearFreeformPositions() {
  state.freeformPositions = {};
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* nothing to clear */ }
}

/** Puts every remembered position on its node; false when there were none */
export function applyFreeformPositions() {
  touchScene(); // positions change
  let applied = 0;
  state.nodes.forEach((n) => {
    const p = state.freeformPositions[n.id];
    if (p) { n.x = p.x; n.y = p.y; applied++; }
  });
  return applied > 0;
}

/** The orbit positions, with the owner's dragged ones on top when freeform is on */
export function layoutOrbit() {
  computeOrbitalLayout();
  if (state.isFreeform) applyFreeformPositions();
}

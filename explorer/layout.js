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
//  3. Hubs with children are packed round the core, largest first (ties by label), each in the free place nearest it,
//     searched from the top clockwise (spec 0008 D1); a cluster's place depends only on the ones placed before it.
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

/**
 * A cluster's whole pack: `children` in rings around the centre, and a child that has children of its own (a store
 * owning 46 outside services) gets its own rings, placed on an outer ring of this cluster with room for them.
 * `kidsOf(node)` says who hangs under a node. Returns `{ children, offsets, radii, subs, extent }`: `subs[i]` is the
 * child i's own pack (or null), `extent` how far the whole thing reaches from the centre.
 */
function packTree(children, kidsOf, spacingOf, byOrder, seen = new Set()) {
  const withSub = [];
  const plain = [];
  children.forEach((c) => {
    const kids = seen.has(c.id) ? [] : kidsOf(c);
    if (!kids.length) { plain.push(c); return; }
    seen.add(c.id);
    const sub = packTree(kids.sort(byOrder), kidsOf, spacingOf, byOrder, seen);
    withSub.push({ c, sub, fp: sub.extent });
  });
  withSub.sort((a, b) => b.fp - a.fp);
  const pack = ringPack(plain, { spacing: spacingOf(children) });
  const out = {
    children: [...plain], offsets: [...pack.offsets], radii: pack.radii, subs: plain.map(() => null),
    extent: pack.radii.length ? pack.radii[pack.radii.length - 1] + 40 : 0,
  };
  if (withSub.length) {
    const lastR = pack.radii.length ? pack.radii[pack.radii.length - 1] : 0;
    const fpMax = withSub[0].fp;
    const arc = withSub.reduce((sum, w) => sum + 2 * w.fp + 30, 0);
    // Each takes arc in proportion to its size; two of them are a chord apart, not an arc, so the ring is as wide as
    // the closest pair needs (for three or more large ones, more than the arc says)
    const mids = [];
    let a = -Math.PI / 2;
    withSub.forEach((w) => { const share = ((2 * w.fp + 30) / arc) * Math.PI * 2; mids.push(a + share / 2); a += share; });
    let r = Math.max(110, lastR + fpMax + 40, arc / (2 * Math.PI));
    for (let i = 0; i < withSub.length; i++) {
      for (let j = i + 1; j < withSub.length; j++) {
        const half = Math.sin(Math.abs(mids[j] - mids[i]) / 2);
        if (half > 1e-6) r = Math.max(r, (withSub[i].fp + withSub[j].fp + 30) / (2 * half));
      }
    }
    withSub.forEach((w, i) => {
      out.children.push(w.c);
      out.offsets.push({ x: Math.cos(mids[i]) * r, y: Math.sin(mids[i]) * r });
      out.subs.push(w.sub);
    });
    out.bigRadius = r;
    out.extent = Math.max(out.extent, r + fpMax);
  }
  return out;
}

/** Puts a pack's children (and theirs) around (ox, oy); a child's own rings are added to `clusters` */
function placePack(pack, ox, oy, clusters) {
  pack.children.forEach((c, i) => {
    c.x = ox + pack.offsets[i].x;
    c.y = oy + pack.offsets[i].y;
    const sub = pack.subs[i];
    if (sub) {
      clusters.push({ x: c.x, y: c.y, radii: sub.radii });
      placePack(sub, c.x, c.y, clusters);
    }
  });
}


/**
 * The free place nearest (0, 0) for a disc of radius `r` among `discs` (`{ x, y, r }`, each already holding its own gap),
 * searched along rays from the top clockwise every STEP degrees: on each ray the nearest point where the disc touches
 * none, and of the rays the nearest of all, the first in the search order winning a tie. Exact and deterministic.
 */
const PACK_STEP_DEG = 2;
function nearestFreePlace(discs, r) {
  let best = null;
  for (let deg = 0; deg < 360; deg += PACK_STEP_DEG) {
    const a = -Math.PI / 2 + (deg * Math.PI) / 180;
    const dx = Math.cos(a), dy = Math.sin(a);
    // The stretches of this ray where the disc would touch another (open intervals of the distance along it)
    const blocked = [];
    for (const d of discs) {
      const along = dx * d.x + dy * d.y;
      const reach = d.r + r;
      const disc = along * along - (d.x * d.x + d.y * d.y) + reach * reach;
      if (disc > 0) blocked.push([along - Math.sqrt(disc), along + Math.sqrt(disc)]);
    }
    blocked.sort((p, q) => p[0] - q[0]);
    let at = 0;
    for (const [lo, hi] of blocked) if (lo < at + 1e-9 && hi > at) at = hi;
    if (!best || at < best.at - 1e-6) best = { at, x: dx * at, y: dy * at };
  }
  return best;
}

export function computeOrbitalLayout() {
  touchScene(); // positions and rings change
  const { nodes, edges } = state;
  if (nodes.length === 0) return;
  state.rings = { rings: [], clusters: [] };
  const LAYOUT = state.rings;

  const ids = new Set(nodes.map((n) => n.id));
  const parentMap = {};
  edges.forEach((e) => {
    // A parent that is not on the map (an edge a proposal left behind) is no parent: the node would sit on the centre
    if (!e.dashed && !e.kind && e.from && e.to && ids.has(e.from) && e.from !== e.to && !parentMap[e.to]) parentMap[e.to] = e.from;
  });
  // Nor is a parent that is its own ancestor: the first node of a loop loses its parent, so the loop hangs from it
  nodes.forEach((n) => {
    const path = new Set([n.id]);
    for (let p = parentMap[n.id]; p; p = parentMap[p]) {
      if (path.has(p)) { delete parentMap[p]; break; }
      path.add(p);
    }
  });

  // topology.json stores no positions; a node the passes below do not place starts at the centre
  nodes.forEach((n) => { n.x = 0; n.y = 0; });
  const root = nodes.find((n) => n.id === 'root');
  if (root) { root.x = 0; root.y = 0; }

  const isData = (n) => DATA_TYPES.includes(n.type);
  const hasChildren = new Set(Object.values(parentMap));
  const parentsOfNonData = new Set(nodes.filter((k) => parentMap[k.id] && !isData(k)).map((k) => parentMap[k.id]));
  // A data store with children of its own (tables, outside services) is a cluster like an app; other data rings the root
  //  and so is any node with no parent but children of its own (its children need somewhere to go)
  const isHub = (n) => n.id !== 'root' && (isData(n)
    ? hasChildren.has(n.id) && (!parentMap[n.id] || parentMap[n.id] === 'root')
      && (n.type === 'store' || parentsOfNonData.has(n.id))
    : parentMap[n.id] === 'root' || (!parentMap[n.id] && (hasChildren.has(n.id) || ['app', 'pkg', 'tool', 'external', 'stack'].includes(n.type))));
  const firstHubs = new Set(nodes.filter(isHub).map((h) => h.id));
  // A data node that would ring the root (its parent is no hub) but has other nodes under it is a cluster too: the
  // data ring has no room for them
  const hubs = nodes.filter((n) => firstHubs.has(n.id)
    || (n.id !== 'root' && isData(n) && parentsOfNonData.has(n.id) && !firstHubs.has(parentMap[n.id])));
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

  // 2. Pack each hub's children (relative to the hub). A child with children of its own (a store that owns the
  //    outside services) gets rings of its own, and they count in the cluster's extent.
  const kidsOf = (n) => (n.id === 'root' ? [] : nodes.filter((k) => parentMap[k.id] === n.id && !hubIds.has(k.id) && !isData(k) && k.id !== 'root'));
  const spacingOf = (list) => Math.min(170, Math.max(84, ...list.map((c) => labelWidth(c) * 0.8 + 26)));
  const packs = new Map();
  hubs.forEach((hub) => {
    const children = nodes.filter((n) => parentMap[n.id] === hub.id && !hubIds.has(n.id)).sort(byTypeThenLabel);
    if (!children.length) return;
    packs.set(hub.id, packTree(children, kidsOf, spacingOf, byTypeThenLabel, new Set([hub.id])));
  });

  // 3. Hubs with children, packed (spec 0008 D1): the largest cluster first (ties by label) takes the free place nearest
  //    the core, searched from the top clockwise, GAP from every cluster already placed. No physics: the same map
  //    always draws the same, and a cluster's place depends only on the ones placed before it.
  const GAP = 70;
  const big = hubs.filter((h) => packs.has(h.id))
    .sort((a, b) => packs.get(b.id).extent - packs.get(a.id).extent || String(a.label).localeCompare(String(b.label)));
  const discs = [{ x: 0, y: 0, r: coreExtent }];
  let hubReach = coreExtent; // how far from the centre the packed clusters reach
  big.forEach((hub) => {
    const pack = packs.get(hub.id);
    const at = nearestFreePlace(discs, pack.extent + GAP / 2);
    hub.x = at.x;
    hub.y = at.y;
    discs.push({ x: hub.x, y: hub.y, r: pack.extent + GAP / 2 });
    hubReach = Math.max(hubReach, Math.hypot(hub.x, hub.y) + pack.extent);
    LAYOUT.clusters.push({ x: hub.x, y: hub.y, radii: pack.radii });
    placePack(pack, hub.x, hub.y, LAYOUT.clusters);
  });

  // 4. Childless hubs on an outer ring, and with them any node that has no parent and is none of the above
  //    (it would otherwise sit on the centre, under whatever else is there)
  const homeless = nodes.filter((n) => n.id !== 'root' && !parentMap[n.id] && !isData(n) && !hubIds.has(n.id));
  const leaves = [...hubs.filter((h) => !packs.has(h.id)), ...homeless].sort(byTypeThenLabel);
  const leafSpacing = Math.max(120, ...leaves.map((n) => labelWidth(n) + 30));
  const leafR = Math.max(hubReach + 90, (leaves.length * leafSpacing) / (2 * Math.PI));
  leaves.forEach((n, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, leaves.length)) * Math.PI * 2;
    n.x = Math.cos(a) * leafR;
    n.y = Math.sin(a) * leafR;
  });
  if (leaves.length) LAYOUT.rings.push({ x: 0, y: 0, r: leafR });

  // Anything still on the centre is a child of a node the passes above did not pack (a child of a data node on the
  // core ring, say): it goes in rings around its parent, with its own children in rings around it, never on one point
  const placedAt = (n) => n.id === 'root' || n.x !== 0 || n.y !== 0;
  const stuckUnder = new Map();
  nodes.forEach((n) => {
    const pid = parentMap[n.id];
    if (placedAt(n) || !pid) return;
    (stuckUnder.get(pid) || stuckUnder.set(pid, []).get(pid)).push(n);
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  stuckUnder.forEach((list, pid) => {
    const p = byId.get(pid);
    if (!p || !placedAt(p)) return; // its parent is stuck too: it is placed with it, in the parent's pack
    if (list.every(placedAt)) return; // placed already, in a pack higher up
    const pack = packTree(list.sort(byTypeThenLabel), kidsOf, spacingOf, byTypeThenLabel, new Set([pid]));
    LAYOUT.clusters.push({ x: p.x, y: p.y, radii: pack.radii });
    placePack(pack, p.x, p.y, LAYOUT.clusters);
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

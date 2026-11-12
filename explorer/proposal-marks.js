/**
 * @module explorer/proposal-marks
 *
 * What a proposal's marks do to the map (spec 0012 B2, TOPO-09), the part a map draws with: which nodes and edges each view shows
 * (`showsNode`, `showsEdge`), the mark a scene carries (`markIn`), a changed item as it was (`beforeOf`), what Diff keeps bright and the camera
 * fits (`touchedIds`), and where an added node sits (`placeAddedNodes`, `orderAddedLast`, `pinLanes`). Pure: no DOM, no state.
 *
 * proposal-model.js re-exports all of it, with the bar's, the panel's and the list's words, which only a review and cornfield's page use: a map
 * alone (scene.js, engine/topology.js, layer-model.js) imports this module and so does not carry those (the components' size budget, spec 0011 D11).
 */

/**
 * What a marked item IS, under the mark it is drawn with: a what-if `edit` (whatif-model.js) is drawn in violet
 * but is still an addition or a removal (`editOp`), and the views and the layout treat it as one.
 * @returns {'none'|'added'|'changed'|'removed'}
 */
export const kindOfMark = (item) => (item.mark === 'edit' ? item.editOp || 'none' : item.mark || 'none');

/** Whether an item carries a mark (any but none) */
export const hasMark = (item) => !!item && !!item.mark && item.mark !== 'none';

// ---------------------------------------------------------------------------
//  What each view shows
// ---------------------------------------------------------------------------

/** Is this node drawn in `view`? (`view` null = no proposal is open: everything is) */
export function showsNode(view, node) {
  if (view === 'before') return kindOfMark(node) !== 'added';
  if (view === 'after') return kindOfMark(node) !== 'removed';
  return true;
}

/** Is this edge drawn in `view`? The same rule: Before hides what is added, After what is removed */
export function showsEdge(view, edge) {
  return showsNode(view, edge);
}

/**
 * The mark a scene carries in `view`: the proposal's own in Diff and none in Before and After; a
 * what-if `edit` is the maintainer's own and shows in all three.
 * @returns {'none'|'added'|'changed'|'removed'|'edit'}
 */
export function markIn(view, item) {
  const mark = item.mark || 'none';
  if (mark === 'edit') return 'edit';
  return view === 'diff' ? mark : 'none';
}

/**
 * A changed node or edge as it was before the proposal: each field in `before` is put back
 * (`null` there means the item did not have it, so it is dropped). Anything else comes back as it is.
 */
export function beforeOf(item) {
  if (item.mark !== 'changed' || !item.before) return item;
  const out = { ...item };
  for (const [field, value] of Object.entries(item.before)) {
    if (value === null) delete out[field];
    else out[field] = value;
  }
  return out;
}

/**
 * Which nodes a proposal touches, for dimming and for fitting the camera.
 *  - `touched`: nodes with a mark, and both ends of a marked edge: what Diff keeps bright
 *  - `near`: `touched` and what they connect to, except the children a touched node owns (a touched
 *    app would otherwise bring all its hundreds of pages): what the camera fits
 * @param {{id:string, mark?:string}[]} nodes
 * @param {{from:string, to:string, kind?:string, dashed?:boolean, mark?:string}[]} edges
 */
export function touchedIds(nodes, edges) {
  const touched = new Set();
  for (const n of nodes) if (hasMark(n)) touched.add(n.id);
  for (const e of edges) if (hasMark(e)) { touched.add(e.from); touched.add(e.to); }
  const near = new Set(touched);
  for (const e of edges) {
    const owns = !e.kind && !e.dashed;
    if (touched.has(e.from) && !(owns && !touched.has(e.to))) near.add(e.to);
    if (touched.has(e.to)) near.add(e.from);
  }
  return { touched, near };
}

// ---------------------------------------------------------------------------
//  Where an added node sits
// ---------------------------------------------------------------------------

/** An ownership edge: a solid line with no kind (the parent → child link) */
const isOwnership = (e) => !e.kind && !e.dashed;

/**
 * Gives every node marked `added` a position, next to the node it hangs off: its parent when it has
 * one, else something it connects to, else a spot on a ring around the centre. Existing nodes never
 * move: the base layout is pinned, which is why the Before view and the Diff view show the same
 * picture. The spot is the first free one on widening rings around the anchor, starting on the side
 * facing away from the centre, where the map has room. Writes `x` and `y`; touches nothing else.
 * @param {{id:string, x:number, y:number, mark?:string}[]} nodes the applied nodes; the existing ones already have x and y
 * @param {{from:string, to:string, kind?:string, dashed?:boolean}[]} edges
 * @param {{gap?: number}} [opts] `gap`: the closest two nodes may sit (world units)
 */
export function placeAddedNodes(nodes, edges, { gap = 74 } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const placed = nodes.filter((n) => kindOfMark(n) !== 'added');
  const added = nodes.filter((n) => kindOfMark(n) === 'added');
  if (!added.length) return;
  const done = new Set(placed.map((n) => n.id));

  const anchorOf = (n) => {
    const own = edges.find((e) => isOwnership(e) && e.to === n.id && byId.has(e.from));
    if (own) return own.from;
    const other = edges.find((e) => (e.from === n.id && byId.has(e.to)) || (e.to === n.id && byId.has(e.from)));
    return other ? (other.from === n.id ? other.to : other.from) : null;
  };

  const free = (x, y) => placed.every((p) => Math.hypot(p.x - x, p.y - y) >= gap);
  const put = (n, ax, ay) => {
    const out = Math.atan2(ay, ax) || -Math.PI / 2; // away from the centre
    const base = ax === 0 && ay === 0 ? -Math.PI / 2 : out;
    let fallback = null;
    for (let r = 96; r <= 96 + 40 * 12; r += 40) {
      const steps = Math.max(8, Math.round((2 * Math.PI * r) / gap));
      for (let k = 0; k < steps; k++) {
        // 0, +1, -1, +2, -2 ... steps either side of the outward direction
        const turn = Math.ceil(k / 2) * (k % 2 ? 1 : -1) * ((2 * Math.PI) / steps);
        const x = ax + Math.cos(base + turn) * r;
        const y = ay + Math.sin(base + turn) * r;
        if (!fallback) fallback = { x, y };
        if (free(x, y)) { n.x = x; n.y = y; return; }
      }
    }
    n.x = fallback.x; n.y = fallback.y;
  };

  // Parents first: an added node can hang off another added node, in any order in the file
  let pending = added.slice();
  for (let pass = 0; pass <= added.length && pending.length; pass++) {
    const next = [];
    for (const n of pending) {
      const anchor = byId.get(anchorOf(n));
      if (anchor && done.has(anchor.id)) {
        put(n, anchor.x, anchor.y);
        placed.push(n);
        done.add(n.id);
      } else {
        next.push(n); // its anchor is another added node not placed yet, or it has none (settled below)
      }
    }
    if (next.length === pending.length) break;
    pending = next;
  }
  // No anchor, or an anchor that never got a place: a spot beside the centre
  for (const n of pending) {
    put(n, 0, 0);
    placed.push(n);
  }
}

/**
 * The data-flow lanes fill a column in order; an added node goes last in its column, so the nodes
 * that were there keep their rows. Reorders each tier's `nodes` in place, stably.
 * @param {{tiers: {nodes: {mark?:string}[]}[]}|null} flow `buildDataFlow` result
 */
export function orderAddedLast(flow) {
  if (!flow) return;
  for (const tier of flow.tiers) {
    tier.nodes = [...tier.nodes.filter((n) => kindOfMark(n) !== 'added'), ...tier.nodes.filter((n) => kindOfMark(n) === 'added')];
  }
}

/** The distance between two rows of a lane (layout.js `LANE_ROW`) */
const LANE_ROW = 50;

/**
 * The data-flow lanes while a proposal is open: the base map's lane layout is pinned and the added
 * nodes take free cells of their lane, so no node that was there moves (laying the lanes out again
 * would re-flow a whole lane when one node more tips it into another row). An added node goes in the
 * free cells at the foot of its lane's last column, then in new rows below it; `flow.top` moves up
 * so the lane bands still cover them.
 *
 * Writes `x`, `y`, `r` of each existing node from `baseFlow`'s node of the same id, `x` and `y` of each
 * added one, and `flow.headers` / `flow.top`. `flow` is the applied map's flow (`buildDataFlow` over
 * the applied nodes, added nodes last in their tier), `baseFlow` the base map's, already laid out.
 * @param {{tiers: {key:string, nodes: object[]}[], headers?: object[], top?: number}} flow
 * @param {{tiers: {key:string, nodes: object[]}[], headers: object[], top: number}} baseFlow
 * @returns {boolean} false when the lanes cannot be pinned (a tier has nodes now that had none, so it has no column
 *   to join): the caller lays the lanes out afresh
 */
export function pinLanes(flow, baseFlow) {
  const baseTier = new Map(baseFlow.tiers.map((t) => [t.key, t]));
  if (flow.tiers.some((t) => t.nodes.length && !baseTier.get(t.key)?.nodes.length)) return false;

  // `headers` has one entry per tier that has nodes, in tier order
  const headerOf = new Map(baseFlow.tiers.filter((t) => t.nodes.length).map((t, i) => [t.key, baseFlow.headers[i]]));
  const was = new Map(baseFlow.tiers.flatMap((t) => t.nodes).map((n) => [n.id, n]));
  flow.headers = baseFlow.headers.map((h) => ({ ...h }));
  let top = baseFlow.top;

  for (const tier of flow.tiers) {
    if (!tier.nodes.length) continue;
    const kept = tier.nodes.filter((n) => was.has(n.id));
    const added = tier.nodes.filter((n) => !was.has(n.id));
    for (const n of kept) { const b = was.get(n.id); n.x = b.x; n.y = b.y; n.r = b.r; }
    if (!added.length) continue;

    const rows = headerOf.get(tier.key).rows;
    const lastX = Math.max(...kept.map((n) => n.x));
    const rowY = (k) => (k - (rows - 1) / 2) * LANE_ROW;
    const taken = new Set(kept.filter((n) => n.x === lastX).map((n) => Math.round(n.y)));
    let k = 0;
    for (const n of added) {
      while (taken.has(Math.round(rowY(k)))) k++;
      n.x = lastX;
      n.y = rowY(k);
      taken.add(Math.round(n.y));
      top = Math.min(top, -(n.y + 40)); // the bands run from `top` down to `-top + 40`
    }
  }
  flow.top = top;
  return true;
}

/**
 * @module explorer/cluster
 *
 * A cluster is a hub and what hangs under it (spec 0008 D1): an app and its pages, a store and its tables. A click or tap on a cluster's title
 * (its hub's label) frames the cluster: the camera fits to all of it. Pure: nodes and edges in, ids out.
 */

/**
 * The ids of a hub and everything under it, by ownership edges (no kind, not dashed).
 * @param {string} hubId
 * @param {{from: string, to: string, kind?: string, dashed?: boolean}[]} edges
 * @returns {Set<string>}
 */
export function clusterIds(hubId, edges) {
  const kids = new Map();
  for (const e of edges) {
    if (e.kind || e.dashed || !e.from || !e.to) continue;
    (kids.get(e.from) || kids.set(e.from, []).get(e.from)).push(e.to);
  }
  const out = new Set([hubId]);
  const todo = [hubId];
  while (todo.length) {
    for (const k of kids.get(todo.pop()) || []) if (!out.has(k)) { out.add(k); todo.push(k); }
  }
  return out;
}

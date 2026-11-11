/**
 * @module explorer/layer-model
 *
 * Which layer a node is in, as the Layers menu and the map read it (spec 0009 D3), from the state alone: no DOM, no drawing.
 *
 *  - `projectLayerKey(state, node)`: the first project layer (`state.projectLayers`, from the config's `layers.add`) whose match the node
 *    meets, or null. A project layer takes its nodes from their starting layer, so a node is in exactly one row.
 *  - `rowKeyOf(state, node)`: the row a node is under: that layer, else its starting layer. The root has none (null).
 *  - `shownByProposal(state, node)`: a node the open proposal touches is always drawn, whatever its layer says, so a review never hides its
 *    own change.
 *
 * The matching itself is core/layers.js (data only); this file only hands it the map's ownership line.
 */

import { layerKeyOf, parentIndex, projectLayerOf } from '../core/layers.js';
import { touchedIds } from './proposal-model.js';

/** Asks the ownership line of the map the state holds, only when a layer matches by `parent` */
const parentFn = (state) => ((state.projectLayers || []).some((l) => l.match && l.match.parent !== undefined) ? (n) => parentIndex(state.edges || []).get(n.id) : undefined);

/** The key of the project layer that takes `node`, or null */
export function projectLayerKey(state, node) {
  const add = state.projectLayers;
  if (!add || !add.length) return null;
  return projectLayerOf(add, node, parentFn(state));
}

/** The key of the row `node` is under (null for the root) */
export const rowKeyOf = (state, node) => layerKeyOf(state.projectLayers || [], node, parentFn(state));

const touchedMemo = new WeakMap();
/** The ids of the nodes the open proposal touches: a node it marks, and both ends of an edge it marks (what Diff keeps bright) */
function touchedBy(state) {
  const edges = state.edges || [];
  const hit = touchedMemo.get(state.nodes);
  if (hit && hit.edges === edges && hit.n === state.nodes.length && hit.e === edges.length) return hit.touched;
  const touched = touchedIds(state.nodes, edges).touched;
  touchedMemo.set(state.nodes, { edges, n: state.nodes.length, e: edges.length, touched });
  return touched;
}

/** Whether the open proposal touches `node` (false with no proposal open) */
export const shownByProposal = (state, node) => !!state.proposal && touchedBy(state).has(node.id);

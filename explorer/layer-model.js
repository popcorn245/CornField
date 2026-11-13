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
 *  - `touchedLayerKeys`, `reviewLayers`, `layersOf`, `layerOn`, `reviewHides` (issue #232): while a proposal is under review the map is narrowed to the
 *    change. The layers the proposal does not touch are off for the review; the viewer's own state (`state.activeLayers`) is never written.
 *
 * The matching itself is core/layers.js (data only); this file only hands it the map's ownership line.
 */

import { STARTING_LAYERS, kindLetters, layerKeyOf, parentIndex, projectLayerOf } from '../core/layers.js';
import { touchedIds } from './proposal-marks.js';

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

const lettersMemo = new WeakMap();
/**
 * The letters of the node's finer kind (core/layers.js `kindLetters`, over the whole map so two kinds of a type never share one), or ''.
 * An outside node's kind is its layer (cloud or web), not a finer one.
 */
export function lettersOf(state, node) {
  if (typeof node.kind !== 'string' || !node.kind || node.type === 'external') return '';
  let hit = lettersMemo.get(state.nodes);
  if (!hit || hit.n !== state.nodes.length) {
    hit = { n: state.nodes.length, map: kindLetters(state.nodes) };
    lettersMemo.set(state.nodes, hit);
  }
  const t = hit.map.get(node.type);
  return (t && t.get(node.kind)) || '';
}

// ---------------------------------------------------------------------------
//  The review narrows the map to the change (issue #232)
// ---------------------------------------------------------------------------

/** Layers a touched layer cannot show without (scene.js `layerShows`): Core needs Packages, Stores and ROM need Data Flow */
const NEEDS = Object.freeze({ core: ['pkg'], store: ['flow'], rom: ['flow'] });
const marked = (item) => !!item && !!item.mark && item.mark !== 'none';

/**
 * The keys of the layers a proposal touches: the layer of every node it marks (added, changed, removed, or a what-if edit) and of both ends of an
 * edge it marks, the Data Flow overlay when a marked edge is a flow, the Runs overlay when a touched node has a run in flight, and what a touched
 * layer cannot be drawn without (`NEEDS`). The root has no layer. Pure: the map, what the layers are, the runs.
 * @param {{ nodes: {id: string, mark?: string}[], edges: {from: string, to: string, kind?: string, mark?: string}[], rowOf: (node: object) => string | null, flight?: { has(id: string): boolean } | null }} map
 * @returns {Set<string>}
 */
export function touchedLayerKeys({ nodes, edges, rowOf, flight = null }) {
  const { touched } = touchedIds(nodes, edges);
  const keys = new Set();
  for (const n of nodes) {
    if (!touched.has(n.id)) continue;
    const key = rowOf(n);
    if (key) { keys.add(key); for (const need of NEEDS[key] || []) keys.add(need); }
    if (flight && flight.has(n.id)) keys.add('runs');
  }
  for (const e of edges) if (marked(e) && e.kind === 'flow') keys.add('flow');
  return keys;
}

/**
 * The layers a review shows, from the viewer's own (`active`), as a new map. Untouched layers are off and touched ones on (a layer the viewer had
 * off comes on for the review); then what the reviewer did by hand (`manual`) and what a playing scenario turned on (`step`). With `whole` the map
 * is the viewer's as it always was, with only the hand and the scenario laid over it. `universe`: every layer key the menu knows.
 * @param {{ active: Record<string, boolean>, touched: Set<string>, universe: Iterable<string>, review: { whole?: boolean, manual?: Record<string, boolean>, step?: Record<string, boolean> } }} a
 * @returns {Record<string, boolean>}
 */
export function reviewLayers({ active, touched, universe, review }) {
  const out = { ...active };
  if (!review.whole && touched.size) for (const key of universe) out[key] = touched.has(key); // a proposal that touches no layer has nothing to narrow the map to: it is left whole
  Object.assign(out, review.manual || {}, review.step || {});
  return out;
}

const layerKeysMemo = new WeakMap();
/** The touched layer keys of the open proposal's map: kept while the map, the runs and the layers' ownership are the same */
function touchedLayers(state) {
  const nodes = state.nodes;
  const edges = state.edges || [];
  const flight = state.runsMap ? state.runsMap.flight : null;
  const hit = layerKeysMemo.get(nodes);
  if (hit && hit.edges === edges && hit.n === nodes.length && hit.e === edges.length && hit.flight === flight && hit.project === state.projectLayers) return hit;
  const touched = touchedLayerKeys({ nodes, edges, rowOf: (n) => rowKeyOf(state, n), flight });
  const universe = new Set([...STARTING_LAYERS.map((l) => l.key), ...(state.projectLayers || []).map((l) => l.key), ...nodes.map((n) => rowKeyOf(state, n)).filter(Boolean)]);
  const made = { edges, n: nodes.length, e: edges.length, flight, project: state.projectLayers, touched, universe };
  layerKeysMemo.set(nodes, made);
  return made;
}

const layersMemo = new WeakMap();
/**
 * The layers the map is drawn with: `state.activeLayers` itself with no review open, else the review's (`reviewLayers`). Every reader of a layer's
 * state for what is drawn goes through this, so the review's hiding is decided in one place.
 */
export function layersOf(state) {
  if (state.view === 'work' && state.workLayers) return state.workLayers; // the Work view has its own layers, and leaves the map's as they were (work-model.js)
  const review = state.review;
  if (!review || !state.proposal) return state.activeLayers;
  const hit = layersMemo.get(review);
  if (hit && hit.rev === review.rev && hit.version === state.sceneVersion && hit.active === state.activeLayers && hit.nodes === state.nodes) return hit.out;
  const { touched, universe } = touchedLayers(state);
  const out = reviewLayers({ active: state.activeLayers, touched, universe, review });
  layersMemo.set(review, { rev: review.rev, version: state.sceneVersion, active: state.activeLayers, nodes: state.nodes, out });
  return out;
}

/** Whether a layer is on for what is drawn (a layer with no entry is on, as the menu shows it) */
export const layerOn = (state, key) => layersOf(state)[key] !== false;

/** Whether the review hid this layer, which the viewer has on: the row says so, and the reviewer may turn it on for the review */
export function reviewHides(state, key) {
  const r = state.review;
  if (!r || !state.proposal || r.whole) return false;
  if (state.activeLayers[key] === false || Object.hasOwn(r.manual || {}, key) || Object.hasOwn(r.step || {}, key)) return false;
  return layersOf(state)[key] === false;
}

/** Whether the greying is on: a review is open, the whole map is not asked for, and the proposal involves something (a proposal that changes nothing greys nothing: scene.js, map-style.js) */
export const greying = (state) => !!state.review && !!state.proposal && !state.review.whole && touchedBy(state).size > 0;

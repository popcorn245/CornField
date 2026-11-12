/**
 * @module explorer/selection-model
 *
 * What a selection lights, and where the camera goes for it (spec 0008 D5 and D6). Pure: no DOM, no state.
 *
 *   activeSubgraph(selected, edges, opts)   the lit set: the node and everything ONE edge away, of any kind (its parent and children
 *                                           included); `throughChildren` adds the children's neighbours (the wider set every
 *                                           selection lit before 0.35); `kind` keeps only the lines of that kind
 *   countOffScreen(ids, camera, rect)       how many of the lit nodes are outside the part of the map nothing covers
 *   selectionCamera(node, lit, rect, opts)  where the camera goes when a selection comes from search, a list, a link or the keyboard:
 *                                           the node and its lit set framed if that fits at zoom 0.5 or closer, else the node
 *                                           centred at zoom 1. A click on the map never asks for it (panels.js)
 *
 * What the node panel says of it (`linesByKind`: "Calls 12 · Reads 9 · Owns 4", `farEnds`, `connectedLine`, `kindPanelWord`) is selection-words.js's.
 *
 * An edge's `kind` is project data: it only ever selects a word from `KIND_WORDS` or is shown as escaped text; it never builds a
 * selector or a token name.
 */

import { frameNodes } from './camera.js';

/** The words for a kind: the panel's plural ("Calls 12"), and the word on a lit edge ("calls") */
export const KIND_WORDS = Object.freeze({
  ownership: { panel: 'Owns', edge: 'owns' },
  usage: { panel: 'Links', edge: 'links' },
  flow: { panel: 'Flows', edge: 'flow' },
  reads: { panel: 'Reads', edge: 'reads' },
  writes: { panel: 'Writes', edge: 'writes' },
  calls: { panel: 'Calls', edge: 'calls' },
  triggers: { panel: 'Triggers', edge: 'triggers' },
  delivers: { panel: 'Delivers', edge: 'delivers' },
  'runs-on': { panel: 'Runs on', edge: 'runs on' },
  uses: { panel: 'Uses', edge: 'uses' },
  extends: { panel: 'Extends', edge: 'extends' },
});

/** The kind of a topology edge: an ownership has none, a usage link is `dashed` */
export const edgeKindOf = (e) => e.kind || (e.dashed ? 'usage' : 'ownership');
export const edgeKeyOf = (e) => `${e.from}->${e.to}`;

export const kindEdgeWord = (kind) => (Object.hasOwn(KIND_WORDS, kind) ? KIND_WORDS[kind].edge : String(kind));

/**
 * The focus subgraph (spec 0008 D5).
 * @param {{id:string}|null} selected
 * @param {object[]} edges the edges to walk
 * @param {{throughChildren?: boolean, kind?: string|null}} [opts]
 * @returns {null | {
 *   connectedNodeIds: Set<string>, connectedEdgeKeys: Set<string>, childIds: Set<string>, selectedId: string,
 *   edges: object[], kinds: Map<string, number>, kind: string|null, throughChildren: boolean }}
 *   `kinds` counts every lit line by kind before a `kind` filter, so the panel keeps listing the others; `edges` is the lit lines
 *   (after it); `kind` is the filter in force, or null when none was asked for or the asked kind is not among the lit lines
 */
export function activeSubgraph(selected, edges, { throughChildren = false, kind = null } = {}) {
  if (!selected) return null;
  const id = selected.id;
  const childIds = new Set();
  for (const e of edges) if (!e.kind && !e.dashed && e.from === id) childIds.add(e.to);
  const core = throughChildren ? new Set([id, ...childIds]) : null; // the selected node and its children: with `throughChildren` their neighbours light too
  const lit = [];
  for (const e of edges) {
    if (core ? (core.has(e.from) || core.has(e.to)) : (e.from === id || e.to === id)) lit.push(e);
  }
  const kinds = new Map();
  for (const e of lit) { const k = edgeKindOf(e); kinds.set(k, (kinds.get(k) || 0) + 1); }
  const filter = kind && kinds.has(kind) ? kind : null;
  const shown = filter ? lit.filter((e) => edgeKindOf(e) === filter) : lit;
  const connectedNodeIds = new Set([id]);
  const connectedEdgeKeys = new Set();
  for (const e of shown) { connectedNodeIds.add(e.from); connectedNodeIds.add(e.to); connectedEdgeKeys.add(edgeKeyOf(e)); }
  return { connectedNodeIds, connectedEdgeKeys, childIds, selectedId: id, edges: shown, kinds, kind: filter, throughChildren };
}

/** The screen point of a world point */
const screenOf = (camera, n) => ({ x: camera.x + n.x * camera.zoom, y: camera.y + n.y * camera.zoom });

/**
 * How many of `nodes` are outside `rect` (the part of the map nothing covers) under `camera`.
 * @param {{x:number, y:number}[]} nodes
 * @param {{x:number, y:number, zoom:number}} camera
 * @param {{x:number, y:number, width:number, height:number}} rect
 */
export function countOffScreen(nodes, camera, rect) {
  let off = 0;
  for (const n of nodes) {
    const p = screenOf(camera, n);
    if (p.x < rect.x || p.x > rect.x + rect.width || p.y < rect.y || p.y > rect.y + rect.height) off++;
  }
  return off;
}

/** The zoom a selection is framed at or above: a lit set that needs less than this is not framed, the node is centred at zoom 1 instead */
export const FRAME_MIN_ZOOM = 0.5;
/** The zoom a node is centred at when its lit set is too wide to frame */
export const CENTRE_ZOOM = 1;

/**
 * Where the camera goes for a selection that did not come from a click on the map (spec 0008 D6).
 * @param {{x:number, y:number, r?:number}} node
 * @param {{x:number, y:number, r?:number}[]} lit the node and what it lights
 * @param {{x:number, y:number, width:number, height:number}} rect the part of the map nothing covers (sheets.js visibleMapRect)
 * @param {{padding?: number}} [opts]
 * @returns {{x:number, y:number, zoom:number, framed:boolean}}
 */
export function selectionCamera(node, lit, rect, { padding = 40 } = {}) {
  const all = lit.length ? lit : [node];
  const fit = frameNodes(all, rect, { padding, maxZoom: CENTRE_ZOOM, minZoom: 0.0001 });
  if (fit && fit.zoom >= FRAME_MIN_ZOOM) return { ...fit, framed: true };
  return { x: rect.x + rect.width / 2 - node.x * CENTRE_ZOOM, y: rect.y + rect.height / 2 - node.y * CENTRE_ZOOM, zoom: CENTRE_ZOOM, framed: false };
}

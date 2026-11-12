/**
 * @module explorer/engine/layers
 *
 * The layers of the map, on an instance: one per kind of node (apps, pages, tables, services, ...), the project's own on top of them, which are
 * on, what the viewer chose, and what a review of a proposal shows. The data-flow preset ignores them. Outside nodes are two layers by their kind
 * (spec 0031): Cloud, and the Public web. What the viewer sees of them, the Layers menu, is a piece (pieces/layers.js); this is what it and the
 * rest of the explorer ask: set a layer, set them all, begin and end a review, the rows with their counts' colours.
 *
 * It tells the instance: `layers` after a layer goes on or off or the layers are set (live.js starts or stops the live layer on it) and
 * `layers:redraw` when the menu should be drawn again. explorer/layers.js keeps the old names for the page's instance.
 */

import { announce } from './keyboard.js';
import { themed } from '../theme-model.js';
import { NODE_THEMES } from '../../core/schema.js';
import { STARTING_LAYERS, clientLayers, orderRows, startingLayerOf } from '../../core/layers.js';
import { layerOn, reviewHides, rowKeyOf } from '../layer-model.js';
import { fillOfNode, groupOf } from '../scene.js';
import { cssColor, fillOf, mapStyleOf } from './map-style.js';

/** The types a starting row's nodes have (House: floors and rooms; Cloud and the Public web: `external`), or none for a row that is not a node type */
export const typesOf = (l) => (l.match && l.match.type ? [].concat(l.match.type) : []);
/** The dot of the two rows that are not a node type: Data Flow's lines and the ring of a run in flight. Every other row's built-in dot is its
 * first type's colour in core/schema.js NODE_THEMES, the colour the map draws its nodes in when the theme sets none (one table, not two) */
const NOT_A_TYPE = { flow: '#fb923c', runs: '#5eead4' };
const builtIn = (l) => { const type = typesOf(l)[0]; return type && NODE_THEMES[type] ? NODE_THEMES[type].color : NOT_A_TYPE[l.key]; };
/** The starting layers that start off: the infra layer is its own view, and the physical world's are loaded when first turned on (spec 0029) */
export const STARTS_OFF = new Set(['stack', 'machine', 'container', 'device', 'house', 'persona']);

/** The starting rows (core/layers.js STARTING_LAYERS) with the colour of their dot */
export const LAYER_DEFS = STARTING_LAYERS.map((l) => ({ ...l, color: builtIn(l) }));

/** Where the viewer's choices are kept, and what they are: only the changes, so a layer the config adds later arrives with its default */
export const STORE_KEY = 'cornfield:layers';
const KEY_SHAPE = /^[a-z][a-z0-9-]{0,40}$/;
const memoryOf = (inst) => inst.slot('layers', () => ({ changes: {}, storeKey: STORE_KEY }));

/** Where this instance keeps what the viewer chose (`null`: nowhere, the choice holds for this visit); the page's is cornfield:layers */
export function keepLayersIn(inst, key) {
  memoryOf(inst).storeKey = key;
}

/** What a layer is when the viewer has not touched it: the config's `off`, else a starting layer's own default, else on */
const defaultOf = (inst, key) => (Object.hasOwn(inst.state.layerDefaults, key) ? inst.state.layerDefaults[key] : !STARTS_OFF.has(key));
/** Whether a layer is on for what is drawn: the viewer's, or the review's while a proposal is under review (layer-model.js) */
export const isOn = (inst, key) => layerOn(inst.state, key);

export const NO_COLOR = '#94a3b8';
/** A colour as the dot's style may hold it: a hex or an rgb()/rgba() of numbers, else the plain grey. A node's colour is the map's data
 * (a proposal can set it), so it is checked before it reaches a style attribute, and escaped there all the same */
const NUM = '\\d{1,3}(?:\\.\\d+)?%?';
const SWATCH_RE = new RegExp(`^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\\(\\s*${NUM}(?:\\s*,\\s*|\\s+)${NUM}(?:\\s*,\\s*|\\s+)${NUM}(?:\\s*[,/]\\s*(?:\\d*\\.)?\\d+%?)?\\s*\\))$`, 'i');
export const swatch = (c) => (typeof c === 'string' && c.length <= 64 && SWATCH_RE.test(c.trim()) ? c.trim() : NO_COLOR);

/**
 * The colour of a row's dot: the fill the map draws for the row's nodes, by the map's own order (map-style.js `fillOf`: the type's or layer's
 * token, then the starting group's), else the row's built-in colour on this ground (`themed`). `node` is what the row's nodes are: for a
 * starting row its type (`typeOfRow`: a row of two types, House, speaks for its first, floors, so `--corn-map-group-house` is its dot unless
 * the theme gives floors a colour of their own) and its key as the group; for a project row its first node's type with the layer. A finer kind's token is left out: a dot is a row's, not a kind's.
 * A token's value is the theme's text and a node's colour is the project's: both go through `swatch` before they reach a style.
 */
function rowColor(inst, node, built) {
  const fill = fillOf(mapStyleOf(inst).get().values, node);
  // The built-in is a node's colour (project data): normalised as the map's renderers read it (`cssColor`, the reader of the tokens), so a
  // name or an `hsl()` the map draws is the dot too; anything that is not a colour is the grey
  return fill ? swatch(fill) : swatch(cssColor(themed(built, inst.state.theme)));
}
/** The type a row's dot speaks for: of a row of several types (House), the first one the map holds, else the first; a row with no type, its key */
const typeOfRow = (inst, l) => { const types = typesOf(l); return (types.length > 1 && types.find((ty) => inst.state.nodes.some((n) => n.type === ty))) || types[0] || l.key; };

/**
 * The rows: the project layers that hold a node, then the starting ones in their usual order (`layers.order` first of all), and one more
 * for any node type on this map that none of them covers (a type a plugin or a newer sync adds), so every type present can be turned off.
 * `root` is always shown and has no row. The overlays are the rows with `overlay`: the menu draws them under their own heading.
 */
export function layerRows(inst) {
  const { state } = inst;
  const dotted = (l) => { const type = typeOfRow(inst, l); return { ...l, color: rowColor(inst, { type, group: l.key }, NODE_THEMES[type] ? NODE_THEMES[type].color : l.color) }; };
  const held = new Set();
  const left = new Set(); // starting layers a project layer took nodes from
  state.nodes.forEach((n) => {
    const key = rowKeyOf(state, n);
    if (!key) return;
    held.add(key);
    const own = startingLayerOf(n);
    if (own !== key) left.add(own);
  });
  const projectDot = (l) => {
    const first = state.nodes.find((n) => rowKeyOf(state, n) === l.key);
    return { color: rowColor(inst, first ? { type: first.type, layer: l.key, group: groupOf(first) } : { type: l.key, layer: l.key }, first ? fillOfNode(first) : NO_COLOR) };
  };
  const project = state.projectLayers.filter((l) => held.has(l.key)).map((l) => ({ key: l.key, label: l.label, desc: l.desc || '', project: true, ...projectDot(l) }));
  // A starting row a project layer has taken every node from goes (spec 0009 D7, example 3); with no project layer, every starting row stays, as it always was
  const starting = LAYER_DEFS.filter((l) => !l.overlay && (held.has(l.key) || !left.has(l.key))).map(dotted);
  const known = new Set([...LAYER_DEFS.map((l) => l.key), ...state.projectLayers.map((l) => l.key)]);
  const extra = [];
  held.forEach((key) => {
    if (known.has(key)) return;
    known.add(key);
    extra.push({ key, label: key.charAt(0).toUpperCase() + key.slice(1), color: rowColor(inst, { type: key, group: key }, NO_COLOR), desc: `Nodes of the type ${key}` });
  });
  return { layers: [...orderRows(project, starting, state.layerOrder), ...extra], overlays: LAYER_DEFS.filter((l) => l.overlay).map(dotted) };
}

// ---------------------------------------------------------------------------
//  What the viewer changed is kept in their browser (only the changes, so a layer the config adds later arrives with its default)
// ---------------------------------------------------------------------------
function readChanges(inst) {
  const key = memoryOf(inst).storeKey;
  if (!key) return {};
  try {
    const parsed = JSON.parse(inst.store.get(key) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([k, v]) => KEY_SHAPE.test(k) && typeof v === 'boolean'));
  } catch { return {}; }
}
function writeChanges(inst) {
  const { changes, storeKey } = memoryOf(inst);
  if (!storeKey) return;
  if (Object.keys(changes).length) inst.store.set(storeKey, JSON.stringify(changes)); else inst.store.remove(storeKey);
}
/** Records what the viewer chose for a layer: a value equal to its default is no change */
function keep(inst, key, on) {
  const { changes } = memoryOf(inst);
  if (on === defaultOf(inst, key)) delete changes[key]; else changes[key] = on;
}

/**
 * Takes the project's layers from the config (`layers`, as /cornfield/config.json carries it; anything that does not pass core/layers.js is
 * ignored), sets what each layer is by default (the config's `off`), then lays the viewer's own changes over that.
 * @param {unknown} raw
 */
export function setProjectLayers(inst, raw) {
  const { state } = inst;
  const cfg = clientLayers(raw);
  state.projectLayers = cfg.add;
  state.layerOrder = cfg.order;
  const defaults = {};
  for (const l of LAYER_DEFS) defaults[l.key] = !STARTS_OFF.has(l.key);
  for (const l of cfg.add) defaults[l.key] = true;
  for (const k of cfg.off) defaults[k] = false;
  state.layerDefaults = defaults;
  const mem = memoryOf(inst);
  mem.changes = readChanges(inst);
  for (const [k, v] of Object.entries(defaults)) state.activeLayers[k] = v;
  for (const [k, v] of Object.entries(mem.changes)) state.activeLayers[k] = v;
  changed(inst);
}

/** The finer kinds and project layers on the map, so the theme's tokens for them are read (map-style.js `setSubjects`) */
export function syncMapSubjects(inst) {
  const { state } = inst;
  const seen = new Set();
  const kinds = [];
  state.nodes.forEach((n) => {
    if (typeof n.kind !== 'string' || !n.kind) return;
    const id = `${n.type}\u0000${n.kind}`;
    if (!seen.has(id)) { seen.add(id); kinds.push([n.type, n.kind]); }
  });
  mapStyleOf(inst).setSubjects({ kinds, layers: state.projectLayers.map((l) => l.key) });
}

/** The nodes, their kinds and the theme's tokens for them are as they are now: the menu is drawn again (and the map reads the tokens of a kind it has not met) */
export function redrawLayers(inst) {
  const mem = inst.slot('layers-draw', () => ({ drawing: false }));
  mem.drawing = true;
  try { syncMapSubjects(inst); } finally { mem.drawing = false; } // reading the tokens of a new kind may tell the style listener of the menu: this draw already has them
  inst.emit('layers:redraw');
}

/** Whether the menu is being drawn in answer to the map's own style (it must not draw again for it) */
export const redrawing = (inst) => inst.slot('layers-draw', () => ({ drawing: false })).drawing;

/** Calls `fn` after a layer goes on or off (live.js starts or stops the live layer). Returns how to stop. */
export const onLayersChange = (inst, fn) => inst.on('layers', fn);

function changed(inst) {
  inst.touchScene();
  inst.emit('layers');
  redrawLayers(inst);
  if (!inst.map) return; // a scope sets the project's layers before the map piece is there; it draws them when it comes
  inst.map.render();
  inst.map.ensureFlowLoop();
}

/**
 * Sets a layer on or off. `viewer`: the person chose it in the menu, so it is kept in their browser; a layer another part of the app
 * turns on (a deploy that lights a stack) is not a choice of theirs and is not kept. While a proposal is under review the choice is the review's:
 * kept for the review only (`state.review.manual`, or `.step` when a playing scenario needs the layer: `scenario`), never in `activeLayers` or the browser.
 */
export function setLayer(inst, key, on, { viewer = false, scenario = false } = {}) {
  const { state } = inst;
  const review = state.review && state.proposal ? state.review : null;
  if (review) {
    (scenario ? review.step : review.manual)[key] = on;
    review.rev++;
  } else {
    state.activeLayers[key] = on;
    if (viewer) { keep(inst, key, on); writeChanges(inst); }
  }
  changed(inst);
  if (viewer) {
    const { layers, overlays } = layerRows(inst);
    const layer = [...layers, ...overlays].find((l) => l.key === key);
    const n = state.nodes.filter((x) => inst.map.isNodeVisible(x)).length;
    announce(inst, `${layer ? layer.label : key} ${on ? 'on' : 'off'}${review ? ' for this review' : ''}. ${n} ${n === 1 ? 'node' : 'nodes'} shown.`);
  }
}

/** Flips a layer (what a click on its row does); see `setLayer` */
export function toggleLayer(inst, key, opts = {}) {
  setLayer(inst, key, !layerOn(inst.state, key), opts);
}

/** All / None: every layer on or off, never an overlay; the root stays drawn. During a review it is the review's state that changes, not the viewer's */
export function toggleAllLayers(inst, on, { viewer = false } = {}) {
  const { state } = inst;
  const { layers } = layerRows(inst);
  const keys = new Set([...LAYER_DEFS.filter((l) => !l.overlay).map((l) => l.key), ...state.projectLayers.map((l) => l.key), ...layers.map((l) => l.key)]);
  const review = state.review && state.proposal ? state.review : null;
  if (review) { keys.forEach((k) => { review.manual[k] = on; }); review.rev++; } else {
    keys.forEach((k) => { state.activeLayers[k] = on; if (viewer) keep(inst, k, on); });
    if (viewer) writeChanges(inst);
  }
  changed(inst);
  if (viewer) {
    const n = state.nodes.filter((x) => inst.map.isNodeVisible(x)).length;
    announce(inst, `${on ? 'All' : 'No'} layers on${review ? ' for this review' : ''}. ${n} ${n === 1 ? 'node' : 'nodes'} shown.`);
  }
}

// ---------------------------------------------------------------------------
//  The review narrows the map to the change (issue #232)
//  The hiding is the review's, never the viewer's: `state.review` holds it (layer-model.js `layersOf` reads it), `activeLayers` and the saved choices are not touched.
// ---------------------------------------------------------------------------

/** A proposal is opened: a fresh review ("Show the whole map" off, nothing turned on by hand yet), also when one was already open */
export function beginReview(inst) {
  inst.state.review = { whole: false, manual: {}, step: {}, rev: 0 }; // the map and the menu are drawn by the caller, once the proposal is on the map (proposal.js rebuildProposalMap)
}

/** The proposal is closed: the viewer's own layers are what is drawn again, exactly as they were */
export function endReview(inst) {
  if (!inst.state.review) return;
  inst.state.review = null;
  inst.touchScene();
  redrawLayers(inst);
}

/** What a screen reader hears when a review opens and hid layers: "Showing 4 of 22 layers: the ones this proposal changes." Nothing when no layer was hidden */
export function reviewLayersLine(inst) {
  const { state } = inst;
  if (!state.review || !state.proposal || state.review.whole) return '';
  const { layers } = layerRows(inst);
  const held = new Set(state.nodes.map((n) => rowKeyOf(state, n))); // a layer that holds no node has nothing to hide
  if (!layers.some((l) => held.has(l.key) && reviewHides(state, l.key))) return '';
  const on = layers.filter((l) => isOn(inst, l.key)).length;
  return `Showing ${on} of ${layers.length} layers: the ones this proposal changes.`;
}

/** "Show the whole map": on brings back every layer the viewer has on and the proposal's dimming of the rest (Diff as it always was); off narrows to the change again. Said once, here */
export function setWholeMap(inst, on) {
  const { state } = inst;
  const review = state.review && state.proposal ? state.review : null;
  if (!review || review.whole === on) return;
  review.whole = on;
  review.rev++;
  changed(inst);
  announce(inst, on ? 'Showing the whole map.' : (reviewLayersLine(inst) || 'Showing the change: the rest of the map is greyed.'));
}

/** A scenario ended: the layers it turned on for the review go off again (the focused view comes back). True when there were any */
export function clearStepLayers(inst) {
  const { review } = inst.state;
  if (!review || !Object.keys(review.step).length) return false;
  review.step = {};
  review.rev++;
  inst.touchScene();
  redrawLayers(inst);
  return true;
}

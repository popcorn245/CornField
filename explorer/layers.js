/**
 * @module explorer/layers
 *
 * The Layers menu: one toggle per kind of node (apps, pages, tables, services, ...) with its
 * count, plus the legend of what the lines mean. The data-flow preset ignores the toggles. Outside nodes are
 * two layers by their kind (spec 0031): Cloud, and the Public web; the Cloud legend says what a call's `when` looks like.
 */

import { state, touchScene, escHtml } from './state.js';
import { render, ensureFlowLoop, isNodeVisible } from './render.js';
import { renderFlowLegend } from './flows.js';
import { WHEN_STYLES } from './cloud-model.js';
import { themed } from './theme-model.js';
import { onThemeChange } from './theme.js';
import { NODE_THEMES } from '../core/schema.js';
import { STARTING_LAYERS, clientLayers, kindLetters, orderRows, startingLayerOf } from '../core/layers.js';
import { rowKeyOf, shownByProposal } from './layer-model.js';
import { fillOfNode, groupOf, layerShows } from './scene.js';
import { STROKE_TOKEN, cssColor, fillOf, getMapStyle, kindToken, onMapStyleChange, pageReader, setMapSubjects } from './map-style.js';
import { over, parseColor, contrast } from '../core/color.js';
import { DARK_GROUND, LIGHT_GROUND } from './theme-model.js';
import { t } from './strings.js';

/** The types a starting row's nodes have (House: floors and rooms; Cloud and the Public web: `external`), or none for a row that is not a node type */
const typesOf = (l) => (l.match && l.match.type ? [].concat(l.match.type) : []);
/** The dot of the two rows that are not a node type: Data Flow's lines and the ring of a run in flight. Every other row's built-in dot is its
 * first type's colour in core/schema.js NODE_THEMES, the colour the map draws its nodes in when the theme sets none (one table, not two) */
const NOT_A_TYPE = { flow: '#fb923c', runs: '#5eead4' };
const builtIn = (l) => { const type = typesOf(l)[0]; return type && NODE_THEMES[type] ? NODE_THEMES[type].color : NOT_A_TYPE[l.key]; };
/** The starting layers that start off: the infra layer is its own view, and the physical world's are loaded when first turned on (spec 0029) */
const STARTS_OFF = new Set(['stack', 'machine', 'container', 'device', 'house', 'persona']);

/** The starting rows (core/layers.js STARTING_LAYERS) with the colour of their dot */
export const LAYER_DEFS = STARTING_LAYERS.map((l) => ({ ...l, color: builtIn(l) }));

const layerListeners = new Set();
/** Calls `fn` after a layer goes on or off (live.js starts or stops the live layer). Returns how to stop. */
export function onLayersChange(fn) {
  layerListeners.add(fn);
  return () => layerListeners.delete(fn);
}

/** The menu open or shut, and its button saying which (aria-expanded) */
function setLegendMenu(open) {
  const menu = document.getElementById('legend-dropdown');
  if (menu) menu.hidden = !open;
  const btn = document.getElementById('legend-toggle-btn');
  if (btn) btn.setAttribute('aria-expanded', String(open));
}

export function toggleLegendMenu() {
  const menu = document.getElementById('legend-dropdown');
  if (menu) setLegendMenu(menu.hidden);
}

export function closeLegendMenu() {
  setLegendMenu(false);
}

/**
 * A click anywhere on the page: runs its action (`act`), then closes the Layers menu if the click was outside it. Whether it was inside is
 * read BEFORE the action: a row's action draws the rows again, the clicked node is then out of the page, and asking afterwards would take a
 * click on a row for a click outside the menu (main.js's document click handler).
 * @param {EventTarget | null} target the click's target
 * @param {() => void} act
 */
export function clickWithLegendMenu(target, act) {
  const menu = document.getElementById('legend-dropdown');
  const btn = document.getElementById('legend-toggle-btn');
  const inside = !!menu && target instanceof Node && (menu.contains(target) || (!!btn && btn.contains(target)));
  act();
  if (menu && !menu.hidden && !inside) closeLegendMenu();
}

// ---------------------------------------------------------------------------
//  The rows (spec 0009 D1, D3, D8)
// ---------------------------------------------------------------------------

/** What a layer is when the viewer has not touched it: the config's `off`, else a starting layer's own default, else on */
const defaultOf = (key) => (Object.hasOwn(state.layerDefaults, key) ? state.layerDefaults[key] : !STARTS_OFF.has(key));
const isOn = (key) => state.activeLayers[key] !== false;

const NO_COLOR = '#94a3b8';
/** A colour as the dot's style may hold it: a hex or an rgb()/rgba() of numbers, else the plain grey. A node's colour is the map's data
 * (a proposal can set it), so it is checked before it reaches a style attribute, and escaped there all the same */
const NUM = '\\d{1,3}(?:\\.\\d+)?%?';
const SWATCH_RE = new RegExp(`^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\\(\\s*${NUM}(?:\\s*,\\s*|\\s+)${NUM}(?:\\s*,\\s*|\\s+)${NUM}(?:\\s*[,/]\\s*(?:\\d*\\.)?\\d+%?)?\\s*\\))$`, 'i');
const swatch = (c) => (typeof c === 'string' && c.length <= 64 && SWATCH_RE.test(c.trim()) ? c.trim() : NO_COLOR);

/**
 * The colour of a row's dot: the fill the map draws for the row's nodes, by the map's own order (map-style.js `fillOf`: the type's or layer's
 * token, then the starting group's), else the row's built-in colour on this ground (`themed`). `node` is what the row's nodes are: for a
 * starting row its type (`typeOfRow`: a row of two types, House, speaks for its first, floors, so `--corn-map-group-house` is its dot unless
 * the theme gives floors a colour of their own) and its key as the group; for a project row its first node's type with the layer. A finer kind's token is left out: a dot is a row's, not a kind's.
 * A token's value is the theme's text and a node's colour is the project's: both go through `swatch` before they reach a style.
 */
function rowColor(node, built) {
  const fill = fillOf(getMapStyle().values, node);
  // The built-in is a node's colour (project data): normalised as the map's renderers read it (`cssColor`, the reader of the tokens), so a
  // name or an `hsl()` the map draws is the dot too; anything that is not a colour is the grey
  return fill ? swatch(fill) : swatch(cssColor(themed(built, state.theme)));
}
/** The type a row's dot speaks for: of a row of several types (House), the first one the map holds, else the first; a row with no type, its key */
const typeOfRow = (l) => { const types = typesOf(l); return (types.length > 1 && types.find((ty) => state.nodes.some((n) => n.type === ty))) || types[0] || l.key; };

/** The ground of the menu: its surface laid over the page, as `--corn-surface-1` and `--corn-ground` say, else the theme's own ground */
function menuSurface() {
  const fallback = state.theme === 'light' ? LIGHT_GROUND : DARK_GROUND;
  const read = pageReader();
  if (!read) return fallback;
  const ground = parseColor(read('--corn-ground'));
  const surface = parseColor(read('--corn-surface-1'));
  if (!ground[3] || !surface[3]) return fallback;
  const [r, g, b] = over(surface, over(ground, [0, 0, 0, 1]));
  return `rgb(${r}, ${g}, ${b})`;
}
/** The outline a dot or swatch gets when its fill is under 3:1 on the menu: the map's own outline colour when the theme sets one, else the CSS default (`.is-ringed`). The fill is never changed */
function ringOf(color, surface) {
  if (contrast(color, surface) >= 3) return null;
  const stroke = getMapStyle().values[STROKE_TOKEN];
  return { stroke: stroke ? swatch(stroke) : '' };
}
/** A swatch of `color` on this menu: the fill, a soft glow on a dark ground, and the outline when it is needed. `extra` is more attributes (a kind's is `aria-hidden`) */
function dot(color, on, surface, extra = '') {
  const ring = ringOf(color, surface);
  const glow = on && state.theme !== 'light' ? (/^#[0-9a-f]{6}$/i.test(color) ? `0 0 8px ${color}90` : `0 0 8px color-mix(in srgb, ${color} 56%, transparent)`) : 'none';
  const style = `background-color: ${color}; box-shadow: ${glow}${ring && ring.stroke ? `; --hx-dot-ring: ${ring.stroke}` : ''}`;
  return `<span class="hx-dot${extra ? ' hx-kind-swatch' : ''}${ring ? ' is-ringed' : ''}" data-corn="swatch"${extra} style="${escHtml(style)}"></span>`;
}

/**
 * The rows: the project layers that hold a node, then the starting ones in their usual order (`layers.order` first of all), and one more
 * for any node type on this map that none of them covers (a type a plugin or a newer sync adds), so every type present can be turned off.
 * `root` is always shown and has no row. The overlays are the rows with `overlay`: the menu draws them under their own heading.
 */
function layerRows() {
  const dotted = (l) => { const type = typeOfRow(l); return { ...l, color: rowColor({ type, group: l.key }, NODE_THEMES[type] ? NODE_THEMES[type].color : l.color) }; };
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
    return { color: rowColor(first ? { type: first.type, layer: l.key, group: groupOf(first) } : { type: l.key, layer: l.key }, first ? fillOfNode(first) : NO_COLOR) };
  };
  const project = state.projectLayers.filter((l) => held.has(l.key)).map((l) => ({ key: l.key, label: l.label, desc: l.desc || '', project: true, ...projectDot(l) }));
  // A starting row a project layer has taken every node from goes (spec 0009 D7, example 3); with no project layer, every starting row stays, as it always was
  const starting = LAYER_DEFS.filter((l) => !l.overlay && (held.has(l.key) || !left.has(l.key))).map(dotted);
  const known = new Set([...LAYER_DEFS.map((l) => l.key), ...state.projectLayers.map((l) => l.key)]);
  const extra = [];
  held.forEach((key) => {
    if (known.has(key)) return;
    known.add(key);
    extra.push({ key, label: key.charAt(0).toUpperCase() + key.slice(1), color: rowColor({ type: key, group: key }, NO_COLOR), desc: `Nodes of the type ${key}` });
  });
  return { layers: [...orderRows(project, starting, state.layerOrder), ...extra], overlays: LAYER_DEFS.filter((l) => l.overlay).map(dotted) };
}

/** The chip says how many layers are on: " · 13 of 20". An overlay (Runs in flight) is not a layer: it is not counted */
function paintCount() {
  const el = document.getElementById('layers-count');
  if (!el) return;
  const { layers } = layerRows();
  const on = layers.filter((l) => isOn(l.key)).length;
  el.textContent = ` · ${on} of ${layers.length}`;
}

// ---------------------------------------------------------------------------
//  What the viewer changed is kept in their browser (only the changes, so a layer the config adds later arrives with its default)
// ---------------------------------------------------------------------------
const STORE_KEY = 'cornfield:layers';
let changes = {};
const KEY_SHAPE = /^[a-z][a-z0-9-]{0,40}$/;

function readChanges() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([k, v]) => KEY_SHAPE.test(k) && typeof v === 'boolean'));
  } catch { return {}; }
}
function writeChanges() {
  try {
    if (Object.keys(changes).length) window.localStorage.setItem(STORE_KEY, JSON.stringify(changes)); else window.localStorage.removeItem(STORE_KEY);
  } catch { /* storage blocked: the choice holds for this visit */ }
}
/** Records what the viewer chose for a layer: a value equal to its default is no change */
function keep(key, on) {
  if (on === defaultOf(key)) delete changes[key]; else changes[key] = on;
}

/**
 * Takes the project's layers from the config (`layers`, as /cornfield/config.json carries it; anything that does not pass core/layers.js is
 * ignored), sets what each layer is by default (the config's `off`), then lays the viewer's own changes over that.
 * @param {unknown} raw
 */
export function setProjectLayers(raw) {
  const cfg = clientLayers(raw);
  state.projectLayers = cfg.add;
  state.layerOrder = cfg.order;
  const defaults = {};
  for (const l of LAYER_DEFS) defaults[l.key] = !STARTS_OFF.has(l.key);
  for (const l of cfg.add) defaults[l.key] = true;
  for (const k of cfg.off) defaults[k] = false;
  state.layerDefaults = defaults;
  changes = readChanges();
  for (const [k, v] of Object.entries(defaults)) state.activeLayers[k] = v;
  for (const [k, v] of Object.entries(changes)) state.activeLayers[k] = v;
  changed();
}

// ---------------------------------------------------------------------------
//  The menu
// ---------------------------------------------------------------------------
/** The rows whose kinds are open ("5 kinds"), by key: kept across redraws */
const openKinds = new Set();

/** "1 link", "3 in flight", else the number */
const UNIT = Object.assign(Object.create(null), { flow: (n) => `${n} ${n === 1 ? 'link' : 'links'}`, runs: (n) => `${n} in flight` });

/** The finer kinds of each row: `{ key: [{ kind, letters, n }] }`, by name, from the nodes the row holds (an outside node's kind is its layer, not a finer one) */
function kindsByRow(rowOf) {
  const letters = kindLetters(state.nodes);
  const rows = new Map();
  state.nodes.forEach((n) => {
    if (typeof n.kind !== 'string' || !n.kind || n.type === 'external') return;
    const key = rowOf(n);
    if (!key) return;
    if (!rows.has(key)) rows.set(key, new Map());
    const id = `${n.type}\u0000${n.kind}`;
    const entry = rows.get(key).get(id) || { type: n.type, kind: n.kind, letters: letters.get(n.type).get(n.kind), n: 0 };
    entry.n++;
    rows.get(key).set(id, entry);
  });
  return new Map([...rows].map(([k, m]) => [k, [...m.values()].sort((a, b) => a.kind.localeCompare(b.kind))]));
}

/** The swatch of a kind: the theme's `--corn-map-kind-<type>-<kind>`, as the map draws that kind, or nothing when the token is unset (the node then has its type's colour, which is the row's dot). Decoration: the letters and the name say which kind it is */
function kindSwatch(k, surface, pad) {
  const fill = getMapStyle().values[kindToken(k.type, k.kind)];
  if (!fill) return pad ? '<span class="hx-dot hx-kind-swatch is-blank" aria-hidden="true"></span>' : ''; // nothing to see, but the letters of the rows stay in line
  return dot(swatch(fill), true, surface, ' aria-hidden="true"');
}

/** What a viewer sees as "kinds" for a row: the disclosure button and, when open, the key rows. A key is a key, not a toggle (spec 0009 D5) */
function kindsHtml(layer, kinds, surface) {
  if (!kinds || !kinds.length) return '';
  const open = openKinds.has(layer.key);
  const id = `layer-kinds-${layer.key}`;
  const words = `${kinds.length} ${kinds.length === 1 ? 'kind' : 'kinds'}`;
  const padded = kinds.some((k) => getMapStyle().values[kindToken(k.type, k.kind)]);
  const list = open ? `<ul class="hx-kind-keys" id="${escHtml(id)}">${kinds.map((k) => `<li class="hx-kind-key" data-corn="kind-key">${kindSwatch(k, surface, padded)}<span class="hx-kind-letter" aria-hidden="true">${escHtml(k.letters)}</span><span class="hx-kind-name">${escHtml(k.kind)}</span><span class="hx-count" data-corn="count">${k.n}</span></li>`).join('')}</ul>` : '';
  return `<div class="hx-kinds"><button type="button" class="hx-textbtn hx-kinds-btn" data-action="toggle-layer-kinds" data-layer="${escHtml(layer.key)}" aria-expanded="${open}" aria-controls="${escHtml(id)}" data-corn="layer-kinds" data-corn-kind="quiet">${open ? '▾' : '▸'} ${escHtml(words)}</button>${list}</div>`;
}

/** The finer kinds and project layers on the map, so the theme's tokens for them are read (map-style.js `setMapSubjects`) */
function syncMapSubjects() {
  const seen = new Set();
  const kinds = [];
  state.nodes.forEach((n) => {
    if (typeof n.kind !== 'string' || !n.kind) return;
    const id = `${n.type}\u0000${n.kind}`;
    if (!seen.has(id)) { seen.add(id); kinds.push([n.type, n.kind]); }
  });
  setMapSubjects({ kinds, layers: state.projectLayers.map((l) => l.key) });
}

let drawing = false;
export function renderLayerToggles() {
  drawing = true;
  try { syncMapSubjects(); } finally { drawing = false; } // reading the tokens of a new kind may tell the style listener below: this draw already has them
  paintCount();
  const container = document.getElementById('layer-toggles-container');
  if (!container) return;

  // Nodes by row. Data Flow has no nodes of its own: it counts its links, and says so; Runs in flight counts runs
  const rowOf = (n) => rowKeyOf(state, n);
  // Keyed by layer key: a project's key may be any word, "constructor" too, so these have no prototype to read through
  const counts = Object.create(null);
  const byProposal = Object.create(null);
  state.nodes.forEach((n) => {
    const key = rowOf(n);
    if (!key) return;
    counts[key] = (counts[key] || 0) + 1;
    if (!layerShows(state, n) && shownByProposal(state, n)) byProposal[key] = (byProposal[key] || 0) + 1;
  });
  counts.flow = state.edges.filter((e) => e.kind === 'flow').length;
  counts.runs = state.runsMap ? state.runsMap.flight.size : 0;
  const kinds = kindsByRow(rowOf);
  const { layers, overlays } = layerRows();
  const surface = menuSurface();

  const row = (layer) => {
    const on = isOn(layer.key);
    const shown = byProposal[layer.key] ? `<span class="hx-faint hx-layer-note" data-corn="layer-note">+${byProposal[layer.key]} shown by the proposal</span>` : '';
    return `
      <button type="button" class="hx-toggle-row${on ? '' : ' is-off'}" data-action="toggle-layer" data-layer="${escHtml(layer.key)}" aria-pressed="${on}" title="${escHtml(layer.desc)}" data-corn="row">
        <span class="hx-toggle-label">
          ${dot(swatch(layer.color), on, surface)}
          <span class="hx-toggle-name">${escHtml(layer.label)}</span>${layer.live ? '<span class="hx-live-tag" data-corn="live-tag">live</span>' : ''}
        </span>
        <span class="hx-toggle-meta">${shown}
          <span class="hx-count" data-corn="count">${(UNIT[layer.key] || String)(counts[layer.key] || 0)}</span>
          <span class="hx-tick">${on ? '✓' : '—'}</span>
        </span>
      </button>${kindsHtml(layer, kinds.get(layer.key), surface)}`;
  };

  // The focus stays where it was across the redraw: the same row or disclosure, found again by what it names
  const active = document.activeElement && container.contains(document.activeElement) ? document.activeElement : null;
  const was = active ? { action: active.getAttribute('data-action'), layer: active.getAttribute('data-layer') } : null;
  container.innerHTML = layers.map(row).join('')
    + (overlays.length ? `<div class="hx-menu-title hx-overlays" data-corn="overlays"><span>${escHtml(t('overlays'))}</span></div>${overlays.map(row).join('')}` : '');
  if (was) {
    const again = [...container.querySelectorAll('[data-action]')].find((el) => el.getAttribute('data-action') === was.action && el.getAttribute('data-layer') === was.layer);
    if (again && typeof again.focus === 'function') again.focus({ preventScroll: true });
  }
  renderFlowLegend();
  renderCloudLegend();
}

/** What a call into a cloud node looks like for its `when` (spec 0031 section 6), while the Cloud layer is on */
export function renderCloudLegend() {
  const el = document.getElementById('cloud-legend');
  if (!el) return;
  if (state.activeLayers.cloud === false) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `
    <div class="hx-menu-title" data-corn="menu-title"><span>Cloud: when an outage bites</span></div>
    ${Object.entries(WHEN_STYLES).map(([when, s]) => `<div class="hx-legend-row"><span class="hx-legend-swatch"><span data-corn="swatch" class="hx-swatch-line hx-swatch-when hx-swatch-when--${when} hx-swatch-when--plain"></span></span><span>${s.legend}</span></div>`).join('')}
    <div class="hx-legend-row"><span class="hx-legend-swatch"></span><span class="hx-faint"><span class="hx-cloud-browser">(browser)</span> the visitor's browser makes the call, not our server</span></div>`;
}

function changed() {
  touchScene();
  layerListeners.forEach((fn) => fn());
  renderLayerToggles();
  render();
  ensureFlowLoop();
}

/** The words a screen reader gets when a layer goes on or off, with how many nodes it now draws */
function say(text) {
  const el = document.getElementById('map-announcer');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 30);
}

/**
 * Turns a layer on or off. `viewer`: the person chose it in the menu, so it is kept in their browser; a layer another part of the app
 * turns on (a deploy that lights a stack) is not a choice of theirs and is not kept.
 */
export function toggleLayer(key, { viewer = false } = {}) {
  const on = state.activeLayers[key] === false; // a layer with no entry yet is on, as the toggles show it
  state.activeLayers[key] = on;
  if (viewer) { keep(key, on); writeChanges(); }
  changed();
  if (viewer) {
    const { layers, overlays } = layerRows();
    const layer = [...layers, ...overlays].find((l) => l.key === key);
    const n = state.nodes.filter((x) => isNodeVisible(x)).length;
    say(`${layer ? layer.label : key} ${on ? 'on' : 'off'}. ${n} ${n === 1 ? 'node' : 'nodes'} shown.`);
  }
}

/** All / None: every layer on or off, never an overlay; the root stays drawn */
export function toggleAllLayers(on, { viewer = false } = {}) {
  const { layers } = layerRows();
  const keys = new Set([...LAYER_DEFS.filter((l) => !l.overlay).map((l) => l.key), ...state.projectLayers.map((l) => l.key), ...layers.map((l) => l.key)]);
  keys.forEach((k) => { state.activeLayers[k] = on; if (viewer) keep(k, on); });
  if (viewer) writeChanges();
  changed();
  if (viewer) {
    const n = state.nodes.filter((x) => isNodeVisible(x)).length;
    say(`${on ? 'All' : 'No'} layers on. ${n} ${n === 1 ? 'node' : 'nodes'} shown.`);
  }
}

/** Opens or closes the kinds of one row ("5 kinds"); the focus stays on its button */
export function toggleLayerKinds(key) {
  if (openKinds.has(key)) openKinds.delete(key); else openKinds.add(key);
  renderLayerToggles();
}

// The dots and the legends are drawn in the theme's colours: drawn again when it changes (theme.js)
onThemeChange(() => renderLayerToggles());
// ... and when the map's own tokens change (a named theme, its stylesheet arriving, light and dark): the same signal the map is drawn again on
onMapStyleChange(() => { if (!drawing) renderLayerToggles(); });

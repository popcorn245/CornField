/**
 * @module explorer/history
 *
 * A node's history on an instance (spec 0014 D2): reads `GET /api/history` (core/history.js) once, the first time the node panel asks, and
 * answers the panel's History section; picking a spec lights every node its commits touched (`state.historyPick`, which scene.js dims around).
 * Nothing is fetched while the config says `history: false`, and the panel then has no History section, the Layers menu no History row.
 *
 * The History layer (spec 0014 D3): a row under Overlays, off to start and remembered like the others. While it is on, each node the history changed
 * wears a halo, its width how often and its colour how lately (as of the timeline's commit, `state.historyAt`, else the newest). A DOM layer over the map,
 * like the runs' marks, decoration for the eye (`aria-hidden`): the words are the node panel's History section. While a spec is picked a bar on the map
 * names it, what it reached, and how to show the whole map again.
 *
 *   initHistory(inst, config)   once, with the client config (`history`, `forge`); returns how to stop
 *
 * What it answers and hears (instance.js lists them):
 *   history:section  node -> HTML | undefined   the node panel's History section; asking starts the one read
 *   history:pick     spec | null  (emit)        light what that spec reached, or nothing; picking the lit spec again ends it
 *   history:all      (none) (emit)              the section lists every commit, not only the newest
 *   history:changed  (none) (emitted)           the read ended, or a pick changed: the open panel draws its History section again
 *   history:legend   { active } (emitted)       the History layer is drawn: the Layers menu shows its legend
 */

import { credentialed } from './engine/connection.js';
import { announce } from './engine/keyboard.js';
import { onLayersChange, redrawLayers } from './engine/layers.js';
import { layerOn } from './layer-model.js';
import { HISTORY_LAYER, MAX_HALOS, forgeLinks, haloWidth, heatOf, historyRowOf, historySectionHtml, specBarHtml, specFiles, specReach } from './history-model.js';

/** Where the server answers the history (server/server.js) */
export const HISTORY_PATH = '/api/history';

/**
 * @param {ReturnType<typeof import('./instance.js').createInstance>} inst
 * @param {{ history?: boolean, forge?: object | null }} config the client config (/cornfield/config.json)
 * @returns {() => void}
 */
export function initHistory(inst, config) {
  /** The dot of the Layers menu's row: this week's halo colour, as the theme has it */
  const haloColor = () => {
    const root = inst.doc && inst.doc.documentElement;
    const view = inst.doc && inst.doc.defaultView;
    const v = root && view && view.getComputedStyle ? view.getComputedStyle(root).getPropertyValue('--corn-history-week').trim() : '';
    return v || 'currentColor';
  };
  const { state } = inst;
  const on = !!(config && config.history === true);
  const mem = { status: on ? 'idle' : 'off', history: null, error: '', all: false, node: null, links: forgeLinks(config && config.forge), specs: null };
  const stops = [];
  const halos = new Map(); // the halo elements by node id, kept between frames
  let heat = null; // heatOf, for the history and the commit it was worked out for
  let placed = '';
  let layerEl = null;
  let barEl = null;

  const stage = () => (state.canvas && state.canvas.parentElement) || null;
  // Off until the layers have their defaults (a layer with no entry reads as on), and never in the Work view
  const haloOn = () => mem.status !== 'off' && !state.workRows && Object.hasOwn(state.layerDefaults || {}, HISTORY_LAYER) && layerOn(state, HISTORY_LAYER);
  const heatNow = () => {
    if (mem.status !== 'ready') return null;
    const at = Number.isInteger(state.historyAt) ? state.historyAt : null;
    if (!heat || heat.of !== mem.history || heat.asked !== at) heat = { of: mem.history, asked: at, ...heatOf(mem.history, at) };
    return heat;
  };

  function clearHalos() {
    for (const el of halos.values()) el.remove();
    halos.clear();
    placed = '';
    if (layerEl) layerEl.hidden = true;
  }

  /** Puts a halo on each node the history changed, at the camera: only their place changes on a pan */
  function syncHalos(scene, camera) {
    const h = haloOn() ? heatNow() : null;
    if (!h || !h.nodes.size) { if (halos.size || (layerEl && !layerEl.hidden)) clearHalos(); return; }
    const key = `${scene.version}|${camera.x}|${camera.y}|${camera.zoom}|${h.at}`;
    if (key === placed && layerEl && layerEl.isConnected) return;
    const host = stage();
    if (!host) return;
    if (!layerEl || !layerEl.isConnected) {
      layerEl = inst.doc.createElement('div');
      layerEl.className = 'hx-history-halos';
      layerEl.setAttribute('aria-hidden', 'true');
      host.append(layerEl);
      halos.clear();
    }
    placed = key;
    layerEl.hidden = false;
    const seen = new Set();
    for (const node of scene.nodes) {
      if (seen.size >= MAX_HALOS) break;
      const it = h.nodes.get(node.id);
      if (!it || !(node.alpha > 0.2)) continue;
      seen.add(node.id);
      let el = halos.get(node.id);
      if (!el) {
        el = inst.doc.createElement('span');
        el.className = 'hx-history-halo';
        el.dataset.node = node.id;
        layerEl.append(el);
        halos.set(node.id, el);
      }
      const w = haloWidth(it.count, h.max);
      el.dataset.band = it.band;
      el.style.left = `${(node.x * camera.zoom + camera.x).toFixed(1)}px`;
      el.style.top = `${(node.y * camera.zoom + camera.y).toFixed(1)}px`;
      el.style.setProperty('--r', `${(Math.max(6, node.r * camera.zoom) + 3 + w / 2).toFixed(1)}px`);
      el.style.setProperty('--w', `${w}px`);
    }
    for (const [id, el] of halos) if (!seen.has(id)) { el.remove(); halos.delete(id); }
  }

  /** The bar on the map while a spec is picked */
  function paintBar() {
    const pickNow = state.historyPick;
    if (!pickNow) { if (barEl) { barEl.remove(); barEl = null; } return; }
    const host = stage();
    if (!host) return;
    if (!barEl || !barEl.isConnected) {
      barEl = inst.doc.createElement('div');
      barEl.className = 'hx-history-bar glass';
      barEl.setAttribute('role', 'group');
      barEl.setAttribute('aria-label', 'Picked spec');
      barEl.addEventListener('click', (e) => { if (e.target.closest('[data-history-unpick]')) pick(null); });
      host.append(barEl);
    }
    if (!mem.specs) mem.specs = specFiles(state.nodes);
    barEl.innerHTML = specBarHtml(pickNow, { links: mem.links, specs: mem.specs });
  }

  /** The layer went on or off, or the read ended: the row's count, the legend and the halos follow */
  function layerChanged() {
    const on = haloOn();
    if (on && mem.status === 'idle') load();
    inst.emit('history:legend', { active: on && mem.status === 'ready' });
    if (!on) clearHalos();
    placed = '';
    if (inst.map) inst.map.render();
  }

  async function load() {
    if (mem.status !== 'idle') return;
    mem.status = 'loading';
    try {
      const res = await credentialed(inst)(HISTORY_PATH);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.ok !== true) throw new Error(body && typeof body.error === 'string' ? body.error : `The history could not be read (${res.status}).`);
      mem.history = body;
      mem.status = 'ready';
    } catch (err) {
      mem.status = 'error';
      mem.error = inst.offline() ? 'You are offline, so the history could not be read.' : String(err && err.message ? err.message : err);
    }
    inst.emit('history:changed');
    redrawLayers(inst); // the row's count
    layerChanged();
  }

  function pick(spec) {
    if (!spec || (state.historyPick && state.historyPick.spec === spec) || mem.status !== 'ready') {
      if (!state.historyPick) return;
      state.historyPick = null;
      announce(inst, 'Showing the whole map again');
    } else {
      const { nodes, commits } = specReach(mem.history, spec);
      state.historyPick = { spec, nodes, commits };
      announce(inst, `Spec ${spec}: ${commits} ${commits === 1 ? 'commit' : 'commits'} reached ${nodes.size} ${nodes.size === 1 ? 'node' : 'nodes'}; the rest is dimmed`);
    }
    inst.touchScene();
    paintBar();
    if (inst.map) inst.map.render();
    inst.emit('history:changed');
  }

  if (mem.status !== 'off') {
    // The Layers menu's row under Overlays (engine/layers.js `layerRows`), in the colour of this week's halo
    state.historyRow = () => historyRowOf(mem.status, mem.status === 'ready' ? heatNow() : null, haloColor());
    stops.push(onLayersChange(inst, layerChanged));
    if (inst.map) stops.push(inst.map.onPaint((scene, camera) => syncHalos(scene, camera)));
    stops.push(inst.on('history:at', () => { placed = ''; if (inst.map) inst.map.render(); redrawLayers(inst); }));
    if (haloOn()) layerChanged();
  }

  stops.push(inst.on('history:section', (node) => {
    if (mem.status === 'off' || !node || typeof node.id !== 'string') return undefined;
    if (mem.node !== node.id) { mem.node = node.id; mem.all = false; } // "Show all" is for the node it was pressed on
    if (mem.status === 'idle') load();
    if (!mem.specs) mem.specs = specFiles(state.nodes);
    return historySectionHtml(node, { history: mem.history, status: mem.status === 'idle' ? 'loading' : mem.status, error: mem.error, links: mem.links, specs: mem.specs, picked: state.historyPick ? state.historyPick.spec : null, all: mem.all });
  }));
  stops.push(inst.on('history:pick', (spec) => pick(typeof spec === 'string' ? spec : null)));
  // A selection cleared (the bare map, Escape, Close) ends a pick too: nothing on screen would say why the map is dim
  stops.push(inst.on('selection', () => { if (!state.selectedNode && state.historyPick) pick(null); }));
  stops.push(inst.on('history:all', () => { mem.all = true; inst.emit('history:changed'); }));
  return () => {
    stops.forEach((s) => s());
    clearHalos();
    if (layerEl) layerEl.remove();
    if (barEl) barEl.remove();
    state.historyRow = null;
    if (state.historyPick) { state.historyPick = null; inst.touchScene(); }
  };
}

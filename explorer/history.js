/**
 * @module explorer/history
 *
 * A node's history on an instance (spec 0014 D2): reads `GET /api/history` (core/history.js) once, the first time the node panel asks, and
 * answers the panel's History section; picking a spec lights every node its commits touched (`state.historyPick`, which scene.js dims around).
 * Nothing is fetched while the config says `history: false`, and the panel then has no History section.
 *
 *   initHistory(inst, config)   once, with the client config (`history`, `forge`); returns how to stop
 *
 * What it answers and hears (instance.js lists them):
 *   history:section  node -> HTML | undefined   the node panel's History section; asking starts the one read
 *   history:pick     spec | null  (emit)        light what that spec reached, or nothing; picking the lit spec again ends it
 *   history:all      (none) (emit)              the section lists every commit, not only the newest
 *   history:changed  (none) (emitted)           the read ended, or a pick changed: the open panel draws its History section again
 */

import { credentialed } from './engine/connection.js';
import { announce } from './engine/keyboard.js';
import { forgeLinks, historySectionHtml, specFiles, specReach } from './history-model.js';

/** Where the server answers the history (server/server.js) */
export const HISTORY_PATH = '/api/history';

/**
 * @param {ReturnType<typeof import('./instance.js').createInstance>} inst
 * @param {{ history?: boolean, forge?: object | null }} config the client config (/cornfield/config.json)
 * @returns {() => void}
 */
export function initHistory(inst, config) {
  const { state } = inst;
  const on = !!(config && config.history === true);
  const mem = { status: on ? 'idle' : 'off', history: null, error: '', all: false, node: null, links: forgeLinks(config && config.forge), specs: null };
  const stops = [];

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
  }

  function pick(spec) {
    if (!spec || (state.historyPick && state.historyPick.spec === spec) || mem.status !== 'ready') {
      if (!state.historyPick) return;
      state.historyPick = null;
      announce(inst, 'Showing the whole map again');
    } else {
      const { nodes, commits } = specReach(mem.history, spec);
      state.historyPick = { spec, nodes };
      announce(inst, `Spec ${spec}: ${commits} ${commits === 1 ? 'commit' : 'commits'} reached ${nodes.size} ${nodes.size === 1 ? 'node' : 'nodes'}; the rest is dimmed`);
    }
    inst.touchScene();
    if (inst.map) inst.map.render();
    inst.emit('history:changed');
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
  return () => { stops.forEach((s) => s()); if (state.historyPick) { state.historyPick = null; inst.touchScene(); } };
}

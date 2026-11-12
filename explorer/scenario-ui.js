/**
 * @module explorer/scenario-ui
 *
 * A bridge (spec 0011 D2 and D3, step 5): the scenario player is now the instance's (engine/player.js) and part of the changes piece
 * (pieces/changes.js). This file keeps the old names for the modules that are not yet on an instance (whatif.js, view.js, tests), bound to the page's
 * instance and to the piece the page mounts. It goes when the last of those callers is converted.
 */

import { pageInstance } from './state.js';
import { pagePiece } from './page-pieces.js';
import { demoScenario as demo } from './engine/player.js';

export const demoScenario = (nodes = pageInstance().state.nodes, edges = pageInstance().state.edges) => demo(nodes, edges);

const piece = () => pagePiece('changes', { anywhere: true });

/** Plays a scenario on the map, replacing any that is playing; returns the player */
export function playScenario(scenario, opts) { const p = piece(); return p ? p.playScenario(scenario, opts) : null; }
/** The cloud panel's Play button: plays "X is down" for a cloud node */
export function playOutage(id) { const p = piece(); return p ? p.playOutage(id) : null; }
/** The player of the scenario on the map, or null */
export const getPlayer = () => { const p = pagePiece('changes'); return p ? p.getPlayer() : null; };
/** Ends the scenario without touching the picture */
export function clearScenario(opts) { const p = pagePiece('changes'); if (p) p.clearScenario(opts); else pageInstance().state.scenario = null; }
/** Ends the scenario and redraws the map without it */
export function stopScenario() { const p = pagePiece('changes'); if (p) p.stopScenario(); }
/** What the frame loop calls every frame with its clock (a test can be the loop) */
export function tickScenario(now) { const p = pagePiece('changes'); if (p) p.tickScenario(now); }
export const wantsFrames = () => { const p = pagePiece('changes'); return !!p && p.wantsFrames(); };
/** The Layers keys that hide a node, or [] when no layer does */
export function layersHiding(node) { const p = piece(); return p ? p.layersHiding(node) : []; }
/** Calls `fn(snapshot)` on each change of the player (null when it closes). Returns how to stop. */
export const onPlayerChange = (fn) => pageInstance().on('scenario:player', fn);
/** The player is ready where the page has its place (page.js mounts the changes piece; a second call does nothing) */
export function initScenarioUi() { piece(); }
/** Starts the demo when the page was opened with `?scenario-demo=1` (call once the topology is loaded) */
export function maybeStartDemo(search = typeof location === 'undefined' ? '' : location.search) {
  if (new URLSearchParams(search).get('scenario-demo') !== '1') return false;
  const p = piece();
  return p ? p.demo(true) : false;
}
/** Who knows where the focus goes when the player closes, who knows the scenario after this one, who keeps a closed scenario's checks (the changes piece sets these itself; a test sets its own) */
export function setCloseFocus(fn) { const p = piece(); if (p) p.setCloseFocus(fn); }
export function setNextScenario(fn) { const p = piece(); if (p) p.setNextScenario(fn); }
export function setKeepChecksOnClose(fn) { const p = piece(); if (p) p.setKeepChecksOnClose(fn); }

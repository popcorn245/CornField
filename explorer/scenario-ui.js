/**
 * @module explorer/scenario-ui
 *
 * The browser half of the scenario player (spec 0012 B3, TOPO-10; the pure core is scenario.js).
 * `playScenario(scenario)` puts a player on the map: it keeps the player's snapshot in
 * `state.scenario` (scene.js lights it), shows a compact bar (title, "2 of 5 · text", previous,
 * play or pause, next, close), answers the keyboard (space, left and right arrows), and glides the
 * camera to the current step when that is off screen. The ROM simulation plays through here too.
 * The bar also holds the viewer's speed: a small menu of how long a step plays (2 s, 5 s, 10 s,
 * or Manual, which moves only on Next), kept in localStorage and applied to the running player.
 *
 * Frames: the player is a frame client of render.js's loop (`addFrameClient`), not a timer of its
 * own. It asks for frames only while playing or while the camera glides, so a paused or finished
 * scenario costs nothing, a hidden tab stops the loop, and under prefers-reduced-motion the steps
 * still change but the packet does not travel and the camera jumps.
 *
 * The scenario list: a `Scenarios · N` disclosure that appears whenever `state.proposal.scenarios`
 * is not empty (TOPO-09 sets `state.proposal`; this follows it through `onSceneTouch`). It sits as
 * a row inside the proposal bar, and at the stage's corner when there is no bar.
 *
 * On a phone (sheets.js, TOPO-18) the bar is a bottom sheet in `#sheet-dock`: a peek (title, step
 * counter and text) until expanded, and the camera follows a step into the part of the map the
 * sheets leave free.
 */

import { state, touchScene, onSceneTouch } from './state.js';
import { render, ensureFlowLoop, addFrameClient, isNodeVisible } from './render.js';
import { flowReduceMotion } from './flows.js';
import { registerSheet, unregisterSheet, collapseAllSheets, measureCovered, onCoveredChange } from './sheets.js';
import { createPlayer, cameraFor, parseSpeed, SPEED_CHOICES, SPEED_KEY } from './scenario.js';
import { edgeKey } from '../core/proposal.js';
import { checksVersion, closeChecks, decorateSnapshot, openChecks, paintChecks } from './check.js';
import { blastRadius, outageLayers, outageScenario } from './outage-model.js';
import { toggleLayer } from './layers.js';

/** A frame that arrives later than this (a tab that was hidden) counts as this long */
const MAX_FRAME_MS = 250;
/** How quickly the camera closes on its target: the time for it to cover about 63% of the way */
const GLIDE_MS = 140;

let player = null;
let bar = null;
let signature = '';
let glide = null; // { to: {x, y, zoom}, last: nowMs|null }
let list = null;

const $stage = () => (state.canvas ? state.canvas.parentElement : null);

// ---------------------------------------------------------------------------
//  Playing
// ---------------------------------------------------------------------------

/**
 * Plays a scenario on the map, replacing any that is playing.
 * @param {import('./scenario.js').Scenario} scenario
 * @param {{ autoplay?: boolean, stepMs?: number | 'manual' }} [opts] `autoplay` false opens it paused on the first step;
 *   `stepMs` is a speed for this scenario in place of the viewer's saved one
 * @returns {ReturnType<typeof createPlayer>} the player, for a caller that wants to drive it
 */
export function playScenario(scenario, opts = {}) {
  clearScenario();
  const speed = opts.stepMs ?? readSpeed();
  player = createPlayer(scenario, { stepMs: speed, maxFrameMs: MAX_FRAME_MS });
  showBar(speed);
  openChecks(scenario, () => { sync(); render(); }); // PHY-10: one batch of permission checks for the scenario (check.js)
  showOutageLayers(scenario);
  if (opts.autoplay !== false) player.play();
  sync(true);
  render();
  ensureFlowLoop();
  return player;
}

/**
 * An outage scenario (spec 0031 section 8) turns on the layers its blast radius is drawn on (containers and
 * machines start off), as a scenario that names a persona turns the People layer on (check.js).
 */
function showOutageLayers(scenario) {
  if (!scenario || !Array.isArray(scenario.down) || !scenario.down.length) return;
  outageLayers(blastRadius(scenario.down, state.nodes, state.edges), state.nodes)
    .forEach((key) => { if (state.activeLayers[key] === false) toggleLayer(key); });
}

/** The cloud panel's Play button (CLOUD-07): plays "X is down" for a cloud node, generated from the map (outage-model.js) */
export function playOutage(id) {
  const node = state.nodes.find((n) => n.id === id);
  if (!node || node.type !== 'external' || node.kind !== 'cloud') return null;
  return playScenario(outageScenario(node, state.nodes, state.edges));
}

/** The player of the scenario on the map, or null */
export const getPlayer = () => player;

/** Ends the scenario without touching the picture: for callers that rebuild it themselves (selecting a node, switching view) */
export function clearScenario() {
  player = null;
  glide = null;
  signature = '';
  state.scenario = null;
  closeChecks();
  if (bar) { unregisterSheet('player'); bar.remove(); bar = null; }
  refreshList();
}

/** Ends the scenario and redraws the map without it */
export function stopScenario() {
  if (!player && !state.scenario) return;
  clearScenario();
  touchScene();
  render();
}

/** Brings `state.scenario` up to date with the player; when a step, the play state or the step start moved, rebuilds the scene and follows the step with the camera */
function sync(force = false) {
  if (!player) return false;
  const snap = decorateSnapshot(player.snapshot(), player.scenario());
  state.scenario = snap;
  const next = `${snap.index}|${snap.playing}|${snap.done}|${snap.stepStartMs}|${snap.stepMs}|${snap.manual}|${checksVersion()}`;
  const changed = force || next !== signature;
  if (changed) {
    const stepChanged = force || next.split('|')[0] !== signature.split('|')[0];
    signature = next;
    touchScene();
    if (stepChanged) followStep(snap);
  }
  updateBar(snap);
  return changed;
}

// ---------------------------------------------------------------------------
//  The camera follows the step
// ---------------------------------------------------------------------------
function followStep(snap) {
  const visible = new Map();
  state.nodes.forEach((n) => { if (isNodeVisible(n)) visible.set(n.id, n); });
  // The bar covers the bottom of the map: a step behind it is as good as off screen. On a phone the sheets
  // (the dock) cover it; the rest of the time it is the bar alone.
  const sheets = measureCovered();
  const covered = sheets > 0 ? sheets + 16 : bar ? bar.offsetHeight + 24 : 0;
  const target = cameraFor({ node: snap.current.node, edge: snap.current.edge, at: snap.current.at, text: snap.current.text }, state.camera, { width: state.width, height: Math.max(120, state.height - covered) }, visible);
  if (!target) return;
  if (flowReduceMotion) { Object.assign(state.camera, target); glide = null; return; }
  glide = { to: target, last: null };
  ensureFlowLoop();
}

function stepGlide(now) {
  if (!glide) return;
  const dt = glide.last === null ? 16 : Math.min(now - glide.last, 100);
  glide.last = now;
  const k = 1 - Math.exp(-dt / GLIDE_MS);
  const cam = state.camera;
  cam.x += (glide.to.x - cam.x) * k;
  cam.y += (glide.to.y - cam.y) * k;
  cam.zoom += (glide.to.zoom - cam.zoom) * k;
  if (Math.abs(glide.to.x - cam.x) < 0.5 && Math.abs(glide.to.y - cam.y) < 0.5 && Math.abs(glide.to.zoom - cam.zoom) < 0.002) {
    Object.assign(cam, glide.to);
    glide = null;
  }
}

/** Whether the player needs frames: while it plays or the camera glides; never when paused, done or closed */
export const wantsFrames = () => !!player && (player.isPlaying() || !!glide);

/** What the frame loop calls every frame with its clock (exported so a test can be the loop) */
export function tickScenario(now) {
  if (!player) return;
  player.tick(now);
  sync();
  stepGlide(now);
}

addFrameClient({ wants: wantsFrames, tick: tickScenario });

// ---------------------------------------------------------------------------
//  The bar
// ---------------------------------------------------------------------------
function showBar(speed) {
  const stage = $stage();
  if (!stage) return;
  bar = document.createElement('div');
  bar.className = 'hx-player glass';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Scenario player');
  bar.innerHTML = `
    <div class="hx-player-head">
      <span class="hx-player-title"></span>
      <select class="hx-player-speed" data-action="scenario-speed" aria-label="Time for each step" title="Time for each step">${SPEED_CHOICES.map((c) => `<option value="${c.value}">${c.label}</option>`).join('')}</select>
      <button type="button" class="hx-close" data-action="scenario-close" aria-label="Close the scenario">✕</button>
    </div>
    <p class="hx-player-text" aria-live="polite"><span class="hx-player-count"></span> · <span class="hx-player-step"></span></p>
    <div class="hx-player-controls">
      <button type="button" class="hx-btn" data-action="scenario-prev">◀ Previous</button>
      <button type="button" class="hx-btn hx-btn--active" data-action="scenario-toggle"></button>
      <button type="button" class="hx-btn" data-action="scenario-next">Next ▶</button>
    </div>
    <div class="hx-player-track" aria-hidden="true"><span class="hx-player-fill"></span></div>`;
  bar.addEventListener('click', (e) => {
    const button = e.target.closest('[data-action]');
    if (button) act(button.dataset.action);
  });
  const menu = bar.querySelector('.hx-player-speed');
  menu.value = String(speed);
  menu.addEventListener('change', (e) => chooseSpeed(e.target.value));
  // On a phone the bar is a sheet in the dock, above the node panel; it opens as a peek and the others fold, so the map shows
  const dock = document.getElementById('sheet-dock');
  const drawer = document.getElementById('spec-drawer');
  if (dock && drawer && drawer.parentElement === dock) dock.insertBefore(bar, drawer);
  else (dock || stage).appendChild(bar);
  registerSheet('player', bar);
  collapseAllSheets();
}

// The viewer's speed: a setting of theirs, kept for the next scenario and the next visit
function readSpeed() {
  try { return parseSpeed(window.localStorage.getItem(SPEED_KEY)); } catch { return parseSpeed(null); }
}

function chooseSpeed(value) {
  const speed = parseSpeed(value);
  try { window.localStorage.setItem(SPEED_KEY, String(speed)); } catch { /* storage blocked: it still applies to this player */ }
  if (!player) return;
  player.setSpeed(speed);
  sync();
  render();
  ensureFlowLoop();
}

/** One place for what the bar's buttons and the keys do */
function act(action) {
  if (!player) return;
  if (action === 'scenario-close') return stopScenario();
  if (action === 'scenario-toggle') {
    const s = player.snapshot();
    if (s.playing) player.pause(); else player.play();
  } else if (action === 'scenario-prev') player.prev();
  else if (action === 'scenario-next') player.next();
  else return;
  sync();
  render();
  ensureFlowLoop();
}

let lastFill = -1;
function updateBar(snap) {
  if (!bar) return;
  const q = (cls) => bar.querySelector(cls);
  q('.hx-player-title').textContent = snap.title;
  q('.hx-player-count').textContent = `${Math.min(snap.index + 1, Math.max(snap.total, 1))} of ${snap.total}`;
  q('.hx-player-step').textContent = snap.current.text;
  const toggle = q('[data-action=scenario-toggle]');
  toggle.textContent = snap.playing ? 'Pause' : snap.done ? 'Play again' : 'Play';
  toggle.disabled = snap.total === 0 || snap.manual;
  toggle.title = snap.manual ? 'The time for each step is Manual: use Next' : '';
  q('[data-action=scenario-prev]').disabled = snap.index === 0 && !snap.done;
  q('[data-action=scenario-next]').disabled = snap.done || snap.total === 0;
  const fill = snap.total ? Math.round(((snap.done ? snap.total : snap.index + snap.progress) / snap.total) * 1000) / 10 : 0;
  if (fill !== lastFill) { lastFill = fill; q('.hx-player-fill').style.width = `${fill}%`; }
  paintChecks(bar, snap);
}

// ---------------------------------------------------------------------------
//  Keyboard: space plays and pauses, left and right step; never while typing
// ---------------------------------------------------------------------------
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

function typingIn(target) {
  return !!(target && target.closest && target.closest(TYPING));
}

function onKeydown(e) {
  if (!player || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target)) return;
  const action = e.key === ' ' || e.code === 'Space' ? 'scenario-toggle' : e.key === 'ArrowLeft' ? 'scenario-prev' : e.key === 'ArrowRight' ? 'scenario-next' : null;
  if (!action) return;
  e.preventDefault(); // space on a focused button would press it as well
  act(action);
}

/** Some browsers press a focused button on the key's release, so a space the player took must not reach it */
function onKeyup(e) {
  if (player && (e.key === ' ' || e.code === 'Space') && !typingIn(e.target)) e.preventDefault();
}

// ---------------------------------------------------------------------------
//  The scenario list
// ---------------------------------------------------------------------------
/** The open proposal's scenarios, with the maintainer's what-if edits in (`state.effectiveProposal`) when there are any */
const proposalScenarios = () => {
  const p = state.effectiveProposal || state.proposal;
  return p && Array.isArray(p.scenarios) ? p.scenarios : [];
};

/**
 * Where the list goes: a row of the open proposal's bar, under its title row, so the list
 * opens in the bar's own flow and the bar grows to hold it (as a second box at the stage's corner
 * it opened underneath the bar and was covered). Without a bar it is a box at the stage's corner.
 */
function mountList() {
  const body = document.getElementById('proposal-body');
  const stage = $stage();
  if (!body) {
    if (stage && list.parentElement !== stage) stage.appendChild(list);
  } else if (list.parentElement !== body) {
    const summary = document.getElementById('proposal-summary');
    if (summary && summary.parentElement === body) body.insertBefore(list, summary);
    else body.appendChild(list);
  }
}

/** Shows or hides the list to match `state.proposal.scenarios` (and hides it while one plays: the bar is the control then) */
export function refreshList() {
  const stage = $stage();
  const scenarios = proposalScenarios();
  const show = !!stage && scenarios.length > 0 && !player;
  if (!show) { if (list) { list.remove(); list = null; } return; }
  const key = scenarios.map((s) => `${s.id}\u0000${s.title}\u0000${(s.steps || []).length}`).join('\u0001');
  if (list && list.dataset.key === key) { mountList(); return; }
  if (list) list.remove();
  list = document.createElement('details');
  list.className = 'hx-scenarios glass';
  list.dataset.key = key;
  const summary = document.createElement('summary');
  summary.textContent = `Scenarios · ${scenarios.length}`;
  list.appendChild(summary);
  scenarios.forEach((s) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hx-scenarios-item';
    button.dataset.scenario = s.id;
    const steps = (s.steps || []).length;
    button.textContent = `${s.title} · ${steps} ${steps === 1 ? 'step' : 'steps'}`;
    list.appendChild(button);
  });
  list.addEventListener('click', (e) => {
    const button = e.target.closest('[data-scenario]');
    if (!button) return;
    const scenario = proposalScenarios().find((s) => s.id === button.dataset.scenario);
    if (scenario) playScenario(scenario);
  });
  mountList();
}

// ---------------------------------------------------------------------------
//  /?scenario-demo=1: a small scenario over real nodes, for looking at the player before a proposal exists
// ---------------------------------------------------------------------------
/**
 * The demo scenario, walked over what the loaded topology really has: from the node with the most links that
 * are not ownership, along such links for up to three hops, never back to a node it has been at. Fewer than
 * two steps (a map with no links) means no demo (null).
 */
export function demoScenario(nodes = state.nodes, edges = state.edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const label = (id) => (nodes.find((n) => n.id === id) || { label: id }).label;
  const links = edges.filter((e) => (e.kind || e.dashed) && ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  if (!links.length) return null;
  const out = new Map();
  for (const e of links) { if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push(e); }
  const start = [...out.keys()].sort((x, y) => out.get(y).length - out.get(x).length || x.localeCompare(y))[0];
  const steps = [{ node: start, text: `It starts at ${label(start)}.` }];
  const seen = new Set([start]);
  let at = start;
  for (let hop = 0; hop < 3; hop++) {
    const next = (out.get(at) || []).find((e) => !seen.has(e.to));
    if (!next) break;
    const edge = { from: next.from, to: next.to, ...(next.kind ? { kind: next.kind } : {}), ...(next.kind === 'flow' ? { flow: next.flow } : {}) };
    steps.push({ edge, text: `${label(next.from)} ${next.label || next.kind || 'uses'} ${label(next.to)}.` });
    steps.push({ node: next.to, text: `Now at ${label(next.to)}.` });
    seen.add(next.to);
    at = next.to;
  }
  return steps.length < 2 ? null : { id: 'demo', title: 'A walk over the map', steps };
}

/** Starts the demo when the page was opened with `?scenario-demo=1` (call once the topology is loaded) */
export function maybeStartDemo(search = window.location.search) {
  if (new URLSearchParams(search).get('scenario-demo') !== '1') return false;
  const scenario = demoScenario();
  if (!scenario) { console.warn('scenario-demo: the map has none of the nodes the demo walks over'); return false; }
  playScenario(scenario);
  return true;
}

// ---------------------------------------------------------------------------
//  Wiring (main.js calls this once)
// ---------------------------------------------------------------------------
let wired = false;
export function initScenarioUi() {
  if (wired) return;
  wired = true;
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('keyup', onKeyup);
  onSceneTouch(refreshList);
  // A sheet that opened or closed changes what the map shows: keep the step in view
  onCoveredChange(() => { if (player && state.scenario) followStep(player.snapshot()); });
  // Taking hold of the map (a drag, the wheel, a pinch) ends the camera's glide: the camera is theirs
  for (const type of ['pointerdown', 'wheel', 'touchstart', 'mousedown']) document.addEventListener(type, (e) => { if (e.target === state.canvas) glide = null; }, { passive: true, capture: true });
  refreshList();
}

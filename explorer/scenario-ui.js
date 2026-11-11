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
 * The scenario list is the review column's (review-column.js): this module plays what it hands over and tells it where the
 * player is (`onPlayerChange`), so the list can follow.
 *
 * On a phone (sheets.js, TOPO-18) the bar is a bottom sheet in `#sheet-dock`: a peek (title, step
 * counter and text) until expanded, and the camera follows a step into the part of the map the
 * sheets leave free.
 */

import { state, touchScene } from './state.js';
import { render, ensureFlowLoop, addFrameClient, isNodeVisible, getMinZoom } from './render.js';
import { flowReduceMotion } from './flows.js';
import { registerSheet, unregisterSheet, collapseAllSheets, visibleMapRect, onCoveredChange } from './sheets.js';
import { createPlayer, cameraFor, parseSpeed, SPEED_CHOICES, SPEED_KEY } from './scenario.js';
import { edgeKey } from '../core/proposal.js';
import { checksVersion, closeChecks, decorateSnapshot, openChecks, paintChecks } from './check.js';
import { blastRadius, outageLayers, outageScenario } from './outage-model.js';
import { toggleLayer } from './layers.js';
import { announce } from './keyboard.js';

/** A frame that arrives later than this (a tab that was hidden) counts as this long */
const MAX_FRAME_MS = 250;
/** How quickly the camera closes on its target: the time for it to cover about 63% of the way */
const GLIDE_MS = 140;

let player = null;
let bar = null;
let signature = '';
let glide = null; // { to: {x, y, zoom}, last: nowMs|null }

const $stage = () => (state.canvas ? state.canvas.parentElement : null);

// ---------------------------------------------------------------------------
//  Playing
// ---------------------------------------------------------------------------

/**
 * Plays a scenario on the map, replacing any that is playing.
 * @param {import('./scenario.js').Scenario} scenario
 * @param {{ autoplay?: boolean, stepMs?: number | 'manual', step?: number, focus?: boolean }} [opts] `autoplay` false opens it paused on the first step;
 *   `step` opens it on that step (paused); `stepMs` is a speed for this scenario in place of the viewer's saved one;
 *   `focus` false leaves the keyboard focus where it is (the review column's step list keeps it)
 * @returns {ReturnType<typeof createPlayer>} the player, for a caller that wants to drive it
 */
export function playScenario(scenario, opts = {}) {
  const opener = openerOf();
  const takeFocus = isKeyboardish() && opts.focus !== false; // checked now: whatever was pressed may go with the markup
  clearScenario({ keepChecks: true });
  returnTo = opener;
  const speed = opts.stepMs ?? readSpeed();
  player = createPlayer(scenario, { stepMs: speed, maxFrameMs: MAX_FRAME_MS });
  if (Number.isFinite(opts.step) && opts.step > 0) player.goTo(opts.step);
  showBar(speed);
  openChecks(scenario, () => { sync(); render(); }); // PHY-10: one batch of permission checks for the scenario (check.js); the same scenario already open in the list keeps its answers
  showOutageLayers(scenario);
  if (opts.autoplay !== false && !(opts.step > 0)) player.play();
  sync(true);
  render();
  ensureFlowLoop();
  // Whatever started it may be gone: focus goes to the player's play and pause button, the first control of what opened
  if (takeFocus && bar) {
    const toggle = bar.querySelector('[data-action=scenario-toggle]');
    if (toggle && !toggle.disabled) toggle.focus(); else bar.querySelector('[data-action=scenario-next]')?.focus();
  }
  return player;
}

/** What had the focus when a scenario started, to give it back when the scenario closes (a control of another panel, say) */
let returnTo = null;
function openerOf() {
  const active = document.activeElement;
  if (active && active !== document.body && !active.closest?.('.hx-player') && !active.closest?.('#review-column') && active !== state.canvas) return active;
  return null;
}

/** Whether the focus is on the page's controls (not on nothing, and not in a field): a scenario started by a script from outside takes none */
function isKeyboardish() {
  const active = document.activeElement;
  return !!active && active !== document.body && !typingIn(active);
}

/** Who knows where the focus goes when the player closes: the review column's step list (review-column.js) gives the step the player was on */
let closeFocus = null;
export function setCloseFocus(fn) { closeFocus = typeof fn === 'function' ? fn : null; }

/** Who is told when the player moves: `fn(snapshot)` on each change of step, play state or answer, and `fn(null)` when it closes */
const playerListeners = new Set();
export function onPlayerChange(fn) {
  playerListeners.add(fn);
  return () => playerListeners.delete(fn);
}
const notify = (snap) => { for (const fn of playerListeners) fn(snap); };

/** Closing the player by the viewer's own act: the focus goes back to the step it was on in the list, else to what started it, else to the map */
function giveFocusBack() {
  const to = returnTo;
  returnTo = null;
  const took = (el) => {
    if (!el || !el.isConnected || el.hidden || el.disabled || el.closest('[hidden]')) return false;
    el.focus();
    return document.activeElement === el; // a control the stylesheet hides takes no focus
  };
  if (took(closeFocus && closeFocus()) || took(to)) return;
  took(state.canvas);
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

/** Ends the scenario without touching the picture: for callers that rebuild it themselves (selecting a node, switching view). `keepChecks` while another scenario is about to start */
export function clearScenario({ keepChecks = false } = {}) {
  const had = !!player || !!state.scenario;
  player = null;
  glide = null;
  signature = '';
  state.scenario = null;
  if (!keepChecks) closeChecks();
  if (bar) { unregisterSheet('player'); bar.remove(); bar = null; }
  if (had && !keepChecks) notify(null);
}

/** Ends the scenario and redraws the map without it */
export function stopScenario() {
  if (!player && !state.scenario) return;
  const hadFocus = !!bar && bar.contains(document.activeElement);
  clearScenario();
  touchScene();
  render();
  if (hadFocus || document.activeElement === document.body) giveFocusBack(); // focus was in the player, which is gone
  else returnTo = null;
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
  if (changed) notify({ id: snap.id, index: snap.index, total: snap.total, done: snap.done, playing: snap.playing, checks: checksVersion() });
  return changed;
}

// ---------------------------------------------------------------------------
//  The camera follows the step
// ---------------------------------------------------------------------------
function followStep(snap) {
  const visible = new Map();
  state.nodes.forEach((n) => { if (isNodeVisible(n)) visible.set(n.id, n); });
  // The step must be in the part of the map nothing covers: not under the proposal bar, the node panel, the player or (on a phone) the sheets
  const rect = visibleMapRect();
  const target = cameraFor({ node: snap.current.node, edge: snap.current.edge, at: snap.current.at, text: snap.current.text }, state.camera, rect, visible, 60, getMinZoom());
  if (!target) return;
  if (flowReduceMotion) { Object.assign(state.camera, target); glide = null; render(); return; } // reduced motion: jump, do not fly
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
  bar.dataset.corn = 'scenario-player';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Scenario player');
  bar.innerHTML = `
    <div class="hx-player-head">
      <span class="hx-player-title"></span>
      <select data-corn="control" class="hx-player-speed" data-action="scenario-speed" aria-label="Time for each step" title="Time for each step">${SPEED_CHOICES.map((c) => `<option value="${c.value}">${c.label}</option>`).join('')}</select>
      <button type="button" class="hx-close" data-action="scenario-close" aria-label="Close the scenario" data-corn-kind="icon">✕</button>
    </div>
    <p class="hx-player-text" aria-live="polite"><span class="hx-player-count" data-corn="count"></span> · <span class="hx-player-step"></span></p>
    <div class="hx-player-controls">
      <button data-corn-kind="secondary" type="button" class="hx-btn" data-action="scenario-prev" data-peek-ok>◀ Previous</button>
      <button type="button" class="hx-btn hx-btn--active" data-action="scenario-toggle" data-peek-ok data-corn-kind="primary"></button>
      <button data-corn-kind="secondary" type="button" class="hx-btn" data-action="scenario-next" data-peek-ok>Next ▶</button>
    </div>
    <div class="hx-player-track" data-corn="scenario-track" aria-hidden="true"><span class="hx-player-fill" data-corn="scenario-fill"></span></div>`;
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
    announce(s.playing ? 'Paused' : s.done ? 'Playing again' : s.index > 0 || s.progress > 0 ? 'Resumed' : 'Playing');
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
  // this runs every frame: a live region is written only when its words change, so a step is said once, not once a frame
  const put = (cls, text) => { const el = q(cls); if (el.textContent !== text) el.textContent = text; };
  put('.hx-player-title', snap.title);
  put('.hx-player-count', `${Math.min(snap.index + 1, Math.max(snap.total, 1))} of ${snap.total}`);
  put('.hx-player-step', snap.current.text);
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
  if (e.key === 'Escape' && !e.defaultPrevented && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (player && !typingIn(e.target) && !otherPopupOpen()) { e.preventDefault(); stopScenario(); return; } // Escape closes the scenario; focus goes back to Play
  }
  if (!player || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target)) return;
  if ((e.key === ' ' || e.code === 'Space') && e.target.closest?.('#review-column')) return; // Space on a step or a row presses it
  const action = e.key === ' ' || e.code === 'Space' ? 'scenario-toggle' : e.key === 'ArrowLeft' ? 'scenario-prev' : e.key === 'ArrowRight' ? 'scenario-next' : null;
  if (!action) return;
  e.preventDefault(); // space on a focused button would press it as well
  act(action);
}

/** A menu or dialog that has its own Escape: the layers menu, the toolbar's ⋯ menu, a dialog */
function otherPopupOpen() {
  return !!document.querySelector('#legend-dropdown:not([hidden]), #proposal-more-menu:not([hidden]), [data-corn="dialog-scrim"]:not([hidden]), .hx-mockup-dialog');
}

/** Some browsers press a focused button on the key's release, so a space the player took must not reach it */
function onKeyup(e) {
  if (player && (e.key === ' ' || e.code === 'Space') && !typingIn(e.target)) e.preventDefault();
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
  // A sheet that opened or closed changes what the map shows: keep the step in view
  onCoveredChange(() => { if (player && state.scenario) followStep(player.snapshot()); });
  // Taking hold of the map (a drag, the wheel, a pinch) ends the camera's glide: the camera is theirs
  for (const type of ['pointerdown', 'wheel', 'touchstart', 'mousedown']) document.addEventListener(type, (e) => { if (e.target === state.canvas) glide = null; }, { passive: true, capture: true });
}

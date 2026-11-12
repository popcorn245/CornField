/**
 * @module explorer/engine/player
 *
 * The browser half of the scenario player on an instance (spec 0012 B3, TOPO-10; the pure core is scenario.js). `play(scenario)` puts a player on the
 * map: it keeps the player's snapshot in `state.scenario` (scene.js lights it), shows a compact bar (title, "2 of 5 · text", previous, play or pause, next,
 * close), answers the keyboard (space, left and right arrows), and glides the camera to the current step when that is off screen. The ROM simulation plays
 * through here too. The bar also holds the viewer's speed: a small menu of how long a step plays (2 s, 5 s, 10 s, or Manual, which moves only on Next), kept
 * in the viewer's browser storage and applied to the running player.
 *
 * Frames: the player is a frame client of the instance's map loop (`inst.map.addFrameClient`), not a timer of its own. It asks for frames only while
 * playing or while the camera glides, so a paused or finished scenario costs nothing, a hidden tab stops the loop, and under prefers-reduced-motion the
 * steps still change but the packet does not travel and the camera jumps.
 *
 * The scenario list is the review column's (pieces/changes.js): this module plays what it hands over and tells it where the player is (`onChange`, and
 * the instance's `scenario:player` event), so the list can follow. On a phone (engine/sheets.js, TOPO-18) the bar is a bottom sheet in `#sheet-dock`: a peek
 * (title, step counter and text) until expanded, and the camera follows a step into the part of the map the sheets leave free.
 *
 * The instance's events from here: `scenario:player` { id, index, total, done, playing, checks } on each change of step, play state or answer, and null when
 * the player closes. It hears `scenario:clear` (a selection ends a playing scenario).
 */

import { escapeHtml as escHtml } from '../../core/text.js';
import { createPlayer, cameraFor, parseSpeed, SPEED_CHOICES, SPEED_KEY } from '../scenario.js';
import { blastRadius } from '../outage-model.js';
import { outageLayers, outageScenario } from '../outage-scenario.js';
import { setLayer, clearStepLayers, LAYER_DEFS } from './layers.js';
import { externalLayer } from '../cloud-model.js';
import { layerOn, layersOf, projectLayerKey, shownByProposal } from '../layer-model.js';
import { registerSheet, unregisterSheet, collapseAllSheets, visibleMapRect, onCoveredChange } from './sheets.js';
import { announce } from './keyboard.js';
import { t } from './strings.js';
import { currentStepSentence } from '../scenario-list-model.js';
import { personaFor, personaLabel } from '../check-model.js';
import { addParts } from './piece.js';

/** A frame that arrives later than this (a tab that was hidden) counts as this long */
const MAX_FRAME_MS = 250;
/** How quickly the camera closes on its target: the time for it to cover about 63% of the way */
const GLIDE_MS = 140;

/**
 * The Layers keys that hide a node, or [] when no layer does (#212). Only what Layers decides: the Flow and House views and
 * Before or After draw their own sets, and a layer would not change them.
 */
export function layersHiding(inst, node) {
  const { state } = inst;
  if (!node || state.view === 'dataflow' || state.view === 'house') return [];
  const layers = layersOf(state); // what is drawn: the viewer's layers, or the review's (layer-model.js)
  const on = (key) => layers[key] !== false;
  const type = node.type;
  if (type === 'root' || shownByProposal(state, node)) return []; // a proposal's own nodes are drawn whatever their layer says (spec 0009 D3)
  const project = projectLayerKey(state, node); // a project layer that takes the node decides alone (spec 0009 D3), as scene.js layerShows has it
  if (project) return on(project) ? [] : [project];
  if (type === 'core') return [...(on('core') ? [] : ['core']), ...(layers.pkg || layers.atom ? [] : ['pkg'])];
  if (type === 'store') return ['flow', 'store'].filter((k) => !on(k));
  if (type === 'rom') return ['rom', 'flow'].filter((k) => !on(k));
  if (type === 'floor' || type === 'room') return on('house') ? [] : ['house'];
  const key = type === 'external' ? externalLayer(node) : type;
  return on(key) ? [] : [key];
}

/** The nodes a scenario's steps name: a node step's node, both ends of an edge step */
const stepNodeIds = (scenario) => (Array.isArray(scenario?.steps) ? scenario.steps : []).flatMap((st) => (st?.edge ? [st.edge.from, st.edge.to] : st && st.node !== undefined ? [st.node] : []));

const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const typingIn = (target) => !!(target && target.closest && target.closest(TYPING));

/**
 * The demo scenario, walked over what the loaded topology really has: from the node with the most links that are not ownership, along such links for up
 * to three hops, never back to a node it has been at. Fewer than two steps (a map with no links) means no demo (null).
 */
export function demoScenario(nodes, edges) {
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

/**
 * The player of an instance.
 * @param {ReturnType<import('../instance.js').createInstance>} inst
 * @param {ReturnType<typeof import('./piece.js').scopeOf>} scope the piece's own end: every listener, observer and the frame client go with it
 * @param {ReturnType<typeof import('./checks.js').createChecks>} checks
 */
export function createScenarioPlayer(inst, scope, checks) {
  const { state } = inst;
  let player = null;
  let bar = null;
  let signature = '';
  let glide = null; // { to: {x, y, zoom}, last: nowMs|null }
  let held = false; // the viewer took hold of the map since the step began: the camera is theirs until the next step
  let framedFor = -1; // the player bar's height when the camera last followed the step
  let barWatch = null; // a ResizeObserver on the bar: when it grows (a check's line arrives), the step is followed again
  let lastFill = -1;
  /** What had the focus when a scenario started, to give it back when the scenario closes (a control of another panel, say) */
  let returnTo = null;
  /** Who knows where the focus goes when the player closes: the review column's step list gives the step the player was on */
  let closeFocus = null;
  /** Who keeps a closed scenario's checks: the review column, while its steps are open in the list (their verdicts stay there) */
  let keepChecksOnClose = null;
  /** Who knows the scenario after this one, in the order the list reads: `fn(scenarioId)` gives the scenario or null */
  let nextScenarioOf = null;
  const listeners = new Set();
  /** Takes the listeners off the bar's own controls when it goes */
  let barOffs = [];
  const notify = (snap) => { for (const fn of [...listeners]) fn(snap); inst.emit('scenario:player', snap); };

  const stage = () => (state.canvas ? state.canvas.parentElement : null);
  const render = () => inst.map.render();

  // ---------------------------------------------------------------------------
  //  Playing
  // ---------------------------------------------------------------------------

  /** What had the focus when a scenario started: not the player, not the review column, not the map */
  function openerOf() {
    const active = inst.active();
    if (active && active !== inst.doc.body && !active.closest?.('.hx-player') && !active.closest?.('#review-column') && active !== state.canvas) return active;
    return null;
  }

  /** Whether the focus is on the page's controls (not on nothing, and not in a field): a scenario started by a script from outside takes none */
  function isKeyboardish() {
    const active = inst.active();
    return !!active && active !== inst.doc.body && !typingIn(active);
  }

  /** Closing the player by the viewer's own act: the focus goes back to the step it was on in the list, else to what started it, else to the map */
  function giveFocusBack() {
    const to = returnTo;
    returnTo = null;
    const took = (el) => {
      if (!el || !el.isConnected || el.hidden || el.disabled || el.closest('[hidden]')) return false;
      el.focus();
      return inst.active() === el; // a control the stylesheet hides takes no focus
    };
    if (took(closeFocus && closeFocus()) || took(to)) return;
    took(state.canvas);
  }

  /**
   * An outage scenario (spec 0031 section 8) turns on the layers its blast radius is drawn on (containers and machines start off), as a scenario that
   * names a persona turns the People layer on (checks.js).
   */
  function showOutageLayers(scenario) {
    if (!scenario || !Array.isArray(scenario.down) || !scenario.down.length) return;
    outageLayers(blastRadius(scenario.down, state.nodes, state.edges), state.nodes)
      .forEach((key) => { if (!layerOn(state, key)) setLayer(inst, key, true, { scenario: true }); });
  }

  /**
   * A step on a layer that is off cannot be followed: the camera has nothing to go to (#212). Playing a scenario turns on the layers
   * its steps are drawn on, as an outage turns on what it hits, and says which.
   */
  function showStepLayers(scenario) {
    const byId = new Map(state.nodes.map((n) => [n.id, n]));
    const keys = [];
    for (const id of stepNodeIds(scenario)) for (const key of layersHiding(inst, byId.get(id))) if (!keys.includes(key)) keys.push(key);
    if (!keys.length) return;
    for (const key of keys) setLayer(inst, key, true, { scenario: true }); // on, for the review too (state.review.step): stopping the scenario takes it off again
    const names = keys.map((key) => (LAYER_DEFS.find((l) => l.key === key) || (state.projectLayers || []).find((l) => l.key === key) || { label: key }).label);
    announce(inst, `Turned on ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]} to show this scenario's steps.`);
  }

  /**
   * Plays a scenario on the map, replacing any that is playing.
   * @param {object} scenario
   * @param {{ autoplay?: boolean, stepMs?: number | 'manual', step?: number, focus?: boolean }} [opts] `autoplay` false opens it paused on the first step;
   *   `step` opens it on that step (paused); `stepMs` is a speed for this scenario in place of the viewer's saved one;
   *   `focus` false leaves the keyboard focus where it is (the review column's step list keeps it)
   * @returns {ReturnType<typeof createPlayer>} the player, for a caller that wants to drive it
   */
  function play(scenario, opts = {}) {
    const opener = openerOf();
    const takeFocus = isKeyboardish() && opts.focus !== false; // checked now: whatever was pressed may go with the markup
    clear({ keepChecks: true });
    returnTo = opener;
    const speed = opts.stepMs ?? readSpeed();
    player = createPlayer(scenario, { stepMs: speed, maxFrameMs: MAX_FRAME_MS });
    if (Number.isFinite(opts.step) && opts.step > 0) player.goTo(opts.step);
    showBar(speed);
    checks.open(scenario, () => { sync(); render(); }); // PHY-10: one batch of permission checks for the scenario (checks.js); the same scenario already open in the list keeps its answers
    showOutageLayers(scenario);
    showStepLayers(scenario);
    if (opts.autoplay !== false && !(opts.step > 0)) player.play();
    sync(true);
    render();
    inst.map.ensureFlowLoop();
    // Whatever started it may be gone: focus goes to the player's play and pause button, the first control of what opened
    if (takeFocus && bar) {
      const toggle = bar.querySelector('[data-action=scenario-toggle]');
      if (toggle && !toggle.disabled) toggle.focus(); else bar.querySelector('[data-action=scenario-next]')?.focus();
    }
    return player;
  }

  /** The cloud panel's Play button (CLOUD-07): plays "X is down" for a cloud node, generated from the map (outage-model.js) */
  function playOutage(id) {
    const node = state.nodes.find((n) => n.id === id);
    if (!node || node.type !== 'external' || node.kind !== 'cloud') return null;
    return play(outageScenario(node, state.nodes, state.edges));
  }

  /** Ends the scenario without touching the picture: for callers that rebuild it themselves (selecting a node, switching view). `keepChecks` while another scenario is about to start */
  function clear({ keepChecks = false, closing = false } = {}) {
    const had = !!player || !!state.scenario;
    if (had) clearStepLayers(inst); // the layers this scenario turned on for a review go off with it: the focused view comes back
    player = null;
    glide = null;
    signature = '';
    state.scenario = null;
    if (!keepChecks) checks.close();
    if (barWatch) { barWatch.disconnect(); barWatch = null; }
    if (bar) { unregisterSheet(inst, 'player'); barOffs.forEach((off) => off()); barOffs = []; checks.unmount(); bar.remove(); bar = null; }
    if (had && (!keepChecks || closing)) notify(null);
  }

  /** Ends the scenario and redraws the map without it */
  function stop() {
    if (!player && !state.scenario) return;
    const active = inst.active();
    const hadFocus = (!!bar && bar.contains(active)) || !!active?.closest?.('#review-column'); // in the player, or in the list that follows it
    const keep = !!player && !!keepChecksOnClose && keepChecksOnClose(player.scenario().id); // the list still shows its steps: their verdicts stay
    clear({ keepChecks: keep, closing: true });
    inst.touchScene();
    render();
    const now = inst.active();
    if (hadFocus || !now || now === inst.doc.body) giveFocusBack(); // focus was in the player, which is gone: it goes to the step the player was on
    else returnTo = null;
  }

  /** Brings `state.scenario` up to date with the player; when a step, the play state or the step start moved, rebuilds the scene and follows the step with the camera */
  function sync(force = false) {
    if (!player) return false;
    const snap = checks.decorate(player.snapshot(), player.scenario());
    state.scenario = snap;
    const next = `${snap.index}|${snap.playing}|${snap.done}|${snap.stepStartMs}|${snap.stepMs}|${snap.manual}|${checks.version()}`;
    const changed = force || next !== signature;
    if (changed) {
      const stepChanged = force || next.split('|')[0] !== signature.split('|')[0];
      signature = next;
      inst.touchScene();
      if (stepChanged) { held = false; followStep(snap); }
    }
    updateBar(snap);
    if (changed) notify({ id: snap.id, index: snap.index, total: snap.total, done: snap.done, playing: snap.playing, checks: checks.version() });
    return changed;
  }

  // ---------------------------------------------------------------------------
  //  The camera follows the step
  // ---------------------------------------------------------------------------
  function followStep(snap) {
    const visible = new Map();
    state.nodes.forEach((n) => { if (inst.map.isNodeVisible(n)) visible.set(n.id, n); });
    // The step must be in the part of the map nothing covers: not under the proposal bar, the node panel, the player or (on a phone) the sheets
    const rect = visibleMapRect(inst);
    framedFor = bar ? bar.offsetHeight : 0;
    const target = cameraFor({ node: snap.current.node, edge: snap.current.edge, at: snap.current.at, text: snap.current.text }, state.camera, rect, visible, 60, inst.map.getMinZoom());
    if (!target) return;
    if (inst.reducedMotion) { Object.assign(state.camera, target); glide = null; render(); return; } // reduced motion: jump, do not fly
    glide = { to: target, last: null };
    inst.map.ensureFlowLoop();
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
  const wantsFrames = () => !!player && (player.isPlaying() || !!glide);

  /** What the frame loop calls every frame with its clock (exported so a test can be the loop) */
  function tick(now) {
    if (!player) return;
    player.tick(now);
    sync();
    stepGlide(now);
  }

  scope.own(inst.map.addFrameClient({ wants: wantsFrames, tick }));

  // ---------------------------------------------------------------------------
  //  The bar
  // ---------------------------------------------------------------------------
  function showBar(speed) {
    const area = stage();
    if (!area) return;
    bar = inst.doc.createElement('div');
    bar.className = 'hx-player glass';
    bar.dataset.corn = 'scenario-player';
    bar.setAttribute('part', 'scenario-player');
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Scenario player');
    // One bar (spec 0006 D6): Previous, Pause or Play, Next; "2 of 4 · As Adult · the step's text · Allowed"; the speed and Close.
    // The scenario's name is the title (heard, and shown on a phone's open sheet); the list beside the map has it open and the step marked.
    bar.innerHTML = `
    <span class="hx-player-title hx-sr-only"></span>
    <div class="hx-player-controls" role="group">
      <button data-corn-kind="secondary" type="button" class="hx-btn hx-player-prev" data-action="scenario-prev" data-peek-ok><span class="hx-player-label"></span></button>
      <button type="button" class="hx-btn hx-btn--active hx-player-toggle" data-action="scenario-toggle" data-peek-ok data-corn-kind="primary"><span class="hx-player-label"></span></button>
      <button data-corn-kind="secondary" type="button" class="hx-btn hx-player-next" data-action="scenario-next" data-peek-ok><span class="hx-player-label"></span></button>
      <button data-corn-kind="secondary" type="button" class="hx-btn hx-player-next-scenario" data-action="scenario-next-scenario" data-peek-ok hidden></button>
    </div>
    <p class="hx-player-text"><span class="hx-player-count" data-corn="count"></span><span class="hx-player-sep" aria-hidden="true"> · </span><span class="hx-player-who"></span><span class="hx-player-step"></span></p>
    <span class="hx-player-says hx-sr-only" role="status" aria-live="polite"></span>
    <div class="hx-player-side">
      <select data-corn="control" class="hx-player-speed" data-action="scenario-speed" aria-label="Time for each step" title="Time for each step">${SPEED_CHOICES.map((c) => `<option value="${escHtml(String(c.value))}">${escHtml(c.label)}</option>`).join('')}</select>
      <button type="button" class="hx-close" data-action="scenario-close" aria-label="Close the scenario" data-corn-kind="icon">✕</button>
    </div>
    <div class="hx-player-track" data-corn="scenario-track" aria-hidden="true"><span class="hx-player-fill" data-corn="scenario-fill"></span></div>`;
    addParts(bar);
    bar.querySelector('.hx-player-controls').setAttribute('aria-label', t(inst, 'steps'));
    bar.querySelector('.hx-player-prev .hx-player-label').textContent = t(inst, 'previousStep');
    bar.querySelector('.hx-player-next .hx-player-label').textContent = t(inst, 'nextStep');
    bar.querySelector('.hx-player-next-scenario').textContent = t(inst, 'nextScenario');
    const onBarClick = (e) => {
      const button = e.target.closest('[data-action]');
      if (button) act(button.dataset.action);
    };
    const menu = bar.querySelector('.hx-player-speed');
    const onSpeed = (e) => chooseSpeed(e.target.value);
    const here = bar;
    here.addEventListener('click', onBarClick);
    menu.value = String(speed);
    menu.addEventListener('change', onSpeed);
    barOffs.push(() => { here.removeEventListener('click', onBarClick); menu.removeEventListener('change', onSpeed); });
    // On a phone the bar is a sheet in the dock, above the node panel; it opens as a peek (one row) and the others fold, so the map shows
    const dock = inst.el('sheet-dock');
    const drawer = inst.el('spec-drawer');
    if (dock && drawer && drawer.parentElement === dock) dock.insertBefore(bar, drawer);
    else (dock || area).appendChild(bar);
    registerSheet(inst, 'player', bar);
    collapseAllSheets(inst);
    // The bar grows once it has more to say (a step's check, its As row): the step it framed would now be under it, so it is followed again
    const RO = inst.win && inst.win.ResizeObserver;
    if (typeof RO === 'function') {
      barWatch = new RO(() => { if (bar && player && state.scenario && !held && bar.offsetHeight !== framedFor) followStep(player.snapshot()); });
      barWatch.observe(bar);
    }
  }

  // The viewer's speed: a setting of theirs, kept for the next scenario and the next visit
  const readSpeed = () => parseSpeed(inst.store.get(SPEED_KEY));

  function chooseSpeed(value) {
    const speed = parseSpeed(value);
    inst.store.set(SPEED_KEY, String(speed));
    if (!player) return;
    player.setSpeed(speed);
    sync();
    render();
    inst.map.ensureFlowLoop();
  }

  /** One place for what the bar's buttons and the keys do */
  function act(action) {
    if (!player) return;
    if (action === 'scenario-close') return stop();
    if (action === 'scenario-next-scenario') {
      // the end of a scenario: nothing advances by itself; this is the reviewer's choice, and it starts the next one in the list's order
      const next = nextScenarioOf ? nextScenarioOf(player.scenario().id) : null;
      if (next) play(next);
      return;
    }
    if (action === 'scenario-toggle') {
      const s = player.snapshot();
      if (s.playing) player.pause(); else player.play();
      announce(inst, s.playing ? 'Paused' : s.done ? 'Playing again' : s.index > 0 || s.progress > 0 ? 'Resumed' : 'Playing');
    } else if (action === 'scenario-prev') player.prev();
    else if (action === 'scenario-next') player.next();
    else return;
    sync();
    render();
    inst.map.ensureFlowLoop();
  }

  function updateBar(snap) {
    if (!bar) return;
    const q = (cls) => bar.querySelector(cls);
    // this runs every frame: a live region is written only when its words change, so a step is said once, not once a frame
    const put = (cls, text) => { const el = q(cls); if (el.textContent !== text) el.textContent = text; };
    put('.hx-player-title', snap.title);
    bar.setAttribute('aria-label', `Scenario player: ${snap.title}`);
    put('.hx-player-count', `${Math.min(snap.index + 1, Math.max(snap.total, 1))} of ${snap.total}`);
    const actor = snap.current.actor ? personaLabel(personaFor(state.nodes, snap.current.actor)) || snap.current.actor : '';
    put('.hx-player-who', actor && !snap.done ? `As ${actor} · ` : '');
    put('.hx-player-step', snap.done ? 'Played to the end' : snap.current.text);
    bar.dataset.done = String(!!snap.done);
    const toggle = q('[data-action=scenario-toggle]');
    const label = snap.playing ? t(inst, 'pause') : snap.done ? t(inst, 'playAgain') : t(inst, 'play');
    put('[data-action=scenario-toggle] .hx-player-label', label);
    toggle.dataset.state = snap.playing ? 'playing' : snap.done ? 'done' : 'paused';
    toggle.disabled = snap.total === 0 || snap.manual;
    toggle.title = snap.manual ? 'The time for each step is Manual: use Next' : '';
    q('[data-action=scenario-prev]').disabled = snap.index === 0 && !snap.done;
    const next = q('[data-action=scenario-next]');
    next.disabled = snap.done || snap.total === 0;
    // at the end: Play again and Next scenario (the next one in the list's order); nothing carries on by itself
    const following = snap.done && nextScenarioOf ? nextScenarioOf(snap.id) : null;
    q('[data-action=scenario-next-scenario]').hidden = !following;
    next.hidden = !!following;
    // the one polite line: a step as the list says it ("Step 2 of 3, as Adult: checkout page, Added. You pay. Allowed.")
    put('.hx-player-says', snap.done ? `${snap.title}: played to the end.` : currentStepSentence({ snap, nodes: state.nodes, edges: state.edges, words: { notChecked: t(inst, 'notChecked') } }));
    const fill = snap.total ? Math.round(((snap.done ? snap.total : snap.index + snap.progress) / snap.total) * 1000) / 10 : 0;
    if (fill !== lastFill) { lastFill = fill; q('.hx-player-fill').style.width = `${fill}%`; }
    checks.paint(bar, snap);
  }

  // ---------------------------------------------------------------------------
  //  Keyboard: space plays and pauses, left and right step; never while typing
  // ---------------------------------------------------------------------------
  /** A menu or dialog that has its own Escape: the layers menu, the toolbar's ⋯ menu, a dialog */
  function otherPopupOpen() {
    return !!inst.root.querySelector('#legend-dropdown:not([hidden]), #proposal-more-menu:not([hidden]), [data-corn="dialog-scrim"]:not([hidden]), .hx-mockup-dialog');
  }

  scope.listen(inst.root, 'keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (player && !typingIn(e.target) && !otherPopupOpen()) { e.preventDefault(); stop(); return; } // Escape closes the scenario; focus goes back to Play
    }
    if (!player || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target)) return;
    if ((e.key === ' ' || e.code === 'Space') && e.target.closest?.('#review-column')) return; // Space on a step or a row presses it
    const action = e.key === ' ' || e.code === 'Space' ? 'scenario-toggle' : e.key === 'ArrowLeft' ? 'scenario-prev' : e.key === 'ArrowRight' ? 'scenario-next' : null;
    if (!action) return;
    e.preventDefault(); // space on a focused button would press it as well
    act(action);
  });
  // Some browsers press a focused button on the key's release, so a space the player took must not reach it
  scope.listen(inst.root, 'keyup', (e) => {
    if (player && (e.key === ' ' || e.code === 'Space') && !typingIn(e.target)) e.preventDefault();
  });
  // A sheet that opened or closed changes what the map shows: keep the step in view
  scope.own(onCoveredChange(inst, () => { if (player && state.scenario) followStep(player.snapshot()); }));
  // Taking hold of the map (a drag, the wheel, a pinch) ends the camera's glide: the camera is theirs
  for (const type of ['pointerdown', 'wheel', 'touchstart', 'mousedown']) scope.listen(inst.root, type, (e) => { if (e.target === state.canvas) { glide = null; held = true; } }, { passive: true, capture: true });
  scope.on('scenario:clear', () => clear());
  scope.own(() => { clear({ keepChecks: false }); listeners.clear(); });

  return {
    play,
    stop,
    clear,
    tick,
    playOutage,
    getPlayer: () => player,
    bar: () => bar,
    wantsFrames,
    /** Calls `fn(snapshot)` on each change of the player: the step it is on (null when closed), whether it reached the end. Returns how to stop. */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setCloseFocus(fn) { closeFocus = typeof fn === 'function' ? fn : null; },
    setNextScenario(fn) { nextScenarioOf = typeof fn === 'function' ? fn : null; },
    setKeepChecksOnClose(fn) { keepChecksOnClose = typeof fn === 'function' ? fn : null; },
    /** Starts the demo when the page was opened with `?scenario-demo=1` (the page says so: `asked`; call it once the topology is loaded) */
    demo(asked = true) {
      if (!asked) return false;
      const scenario = demoScenario(state.nodes, state.edges);
      if (!scenario) { console.warn('scenario-demo: the map has none of the nodes the demo walks over'); return false; }
      play(scenario);
      return true;
    },
  };
}

/**
 * @module explorer/scenario
 *
 * THE SCENARIO PLAYER'S CORE (spec 0012 B3, TOPO-10). Pure: no DOM, no clock, no `window`.
 * A scenario is a story told over the map, one step at a time (a proposal's `scenarios`, or the
 * ROM simulation's walk):
 *
 *     { id, title, steps: [{ node: id, text } | { edge: { from, to, kind?, flow? }, text }, ...], actor? }
 *
 * A step may also say who does it and where (spec 0029 section 3): `actor` (a persona id; the step's
 * own wins over the scenario's), `at` (a node, or a live id the live layer resolves), `check` and
 * `expect`. The player hands them on in `snapshot().current`; it checks nothing itself.
 * An outage scenario (spec 0031 section 8) names the cloud nodes it takes down in `down`; the player hands
 * the list on in `snapshot().down` and works out nothing from it (the blast radius is drawn from the map: outage-model.js).
 *
 * `createPlayer(scenario)` is a state machine over its steps. It never reads a clock: the caller
 * hands `tick(nowMs)` the time, so tests drive it with numbers and the browser drives it from the
 * frame loop. What it hands back is `snapshot()`, a plain object the explorer keeps in
 * `state.scenario`; scene.js turns that into highlights (the player itself draws nothing).
 * The browser half (bar, keyboard, camera, the frame loop) is scenario-ui.js.
 *
 * @typedef {{ from: string, to: string, kind?: string, flow?: string }} StepEdge
 * @typedef {{ route: string, method: string } | { table: string, op: 'read' | 'write' | 'delete', row?: string }} StepCheck
 * @typedef {{ actor?: string, at?: string, check?: StepCheck | StepCheck[], expect?: 'allowed' | 'refused' }} StepWho
 * @typedef {{ node?: string, edge?: StepEdge, text: string, ms?: number, actor?: string, at?: string, check?: StepCheck | StepCheck[], expect?: 'allowed' | 'refused' }} Step
 *   Exactly one of `node` and `edge`.
 *   `ms` is how long this step plays; the default is the player's `stepMs`.
 * @typedef {{ id: string, title: string, steps: Step[], stepMs?: number, linkNodes?: boolean, actor?: string, down?: string[] }} Scenario
 *   `linkNodes`: also light every map edge between two visited nodes (the ROM walk: its steps are
 *   nodes, and the lit pipeline is the edges between them). A proposal's scenario lights only its own edge steps.
 *   `actor`: the persona every step acts as, unless the step names its own.
 *   `down`: the ids of the cloud nodes the scenario takes down, for the whole scenario (spec 0031 section 8).
 *
 * @typedef {object} ScenarioSnapshot
 * @property {string} id
 * @property {string} title
 * @property {number} total          how many steps
 * @property {number} index          the current step (0-based); 0 when there are none
 * @property {boolean} playing
 * @property {boolean} done          played to the end (or stepped past the last step); `play()` then starts again
 * @property {{ nodes: Set<string>, edges: Set<string>, edgeList: StepEdge[] }} visited
 *   Everything from the first step up to and including the current one. `edges` holds the proposal's
 *   `edgeKey` of each edge step; an edge step also puts both its end nodes in `nodes`, and a step's `at` is in `nodes` too.
 * @property {{ node?: string, edge?: StepEdge, edgeKey?: string, text: string } & StepWho} current
 *   `actor` is the step's own or the scenario's (`stepActor`); each of the four is left out when the step has none.
 * @property {number} progress       0..1 through the current step
 * @property {number} stepMs         how long the current step plays (in manual speed: how long it would; nothing advances by itself)
 * @property {boolean} manual        the viewer's speed is Manual: only next() moves on
 * @property {number|null} stepStartMs  when the current step began on `tick`'s clock; null until the first tick after `play()`
 * @property {boolean} linkNodes
 * @property {string[]} down        the scenario's down node ids (`scenarioDown`), a fresh list each time; empty when it is no outage
 */

import { edgeKey } from '../core/proposal.js';

export const DEFAULT_STEP_MS = 5000;
/** Where the viewer's speed is kept (localStorage); scenario-ui.js reads and writes it */
export const SPEED_KEY = 'topology.scenarioSpeed';
/** The speeds the player bar offers: how long a step plays, or Manual (it moves only on Next) */
export const SPEED_CHOICES = [
  { value: '2000', label: '2 s' },
  { value: '5000', label: '5 s' },
  { value: '10000', label: '10 s' },
  { value: 'manual', label: 'Manual' },
];

/** A stored speed back as the player takes it (a number of ms, or 'manual'); anything that is not one of the choices is the default */
export function parseSpeed(raw) {
  const choice = SPEED_CHOICES.find((c) => c.value === raw);
  if (!choice) return DEFAULT_STEP_MS;
  return choice.value === 'manual' ? 'manual' : Number(choice.value);
}
/** The zoom fit-to-screen never goes below (render.js `fitGraphToViewport`) */
export const MIN_FIT_ZOOM = 0.18;

/** How long a step plays: its own `ms` when that is a positive number, else `fallback` */
export function stepDuration(step, fallback = DEFAULT_STEP_MS) {
  const ms = step && step.ms;
  return typeof ms === 'number' && ms > 0 && Number.isFinite(ms) ? ms : fallback;
}

const stepsOf = (scenario) => (scenario && Array.isArray(scenario.steps) ? scenario.steps : []);

/** The ids a scenario takes down (`down`, spec 0031 section 8), each once; anything that is not an id is skipped (validateProposal reports it) */
export function scenarioDown(scenario) {
  const down = scenario && Array.isArray(scenario.down) ? scenario.down : [];
  return [...new Set(down.filter((id) => typeof id === 'string' && id !== ''))];
}

/** Who does a step: its own `actor`, else its scenario's, else null (a step no one does is never checked) */
export function stepActor(scenario, step) {
  return (step && step.actor) || (scenario && scenario.actor) || null;
}

/**
 * @param {Scenario} scenario
 * @param {{ stepMs?: number | 'manual', maxFrameMs?: number }} [opts]
 *   `stepMs` the viewer's speed: the time of a step that has no `ms` of its own and whose scenario has
 *   no `stepMs` (else the default, 5 s); `'manual'` never advances by itself, whatever the scenario says,
 *   and `setSpeed` changes it while it plays. The order: the step's `ms`, the scenario's `stepMs`, this, the default;
 *   `maxFrameMs` the most one `tick` may advance (default: no limit). The browser sets it so a tab
 *   that was hidden for ten minutes carries on where it was instead of racing through the steps.
 */
export function createPlayer(scenario, opts = {}) {
  let sc = scenario;
  let speed = opts.stepMs;
  const manual = () => speed === 'manual';
  const fallbackMs = () => sc.stepMs ?? (typeof speed === 'number' && speed > 0 ? speed : DEFAULT_STEP_MS);
  const maxFrameMs = opts.maxFrameMs ?? Infinity;

  let index = 0;
  let playing = false;
  let done = stepsOf(scenario).length === 0;
  let elapsed = 0; // ms spent in the current step
  let lastNow = null; // the clock at the last tick while playing; null = the next tick only sets it
  let stepStart = null; // the clock when the current step began; null while paused

  const steps = () => stepsOf(sc);
  const last = () => steps().length - 1;
  const durationAt = (i) => stepDuration(steps()[i], fallbackMs());
  const clampIndex = (i) => Math.max(0, Math.min(Math.max(0, last()), i));
  const restart = () => { index = 0; done = steps().length === 0; elapsed = 0; lastNow = null; stepStart = null; };
  const pausePlayback = () => { playing = false; lastNow = null; stepStart = null; };

  const player = {
    play() {
      if (steps().length === 0 || manual()) return;
      if (done) restart();
      if (!playing) { playing = true; lastNow = null; }
    },
    pause() { pausePlayback(); },
    /** Whether it is playing now: what a frame loop asks every frame, so it does not build a whole snapshot to find out */
    isPlaying: () => playing,
    next() {
      pausePlayback();
      if (index < last()) { index++; elapsed = 0; } else if (steps().length) done = true;
    },
    prev() {
      pausePlayback();
      done = false;
      if (index > 0) { index--; elapsed = 0; }
    },
    goTo(i) {
      pausePlayback();
      if (!Number.isFinite(i)) return;
      const next = clampIndex(Math.floor(i));
      if (next !== index) { index = next; elapsed = 0; }
      done = false;
    },
    stop() { pausePlayback(); restart(); },
    /** Changes the viewer's speed (ms per step, or 'manual') while it plays: the time already spent in the step still counts, and manual pauses it */
    setSpeed(next) {
      speed = next;
      if (manual()) pausePlayback();
    },
    /** The scenario it plays (an edited one after `setScenario`): what the checks are planned from (check.js) */
    scenario: () => sc,
    /** Swaps in an edited scenario, keeping the step it was on when that still exists */
    setScenario(next) {
      sc = next;
      index = clampIndex(index);
      if (steps().length === 0) done = true;
    },
    /**
     * Moves time on to `nowMs` (any clock that only goes forward; the browser's is the frame
     * loop's). The first tick after `play()` only sets the clock. Does nothing unless playing.
     */
    tick(nowMs) {
      if (!playing || manual()) return;
      if (lastNow === null) { lastNow = nowMs; stepStart = nowMs - elapsed; return; }
      const dt = Math.max(0, nowMs - lastNow);
      elapsed += Math.min(dt, maxFrameMs);
      if (dt > maxFrameMs) stepStart = nowMs - elapsed; // time was lost (a hidden tab): the step began later than the clock says
      lastNow = nowMs;
      while (elapsed >= durationAt(index)) {
        if (index >= last()) { elapsed = durationAt(index); done = true; pausePlayback(); return; }
        elapsed -= durationAt(index);
        stepStart += durationAt(index);
        index++;
      }
    },
    /** @returns {ScenarioSnapshot} */
    snapshot() {
      const all = steps();
      const nodes = new Set();
      const edges = new Set();
      const edgeList = [];
      for (let i = 0; i <= index && i < all.length; i++) {
        const s = all[i];
        if (s.node !== undefined) nodes.add(s.node);
        if (s.at !== undefined) nodes.add(s.at);
        if (s.edge) {
          nodes.add(s.edge.from);
          nodes.add(s.edge.to);
          const key = edgeKey(s.edge);
          if (!edges.has(key)) { edges.add(key); edgeList.push({ ...s.edge }); }
        }
      }
      const step = all[index];
      const current = { text: step ? String(step.text ?? '') : '' };
      if (step && step.node !== undefined) current.node = step.node;
      if (step && step.edge) { current.edge = { ...step.edge }; current.edgeKey = edgeKey(step.edge); }
      const actor = stepActor(sc, step);
      if (actor) current.actor = actor;
      if (step && step.at !== undefined) current.at = step.at;
      if (step && step.check !== undefined) current.check = JSON.parse(JSON.stringify(step.check));
      if (step && step.expect !== undefined) current.expect = step.expect;
      const ms = durationAt(index);
      return {
        id: sc.id, title: sc.title, total: all.length, index, playing, done,
        visited: { nodes, edges, edgeList },
        current,
        progress: done ? 1 : manual() ? 0 : Math.min(1, elapsed / ms),
        manual: manual(),
        stepMs: ms,
        stepStartMs: stepStart,
        linkNodes: !!sc.linkNodes,
        down: scenarioDown(sc),
      };
    },
  };
  return player;
}

/**
 * Where the camera should go so a step is on screen, or null when it already is (or the step points
 * at something that is not in the map). A node off screen is centred at the same zoom; an edge is
 * centred and, if its two ends do not fit, zoomed out to fit (never below MIN_FIT_ZOOM, never in).
 * A step's `at` is kept in view with it when it is on the map, and ignored when it is not (a live id with no live layer).
 * @param {Step} step
 * @param {{ x: number, y: number, zoom: number }} camera
 * @param {{ width: number, height: number }} viewport CSS px
 * @param {Map<string, { x: number, y: number, r?: number }>} nodes by id
 * @param {number} [margin] px kept clear at the screen's edge
 * @returns {{ x: number, y: number, zoom: number } | null}
 */
export function cameraFor(step, camera, viewport, nodes, margin = 60) {
  if (!viewport.width || !viewport.height) return null;
  const ids = step.node !== undefined ? [step.node] : step.edge ? [step.edge.from, step.edge.to] : [];
  const ends = ids.map((id) => nodes.get(id));
  if (ends.length === 0 || ends.some((n) => !n)) return null;
  if (step.at !== undefined && nodes.has(step.at) && !ids.includes(step.at)) ends.push(nodes.get(step.at));

  const onScreen = ends.every((n) => {
    const sx = camera.x + n.x * camera.zoom;
    const sy = camera.y + n.y * camera.zoom;
    return sx >= margin && sx <= viewport.width - margin && sy >= margin && sy <= viewport.height - margin;
  });
  if (onScreen) return null;

  const r = (n) => n.r || 18;
  const minX = Math.min(...ends.map((n) => n.x - r(n)));
  const maxX = Math.max(...ends.map((n) => n.x + r(n)));
  const minY = Math.min(...ends.map((n) => n.y - r(n)));
  const maxY = Math.max(...ends.map((n) => n.y + r(n)));
  const fit = Math.min((viewport.width - margin * 2) / (maxX - minX), (viewport.height - margin * 2) / (maxY - minY));
  const zoom = Math.max(MIN_FIT_ZOOM, Math.min(camera.zoom, fit));
  return { x: viewport.width / 2 - ((minX + maxX) / 2) * zoom, y: viewport.height / 2 - ((minY + maxY) / 2) * zoom, zoom };
}

/**
 * The ROM simulation's walk as a scenario: the path's nodes in order, each step's text the label of
 * the stage that happens there (a node with two stages gets both; a node with none keeps its name).
 * @param {{ table: string, path: string[], stages: { node: string, label: string }[], labelOf: (id: string) => string }} walk
 * @returns {Scenario}
 */
export function romScenario({ table, path, stages, labelOf }) {
  const textOf = (id) => {
    const labels = stages.filter((s) => s.node === id).map((s) => s.label);
    return labels.length ? labels.join(', then ') : labelOf(id);
  };
  return {
    id: `rom-${table}`,
    title: `A write to ${table} through ROM`,
    stepMs: 420,
    linkNodes: true,
    steps: path.map((id) => ({ node: id, text: textOf(id) })),
  };
}

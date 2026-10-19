/**
 * @module explorer/state
 *
 * The explorer's one shared, mutable state object. ES module bindings cannot be reassigned
 * from another module, so everything that more than one module reads or writes lives here as a
 * property: the topology, which layers are on, the camera, the selection, the view.
 */

// The one escaper: the server serves this file (core/text.js), beside the explorer's own
import { escapeHtml } from '../core/text.js';

/** The map canvas, and a 2d context used only to measure text (layout.js), set by main.js before anything draws */
export const state = {
  canvas: /** @type {HTMLCanvasElement|null} */ (null),
  ctx: /** @type {CanvasRenderingContext2D|null} */ (null),
  /** The transparent canvas stacked over `canvas` that draws every label (labels.js); null = no labels */
  labelCanvas: /** @type {HTMLCanvasElement|null} */ (null),
  width: 0,
  height: 0,
  /** Height (px) of the bottom of the map the phone's sheets cover (sheets.js); 0 on a desktop. The fit and the scenario camera leave it out. */
  coveredBottom: 0,

  /** topology.json: every node has x/y assigned by layout.js (the file stores no positions) */
  nodes: [],
  edges: [],

  /** 'orbit' (the whole map), 'dataflow' (the preset: browser -> servers -> API -> tables -> services -> outside) or 'house' (the House preset, PHY-11) */
  view: 'orbit',
  /** What the data-flow preset shows, built by flows.js buildDataFlow() when the topology loads */
  flow: null,
  /** The orbital rings layout.js drew the positions on */
  rings: { rings: [], clusters: [] },

  /** 'dark' or 'light': the ground the map is drawn for (theme.js keeps it, from the system and the toggle); a change must `touchScene()` */
  theme: 'dark',

  camera: { x: 0, y: 0, zoom: 1 },
  selectedNode: null,
  searchQuery: '',

  isFreeform: false,
  freeformPositions: {},

  /**
   * Layer key -> on. The infra layer is its own view, so it starts off, and so do the physical world's
   * (spec 0029): machines, containers, devices, the house and people. Turning one of the live ones on
   * (live-model.js LIVE_LAYERS) is what first loads the live layer.
   */
  activeLayers: {
    app: true, pkg: true, page: true, atom: true, molecule: true, token: true, tool: true,
    flow: true, table: true, rom: true, service: true, cloud: true, web: true, stack: false,
    machine: false, container: false, device: false, house: false, persona: false,
  },

  /**
   * The map as the last `setMap` (view.js) was handed it, before the live layer is laid in: the base
   * copies, or a proposal applied over them. `nodes` and `edges` are these plus the live ones.
   */
  mapNodes: [],
  mapEdges: [],

  /**
   * The live layer (live.js, spec 0029 section 4), in memory only and never stored anywhere: the
   * runner's snapshot `{ status, answer, error, lastOkAt }` and what merging it found: `counts`
   * (persona id -> accounts), `other` (accounts no persona counts), `linked` (node id -> its
   * inventory item). null until a live layer is first turned on.
   */
  live: null,

  /**
   * The House view (house.js, house-model.js, spec 0029 section 7): its settings (`floor`, `phone`, `software`, the
   * rooms opened past their "+N", the plugin's default plan) and what its last layout found (what it shows, its bands
   * and tray, the fit, each thing's floor). null until the view is first opened.
   */
  house: null,

  /**
   * The map as topology.json holds it: never laid out, never changed. `nodes` and `edges` above are
   * copies of these (or `applyProposal` of them while a proposal is open), which is what makes
   * Before, After and closing a proposal exact.
   */
  baseNodes: [],
  baseEdges: [],

  /**
   * The proposal open on the map (proposal.js, spec 0012 B2): the parsed file or null. While it is
   * set, `nodes` and `edges` are `applyProposal(base, proposal)`: each carries `mark` (and `before`,
   * `why` when changed or removed). `proposalView` is what scene.js shows of that: 'before' | 'diff' |
   * 'after'. `proposalSource` is where it was found ('checkout' or a worktree name), `proposalSlug` its
   * file name without `.json`, `proposalErrors` what `validateProposal` found against the base.
   */
  proposal: null,
  proposalView: 'diff',
  proposalSource: null,
  proposalSlug: null,
  proposalErrors: [],
  /** Where each of the open proposal's mockups stands with the review, by position: 'approved' | 'changed' | 'unreviewed' | 'missing' (mockups.js; none read yet is empty) */
  mockupStates: {},
  /**
   * The proposal the map is drawn from: `proposal` with what-if edits folded in (whatif.js, TOPO-11), or `proposal` itself
   * when there are none; null with no proposal open. `proposal` is never changed: it is the robot's file.
   */
  effectiveProposal: null,
  /** The maintainer's what-if edits to the open proposal, and what Undo took back (whatif-model.js): `{ edits, undone }` */
  whatIf: { edits: [], undone: [] },
  /** A marked edge picked on the map (nodes are `selectedNode`): the panel shows it, the scene does not change */
  selectedEdge: null,

  /**
   * The scenario being played on the map: the player's snapshot (scenario.js `ScenarioSnapshot`:
   * index, playing, done, visited, current, progress ...) or null. The ROM simulation's walk is one.
   * scenario-ui.js owns it; scene.js lights it, and an outage's `down` its blast radius (outage-model.js).
   */
  scenario: null,

  /**
   * Changes whenever anything the scene is built from changes (scene.js). render.js rebuilds the
   * scene only when this moved: never for a camera change or a packet frame.
   */
  sceneVersion: 0,
};

/**
 * Call after changing anything a picture is built from: the topology or its layout (positions, radii,
 * a dragged node), the layers, the selection, the search, the view, a playing scenario, and
 * later a proposal. Not for the camera, and not for time.
 */
export function touchScene() {
  state.sceneVersion++;
  sceneListeners.forEach((fn) => fn());
}

const sceneListeners = new Set();
/** Calls `fn` after every touchScene(): for UI that follows what the scene is built from (the scenario list follows `state.proposal`). Returns how to stop. */
export function onSceneTouch(fn) {
  sceneListeners.add(fn);
  return () => sceneListeners.delete(fn);
}

/** The edges the current view draws and the selection walks */
export function viewEdges() {
  return state.view === 'dataflow' && state.flow ? state.flow.edges : state.edges;
}

export const nodeById = (id) => state.nodes.find((n) => n.id === id);
export const nameOf = (id) => (nodeById(id) || { label: id }).label;

export const escHtml = escapeHtml;

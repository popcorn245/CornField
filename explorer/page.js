/**
 * @module explorer/page
 *
 * cornfield's own page: the shell that mounts the engine in the document (spec 0011 D1, D2). explorer/main.js (which index.html loads) only
 * calls `startPage()`. It makes exactly one instance (instance.js) with the document as its root, starts the map on it, and wires the header,
 * the Layers menu and the side panel to the modules that do the work (some are on the instance already, some still reach it through
 * state.js), loads topology.json, then the sources the repo's config names (plugins.js).
 *
 * This is the one module that may read `location`, write `history` and listen on `document`: the address bar, the click on any
 * `data-action` and the deep links belong to the page, not to a piece. (test/explorer/instance-tripwires.test.js exempts it.)
 *
 *   instance.js the instance (state, root, base)   engine/layout.js   where nodes sit (orbit, lanes, freeform)
 *   engine/render.js the camera and the loop        flows.js    flow styling, legend, the data-flow preset
 *   scene.js    what is drawn (contract)    renderer.js  how it is drawn: renderer-webgl.js or renderer-canvas2d.js
 *   layers.js   the Layers menu             panels.js   the node panel
 *   view.js     loading and view switching  input.js    mouse and touch
 *   proposal.js the proposal overlay (picker, Before / Diff / After); proposal-model.js its pure half
 *   whatif.js   what-if edits on an open proposal (add, remove, draw, steps, undo); whatif-model.js its pure half
 *   review.js   approve a proposal or send it back with a note and the edits; review-model.js its pure half
 *   deep-link.js  ?run=, ?issue= and ?proposal=…&start=1 land on a run, an issue and a Start dialog
 *   scenario.js the player's pure core      scenario-ui.js  its bar, keys and camera
 *   bench.js    /?bench=1 stopwatch and /?fixture=5k (the generated topology, from the server)
 *   keyboard.js the map by keyboard and the screen reader's announcer; keyboard-model.js its pure half
 *   search.js   search: the count, the list by type and the stepping; search-model.js its pure half (what it reads and the rank)
 *   live.js     the live layer: the chip, polling, laying a live source's answer over the map; live-model.js its pure half
 *   review-tokens.js  review tokens for the review API, when somebody is signed in: make one (shown once), list, revoke; review-tokens-model.js its pure half
 *   forge-panel.js  the issues and PRs panel, when the config names a forge: a PR lights the nodes it changes; forge-panel-model.js its pure half
 *   theme.js    light or dark: the system setting and the header toggle; theme-model.js the colours (theme-boot.js before the first paint)
 */

import { state, nodeById, startPageInstance } from './state.js';
import { initSearch, setQuery, stepMatch } from './search.js';
import { createMap } from './engine/render.js';
import { rendererPreference } from './renderer.js';
import { clearFreeformPositions, layoutOrbit, loadFreeformPositions } from './engine/layout.js';
import { measureCovered } from './sheets.js';
import { stopFlight } from './fly.js';
import { clickWithLegendMenu, setProjectLayers, toggleAllLayers, toggleLayer, toggleLayerKinds, toggleLegendMenu } from './layers.js';
import { closeDrawer, copySpec, selectNode, startRun } from './panels.js';
import { initScenarioUi, maybeStartDemo, playOutage } from './scenario-ui.js';
import { initSheets } from './sheets.js';
import { initReviewColumn } from './review-column.js';
import { loadTopology, setView, syncViewUi } from './view.js';
import { mount as mountMap } from './pieces/map.js';
import { initProposals } from './proposal.js';
import { followDeepLink } from './deep-link.js';
import { initWhatIf } from './whatif.js';
import { initReview } from './review.js';
import { initMockups } from './mockups.js';
import { benchMeta, measureParams, readoutLines, resultLine, runBench, showReadout } from './bench.js';
import { initLive } from './live.js';
import { initHouse } from './house.js';
import { houseOffered } from './house-model.js';
import { initChecks } from './check.js';
import { frameThem, initKeyboard } from './keyboard.js';
import { initForgePanel } from './forge-panel.js';
import { initReviewTokens } from './review-tokens.js';
import { loadClientConfig, loadSources, applyBranding } from './plugins.js';
import { initTheme, setThemeChoice } from './theme.js';
import { initAccountMenu } from './account-menu.js';
import { watchHeaderFit } from './header-fit.js';
import { watchHint } from './hint.js';
import { watchFocusRoom } from './focus-room.js';
import { mapStyleOf } from './engine/map-style.js';

/** The instance and its map: made by `startPage`, the one of this document */
let inst;
let map;

const $ = (id) => inst.el(id);
const render = () => map.render();
const fitGraphToViewport = (...a) => map.fitGraphToViewport(...a);
const fitPadding = () => map.fitPadding();

// ---------------------------------------------------------------------------
//  Freeform mode: orbit clustering (locked) or dragging nodes anywhere
// ---------------------------------------------------------------------------
function updateFreeformUI() {
  const on = state.isFreeform;
  $('freeform-toggle-btn').setAttribute('aria-checked', String(on));
  $('reset-positions-btn').hidden = !on;
  syncViewUi();
  state.canvas.style.cursor = on ? 'default' : 'grab';
}

function toggleFreeformMode() {
  setView('orbit'); // positions are only draggable on the full map
  state.isFreeform = !state.isFreeform;
  layoutOrbit(inst);
  updateFreeformUI();
  render();
}

function resetFreeformPositions() {
  clearFreeformPositions(inst);
  layoutOrbit(inst);
  updateFreeformUI();
  render();
}

// ---------------------------------------------------------------------------
//  Search
// ---------------------------------------------------------------------------
function toggleMobileSearch(open) {
  const bar = $('mobile-search-bar');
  const input = $('mobile-node-search');
  const willOpen = open !== undefined ? open : bar.hidden;
  bar.hidden = !willOpen;
  if (willOpen) {
    input.value = state.searchQuery;
    setTimeout(() => input.focus(), 60);
  }
}

// ---------------------------------------------------------------------------
//  One click handler for everything with a data-action
// ---------------------------------------------------------------------------
const ACTIONS = {
  'reset-view': () => fitGraphToViewport(fitPadding()),
  'fit': () => fitGraphToViewport(fitPadding()),
  'toggle-layers-menu': () => toggleLegendMenu(),
  'layers-all': () => toggleAllLayers(true, { viewer: true }),
  'layers-none': () => toggleAllLayers(false, { viewer: true }),
  'toggle-layer': (el) => toggleLayer(el.dataset.layer, { viewer: true }),
  'toggle-layer-kinds': (el) => toggleLayerKinds(el.dataset.layer),
  'toggle-freeform': () => toggleFreeformMode(),
  'reset-positions': () => resetFreeformPositions(),
  'preset-map': () => {
    closeDrawer();
    setView('orbit');
  },
  'preset-dataflow': () => {
    closeDrawer();
    setView(state.view === 'dataflow' ? 'orbit' : 'dataflow');
  },
  'toggle-mobile-search': () => toggleMobileSearch(),
  'close-mobile-search': () => toggleMobileSearch(false),
  'clear-search': () => { setQuery(''); const field = $('node-search'); const bar = $('mobile-search-bar'); (bar && !bar.hidden ? $('mobile-node-search') : field).focus(); },
  'search-prev': () => stepMatch(-1),
  'search-next': () => stepMatch(1),
  'close-drawer': () => closeDrawer(),
  'copy-spec': (el) => copySpec(el),
  'start-run': () => startRun(),
  'select-node': (el) => selectNode(nodeById(el.dataset.id), { frame: true }), // a link or a list row: the camera follows (spec 0008 D6)
  'frame-selection': () => frameThem(),
  'play-outage': (el) => playOutage(el.dataset.id), // the cloud panel's Play button (spec 0031 section 8)
  'retry': () => loadTopology(),
  'set-theme': (el) => setThemeChoice(el.dataset.choice),
};

// Any click outside the Layers menu closes it; a click on one of its rows does not (layers.js clickWithLegendMenu reads which before the action)
document.addEventListener('click', (e) => clickWithLegendMenu(e.target, () => {
  const target = e.target.closest('[data-action]');
  if (target) {
    const action = ACTIONS[target.dataset.action];
    if (action) action(target);
  }
}));

// ---------------------------------------------------------------------------
//  /?bench=1: the scripted pan-and-zoom of bench.js on the map as loaded
// ---------------------------------------------------------------------------
async function runPageBench(frames, zoomFactor, sync) {
  fitGraphToViewport(fitPadding());
  const { camera, width, height } = state;
  const base = { zoom: camera.zoom, cx: (width / 2 - camera.x) / camera.zoom, cy: (height / 2 - camera.y) / camera.zoom, width, height, zoomFactor };
  const result = await runBench({
    frames,
    base,
    setCamera: (c) => { camera.x = c.x; camera.y = c.y; camera.zoom = c.zoom; },
    // renderNow draws this instant (and the labels with it), so a measured frame is a whole one
    draw: () => {
      map.renderNow();
      // ?sync=1: wait for the GPU, so the time in draw is the whole frame's and not just the hand-over
      if (sync) { const gl = state.canvas.getContext('webgl2'); if (gl) gl.finish(); }
    },
    // The page's own frames (a packet loop, a pending draw) would add draws the script does not count:
    // hold them while the run lasts, then let go, so the run draws what a viewer sees
    before: () => map.holdFrames(true),
    after: () => { map.holdFrames(false); fitGraphToViewport(fitPadding()); map.ensureFlowLoop(); },
  });
  const meta = benchMeta({
    nodes: state.nodes.length, edges: state.edges.length, view: state.view, renderer: map.getRenderer().kind,
    zoomFactor, width, height, dpr: window.devicePixelRatio, search: window.location.search,
  });
  const line = resultLine(result, meta);
  console.log(line);
  window.__bench = { result, meta, line };
  showReadout(document, readoutLines(result, meta));
}

// ---------------------------------------------------------------------------
//  Start
// ---------------------------------------------------------------------------
/**
 * Starts cornfield's page: the one instance of this document, its map, and everything the page shows. Called once, by main.js.
 * @returns {ReturnType<typeof startPageInstance>} the page's instance
 */
export function startPage() {
  inst = startPageInstance({ root: document }); // the one instance of this document, the document its root; state.js hands the modules that are not yet on an instance its state
  map = createMap(inst, { measureCovered }); // the camera, the scene and the frame loop of this instance (engine/render.js)
  const mapStyle = mapStyleOf(inst);
  initTheme(); // light or dark, before the first scene is built (theme.js)
  // The map's canvases, their keys' help and the announcer are made by the map piece (pieces/map.js, also what <corn-map> mounts), into this stage.
  // It watches the theme's tokens (the map reads --corn-map-* from the theme, and again when it changes), makes the renderer (WebGL2, or Canvas 2D
  // when it is missing or the address says ?renderer=canvas2d: the address is read here, not by the renderer), binds the canvas and follows the box's size.
  // The page keeps what a tap on a node means (its panel) and the keys (keyboard.js, which also drives the panels): `handleTaps` and `keyboard` are off.
  mountMap(document.querySelector('[data-corn="stage"]'), inst, {
    stage: false, keyboard: false, handleTaps: false, measureCovered,
    renderer: rendererPreference(window.location.search) === 'canvas2d' ? 'canvas2d' : 'auto',
    keysHelp: "Arrow keys pan, plus and minus zoom, 0 fits the map. N and P select the next and the previous node, Home and End the first and the last. F frames the selected node and what it lights. Enter goes to the selected node's panel, Escape closes it. In Freeform, Alt and an arrow moves the selected node.",
  });
  loadFreeformPositions(inst);
  // What a tap on the map asks of the page: a node's panel, the normal view, the end of a flight to a match
  inst.on('select', (node) => selectNode(node));
  inst.on('background', () => closeDrawer());
  inst.on('grab', () => stopFlight());
  initKeyboard(); // the map, the panel, the search and the Layers menu by keyboard (keyboard.js)
  initAccountMenu(); // the one menu at the right of the header (account-menu.js)
  initSheets();
  initScenarioUi();
  initReviewColumn(); // the review column: the changes, and the personas with their scenarios (review-column.js)
  initSearch(); // the count, the list and the stepping of both search fields (search.js)

  map.resize();
  syncViewUi();
  // /?proposal=<slug> opens a proposal over the map, /?view=dataflow the data-flow preset: both have a link
  const configReady = loadClientConfig().then((config) => { applyBranding(document, config); watchHeaderFit(document); watchHint(document); watchFocusRoom(document); mapStyle.applyTheme(config.theme); setProjectLayers(config.layers); syncViewUi(); return config; }); // the brand, then the theme's icons for the map; the hint again, in the repo's words
  loadTopology().then(async (ok) => {
    if (!ok) return;
    // The sources the repo's cornfield.config.js names (plugins.js): a live layer, a house, devices, a checker; each optional
    const config = await configReady;
    state.forge = config.forge || null;
    const { liveSource, floorRenderer, checker, houseSource } = await loadSources(config);
    const forgeOn = initForgePanel(config); // issues and PRs: only when the config names a forge (forge-panel.js)
    initReviewTokens(config); // review tokens for the review API: only for somebody signed in (review-tokens.js)
    initWhatIf(); // before a proposal can open, so its edits come with it
    initReview(); // after it: the review controls sit under the edit controls on the bar
    initMockups(); // a proposal's screens open from the node they name
    const proposalOpened = await initProposals();
    // The live layer (live.js): loads only once a live layer goes on in the Layers menu; with no source it stays off
    initLive({ source: liveSource, onSelectionGone: closeDrawer });
    // The House view (house.js): a source's floor renderer draws the plan under the map (plain room boxes without one); /?view=house opens it
    initHouse({ floor: floorRenderer, offered: houseOffered(houseSource, state.nodes) }); // no house source and no house in the map: no House button
    initChecks({ checker }); // scenarios ask the source's checker, when there is one (check.js)
    if (new URLSearchParams(window.location.search).get("view") === "dataflow") setView("dataflow");
    // /?run=, /?issue= and /?proposal=…&start=1 land on a run, an issue's Start button and a proposal's Start dialog (deep-link.js)
    followDeepLink({ proposalOpened, forgeOn }).catch((err) => console.error('Following the link failed', err));
    // /?scenario-demo=1 plays a small scenario over real nodes, to look at the player
    maybeStartDemo();
    // /?bench=1 runs the stopwatch (bench.js) once the map is up
    const { benchFrames, benchZoom, benchSync } = measureParams(window.location.search);
    if (benchFrames) {
      try { await runPageBench(benchFrames, benchZoom, benchSync); } catch (err) { console.error("The bench failed", err); }
    }
  });
  return inst;
}

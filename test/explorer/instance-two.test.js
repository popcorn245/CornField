// @vitest-environment happy-dom
/**
 * Spec 0011 D2: two maps in one document. Each is an instance of the engine over its own root, with a topology of its own; selecting,
 * hovering, panning, changing the layers or the layout in one changes nothing in the other, and each reads its own tokens from its own
 * root. A renderer is a recording stand-in: the point is what the instances share, which is nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadSample } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { createInstance } from '../../explorer/instance.js';
// @ts-expect-error plain JS modules, no declarations
import { createMap } from '../../explorer/engine/render.js';
// @ts-expect-error plain JS modules, no declarations
import { computeDegreeCentrality, layoutOrbit } from '../../explorer/engine/layout.js';
// @ts-expect-error plain JS modules, no declarations
import { bindCanvasInput } from '../../explorer/input.js';
// @ts-expect-error plain JS modules, no declarations
import { looksWith, mapStyleOf, styledScene } from '../../explorer/engine/map-style.js';
// @ts-expect-error plain JS modules, no declarations
import { looksFor } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { state as pageState } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import * as nodePanel from '../../explorer/pieces/node-panel.js';
// @ts-expect-error plain JS modules, no declarations
import * as layersPiece from '../../explorer/pieces/layers.js';
// @ts-expect-error plain JS modules, no declarations
import * as searchPiece from '../../explorer/pieces/search.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode, clearSelection } from '../../explorer/engine/selection.js';
// @ts-expect-error plain JS modules, no declarations
import { applyStrings } from '../../explorer/engine/strings.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard } from '../../explorer/engine/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import * as proposalPiece from '../../explorer/pieces/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import * as changesPiece from '../../explorer/pieces/changes.js';
// @ts-expect-error plain JS modules, no declarations
import * as decisionPiece from '../../explorer/pieces/decision.js';
// @ts-expect-error plain JS modules, no declarations
import { HOLD_MS } from '../../explorer/decision-model.js';
// @ts-expect-error plain JS modules, no declarations
import * as workPiece from '../../explorer/pieces/work.js';

const sample = loadSample();
/** Two different maps: all of the sample, and the sample without its pages (and the edges that touch them) */
const topologyA = () => ({ nodes: structuredClone(sample.nodes), edges: structuredClone(sample.edges) });
const topologyB = () => {
  const nodes = structuredClone(sample.nodes.filter((n) => n.type !== 'page'));
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: structuredClone(sample.edges.filter((e) => ids.has(e.from) && ids.has(e.to))) };
};

const SIZE = { width: 800, height: 600 };
const measure = { save() {}, restore() {}, font: '', measureText: (s) => ({ width: String(s).length * 6 }) };

/** A map mounted in a root of its own, with the renderer replaced by one that records what it was asked to draw */
function mount(name, topology, tokens = {}, extra = {}) {
  const root = document.createElement('div');
  root.id = `root-${name}`;
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
  root.innerHTML = '<div class="hx-stage"><canvas id="graph-canvas"></canvas><canvas id="label-canvas"></canvas></div>';
  document.body.append(root);
  const inst = createInstance({ root, ...extra });
  const canvas = inst.el('graph-canvas');
  const stage = canvas.parentElement;
  Object.defineProperty(stage, 'clientWidth', { value: SIZE.width });
  Object.defineProperty(stage, 'clientHeight', { value: SIZE.height });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: SIZE.width, bottom: SIZE.height, width: SIZE.width, height: SIZE.height, x: 0, y: 0, toJSON() {} });
  Object.assign(inst.state, { canvas, ctx: measure, nodes: topology.nodes, edges: topology.edges });
  const map = createMap(inst);
  const drawn = [];
  map.setRenderer({ kind: 'stub', draw: (scene, camera) => drawn.push({ scene, camera: { ...camera } }), resize() {}, destroy() {} });
  computeDegreeCentrality(inst);
  layoutOrbit(inst);
  map.resize();
  map.fitGraphToViewport(40);
  bindCanvasInput(inst);
  map.renderNow();
  return { inst, map, canvas, root, drawn, state: inst.state };
}

const mouse = (target, type, x, y) => target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
const frame = () => vi.advanceTimersByTime(16);
/** Where a node is on the screen of an instance */
const screenOf = ({ state }, node) => ({ x: state.camera.x + node.x * state.camera.zoom, y: state.camera.y + node.y * state.camera.zoom });

let A;
let B;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  A = mount('a', topologyA(), { '--corn-map-node-app': 'rgb(255, 0, 0)', '--corn-map-stroke': 'rgb(1, 2, 3)' });
  B = mount('b', topologyB(), { '--corn-map-node-app': 'rgb(0, 0, 255)' });
});

afterEach(() => {
  A.inst.destroy();
  B.inst.destroy();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('two instances in one document', () => {
  it('are two things: each has a state, a map and elements of its own, and neither is the page\'s', () => {
    expect(A.state).not.toBe(B.state);
    expect(A.state).not.toBe(pageState);
    expect(A.map).not.toBe(B.map);
    expect(A.canvas).not.toBe(B.canvas);
    expect(A.inst.el('graph-canvas')).toBe(A.canvas); // the same id in two roots: each finds its own
    expect(B.inst.el('graph-canvas')).toBe(B.canvas);
    expect(A.state.nodes.length).toBeGreaterThan(B.state.nodes.length);
    expect(B.state.nodes.some((n) => n.type === 'page')).toBe(false);
    expect(A.map.getScene().nodes.length).toBeGreaterThan(B.map.getScene().nodes.length);
  });

  it('selecting a node in one changes nothing in the other', () => {
    const before = { scene: B.map.getScene(), builds: B.map.sceneBuilds(), drawn: B.drawn.length, camera: { ...B.state.camera } };
    const target = A.state.nodes.find((n) => n.type === 'app');
    A.state.selectedNode = target;
    A.inst.touchScene();
    A.map.renderNow();
    expect(A.map.getScene().nodes.find((n) => n.id === target.id).selected).toBe(true);
    expect(A.map.getScene().nodes.filter((n) => n.selected)).toHaveLength(1);
    // B: no selection, no new scene, no draw, the same camera
    expect(B.state.selectedNode).toBeNull();
    expect(B.map.getScene()).toBe(before.scene);
    expect(B.map.sceneBuilds()).toBe(before.builds);
    expect(B.drawn.length).toBe(before.drawn);
    expect(B.state.camera).toEqual(before.camera);
    expect(B.map.getScene().nodes.some((n) => n.selected)).toBe(false);
  });

  it('a tap on a node in one is heard by that instance only', () => {
    const heardA = vi.fn();
    const heardB = vi.fn();
    A.inst.on('select', heardA);
    B.inst.on('select', heardB);
    const node = A.state.nodes.find((n) => n.type === 'app');
    const at = screenOf(A, node);
    mouse(A.canvas, 'mousedown', at.x, at.y);
    mouse(A.canvas, 'mouseup', at.x, at.y);
    expect(heardA).toHaveBeenCalledTimes(1);
    expect(heardA.mock.calls[0][0].id).toBe(node.id);
    expect(heardB).not.toHaveBeenCalled();
  });

  it('hovering in one names a node in that one only', () => {
    const node = A.state.nodes.find((n) => n.type === 'app');
    const at = screenOf(A, node);
    mouse(A.canvas, 'mousemove', at.x, at.y);
    frame();
    expect(A.state.hoverNodeId).toBe(node.id);
    expect(B.state.hoverNodeId).toBeNull();
    expect(A.canvas.style.cursor).toBe('pointer');
    expect(B.canvas.style.cursor).not.toBe('pointer');
  });

  it('panning one moves its camera and no other, and a wheel zooms the one it is over', () => {
    const cameraB = { ...B.state.camera };
    const buildsB = B.map.sceneBuilds();
    const start = { ...A.state.camera };
    mouse(A.canvas, 'mousedown', 400, 300);
    mouse(A.canvas, 'mousemove', 430, 320);
    frame();
    mouse(A.canvas, 'mouseup', 430, 320);
    expect(A.state.camera.x).toBeCloseTo(start.x + 30);
    expect(A.state.camera.y).toBeCloseTo(start.y + 20);
    expect(B.state.camera).toEqual(cameraB);

    // In an element root the wheel is the page's until the map is asked (input.js): passing over, it scrolls the page; with the focus it zooms
    const passing = new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 300, bubbles: true, cancelable: true });
    A.canvas.dispatchEvent(passing);
    expect(passing.defaultPrevented).toBe(false);
    expect(A.state.camera.zoom).toBe(start.zoom);
    A.canvas.tabIndex = 0;
    A.canvas.focus();
    A.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
    expect(A.state.camera.zoom).toBeGreaterThan(start.zoom);
    expect(B.state.camera).toEqual(cameraB);
    expect(B.map.sceneBuilds()).toBe(buildsB);
  });

  it('changing the layers of one rebuilds its scene and leaves the other\'s alone', () => {
    const sceneB = B.map.getScene();
    const appsA = A.map.getScene().nodes.filter((n) => n.type === 'app').length;
    expect(appsA).toBeGreaterThan(0);
    A.state.activeLayers = { ...A.state.activeLayers, app: false };
    A.inst.touchScene();
    expect(A.map.getScene().nodes.filter((n) => n.type === 'app')).toHaveLength(0);
    expect(B.map.getScene()).toBe(sceneB);
    expect(B.map.getScene().nodes.filter((n) => n.type === 'app').length).toBeGreaterThan(0);
    expect(B.state.activeLayers.app).toBe(true);
  });

  it('what is told about a scene change reaches the instance that changed, not the other', () => {
    const a = vi.fn();
    const b = vi.fn();
    A.inst.onSceneTouch(a);
    B.inst.onSceneTouch(b);
    A.inst.touchScene();
    A.inst.touchScene();
    B.inst.touchScene();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
    expect(A.state.sceneVersion).not.toBe(B.state.sceneVersion);
  });

  it('laying out one moves the nodes of that one only (the freeform choice is kept per instance, too)', () => {
    const where = B.state.nodes.map((n) => [n.x, n.y]);
    A.state.isFreeform = true;
    A.state.freeformPositions = Object.fromEntries(A.state.nodes.slice(0, 3).map((n) => [n.id, { x: 5, y: 7 }]));
    layoutOrbit(A.inst);
    expect(A.state.nodes.slice(0, 3).every((n) => n.x === 5 && n.y === 7)).toBe(true);
    expect(B.state.nodes.map((n) => [n.x, n.y])).toEqual(where);
    expect(B.state.isFreeform).toBe(false);
    expect(A.state.rings).not.toBe(B.state.rings);
  });

  it('each reads its own tokens from its own root, and a change in one root reaches that instance only', () => {
    const a = mapStyleOf(A.inst);
    const b = mapStyleOf(B.inst);
    expect(a.refresh()).toBe(true);
    expect(b.refresh()).toBe(true);
    const colour = (style) => style.get().values['--corn-map-node-app'];
    expect(colour(a)).toMatch(/255,\s*0,\s*0|#ff0000/i);
    expect(colour(b)).toMatch(/0,\s*0,\s*255|#0000ff/i);
    expect(a.get().values['--corn-map-stroke']).toBeTruthy(); // set on A's root only
    expect(b.get().values['--corn-map-stroke']).toBeUndefined();

    // The picture each draws is in its own colours
    const fillOf = (map, style, type) => styledScene(map.getScene(), style.get()).nodes.find((n) => n.type === type && !n.painted).color;
    expect(fillOf(A.map, a, 'app')).toBe(colour(a));
    expect(fillOf(B.map, b, 'app')).toBe(colour(b));

    // A token changed on B's root is read by B's style, and A's does not move
    const versionA = a.get().version;
    B.root.style.setProperty('--corn-map-node-app', 'rgb(0, 128, 0)');
    expect(b.refresh()).toBe(true);
    expect(colour(b)).toMatch(/0,\s*128,\s*0|#008000/i);
    expect(a.refresh()).toBe(false);
    expect(a.get().version).toBe(versionA);
    expect(colour(a)).toMatch(/255,\s*0,\s*0|#ff0000/i);
  });

  it('the halos and the styled scene are each instance\'s own, even when both styles are at the same version', () => {
    // Every instance gets the same looks object for a ground (scene.js looksFor); its styled copy is remembered. Two styles count their
    // versions apart, so the same number can be two themes: what is remembered for one must never be handed to the other.
    A.root.style.setProperty('--corn-map-selected', 'rgb(255, 0, 255)');
    B.root.style.setProperty('--corn-map-selected', 'rgb(0, 255, 0)');
    const a = mapStyleOf(A.inst);
    const b = mapStyleOf(B.inst);
    a.refresh();
    b.refresh();
    while (a.get().version < b.get().version) a.setIcons(null); // one change each: the same tokens, the version moves on
    while (b.get().version < a.get().version) b.setIcons(null);
    expect(a.get().version).toBe(b.get().version);
    const looks = looksFor('dark');
    const ringA = looksWith(looks, a.get()).halo.selected.ring;
    const ringB = looksWith(looks, b.get()).halo.selected.ring;
    expect(ringA).toMatch(/255,\s*0,\s*255|#ff00ff/i);
    expect(ringB).toMatch(/0,\s*255,\s*0|#00ff00/i);
    // the same for a scene drawn under both styles
    const scene = A.map.getScene();
    expect(styledScene(scene, a.get())).not.toBe(styledScene(scene, b.get()));
  });

  it('a change of style in one instance draws that map again and not the other', () => {
    const seenA = vi.fn();
    const seenB = vi.fn();
    mapStyleOf(A.inst).onChange(seenA);
    mapStyleOf(B.inst).onChange(seenB);
    A.root.style.setProperty('--corn-map-node-app', 'rgb(9, 9, 9)');
    mapStyleOf(A.inst).refresh();
    expect(seenA).toHaveBeenCalledTimes(1);
    expect(seenB).not.toHaveBeenCalled();
  });

  it('theme icons are fetched from the instance\'s own base', () => {
    const urls = [];
    const root = document.createElement('div');
    document.body.append(root);
    const inst = createInstance({ root, base: 'https://map.example.test' });
    expect(inst.url('/cornfield/theme/assets/app.png')).toBe('https://map.example.test/cornfield/theme/assets/app.png');
    expect(inst.url('https://elsewhere.test/x.png')).toBe('https://elsewhere.test/x.png');
    expect(createInstance({ root }).url('/cornfield/theme/assets/app.png')).toBe('/cornfield/theme/assets/app.png');
    mapStyleOf(inst).setIcons({ icons: { app: '/cornfield/theme/assets/app.png' } }, { load: (u) => { urls.push(u); return Promise.reject(new Error('no')); }, warn() {} });
    // the default loader resolves against the base; a custom one is handed the served path as written
    expect(urls).toEqual([]);
    inst.destroy();
  });

  it('hands out what the map and the page use, and nothing more (spec 0011: the simplest thing; a later step adds what it needs)', () => {
    const inst = createInstance({ root: document.body });
    expect(Object.keys(inst).sort()).toEqual([
      'active', 'ask', 'attach', 'base', 'destroy', 'doc', 'dpr', 'el', 'emit', 'ended', 'extraRoots', 'fetch', 'hidden', 'listen', 'offline', 'on', 'onHide', 'onNetwork', 'onPageFocus', 'onPageHide', 'onPageShow', 'onResize', 'onSceneTouch', 'onShown',
      'onWindowFocus', 'own', 'reducedMotion', 'release', 'root', 'setSelection', 'slot', 'state', 'store', 'strings', 'tokenElement', 'tokenReader', 'touchScene', 'url', 'viewEdges', 'win',
    ]);
    inst.destroy();
  });

  it('a fetch is bound to the instance\'s base', async () => {
    const calls = [];
    const inst = createInstance({ root: document.body, base: 'https://map.example.test', fetch: (u, init) => { calls.push([u, init]); return Promise.resolve({ ok: true }); } });
    await inst.fetch('/cornfield/config.json', { credentials: 'include' });
    await inst.fetch('https://other.test/x');
    expect(calls).toEqual([['https://map.example.test/cornfield/config.json', { credentials: 'include' }], ['https://other.test/x', undefined]]);
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
//  Spec 0011 D3 (step 4): each with its own node panel, Layers menu and search
// ---------------------------------------------------------------------------------------------------------------------------------

describe('two instances, each with its own node panel, Layers menu and search', () => {
  let a;
  let b;
  const piecesOn = (one, strings) => {
    if (strings) Object.assign(one.inst.strings, strings);
    one.keyboard = initKeyboard(one.inst);
    one.panel = nodePanel.mount(one.root, one.inst);
    one.layers = layersPiece.mount(one.root, one.inst, { storageKey: null });
    one.search = searchPiece.mount(one.root, one.inst);
    applyStrings(one.inst, one.root);
    one.canvas.setAttribute('tabindex', '0');
    return one;
  };
  const q = (one, sel) => one.root.querySelector(sel);
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const key = (el, k, init = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };

  beforeEach(() => {
    a = piecesOn(A, { layers: 'Strata' });
    b = piecesOn(B);
  });
  afterEach(() => {
    a.panel.destroy(); a.layers.destroy(); a.search.destroy();
    b.panel.destroy(); b.layers.destroy(); b.search.destroy();
  });

  it('each makes its own markup in its own root, with the same ids twice in the document', () => {
    expect(document.querySelectorAll('#spec-drawer')).toHaveLength(2);
    expect(document.querySelectorAll('#legend-dropdown')).toHaveLength(2);
    expect(document.querySelectorAll('#node-search')).toHaveLength(2);
    expect(a.inst.el('spec-drawer')).toBe(q(a, '#spec-drawer'));
    expect(b.inst.el('spec-drawer')).toBe(q(b, '#spec-drawer'));
    expect(a.inst.el('spec-drawer')).not.toBe(b.inst.el('spec-drawer'));
    // every hook has its part
    for (const root of [a.root, b.root]) for (const el of root.querySelectorAll('[data-corn]')) expect(el.getAttribute('part'), el.outerHTML.slice(0, 80)).toBe(el.getAttribute('data-corn'));
  });

  it('selecting in one opens that one\'s panel and changes nothing in the other', () => {
    const heardA = vi.fn();
    const heardB = vi.fn();
    a.inst.on('selection', heardA);
    b.inst.on('selection', heardB);
    const sceneB = B.map.getScene();
    const node = a.state.nodes.find((n) => n.type === 'app');
    selectNode(a.inst, node, { source: 'search' });
    expect(q(a, '#spec-drawer').classList.contains('drawer-open')).toBe(true);
    expect(q(a, '#drawer-title').textContent).toBe(node.label);
    expect(q(a, '#drawer-backdrop').hidden).toBe(false);
    expect(heardA).toHaveBeenCalledTimes(1);
    expect(heardA.mock.calls[0][0]).toMatchObject({ source: 'search', edge: null });
    expect(heardA.mock.calls[0][0].node.id).toBe(node.id);
    expect(heardB).not.toHaveBeenCalled();
    expect(q(b, '#spec-drawer').classList.contains('drawer-open')).toBe(false);
    expect(q(b, '#spec-drawer').inert).toBe(true);
    expect(q(b, '#drawer-title').textContent).not.toBe(node.label);
    expect(B.state.selectedNode).toBeNull();
    expect(B.map.getScene()).toBe(sceneB);
    // the Close button of one closes that one only
    const other = b.state.nodes.find((n) => n.type === 'app');
    selectNode(b.inst, other, { source: 'tap' });
    click(q(a, '[data-action="close-drawer"]'));
    expect(a.state.selectedNode).toBeNull();
    expect(q(a, '#spec-drawer').classList.contains('drawer-open')).toBe(false);
    expect(b.state.selectedNode.id).toBe(other.id);
    expect(q(b, '#spec-drawer').classList.contains('drawer-open')).toBe(true);
  });

  it('the selection event names every way a selection changes, and says nothing when it did not', () => {
    const seen = [];
    a.inst.on('selection', (d) => seen.push([d.source, d.node ? d.node.id : null, d.edge ? d.edge.kind : null]));
    const [n1, n2] = a.state.nodes.filter((n) => n.type === 'app' || n.type === 'service');
    selectNode(a.inst, n1, { source: 'tap' });
    selectNode(a.inst, n1, { source: 'tap' }); // the same node again: not a change
    selectNode(a.inst, n2, { source: 'keyboard' });
    a.state.selectedEdge = { from: n1.id, to: n2.id, kind: 'calls' }; // an edge picked on the map
    a.state.selectedNode = n1; // a program assigning it
    clearSelection(a.inst, { source: 'api' });
    clearSelection(a.inst, { source: 'api' }); // nothing was selected: not a change
    expect(seen).toEqual([['tap', n1.id, null], ['keyboard', n2.id, null], ['state', n2.id, 'calls'], ['state', n1.id, 'calls'], ['api', null, null]]);
  });

  it('the selection event is said once per change, in order, never inside itself, with what was last heard as `previous`', () => {
    const [n1, n2, n3] = a.state.nodes.filter((n) => n.type === 'app' || n.type === 'service');
    const id = (x) => (x ? x.id : null);
    // a listener that selects while the event is being said: every listener hears the first change before anyone hears the second
    const first = [];
    const second = [];
    const offA = a.inst.on('selection', (d) => { first.push([id(d.previous.node), id(d.node)]); if (id(d.node) === n1.id) a.state.selectedNode = n2; });
    const offB = a.inst.on('selection', (d) => second.push([id(d.previous.node), id(d.node)]));
    selectNode(a.inst, n1, { source: 'tap' });
    expect(second).toEqual([[null, n1.id], [n1.id, n2.id]]);
    expect(first).toEqual([[null, n1.id], [n1.id, n2.id]]);
    offA();
    // a quiet change that a later one overtook says nothing of its own, and is said only once however often it is told to
    second.length = 0;
    const held = a.inst.setSelection(n3, null, { source: 'api', quiet: true });
    a.state.selectedNode = n1;
    held.announce();
    held.announce();
    expect(second).toEqual([[n2.id, n1.id]]);
    const twice = a.inst.setSelection(n2, null, { source: 'api', quiet: true });
    twice.announce();
    twice.announce();
    expect(second).toEqual([[n2.id, n1.id], [n1.id, n2.id]]);
    offB();
  });

  it('toggling a layer in one redraws that menu and leaves the other\'s rows, counts and scene alone', () => {
    const rowsB = q(b, '#layer-toggles-container').innerHTML;
    const chipB = q(b, '#layers-count').textContent;
    const sceneB = B.map.getScene();
    const appRow = q(a, '[data-action="toggle-layer"][data-layer="app"]');
    expect(appRow.getAttribute('aria-pressed')).toBe('true');
    click(appRow);
    expect(a.state.activeLayers.app).toBe(false);
    expect(q(a, '[data-action="toggle-layer"][data-layer="app"]').getAttribute('aria-pressed')).toBe('false');
    expect(A.map.getScene().nodes.filter((n) => n.type === 'app')).toHaveLength(0);
    expect(b.state.activeLayers.app).toBe(true);
    expect(q(b, '#layer-toggles-container').innerHTML).toBe(rowsB);
    expect(q(b, '#layers-count').textContent).toBe(chipB);
    expect(B.map.getScene()).toBe(sceneB);
    // the chip opens one menu
    click(q(a, '#legend-toggle-btn'));
    expect(q(a, '#legend-dropdown').hidden).toBe(false);
    expect(q(b, '#legend-dropdown').hidden).toBe(true);
    // a click in B's root is outside A's menu: it stays open (it is B's click), a click in A's root outside the menu closes it
    click(a.canvas);
    expect(q(a, '#legend-dropdown').hidden).toBe(true);
  });

  it('searching in one finds in that one only', () => {
    const input = q(a, '#node-search');
    type(input, 'a');
    expect(a.state.searchQuery).toBe('a');
    expect(b.state.searchQuery).toBe('');
    expect(q(a, '#search-count').textContent).not.toBe('');
    expect(q(b, '#search-count').textContent).toBe('');
    expect(q(b, '#search-steps').hidden).toBe(true);
    input.focus();
    key(input, 'Enter');
    expect(a.state.searchCurrent).toBeTruthy();
    expect(a.state.selectedNode.id).toBe(a.state.searchCurrent); // a search selects what it chose, in its own instance
    expect(b.state.selectedNode).toBeNull();
    expect(b.state.searchCurrent).toBeNull();
    // Escape in the field clears A's search
    key(input, 'Escape');
    key(input, 'Escape');
    expect(a.state.searchQuery).toBe('');
  });

  it('a shortcut acts where the focus is: / goes to that instance\'s search, N steps that map, Escape closes that panel', () => {
    a.canvas.focus();
    key(a.canvas, '/', { bubbles: true });
    expect(a.inst.active()).toBe(q(a, '#node-search'));
    expect(b.inst.active()).not.toBe(q(b, '#node-search'));
    // N on A's map selects in A only
    a.canvas.focus();
    key(a.canvas, 'n');
    expect(a.state.selectedNode).not.toBeNull();
    expect(b.state.selectedNode).toBeNull();
    // Escape inside A's panel closes A's panel
    const other = b.state.nodes.find((n) => n.type === 'app');
    selectNode(b.inst, other);
    key(q(a, '#drawer-title'), 'Escape');
    expect(a.state.selectedNode).toBeNull();
    expect(b.state.selectedNode.id).toBe(other.id);
    // a key pressed in B's root is B's: `/` on B's canvas takes B's search, and A's keeps what it has
    key(b.canvas, '/');
    expect(b.inst.active()).toBe(q(b, '#node-search'));
    expect(a.inst.active()).toBeNull();
  });

  it('speak in their own words: a key one overrides is read by that one only', () => {
    expect(q(a, '#legend-toggle-btn').firstElementChild.textContent).toBe('Strata');
    expect(q(b, '#legend-toggle-btn').firstElementChild.textContent).toBe('Layers');
    selectNode(a.inst, a.state.nodes.find((n) => n.type === 'app'));
    selectNode(b.inst, b.state.nodes.find((n) => n.type === 'app'));
    expect(q(a, '#drawer-file-btn').textContent).toBe('Open file ↗');
    a.inst.strings.openFile = 'See the source';
    a.panel.update();
    expect(q(a, '#drawer-file-btn').textContent).toBe('See the source ↗');
    expect(q(b, '#drawer-file-btn').textContent).toBe('Open file ↗');
  });

  it('make their markup in the instance\'s words from the start: a host need not apply them after mounting', () => {
    const box = document.createElement('div');
    a.root.append(box);
    a.inst.strings.searchPlaceholder = 'Find a part';
    a.inst.strings.copySpec = 'Copy as JSON';
    const layers = layersPiece.mount(box, a.inst, { storageKey: null });
    const search = searchPiece.mount(box, a.inst);
    const panel = nodePanel.mount(box, a.inst);
    expect(box.querySelector('[data-corn="layers-button"]').firstElementChild.textContent).toBe('Strata');
    expect(box.querySelector('[data-corn="search-input"]').getAttribute('placeholder')).toBe('Find a part');
    expect(box.querySelector('[data-action="copy-spec"]').textContent).toBe('Copy as JSON');
    panel.destroy(); search.destroy(); layers.destroy();
    delete a.inst.strings.searchPlaceholder;
    delete a.inst.strings.copySpec;
    box.remove();
  });

  it('ending one piece takes its markup and its listeners and leaves the other instance as it was', () => {
    const snapshot = b.root.innerHTML;
    a.panel.destroy();
    a.layers.destroy();
    a.search.destroy();
    expect(a.root.querySelector('#spec-drawer')).toBeNull();
    expect(a.root.querySelector('#legend-dropdown')).toBeNull();
    expect(a.root.querySelector('#node-search')).toBeNull();
    expect(b.root.innerHTML).toBe(snapshot);
    selectNode(a.inst, a.state.nodes.find((n) => n.type === 'app')); // no panel to open, and nothing breaks
    expect(a.state.selectedNode).not.toBeNull();
    a.panel = nodePanel.mount(a.root, a.inst); a.layers = layersPiece.mount(a.root, a.inst, { storageKey: null }); a.search = searchPiece.mount(a.root, a.inst); // for afterEach
  });
});


// ---------------------------------------------------------------------------
//  Step 5: the proposal's bar, the change list, the player and the decision, twice
// ---------------------------------------------------------------------------
describe('two instances, each with its own proposal bar, change list, player and decision', () => {
  let a;
  let b;
  let calls;
  const facts = (n) => ({ pull: { number: n, draft: false, head: String(n).repeat(40).slice(0, 40) }, checks: { total: 1, passed: 1, running: 0, failed: [] }, lands: false, landing: null, run: null });
  const res = (status, data) => ({ ok: status < 400, status, redirected: false, headers: new Headers(), json: async () => data });
  /** A proposal of its own: one added page under the first app, one scenario walking to it */
  const proposalOf = (name, parent) => ({
    version: 1, spec: name, title: `Spec ${name}`, summary: `Adds /${name}.`,
    nodes: { add: [{ id: `page-${name}`, label: `/${name}`, type: 'page', parent }] },
    edges: {},
    scenarios: [{ id: `walk-${name}`, title: `Walk ${name}`, stepMs: 1000, steps: [{ node: `page-${name}`, text: `It opens ${name}.` }, { node: parent, text: 'And its parent.' }] }],
  });
  const piecesOn = (one, name, number) => {
    const parent = one.state.nodes.find((n) => n.type === 'app').id;
    Object.assign(one.state, { baseNodes: one.state.nodes.map((n) => ({ ...n })), baseEdges: one.state.edges.map((e) => ({ ...e })) });
    one.proposal = proposalPiece.mount(one.root, one.inst);
    one.changes = changesPiece.mount(one.root, one.inst);
    one.decision = decisionPiece.mount(one.root, one.inst);
    one.number = number;
    one.name = name;
    one.pr = proposalOf(name, parent);
    return one;
  };
  const open = (one) => one.proposal.update({ proposal: one.pr, slug: `00${one.number}-${one.name}`, source: `pull/${one.number}`, sha256: String(one.number).repeat(64).slice(0, 64) });
  const q = (one, sel) => one.root.querySelector(sel);
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  beforeEach(async () => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const method = init.method || 'GET';
      calls.push({ method, url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined });
      const m = /\/proposals\/00(\d+)-[a-z]+\/(decision|review)/.exec(String(url));
      if (m && m[2] === 'decision') return res(200, facts(Number(m[1])));
      if (m && m[2] === 'review') return method === 'PUT' ? res(200, { verdict: 'approved', at: new Date().toISOString(), by: 'maintainer' }) : res(404, { error: 'No review yet' });
      return res(404, { error: 'no' });
    }));
    a = piecesOn(A, 'alpha', 21);
    b = piecesOn(B, 'beta', 22);
    open(a);
    open(b);
    await vi.advanceTimersByTimeAsync(0);
  });
  afterEach(() => {
    for (const one of [a, b]) { one.decision.destroy(); one.changes.destroy(); one.proposal.destroy(); }
  });

  it('each shows its own proposal in its own bar and list, with the same ids twice in the document', () => {
    expect(document.querySelectorAll('#proposal-bar')).toHaveLength(2);
    expect(document.querySelectorAll('#review-column')).toHaveLength(2);
    expect(document.querySelectorAll('#review-decision')).toHaveLength(2);
    expect(q(a, '#proposal-title').textContent).toBe('Spec alpha');
    expect(q(b, '#proposal-title').textContent).toBe('Spec beta');
    expect(q(a, '#review-lists').textContent).toContain('/alpha');
    expect(q(a, '#review-lists').textContent).not.toContain('/beta');
    expect(q(b, '#review-lists').textContent).toContain('Walk beta');
    expect(q(a, '#proposal-bar').hidden).toBe(false);
    expect(A.state.proposalSlug).toBe('0021-alpha');
    expect(B.state.proposalSlug).toBe('0022-beta');
    for (const one of [a, b]) for (const el of one.root.querySelectorAll('[data-corn]')) expect(el.getAttribute('part'), el.outerHTML.slice(0, 80)).toBe(el.getAttribute('data-corn'));
  });

  it('switching Before, Diff and After in one changes nothing in the other', () => {
    const sceneB = B.map.getScene();
    const buildsB = B.map.sceneBuilds();
    click(q(a, '[data-action="proposal-view"][data-view="after"]'));
    expect(A.state.proposalView).toBe('after');
    expect(q(a, '[data-view="after"]').getAttribute('aria-pressed')).toBe('true');
    expect(q(a, '[data-view="diff"]').getAttribute('aria-pressed')).toBe('false');
    expect(B.state.proposalView).toBe('diff');
    expect(q(b, '[data-view="diff"]').getAttribute('aria-pressed')).toBe('true');
    expect(q(b, '[data-view="after"]').getAttribute('aria-pressed')).toBe('false');
    expect(B.map.getScene()).toBe(sceneB);
    expect(B.map.sceneBuilds()).toBe(buildsB);
    click(q(a, '[data-action="proposal-whole"]')); // Whole map, too
    expect(A.state.review.whole).toBe(true);
    expect(B.state.review.whole).toBe(false);
    expect(q(b, '#proposal-whole').getAttribute('aria-pressed')).toBe('false');
  });

  it('playing a scenario in one puts a player there and nowhere else', async () => {
    click(q(a, '[data-action="scenario-open"]'));
    click(q(a, '[data-action="scenario-step"]'));
    expect(q(a, '.hx-player')).toBeTruthy();
    expect(q(a, '.hx-player-title').textContent).toBe('Walk alpha');
    expect(A.state.scenario).not.toBeNull();
    expect(q(b, '.hx-player')).toBeNull();
    expect(B.state.scenario).toBeNull();
    expect(q(b, '[aria-current="step"]')).toBeNull();
    expect(q(a, '[aria-current="step"]')).toBeTruthy();
    click(q(a, '[data-action="scenario-close"]'));
    expect(q(a, '.hx-player')).toBeNull();
  });

  it('pressing Approve in one holds, sends and announces for that one, and the other keeps its button and sends nothing', async () => {
    const said = [];
    a.inst.on('decision', (d) => said.push(['a', d]));
    b.inst.on('decision', (d) => said.push(['b', d]));
    const approveA = q(a, '[data-review="approved"]');
    const approveB = q(b, '[data-review="approved"]');
    click(approveA);
    expect(approveA.dataset.holding).toBe('true');
    expect(approveB.dataset.holding).toBe('false');
    expect(q(b, '[data-review-undo]').hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(HOLD_MS + 50);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe('/proposals/0021-alpha/review?source=pull%2F21');
    expect(puts[0].body).toMatchObject({ verdict: 'approved', sha256: '21'.repeat(32) });
    expect(said.map(([who, d]) => [who, d.outcome, d.slug])).toEqual([['a', 'approved', '0021-alpha']]);
    expect(q(a, '[data-review-verdict]').textContent).toBe('Approved');
    expect(q(b, '[data-review-verdict]').textContent).toBe('');
    expect(approveB.textContent).toBe('Approve');
    expect(calls.some((c) => c.method !== 'GET' && c.url.includes('0022'))).toBe(false);
  });

  it('Approve in one while a hold counts down in the other: each sends its own, at its own time; Undo in one leaves the other\'s hold', async () => {
    const said = [];
    a.inst.on('decision', (d) => said.push(['a', d.slug]));
    b.inst.on('decision', (d) => said.push(['b', d.slug]));
    click(q(a, '[data-review="approved"]'));
    await vi.advanceTimersByTimeAsync(2000);
    click(q(b, '[data-review="approved"]'));
    expect(q(a, '[data-review="approved"]').dataset.holding).toBe('true');
    expect(q(b, '[data-review="approved"]').dataset.holding).toBe('true');
    // B's Undo, while A still holds
    click(q(b, '[data-review-undo]'));
    expect(q(b, '[data-review="approved"]').dataset.holding).toBe('false');
    expect(q(a, '[data-review="approved"]').dataset.holding).toBe('true');
    click(q(b, '[data-review="approved"]')); // and again: B's hold now ends 2 s after A's
    await vi.advanceTimersByTimeAsync(HOLD_MS - 2000 + 100);
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.url)).toEqual(['/proposals/0021-alpha/review?source=pull%2F21']);
    expect(said).toEqual([['a', '0021-alpha']]);
    expect(q(b, '[data-review="approved"]').dataset.holding).toBe('true');
    await vi.advanceTimersByTimeAsync(2100);
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.url)).toEqual(['/proposals/0021-alpha/review?source=pull%2F21', '/proposals/0022-beta/review?source=pull%2F22']);
    expect(said).toEqual([['a', '0021-alpha'], ['b', '0022-beta']]);
    expect(q(a, '[data-review-verdict]').textContent).toBe('Approved');
    expect(q(b, '[data-review-verdict]').textContent).toBe('Approved');
  });

  it('the same proposal open in both: a press in one holds and sends there only, and Escape in the other stops nothing', async () => {
    b.proposal.update({ proposal: a.pr, slug: '0021-alpha', source: 'pull/21', sha256: '21'.repeat(32) });
    await vi.advanceTimersByTimeAsync(0);
    click(q(a, '[data-review="approved"]'));
    q(b, '#review-note').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(q(a, '[data-review="approved"]').dataset.holding).toBe('true');
    expect(q(b, '[data-review="approved"]').dataset.holding).toBe('false');
    await vi.advanceTimersByTimeAsync(HOLD_MS + 100);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(q(a, '[data-review-verdict]').textContent).toBe('Approved');
    expect(q(b, '[data-review-verdict]').textContent).toBe(''); // it reads its own reviews; the page that did not press says nothing it was not told
  });

  it('closing one proposal leaves the other open', () => {
    a.proposal.update({ proposal: null });
    expect(A.state.proposal).toBeNull();
    expect(q(a, '#proposal-bar').hidden).toBe(true);
    expect(q(a, '#review-column').hidden).toBe(true);
    expect(B.state.proposal).not.toBeNull();
    expect(q(b, '#proposal-bar').hidden).toBe(false);
    expect(q(b, '#review-column').hidden).toBe(false);
  });
});

describe('two Work panels in one document (step 6)', () => {
  const NOW = Date.parse('2026-10-19T12:00:00Z');
  const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();
  const ID = (n) => `run-01JC8Z3Q5M7VXK2RT9N4B6HD${String(n).padStart(2, '0')}`;
  const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });
  const pull = (n, title) => ({ number: n, title, state: 'open', draft: false, author: { login: 'agent-four' }, labels: [], head: { ref: `b${n}`, sha: `sha${n}` }, base: { ref: 'main' }, url: `https://git.example.test/pull/${n}`, createdAt: ago(5), updatedAt: ago(4), mergedAt: null });
  const waitingRun = (n) => ({ kind: 'code', profile: null, refs: { issue: n }, open: true, requestedBy: 'maintainer-one', requestedAt: ago(5), via: 'dashboard', limits: null, stopRequested: null, checks: null, pull: null, nodes: [], timeline: [], report: { state: 'waiting', at: ago(1), by: 'r', note: `Plan ${n} ready`, url: null, tokens: null, cost: null }, answer: null, runId: ID(n), status: 'waiting' });
  /** One panel's own server: its own pull requests and its own run, and what it was sent */
  const server = (name, n) => {
    const calls = [];
    const fetch = vi.fn(async (url, init = {}) => {
      const u = new URL(url, 'http://localhost');
      calls.push({ method: init.method || 'GET', path: u.pathname + u.search, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (u.pathname === '/api/agent-runs') return json(200, { ok: true, runs: [waitingRun(n)], open: 1, maxOpen: 10, profiles: [], limits: {} });
      if (u.pathname === '/proposals') return json(200, []);
      if (u.pathname === '/api/forge/pulls') return json(200, { ok: true, at: ago(0.01), rate: '', items: [pull(n, `Pull of ${name}`)] });
      if (u.pathname === `/api/forge/pulls/${n}`) return json(200, { ok: true, at: ago(0.01), rate: '', pull: pull(n, `Pull of ${name}`), files: [], checks: [{ id: 'run:1', name: 'test', state: 'success', url: null, rerunnable: false }] });
      if (u.pathname === `/api/forge/pulls/${n}/merge`) return json(200, { ok: true, merged: true });
      if (u.pathname === `/api/agent-runs/${ID(n)}/answer`) return json(200, { ok: true, run: { ...waitingRun(n), status: 'working', answer: { action: 'continue', at: ago(0), by: 'maintainer-one' } } });
      if (['/api/forge/issues', '/api/forge/threads', '/api/forge/deploys'].includes(u.pathname)) return json(200, { ok: true, at: ago(0.01), rate: '', items: [] });
      return json(404, { ok: false, error: 'No such thing.', code: 'not-found' });
    });
    return { calls, fetch };
  };
  const CONFIG = { forge: { type: 'github', url: 'https://git.example.test', repo: 'owner/name' }, signIn: { login: 'maintainer-one' }, agents: { runs: true } };
  let a; let b; let sa; let sb;
  const q = (one, sel) => one.root.querySelector(sel);
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const panelOn = (name, topology, n) => {
    const srv = server(name, n);
    const one = mount(name, topology, {}, { fetch: srv.fetch });
    const work = workPiece.mount(one.root, one.inst, { config: CONFIG, clock: () => NOW });
    return { ...one, work, srv };
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    a = panelOn('alpha', topologyA(), 21);
    b = panelOn('beta', topologyB(), 22);
    sa = a.srv; sb = b.srv;
    await settle();
  });
  afterEach(() => { a.work.destroy(); b.work.destroy(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('each has its own markup, its own button and its own count, with the same ids twice in the document', () => {
    expect(document.querySelectorAll('#forge-panel')).toHaveLength(2);
    expect(document.querySelectorAll('#forge-btn')).toHaveLength(2);
    expect(q(a, '#forge-btn').hidden).toBe(false);
    expect(q(a, '#forge-btn-waiting')).toBeNull(); // the number is the view switch's, not this button's
    expect(q(a, '#forge-btn').getAttribute('aria-label')).toBe('Work panel');
    for (const one of [a, b]) for (const el of one.root.querySelectorAll('[data-corn]')) expect(el.getAttribute('part'), el.outerHTML.slice(0, 80)).toBe(el.getAttribute('data-corn'));
  });

  it('opening one, switching its tabs and opening a pull request there changes nothing in the other, and each asks only its own server', async () => {
    const before = b.root.innerHTML;
    click(q(a, '#forge-btn'));
    await settle();
    expect(q(a, '#forge-panel').classList.contains('forge-open')).toBe(true);
    expect(q(b, '#forge-panel').classList.contains('forge-open')).toBe(false);
    click(q(a, '[data-forge-kind="pulls"]'));
    await settle();
    expect(q(a, '#forge-list').textContent).toContain('Pull of alpha');
    click(q(a, '[data-forge-pr="21"]'));
    await settle();
    expect(q(a, '#forge-detail').hidden).toBe(false);
    expect(q(a, '#forge-detail').textContent).toContain('Pull of alpha');
    expect(a.state.forgeLit).not.toBeNull();
    expect(b.state.forgeLit).toBeNull();
    expect(b.root.innerHTML).toBe(before);
    expect(sb.calls.filter((c) => c.path.startsWith('/api/forge/pulls'))).toEqual([]);
    expect(sa.calls.some((c) => c.path === '/api/forge/pulls/21')).toBe(true);
    expect(sa.calls.some((c) => c.path.includes('22'))).toBe(false);
  });

  it('the confirm step of one is the one\'s: it holds the focus there, and the other has none open', async () => {
    click(q(a, '#forge-btn'));
    click(q(b, '#forge-btn'));
    click(q(a, '[data-forge-kind="pulls"]'));
    await settle();
    click(q(a, '[data-forge-pr="21"]'));
    await settle();
    click(q(a, '[data-forge-merge]'));
    expect(q(a, '#forge-confirm').hidden).toBe(false);
    expect(q(b, '#forge-confirm').hidden).toBe(true);
    expect(a.inst.active()).toBe(q(a, '[data-action="forge-confirm-cancel"]'));
    // a focus that lands elsewhere in A's root is brought back, and so is one in B's: B is behind A's scrim like the rest of the page
    q(a, '#forge-title').focus();
    expect(a.inst.active()).toBe(q(a, '[data-action="forge-confirm-cancel"]'));
    q(b, '#forge-title').focus();
    expect(a.inst.active()).toBe(q(a, '[data-action="forge-confirm-cancel"]'));
    expect(b.inst.active()).toBe(null);
    q(a, '#forge-confirm').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(q(a, '#forge-confirm').hidden).toBe(true);
    expect(sa.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('answering a waiting run in one sends one answer to its server and leaves the other\'s run waiting', async () => {
    click(q(a, '#forge-btn'));
    click(q(a, '[data-forge-kind="work"]'));
    await settle();
    expect(q(a, '#forge-runs-list').textContent).toContain('Plan 21 ready');
    expect(q(b, '[data-forge-kind="work"] .hx-forge-count').textContent).toBe('1');
    click(q(a, `[data-run-answer="continue"][data-run-id="${ID(21)}"]`));
    await settle();
    expect(sa.calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body])).toEqual([[`/api/agent-runs/${ID(21)}/answer`, { action: 'continue' }]]);
    expect(sb.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(q(b, '#forge-runs-list').textContent).not.toContain('Plan 22');
  });

  it('each says what waits in its own words, and a host\'s words for one are not the other\'s', () => {
    a.inst.strings.issuesAndPrs = 'Tasks';
    a.work.update({ config: CONFIG });
    expect(a.inst.strings.issuesAndPrs).toBe('Tasks');
    expect(b.inst.strings.issuesAndPrs).toBeUndefined();
  });
});

describe('the pieces with no Work panel beside them (a review mounts none)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('the node panel shows no Threads and no Start a run, the bar no Answer, the account menu its Proposals entry, and nothing throws', async () => {
    const one = mount('lone', topologyA());
    const panel = nodePanel.mount(one.root, one.inst);
    const bar = proposalPiece.mount(one.root, one.inst);
    Object.assign(one.state, { proposal: { title: 'x' }, proposalSlug: '0042-x', proposalSource: 'pull/42' });
    selectNode(one.inst, one.state.nodes[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(one.root.querySelector('#drawer-threads').textContent.trim()).toBe('');
    expect(one.root.querySelector('[data-thread-open], [data-thread-start]')).toBe(null);
    expect(one.root.querySelector('#drawer-run-btn').hidden).toBe(true);
    one.inst.emit('proposal:bar', { open: true });
    const answer = one.root.querySelector('[data-waiting-answer]');
    expect(!answer || !!answer.closest('[hidden]')).toBe(true);
    expect(one.root.querySelector('#proposal-wrap').hidden).toBe(false);
    // what the Work panel would hear is said to nobody
    expect(() => {
      one.inst.emit('thread:open', { number: 5 });
      one.inst.emit('thread:start', { node: one.state.nodes[0] });
      one.inst.emit('work:answer', { run: 'run-x' });
      one.inst.emit('threads:ensure');
      one.inst.emit('forge:start', { slug: '0042-x', returnTo: '#drawer-run-btn' });
    }).not.toThrow();
    expect(one.inst.ask('work:on')).toBeUndefined();
    bar.destroy();
    panel.destroy();
    one.inst.destroy();
  });
});

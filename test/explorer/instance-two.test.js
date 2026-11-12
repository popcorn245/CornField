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
function mount(name, topology, tokens = {}) {
  const root = document.createElement('div');
  root.id = `root-${name}`;
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
  root.innerHTML = '<div class="hx-stage"><canvas id="graph-canvas"></canvas><canvas id="label-canvas"></canvas></div>';
  document.body.append(root);
  const inst = createInstance({ root });
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
      'active', 'ask', 'base', 'destroy', 'doc', 'dpr', 'el', 'emit', 'fetch', 'hidden', 'listen', 'on', 'onSceneTouch', 'onShown', 'own', 'reducedMotion',
      'release', 'root', 'setSelection', 'slot', 'state', 'store', 'strings', 'tokenElement', 'tokenReader', 'touchScene', 'url', 'viewEdges', 'win',
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

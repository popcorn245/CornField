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
import { mapStyleOf, styledScene } from '../../explorer/engine/map-style.js';
// @ts-expect-error plain JS modules, no declarations
import { state as pageState } from '../../explorer/state.js';

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

  it('a change of style in one instance draws that map again and not the other', () => {
    const seenA = vi.fn();
    const seenB = vi.fn();
    A.inst.on('mapstyle', seenA);
    B.inst.on('mapstyle', seenB);
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

  it('a fetch is bound to the instance\'s base', async () => {
    const calls = [];
    const inst = createInstance({ root: document.body, base: 'https://map.example.test', fetch: (u, init) => { calls.push([u, init]); return Promise.resolve({ ok: true }); } });
    await inst.fetch('/cornfield/config.json', { credentials: 'include' });
    await inst.fetch('https://other.test/x');
    expect(calls).toEqual([['https://map.example.test/cornfield/config.json', { credentials: 'include' }], ['https://other.test/x', undefined]]);
  });
});

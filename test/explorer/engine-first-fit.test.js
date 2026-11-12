// @vitest-environment happy-dom
/**
 * Issue #253: on a fresh load the map was drawn off to the top left, fitted to a stage that was not final yet (an embedded pane sized after the page began to
 * load), and never corrected itself. The rule the engine holds (explorer/engine/render.js `fitGraphToViewport`, `resize`): while the map has its nodes and
 * the camera is still where the last fit put it, a box that becomes known or changes is fitted again; once the camera has moved, a new box keeps the view.
 * A fit asked for with no box waits for one. A map that loaded hidden reads its box again when it is shown. The map piece (so `<corn-map>` and
 * `<corn-review>`) and the page's own calls (view.js) share it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadSample } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { mount } from '../../explorer/pieces/map.js';

const sample = loadSample();
const topology = () => ({ nodes: structuredClone(sample.nodes), edges: structuredClone(sample.edges) });
const ctx2d = new Proxy({}, { get: (t, k) => (k === 'measureText' ? (text) => ({ width: String(text).length * 6 }) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });

let restore = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  const realGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) { return type === '2d' ? ctx2d : null; };
  restore.push(() => { HTMLCanvasElement.prototype.getContext = realGet; });
});
afterEach(() => {
  restore.forEach((fn) => fn());
  restore = [];
  document.body.innerHTML = '';
  delete document.hidden;
  delete document.visibilityState;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A map in a stage whose box the test sets (what a layout would give it); `size.resize()` is what a ResizeObserver's callback does */
function make(size, options = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const piece = mount(host.attachShadow({ mode: 'open' }), null, { renderer: 'canvas2d', ...options });
  const { state } = piece.inst;
  const stage = state.canvas.parentElement;
  Object.defineProperty(stage, 'clientWidth', { get: () => size.w, configurable: true });
  Object.defineProperty(stage, 'clientHeight', { get: () => size.h, configurable: true });
  return { piece, state, map: piece.map, camera: () => ({ ...state.camera }) };
}
const frames = () => vi.advanceTimersByTime(64);
/** What an explicit fit to the box as it is now would set: the camera the map must have */
const wanted = (piece, state) => { const keep = { ...state.camera }; piece.fit(); const fitted = { ...state.camera }; Object.assign(state.camera, keep); return fitted; };

describe('the first fit follows the box (issue #253)', () => {
  it('a topology that arrives before the stage has a box is fitted when the box arrives, not to nothing', () => {
    const size = { w: 0, h: 0 };
    const { piece, state, map, camera } = make(size, { topology: topology() });
    expect(camera()).toEqual({ x: 0, y: 0, zoom: 1 }); // nothing was fitted to a box of no size
    size.w = 1024; size.h = 716;
    map.resize(); // the observer's callback
    frames();
    expect(camera()).toEqual(wanted(piece, state));
    expect(state.camera.zoom).toBeLessThan(1);
    expect(state.camera.x).toBeGreaterThan(100); // centred in 1024, not at the left edge
  });

  it('a box that grows after the first fit, before anyone moved the camera, fits the map again', () => {
    const size = { w: 300, h: 150 };
    const { piece, state, map, camera } = make(size, { topology: topology() });
    map.resize();
    const small = camera();
    size.w = 1024; size.h = 716;
    map.resize();
    expect(camera()).not.toEqual(small);
    expect(camera()).toEqual(wanted(piece, state));
  });

  it('the padding is the new box\'s (a phone-wide box first, then a wide one)', () => {
    const size = { w: 400, h: 600 };
    const { piece, state, map, camera } = make(size, { topology: topology() });
    map.resize();
    size.w = 1200;
    map.resize();
    expect(camera()).toEqual(wanted(piece, state));
  });

  it('a map that loaded hidden, with no box, is fitted when it is shown (a page in a background tab, a pane not shown yet)', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const size = { w: 0, h: 0 };
    const { piece, state, camera } = make(size, { topology: topology() });
    frames();
    expect(camera()).toEqual({ x: 0, y: 0, zoom: 1 });
    size.w = 1024; size.h = 716; // the box is laid out while no frame runs and no observer reports
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    frames();
    expect(camera()).toEqual(wanted(piece, state));
    expect(state.width).toBe(1024);
  });

  it('once the person has panned or zoomed, a new box keeps their view (as 0.46.1 does)', () => {
    const size = { w: 800, h: 600 };
    const { state, map, camera } = make(size, { topology: topology() });
    map.resize();
    state.camera.x += 120; state.camera.y -= 40; // a pan
    const panned = camera();
    size.w = 1000; size.h = 500;
    map.resize();
    expect(camera()).toEqual(panned);
    state.camera.zoom *= 1.5; // a zoom
    const zoomed = camera();
    size.w = 640; size.h = 640;
    map.resize();
    expect(camera()).toEqual(zoomed);
  });

  it('a box of the same size changes nothing, and an explicit fit is made at once when there is a box', () => {
    const size = { w: 800, h: 600 };
    const { piece, state, map, camera } = make(size, { topology: topology() });
    map.resize();
    const before = camera();
    map.resize();
    expect(camera()).toEqual(before);
    state.camera.x += 10;
    piece.fit();
    expect(camera()).toEqual(before);
  });

  it("cornfield's own page calls the engine's fit itself (view.js): the same rule, with the page's padding", () => {
    const size = { w: 0, h: 0 };
    const { piece, state, map, camera } = make(size);
    state.nodes = structuredClone(sample.nodes).map((n, i) => ({ ...n, x: (i % 10) * 90, y: Math.floor(i / 10) * 90, r: 20 }));
    map.fitGraphToViewport(map.fitPadding()); // loadTopology: before the stage has its box
    expect(camera()).toEqual({ x: 0, y: 0, zoom: 1 });
    size.w = 1024; size.h = 716;
    map.resize();
    expect(camera()).toEqual(wanted(piece, state));
    expect(state.camera.x).not.toBe(0);
  });
});

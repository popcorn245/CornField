// @vitest-environment happy-dom
/**
 * Spec 0011 D2/D3: `inst.destroy()` takes back everything the map set up. A map is made and destroyed 50 times in one document; at the
 * end no listener, observer or timer is left, no frame is waiting, every WebGL context it took has been released, and nothing in the
 * instance answers any more. Without destroy() the same loop leaves them all behind (the second test shows the test can fail).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeGl } from './fake-gl.js';
// @ts-expect-error plain JS modules, no declarations
import { createInstance } from '../../explorer/instance.js';
// @ts-expect-error plain JS modules, no declarations
import { createMap } from '../../explorer/engine/render.js';
// @ts-expect-error plain JS modules, no declarations
import { createRenderer } from '../../explorer/renderer.js';
// @ts-expect-error plain JS modules, no declarations
import { mapStyleOf } from '../../explorer/engine/map-style.js';
// @ts-expect-error plain JS modules, no declarations
import { bindCanvasInput } from '../../explorer/input.js';

const protoWith = (obj, key) => { let p = obj; while (p && !Object.prototype.hasOwnProperty.call(p, key)) p = Object.getPrototypeOf(p); return p; };

/** What is live right now: listeners (target, type, function, options), observers, media-query listeners, GL contexts */
const live = { listeners: new Set(), resize: 0, mutation: 0, media: 0, contexts: 0, lost: 0 };
const ids = new WeakMap();
let nextId = 0;
const idOf = (o) => { if (!ids.has(o)) ids.set(o, ++nextId); return ids.get(o); };
const keyOf = (target, type, fn, opts) => `${idOf(target)}|${type}|${idOf(fn)}|${typeof opts === 'object' && opts ? !!opts.capture : !!opts}`;

let restore = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  Object.assign(live, { listeners: new Set(), resize: 0, mutation: 0, media: 0, contexts: 0, lost: 0 });

  const proto = protoWith(document.body, 'addEventListener');
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  proto.addEventListener = function (type, fn, opts) { if (fn) live.listeners.add(keyOf(this, type, fn, opts)); return add.call(this, type, fn, opts); };
  proto.removeEventListener = function (type, fn, opts) { if (fn) live.listeners.delete(keyOf(this, type, fn, opts)); return remove.call(this, type, fn, opts); };
  restore.push(() => { proto.addEventListener = add; proto.removeEventListener = remove; });

  vi.stubGlobal('ResizeObserver', class { constructor() { this.on = false; } observe() { if (!this.on) { this.on = true; live.resize++; } } disconnect() { if (this.on) { this.on = false; live.resize--; } } unobserve() {} });
  window.ResizeObserver = globalThis.ResizeObserver;
  const RealMutation = window.MutationObserver;
  window.MutationObserver = class extends RealMutation {
    observe(...a) { if (!this.on) { this.on = true; live.mutation++; } return super.observe(...a); }
    disconnect() { if (this.on) { this.on = false; live.mutation--; } return super.disconnect(); }
  };
  restore.push(() => { window.MutationObserver = RealMutation; });
  const realMatch = window.matchMedia;
  window.matchMedia = () => ({ matches: false, addEventListener() { live.media++; }, removeEventListener() { live.media--; } });
  restore.push(() => { window.matchMedia = realMatch; });
});

afterEach(() => {
  restore.forEach((fn) => fn());
  restore = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A canvas whose WebGL2 context is a fake one that counts the contexts taken and given back */
function glCanvas(canvas) {
  const gl = fakeGl();
  const lose = { loseContext: () => { live.lost++; } };
  const wrapped = new Proxy(gl, { get: (t, k) => (k === 'getExtension' ? (n) => (n === 'WEBGL_lose_context' ? lose : null) : t[k]) });
  canvas.getContext = (type) => { if (type !== 'webgl2') return null; live.contexts++; return wrapped; };
  return wrapped;
}

/** One map as a page or a component would make it: a root, an instance, the map, input, the style watch, a WebGL renderer */
function make() {
  const root = document.createElement('div');
  root.innerHTML = '<div class="hx-stage"><canvas id="graph-canvas"></canvas><canvas id="label-canvas"></canvas></div>';
  document.body.append(root);
  const inst = createInstance({ root });
  const canvas = inst.el('graph-canvas');
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 800 });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 600 });
  glCanvas(canvas);
  const labelCanvas = inst.el('label-canvas');
  const ctx2d = new Proxy({}, { get: (t, k) => (k === 'measureText' ? (text) => ({ width: String(text).length * 6 }) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  labelCanvas.getContext = () => ctx2d;
  Object.assign(inst.state, {
    canvas,
    labelCanvas,
    nodes: [{ id: 'a', type: 'app', label: 'a', x: 10, y: 10, r: 20, color: '#336699' }, { id: 'b', type: 'page', label: 'b', x: 90, y: 40, r: 20, color: '#336699' }],
    edges: [{ from: 'a', to: 'b', kind: 'flow', flow: 'api' }],
  });
  const map = createMap(inst);
  const style = mapStyleOf(inst);
  style.watch();
  map.setRenderer(createRenderer(canvas, { mapStyle: style.get }));
  inst.on('select', () => {});
  bindCanvasInput(inst);
  map.watchSize();
  map.resize();
  map.addFrameClient({ wants: () => true, tick() {} }); // something that asks for frames for ever, as the scenario player does while it plays
  map.fitGraphToViewport();
  vi.advanceTimersByTime(40); // a frame or two runs
  return { inst, map, root, canvas };
}

const snapshot = () => ({ listeners: live.listeners.size, resize: live.resize, mutation: live.mutation, media: live.media, timers: vi.getTimerCount(), contexts: live.contexts - live.lost });

describe('inst.destroy()', () => {
  it('a map has things to take back: listeners, observers, a frame waiting, a GL context', () => {
    const one = make();
    const s = snapshot();
    expect(s.listeners).toBeGreaterThan(8);
    expect(s.resize).toBe(1);
    expect(s.mutation).toBe(1);
    expect(s.media).toBe(1);
    expect(s.timers).toBeGreaterThan(0);
    expect(s.contexts).toBe(1);
    one.inst.destroy();
  });

  it('made and destroyed 50 times, leaves no listener, observer, timer or context behind', () => {
    const before = snapshot();
    expect(before).toMatchObject({ resize: 0, mutation: 0, media: 0, timers: 0, contexts: 0 });
    for (let i = 0; i < 50; i++) {
      const { inst, root } = make();
      inst.destroy();
      root.remove();
    }
    expect(snapshot()).toEqual(before);
    expect(live.contexts).toBe(50); // 50 contexts were taken ...
    expect(live.lost).toBe(50); // ... and each was given back
  });

  it('is what does it: 50 maps made and not destroyed leave all of it behind', () => {
    for (let i = 0; i < 50; i++) make();
    const s = snapshot();
    expect(s.listeners).toBeGreaterThan(50 * 8);
    expect(s.resize).toBe(50);
    expect(s.mutation).toBe(50);
    expect(s.contexts).toBe(50);
    expect(s.timers).toBeGreaterThan(0);
  });

  it('a renderer swapped on the same canvas keeps the canvas\'s context alive; only the end of the map gives it back', () => {
    const { inst, map, canvas } = make();
    const gl = canvas.getContext('webgl2'); // the one context the canvas hands out, to every renderer made on it
    const drawsBefore = gl.log.filter((c) => c[0].startsWith('draw')).length;
    map.setRenderer(createRenderer(canvas, { mapStyle: mapStyleOf(inst).get })); // a renderer switch: the old one is destroyed
    expect(live.lost).toBe(0); // a context lost on purpose could never be had again from this canvas: the new renderer would draw nothing
    map.renderNow();
    expect(gl.log.filter((c) => c[0].startsWith('draw')).length).toBeGreaterThan(drawsBefore);
    inst.destroy();
    expect(live.lost).toBe(1);
  });

  it('is safe to call twice, and after it nothing answers: no frame, no event, no draw', () => {
    const { inst, map, canvas } = make();
    const draws = vi.fn();
    map.onPaint(draws);
    inst.destroy();
    inst.destroy();
    expect(inst.destroyed).toBe(true);
    const frames = map.frameStats().frames;
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 20, bubbles: true }));
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(1000);
    expect(map.frameStats().frames).toBe(frames);
    expect(draws).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('what arrives after it (a theme icon still loading) draws nothing and asks for no frame', async () => {
    const { inst, map } = make();
    let arrive;
    const redraws = vi.fn(() => map.render());
    mapStyleOf(inst).onChange(redraws); // as the page shell does: a change of style draws again
    mapStyleOf(inst).setIcons({ icons: { app: '/cornfield/theme/assets/app.png' } }, { load: () => new Promise((res) => { arrive = res; }) });
    await Promise.resolve();
    vi.advanceTimersByTime(40);
    const frames = map.frameStats().frames;
    const contexts = live.contexts;
    inst.destroy();
    expect(vi.getTimerCount()).toBe(0);
    arrive({ width: 8, height: 8, naturalWidth: 8, naturalHeight: 8 }); // the image comes in after the map has ended
    await Promise.resolve();
    await Promise.resolve();
    map.render(); // and a module that is not told calls the map
    map.ensureFlowLoop();
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
    expect(map.frameStats().frames).toBe(frames);
    expect(live.contexts).toBe(contexts); // no renderer made again on the ended canvas
    expect(redraws).toHaveBeenCalledTimes(1); // when setIcons started, not when the image arrived
  });

  it('a frame reads the style without asking the instance for it (no slot lookup on the draw path)', () => {
    const { inst, map } = make();
    const slot = vi.spyOn(inst, 'slot');
    for (let i = 0; i < 10; i++) { map.fitGraphToViewport(20 + i); map.renderNow(); }
    expect(slot).not.toHaveBeenCalled();
    inst.destroy();
  });

  it('runs every clean-up it was given, last first, and one that throws does not stop the rest', () => {
    const inst = createInstance({ root: document.body });
    const order = [];
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    inst.own(() => order.push('first'));
    inst.own(() => { throw new Error('a clean-up failed'); });
    inst.own(() => order.push('third'));
    inst.destroy();
    expect(order).toEqual(['third', 'first']);
    expect(quiet).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });
});

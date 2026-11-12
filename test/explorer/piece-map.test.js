// @vitest-environment happy-dom
/**
 * Spec 0011 D3: the map as a piece (explorer/pieces/map.js). It makes its own elements, sets the instance's map up, tells the host when the selection
 * changes, and ends completely: made and destroyed 30 times it leaves no element, listener, observer, timer or WebGL context. The traps of the step
 * (STEP2NOTE) each have a test: a drag released outside the root, theme icons from another origin, a theme change, freeform positions, a canvas never reused.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fakeGl } from './fake-gl.js';
import { loadSample, MAP_ELEMENTS_HTML, EXPLORER } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { mount } from '../../explorer/pieces/map.js';
// @ts-expect-error plain JS modules, no declarations
import { createInstance } from '../../explorer/instance.js';

const sample = loadSample();
const topology = () => ({ nodes: structuredClone(sample.nodes), edges: structuredClone(sample.edges) });
const ctx2d = new Proxy({}, { get: (t, k) => (k === 'measureText' ? (text) => ({ width: String(text).length * 6 }) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });

/** What is live right now: listeners (target, type, function, options), observers, media-query listeners, GL contexts */
const live = { listeners: new Set(), resize: 0, mutation: 0, media: 0, contexts: 0, lost: 0 };
const ids = new WeakMap();
let nextId = 0;
const idOf = (o) => { if (!ids.has(o)) ids.set(o, ++nextId); return ids.get(o); };
const keyOf = (target, type, fn, opts) => `${idOf(target)}|${type}|${idOf(fn)}|${typeof opts === 'object' && opts ? !!opts.capture : !!opts}`;
const protoWith = (obj, key) => { let p = obj; while (p && !Object.prototype.hasOwnProperty.call(p, key)) p = Object.getPrototypeOf(p); return p; };
let restore = [];
let useGl = false;
let stored = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  Object.assign(live, { listeners: new Set(), resize: 0, mutation: 0, media: 0, contexts: 0, lost: 0 });
  stored = [];
  useGl = false;

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

  // Every canvas the piece makes: a WebGL2 context that counts, or a 2d one
  const realGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) {
    if (type === '2d') return ctx2d;
    if (type === 'webgl2' && useGl) {
      if (this.__gl) return this.__gl;
      const gl = fakeGl();
      const lose = { loseContext: () => { live.lost++; } };
      live.contexts++;
      this.__gl = new Proxy(gl, { get: (t, k) => (k === 'getExtension' ? (n) => (n === 'WEBGL_lose_context' ? lose : null) : t[k]) });
      return this.__gl;
    }
    return null;
  };
  restore.push(() => { HTMLCanvasElement.prototype.getContext = realGet; });
  const realSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) { stored.push(k); return realSet.call(this, k, v); };
  restore.push(() => { Storage.prototype.setItem = realSet; });
});

afterEach(() => {
  restore.forEach((fn) => fn());
  restore = [];
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const SIZE = { width: 800, height: 600 };
/** A host element with the box a layout would give it, and the piece in it */
function make(options = {}, { shadow = true, inst = null } = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = shadow ? host.attachShadow({ mode: 'open' }) : host;
  const piece = mount(root, inst, { renderer: 'canvas2d', ...options });
  const stage = piece.inst.state.canvas.parentElement;
  Object.defineProperty(stage, 'clientWidth', { value: SIZE.width, configurable: true });
  Object.defineProperty(stage, 'clientHeight', { value: SIZE.height, configurable: true });
  piece.inst.state.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: SIZE.width, bottom: SIZE.height, width: SIZE.width, height: SIZE.height, x: 0, y: 0, toJSON() {} });
  piece.map.resize();
  return { host, root, piece, state: piece.inst.state, canvas: piece.inst.state.canvas };
}
const frames = (n = 3) => vi.advanceTimersByTime(16 * n);
const key = (el, k, init = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, composed: true, ...init }));

describe('its elements', () => {
  it('makes a stage, the map canvas (named, focusable, described), its keys help, an announcer and the label canvas, in the root it is given', () => {
    const { root, canvas } = make({ topology: topology() });
    const stage = root.querySelector('[data-corn="map-stage"]');
    expect(stage).toBeTruthy();
    expect(canvas.parentElement).toBe(stage);
    expect(canvas.getAttribute('aria-label')).toBe('Topology map');
    expect(canvas.getAttribute('role')).toBe('application');
    expect(canvas.getAttribute('tabindex')).toBe('0');
    expect(root.querySelector(`#${canvas.getAttribute('aria-describedby')}`)?.textContent).toMatch(/Arrow keys pan/);
    expect(root.querySelector('#map-announcer').getAttribute('aria-live')).toBe('polite');
    expect(root.querySelector('[data-corn="label-canvas"]').getAttribute('aria-hidden')).toBe('true');
  });

  it('gives every element with a data-corn hook a part of the same name (D7), for the stage and for the page', () => {
    for (const shadow of [true, false]) {
      const { root } = make({ topology: topology() }, { shadow });
      const hooked = [...root.querySelectorAll('[data-corn]')];
      expect(hooked.length).toBeGreaterThanOrEqual(3);
      for (const el of hooked) expect(el.getAttribute('part'), el.outerHTML).toBe(el.getAttribute('data-corn'));
    }
  });

  it('holds the part rule for every file in explorer/pieces: a data-corn is only ever written with its part', () => {
    const dir = path.join(EXPLORER, 'pieces');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    expect(files).toContain('map.js');
    for (const f of files) {
      const code = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const dataCorn = (code.match(/['"]data-corn['"]|\bdata-corn=/g) || []).length;
      const parts = (code.match(/['"]part['"]|\bpart=/g) || []).length;
      expect(parts, `${f} writes ${dataCorn} data-corn and ${parts} part`).toBeGreaterThanOrEqual(dataCorn);
    }
  });

  it('in the page (no stage of its own) makes exactly the elements index.html used to hold, in that order', () => {
    const { root } = make({ stage: false, keysHelp: "Arrow keys pan, plus and minus zoom, 0 fits the map. N and P select the next and the previous node, Home and End the first and the last. F frames the selected node and what it lights. Enter goes to the selected node's panel, Escape closes it. In Freeform, Alt and an arrow moves the selected node." }, { shadow: false });
    const holder = document.createElement('div');
    holder.innerHTML = MAP_ELEMENTS_HTML;
    const names = (el) => [...el.children].map((c) => `${c.tagName}#${c.id}|${c.getAttribute('data-corn')}|${c.getAttribute('class')}|${c.getAttribute('role')}`);
    expect(names(root)).toEqual(names(holder));
    expect(root.querySelector('#map-keys-help').textContent).toBe(holder.querySelector('#map-keys-help').textContent);
  });

  it('leaves the host\'s topology alone: the map works on copies', () => {
    const t = topology();
    const before = JSON.stringify(t);
    make({ topology: t });
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe('the map', () => {
  it('lays out and draws a topology, and the data-flow view lays it out again', () => {
    const { piece, state } = make({ topology: topology() });
    expect(state.nodes.length).toBe(sample.nodes.length);
    expect(state.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    const orbit = state.nodes.map((n) => [n.x, n.y].join());
    piece.update({ view: 'dataflow' });
    expect(state.view).toBe('dataflow');
    expect(state.flow.tiers.some((t) => t.nodes.length)).toBe(true);
    const flowed = state.flow.tiers.flatMap((t) => t.nodes).map((n) => [n.x, n.y].join());
    expect(flowed.some((p) => !orbit.includes(p))).toBe(true);
    piece.update({ view: 'map' });
    expect(state.nodes.map((n) => [n.x, n.y].join())).toEqual(orbit);
  });

  it('says it is ready once, after the first frame with a map in it is drawn', () => {
    const onReady = vi.fn();
    const { piece } = make({ onReady });
    frames();
    expect(onReady).not.toHaveBeenCalled(); // nothing to draw yet
    piece.update({ topology: topology() });
    frames();
    expect(onReady).toHaveBeenCalledTimes(1);
    piece.update({ topology: topology() });
    frames();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('is two maps with nothing in common when two pieces are mounted in one document', () => {
    const a = make({ topology: topology() });
    const b = make({ topology: { nodes: sample.nodes.slice(0, 5).map((n) => ({ ...n })), edges: [] } });
    const first = a.state.nodes[3];
    a.piece.update({ node: first.id });
    expect(a.state.selectedNode.id).toBe(first.id);
    expect(b.state.selectedNode).toBe(null);
    expect(b.state.nodes.length).toBe(5);
    expect(a.state.nodes.length).toBe(sample.nodes.length);
  });
});

describe('selection: onSelect comes from the real change of selection', () => {
  it('fires for a key, a property, focusNode, a tap and a click on the background, once for each change, and not for what changes nothing', () => {
    const onSelect = vi.fn();
    const { piece, canvas, state } = make({ topology: topology(), onSelect });
    const ids = state.nodes.map((n) => n.id);

    key(canvas, 'n'); // the keyboard selects the first node in reading order
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ kind: 'node' });
    const first = onSelect.mock.calls[0][0].id;
    expect(state.selectedNode.id).toBe(first);

    const other = ids.find((id) => id !== first);
    piece.update({ node: other }); // the host sets the node
    expect(onSelect).toHaveBeenLastCalledWith({ id: other, kind: 'node' });
    piece.update({ node: other }); // the same again: nothing changed
    expect(onSelect).toHaveBeenCalledTimes(2);

    expect(piece.focusNode(first)).toBe(true);
    expect(onSelect).toHaveBeenLastCalledWith({ id: first, kind: 'node' });
    expect(piece.focusNode('no-such-node')).toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(3);

    piece.inst.emit('background'); // a tap on the bare map
    expect(onSelect).toHaveBeenLastCalledWith({ id: null, kind: 'node' });
    piece.inst.emit('select', state.nodes[2]); // a tap on a node
    expect(onSelect).toHaveBeenLastCalledWith({ id: state.nodes[2].id, kind: 'node' });
    key(canvas, 'Escape');
    expect(onSelect).toHaveBeenLastCalledWith({ id: null, kind: 'node' });
    expect(onSelect).toHaveBeenCalledTimes(6);
  });

  it('a node set before the topology arrives is selected when it does', () => {
    const onSelect = vi.fn();
    const { piece, state } = make({ onSelect, node: sample.nodes[4].id });
    expect(onSelect).not.toHaveBeenCalled();
    piece.update({ topology: topology() });
    expect(state.selectedNode.id).toBe(sample.nodes[4].id);
    expect(onSelect).toHaveBeenCalledWith({ id: sample.nodes[4].id, kind: 'node' });
  });

  it('does not take a tap for the host when handleTaps is off (cornfield\'s page decides what a tap means)', () => {
    const { piece, state } = make({ topology: topology(), handleTaps: false });
    piece.inst.emit('select', state.nodes[1]);
    expect(state.selectedNode).toBe(null);
  });

  it('the keys act on the canvas only: a key anywhere else in the root does nothing, and a handled key is marked as handled', () => {
    const { canvas, root, state } = make({ topology: topology() });
    const x = state.camera.x;
    const outside = root.querySelector('#map-announcer');
    key(outside, 'ArrowLeft');
    expect(state.camera.x).toBe(x);
    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    canvas.dispatchEvent(event);
    expect(state.camera.x).not.toBe(x);
    expect(event.defaultPrevented).toBe(true);
    const typing = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true });
    canvas.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false); // a browser shortcut is left alone
  });
});

describe('what a map in another app needs (the traps)', () => {
  it('a drag released outside the root ends: a mouse press on the canvas takes pointer capture, in a shadow root and not in the page', () => {
    const { canvas } = make({ topology: topology() });
    canvas.setPointerCapture = vi.fn();
    const down = new Event('pointerdown', { bubbles: true });
    Object.assign(down, { pointerType: 'mouse', pointerId: 7 });
    canvas.dispatchEvent(down);
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(7);
    const touch = new Event('pointerdown', { bubbles: true });
    Object.assign(touch, { pointerType: 'touch', pointerId: 8 });
    canvas.dispatchEvent(touch);
    expect(canvas.setPointerCapture).toHaveBeenCalledTimes(1); // a touch is captured by the browser already

    const page = make({ stage: false }, { shadow: false, inst: createInstance({ root: document }) });
    page.canvas.setPointerCapture = vi.fn();
    page.canvas.dispatchEvent(down);
    expect(page.canvas.setPointerCapture).not.toHaveBeenCalled(); // the page hears the release anywhere on the document
    page.piece.destroy();
    page.piece.inst.destroy();
  });

  it('theme icons are fetched with CORS when the instance has a base (another origin), and as before without one', async () => {
    const made = [];
    vi.stubGlobal('Image', class { constructor() { made.push(this); } set src(v) { this._src = v; } get src() { return this._src; } });
    const icons = { icons: { app: '/cornfield/theme/assets/app.png' } };
    const withBase = make({ base: 'https://map.example.com' });
    withBase.piece.applyTheme(icons);
    await vi.advanceTimersByTimeAsync(5);
    expect(made).toHaveLength(1);
    expect(made[0].crossOrigin).toBe('anonymous');
    expect(made[0].src).toBe('https://map.example.com/cornfield/theme/assets/app.png');
    const plain = make({});
    plain.piece.applyTheme(icons);
    await vi.advanceTimersByTimeAsync(5);
    expect(made).toHaveLength(2);
    expect(made[1].crossOrigin).toBeUndefined();
  });

  it('a change of theme reads the tokens again and draws for the new ground', () => {
    const { host, piece, state } = make({ topology: topology() });
    expect(state.theme).toBe('dark');
    host.style.setProperty('--corn-map-node-app', 'rgb(1, 2, 3)');
    const drawn = state.sceneVersion;
    piece.update({ theme: 'light' });
    expect(state.theme).toBe('light');
    expect(state.sceneVersion).toBeGreaterThan(drawn);
    host.style.setProperty('--corn-map-node-app', 'rgb(9, 9, 9)');
    piece.refresh(); // a change the style cannot see
    expect(piece.inst.map).toBe(piece.map);
    piece.update({ theme: 'auto' });
    expect(state.theme).toBe('dark');
    document.documentElement.setAttribute('data-theme', 'light'); // the page's own switch, with no theme on the element
    piece.refresh();
    expect(state.theme).toBe('light');
    piece.update({ theme: 'dark' });
    expect(state.theme).toBe('dark'); // forced: the page's mode does not matter
  });

  it('stores nothing: freeform positions have no key shared with another map', () => {
    const { piece, canvas, state } = make({ topology: topology() });
    key(canvas, 'n');
    key(canvas, 'ArrowLeft', { altKey: true }); // freeform's move, which a map without freeform does not take
    piece.update({ view: 'dataflow' });
    piece.update({ view: 'map' });
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 5, clientY: 5, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('mouseup', { clientX: 50, clientY: 50, bubbles: true }));
    expect(stored).toEqual([]);
    expect(state.isFreeform).toBe(false);
  });

  it('a changed renderer gets a new canvas (a canvas that gave WebGL cannot give 2d) and gives the old context back', () => {
    useGl = true;
    const { piece, canvas, root } = make({ topology: topology(), renderer: 'auto' });
    expect(live.contexts).toBe(1);
    piece.update({ renderer: 'canvas2d' });
    const now = piece.inst.state.canvas;
    expect(now).not.toBe(canvas);
    expect(root.contains(canvas)).toBe(false);
    expect(root.querySelectorAll('[data-corn="map-canvas"]')).toHaveLength(1);
    expect(live.lost).toBe(1);
    key(now, 'n'); // the new canvas has its input
    expect(piece.inst.state.selectedNode).not.toBe(null);
    piece.update({ renderer: 'auto' });
    expect(live.contexts).toBe(2);
  });
});

describe('its end', () => {
  const snapshot = () => ({ listeners: live.listeners.size, resize: live.resize, mutation: live.mutation, media: live.media, timers: vi.getTimerCount(), contexts: live.contexts - live.lost, docChildren: document.body.childElementCount });

  it('mounted and destroyed 30 times leaves no element, listener, observer, timer or WebGL context, and a canvas is never given again', () => {
    useGl = true;
    const before = snapshot();
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const { piece, root, host, canvas } = make({ topology: topology(), renderer: 'auto' });
      expect(seen.has(canvas)).toBe(false);
      seen.add(canvas);
      frames();
      piece.update({ node: sample.nodes[1].id });
      piece.destroy();
      expect(root.childElementCount).toBe(0);
      host.remove();
    }
    expect(snapshot()).toEqual(before);
    expect(live.contexts).toBe(30);
    expect(live.lost).toBe(30);
  });

  it('is what does it: 30 pieces never destroyed leave it all behind', () => {
    useGl = true;
    for (let i = 0; i < 30; i++) make({ topology: topology(), renderer: 'auto' });
    const s = snapshot();
    expect(s.listeners).toBeGreaterThan(30 * 5);
    expect(s.resize).toBe(30);
    expect(s.contexts).toBe(30);
  });

  it('destroys the instance it made, and only that one: a page\'s instance goes on after its piece', () => {
    const made = make({ topology: topology() });
    const spy = vi.spyOn(made.piece.inst, 'destroy');
    made.piece.destroy();
    expect(spy).toHaveBeenCalledTimes(1);
    made.piece.destroy(); // twice is safe
    expect(spy).toHaveBeenCalledTimes(1);

    const mine = createInstance({ root: document });
    const page = make({ stage: false }, { shadow: false, inst: mine });
    const own = vi.spyOn(mine, 'destroy');
    page.piece.destroy();
    expect(own).not.toHaveBeenCalled();
    mine.destroy();
  });

  it('after destroy, nothing it was told to do does anything', () => {
    const onSelect = vi.fn();
    const { piece, state } = make({ topology: topology(), onSelect });
    piece.destroy();
    piece.update({ node: sample.nodes[2].id, view: 'dataflow', theme: 'light' });
    piece.fit();
    frames();
    expect(onSelect).not.toHaveBeenCalled();
    expect(state.selectedNode).toBe(null);
  });
});

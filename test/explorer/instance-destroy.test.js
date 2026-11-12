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
// @ts-expect-error plain JS modules, no declarations
import * as nodePanel from '../../explorer/pieces/node-panel.js';
// @ts-expect-error plain JS modules, no declarations
import * as layersPiece from '../../explorer/pieces/layers.js';
// @ts-expect-error plain JS modules, no declarations
import * as searchPiece from '../../explorer/pieces/search.js';
// @ts-expect-error plain JS modules, no declarations
import * as proposalPiece from '../../explorer/pieces/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import * as changesPiece from '../../explorer/pieces/changes.js';
// @ts-expect-error plain JS modules, no declarations
import * as decisionPiece from '../../explorer/pieces/decision.js';
// @ts-expect-error plain JS modules, no declarations
import { showProposal, openProposal } from '../../explorer/engine/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { HOLD_MS } from '../../explorer/decision-model.js';
// @ts-expect-error plain JS modules, no declarations
import { initKeyboard } from '../../explorer/engine/keyboard.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode } from '../../explorer/engine/selection.js';

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
  root.innerHTML = '<div class="hx-stage"><canvas id="graph-canvas"></canvas><canvas id="label-canvas"></canvas><div id="sheet-dock" class="hx-dock"></div></div>';
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


/** The three pieces of a page on an instance, as a page would mount them: the node panel in the dock, the others in the root. `end()` destroys them all */
function mountPieces(root, inst) {
  const marker = inst.el('sheet-dock').appendChild(document.createComment('corn-piece:node-panel/drawer'));
  const pieces = [
    nodePanel.mount(root, inst, { slots: { drawer: marker } }),
    layersPiece.mount(root, inst, { storageKey: null }),
    searchPiece.mount(root, inst),
  ];
  const end = () => { pieces.forEach((p) => p.destroy()); marker.remove(); };
  return Object.assign(pieces, { end });
}

describe('the pieces: node panel, Layers menu, search', () => {
  it('have things to take back: listeners, observers, a timer, markup', () => {
    const { inst, root } = make();
    const before = snapshot();
    const pieces = mountPieces(root, inst);
    initKeyboard(inst);
    const after = snapshot();
    expect(after.listeners).toBeGreaterThan(before.listeners + 15);
    expect(root.querySelector('#spec-drawer') && root.querySelector('#legend-dropdown') && root.querySelector('#node-search')).toBeTruthy();
    selectNode(inst, inst.state.nodes[0]);
    pieces.end();
    expect(root.querySelector('#spec-drawer')).toBeNull();
    expect(root.querySelector('#legend-dropdown')).toBeNull();
    expect(root.querySelector('#node-search')).toBeNull();
    inst.destroy();
  });

  it('mounted and destroyed 50 times on one instance, add nothing: the only things left are the instance\'s (the dock\'s observers)', () => {
    const { inst, root } = make();
    const first = mountPieces(root, inst);
    first.end();
    const once = snapshot();
    const cleanups = vi.spyOn(inst, 'own');
    for (let i = 0; i < 50; i++) {
      const pieces = mountPieces(root, inst);
      selectNode(inst, inst.state.nodes[i % 2]); // a panel filled, a sheet registered
      pieces.end();
    }
    expect(snapshot()).toEqual(once);
    expect(root.querySelectorAll('[data-corn="node-panel"], [data-corn="layers-menu"], [data-corn="search"], [data-corn="mobile-search"]')).toHaveLength(0);
    cleanups.mockRestore();
    inst.destroy();
  });

  it('made and destroyed 50 times with their instance, leave no listener, observer, timer or context behind', () => {
    const before = snapshot();
    for (let i = 0; i < 50; i++) {
      const { inst, root } = make();
      mountPieces(root, inst);
      initKeyboard(inst);
      selectNode(inst, inst.state.nodes[0]);
      inst.root.querySelector('#node-search').dispatchEvent(new Event('input', { bubbles: true }));
      inst.destroy();
      root.remove();
    }
    expect(snapshot()).toEqual(before);
  });

  it('are what does it: 50 pieces mounted and not destroyed leave listeners behind', () => {
    const { inst, root } = make();
    const base = snapshot().listeners;
    for (let i = 0; i < 50; i++) mountPieces(root, inst);
    expect(snapshot().listeners).toBeGreaterThan(base + 50 * 10);
    inst.destroy();
  });

  it('the copy timer, the focus timer and the search status timer do not outlive their piece', async () => {
    const { inst, root } = make();
    const pieces = mountPieces(root, inst);
    const quiet = snapshot().timers;
    inst.root.querySelector('[data-action="toggle-mobile-search"]').click(); // the focus timer
    const input = inst.root.querySelector('#node-search');
    input.value = 'zzzz'; input.dispatchEvent(new Event('input', { bubbles: true })); // the status timer
    expect(snapshot().timers).toBeGreaterThan(quiet);
    pieces.end();
    inst.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});


// ---------------------------------------------------------------------------
//  Step 5: the proposal's bar, the change list with the player, the decision
// ---------------------------------------------------------------------------

const PROPOSAL = {
  version: 1, spec: '0001', title: 'Add a page', summary: 'Adds /new.',
  nodes: { add: [{ id: 'page-new', label: '/new', type: 'page', parent: 'a' }] },
  edges: { add: [{ from: 'page-new', to: 'b', kind: 'calls', label: 'asks' }] },
  scenarios: [{ id: 's1', title: 'Opening the page', stepMs: 1000, steps: [{ node: 'page-new', text: 'It opens.' }, { node: 'b', text: 'Then it asks.' }] }],
};
const FACTS = { pull: { number: 21, draft: false, head: 'a'.repeat(40) }, checks: { total: 1, passed: 1, running: 0, failed: [] }, lands: false, landing: null, run: null };
const jsonRes = (status, data) => ({ ok: status < 400, status, redirected: false, headers: new Headers(), json: async () => data });

/** A fetch for the review's routes; `hold` is a list the test pushes to, to answer a request later */
function reviewFetch({ hold = null } = {}) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn((url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url: String(url) });
    const answer = () => {
      if (String(url).includes('/decision')) return jsonRes(200, FACTS);
      if (method === 'PUT') return jsonRes(200, { verdict: 'approved', at: new Date().toISOString() });
      if (String(url).includes('/review')) return jsonRes(404, { error: 'No review yet' });
      if (String(url).includes('/api/forge/pulls/')) return jsonRes(200, { pull: { number: 21, state: 'open', head: { sha: 'a'.repeat(40) } }, checks: [] });
      return jsonRes(404, { error: 'no' });
    };
    if (hold && !String(url).includes('/api/forge/')) return new Promise((resolve) => hold.push(() => resolve(answer())));
    return Promise.resolve(answer());
  }));
  return calls;
}

/** The three pieces of the review on an instance, with a proposal open on it; `end()` destroys them */
function mountReview(root, inst) {
  Object.assign(inst.state, { baseNodes: inst.state.nodes.map((n) => ({ ...n })), baseEdges: inst.state.edges.map((e) => ({ ...e })) });
  const pieces = [proposalPiece.mount(root, inst), changesPiece.mount(root, inst), decisionPiece.mount(root, inst)];
  showProposal(inst, structuredClone(PROPOSAL), { slug: '0001-add-a-page', source: 'pull/21', sha256: 'b'.repeat(64) });
  return Object.assign(pieces, { end: () => pieces.slice().reverse().forEach((p) => p.destroy()) });
}

describe('the review pieces: proposal bar, change list with the player, decision', () => {
  beforeEach(() => { reviewFetch(); });

  it('have things to take back: listeners, observers, timers, markup', async () => {
    const { inst, root } = make();
    const before = snapshot();
    const pieces = mountReview(root, inst);
    await vi.advanceTimersByTimeAsync(0);
    const after = snapshot();
    expect(after.listeners).toBeGreaterThan(before.listeners + 8);
    expect(after.timers).toBeGreaterThan(before.timers);
    expect(root.querySelector('#proposal-bar') && root.querySelector('#review-column') && root.querySelector('#review-decision')).toBeTruthy();
    pieces.end();
    for (const id of ['proposal-bar', 'proposal-wrap', 'review-column', 'review-decision']) expect(root.querySelector(`#${id}`), id).toBeNull();
    inst.destroy();
  });

  it('mounted, played, held and destroyed 50 times on one instance, add nothing', async () => {
    const { inst, root } = make();
    const first = mountReview(root, inst);
    first.end();
    await vi.advanceTimersByTimeAsync(0);
    const once = snapshot();
    for (let i = 0; i < 50; i++) {
      const pieces = mountReview(root, inst);
      await vi.advanceTimersByTimeAsync(0); // the facts are read
      pieces[1].playScenario(inst.state.proposal.scenarios[0], { autoplay: true }); // a scenario plays: a bar, a frame client, a sheet
      root.querySelector('[data-review="approved"]').click(); // a hold counts down
      pieces.end();
    }
    expect(snapshot()).toEqual(once);
    expect(root.querySelectorAll('[data-corn="proposal-bar"], [data-corn="review-column"], [data-corn="decision"], [data-corn="scenario-player"], [data-corn="proposals-button"]')).toHaveLength(0);
    inst.destroy();
  });

  it('are what does it: ten sets mounted and not destroyed leave listeners behind', () => {
    const { inst, root } = make();
    const base = snapshot().listeners;
    for (let i = 0; i < 10; i++) mountReview(root, inst);
    expect(snapshot().listeners).toBeGreaterThan(base + 10 * 8);
    inst.destroy();
  });

  it('a destroy while a scenario plays takes the bar, the frame client and the sheet with it, and the instance carries on', async () => {
    const { inst, root, map } = make();
    const pieces = mountReview(root, inst);
    const snap = pieces[1].playScenario(inst.state.proposal.scenarios[0], { autoplay: true });
    expect(snap && root.querySelector('.hx-player')).toBeTruthy();
    expect(inst.state.scenario).not.toBeNull();
    const heard = vi.fn();
    inst.on('scenario:player', heard);
    pieces.end();
    expect(root.querySelector('.hx-player')).toBeNull();
    expect(inst.state.scenario).toBeNull();
    heard.mockClear();
    vi.advanceTimersByTime(3000); // the frames that would have played it
    map.renderNow();
    expect(heard).not.toHaveBeenCalled();
    expect(inst.state.scenario).toBeNull();
    inst.destroy();
  });

  it('a destroy while a hold counts down sends nothing and leaves no timer', async () => {
    const calls = reviewFetch();
    const { inst, root } = make();
    const pieces = mountReview(root, inst);
    await vi.advanceTimersByTimeAsync(0);
    root.querySelector('[data-review="approved"]').click();
    expect(root.querySelector('[data-review-hold]').hidden).toBe(false);
    const timers = vi.getTimerCount();
    pieces.end();
    expect(vi.getTimerCount()).toBeLessThan(timers);
    await vi.advanceTimersByTimeAsync(HOLD_MS + 5000);
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
    inst.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a destroy while a fetch is in flight paints nothing and says nothing when the answer comes', async () => {
    const hold = [];
    reviewFetch({ hold });
    const { inst, root } = make();
    const said = vi.fn();
    inst.on('decision', said);
    inst.on('auth', said);
    const pieces = mountReview(root, inst); // the decision and the review are asked, and not answered
    expect(hold.length).toBeGreaterThan(0);
    const foot = root.querySelector('#review-decision');
    pieces.end();
    hold.splice(0).forEach((answer) => answer());
    await vi.advanceTimersByTimeAsync(0);
    expect(said).not.toHaveBeenCalled();
    expect(foot.isConnected).toBe(false);
    expect(root.querySelector('#review-decision')).toBeNull();
    inst.destroy();
  });

  it('a destroy while the review is being sent: the answer says nothing, clears no edits and reads nothing more', async () => {
    const calls = reviewFetch();
    const { inst, root } = make();
    const pieces = mountReview(root, inst);
    await vi.advanceTimersByTimeAsync(0);
    let answer;
    const late = new Promise((r) => { answer = r; });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url, init = {}) => ((init.method || 'GET') === 'PUT' ? (calls.push({ method: 'PUT', url: String(url) }), late) : realFetch(url, init))));
    const said = vi.fn();
    for (const name of ['decision', 'auth', 'whatif:clear', 'mockups:refresh']) inst.on(name, said);
    root.querySelector('[data-review="approved"]').click();
    await vi.advanceTimersByTimeAsync(HOLD_MS + 100); // the hold is over, the PUT is in flight
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    pieces.end();
    const before = calls.length;
    answer(jsonRes(200, { verdict: 'approved', at: new Date().toISOString() }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(said).not.toHaveBeenCalled();
    expect(calls.length).toBe(before); // no facts read again for a foot that is gone
    inst.destroy();
  });

  it('a destroy while the proposal is being fetched leaves the bar gone and the map as it was', async () => {
    const hold = [];
    reviewFetch({ hold });
    const { inst, root } = make();
    Object.assign(inst.state, { baseNodes: inst.state.nodes.map((n) => ({ ...n })), baseEdges: inst.state.edges });
    const bar = proposalPiece.mount(root, inst);
    const opening = openProposal(inst, '0001-add-a-page', 'pull/21');
    bar.destroy();
    inst.destroy();
    hold.splice(0).forEach((answer) => answer());
    await vi.advanceTimersByTimeAsync(0);
    await opening.catch(() => {});
    expect(root.querySelector('#proposal-bar')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

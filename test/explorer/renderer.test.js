// @vitest-environment happy-dom
/**
 * The Canvas 2D renderer behind the scene contract, and render.js as the thin module in front of
 * it (TOPO-02). No real canvas: a recording context stands in, so the tests read what the
 * renderer asked it to draw.
 */
import { DIFF_MARK_COLORS } from '../../explorer/diff-marks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { createCanvas2dRenderer } from '../../explorer/renderer-canvas2d.js';
// @ts-expect-error plain JS module, no declarations
import { createLabelLayer } from '../../explorer/labels.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { state, touchScene } from '../../explorer/state.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { toggleLayer } from '../../explorer/layers.js';



/** A 2d context that records every call and every property set */
function recordingCtx() {
  const log         = [];
  const ctx      = new Proxy({}, {
    get: (_t, key        ) => (key === 'log' ? log : key === 'measureText' ? (text        ) => ({ width: text.length * 6 }) : (...args       ) => { log.push([key, ...args]); }),
    set: (_t, key        , value) => { log.push([`set:${key}`, value]); return true; },
  });
  return ctx;
}
function fakeCanvas(ctx     , w = 800, h = 600) {
  return { width: 0, height: 0, getContext: () => ctx, parentElement: { clientWidth: w, clientHeight: h } }       ;
}
const names = (ctx     ) => (ctx.log          ).map((c) => c[0]);
const texts = (ctx     ) => (ctx.log          ).filter((c) => c[0] === 'fillText').map((c) => c[1]);

const node = (id        , type        , x = 0, y = 0, extra         = {}) => ({ id, type, x, y, r: 20, color: '#336699', label: id, ...extra });
const link = (from        , to        , extra         = {}) => ({ from, to, ...extra });
const nodes = [node('root', 'root', 0, 0), node('app', 'app', 100, 0), node('page', 'page', 200, 0), node('tbl', 'table', 300, 0), node('far', 'page', 400, 0)];
const edges = [link('root', 'app'), link('app', 'page'), link('app', 'tbl', { kind: 'flow', flow: 'api', status: 'live', label: 'calls the API' })];
const layers = { app: true, pkg: true, page: true, atom: true, molecule: true, token: true, tool: true, flow: true, table: true, rom: true, service: true, external: true, stack: false };
const mk = (extra         = {})      => ({ nodes, edges, view: 'orbit', flow: null, rings: { rings: [{ x: 0, y: 0, r: 100 }], clusters: [] }, selectedNode: null, searchQuery: '', isFreeform: false, activeLayers: layers, scenario: null, sceneVersion: 1, ...extra });

describe('renderer-canvas2d', () => {
  it('is a renderer: kind, draw, resize, destroy', () => {
    const r = createCanvas2dRenderer(fakeCanvas(recordingCtx()));
    expect(r.kind).toBe('canvas2d');
    for (const fn of ['draw', 'resize', 'destroy']) expect(typeof r[fn]).toBe('function');
  });

  it('never reads the explorer\'s state', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../explorer/renderer-canvas2d.js'), 'utf8');
    expect(src).not.toMatch(/state\.js/);
    expect(src).not.toMatch(/\bstate\b\./);
    expect([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['./scene.js', './engine/map-style.js', './kind-letters.js', './glyphs.js']);
  });

  it('sizes the canvas for the device pixel ratio and scales the context to match', () => {
    const ctx = recordingCtx();
    const canvas = fakeCanvas(ctx);
    createCanvas2dRenderer(canvas).resize(800, 600, 2);
    expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
    expect(ctx.log).toContainEqual(['setTransform', 2, 0, 0, 2, 0, 0]);
  });

  it('draws clear, then the grid, the rings, the edges and the nodes, and no text at all', () => {
    const ctx = recordingCtx();
    const r = createCanvas2dRenderer(fakeCanvas(ctx));
    r.resize(800, 600, 1);
    ctx.log.length = 0;
    r.draw(buildScene(mk()), { x: 10, y: 20, zoom: 1.5 }, 0);
    const ops = names(ctx);
    expect(ops[0]).toBe('clearRect');
    expect(ctx.log).toContainEqual(['translate', 10, 20]);
    expect(ctx.log).toContainEqual(['scale', 1.5, 1.5]);
    expect(ops.indexOf('lineTo')).toBeGreaterThan(-1); // the grid and the ownership links
    expect(ops.indexOf('quadraticCurveTo')).toBeGreaterThan(-1); // the flow edge
    expect(ops.indexOf('arc')).toBeGreaterThan(-1); // the circles
    // every label is the label layer's (labels.js): the edge label of this flow edge too
    expect(buildScene(mk({ selectedNode: nodes[1] })).edges.some((e     ) => e.label)).toBe(true);
    ctx.log.length = 0;
    r.draw(buildScene(mk({ selectedNode: nodes[1] })), { x: 0, y: 0, zoom: 0.5 }, 0);
    for (const op of ['fillText', 'strokeText', 'set:font']) expect(names(ctx), op).not.toContain(op);
  });

  it('draws a node\'s glow and a dimmed node\'s alpha as the scene says', () => {
    const ctx = recordingCtx();
    const r = createCanvas2dRenderer(fakeCanvas(ctx));
    r.resize(800, 600, 1);
    ctx.log.length = 0;
    r.draw(buildScene(mk({ selectedNode: nodes[2] })), { x: 0, y: 0, zoom: 1 }, 0);
    const sets = (ctx.log          ).filter((c) => c[0] === 'set:shadowBlur' || c[0] === 'set:globalAlpha').map((c) => `${c[0].slice(4)}=${c[1]}`);
    expect(sets).toContain('globalAlpha=0.07'); // the nodes outside the focus
    // a glow is a soft disc behind the node, never a shadowBlur (a blur per node and edge is what made a tap take seconds: F30)
    expect(sets.some((x     ) => x.startsWith('shadowBlur'))).toBe(false);
    const sel = buildScene(mk({ selectedNode: nodes[2] })).nodes.find((n     ) => n.glow);
    expect(ctx.log.some((c     ) => c[0] === 'arc' && Math.abs(c[3] - (sel.r + sel.glow * 0.7)) < 1e-9)).toBe(true); // the selected page's halo
  });

  it('draws the end mark of each family and the ticks of a `when` (spec 0008 D7)', () => {
    const drawn = (extra        ) => {
      const ctx = recordingCtx();
      const r = createCanvas2dRenderer(fakeCanvas(ctx));
      r.resize(800, 600, 1);
      const e = { key: 'a->b', from: 'a', to: 'b', kind: 'reads', x1: 0, y1: 0, x2: 100, y2: 0, r1: 20, r2: 20, color: '#38bdf8', width: 1.6, alpha: 1, dash: null, ticks: 0, curve: null, arrow: true, end: 'chevron', glow: 0, glowColor: null, label: null, packet: null, mark: 'none', ...extra };
      r.draw({ nodes: [], edges: [e], decor: { grid: null, rings: [], lanes: [] }, preset: false, theme: 'dark', version: 1 }, { x: 0, y: 0, zoom: 1 }, 0);
      return ctx.log          ;
    };
    const verbs = (log        , from = 0) => log.slice(from).map((c        ) => c[0]);
    expect(verbs(drawn({ end: 'triangle' }))).toContain('fill'); // a filled triangle
    const chevron = drawn({ end: 'chevron' });
    expect(verbs(chevron).filter((v        ) => v === 'fill').length).toBe(0); // open: stroked only
    expect(chevron.filter((c        ) => c[0] === 'lineTo').length).toBe(3); // the line, then the two barbs
    expect(drawn({ end: 'bar' }).filter((c        ) => c[0] === 'moveTo').length).toBe(2);
    const diamond = drawn({ end: 'diamond' });
    expect(verbs(diamond)).toContain('closePath');
    expect(verbs(diamond)).not.toContain('fill');
    const lines = (log        ) => log.filter((c        ) => c[0] === 'moveTo').length;
    expect(lines(drawn({ end: null, arrow: false, ticks: 2 })) - lines(drawn({ end: null, arrow: false, ticks: 0 }))).toBe(2); // one stroke segment per tick
    expect(lines(drawn({ end: null, arrow: false, ticks: 1 })) - lines(drawn({ end: null, arrow: false, ticks: 0 }))).toBe(1);
  });

  it('strokes only the lines whose box reaches the view: the picture is the same, a pan on a big map strokes what is in view', () => {
    const ctx = recordingCtx();
    const r = createCanvas2dRenderer(fakeCanvas(ctx));
    r.resize(800, 600, 1);
    const e = (key, x1, y1, x2, y2, extra = {}) => ({ key, from: 'a', to: 'b', kind: 'reads', x1, y1, x2, y2, r1: 0, r2: 0, color: '#38bdf8', width: 1.6, alpha: 0.04, dash: null, ticks: 0, curve: null, arrow: false, end: null, glow: 0, glowColor: null, label: null, packet: null, mark: 'none', ...extra });
    const edges = [
      e('in', 100, 100, 200, 200), // in view
      e('across', -5000, 300, 5000, 300), // both ends far outside, the line crosses the view
      e('curve', -400, -400, 1200, -400, { curve: { cx: 400, cy: 1400 } }), // the ends above the view, the curve dips into it
      e('out', 3000, 3000, 3100, 3100), // nowhere near
      e('near', 815, 100, 900, 100, { arrow: true, end: 'diamond' }), // its end mark reaches back to the right edge: kept
    ];
    r.draw({ nodes: [], edges, decor: { grid: null, rings: [], lanes: [] }, preset: false, theme: 'dark', version: 1 }, { x: 0, y: 0, zoom: 1 }, 0);
    const starts = ctx.log.filter((c) => c[0] === 'moveTo').map((c) => c.slice(1).join(','));
    expect(starts).toEqual(expect.arrayContaining(['100,100', '-5000,300', '-400,-400', '815,100']));
    expect(starts).not.toContain('3000,3000');
  });

  it('draws the lines of a scene with packets once, and only the packets again while nothing but time moves (F30)', () => {
    const layerCtx = recordingCtx();
    vi.stubGlobal('OffscreenCanvas', class { width = 1; height = 1; getContext() { return layerCtx; } });
    try {
      const ctx = recordingCtx();
      const r = createCanvas2dRenderer(fakeCanvas(ctx), { layerMinEdges: 0 }); // a small scene: the layer is asked for
      r.resize(800, 600, 1);
      const scene = buildScene(mk({ selectedNode: nodes[1] }));
      expect(scene.edges.some((e     ) => e.packet)).toBe(true);
      const camera = { x: 0, y: 0, zoom: 1 };
      r.draw(scene, camera, 0);
      const strokesOnce = names(layerCtx).filter((n     ) => n === 'stroke').length;
      expect(strokesOnce).toBeGreaterThan(0); // the lines went to the layer
      expect(names(ctx)).toContain('drawImage');
      layerCtx.log.length = 0; ctx.log.length = 0;
      r.draw(scene, camera, 500); // only the time moved
      expect(names(layerCtx)).not.toContain('stroke');
      expect(names(ctx)).not.toContain('quadraticCurveTo');
      expect(names(ctx)).toContain('drawImage');
      expect((ctx.log          ).some((c     ) => c[0] === 'arc' && c[3] === 3.5)).toBe(true); // the packet still moved
      r.draw(scene, { x: 5, y: 0, zoom: 1 }, 600); // the camera moved: the lines are drawn again
      expect(names(layerCtx)).toContain('stroke');
      // A new scene (a selection, a layer, the theme, a proposal or a scenario step all build one) draws the lines again
      const again = (fn) => { fn(); layerCtx.log.length = 0; r.draw(scene2, { x: 5, y: 0, zoom: 1 }, 700); return names(layerCtx).includes('stroke'); };
      const scene2 = buildScene(mk({ selectedNode: nodes[1], sceneVersion: 2 })); // the same selection, built again
      expect(again(() => {})).toBe(true);
      layerCtx.log.length = 0;
      r.draw(scene2, { x: 5, y: 0, zoom: 1 }, 800);
      expect(names(layerCtx)).not.toContain('stroke'); // and then holds
      expect(again(() => r.resize(390, 844, 3))).toBe(true); // a resize or a new device pixel ratio
    } finally { vi.unstubAllGlobals(); }
  });

  it('moves a packet with the time it is given and builds nothing', () => {
    const ctx = recordingCtx();
    const r = createCanvas2dRenderer(fakeCanvas(ctx));
    r.resize(800, 600, 1);
    const scene = buildScene(mk({ selectedNode: nodes[1] }));
    const frozen = JSON.stringify(scene);
    expect(scene.edges.some((e     ) => e.packet)).toBe(true);
    const packetAt = (t        ) => {
      ctx.log.length = 0;
      r.draw(scene, { x: 0, y: 0, zoom: 1 }, t);
      const arcs = (ctx.log          ).filter((c) => c[0] === 'arc' && c[3] === 3.5);
      return arcs.map((a) => [a[1], a[2]]);
    };
    const a = packetAt(0);
    const b = packetAt(900);
    expect(a.length).toBeGreaterThan(0);
    expect(b).not.toEqual(a);
    expect(packetAt(0)).toEqual(a); // a pure function of time
    expect(JSON.stringify(scene)).toBe(frozen);
  });

  it('draws the data-flow lanes from the scene alone (their titles belong to the label layer)', () => {
    const ctx = recordingCtx();
    const r = createCanvas2dRenderer(fakeCanvas(ctx));
    r.resize(800, 600, 1);
    const flowNodes = [node('store-idb', 'store', -100, 0), node('app-api', 'app', 100, 0)];
    const flow = { ids: new Set(['store-idb', 'app-api']), edges: [link('store-idb', 'app-api', { kind: 'flow', flow: 'outbox', status: 'live' })], top: -80, headers: [{ title: 'Browser', note: 'saved first', x: -100, left: -130, right: -70, rows: 1 }, { title: 'API', note: 'the writer', x: 100, left: 70, right: 130, rows: 1 }] };
    const scene = buildScene({ ...mk(), nodes: flowNodes, edges: [], view: 'dataflow', flow });
    ctx.log.length = 0;
    r.draw(scene, { x: 0, y: 0, zoom: 1 }, 0);
    expect((ctx.log          ).filter((c) => c[0] === 'roundRect' && c[5] === 14)).toHaveLength(2); // the lanes (a store's rounded square is a roundRect too: its corner is not 14)
    expect(texts(ctx)).toEqual([]); // the titles, notes and arrows are the label layer's
    expect((ctx.log          ).filter((c) => c[0] === 'setLineDash' && c[1].length === 2 && c[1][0] === 4 && c[1][1] === 6)).toHaveLength(0); // no orbital rings here
  });
});

describe('renderer-canvas2d proposal marks', () => {
  const marked = (mark        , extra         = {}) => {
    const scene = buildScene(mk());
    Object.assign(scene.nodes[2], { mark, ...extra }); // the 'page' node
    const ctx = recordingCtx();
    const r = createCanvas2dRenderer(fakeCanvas(ctx));
    r.resize(800, 600, 1);
    ctx.log.length = 0;
    r.draw(scene, { x: 0, y: 0, zoom: 1 }, 0);
    return ctx;
  };
  const ringsOf = (ctx     , color        ) => (ctx.log          ).filter((c, i, log) => c[0] === 'set:strokeStyle' && c[1] === color && log.slice(Math.max(0, i - 3), i).some((p) => p[0] === 'arc'));

  it('draws no ring for an unmarked node', () => {
    const ctx = marked('none');
    for (const color of Object.values(DIFF_MARK_COLORS.dark)) expect(ringsOf(ctx, color), color).toHaveLength(0);
  });

  it('draws a dashed ring in the added colour for an addition, a dotted one for an edit, and a solid one for the others', () => {
    const added = marked('added');
    expect(ringsOf(added, DIFF_MARK_COLORS.dark.added)).toHaveLength(1);
    expect(added.log).toContainEqual(['setLineDash', [5, 4]]);
    for (const [mark, color] of [['changed', DIFF_MARK_COLORS.dark.changed], ['removed', DIFF_MARK_COLORS.dark.removed], ['edit', DIFF_MARK_COLORS.dark.edit]]) {
      const ctx = marked(mark);
      expect(ringsOf(ctx, color), mark).toHaveLength(1);
      expect(ctx.log, mark).not.toContainEqual(['setLineDash', [5, 4]]);
      if (mark === 'edit') expect(ctx.log).toContainEqual(['setLineDash', [2, 5]]); // F20: not the changed mark's solid ring
    }
  });

  it('draws a mark\'s ring at the node\'s own alpha, as the WebGL shader does, so a removed ring is faded as the contrast check measures it', () => {
    const ctx = marked('removed', { alpha: 0.85 });
    const i = (ctx.log          ).findIndex((c) => c[0] === 'set:strokeStyle' && c[1] === DIFF_MARK_COLORS.dark.removed);
    const alphas = (ctx.log          ).slice(0, i).filter((c) => c[0] === 'set:globalAlpha').map((c) => c[1]);
    expect(alphas.at(-1)).toBe(0.85);
  });

  it('strikes a removed node through, as the WebGL shader does, and no other mark', () => {
    const lines = (ctx     ) => (ctx.log          ).filter((c) => c[0] === 'lineTo').length;
    expect(lines(marked('removed'))).toBe(lines(marked('changed')) + 1);
    expect(lines(marked('edit'))).toBe(lines(marked('changed')));
  });

  it('strikes a removed edge across at its midpoint, as the WebGL tips pass does', () => {
    const drawn = (mark        ) => {
      const scene = buildScene(mk());
      Object.assign(scene.edges[0], { mark, curve: null, arrow: false, packet: null });
      const ctx = recordingCtx();
      const r = createCanvas2dRenderer(fakeCanvas(ctx));
      r.resize(800, 600, 1);
      ctx.log.length = 0;
      r.draw(scene, { x: 0, y: 0, zoom: 1 }, 0);
      return (ctx.log          ).filter((c) => c[0] === 'lineTo').length;
    };
    expect(drawn('removed')).toBe(drawn('changed') + 1);
  });

  it('keeps a ring at least 1.8px thick on screen when zoomed out', () => {
    const scene = buildScene(mk());
    Object.assign(scene.nodes[2], { mark: 'added' });
    const ctx = recordingCtx();
    const r = createCanvas2dRenderer(fakeCanvas(ctx));
    r.resize(800, 600, 1);
    ctx.log.length = 0;
    r.draw(scene, { x: 0, y: 0, zoom: 0.25 }, 0);
    const widths = (ctx.log          ).filter((c) => c[0] === 'set:lineWidth').map((c) => c[1]);
    expect(widths).toContain(1.8 / 0.25);
  });

  it('draws no text: the label layer strikes the label of a removed node through, and no other', () => {
    expect(texts(marked('removed', { labelStrike: true }))).toEqual([]);
    const labelled = (mark        , extra         = {}) => {
      const scene = buildScene(mk());
      Object.assign(scene.nodes[2], { mark, ...extra });
      const ctx = recordingCtx();
      const layer = createLabelLayer(fakeCanvas(ctx));
      layer.resize(800, 600, 1);
      ctx.log.length = 0;
      layer.draw(scene, { x: 0, y: 0, zoom: 1 });
      return ctx;
    };
    const strokes = (ctx     ) => (ctx.log          ).filter((c) => c[0] === 'set:lineWidth' && c[1] === 1.4).length;
    expect(strokes(labelled('removed', { labelStrike: true }))).toBe(strokes(labelled('none')) + 1); // one more line than the plain picture
  });
});

describe('render.js', () => {
  let labelCtx     ;
  beforeEach(() => {
    const ctx = recordingCtx();
    state.canvas = fakeCanvas(ctx);
    state.ctx = ctx;
    labelCtx = recordingCtx();
    state.labelCanvas = fakeCanvas(labelCtx);
    state.nodes = structuredClone(nodes);
    state.edges = structuredClone(edges);
    state.view = 'orbit';
    state.flow = null;
    state.selectedNode = null;
    state.searchQuery = '';
    state.scenario = null;
    state.camera = { x: 0, y: 0, zoom: 1 };
    state.activeLayers = { ...layers };
    touchScene();
    render.resize();
  });

  it('fits into the part of the map the phones sheets leave: the viewport the fit uses shrinks by the covered height (TOPO-18)', () => {
    const fit = () => { render.fitGraphToViewport(40); return { ...state.camera }; };
    state.coveredBottom = 0;
    const full = fit();
    state.coveredBottom = 300; // the sheets hide the bottom 300 of the 600 px
    const covered = fit();
    expect(covered.zoom).toBe(full.zoom);
    expect(covered.y).toBeCloseTo(full.y - 150, 5); // centred in the 300 px that are left, not the 600
    expect(covered.x).toBeCloseTo(full.x, 5);

    // a map that is taller than it is wide is fitted by height, so the sheets make it smaller too
    state.nodes.push(node('deep', 'page', 200, 1200));
    state.coveredBottom = 0;
    const tall = fit();
    state.coveredBottom = 300;
    const tallCovered = fit();
    expect(tallCovered.zoom).toBeLessThan(tall.zoom);
    for (const n of state.nodes) {
      const y = state.camera.y + n.y * state.camera.zoom;
      expect(y + (n.r || 18) * state.camera.zoom).toBeLessThanOrEqual(600 - 300);
    }
    state.coveredBottom = 0;
  });

  it('keeps every export other modules import', () => {
    for (const name of ['render', 'resize', 'fitGraphToViewport', 'fitPadding', 'screenToWorld', 'isNodeVisible', 'getActiveSubgraph', 'ensureFlowLoop']) {
      expect(typeof (render       )[name], name).toBe('function');
    }
  });

  it('answers isNodeVisible, getActiveSubgraph and screenToWorld from the state', () => {
    state.activeLayers.page = false;
    expect(render.isNodeVisible(state.nodes[2])).toBe(false);
    expect(render.isNodeVisible(state.nodes[0])).toBe(true);
    expect([...render.getActiveSubgraph(state.nodes[1]) .connectedNodeIds].sort()).toEqual(['app', 'page', 'root', 'tbl'].sort());
    state.camera = { x: 100, y: 50, zoom: 2 };
    expect(render.screenToWorld(300, 250)).toEqual({ x: 100, y: 100 });
  });

  it('rebuilds the scene when the version moves, and never for a camera change or a packet frame', () => {
    render.renderNow();
    const built = render.sceneBuilds();
    const scene = render.getScene();
    for (let frame = 0; frame < 30; frame++) {
      state.camera.x += 5;
      state.camera.zoom *= 1.01;
      render.renderNow(); // a camera frame, and a packet frame: performance.now() moves between calls
    }
    render.fitGraphToViewport(40);
    render.resize();
    render.renderNow();
    expect(render.sceneBuilds()).toBe(built);
    expect(render.getScene()).toBe(scene);

    touchScene();
    render.renderNow();
    expect(render.sceneBuilds()).toBe(built + 1);
    render.renderNow();
    expect(render.sceneBuilds()).toBe(built + 1);
  });

  it('rebuilds once per frame when layers are toggled (layers.js touches the scene)', () => {
    render.renderNow();
    const built = render.sceneBuilds();
    toggleLayer('page');
    toggleLayer('page');
    toggleLayer('page');
    expect(render.sceneBuilds()).toBe(built); // asking for a frame builds nothing
    render.renderNow();
    expect(render.sceneBuilds()).toBe(built + 1); // three toggles, one build
    expect(render.getScene().nodes.map((n     ) => n.id)).not.toContain('page');
    toggleLayer('page');
    render.renderNow();
    expect(render.getScene().nodes.map((n     ) => n.id)).toContain('page');
  });

  it('draws the labels on the label canvas, once, and not again on a packet frame', () => {
    render.resize();
    render.renderNow();
    const labelTexts = () => texts(labelCtx);
    expect(labelTexts().length).toBeGreaterThan(0);
    expect(labelTexts()).toEqual(expect.arrayContaining(['root', 'app', 'page', 'tbl']));
    const logged = labelCtx.log.length;
    for (let frame = 0; frame < 30; frame++) render.renderNow(); // performance.now() moves between these: packets move, labels do not
    expect(labelCtx.log.length).toBe(logged);
    state.camera.x += 10; // a pan repaints them
    render.renderNow();
    expect(labelCtx.log.length).toBeGreaterThan(logged);
    const afterPan = labelCtx.log.length;
    touchScene(); // a new scene repaints them
    render.renderNow();
    expect(labelCtx.log.length).toBeGreaterThan(afterPan);
  });

  it('sizes the label canvas with the map canvas', () => {
    (state.canvas.parentElement       ).clientWidth = 640;
    (state.canvas.parentElement       ).clientHeight = 480;
    render.resize();
    render.renderNow();
    expect([state.labelCanvas.width, state.labelCanvas.height]).toEqual([state.canvas.width, state.canvas.height]);
    expect(labelCtx.log.filter((c      ) => c[0] === 'setTransform').length).toBeGreaterThan(0);
  });

  it('draws no labels, and does not fail, when the page has no label canvas', () => {
    state.labelCanvas = null;
    expect(() => { render.resize(); render.renderNow(); }).not.toThrow();
  });

  it('draws through whichever renderer it is given', () => {
    const drawn        = [];
    render.setRenderer({ kind: 'test', draw: (scene     , camera     , t        ) => drawn.push({ scene, camera, t }), resize() {}, destroy() {} });
    expect(render.getRenderer().kind).toBe('test');
    drawn.length = 0;
    render.renderNow();
    expect(drawn).toHaveLength(1);
    expect(drawn[0].scene.nodes).toHaveLength(state.nodes.length);
    expect(drawn[0].camera).toBe(state.camera);
    expect(typeof drawn[0].t).toBe('number');
    // a new canvas gets a fresh Canvas 2D renderer again
    state.canvas = fakeCanvas(recordingCtx());
    expect(render.getRenderer().kind).toBe('canvas2d');
  });
});

describe('render.js draws on demand', () => {
  let drawn       ;
  const settle = () => vi.advanceTimersByTime(16);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb                     ) => setTimeout(() => cb(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (id        ) => clearTimeout(id));
    const ctx = recordingCtx();
    state.canvas = fakeCanvas(ctx);
    state.ctx = ctx;
    state.nodes = structuredClone(nodes);
    state.edges = structuredClone(edges);
    state.view = 'orbit';
    state.flow = null;
    state.selectedNode = null;
    state.searchQuery = '';
    state.sim = null;
    state.camera = { x: 0, y: 0, zoom: 1 };
    state.activeLayers = { ...layers };
    touchScene();
    drawn = [];
    render.setRenderer({ kind: 'test', draw: (scene     , camera     , t        ) => drawn.push({ scene, camera, t }), resize() {}, destroy() {} });
    settle();
    render.cancelFrame();
    drawn.length = 0;
  });
  afterEach(() => {
    render.cancelFrame();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('render() does not draw by itself: it asks for a frame, and any number of calls draw once', () => {
    for (let i = 0; i < 30; i++) render.render();
    expect(drawn).toHaveLength(0);
    settle();
    expect(drawn).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(drawn).toHaveLength(1);
  });

  it('an untouched map with no packets draws nothing, however long it sits', () => {
    render.render();
    settle();
    drawn.length = 0;
    const stats = render.frameStats();
    vi.advanceTimersByTime(10_000);
    expect(drawn).toHaveLength(0);
    expect(render.frameStats().frames).toBe(stats.frames); // not even a frame ran
  });

  it('a scene change that nobody drew yet is drawn by the next frame', () => {
    touchScene();
    render.ensureFlowLoop();
    settle();
    expect(drawn).toHaveLength(1);
  });

  it('packets (a selection with flow edges) keep drawing, and stop after 30 s without input; input starts them again', () => {
    state.selectedNode = state.nodes[1]; // app: has a flow edge to tbl
    touchScene();
    render.render();
    vi.advanceTimersByTime(1000);
    expect(render.getScene().edges.some((e     ) => e.packet)).toBe(true);
    expect(drawn.length).toBeGreaterThan(20); // about 30 frames a second
    vi.advanceTimersByTime(40_000);
    const asleep = drawn.length;
    vi.advanceTimersByTime(5000);
    expect(drawn.length).toBe(asleep);
    document.body.dispatchEvent(new Event('mousemove', { bubbles: true })); // any input wakes them
    vi.advanceTimersByTime(1000);
    expect(drawn.length).toBeGreaterThan(asleep + 20);
    // a key does too
    vi.advanceTimersByTime(40_000);
    const asleepAgain = drawn.length;
    document.body.dispatchEvent(new Event('keydown', { bubbles: true }));
    vi.advanceTimersByTime(1000);
    expect(drawn.length).toBeGreaterThan(asleepAgain + 20);
  });

  it('packets stop while the tab is hidden and start again when it is shown', () => {
    state.selectedNode = state.nodes[1];
    touchScene();
    render.render();
    vi.advanceTimersByTime(500);
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    vi.advanceTimersByTime(100);
    const before = drawn.length;
    vi.advanceTimersByTime(5000);
    expect(drawn.length).toBe(before);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(1000);
    expect(drawn.length).toBeGreaterThan(before + 20);
    delete (document       ).hidden;
  });

  it('packets that have scrolled off the screen do not keep it drawing', () => {
    state.selectedNode = state.nodes[1];
    touchScene();
    state.camera = { x: 100000, y: 100000, zoom: 1 };
    render.render();
    settle();
    drawn.length = 0;
    vi.advanceTimersByTime(3000);
    expect(drawn).toHaveLength(0);
    state.camera = { x: 0, y: 0, zoom: 1 };
    render.render();
    vi.advanceTimersByTime(1000);
    expect(drawn.length).toBeGreaterThan(20);
  });

  it('queued frame work runs once, before the draw', () => {
    const order           = [];
    render.setRenderer({ kind: 'test', draw: () => order.push('draw'), resize() {}, destroy() {} });
    settle();
    order.length = 0;
    const job = () => order.push('job');
    for (let i = 0; i < 10; i++) render.queueFrameWork(job);
    settle();
    expect(order).toEqual(['job', 'draw']);
  });

  it('builds the spatial index once per scene, not per query', () => {
    const first = render.getSpatialIndex();
    const built = render.spatialBuilds();
    for (let i = 0; i < 20; i++) render.getSpatialIndex().nodeAt(100, 0);
    expect(render.getSpatialIndex()).toBe(first);
    expect(render.spatialBuilds()).toBe(built);
    touchScene();
    expect(render.getSpatialIndex()).not.toBe(first);
    expect(render.spatialBuilds()).toBe(built + 1);
    expect(render.getSpatialIndex().nodeAt(100, 0) .id).toBe('app');
  });
});

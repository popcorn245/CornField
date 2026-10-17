/**
 * @vitest-environment node
 *
 * The label overlay (TOPO-05, spec 0012 A3): which labels to draw (chooseLabels, pure) and
 * the transparent layer that draws them only when the camera, the scene or the size changed. No
 * DOM and no real canvas: a recording context stands in, as in renderer.test.ts.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { chooseLabels, createLabelLayer, MAX_LABELS } from '../../explorer/labels.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene, FONT_NODE, LABEL_OUTLINE } from '../../explorer/scene.js';



const VIEW = { width: 800, height: 600 };
const CAM = { x: 0, y: 0, zoom: 1 };
/** Every label is 60 world px wide, so the boxes in these tests are exact */
const measure = () => 60;
const noMargin = { margin: 0, measure };

/** A scene node, with every field `labelAt` and `chooseLabels` read */
const sn = (id        , x        , y        , extra         = {})      => ({
  id, type: 'page', x, y, r: 10, color: '#336699', alpha: 1, glow: 0, halo: 'none', mark: 'none',
  selected: false, match: false, connected: true,
  label: id, labelSize: 11, labelBold: false, labelAlpha: 1, labelColor: '#f8fafc', labelKeep: false,
  ...extra,
});
const sc = (nodes       , extra         = {})      => ({ nodes, edges: [], decor: { grid: null, rings: [], lanes: [] }, preset: false, version: 1, ...extra });
const ids = (items       ) => items.filter((i) => i.kind === 'node').map((i) => i.id);

describe('chooseLabels: what is drawn', () => {
  it('turns a node into a text item placed under the circle, with the node outline', () => {
    const [item] = chooseLabels(sc([sn('a', 100, 50, { labelBold: true, labelSize: 12 })]), CAM, VIEW, noMargin);
    expect(item).toMatchObject({ kind: 'node', id: 'a', text: 'a', x: 100, y: 50 + 10 + 12 + 3, size: 12, bold: true, italic: false, align: 'center', color: '#f8fafc', alpha: 1, outline: LABEL_OUTLINE.node, family: FONT_NODE });
  });

  it('keeps a label whose box touches the viewport and drops one that is fully outside, at each edge', () => {
    // the box is 60 wide, 11 high above the baseline (y + 24) and 3.3 below it
    const at = (x        , y        ) => ids(chooseLabels(sc([sn('n', x, y)]), CAM, VIEW, noMargin));
    // right: box left = x - 30
    expect(at(829, 100)).toEqual(['n']);
    expect(at(831, 100)).toEqual([]);
    // left: box right = x + 30
    expect(at(-29, 100)).toEqual(['n']);
    expect(at(-31, 100)).toEqual([]);
    // bottom: box top = y + 24 - 11
    expect(at(400, 586)).toEqual(['n']);
    expect(at(400, 589)).toEqual([]);
    // top: box bottom = y + 24 + 3.3
    expect(at(400, -27)).toEqual(['n']);
    expect(at(400, -29)).toEqual([]);
  });

  it('keeps a label a little past the edge by the margin, so none pops in at the border', () => {
    const scene = sc([sn('n', 875, 100)]);
    expect(ids(chooseLabels(scene, CAM, VIEW, noMargin))).toEqual([]);
    expect(ids(chooseLabels(scene, CAM, VIEW, { margin: 50, measure }))).toEqual(['n']);
    expect(ids(chooseLabels(scene, CAM, VIEW, { measure }))).toEqual([]); // the default margin is small, not huge
  });

  it('takes the camera into account: world position, zoom, and the scaled label box', () => {
    const scene = sc([sn('n', 600, 100)]);
    expect(ids(chooseLabels(scene, { x: -500, y: 0, zoom: 2 }, VIEW, noMargin))).toEqual(['n']); // screen x = 700
    expect(ids(chooseLabels(scene, { x: 100, y: 0, zoom: 2 }, VIEW, noMargin))).toEqual([]); // screen x = 1300
    expect(ids(chooseLabels(scene, { x: -500, y: 900, zoom: 2 }, VIEW, noMargin))).toEqual([]); // screen y = 1100
    // zoom scales the box: at zoom 2 its half width is 60 px, so a centre at 859.. is just in (left 799), 862 just out
    expect(ids(chooseLabels(sc([sn('n', 429.5, 100)]), { x: 0, y: 0, zoom: 2 }, VIEW, noMargin))).toEqual(['n']);
    expect(ids(chooseLabels(sc([sn('n', 431, 100)]), { x: 0, y: 0, zoom: 2 }, VIEW, noMargin))).toEqual([]);
  });

  it('applies labelAt: only landmarks and the focus below zoom 0.6, larger; everything above', () => {
    const scene = sc([sn('plain', 100, 100), sn('landmark', 200, 100, { type: 'app', labelKeep: true, labelSize: 12, labelBold: true })]);
    const out = chooseLabels(scene, { x: 0, y: 0, zoom: 0.5 }, VIEW, noMargin);
    expect(ids(out)).toEqual(['landmark']);
    expect(out[0].size).toBe(Math.round(12 * 1.5)); // the zoomed-out boost: 0.75 / 0.5
    const near = chooseLabels(scene, { x: 0, y: 0, zoom: 0.6 }, VIEW, noMargin);
    expect(ids(near)).toEqual(['plain', 'landmark']);
    expect(near.map((i     ) => i.size)).toEqual([11, 12]);
  });

  it('labels every node in the data-flow view at any zoom, with its own boost', () => {
    const scene = sc([sn('a', 100, 100), sn('b', 200, 100)], { preset: true });
    const out = chooseLabels(scene, { x: 0, y: 0, zoom: 0.4 }, VIEW, noMargin);
    expect(ids(out)).toEqual(['a', 'b']);
    expect(out[0].size).toBe(Math.round(11 * Math.min(1.8, 0.8 / 0.4)));
  });

  it('draws a dimmed node at its dim alpha and colour', () => {
    const scene = sc([sn('dim', 100, 100, { connected: false, alpha: 0.07, labelAlpha: 0.07, labelColor: 'rgba(255, 255, 255, 0.3)', labelKeep: true })]);
    const [item] = chooseLabels(scene, CAM, VIEW, noMargin);
    expect(item.alpha).toBe(0.07);
    expect(item.color).toBe('rgba(255, 255, 255, 0.3)');
  });

  it('estimates the box without a measure function (the longer the text, the wider)', () => {
    // 11 px text is estimated at about 6.4 px a character: 200 characters reach 640 px either side of the centre
    const scene = sc([sn('x'.repeat(10), 790, 100), sn('w'.repeat(200), 1300, 200), sn('z'.repeat(3), 850, 300)]);
    expect(ids(chooseLabels(scene, CAM, VIEW, { margin: 0 }))).toEqual(['x'.repeat(10), 'w'.repeat(200)]);
  });
});

describe('chooseLabels: the cap and its priority', () => {
  /** 600 nodes on a grid, all on screen, radius 10 + (i % 7) so the radius order is not the scene order */
  const grid = (n = 600, extra                        = () => ({})) => Array.from({ length: n }, (_, i) =>
    sn(`n${i}`, 20 + (i % 40) * 19, 20 + Math.floor(i / 40) * 22, { r: 10 + (i % 7), ...extra(i) }));

  it('draws at most 400 node labels by default, and says so in MAX_LABELS', () => {
    expect(MAX_LABELS).toBe(400);
    const out = chooseLabels(sc(grid()), CAM, VIEW, noMargin);
    expect(ids(out)).toHaveLength(400);
  });

  it('keeps the largest radius first when nothing else ranks them', () => {
    const out = chooseLabels(sc(grid()), CAM, VIEW, { ...noMargin, max: 100 });
    const radii = ids(out).map((id) => 10 + (Number(id.slice(1)) % 7));
    expect(Math.min(...radii)).toBe(15); // 600 nodes: 85 have r=16, so the other 15 places go to r=15
    expect(radii.filter((r) => r === 16)).toHaveLength(85);
  });

  it('ranks: selection and its neighbours, then search matches, then landmarks, then radius', () => {
    const nodes = grid(300, (i) => {
      if (i === 5) return { selected: true, labelKeep: true, r: 10 };
      if (i >= 10 && i < 14) return { connected: true, labelKeep: true, r: 10 }; // neighbours
      if (i >= 20 && i < 23) return { connected: false, match: true, labelKeep: true, r: 10 }; // matches
      if (i >= 30 && i < 32) return { connected: false, type: 'app', labelKeep: true, r: 10 }; // landmarks
      return { connected: false, r: 10 + (i % 7) };
    });
    // a landmark has a small radius on purpose: the landmark tier still beats a bigger plain node
    const out = chooseLabels(sc(nodes), CAM, VIEW, { ...noMargin, max: 12 });
    const got = new Set(ids(out));
    expect(got.size).toBe(12);
    for (const i of [5, 10, 11, 12, 13]) expect(got.has(`n${i}`), `n${i} (selection or neighbour)`).toBe(true);
    for (const i of [20, 21, 22]) expect(got.has(`n${i}`), `n${i} (match)`).toBe(true);
    for (const i of [30, 31]) expect(got.has(`n${i}`), `n${i} (landmark)`).toBe(true);
    // the last two places go to the biggest plain nodes (r = 16), the earliest in the scene first
    const rest = [...got].filter((id) => ![5, 10, 11, 12, 13, 20, 21, 22, 30, 31].includes(Number(id.slice(1))));
    expect(rest.sort()).toEqual(['n27', 'n6']);
  });

  it('with the selection, spends the cap on the selection tier before a search match', () => {
    const nodes = grid(100, (i) => (i === 50 ? { selected: true, r: 10, labelKeep: true } : i < 5 ? { connected: false, match: true, labelKeep: true } : { connected: false }));
    const out = chooseLabels(sc(nodes), CAM, VIEW, { ...noMargin, max: 3 });
    expect(ids(out)).toContain('n50');
    expect(ids(out)).toHaveLength(3);
  });

  it('does not count what is off screen against the cap', () => {
    const nodes = [...grid(300), ...Array.from({ length: 300 }, (_, i) => sn(`far${i}`, 5000 + i * 30, 100, { r: 40 }))];
    const out = chooseLabels(sc(nodes), CAM, VIEW, { ...noMargin, max: 400 });
    expect(ids(out)).toHaveLength(300);
    expect(ids(out).every((id) => id.startsWith('n'))).toBe(true);
  });

  it('keeps ties in scene order, so labels do not flicker while the camera pans', () => {
    const nodes = grid(600, () => ({ r: 10 }));
    const a = chooseLabels(sc(nodes), CAM, VIEW, noMargin);
    const b = chooseLabels(sc(nodes), CAM, VIEW, noMargin);
    expect(a).toEqual(b);
    expect(ids(a)).toEqual(nodes.slice(0, 400).map((n) => n.id)); // the first 400 in scene order
    // a few pixels of pan changes nothing about which labels are chosen
    for (const dx of [1, 3, -2, 7]) expect(ids(chooseLabels(sc(nodes), { x: dx, y: dx, zoom: 1 }, VIEW, noMargin))).toEqual(ids(a));
    // and the items come out in scene order, whatever the priority
    const mixed = chooseLabels(sc(grid(600)), CAM, VIEW, noMargin);
    const order = ids(mixed).map((id) => Number(id.slice(1)));
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it('chooses the same set on every call (a pure function of its arguments)', () => {
    const scene = sc(grid());
    expect(chooseLabels(scene, { x: 10, y: -5, zoom: 0.9 }, VIEW, { margin: 40 })).toEqual(chooseLabels(scene, { x: 10, y: -5, zoom: 0.9 }, VIEW, { margin: 40 }));
  });
});

describe('chooseLabels: lane titles and selection edge labels are always there', () => {
  const lane = (title        , x        ) => ({
    x: x - 40, y: -90, w: 80, h: 200, radius: 14, fill: 'f', stroke: 's', strokeWidth: 1,
    title: { text: title, x, y: -86, size: 15, bold: true, color: '#e2e8f0' },
    note: { text: `${title} note`, x, y: -68, size: 11, bold: false, color: '#94a3b8' },
    arrow: { text: '→', x: x + 50, y: -82, size: 18, bold: true, color: 'rgba(148, 163, 184, 0.5)' },
  });
  const edge = (label               )      => ({ key: 'a->b', from: 'a', to: 'b', kind: 'flow', alpha: 1, label });

  it('adds every lane title, note and arrow, centred, with no outline, however many nodes there are', () => {
    const scene = sc([sn('a', 100, 100)], { preset: true, decor: { grid: null, rings: [], lanes: [lane('Browser', 100), lane('API', 400)] } });
    const out = chooseLabels(scene, CAM, VIEW, { ...noMargin, max: 0 });
    const lanes = out.filter((i     ) => i.kind === 'lane');
    expect(lanes.map((i     ) => i.text)).toEqual(['Browser', 'Browser note', '→', 'API', 'API note', '→']);
    expect(lanes[0]).toMatchObject({ x: 100, y: -86, size: 15, bold: true, color: '#e2e8f0', align: 'center', outline: null, alpha: 1, italic: false });
    expect(ids(out)).toEqual([]); // max 0: no node labels, the lane text is not capped
  });

  it('draws lane text even when it is off screen (it is always included)', () => {
    const scene = sc([], { decor: { grid: null, rings: [], lanes: [lane('Far', 90000)] } });
    expect(chooseLabels(scene, CAM, VIEW, noMargin).filter((i     ) => i.kind === 'lane')).toHaveLength(3);
  });

  it('adds a selection edge label in the edge font and outline, italic when proposed, at the edge alpha', () => {
    const scene = sc([], { edges: [edge({ text: 'calls the API', x: 300, y: 200, color: '#38bdf8', italic: true }), edge(null)] });
    const out = chooseLabels(scene, CAM, VIEW, { ...noMargin, max: 0 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'edge', text: 'calls the API', x: 300, y: 200, size: 10, bold: false, italic: true, color: '#38bdf8', alpha: 1, align: 'center', outline: LABEL_OUTLINE.edge, family: '"Segoe UI", -apple-system, sans-serif' });
  });

  it('orders them lanes, then edge labels, then node labels', () => {
    const scene = sc([sn('a', 100, 100)], { preset: true, decor: { grid: null, rings: [], lanes: [lane('Browser', 100)] }, edges: [edge({ text: 'x', x: 1, y: 2, color: '#fff', italic: false })] });
    expect(chooseLabels(scene, CAM, VIEW, noMargin).map((i     ) => i.kind)).toEqual(['lane', 'lane', 'lane', 'edge', 'node']);
  });

  it('works on a real scene from buildScene in the data-flow view', () => {
    const nodes = [sn('store-idb', -100, 0, { type: 'store' }), sn('app-api', 100, 0, { type: 'app' })].map(({ id, type, x, y, r, color, label }) => ({ id, type, x, y, r, color, label }));
    const flow = { ids: new Set(['store-idb', 'app-api']), edges: [{ from: 'store-idb', to: 'app-api', kind: 'flow', flow: 'outbox', status: 'live' }], top: -80, headers: [{ title: 'Browser', note: 'saved first', x: -100, left: -130, right: -70, rows: 1 }, { title: 'API', note: 'the writer', x: 100, left: 70, right: 130, rows: 1 }] };
    const layers = { app: true, store: true, flow: true };
    const scene = buildScene({ nodes, edges: [], view: 'dataflow', flow, rings: { rings: [], clusters: [] }, selectedNode: null, searchQuery: '', isFreeform: false, activeLayers: layers, sim: null, sceneVersion: 3 });
    const out = chooseLabels(scene, { x: 400, y: 300, zoom: 1 }, VIEW, {});
    expect(out.filter((i     ) => i.kind === 'lane').map((i     ) => i.text)).toEqual(['Browser', 'saved first', '→', 'API', 'the writer']);
    expect(ids(out)).toEqual(['store-idb', 'app-api']);
  });
});

describe('chooseLabels: how fast', () => {
  it('chooses from 5,000 nodes in under 5 ms (median of 25 runs)', () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => sn(`node-${i}`, (i % 100) * 40 - 1000, Math.floor(i / 100) * 40 - 800, { r: 8 + (i % 9), type: i % 50 === 0 ? 'app' : 'page', labelKeep: i % 50 === 0 }));
    const scene = sc(nodes);
    const cams = [{ x: 400, y: 300, zoom: 0.3 }, { x: 0, y: 0, zoom: 0.8 }, { x: -800, y: -400, zoom: 1.5 }];
    for (const cam of cams) {
      const times           = [];
      for (let i = 0; i < 25; i++) {
        const t0 = performance.now();
        const out = chooseLabels(scene, cam, { width: 1400, height: 900 }, {});
        times.push(performance.now() - t0);
        expect(ids(out).length).toBeLessThanOrEqual(400);
      }
      times.sort((a, b) => a - b);
      expect(times[12], `median at zoom ${cam.zoom}`).toBeLessThan(5);
    }
  });
});

// ---------------------------------------------------------------------------
//  The layer
// ---------------------------------------------------------------------------
function recordingCtx() {
  const log         = [];
  const ctx      = new Proxy({}, {
    get: (_t, key        ) => (key === 'log' ? log : key === 'measureText' ? (s        ) => ({ width: s.length * 6 }) : (...args       ) => { log.push([key, ...args]); }),
    set: (_t, key        , value) => { log.push([`set:${key}`, value]); return true; },
  });
  return ctx;
}
const fakeCanvas = (ctx     ) => ({ width: 0, height: 0, getContext: () => ctx })       ;
const names = (ctx     ) => (ctx.log          ).map((c) => c[0]);
const texts = (ctx     ) => (ctx.log          ).filter((c) => c[0] === 'fillText').map((c) => c[1]);

describe('createLabelLayer', () => {
  const scene = () => sc([sn('a', 100, 100, { labelKeep: true }), sn('b', 200, 100)]);
  const make = () => {
    const ctx = recordingCtx();
    const canvas = fakeCanvas(ctx);
    const layer = createLabelLayer(canvas);
    layer.resize(800, 600, 2);
    ctx.log.length = 0;
    return { ctx, canvas, layer };
  };

  it('is a layer: draw, resize, destroy', () => {
    const { layer } = make();
    for (const fn of ['draw', 'resize', 'destroy']) expect(typeof layer[fn]).toBe('function');
  });

  it('sizes its canvas for the device pixel ratio and scales the context to match', () => {
    const ctx = recordingCtx();
    const canvas = fakeCanvas(ctx);
    createLabelLayer(canvas).resize(800, 600, 2);
    expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
    expect(ctx.log).toContainEqual(['setTransform', 2, 0, 0, 2, 0, 0]);
  });

  it('draws with the camera: clear, translate, scale, then outline and fill for each label', () => {
    const { ctx, layer } = make();
    layer.draw(scene(), { x: 10, y: 20, zoom: 1.5 });
    expect(names(ctx)[0]).toBe('setTransform');
    expect(ctx.log).toContainEqual(['clearRect', 0, 0, 800, 600]);
    expect(ctx.log).toContainEqual(['translate', 10, 20]);
    expect(ctx.log).toContainEqual(['scale', 1.5, 1.5]);
    expect(texts(ctx)).toEqual(['a', 'b']);
    expect(names(ctx).filter((n) => n === 'strokeText')).toHaveLength(2);
    expect((ctx.log          ).filter((c) => c[0] === 'set:font').map((c) => c[1])).toContain(`11px ${FONT_NODE}`);
    expect(ctx.log).toContainEqual(['set:lineWidth', LABEL_OUTLINE.node.width]);
    expect(ctx.log).toContainEqual(['set:textAlign', 'center']);
  });

  it('draws nothing it should not: the circles, edges and grid are the renderer\'s', () => {
    const { ctx, layer } = make();
    layer.draw(scene(), CAM);
    for (const op of ['arc', 'lineTo', 'quadraticCurveTo', 'roundRect', 'fill']) expect(names(ctx), op).not.toContain(op);
  });

  it('lets a node cover an edge label, as it did when the circles were drawn after the edges', () => {
    const { ctx, layer } = make();
    const edge      = { key: 'a->b', from: 'a', to: 'b', kind: 'flow', alpha: 1, label: { text: 'calls the API', x: 105, y: 90, color: '#38bdf8', italic: false } };
    const dim = sn('dim', 300, 100, { alpha: 0.07 }); // a dimmed node hides nothing
    layer.draw(sc([sn('a', 100, 100, { r: 14 }), dim], { edges: [edge] }), CAM);
    const ops = ctx.log          ;
    const edgeText = ops.findIndex((c) => c[0] === 'fillText' && c[1] === 'calls the API');
    const punch = ops.findIndex((c) => c[0] === 'set:globalCompositeOperation' && c[1] === 'destination-out');
    const nodeText = ops.findIndex((c) => c[0] === 'fillText' && c[1] === 'a');
    expect(edgeText).toBeGreaterThan(-1);
    expect(punch).toBeGreaterThan(edgeText); // erase the circles from the edge labels ...
    expect(nodeText).toBeGreaterThan(punch); // ... before any node label is drawn
    const arcs = ops.filter((c) => c[0] === 'arc');
    expect(arcs).toEqual([['arc', 100, 100, 14, 0, Math.PI * 2]]);
    expect(ops.slice(punch).findIndex((c) => c[0] === 'restore')).toBeGreaterThan(0); // saved and restored around the cut
  });

  it('redraws nothing when the camera, the scene and the size are the same (a packet frame)', () => {
    const { ctx, layer } = make();
    const s = scene();
    const cam = { x: 5, y: 6, zoom: 1 };
    expect(layer.draw(s, cam)).toBe(true);
    const drawn = ctx.log.length;
    expect(drawn).toBeGreaterThan(0);
    for (let frame = 0; frame < 60; frame++) expect(layer.draw(s, { ...cam })).toBe(false); // a new camera object, the same numbers
    expect(ctx.log.length).toBe(drawn);
  });

  it('redraws when the camera moves, in any of x, y or zoom', () => {
    const { ctx, layer } = make();
    const s = scene();
    layer.draw(s, { x: 0, y: 0, zoom: 1 });
    for (const cam of [{ x: 1, y: 0, zoom: 1 }, { x: 1, y: 2, zoom: 1 }, { x: 1, y: 2, zoom: 1.1 }]) {
      const before = ctx.log.length;
      expect(layer.draw(s, cam)).toBe(true);
      expect(ctx.log.length).toBeGreaterThan(before);
    }
  });

  it('redraws when the scene version moves, and when it is a different scene', () => {
    const { ctx, layer } = make();
    const s = scene();
    layer.draw(s, CAM);
    let before = ctx.log.length;
    const next = { ...s, version: 2 };
    expect(layer.draw(next, CAM)).toBe(true);
    expect(ctx.log.length).toBeGreaterThan(before);
    before = ctx.log.length;
    expect(layer.draw(next, CAM)).toBe(false); // the same scene at the same version: nothing changed
    expect(ctx.log.length).toBe(before);
    expect(layer.draw({ ...next }, CAM)).toBe(true); // a rebuilt scene object is a new picture
  });

  it('redraws after a resize, which clears the canvas', () => {
    const { ctx, layer } = make();
    const s = scene();
    layer.draw(s, CAM);
    expect(layer.draw(s, CAM)).toBe(false);
    layer.resize(1000, 700, 1);
    expect(layer.draw(s, CAM)).toBe(true);
    expect(ctx.log).toContainEqual(['clearRect', 0, 0, 1000, 700]);
    expect(layer.draw(s, CAM)).toBe(false);
  });

  it('chooses with its own viewport and measures text on its own context', () => {
    const { ctx, layer } = make();
    // 6 px a character: 'wide-label' is 60 wide, centred on x = 829 -> box left = 799, in view
    layer.draw(sc([sn('wide-label', 829, 100)]), CAM);
    expect(texts(ctx)).toEqual(['wide-label']);
    ctx.log.length = 0;
    layer.draw(sc([sn('wide-label', 900, 100)], { version: 2 }), CAM);
    expect(texts(ctx)).toEqual([]); // box left = 870, past the 800 px viewport and its margin
  });

  it('draws nothing after destroy', () => {
    const { ctx, layer } = make();
    layer.destroy();
    ctx.log.length = 0;
    expect(layer.draw(scene(), CAM)).toBe(false);
    expect(texts(ctx)).toEqual([]);
  });
});

/**
 * @vitest-environment node
 *
 * The label overlay (TOPO-05, spec 0012 A3): which labels to draw (chooseLabels, pure) and
 * the transparent layer that draws them only when the camera, the scene or the size changed. No
 * DOM and no real canvas: a recording context stands in, as in renderer.test.ts.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { chooseLabels, createLabelLayer, labelHit, placeLabels, LABEL_PAD, MAX_LABELS } from '../../explorer/labels.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene, FONT_NODE, LABEL_OUTLINE } from '../../explorer/scene.js';



const VIEW = { width: 800, height: 600 };
const CAM = { x: 0, y: 0, zoom: 1 };
/** Every label is 60 world px wide, so the boxes in these tests are exact */
const measure = (_text, size) => (60 * size) / 11; // 60 px wide at 11 px
const noMargin = { margin: 0, measure };

/** A scene node, with every field `labelAt` and `chooseLabels` read */
const sn = (id        , x        , y        , extra         = {})      => ({
  id, type: 'page', x, y, r: 10, color: '#336699', alpha: 1, glow: 0, halo: 'none', mark: 'none',
  selected: false, match: false, current: false, degree: 0, connected: true,
  label: id, labelSize: 11, labelBold: false, labelAlpha: 1, labelColor: '#f8fafc', labelKeep: false,
  ...extra,
});
const sc = (nodes       , extra         = {})      => ({ nodes, edges: [], decor: { grid: null, rings: [], lanes: [] }, preset: false, version: 1, ...extra });
const ids = (items       ) => items.filter((i) => i.kind === 'node').map((i) => i.id);

describe('chooseLabels: what is drawn', () => {
  it('turns a node into a text item placed under the circle, with the node outline', () => {
    const [item] = chooseLabels(sc([sn('a', 100, 50, { labelBold: true, labelSize: 12 })]), CAM, VIEW, noMargin);
    // zoom 1: a node's label is 12 px here, so it is a hub's 13 minimum? no: 'page' is no hub, its minimum is 11 and 12 is more
    expect(item).toMatchObject({ kind: 'node', id: 'a', text: 'a', x: 100, y: 50 + 10 + 3 + 12, size: 12, bold: true, italic: false, align: 'center', color: '#f8fafc', alpha: 1, outline: LABEL_OUTLINE.node, family: FONT_NODE });
  });

  it('keeps a label whose box touches the viewport and drops one that is fully outside, at each edge', () => {
    // the box is 60 wide, 11 high above the baseline (y + 24) and 3.3 below it
    const at = (x, y) => ids(chooseLabels(sc([sn('n', x, y)]), CAM, VIEW, noMargin));
    expect(at(829, 100)).toEqual(['n']); // right: box left = x - 30
    expect(at(831, 100)).toEqual([]);
    expect(at(-29, 100)).toEqual(['n']); // left: box right = x + 30
    expect(at(-31, 100)).toEqual([]);
    expect(at(400, 586)).toEqual(['n']); // bottom: box top = y + 24 - 11
    expect(at(400, 589)).toEqual([]);
    expect(at(400, -27)).toEqual(['n']); // top: box bottom = y + 24 + 3.3
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
    // a label is 22 px at zoom 2 (11 world units) and 60 / 11 * 22 = 120 wide: half is 60, so a centre at 859.. is just in (left 799)
    expect(ids(chooseLabels(sc([sn('n', 429.5, 100)]), { x: 0, y: 0, zoom: 2 }, VIEW, noMargin))).toEqual(['n']);
    expect(ids(chooseLabels(sc([sn('n', 431, 100)]), { x: 0, y: 0, zoom: 2 }, VIEW, noMargin))).toEqual([]);
  });

  it('has no zoom cut-off: a plain node is labelled at every zoom, and never under 11 px on screen (spec 0008 D2)', () => {
    const scene = sc([sn('plain', 100, 100), sn('landmark', 4100, 100, { type: 'app', labelKeep: true, labelSize: 12, labelBold: true })]);
    for (const zoom of [0.05, 0.1, 0.25, 0.5, 0.59, 0.6, 1, 2, 3]) {
      const out = chooseLabels(scene, { x: 0, y: 0, zoom }, { width: 20000, height: 5000 }, noMargin);
      expect(ids(out), `zoom ${zoom}`).toEqual(['plain', 'landmark']);
      const [plain, hub] = out;
      expect(plain.size * zoom, `plain at ${zoom}`).toBeGreaterThanOrEqual(11 - 1e-9);
      expect(hub.size * zoom, `hub at ${zoom}`).toBeGreaterThanOrEqual(13 - 1e-9); // a cluster's title is 13 px and bold
      expect(hub.bold).toBe(true);
    }
  });

  it('draws a label at 11 px when zoomed out, and grows with the map when zoomed in (the same as before from zoom 1)', () => {
    const scene = sc([sn('n', 100, 100)]);
    const size = (zoom) => chooseLabels(scene, { x: 0, y: 0, zoom }, { width: 5000, height: 5000 }, noMargin)[0].size;
    expect(size(0.25) * 0.25).toBeCloseTo(11);
    expect(size(0.5)).toBeCloseTo(22);
    expect(size(1)).toBeCloseTo(11);
    expect(size(2)).toBeCloseTo(11); // 22 px on screen: 11 world units, scaled by the zoom
    expect(size(2) * 2).toBeCloseTo(22);
  });

  it('lets a theme raise the minimum (--corn-map-label-min), never lower it: 9 and 10 px draw at 11, under 9 px is ignored', () => {
    const at = (labelMin) => chooseLabels(sc([sn('n', 100, 100)], { labelMin }), { x: 0, y: 0, zoom: 0.5 }, VIEW, noMargin)[0].size * 0.5;
    expect(at(undefined)).toBeCloseTo(11);
    expect(at(14)).toBeCloseTo(14);
    expect(at(8)).toBeCloseTo(11);
    expect(at(6)).toBeCloseTo(11);
    expect(at(8.9)).toBeCloseTo(11);
    expect(at(9)).toBeCloseTo(11); // read (validate does not warn), but a theme may not lower the 11 px (spec 0008, open question 3)
    expect(at(10)).toBeCloseTo(11);
    expect(at(11.5)).toBeCloseTo(11.5);
  });

  it('draws a dimmed node at its dim alpha and colour, and gives a label nobody can read no room', () => {
    const scene = sc([sn('dim', 100, 100, { connected: false, alpha: 0.28, labelAlpha: 0.28, labelColor: 'rgba(255, 255, 255, 0.3)', labelKeep: true })]);
    const [item] = chooseLabels(scene, CAM, VIEW, noMargin);
    expect(item.alpha).toBe(0.28);
    expect(item.color).toBe('rgba(255, 255, 255, 0.3)');
    const gone = sc([sn('gone', 100, 100, { alpha: 0.07, labelAlpha: 0.07 }), sn('next', 110, 100)]);
    expect(ids(chooseLabels(gone, CAM, VIEW, noMargin))).toEqual(['next']); // the focus dim: its label takes no room from a neighbour
  });

  it('draws no label for a node with no text (a room in the House view)', () => {
    expect(ids(chooseLabels(sc([sn('room', 100, 100, { label: '' })]), CAM, VIEW, noMargin))).toEqual([]);
  });

  it('estimates the box without a measure function (the longer the text, the wider)', () => {
    // 11 px text is estimated at about 6.4 px a character: 200 characters reach 640 px either side of the centre
    const scene = sc([sn('x'.repeat(10), 790, 100), sn('w'.repeat(200), 1300, 200), sn('z'.repeat(3), 850, 300)]);
    expect(ids(chooseLabels(scene, CAM, VIEW, { margin: 0 }))).toEqual(['x'.repeat(10), 'w'.repeat(200)]);
  });
});

describe('placeLabels: no two labels touch, in a fixed priority order (spec 0008 D2)', () => {
  /** Ten nodes in a row 20 world px apart: at zoom 1 their 60 px labels (11 px high) sit on one line and every one touches the next */
  const row = (extra = () => ({})) => Array.from({ length: 10 }, (_, i) => sn(`n${i}`, 100 + i * 20, 100, extra(i)));
  const placedIds = (scene, zoom = 1) => placeLabels(scene, zoom, { measure: () => 60 }).map((p) => p.id);
  // measure answers for a font size of 100: width 60 at 100 px, so 6.6 at 11. Use a measure that is the real width instead:
  const wide = (_t, size) => size * 0.55 * 6; // six glyphs wide

  const collisions = (placed, pad = 0) => {
    const bad = [];
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], b = placed[j];
        if (a.l - pad < b.r && a.r + pad > b.l && a.t - pad < b.b && a.b + pad > b.t) bad.push(`${a.id}/${b.id}`);
      }
    }
    return bad;
  };

  it('places the first, and skips what touches it: no two placed boxes touch, and they are at least 2 px apart', () => {
    const placed = placeLabels(sc(row()), 1, { measure: wide });
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.length).toBeLessThan(10);
    expect(collisions(placed, LABEL_PAD)).toEqual([]);
  });

  it('places the selection first, then the current match, the other matches, the lit neighbours, marked nodes, hubs, then the rest', () => {
    const kinds = [
      ['rest', {}], ['hub', { type: 'app' }], ['marked', { mark: 'added' }], ['lit', { connected: true }], ['match', { match: true }],
      ['current', { match: true, current: true }], ['selected', { selected: true }],
    ];
    // All on one spot so only one can win: the best tier is the one left. Remove it, and the next best wins.
    let rest = kinds.map(([name, extra], i) => sn(name, 100, 100, { connected: name === 'lit' || name === 'match' || name === 'current' || name === 'selected' ? true : false, ...extra, r: 10 + (i % 2) }));
    const winners = [];
    while (rest.length) {
      // `focused` (a selection or a dimmed node exists) makes the lit tier count
      const [first] = placeLabels(sc(rest), 1, { measure: wide });
      winners.push(first.id);
      rest = rest.filter((n) => n.id !== first.id);
    }
    expect(winners).toEqual(['selected', 'current', 'match', 'lit', 'marked', 'hub', 'rest']);
  });

  it('breaks a tie by the larger disc, then more edges, then scene order', () => {
    const win = (nodes) => placeLabels(sc(nodes), 1, { measure: wide })[0].id;
    expect(win([sn('small', 100, 100, { r: 10 }), sn('big', 100, 100, { r: 16 })])).toBe('big');
    expect(win([sn('few', 100, 100, { degree: 2 }), sn('many', 100, 100, { degree: 9 })])).toBe('many');
    expect(win([sn('first', 100, 100), sn('second', 100, 100)])).toBe('first');
  });

  it('is the same wherever the camera is: a pan changes which labels are in view, never which are placed', () => {
    const nodes = Array.from({ length: 200 }, (_, i) => sn(`n${i}`, (i % 20) * 30, Math.floor(i / 20) * 25, { r: 10 + (i % 5) }));
    const a = placeLabels(sc(nodes), 0.7, { measure: wide });
    const b = placeLabels(sc(nodes), 0.7, { measure: wide });
    expect(a).toEqual(b);
    const seen = (cam) => new Set(ids(chooseLabels(sc(nodes), cam, VIEW, { margin: 0, measure: wide, placed: a })));
    const all = new Set(a.map((p) => p.id));
    for (const cam of [{ x: 0, y: 0, zoom: 0.7 }, { x: -120, y: -40, zoom: 0.7 }, { x: 31, y: 7, zoom: 0.7 }]) for (const id of seen(cam)) expect(all.has(id)).toBe(true);
  });

  it('a match wins its label over a plain neighbour on the same spot, and the neighbour gives way', () => {
    const scene = sc([sn('plain', 100, 100, { r: 18 }), sn('hit', 100, 100, { match: true, r: 10 })]);
    expect(placedIds(scene)).toEqual(['hit']);
  });

  it('puts a chip, over everything, on a hovered node that has no label, and none on one that has', () => {
    const scene = sc([sn('a', 100, 100), sn('b', 100, 100)]); // b is under a's label: no room
    const withChip = chooseLabels(scene, CAM, VIEW, { ...noMargin, hover: 'b' });
    expect(withChip.at(-1)).toMatchObject({ kind: 'chip', id: 'b', text: 'b', alpha: 1 });
    expect(withChip.at(-1).size * 1).toBeGreaterThanOrEqual(11);
    expect(chooseLabels(scene, CAM, VIEW, { ...noMargin, hover: 'a' }).some((i) => i.kind === 'chip')).toBe(false); // it already shows its label
    expect(chooseLabels(scene, CAM, VIEW, noMargin).some((i) => i.kind === 'chip')).toBe(false);
  });
});

describe('labelHit and the layer\'s hit: the label under a screen point (a cluster\'s title)', () => {
  const scene = sc([sn('a', 100, 100, { type: 'app', labelKeep: true, labelSize: 12, labelBold: true }), sn('b', 400, 100)]);
  it('answers with the node whose box holds the point, and null off any box', () => {
    const cam = { x: 10, y: 20, zoom: 1 };
    const placed = placeLabels(scene, 1, { measure });
    // a: centred on x = 100, baseline y = 100 + 10 + 3 + 13 = 126, box from 113 up to 126 and 3.9 down, in screen px + the camera
    expect(labelHit(placed, cam, 110, 20 + 120)).toBe('a');
    expect(labelHit(placed, cam, 410, 20 + 120)).toBe('b');
    expect(labelHit(placed, cam, 250, 20 + 120)).toBeNull();
    expect(labelHit(placed, cam, 110, 20 + 90)).toBeNull(); // on the disc, above the label
  });
  it('is the layer\'s hit for the last scene and camera it drew', () => {
    const ctx = recordingCtx();
    const layer = createLabelLayer(fakeCanvas(ctx));
    layer.resize(800, 600, 1);
    expect(layer.hit(110, 140)).toBeNull(); // nothing drawn yet
    layer.draw(scene, { x: 10, y: 20, zoom: 1 });
    expect(layer.hit(110, 20 + 120)).toBe('a');
    expect(layer.hit(5, 5)).toBeNull();
  });
});

describe('chooseLabels: the cap', () => {
  /** 600 nodes on a grid with room for every label, all on screen */
  const grid = (n = 600, extra = () => ({})) => Array.from({ length: n }, (_, i) =>
    sn(`n${i}`, 20 + (i % 40) * 119, 20 + Math.floor(i / 40) * 40, { r: 10 + (i % 7), ...extra(i) }));
  const BIG = { width: 5000, height: 700 };

  it('draws at most 400 node labels in view by default, and says so in MAX_LABELS', () => {
    expect(MAX_LABELS).toBe(400);
    const out = chooseLabels(sc(grid()), CAM, BIG, noMargin);
    expect(ids(out)).toHaveLength(400);
  });

  it('keeps the best placed ones over the cap: the priority order, not the scene order', () => {
    const out = chooseLabels(sc(grid(600, (i) => (i === 599 ? { selected: true } : {}))), CAM, BIG, { ...noMargin, max: 5 });
    expect(ids(out)).toContain('n599');
    expect(ids(out)).toHaveLength(5);
  });

  it('does not count what is off screen against the cap', () => {
    const nodes = [...grid(300), ...Array.from({ length: 300 }, (_, i) => sn(`far${i}`, 50000 + i * 130, 100, { r: 40 }))];
    const out = chooseLabels(sc(nodes), CAM, BIG, { ...noMargin, max: 400 });
    expect(ids(out)).toHaveLength(300);
    expect(ids(out).every((id) => id.startsWith('n'))).toBe(true);
  });

  it('gives the items in scene order, whatever the priority, and the same on every call', () => {
    const nodes = grid(100, (i) => (i === 50 ? { selected: true } : {}));
    const a = chooseLabels(sc(nodes), CAM, BIG, noMargin);
    expect(a).toEqual(chooseLabels(sc(nodes), CAM, BIG, noMargin));
    const order = ids(a).map((id) => Number(id.slice(1)));
    expect(order).toEqual([...order].sort((x, y) => x - y));
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
    const lanes = out.filter((i) => i.kind === 'lane');
    expect(lanes.map((i) => i.text)).toEqual(['Browser', 'Browser note', '→', 'API', 'API note', '→']);
    expect(lanes[0]).toMatchObject({ x: 100, y: -86, size: 15, bold: true, color: '#e2e8f0', align: 'center', outline: null, alpha: 1, italic: false });
    expect(ids(out)).toEqual([]); // max 0: no node labels, the lane text is not capped
  });

  it('draws lane text even when it is off screen (it is always included)', () => {
    const scene = sc([], { decor: { grid: null, rings: [], lanes: [lane('Far', 90000)] } });
    expect(chooseLabels(scene, CAM, VIEW, noMargin).filter((i) => i.kind === 'lane')).toHaveLength(3);
  });

  it('adds a selection edge label in the edge font and outline, italic when proposed, at the edge alpha', () => {
    const scene = sc([], { edges: [edge({ text: 'calls the API', x: 300, y: 200, color: '#38bdf8', italic: true }), edge(null)] });
    const out = chooseLabels(scene, CAM, VIEW, { ...noMargin, max: 0 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'edge', text: 'calls the API', x: 300, y: 200, size: 10, bold: false, italic: true, color: '#38bdf8', alpha: 1, align: 'center', outline: LABEL_OUTLINE.edge, family: '"Segoe UI", -apple-system, sans-serif' });
  });

  it('orders them lanes, then edge labels, then node labels', () => {
    const scene = sc([sn('a', 100, 100)], { preset: true, decor: { grid: null, rings: [], lanes: [lane('Browser', 100)] }, edges: [edge({ text: 'x', x: 1, y: 2, color: '#fff', italic: false })] });
    expect(chooseLabels(scene, CAM, VIEW, noMargin).map((i) => i.kind)).toEqual(['lane', 'lane', 'lane', 'edge', 'node']);
  });

  it('works on a real scene from buildScene in the data-flow view', () => {
    const nodes = [sn('store-idb', -100, 0, { type: 'store' }), sn('app-api', 100, 0, { type: 'app' })].map(({ id, type, x, y, r, color, label }) => ({ id, type, x, y, r, color, label }));
    const flow = { ids: new Set(['store-idb', 'app-api']), edges: [{ from: 'store-idb', to: 'app-api', kind: 'flow', flow: 'outbox', status: 'live' }], top: -80, headers: [{ title: 'Browser', note: 'saved first', x: -100, left: -130, right: -70, rows: 1 }, { title: 'API', note: 'the writer', x: 100, left: 70, right: 130, rows: 1 }] };
    const layers = { app: true, store: true, flow: true };
    const scene = buildScene({ nodes, edges: [], view: 'dataflow', flow, rings: { rings: [], clusters: [] }, selectedNode: null, searchQuery: '', isFreeform: false, activeLayers: layers, sim: null, sceneVersion: 3 });
    const out = chooseLabels(scene, { x: 400, y: 300, zoom: 1 }, VIEW, {});
    expect(out.filter((i) => i.kind === 'lane').map((i) => i.text)).toEqual(['Browser', 'saved first', '→', 'API', 'the writer']);
    expect(ids(out)).toEqual(['store-idb', 'app-api']);
  });
});

describe('placing and choosing: how fast', () => {
  const nodes = Array.from({ length: 5000 }, (_, i) => sn(`node-${i}`, (i % 100) * 40 - 1000, Math.floor(i / 100) * 40 - 800, { r: 8 + (i % 9), type: i % 50 === 0 ? 'app' : 'page', labelKeep: i % 50 === 0 }));
  const scene = sc(nodes);
  const median = (run) => {
    const times = [];
    for (let i = 0; i < 15; i++) { const t0 = performance.now(); run(); times.push(performance.now() - t0); }
    return times.sort((a, b) => a - b)[7];
  };

  it('places 5,000 nodes at a zoom in under 40 ms (a zoom change; a pan never does it again)', () => {
    for (const zoom of [0.3, 0.8, 1.5]) expect(median(() => placeLabels(scene, zoom, { measure })), `zoom ${zoom}`).toBeLessThan(40);
  });

  it('chooses what is in view from a kept placing in under 5 ms, however far the camera pans', () => {
    for (const cam of [{ x: 400, y: 300, zoom: 0.3 }, { x: 0, y: 0, zoom: 0.8 }, { x: -800, y: -400, zoom: 1.5 }]) {
      const placed = placeLabels(scene, cam.zoom, { measure });
      expect(median(() => chooseLabels(scene, cam, { width: 1400, height: 900 }, { measure, placed })), `zoom ${cam.zoom}`).toBeLessThan(5);
      expect(ids(chooseLabels(scene, cam, { width: 1400, height: 900 }, { measure, placed })).length).toBeLessThanOrEqual(400);
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

  it('draws a label at its minimum size in screen space at 11 px whatever the zoom, so the font string never changes with the zoom (spec 0008 D2)', () => {
    const { ctx, layer } = make();
    const fonts = new Set();
    for (const zoom of [0.1, 0.13, 0.2, 0.31, 0.5, 0.77, 1]) {
      ctx.log.length = 0;
      layer.draw(sc([sn('a', 100, 100), sn('b', 900, 400, { type: 'app', labelBold: true, labelSize: 12 })]), { x: 7, y: 9, zoom });
      for (const c of ctx.log) if (c[0] === 'set:font' && !/100px/.test(c[1])) fonts.add(c[1]); // (the 100 px ones measure text)
      // the text is where the camera puts it, in px: x = 7 + 100 * zoom, the baseline under the disc
      const at = ctx.log.find((c) => c[0] === 'fillText' && c[1] === 'a');
      expect(at[2]).toBeCloseTo(7 + 100 * zoom);
      expect(at[3]).toBeCloseTo(9 + 100 * zoom + 10 * zoom + Math.max(3, 3 * zoom) + 11);
    }
    expect([...fonts].sort()).toEqual([`11px ${FONT_NODE}`, `bold 13px ${FONT_NODE}`]);
  });

  it('names a hovered node that has no room for its label with a chip, drawn last, in screen space', () => {
    const { ctx, layer } = make();
    const s = sc([sn('a', 100, 100), sn('b', 100, 100)]);
    expect(layer.draw(s, { x: 0, y: 0, zoom: 1 }, { hover: 'b' })).toBe(true);
    const ops = ctx.log;
    const texts = ops.filter((c) => c[0] === 'fillText').map((c) => c[1]);
    expect(texts).toEqual(['a', 'b']); // the chip's text is the last thing drawn
    const chip = ops.findIndex((c) => c[0] === 'rect' || c[0] === 'roundRect');
    expect(chip).toBeGreaterThan(-1);
    expect(ops.findIndex((c) => c[0] === 'fillText' && c[1] === 'a')).toBeLessThan(chip);
    // moving the pointer off redraws without it, and the same hover again draws nothing
    ctx.log.length = 0;
    expect(layer.draw(s, { x: 0, y: 0, zoom: 1 }, { hover: 'b' })).toBe(false);
    expect(layer.draw(s, { x: 0, y: 0, zoom: 1 }, {})).toBe(true);
    expect(ctx.log.filter((c) => c[0] === 'fillText').map((c) => c[1])).toEqual(['a']);
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

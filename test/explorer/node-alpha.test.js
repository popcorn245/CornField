// @vitest-environment happy-dom
/**
 * A node's own `color` with an alpha (`#aabbccdd`, `rgba(…, 0.5)`; issue #233). It means: the colour as written, drawn translucent over whatever is
 * under the node (the ground, a line that ends at it, a neighbour's glow), in both renderers, with the node's own glow left out under the fill so
 * the fill alone sets what is seen through it. It is not blended with the ground at build time: the ground is the theme's to say (a theme can
 * set it), and a line or a neighbour is under a node as often as the ground. These tests read what each renderer is handed and what it does with it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { explorerPage } from '../helpers.js';
import { recordingCtx, fakeGl, fakeCanvas, callsOf } from './fake-gl.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene, SHAPE_SIZES } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { createCanvas2dRenderer } from '../../explorer/renderer-canvas2d.js';
// @ts-expect-error plain JS modules, no declarations
import { packNodes, NODE_STRIDE, createWebglRenderer } from '../../explorer/renderer-webgl.js';
// @ts-expect-error plain JS modules, no declarations
import { NODE_FRAG } from '../../explorer/shaders.js';
// @ts-expect-error plain JS modules, no declarations
import { DARK_GROUND, LIGHT_GROUND, parseColor } from '../../explorer/theme-model.js';
// @ts-expect-error plain JS modules, no declarations
import { INK_DARK, INK_LIGHT, inkFor, glyphInk } from '../../explorer/glyphs.js';
// @ts-expect-error plain JS modules, no declarations
import { readMapTokens } from '../../explorer/engine/map-style.js';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { renderLayerToggles, setProjectLayers } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import * as M from '../../explorer/map-style.js';

afterEach(() => M.resetMapStyle());

const layers = { app: true, page: true, table: true, external: true };
const sceneOf = (color, extra = {}, theme = 'dark') => buildScene({
  nodes: [{ id: 'n', type: extra.type || 'table', x: 0, y: 0, r: 20, color, label: 'n', ...extra }], edges: [], view: 'orbit', flow: null, rings: { rings: [], clusters: [] },
  selectedNode: null, searchQuery: '', isFreeform: false, activeLayers: layers, scenario: null, sceneVersion: 1, theme,
});
const TRANSLUCENT = ['#aabbccdd', 'rgba(170, 187, 204, 0.5)', 'rgba(30, 200, 120, 0.25)', '#abcd'];
/** One node type for each silhouette the renderers draw (core/schema.js NODE_SHAPES) */
const SHAPES = { circle: 'service', 'rounded-square': 'table', hexagon: 'external', square: 'machine', diamond: 'persona' };

/** What the Canvas 2D renderer does for the scene's one node, as a list of [call, ...args] */
function canvasLog(scene) {
  const ctx = recordingCtx();
  const renderer = createCanvas2dRenderer({ width: 0, height: 0, getContext: () => ctx });
  renderer.resize(800, 600, 1);
  ctx.log.length = 0;
  renderer.draw(scene, { x: 400, y: 300, zoom: 1 }, 0);
  return ctx.log;
}
/** The fills of the glow disc and of the node, and whether the glow was clipped to leave the node's own shape out */
function canvasNode(scene) {
  const log = canvasLog(scene);
  const clip = log.findIndex((c) => c[0] === 'clip');
  const fills = [];
  let style = null;
  log.forEach((c, i) => { if (c[0] === 'set:fillStyle') style = c[1]; if (c[0] === 'fill') fills.push({ style, at: i }); });
  return { log, clip: clip < 0 ? null : log[clip], clipAt: clip, fills };
}

/** The shader's signed distance to a node's silhouette (shaders.js `sdShape`), in JS: the shape both renderers are held to */
function sdShape([x, y], R, shape) {
  const roundBox = (h, c) => { const qx = Math.abs(x) - (h - c), qy = Math.abs(y) - (h - c); return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - c; };
  if (shape === 'rounded-square') return roundBox(SHAPE_SIZES.roundedHalf * R, SHAPE_SIZES.roundedCorner * R);
  if (shape === 'square') return roundBox(SHAPE_SIZES.squareHalf * R, SHAPE_SIZES.squareCorner * R);
  if (shape === 'diamond') return (Math.abs(x) + Math.abs(y) - SHAPE_SIZES.diamondHalf * R) * Math.SQRT1_2;
  if (shape === 'hexagon') { // sdHex(p.yx, r)
    const k = [-0.866025404, 0.5, 0.577350269];
    const r = SHAPE_SIZES.hexInradius * R;
    let px = Math.abs(y), py = Math.abs(x);
    const d = 2 * Math.min(k[0] * px + k[1] * py, 0);
    px -= d * k[0]; py -= d * k[1];
    px -= Math.min(Math.max(px, -k[2] * r), k[2] * r); py -= r;
    return Math.hypot(px, py) * Math.sign(py);
  }
  return Math.hypot(x, y) - R;
}

/** The subpaths of the path a recorded call at `end` used (from its beginPath), each as a test of whether a point is inside it */
function subpathsOf(log, end) {
  let start = end;
  while (start > 0 && log[start][0] !== 'beginPath') start--;
  const subs = [];
  for (let i = start + 1; i < end; i++) {
    const [op, ...a] = log[i];
    if (op === 'rect' || op === 'roundRect') {
      const [x, y, w, h, c = 0] = a;
      subs.push(([px, py]) => { const qx = Math.abs(px - (x + w / 2)) - (w / 2 - c), qy = Math.abs(py - (y + h / 2)) - (h / 2 - c); return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - c < 0; });
    } else if (op === 'arc') {
      if (log[i - 1][0] === 'moveTo') subs.pop(); // moveTo + a whole arc: one circle
      const [cx, cy, r, from, to] = a;
      expect(to - from).toBeCloseTo(Math.PI * 2);
      subs.push(([px, py]) => Math.hypot(px - cx, py - cy) < r);
    } else if (op === 'moveTo') {
      const pts = [a];
      subs.push(Object.assign(([px, py]) => {
        let inside = false;
        for (let j = 0, k = pts.length - 1; j < pts.length; k = j++) { const [xi, yi] = pts[j], [xk, yk] = pts[k]; if ((yi > py) !== (yk > py) && px < ((xk - xi) * (py - yi)) / (yk - yi) + xi) inside = !inside; }
        return inside;
      }, { pts }));
    } else if (op === 'lineTo') subs[subs.length - 1].pts.push(a);
  }
  return subs;
}
/** Whether a point is in a recorded path under a fill rule (every subpath here winds the same way, so nonzero is "in any") */
const inPath = (subs, p, rule) => { const n = subs.filter((s) => s(p)).length; return rule === 'evenodd' ? n % 2 === 1 : n > 0; };

/**
 * Where the Canvas 2D renderer lays the glow of the scene's one node, as a test on a point (world units from its centre): in the glow's filled
 * path and in its clip. Read from the calls it made, so it is what the canvas would draw.
 */
function glowRegion(scene) {
  const { log, fills } = canvasNode(scene);
  const node = scene.nodes[0];
  const glow = fills[0].at; // the glow disc is the node's first fill
  const fillSubs = subpathsOf(log, glow);
  const fillRule = log[glow][1] || 'nonzero';
  const clipAt = log.slice(0, glow).map((c) => c[0]).lastIndexOf('clip');
  const clipSubs = clipAt < 0 ? null : subpathsOf(log, clipAt);
  const clipRule = clipAt < 0 ? null : log[clipAt][1] || 'nonzero';
  // the path is in world units (the camera is the canvas's transform)
  return ([x, y]) => { const p = [node.x + x, node.y + y]; return inPath(fillSubs, p, fillRule) && (!clipSubs || inPath(clipSubs, p, clipRule)); };
}

describe('a translucent node colour reaches both renderers as the same colour', () => {
  it.each(TRANSLUCENT)('%s: the scene keeps it, WebGL packs its channels and alpha, Canvas 2D sets it as the fill', (c) => {
    const scene = sceneOf(c);
    expect(scene.nodes[0].color).toBe(c);
    const [r, g, b, a] = parseColor(c);
    expect(a).toBeLessThan(1);
    const gl = packNodes(scene).data.slice(0, NODE_STRIDE);
    expect([gl[4], gl[5], gl[6], gl[10]].map((v) => +v.toFixed(3))).toEqual([r / 255, g / 255, b / 255, a].map((v) => +v.toFixed(3)));
    const { fills } = canvasNode(scene);
    expect(fills.map((f) => f.style)).toContain(c); // the glow disc and the node: both in the colour as written, which the canvas reads with its alpha
    expect(fills.filter((f) => f.style === c).length).toBe(2);
  });
});

describe('the glow of a translucent node is left out under its fill, in both renderers', () => {
  it.each(TRANSLUCENT)('Canvas 2D cuts the node\'s own shape out of the glow disc (even-odd), %s', (c) => {
    const { log, fills } = canvasNode(sceneOf(c));
    const glow = fills.find((f) => f.style === c);
    expect(log[glow.at]).toEqual(['fill', 'evenodd']); // the shape lies in the disc: the disc with the shape as a hole, no clip
    expect(log.some((call) => call[0] === 'clip')).toBe(false);
    const small = sceneOf(c, { type: 'persona' });
    small.nodes[0].glow = 2; // a diamond's points reach past a small glow's disc: clipped to everything but the shape instead
    const clipped = canvasNode(small);
    expect(clipped.clip).toEqual(['clip', 'evenodd']);
    expect(clipped.clipAt).toBeLessThan(clipped.fills.find((f) => f.style === c).at);
  });

  // The glow Canvas 2D draws, point by point, against the shader's own shape: inside the silhouette, none; in the disc outside it, all of it.
  // With the glow a theme turns down (`--corn-map-glow`), a diamond's or a square's corners reach past the glow disc, and must still have none.
  describe.each(Object.entries(SHAPES))('the %s silhouette (%s)', (shape, type) => {
    it.each([9, 2])('the glow (%s) is everywhere in its disc but inside the node\'s silhouette', (glowSize) => {
      const scene = sceneOf('#aabbccdd', { type });
      const node = scene.nodes[0];
      expect(node.shape).toBe(shape);
      node.glow = glowSize;
      const inGlow = glowRegion(scene);
      const disc = node.r + glowSize * 0.7;
      let inside = 0, ring = 0;
      for (let y = -30; y <= 30; y += 0.5) for (let x = -30; x <= 30; x += 0.5) {
        const sd = sdShape([x, y], node.r, shape), d = Math.hypot(x, y) - disc;
        if (Math.abs(sd) < 0.25 || Math.abs(d) < 0.25) continue; // on an edge: the anti-aliasing's
        const want = d < 0 && sd > 0;
        if (inGlow([x, y]) !== want) throw new Error(`at (${x}, ${y}) the glow is ${want ? 'missing' : 'drawn'}`);
        if (sd < 0) inside++; else if (d < 0) ring++;
      }
      expect(inside).toBeGreaterThan(100);
      if (glowSize > 5) expect(ring).toBeGreaterThan(100);
    });

    it('an opaque colour keeps the whole glow disc, as before', () => {
      const scene = sceneOf('#aabbcc', { type });
      const inGlow = glowRegion(scene);
      expect(inGlow([0, 0])).toBe(true);
      expect(inGlow([scene.nodes[0].r + 1, 0])).toBe(true);
    });
  });

  it('WebGL\'s node shader draws a translucent node\'s glow only where its fill is not, as one layer, and an opaque one as it always was', () => {
    const src = String(NODE_FRAG);
    const main = src.slice(src.indexOf('void main()'));
    const at = (re) => { const m = re.exec(main); expect(m, String(re)).not.toBeNull(); return m.index; };
    // how much of the pixel the silhouette covers: the shape sdShape gives (the shapes the Canvas 2D clip is held to above)
    const cover = at(/float shapeCover = coverEdge\(sdShape\(v_local, R, shapeCode, len\), pix\);/);
    // a translucent colour (its alpha, v_kind.z, packed from the colour: the first test) takes one layer: the glow where the fill does not
    // cover, the fill where it does. Two layers there would let the ground through both at the edge (a dark line round a square)
    const branch = at(/if \(v_kind\.z < 1\.0\) \{\s*float soft = glow > 0\.0 \? glowDisc\(len, R, glow \* 0\.5 \/ u_dpr\) : 0\.0;\s*over\(acc, v_color\.rgb, v_kind\.z \* al \* mix\(soft, 1\.0, shapeCover\)\);\s*\} else \{/);
    // an opaque one: the glow, then the fill over it, exactly as before this change
    const opaque = at(/\} else \{\s*if \(glow > 0\.0\) over\(acc, v_color\.rgb, v_kind\.z \* al \* glowDisc\(len, R, glow \* 0\.5 \/ u_dpr\)\);\s*over\(acc, v_color\.rgb, v_kind\.z \* al \* shapeCover\);\s*\}/);
    expect(cover).toBeLessThan(branch);
    expect(branch).toBeLessThan(opaque);
    // and nothing else draws the node's colour
    expect(main.match(/over\(acc, v_color\.rgb/g)).toHaveLength(3);
  });

  const cuts = (log) => log.some((call) => call[0] === 'clip' || (call[0] === 'fill' && call[1] === 'evenodd'));
  it.each(['#aabbcc', '#aabbccff', 'rgb(170, 187, 204)', 'rgba(170, 187, 204, 1)'])('an opaque colour (%s) is drawn as it always was: nothing cut', (c) => {
    expect(cuts(canvasNode(sceneOf(c)).log)).toBe(false);
    const small = sceneOf(c, { type: 'persona' });
    small.nodes[0].glow = 2;
    expect(cuts(canvasNode(small).log)).toBe(false);
  });

  it('a node with no glow (dimmed by a focus) has no glow to cut', () => {
    const dimmed = sceneOf('#aabbccdd');
    dimmed.nodes[0].glow = 0;
    expect(cuts(canvasNode(dimmed).log)).toBe(false);
  });
});

describe('the ink of a glyph is chosen against what the translucent fill looks like', () => {
  it('a pale translucent fill reads dark over the light ground and as a dark fill over the dark ground', () => {
    const fill = 'rgba(255, 255, 255, 0.2)';
    expect(inkFor(fill, DARK_GROUND)).toBe(INK_LIGHT); // a faint white over the dark ground is still dark
    expect(inkFor(fill, LIGHT_GROUND)).toBe(INK_DARK); // and over the light ground it is nearly the ground
    expect(glyphInk({ color: fill }, null, 'light')).toBe(INK_DARK);
    expect(glyphInk({ color: fill }, null, 'dark')).toBe(INK_LIGHT);
  });
  it('over the ground the theme sets, not only light or dark: a mid-grey ground', () => {
    const grey = { values: {}, ground: '#808080' };
    // a faint white over mid-grey is a light grey: dark ink (7.7:1), where white would be 2.4:1
    expect(glyphInk({ color: 'rgba(255, 255, 255, 0.3)' }, grey, 'dark')).toBe(INK_DARK);
    // a faint black over mid-grey is a dark grey: white ink (6.9:1), where the dark ink would be 2.7:1
    expect(glyphInk({ color: 'rgba(0, 0, 0, 0.3)' }, grey, 'light')).toBe(INK_LIGHT);
    // the map style reads that ground from the theme, through the same colour reader as every map token
    expect(readMapTokens((name) => (name === '--corn-ground' ? ' #808080 ' : '')).ground).toBe('#808080');
    expect(readMapTokens((name) => (name === '--corn-ground' ? 'url(x)' : '')).ground).toBeNull();
  });
  it('WebGL packs its glyph rows again when the ground changes, and only then (Canvas 2D asks for the ink at every draw)', () => {
    const gl = fakeGl();
    let style = { values: {}, ground: null, plain: true, version: 1 };
    const r = createWebglRenderer(fakeCanvas({ webgl2: gl }), { mapStyle: () => style });
    r.resize(800, 600, 1);
    const uploads = () => callsOf(gl, 'bufferData').length;
    const scene = sceneOf('rgba(255, 255, 255, 0.3)');
    r.draw(scene, { x: 400, y: 300, zoom: 1 }, 0);
    const first = uploads();
    r.draw(scene, { x: 400, y: 300, zoom: 1 }, 0);
    expect(uploads()).toBe(first); // the same scene on the same ground: nothing packed again
    style = { ...style, ground: '#808080', version: 2 };
    r.draw(scene, { x: 400, y: 300, zoom: 1 }, 0);
    expect(uploads()).toBeGreaterThan(first); // a theme's ground arrived: packed again, so the glyph takes the ink that reads on it
  });
  it('an opaque fill is read as before, whatever the ground', () => {
    for (const ground of [DARK_GROUND, LIGHT_GROUND, '#808080']) { expect(inkFor('#38bdf8', ground)).toBe(INK_DARK); expect(inkFor('#1e1b4b', ground)).toBe(INK_LIGHT); }
    expect(inkFor('#38bdf8')).toBe(INK_DARK);
  });
});

describe('the Layers menu dot of a translucent node', () => {
  const body = /<body>([\s\S]*)<\/body>/.exec(explorerPage())[1].replace(/<script[\s\S]*?<\/script>/g, '');
  beforeEach(() => { document.body.innerHTML = body; });
  afterEach(() => { document.body.innerHTML = ''; document.documentElement.style.removeProperty('--corn-ground'); document.documentElement.style.removeProperty('--corn-surface-1'); });
  const show = (color) => {
    document.documentElement.style.setProperty('--corn-ground', '#ffffff');
    document.documentElement.style.setProperty('--corn-surface-1', '#ffffff');
    const nodes = [{ id: 'root', type: 'root', x: 0, y: 0, r: 20, color: '#f59e0b', label: 'root' }, { id: 'a', type: 'service', x: 0, y: 0, r: 20, color, label: 'a' }];
    Object.assign(state, { nodes, edges: [], theme: 'light', view: 'orbit', runsMap: null, proposal: null, flow: null, activeLayers: {} });
    setProjectLayers({ add: [{ key: 'ok', label: 'Ok', match: { type: 'service' } }] });
    renderLayerToggles();
    return document.querySelector('[data-action="toggle-layer"][data-layer="ok"]').querySelector('[data-corn="swatch"]');
  };
  it('is the node\'s colour with its alpha, and is outlined when it is pale over the menu even though the colour alone is strong', () => {
    const opaque = show('rgb(75, 47, 224)');
    expect(opaque.classList.contains('is-ringed')).toBe(false);
    const faint = show('rgba(75, 47, 224, 0.2)');
    expect(faint.style.backgroundColor.replace(/\s/g, '')).toBe('rgba(75,47,224,0.2)');
    expect(faint.classList.contains('is-ringed')).toBe(true);
  });
});

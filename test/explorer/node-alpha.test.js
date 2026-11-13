// @vitest-environment happy-dom
/**
 * A node's own `color` with an alpha (`#aabbccdd`, `rgba(…, 0.5)`; issue #233). It means: the colour as written, drawn translucent over whatever is
 * under the node (the ground, a line that ends at it, a neighbour's glow), in both renderers, with the node's own glow left out under the fill so
 * the fill alone sets what is seen through it. It is not blended with the ground at build time: the ground is the theme's to say (a theme can
 * set it), and a line or a neighbour is under a node as often as the ground. These tests read what each renderer is handed and what it does with it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { explorerPage } from '../helpers.js';
import { recordingCtx } from './fake-gl.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { createCanvas2dRenderer } from '../../explorer/renderer-canvas2d.js';
// @ts-expect-error plain JS modules, no declarations
import { packNodes, NODE_STRIDE } from '../../explorer/renderer-webgl.js';
// @ts-expect-error plain JS modules, no declarations
import { NODE_FRAG } from '../../explorer/shaders.js';
// @ts-expect-error plain JS modules, no declarations
import { parseColor } from '../../explorer/theme-model.js';
// @ts-expect-error plain JS modules, no declarations
import { INK_DARK, INK_LIGHT, inkFor, glyphInk } from '../../explorer/glyphs.js';
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
const SHAPES = ['table', 'store', 'service', 'page', 'external', 'person'];

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
  it.each(TRANSLUCENT)('Canvas 2D clips the glow disc (even-odd) with the node\'s own shape cut out of it, %s', (c) => {
    const { clip, clipAt, fills } = canvasNode(sceneOf(c));
    expect(clip).toEqual(['clip', 'evenodd']);
    const glow = fills.find((f) => f.style === c);
    expect(clipAt).toBeLessThan(glow.at); // the clip is set before the glow is filled
  });

  it.each(SHAPES)('and for the %s shape, whose silhouette is not a circle, the hole is that shape', (type) => {
    const { log, clip } = canvasNode(sceneOf('#aabbccdd', { type }));
    expect(clip).toEqual(['clip', 'evenodd']);
    // two subpaths in the clipped path: the glow's circle, then the shape (a circle: moveTo + arc; the rest: their own path)
    const arcs = log.filter((c) => c[0] === 'arc').length;
    const shapes = log.filter((c) => ['roundRect', 'rect', 'lineTo'].includes(c[0])).length;
    expect(arcs + shapes).toBeGreaterThan(1);
  });

  it('WebGL\'s node shader multiplies the glow by "not under the fill" only when the colour is translucent', () => {
    const src = String(NODE_FRAG);
    expect(src).toMatch(/glowDisc\([^;]*\) \* \(v_kind\.z < 1\.0 \? 1\.0 - cover : 1\.0\)/);
    // the fill is the same coverage, so what is cut out of the glow is what the fill covers
    expect(src).toMatch(/over\(acc, v_color\.rgb, v_kind\.z \* al \* cover\)/);
  });

  it.each(['#aabbcc', '#aabbccff', 'rgb(170, 187, 204)', 'rgba(170, 187, 204, 1)'])('an opaque colour (%s) is drawn as it always was: no clip', (c) => {
    expect(canvasNode(sceneOf(c)).clip).toBeNull();
  });

  it('a node with no glow (dimmed by a focus) has no glow to clip', () => {
    const dimmed = sceneOf('#aabbccdd');
    dimmed.nodes[0].glow = 0;
    expect(canvasNode(dimmed).clip).toBeNull();
  });
});

describe('the ink of a glyph is chosen against what the translucent fill looks like', () => {
  it('a pale translucent fill reads dark over the light ground and as a dark fill over the dark ground', () => {
    const fill = 'rgba(255, 255, 255, 0.2)';
    expect(inkFor(fill, 'dark')).toBe(INK_LIGHT); // a faint white over the dark ground is still dark
    expect(inkFor(fill, 'light')).toBe(INK_DARK); // and over the light ground it is nearly the ground
    expect(glyphInk({ color: fill }, null, 'light')).toBe(INK_DARK);
    expect(glyphInk({ color: fill }, null, 'dark')).toBe(INK_LIGHT);
  });
  it('an opaque fill is read as before, whatever the ground', () => {
    for (const theme of ['dark', 'light']) { expect(inkFor('#38bdf8', theme)).toBe(INK_DARK); expect(inkFor('#1e1b4b', theme)).toBe(INK_LIGHT); }
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

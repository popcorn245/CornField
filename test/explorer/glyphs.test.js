// @vitest-environment happy-dom
/**
 * The type glyphs and the silhouettes (spec 0008 D8): every type has a silhouette and a glyph, the glyph reads on every fill of the default palette
 * (3:1, white or dark ink), it sits where a theme icon and kind letters sit and yields to both, its textures are bounded, and the Canvas 2D renderer draws the
 * silhouette of each family. The WebGL half is the shader's and is held in renderer-webgl-edges.test.js and shaders tests.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { NODE_SHAPES, NODE_THEMES } from '../../core/schema.js';
import { lightColor, parseColor } from '../../explorer/theme-model.js';
import { luminance, ratio } from '../../core/color.js';
// @ts-expect-error plain JS modules, no declarations
import { GLYPH_MIN_PX, GLYPH_TYPES, INK_DARK, INK_LIGHT, MAX_GLYPH_IMAGES, forgetGlyphImages, glyphImage, glyphInk, glyphKey, glyphOfKey, hasGlyph, inkFor, isGlyphKey, showsGlyph } from '../../explorer/glyphs.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { createCanvas2dRenderer, silhouette } from '../../explorer/renderer-canvas2d.js';
// @ts-expect-error plain JS modules, no declarations
import { packIcons, packNodes, NODE_STRIDE, SHAPE_CODE, GLYPH_FLAG } from '../../explorer/renderer-webgl.js';
// @ts-expect-error plain JS modules, no declarations
import { NODE_VERT, NODE_FRAG } from '../../explorer/shaders.js';

afterEach(() => { vi.unstubAllGlobals(); forgetGlyphImages(); });

const node = (id, type, x, extra = {}) => ({ id, type, x, y: 0, r: 20, color: NODE_THEMES[type] ? NODE_THEMES[type].color : '#336699', label: id, ...extra });
const mk = (nodes) => ({ nodes, edges: [], view: 'orbit', flow: null, rings: { rings: [], clusters: [] }, selectedNode: null, searchQuery: '', isFreeform: false, activeLayers: {}, scenario: null, sceneVersion: 1, theme: 'dark', projectLayers: [] });
const plain = { version: 1, values: {}, strokeWidth: 1.5, icons: null, pixelated: false, plain: true };

describe('every type', () => {
  it('has a glyph, and the scene gives each node its silhouette and its glyph', () => {
    expect([...GLYPH_TYPES].sort()).toEqual(Object.keys(NODE_THEMES).sort());
    const types = Object.keys(NODE_THEMES);
    const scene = buildScene(mk(types.map((t, i) => node(t, t, i * 50))));
    for (const n of scene.nodes) { expect(n.shape, n.type).toBe(NODE_SHAPES[n.type]); expect(n.glyph, n.type).toBe(n.type); }
    expect(hasGlyph('constructor')).toBe(false); // a type a project invents has none: it only selects from the table
    expect(hasGlyph('__proto__')).toBe(false);
    expect(buildScene(mk([node('x', 'invented', 0)])).nodes[0]).toMatchObject({ shape: 'circle' });
    expect(buildScene(mk([node('x', 'invented', 0)])).nodes[0].glyph).toBeUndefined();
  });
  it('reads at 3:1 on every fill of the default palette, on both grounds, in white or dark ink', () => {
    const bad = [];
    for (const mode of ['dark', 'light']) for (const type of GLYPH_TYPES) {
      const fill = mode === 'light' ? lightColor(NODE_THEMES[type].color) : NODE_THEMES[type].color;
      const ink = inkFor(fill);
      expect([INK_LIGHT, INK_DARK]).toContain(ink);
      const r = ratio(luminance(parseColor(ink).slice(0, 3)), luminance(parseColor(fill).slice(0, 3)));
      if (r < 3) bad.push(`${mode} ${type} ${r.toFixed(2)}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('where the glyph sits', () => {
  it('is drawn at 14 px across, and yields to a theme icon and to a finer kind\'s letters', () => {
    expect(GLYPH_MIN_PX).toBe(14);
    expect(showsGlyph({ glyph: 'page', r: 20 }, 0.34)).toBe(false);
    expect(showsGlyph({ glyph: 'page', r: 20 }, 0.35)).toBe(true);
    expect(showsGlyph({ glyph: 'page', r: 20, icon: 'page' }, 1)).toBe(false);
    expect(showsGlyph({ glyph: 'service', r: 20, letters: 'j' }, 1)).toBe(false);
    expect(showsGlyph({ r: 20 }, 1)).toBe(false);
  });
  it('packs after a theme icon and letters in the WebGL icon pass, one group per type and ink, so the textures are few', () => {
    const scene = buildScene(mk([node('a', 'page', 0), node('b', 'page', 50), node('c', 'table', 100), node('j', 'service', 150, { kind: 'job' })]));
    const p = packIcons(scene, () => true, plain);
    expect(p.groups.map((g) => g.kind)).toEqual([glyphKey('page', glyphInk({ color: NODE_THEMES.page.color }, plain)), glyphKey('table', glyphInk({ color: NODE_THEMES.table.color }, plain)), 'letters:j']);
    expect(p.groups[0].count).toBe(2); // the two pages share one texture
    const icon = buildScene(mk([node('a', 'page', 0)]));
    icon.nodes[0].icon = 'page';
    expect(packIcons(icon, (k) => k === 'page', plain).groups.map((g) => g.kind)).toEqual(['page']);
  });
  it('makes at most MAX_GLYPH_IMAGES images, whatever inks a theme asks for', () => {
    const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
    vi.stubGlobal('OffscreenCanvas', class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return ctx; } });
    let made = 0;
    for (let i = 0; i < MAX_GLYPH_IMAGES + 20; i++) if (glyphImage('page', `#${(0x100000 + i).toString(16)}`)) made++;
    expect(made).toBe(MAX_GLYPH_IMAGES);
    expect(glyphImage('nonsense', '#fff')).toBeNull();
    expect(isGlyphKey(glyphKey('page', '#fff'))).toBe(true);
    expect(glyphOfKey(glyphKey('page', 'rgb(1, 2, 3)'))).toEqual({ type: 'page', ink: 'rgb(1, 2, 3)' });
  });
  it('takes the theme\'s ink when it sets one', () => {
    expect(glyphInk({ color: '#38bdf8' }, { values: { '--corn-map-glyph': '#112233' } })).toBe('#112233');
    expect(glyphInk({ color: '#38bdf8' }, plain)).toBe(INK_DARK);
    expect(glyphInk({ color: '#1e1b4b' }, plain)).toBe(INK_LIGHT);
  });
});

describe('the core dot', () => {
  const rec = () => { const log = []; return { log, ctx: new Proxy({}, { get: (_t, k) => (...a) => { log.push([k, ...a]); }, set: () => true }) }; };
  it('gives way to the glyph once the glyph shows, in Canvas 2D: the glyph is drawn in its place, never over it', () => {
    const glyphCtx = new Proxy({}, { get: () => () => {}, set: () => true });
    vi.stubGlobal('OffscreenCanvas', class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return glyphCtx; } });
    const coreArcs = (zoom) => {
      const { log, ctx } = rec();
      const r = createCanvas2dRenderer({ getContext: () => ctx, style: {}, parentElement: {} }, { mapStyle: () => plain });
      r.resize(400, 300, 1);
      log.length = 0;
      r.draw(buildScene(mk([node('p', 'page', 0)])), { x: 200, y: 150, zoom }, 0);
      return { arcs: log.filter((c) => c[0] === 'arc' && Math.abs(c[3] - 20 * 0.32) < 1e-9).length, images: log.filter((c) => c[0] === 'drawImage').length };
    };
    expect(coreArcs(1)).toEqual({ arcs: 0, images: 1 }); // 40 px across: the glyph, no dot under it
    expect(coreArcs(0.3)).toEqual({ arcs: 1, images: 0 }); // 12 px across: no glyph, so the dot
  });
});

describe('silhouettes', () => {
  const rec = () => { const log = []; return { log, ctx: new Proxy({}, { get: (_t, k) => (...a) => { log.push([k, ...a]); }, set: () => true }) }; };
  it('Canvas 2D draws a circle, a rounded square, a hexagon, a square and a diamond', () => {
    const verbs = (shape) => { const { log, ctx } = rec(); silhouette(ctx, shape, 0, 0, 20); return log.map((c) => c[0]); };
    expect(verbs('circle')).toEqual(['beginPath', 'arc']);
    expect(verbs('rounded-square')).toEqual(['beginPath', 'roundRect']);
    expect(verbs('square')).toEqual(['beginPath', 'roundRect']);
    expect(verbs('hexagon').filter((v) => v === 'lineTo')).toHaveLength(5);
    expect(verbs('diamond').filter((v) => v === 'lineTo')).toHaveLength(3);
    expect(verbs('nonsense')).toEqual(['beginPath', 'arc']); // anything else is the circle
    const { log, ctx } = rec();
    silhouette(ctx, 'square', 0, 0, 20);
    expect(log[1].slice(1)).toEqual([-17.2, -17.2, 34.4, 34.4, 2.4]); // a square is a little smaller than the circle it is hit-tested by
  });
  it('the renderer fills each node in its own silhouette', () => {
    const { log, ctx } = rec();
    const r = createCanvas2dRenderer({ getContext: () => ctx, style: {}, parentElement: {} }, { mapStyle: () => plain });
    r.resize(400, 300, 1);
    log.length = 0;
    r.draw(buildScene(mk([node('s', 'store', 0), node('e', 'external', 50), node('p', 'persona', 100), node('m', 'machine', 150)])), { x: 200, y: 150, zoom: 1 }, 0);
    expect(log.filter((c) => c[0] === 'roundRect').length).toBeGreaterThanOrEqual(2); // the store and the machine
    expect(log.filter((c) => c[0] === 'closePath').length).toBeGreaterThanOrEqual(2); // the hexagon and the diamond
  });
  it('WebGL numbers them and the node shader draws each; the codes are the packed row\'s last float', () => {
    expect(SHAPE_CODE).toEqual({ circle: 0, 'rounded-square': 1, hexagon: 2, square: 3, diamond: 4 });
    const scene = buildScene(mk([node('s', 'store', 0), node('e', 'external', 50), node('p', 'persona', 100), node('a', 'app', 150)]));
    const packed = packNodes(scene);
    expect(NODE_STRIDE).toBe(12);
    expect([0, 1, 2, 3].map((i) => packed.data[i * NODE_STRIDE + 11])).toEqual([1, 2, 4, 0].map((c) => c + GLYPH_FLAG)); // each has a glyph, so the shader leaves its core dot out once it shows
    expect(packNodes({ ...scene, nodes: scene.nodes.map((n) => ({ ...n, letters: 'ab' })) }).data[11]).toBe(1); // letters (or a theme's icon) keep the dot
    expect(NODE_FRAG).toMatch(/u_glyphMin/);
    expect(NODE_FRAG).toMatch(/sdShape/);
    expect(NODE_FRAG).toMatch(/sdHex/);
    expect(NODE_VERT).toMatch(/shape code/);
  });
});

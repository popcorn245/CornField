// @vitest-environment happy-dom
/**
 * Finer kinds on the map (spec 0009 D5): the letters a node with a `kind` shows in its core, in the scene, in Canvas 2D and in WebGL,
 * once the node is wide enough on screen, replaced by a theme's icon, and never an error for a kind nobody has heard of.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fakeGl, fakeCanvas, callsOf, recordingCtx } from './fake-gl.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { LETTER_MIN_PX, LETTER_RATIO, letterImage, letterKey, showsLetters } from '../../explorer/kind-letters.js';
// @ts-expect-error plain JS modules, no declarations
import { createCanvas2dRenderer } from '../../explorer/renderer-canvas2d.js';
// @ts-expect-error plain JS modules, no declarations
import { createWebglRenderer, packIcons } from '../../explorer/renderer-webgl.js';
// @ts-expect-error plain JS modules, no declarations
import { ICON_RATIO } from '../../explorer/map-style.js';

const node = (id, type, x, extra = {}) => ({ id, type, x, y: 0, r: 20, color: '#336699', label: id, ...extra });
const nodes = [
  node('root', 'root', 0), node('j', 'service', 100, { kind: 'job' }), node('h', 'service', 200, { kind: 'hook' }), node('w', 'service', 300, { kind: 'webhook' }),
  node('pg', 'page', 400), node('cl', 'external', 500, { kind: 'cloud' }), node('odd', 'service', 600, { kind: '<b>x</b>' }),
];
const state = (extra = {}) => ({ nodes, edges: [], view: 'orbit', flow: null, rings: { rings: [], clusters: [] }, selectedNode: null, searchQuery: '', isFreeform: false, activeLayers: {}, scenario: null, sceneVersion: 1, theme: 'dark', projectLayers: [], ...extra });
const scene = () => buildScene(state());
const byId = (s, id) => s.nodes.find((n) => n.id === id);
const plain = { version: 1, values: {}, strokeWidth: 1.5, icons: null, pixelated: false, plain: true };

afterEach(() => vi.unstubAllGlobals());

/** A canvas that can draw text, so the letters' image can be made in a test */
function withCanvas() {
  const drawn = [];
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'fillText' || k === 'strokeText' ? (...a) => drawn.push([k, ...a]) : () => {}), set: () => true });
  vi.stubGlobal('OffscreenCanvas', class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return ctx; } });
  return drawn;
}

describe('the scene', () => {
  it('gives a node with a kind its letters: the shortest start no other kind of its type shares', () => {
    const s = scene();
    expect(byId(s, 'j').letters).toBe('j');
    expect(byId(s, 'h').letters).toBe('h');
    expect(byId(s, 'w').letters).toBe('w');
    expect(byId(s, 'j').kind).toBe('job');
  });
  it('gives none to a node with no kind, nor to an outside node (its kind is its layer)', () => {
    const s = scene();
    expect(byId(s, 'pg').letters).toBeUndefined();
    expect(byId(s, 'cl').letters).toBeUndefined();
    expect(byId(s, 'root').letters).toBeUndefined();
  });
  it('takes any text for a kind, as text: it is one more kind, never an error', () => {
    expect(byId(scene(), 'odd').letters).toBe('<');
  });
  it('names the project layer that takes the node, for the theme\'s colour and icon', () => {
    const s = buildScene(state({ projectLayers: [{ key: 'jobs', label: 'Jobs', match: { kind: ['job'] } }] }));
    expect(byId(s, 'j').layer).toBe('jobs');
    expect(byId(s, 'h').layer).toBeUndefined();
  });
});

describe('when they are drawn', () => {
  it('once the node is at least 14 px across', () => {
    expect(LETTER_MIN_PX).toBe(14);
    const n = { letters: 'j', r: 20 };
    expect(showsLetters(n, 0.34)).toBe(false);
    expect(showsLetters(n, 0.35)).toBe(true);
    expect(showsLetters({ letters: 'j', r: 7 }, 1)).toBe(true);
    expect(showsLetters({ letters: 'j', r: 6.9 }, 1)).toBe(false);
  });
  it('not for a node with no letters, nor one a theme icon replaces', () => {
    expect(showsLetters({ r: 20 }, 1)).toBe(false);
    expect(showsLetters({ letters: 'j', r: 20, icon: 'service:job' }, 1)).toBe(false);
  });
  it('makes the image of some letters once, text only, and none where there is no canvas', () => {
    expect(letterImage('')).toBeNull();
    const drawn = withCanvas();
    const a = letterImage('zq');
    expect(a).not.toBeNull();
    expect(letterImage('zq')).toBe(a);
    expect(drawn.filter((d) => d[0] === 'fillText').map((d) => d[1])).toEqual(['zq']);
    expect(letterKey('j')).toBe('letters:j');
  });
});

describe('Canvas 2D', () => {
  const draw = (sc, zoom) => {
    const ctx = recordingCtx();
    const r = createCanvas2dRenderer({ getContext: () => ctx, style: {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ width: 800, height: 600 }) }, { mapStyle: () => plain });
    r.resize(800, 600, 1);
    ctx.log.length = 0;
    r.draw(sc, { x: 0, y: 0, zoom }, 0);
    return ctx.log.filter((c) => c[0] === 'drawImage');
  };
  it('draws the letters over the node as an image, the size of a theme icon\'s square, once per node with a kind', () => {
    withCanvas();
    const calls = draw(scene(), 1);
    expect(calls).toHaveLength(4); // j, h, w and the odd one
    const j = byId(scene(), 'j');
    const side = j.r * LETTER_RATIO;
    expect(calls[0].slice(2)).toEqual([j.x - side / 2, j.y - side / 2, side, side]);
  });
  it('draws none when the node is under 14 px across, and none where no canvas can make the image', () => {
    withCanvas();
    expect(draw(scene(), 0.3)).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

describe('WebGL', () => {
  const sc = () => scene();
  it('packs the letters like icons: a group per letters, in scene order, saying its smallest node\'s radius', () => {
    const p = packIcons(sc(), () => true);
    expect(p.groups.map((g) => g.kind)).toEqual(['letters:j', 'letters:h', 'letters:w', 'letters:<']);
    expect(p.groups.every((g) => g.count === 1 && g.minR === 20)).toBe(true);
    expect(p.data[2]).toBe(Math.fround(20 * LETTER_RATIO));
  });
  it('lets a theme icon replace the letters, and packs none for letters it cannot make', () => {
    const s = sc();
    byId(s, 'j').icon = 'service';
    const p = packIcons(s, (k) => k === 'service');
    expect(p.groups.map((g) => g.kind)).toEqual(['service']);
    expect(p.data[2]).toBe(Math.fround(20 * ICON_RATIO));
    expect(packIcons(sc(), (k) => !k.startsWith('letters:')).count).toBe(0);
  });
  const make = (camera) => {
    const gl = fakeGl();
    const r = createWebglRenderer(fakeCanvas({ webgl2: gl }), { mapStyle: () => plain });
    r.resize(800, 600, 1);
    r.draw(sc(), camera, 0);
    return gl;
  };
  it('draws them in the icon pass, from one texture each, smooth even in a pixelated theme', () => {
    withCanvas();
    const gl = make({ x: 0, y: 0, zoom: 1 });
    expect(callsOf(gl, 'createTexture')).toHaveLength(4);
    const draws = callsOf(gl, 'drawArraysInstanced').map((c) => c.slice(1));
    expect(draws.slice(-4)).toEqual(Array(4).fill(['TRIANGLE_STRIP', 0, 4, 1]));
  });
  it('draws none when the nodes are under 14 px across', () => {
    withCanvas();
    const gl = make({ x: 0, y: 0, zoom: 0.3 });
    expect(callsOf(gl, 'createTexture')).toHaveLength(0);
  });
});

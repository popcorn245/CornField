/**
 * @vitest-environment node
 *
 * The WebGL2 renderer (TOPO-03). There is no GPU in CI, so nothing here makes a real GL
 * context: the packing of a scene into the typed arrays handed to GL is a pure function and is
 * tested on a small hand-made scene; the renderer's call sequence is tested against a fake GL
 * object that records every call.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { packNodes, packDecor, NODE_STRIDE, RING_STRIDE, LANE_STRIDE, GRID_STRIDE, HALO_CODE, MARK_CODE, styleTables } from '../../explorer/renderer-webgl.js';
// @ts-expect-error plain JS modules, no declarations
import { HALO, MARK, MARK_MIN_PX, CORE_RATIO, DIM_ALPHA } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { NODE_VERT, NODE_FRAG, EDGE_FRAG, edgeVert } from '../../explorer/shaders.js';

const snode = (extra         = {})      => ({
  id: 'n', type: 'page', x: 10, y: -20, r: 18, color: '#ff8000', alpha: 1, glow: 9, halo: 'none', mark: 'none',
  selected: false, match: false, connected: true, label: 'n', labelSize: 11, labelBold: false, labelAlpha: 1, labelColor: '#f8fafc', labelKeep: false, ...extra,
});
const scene = (extra         = {})      => ({
  nodes: [], edges: [], decor: { grid: null, rings: [], lanes: [] }, preset: false, version: 1, ...extra,
});
const row = (packed     , i        ) => Array.from(packed.data.slice(i * packed.stride, (i + 1) * packed.stride));

describe('packNodes', () => {
  it('is empty for an empty scene', () => {
    const p = packNodes(scene());
    expect(p.count).toBe(0);
    expect(p.data.length).toBe(0);
    expect(p.stride).toBe(NODE_STRIDE);
  });

  it('packs one row of NODE_STRIDE floats per node, in draw order', () => {
    const p = packNodes(scene({ nodes: [snode({ id: 'a', x: 1 }), snode({ id: 'b', x: 2 }), snode({ id: 'c', x: 3 })] }));
    expect(p.count).toBe(3);
    expect(p.data).toBeInstanceOf(Float32Array);
    expect(p.data.length).toBe(3 * NODE_STRIDE);
    expect([row(p, 0)[0], row(p, 1)[0], row(p, 2)[0]]).toEqual([1, 2, 3]);
  });

  it('puts position, radius and alpha first, then the colour (0..1) and glow, then halo, mark and the colour alpha', () => {
    const p = packNodes(scene({ nodes: [snode({ x: 10, y: -20, r: 18, alpha: DIM_ALPHA, glow: 15, color: '#ff8000', halo: 'selected', mark: 'changed' })] }));
    const r = row(p, 0);
    expect(r.slice(0, 4)).toEqual([10, -20, 18, Math.fround(DIM_ALPHA)]);
    expect(r[4]).toBeCloseTo(1, 6);
    expect(r[5]).toBeCloseTo(128 / 255, 6);
    expect(r[6]).toBeCloseTo(0, 6);
    expect(r[7]).toBe(15);
    expect(r[8]).toBe(HALO_CODE.selected);
    expect(r[9]).toBe(MARK_CODE.changed);
    expect(r[10]).toBe(1);
  });

  it('gives each halo its own code, and 0 for none or anything unknown', () => {
    expect(HALO_CODE).toEqual({ none: 0, selected: 1, match: 2, child: 3 });
    for (const halo of Object.keys(HALO_CODE)) {
      const r = row(packNodes(scene({ nodes: [snode({ halo })] })), 0);
      expect(r[8]).toBe(HALO_CODE[halo]);
    }
    expect(row(packNodes(scene({ nodes: [snode({ halo: 'sparkle' })] })), 0)[8]).toBe(0);
  });

  it('gives each mark its own code', () => {
    expect(MARK_CODE).toEqual({ none: 0, added: 1, changed: 2, removed: 3, edit: 4 });
    for (const mark of Object.keys(MARK_CODE)) {
      const r = row(packNodes(scene({ nodes: [snode({ mark })] })), 0);
      expect(r[9]).toBe(MARK_CODE[mark]);
    }
    expect(row(packNodes(scene({ nodes: [snode({ mark: 'weird' })] })), 0)[9]).toBe(0);
  });

  it('keeps the alpha the scene set: buildScene has already faded a removed node (MARK.removed.alpha), so no renderer fades it again', () => {
    const removed = row(packNodes(scene({ nodes: [snode({ mark: 'removed', alpha: MARK.removed.alpha })] })), 0);
    expect(removed[3]).toBeCloseTo(MARK.removed.alpha, 6);
    const dimmed = row(packNodes(scene({ nodes: [snode({ mark: 'removed', alpha: DIM_ALPHA })] })), 0);
    expect(dimmed[3]).toBeCloseTo(DIM_ALPHA, 6);
    expect(row(packNodes(scene({ nodes: [snode({ mark: 'added' })] })), 0)[3]).toBe(1);
  });

  it('carries the alpha of an rgba colour in its own slot, not in the node alpha', () => {
    const r = row(packNodes(scene({ nodes: [snode({ color: 'rgba(0, 255, 0, 0.5)', alpha: 0.5 })] })), 0);
    expect(r[3]).toBe(0.5);
    expect(r[10]).toBe(0.5);
    expect(r[5]).toBe(1);
  });
});

describe('styleTables (the looks in scene.js, handed to the shaders as uniforms)', () => {
  const t = styleTables();

  it('has an entry per halo code with the fill colour, ring colour and the radii of scene.js HALO', () => {
    for (const [name, code] of Object.entries(HALO_CODE)                      ) {
      if (!code) continue;
      const look = (HALO       )[name];
      expect(t.haloGeom[code * 4]).toBe(look.fillR);
      expect(t.haloGeom[code * 4 + 1]).toBe(look.ringR);
      expect(t.haloGeom[code * 4 + 2]).toBeCloseTo(look.ringWidth, 5);
      expect(t.haloRing[code * 4 + 3]).toBeGreaterThan(0);
      expect(t.haloFill[code * 4 + 3] > 0).toBe(!!look.fill);
    }
    expect(Array.from(t.haloRing.slice(0, 4))).toEqual([0, 0, 0, 0]);
  });

  it('has the selected halo ring in #818cf8 and the child ring at alpha 0.28', () => {
    const ring = (code        ) => Array.from(t.haloRing.slice(code * 4, code * 4 + 4))            ;
    expect(ring(HALO_CODE.selected).map((v) => Math.round(v * 255)).slice(0, 3)).toEqual([0x81, 0x8c, 0xf8]);
    expect(ring(HALO_CODE.child)[3]).toBeCloseTo(0.28, 6);
  });

  it('has a colour per mark code and the ring look', () => {
    const mark = (code        ) => Array.from(t.markColor.slice(code * 4, code * 4 + 4))            ;
    expect(mark(MARK_CODE.none)).toEqual([0, 0, 0, 0]);
    expect(mark(MARK_CODE.removed).map((v) => Math.round(v * 255)).slice(0, 3)).toEqual([1, 3, 5].map((i) => parseInt(MARK.removed.color.slice(i, i + 2), 16)));
    expect(t.core[3]).toBe(1);
    expect(t.coreRatio).toBe(CORE_RATIO);
  });

  it('has the ring geometry of each mark, indexed by mark code like the colours: u_markGeom[5]', () => {
    expect(t.markGeom).toBeInstanceOf(Float32Array);
    expect(t.markGeom.length).toBe(5 * 4);
    const geom = (code        ) => Array.from(t.markGeom.slice(code * 4, code * 4 + 4))            ;
    expect(geom(MARK_CODE.none)).toEqual([0, 0, 0, 0]);
    for (const name of ['added', 'changed', 'removed', 'edit']) {
      const look = (MARK       )[name];
      const [on, off] = look.ringDash || [0, 0];
      expect(geom((MARK_CODE       )[name]), name).toEqual([look.ringR, look.ringWidth, on, off]);
    }
  });

  it('draws a changed and an edit ring thicker than an added one, as Canvas 2D does, and dashes only the added', () => {
    const width = (name        ) => t.markGeom[(MARK_CODE       )[name] * 4 + 1];
    const dash = (name        ) => Array.from(t.markGeom.slice((MARK_CODE       )[name] * 4 + 2, (MARK_CODE       )[name] * 4 + 4));
    expect(width('changed')).toBe(2.5);
    expect(width('edit')).toBe(2.5);
    expect(width('added')).toBe(2);
    expect(width('removed')).toBe(2);
    expect(width('changed')).toBeGreaterThan(width('added'));
    expect(dash('added')).toEqual([5, 4]);
    for (const name of ['changed', 'removed', 'edit']) expect(dash(name), name).toEqual([0, 0]);
  });

  it('hands the on-screen minimums of scene.js MARK_MIN_PX over as one uniform: ring thickness, edge thickness, gap', () => {
    expect(Array.from(t.markMin)).toEqual([MARK_MIN_PX.ring, MARK_MIN_PX.edge, MARK_MIN_PX.gap].map(Math.fround));
    expect(Array.from(t.markMin)).toEqual([1.8, 1.6, 4].map(Math.fround));
  });
});

describe('the mark shaders (no GPU: the source is read, the numbers come from uniforms)', () => {
  it('the node shaders read each mark\'s ring from u_markGeom[mark] and the minimums from u_markMin, and hold no number of their own for them', () => {
    for (const [name, src] of [['vertex', NODE_VERT], ['fragment', NODE_FRAG]]                      ) {
      expect(src, name).toMatch(/uniform vec4 u_markGeom\[5\];/);
      expect(src, name).toMatch(/uniform vec3 u_markMin;/);
      expect(src, name).not.toMatch(/u_markGeom\.[xyzw]/);
    }
    expect(NODE_FRAG).toMatch(/u_markMin\.x/); // the ring's thickness floor
    expect(NODE_FRAG).toMatch(/u_markMin\.z/); // the gap floor
    expect(NODE_FRAG).toMatch(/u_markGeom\[mark\]/); // indexed by the node's mark code
    expect(NODE_FRAG).not.toMatch(/,\s*1\.5\)/); // the old hard-coded floor is gone
  });

  it('the edge shaders thicken a marked edge to u_markMin.y, and carry a marked flag as attribute 6', () => {
    const vert = edgeVert(1);
    expect(vert).toMatch(/uniform vec3 u_markMin;/);
    expect(vert).toMatch(/layout\(location = 6\) in float a_marked;/);
    expect(vert).toMatch(/u_markMin\.y/);
    expect(vert).not.toMatch(/1\.6/);
    expect(EDGE_FRAG).not.toMatch(/1\.6/);
  });
});

describe('packDecor', () => {
  const ring = { x: 5, y: 6, r: 100, color: 'rgba(66, 153, 225, 0.14)', width: 1, dash: [4, 6] };
  const lane = {
    x: -50, y: 30, w: 200, h: 400, radius: 14, fill: 'rgba(66, 153, 225, 0.05)', stroke: 'rgba(66, 153, 225, 0.18)', strokeWidth: 1,
    title: { text: 'Browser', x: 0, y: 0, size: 15, bold: true, color: '#fff' }, note: { text: 'n', x: 0, y: 0, size: 11, bold: false, color: '#fff' }, arrow: null,
  };

  it('packs no grid when the scene has none, and one instance when it has', () => {
    expect(packDecor(scene()).grid.count).toBe(0);
    const g = packDecor(scene({ decor: { grid: { size: 48, color: 'rgba(255, 255, 255, 0.035)', width: 0.5, margin: 200 }, rings: [], lanes: [] } })).grid;
    expect(g.count).toBe(1);
    expect(g.stride).toBe(GRID_STRIDE);
    const r = row(g, 0);
    expect(r.slice(0, 2)).toEqual([48, 0.5]);
    expect(r[7]).toBeCloseTo(0.035, 6);
    expect(r.slice(4, 7)).toEqual([1, 1, 1]);
  });

  it('packs a ring as centre, radius, width, colour and its dash', () => {
    const p = packDecor(scene({ decor: { grid: null, rings: [ring, { ...ring, dash: [] }], lanes: [] } })).rings;
    expect(p.count).toBe(2);
    expect(p.stride).toBe(RING_STRIDE);
    expect(p.data.length).toBe(2 * RING_STRIDE);
    const r = row(p, 0);
    expect(r.slice(0, 4)).toEqual([5, 6, 100, 1]);
    expect(r[7]).toBeCloseTo(0.14, 6);
    expect(r.slice(8, 10)).toEqual([4, 6]);
    expect(row(p, 1).slice(8, 10)).toEqual([0, 0]); // no dash = solid
  });

  it('packs a lane band as its rectangle, both colours, the corner radius and the stroke width', () => {
    const p = packDecor(scene({ decor: { grid: null, rings: [], lanes: [lane] } })).lanes;
    expect(p.count).toBe(1);
    expect(p.stride).toBe(LANE_STRIDE);
    const r = row(p, 0);
    expect(r.slice(0, 4)).toEqual([-50, 30, 200, 400]);
    expect(r[7]).toBeCloseTo(0.05, 6);
    expect(r[11]).toBeCloseTo(0.18, 6);
    expect(r.slice(12, 14)).toEqual([14, 1]);
  });
});

describe('the files', () => {
  it('renderer-webgl.js and shaders.js do not read the explorer\'s state', () => {
    for (const file of ['renderer-webgl.js', 'shaders.js']) {
      const src = fs.readFileSync(path.resolve(__dirname, '../../explorer', file), 'utf8');
      expect(src, file).not.toMatch(/state\.js/);
      expect(src, file).not.toMatch(/\bstate\b\./);
      expect(src, file).not.toMatch(/https?:\/\//);
    }
  });
});

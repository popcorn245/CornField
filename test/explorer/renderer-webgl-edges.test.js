/**
 * @vitest-environment node
 *
 * The WebGL2 renderer's edges (TOPO-04). There is no GPU in CI: the packing of a scene's edges
 * into the typed arrays handed to GL is pure and is read directly; the GLSL packet formula is held
 * against scene.js `packetPoint` by a JS twin; the draw sequence is read from a fake GL.
 */
import { describe, it, expect } from 'vitest';
import { fakeGl, fakeCanvas, callsOf } from './fake-gl.js';
import {
  packEdges, packScene, createWebglRenderer, PASSES, EDGE_STRIDE, TIP_STRIDE, PACKET_STRIDE, TIP_CODE,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/renderer-webgl.js';
// @ts-expect-error plain JS modules, no declarations
import { ARROW, EDGE_STRIKE, MARK, MARK_MIN_PX, packetPoint, edgePoint } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { CURVE_SEGMENTS, PACKET_POS, edgeVert, EDGE_FRAG, PACKET_VERT } from '../../explorer/shaders.js';

const edge = (extra         = {})      => ({
  key: 'a->b', from: 'a', to: 'b', kind: 'ownership', x1: 0, y1: 0, x2: 100, y2: 40, r1: 18, r2: 18,
  color: 'rgba(255, 255, 255, 0.16)', width: 1.4, alpha: 1, dash: null, curve: null, arrow: false,
  glow: 0, glowColor: null, label: null, packet: null, mark: 'none', ...extra,
});
const packet = (extra         = {}) => ({ color: '#ffffff', glowColor: '#38bdf8', radius: 3.5, glow: 10, speed: 1000 / 2600, phase: 0.3, ...extra });
const scene = (edges        = [], extra         = {})      => ({ nodes: [], edges, decor: { grid: null, rings: [], lanes: [] }, preset: false, version: 1, ...extra });
const row = (p     , i        ) => Array.from(p.data.slice(i * p.stride, (i + 1) * p.stride))            ;
const f32 = Math.fround;

describe('packEdges: shape', () => {
  it('is four empty sets for a scene with no edges', () => {
    const p = packEdges(scene());
    for (const set of ['straight', 'curved', 'tips', 'packets']) {
      expect(p[set].count, set).toBe(0);
      expect(p[set].data.length, set).toBe(0);
    }
    expect([p.straight.stride, p.curved.stride, p.tips.stride, p.packets.stride]).toEqual([EDGE_STRIDE, EDGE_STRIDE, TIP_STRIDE, PACKET_STRIDE]);
  });

  it('puts a straight edge and a curved edge in their own sets, in the scene\'s order, one row of EDGE_STRIDE floats each', () => {
    const p = packEdges(scene([
      edge({ x1: 1 }), edge({ x1: 2, curve: { cx: 5, cy: 6 } }), edge({ x1: 3 }), edge({ x1: 4, curve: { cx: 7, cy: 8 } }),
    ]));
    expect(p.straight.count).toBe(2);
    expect(p.curved.count).toBe(2);
    expect(p.straight.data).toBeInstanceOf(Float32Array);
    expect(p.straight.data.length).toBe(2 * EDGE_STRIDE);
    expect([row(p.straight, 0)[0], row(p.straight, 1)[0]]).toEqual([1, 3]);
    expect([row(p.curved, 0)[0], row(p.curved, 1)[0]]).toEqual([2, 4]);
  });

  it('is part of packScene, with the nodes and the decor', () => {
    const p = packScene(scene([edge()]));
    expect(Object.keys(p).sort()).toEqual(['curved', 'grid', 'lanes', 'nodes', 'packets', 'rings', 'straight', 'tips']);
  });
});

describe('packEdges: the line', () => {
  it('packs the ends, the control point, the width, the glow blur, the colour and the dash', () => {
    const r = row(packEdges(scene([edge({ x1: 10, y1: 20, x2: 110, y2: 60, width: 2.4, color: '#ff8000', dash: [5, 4], glow: 8, glowColor: 'rgba(129, 140, 248, 0.7)' })])).straight, 0);
    expect(r.slice(0, 4)).toEqual([10, 20, 110, 60]);
    expect(r.slice(4, 8)).toEqual([60, 40, f32(2.4), 8]); // a straight edge's control point is its midpoint
    expect(r[8]).toBe(1);
    expect(r[9]).toBeCloseTo(128 / 255, 6);
    expect(r[10]).toBe(0);
    expect(r[11]).toBe(1);
    expect(r.slice(12, 15).map((v) => Math.round(v * 255))).toEqual([129, 140, 248]);
    expect(r[15]).toBeCloseTo(0.7, 6); // glow strength = the glow colour's alpha
    expect(r.slice(16, 18)).toEqual([5, 4]);
  });

  it('keeps a curved edge\'s control point', () => {
    const r = row(packEdges(scene([edge({ curve: { cx: 33, cy: -7 } })])).curved, 0);
    expect(r.slice(4, 6)).toEqual([33, -7]);
  });

  it('encodes no dash as 0, 0 (solid), and a dash of fewer than two numbers the same', () => {
    expect(row(packEdges(scene([edge()])).straight, 0).slice(16, 18)).toEqual([0, 0]);
    expect(row(packEdges(scene([edge({ dash: [] })])).straight, 0).slice(16, 18)).toEqual([0, 0]);
    expect(row(packEdges(scene([edge({ dash: [7, 5], curve: { cx: 1, cy: 1 } })])).curved, 0).slice(16, 18)).toEqual([7, 5]);
  });

  it('folds the edge\'s alpha into the line colour and the glow, so a shader has one alpha to think about', () => {
    const r = row(packEdges(scene([edge({ color: 'rgba(255, 255, 255, 0.5)', alpha: 0.5, glow: 10, glowColor: 'rgba(255, 255, 255, 0.8)' })])).straight, 0);
    expect(r[11]).toBeCloseTo(0.25, 6);
    expect(r[15]).toBeCloseTo(0.8 * 0.25, 6);
  });

  it('has no glow when the edge has no glow colour or no blur', () => {
    expect(row(packEdges(scene([edge({ glow: 8, glowColor: null })])).straight, 0).slice(7, 8)).toEqual([0]);
    const r = row(packEdges(scene([edge({ glow: 0, glowColor: '#fff' })])).straight, 0);
    expect([r[7], r[15]]).toEqual([0, 0]);
  });
});

describe('packEdges: the arrowhead', () => {
  it('makes no tip for an edge without an arrow', () => {
    expect(packEdges(scene([edge()])).tips.count).toBe(0);
  });

  it('puts the tip at (x2, y2) pointing along the end tangent: from the control point for a curve', () => {
    const p = packEdges(scene([edge({ x1: 0, y1: 0, x2: 100, y2: 0, curve: { cx: 60, cy: -40 }, arrow: true, color: '#38bdf8', alpha: 0.5 })])).tips;
    expect(p.count).toBe(1);
    const r = row(p, 0);
    const len = Math.hypot(40, 40);
    expect(r.slice(0, 2)).toEqual([100, 0]);
    expect(r[2]).toBeCloseTo(40 / len, 6);
    expect(r[3]).toBeCloseTo(40 / len, 6);
    expect(r[7]).toBeCloseTo(0.5, 6);
    expect(r[8]).toBe(TIP_CODE.arrow);
  });

  it('points a straight edge\'s arrowhead from its start to its end', () => {
    const r = row(packEdges(scene([edge({ x1: 0, y1: 0, x2: 0, y2: 50, arrow: true })])).tips, 0);
    expect([r[2], r[3]].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1]);
  });

  it('draws the same arrowhead as Canvas 2D: ARROW is handed to the shader as a uniform, not copied', () => {
    const gl = fakeGl();
    createWebglRenderer(fakeCanvas({ webgl2: gl }), {});
    const tip = callsOf(gl, 'uniform4f').find((c) => c[1].uniform === 'u_tip') ;
    expect(tip.slice(2)).toEqual([ARROW.length, ARROW.spread, EDGE_STRIKE.halfLength, EDGE_STRIKE.width]);
  });
});

describe('packEdges: marks', () => {
  const one = (mark        , extra         = {}) => packEdges(scene([edge({ mark, ...extra })]));
  const rgb = (r          , at = 8) => r.slice(at, at + 3).map((v) => Math.round(v * 255));
  const hex = (css        ) => [1, 3, 5].map((i) => parseInt(css.slice(i, i + 2), 16));

  // The look of a mark is scene.js's business (styleForProposal puts colour, dash, weight and fade in the edge itself); the packer takes the edge as it comes
  it('a marked edge keeps the colour, dash and alpha the scene gave it', () => {
    for (const mark of ['added', 'changed', 'edit']) {
      const r = row(one(mark, { color: MARK[mark].color, dash: MARK[mark].edgeDash, alpha: 0.65 }).straight, 0);
      expect(rgb(r), mark).toEqual(hex(MARK[mark].color));
      expect(r[11], mark).toBeCloseTo(0.65, 6);
      expect(r.slice(16, 18), mark).toEqual(MARK[mark].edgeDash || [0, 0]);
    }
  });

  it('removed: the edge as the scene faded it, with a strike across it at its midpoint', () => {
    const p = one('removed', { x1: 0, y1: 0, x2: 200, y2: 0, color: MARK.removed.color, alpha: MARK.removed.alpha });
    const r = row(p.straight, 0);
    expect(rgb(r)).toEqual(hex(MARK.removed.color));
    expect(r[11]).toBeCloseTo(MARK.removed.alpha, 6);
    expect(p.tips.count).toBe(1);
    const t = row(p.tips, 0);
    expect(t.slice(0, 4)).toEqual([100, 0, 1, 0]);
    expect(t[7]).toBeCloseTo(MARK.removed.alpha, 6);
    expect(t[8]).toBe(TIP_CODE.strike);
  });

  it('strikes a curved removed edge at the curve\'s midpoint, not the chord\'s', () => {
    const e = edge({ mark: 'removed', x1: 0, y1: 0, x2: 200, y2: 0, curve: { cx: 100, cy: -60 } });
    const t = row(packEdges(scene([e])).tips, 0);
    const mid = edgePoint(e, 0.5);
    expect([t[0], t[1]]).toEqual([f32(mid.x), f32(mid.y)]);
    expect(mid.y).toBe(-30);
  });

  it('gives a zero-length removed edge a strike direction anyway', () => {
    const t = row(packEdges(scene([edge({ mark: 'removed', x2: 0, y2: 0 })])).tips, 0);
    expect([t[2], t[3]]).toEqual([1, 0]);
  });

  it('a removed edge with an arrow has the arrowhead and the strike, both in the mark colour', () => {
    const p = packEdges(scene([edge({ mark: 'removed', arrow: true, curve: { cx: 50, cy: 30 }, color: MARK.removed.color })]));
    expect(p.tips.count).toBe(2);
    expect([row(p.tips, 0)[8], row(p.tips, 1)[8]]).toEqual([TIP_CODE.arrow, TIP_CODE.strike]);
    expect(rgb(row(p.tips, 0), 4)).toEqual(hex(MARK.removed.color));
  });

  it('flags a marked edge in the last float of its row, so the shader can keep it MARK_MIN_PX.edge thick, as Canvas 2D does', () => {
    expect(EDGE_STRIDE).toBe(19);
    for (const mark of ['added', 'changed', 'removed', 'edit']) {
      expect(row(one(mark).straight, 0)[18], mark).toBe(1);
      expect(row(one(mark, { curve: { cx: 1, cy: 1 } }).curved, 0)[18], mark).toBe(1);
    }
    expect(row(one('none').straight, 0)[18]).toBe(0);
    expect(row(packEdges(scene([edge()])).straight, 0)[18]).toBe(0);
  });

  it('draws a marked edge no thinner than MARK_MIN_PX.edge: the minimum is a uniform on both edge programs, not a number in the GLSL', () => {
    const gl = fakeGl();
    createWebglRenderer(fakeCanvas({ webgl2: gl }), {});
    const mins = callsOf(gl, 'uniform3fv').filter((c) => c[1].uniform === 'u_markMin');
    expect(mins.length).toBe(3);
    expect(Math.fround(MARK_MIN_PX.edge)).toBe(Array.from(mins[1][2])[1]);
    expect(Math.fround(MARK_MIN_PX.edge)).toBe(Array.from(mins[2][2])[1]);
  });

  it('an edge with no mark, or an unknown one, is left alone and gets no strike', () => {
    for (const mark of ['none', 'sparkle', 'ringR']) {
      const p = one(mark, { color: '#ff8000' });
      expect(rgb(row(p.straight, 0)), mark).toEqual([255, 128, 0]);
      expect(p.tips.count, mark).toBe(0);
    }
  });

  it('a packet carries its edge\'s alpha (a removed edge comes faded from the scene)', () => {
    const r = row(packEdges(scene([edge({ mark: 'removed', alpha: MARK.removed.alpha, packet: packet() })])).packets, 0);
    expect(r[11]).toBeCloseTo(MARK.removed.alpha, 6);
  });
});

describe('packEdges: packets', () => {
  it('an edge with no packet gives no packet row', () => {
    const p = packEdges(scene([edge(), edge({ curve: { cx: 1, cy: 1 }, arrow: true })]));
    expect(p.packets.count).toBe(0);
  });

  it('packs the edge, its control point, the speed and the phase, the two colours and the sizes', () => {
    const p = packEdges(scene([edge(), edge({ x1: 5, y1: 6, x2: 105, y2: 66, curve: { cx: 40, cy: -20 }, alpha: 0.5, packet: packet({ speed: 0.5, phase: 0.25, radius: 3.5, glow: 10, glowColor: 'rgba(56, 189, 248, 0.5)' }) })])).packets;
    expect(p.count).toBe(1); // only the edge that has a packet
    const r = row(p, 0);
    expect(r.slice(0, 8)).toEqual([5, 6, 105, 66, 40, -20, 0.5, 0.25]);
    expect(r.slice(8, 12)).toEqual([1, 1, 1, 0.5]); // the dot: white, at the edge's alpha
    expect(r.slice(12, 15).map((v) => Math.round(v * 255))).toEqual([56, 189, 248]);
    expect(r[15]).toBeCloseTo(0.5 * 0.5, 6); // glow colour alpha x edge alpha
    expect(r.slice(16, 18)).toEqual([3.5, 10]);
  });

  it('uses the midpoint as the control point of a straight edge\'s packet', () => {
    const r = row(packEdges(scene([edge({ x1: 0, y1: 0, x2: 100, y2: 40, packet: packet() })])).packets, 0);
    expect(r.slice(4, 6)).toEqual([50, 20]);
  });
});

// ---------------------------------------------------------------------------
//  The GLSL packet formula and scene.js packetPoint must agree
// ---------------------------------------------------------------------------

/** A JS twin of shaders.js PACKET_POS (and `bez`), term for term, in float32 as a GPU computes it */
function shaderPacketPos(ends          , mot          , timeSec        ) {
  const fract = (x        ) => x - Math.floor(x);
  const k = f32(fract(f32(f32(timeSec * mot[2]) + mot[3])));
  const u = f32(1 - k);
  const bez = (a        , c        , b        ) => f32(f32(f32(u * u) * a) + f32(f32(2 * u * k) * c) + f32(f32(k * k) * b));
  return { x: bez(ends[0], mot[0], ends[2]), y: bez(ends[1], mot[1], ends[3]) };
}

describe('the packet formula in GLSL and in scene.js', () => {
  const edges = [
    edge({ x1: 0, y1: 0, x2: 400, y2: 80, packet: packet() }),
    edge({ x1: -50, y1: 30, x2: 300, y2: -200, curve: { cx: 120, cy: 90 }, packet: packet({ phase: 0.9 }) }),
    edge({ x1: 10, y1: 10, x2: 10.5, y2: 10, curve: { cx: 10, cy: 10 }, packet: packet({ speed: 2, phase: 0 }) }),
  ];
  const times = [0, 1, 1234.5, 5000, 60_000, 3_600_000];

  it('puts the packet at the same point, for several edges and times', () => {
    const p = packEdges(scene(edges)).packets;
    edges.forEach((e, i) => {
      const r = row(p, i);
      for (const timeMs of times) {
        const want = packetPoint(e, timeMs);
        const got = shaderPacketPos(r.slice(0, 4), r.slice(4, 8), timeMs / 1000);
        expect(got.x, `edge ${i} at ${timeMs}`).toBeCloseTo(want.x, 1);
        expect(got.y, `edge ${i} at ${timeMs}`).toBeCloseTo(want.y, 1);
      }
    });
  });

  it('wraps: after a whole number of trips it is back where it started', () => {
    const r = row(packEdges(scene([edges[0]])).packets, 0);
    const a = shaderPacketPos(r.slice(0, 4), r.slice(4, 8), 0);
    const b = shaderPacketPos(r.slice(0, 4), r.slice(4, 8), 2.6 * 5);
    expect(b.x).toBeCloseTo(a.x, 1);
  });

  it('is the formula the vertex shader runs: fract of time x speed + phase, along the quadratic', () => {
    expect(PACKET_POS).toContain('fract(timeSec * mot.z + mot.w)');
    expect(PACKET_POS).toContain('bez(ends.xy, mot.xy, ends.zw, k)');
    expect(PACKET_VERT).toContain(PACKET_POS);
    expect(PACKET_VERT).toContain('packetPos(a_ends, a_mot, u_time)');
  });
});

// ---------------------------------------------------------------------------
//  The shaders and the passes agree about the attribute layout
// ---------------------------------------------------------------------------
describe('the passes', () => {
  const vertexOf = (pass     ) => pass.vert          ;
  const SIZE                         = { float: 1, vec2: 2, vec3: 3, vec4: 4 };

  it('lists the edge passes, the tips and the packets between the rings and the nodes', () => {
    expect(PASSES.map((p     ) => p.name)).toEqual(['grid', 'lanes', 'rings', 'straight', 'curved', 'tips', 'packets', 'nodes']);
  });

  it('every attribute a pass sets up is declared by its vertex shader at that location and size', () => {
    for (const pass of PASSES         ) {
      const declared = new Map                ();
      for (const m of vertexOf(pass).matchAll(/layout\(location = (\d+)\) in (float|vec2|vec3|vec4) /g)) declared.set(Number(m[1]), SIZE[m[2]]);
      const set = new Map                (pass.attribs.map(([loc, size]          ) => [loc, size]));
      if (!pass.verts) set.set(0, 2); // the unit quad's corner
      expect(Object.fromEntries(declared), pass.name).toEqual(Object.fromEntries(set));
      const floats = pass.attribs.reduce((n        , [, size]          ) => n + size, 0);
      expect(floats, pass.name).toBe(pass.stride);
    }
  });

  it('the packed strides are what the passes read', () => {
    const byName = Object.fromEntries((PASSES         ).map((p) => [p.name, p.stride]));
    expect([byName.straight, byName.curved, byName.tips, byName.packets]).toEqual([EDGE_STRIDE, EDGE_STRIDE, TIP_STRIDE, PACKET_STRIDE]);
  });

  it('one edge program text makes both passes: a strip of 1 step for straight edges, CURVE_SEGMENTS for curved ones', () => {
    expect(edgeVert(1)).toContain('#define SEGS 1\n');
    expect(edgeVert(CURVE_SEGMENTS)).toContain(`#define SEGS ${CURVE_SEGMENTS}\n`);
    const [straight, curved] = (PASSES         ).filter((p) => p.name === 'straight' || p.name === 'curved');
    expect(straight.frag).toBe(EDGE_FRAG);
    expect(curved.frag).toBe(EDGE_FRAG);
    // a strip pair per step, plus a pair at each end
    expect([straight.verts, curved.verts]).toEqual([2 * (1 + 3), 2 * (CURVE_SEGMENTS + 3)]);
  });
});

// ---------------------------------------------------------------------------
//  The draw sequence
// ---------------------------------------------------------------------------
describe('drawing edges', () => {
  function make() {
    const gl = fakeGl();
    const r = createWebglRenderer(fakeCanvas({ webgl2: gl }), {});
    r.resize(800, 600, 1);
    return { gl, r };
  }
  const node = (id        , x        )      => ({ id, type: 'page', x, y: 0, r: 18, color: '#336699', alpha: 1, glow: 0, halo: 'none', mark: 'none', selected: false, match: false, connected: true, label: id, labelSize: 11, labelBold: false, labelAlpha: 1, labelColor: '#fff', labelKeep: false });
  const full = () => scene([
    edge(), edge({ x1: 5 }), edge({ curve: { cx: 40, cy: 10 }, arrow: true, packet: packet() }),
    edge({ mark: 'removed', curve: { cx: 40, cy: 10 }, packet: packet() }),
  ], { nodes: [node('a', 0), node('b', 100)] });
  const draws = (gl     ) => callsOf(gl, 'drawArraysInstanced').map((c) => c.slice(1));

  it('draws straight, curved, tips, packets, then the nodes: one instanced call each, the strip lengths as the vertex counts', () => {
    const { gl, r } = make();
    r.draw(full(), { x: 0, y: 0, zoom: 1 }, 0);
    expect(draws(gl)).toEqual([
      ['TRIANGLE_STRIP', 0, 2 * (1 + 3), 2],                    // two straight edges
      ['TRIANGLE_STRIP', 0, 2 * (CURVE_SEGMENTS + 3), 2],       // two curved ones
      ['TRIANGLE_STRIP', 0, 4, 2],                              // an arrowhead and a strike
      ['TRIANGLE_STRIP', 0, 4, 2],                              // two packets
      ['TRIANGLE_STRIP', 0, 4, 2],                              // the nodes, on top
    ]);
  });

  it('skips a set with nothing in it', () => {
    const { gl, r } = make();
    r.draw(scene([edge()], { nodes: [node('a', 0)] }), { x: 0, y: 0, zoom: 1 }, 0);
    expect(draws(gl).map((d) => d[2])).toEqual([8, 4]);
  });

  it('sets no corner buffer for a strip pass, and does for a quad pass', () => {
    const { gl } = make();
    // 8 programs; the six quad passes bind the shared corner buffer to location 0, the two strips do not
    const zero = callsOf(gl, 'enableVertexAttribArray').filter((c) => c[1] === 0);
    expect(zero.length).toBe(6);
  });

  it('moves the packets with time as a uniform: no upload, no new packing', () => {
    const { gl, r } = make();
    const s = full();
    r.draw(s, { x: 0, y: 0, zoom: 1 }, 0);
    const uploaded = callsOf(gl, 'bufferData').length;
    r.draw(s, { x: 0, y: 0, zoom: 1 }, 1300);
    r.draw(s, { x: 9, y: 0, zoom: 2 }, 2600);
    expect(callsOf(gl, 'bufferData').length).toBe(uploaded);
    expect(r.stats.uploads).toBe(1);
    const times = callsOf(gl, 'uniform1f').filter((c) => c[1].uniform === 'u_time').map((c) => c[2]);
    expect(times).toEqual([0, 1.3, 2.6]); // seconds, once a frame, for the packet pass only
  });

  it('uploads the packed edges once per scene version', () => {
    const { gl, r } = make();
    r.draw(full(), { x: 0, y: 0, zoom: 1 }, 0);
    const sizes = callsOf(gl, 'bufferData').map((c) => c[2]?.length).filter((n) => n > 8);
    expect(sizes).toContain(2 * EDGE_STRIDE); // both edge sets are two rows
    expect(sizes).toContain(2 * TIP_STRIDE);
    expect(sizes).toContain(2 * PACKET_STRIDE);
  });
});

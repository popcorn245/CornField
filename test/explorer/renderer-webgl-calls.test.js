/**
 * @vitest-environment node
 *
 * The WebGL2 renderer's call sequence against a fake GL (TOPO-03): what it uploads and when,
 * what it draws, what it does when the context is lost. No real context, ever.
 */
import { describe, it, expect } from 'vitest';
import { fakeGl, fakeCanvas, callsOf } from './fake-gl.js';
// @ts-expect-error plain JS modules, no declarations
import { createWebglRenderer, NODE_STRIDE, MARK_CODE } from '../../explorer/renderer-webgl.js';
// @ts-expect-error plain JS modules, no declarations
import { MARK, MARK_MIN_PX } from '../../explorer/scene.js';

const snode = (extra         = {})      => ({
  id: 'n', type: 'page', x: 10, y: -20, r: 18, color: '#ff8000', alpha: 1, glow: 9, halo: 'none', mark: 'none',
  selected: false, match: false, connected: true, label: 'n', labelSize: 11, labelBold: false, labelAlpha: 1, labelColor: '#f8fafc', labelKeep: false, ...extra,
});
const scene = (extra         = {})      => ({ nodes: [], edges: [], decor: { grid: null, rings: [], lanes: [] }, preset: false, version: 1, ...extra });
const camera = (extra         = {}) => ({ x: 100, y: 50, zoom: 1.5, ...extra });
const small = (extra         = {}) => scene({
  nodes: [snode({ id: 'a' }), snode({ id: 'b', x: 50 }), snode({ id: 'c', x: 90 })],
  decor: { grid: { size: 48, color: 'rgba(255, 255, 255, 0.035)', width: 0.5, margin: 200 }, rings: [{ x: 0, y: 0, r: 100, color: '#fff', width: 1, dash: [4, 6] }], lanes: [] },
  ...extra,
});

function make(opts         = {}) {
  const gl = fakeGl(opts);
  const canvas = fakeCanvas({ webgl2: gl });
  const r = createWebglRenderer(canvas, {});
  r.resize(800, 600, 2);
  return { gl, canvas, r };
}
const instanceCounts = (gl     ) => callsOf(gl, 'drawArraysInstanced').map((c) => c[4]);
const uploads = (gl     ) => callsOf(gl, 'bufferData').filter((c) => c[2] instanceof Float32Array && c[2].length > 8);

describe('createWebglRenderer', () => {
  it('is a renderer: kind webgl2, draw, resize, destroy', () => {
    const { r } = make();
    expect(r.kind).toBe('webgl2');
    for (const fn of ['draw', 'resize', 'destroy']) expect(typeof r[fn]).toBe('function');
  });

  it('throws when the canvas has no WebGL2 context', () => {
    expect(() => createWebglRenderer(fakeCanvas({}), {})).toThrow(/WebGL2 is not available/);
  });

  it('throws, naming the shader, when a shader does not compile or the program does not link', () => {
    expect(() => createWebglRenderer(fakeCanvas({ webgl2: fakeGl({ failCompile: true }) }), {})).toThrow(/grid vertex shader did not compile: fake driver says no/);
    expect(() => createWebglRenderer(fakeCanvas({ webgl2: fakeGl({ failLink: true }) }), {})).toThrow(/grid program did not link/);
  });

  it('sizes the drawing buffer for the device pixel ratio', () => {
    const { canvas } = make();
    expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
  });

  it('draws the grid, the ring and the nodes as one instanced call each, with the node count as the instances', () => {
    const { gl, r } = make();
    r.draw(small(), camera(), 0);
    expect(callsOf(gl, 'drawArraysInstanced').map((c) => c.slice(1))).toEqual([
      ['TRIANGLE_STRIP', 0, 4, 1], // the grid
      ['TRIANGLE_STRIP', 0, 4, 1], // the one ring
      ['TRIANGLE_STRIP', 0, 4, 3], // three nodes, one call
    ]);
  });

  it('draws nothing for a pass that has no instances', () => {
    const { gl, r } = make();
    r.draw(scene({ nodes: [snode()] }), camera(), 0);
    expect(instanceCounts(gl)).toEqual([1]);
  });

  it('blends premultiplied: ONE, ONE_MINUS_SRC_ALPHA, over a transparent clear', () => {
    const { gl, r } = make();
    r.draw(small(), camera(), 0);
    expect(callsOf(gl, 'blendFunc')[0]).toEqual(['blendFunc', 'ONE', 'ONE_MINUS_SRC_ALPHA']);
    expect(callsOf(gl, 'clearColor')[0]).toEqual(['clearColor', 0, 0, 0, 0]);
    expect(callsOf(gl, 'viewport')[0]).toEqual(['viewport', 0, 0, 1600, 1200]);
  });

  it('uploads the packed nodes once, and a pan or a zoom uploads nothing', () => {
    const { gl, r } = make();
    const s = small();
    r.draw(s, camera(), 0);
    const first = uploads(gl).length;
    expect(first).toBeGreaterThan(0);
    const nodeUpload = uploads(gl).find((c) => c[2].length === 3 * NODE_STRIDE);
    expect(nodeUpload).toBeTruthy();
    expect(Array.from(nodeUpload [2].slice(0, 3))).toEqual([10, -20, 18]);

    r.draw(s, camera({ x: 300 }), 16);
    r.draw(s, camera({ zoom: 0.5 }), 32);
    r.draw(s, camera({ zoom: 0.5 }), 5000); // time moves packets, and only packets
    expect(uploads(gl).length).toBe(first);
    expect(r.stats.uploads).toBe(1);
    expect(r.stats.draws).toBe(12);
  });

  it('hands the camera and the viewport to the shaders as uniforms', () => {
    const { gl, r } = make();
    const s = small();
    r.draw(s, camera(), 0);
    r.draw(s, camera({ x: -40, y: 7, zoom: 0.25 }), 1);
    const cams = callsOf(gl, 'uniform3f');
    expect(cams[0].slice(1)).toEqual([{ uniform: 'u_cam' }, 100, 50, 1.5]);
    expect(cams[cams.length - 1].slice(1)).toEqual([{ uniform: 'u_cam' }, -40, 7, 0.25]);
    expect(callsOf(gl, 'uniform2f')[0].slice(2)).toEqual([800, 600]);
    expect(callsOf(gl, 'uniform1f').filter((c) => c[1].uniform === 'u_dpr')[0][2]).toBe(2);
  });

  it('uploads again when the scene version moves, or when it is a different scene', () => {
    const { r } = make();
    const s = small();
    r.draw(s, camera(), 0);
    s.version = 2;
    r.draw(s, camera(), 1);
    expect(r.stats.uploads).toBe(2);
    r.draw(small({ version: 2 }), camera(), 2);
    expect(r.stats.uploads).toBe(3);
  });

  it('sets the looks of scene.js as uniforms once, not per frame', () => {
    const { gl, r } = make();
    const s = small();
    r.draw(s, camera(), 0);
    const n = callsOf(gl, 'uniform4fv').length;
    expect(n).toBe(6);
    r.draw(s, camera({ x: 1 }), 1);
    expect(callsOf(gl, 'uniform4fv').length).toBe(n);
  });

  it('uploads one ring geometry per mark: u_markGeom is five vec4 (none, added, changed, removed, edit), once', () => {
    const { gl, r } = make();
    r.draw(small(), camera(), 0);
    const geom = callsOf(gl, 'uniform4fv').filter((c) => c[1].uniform === 'u_markGeom');
    expect(geom.length).toBe(1);
    const data = Array.from(geom[0][2])            ;
    expect(data.length).toBe(20);
    const at = (name        ) => data.slice((MARK_CODE       )[name] * 4, (MARK_CODE       )[name] * 4 + 4);
    expect(at('none')).toEqual([0, 0, 0, 0]);
    expect(at('added')).toEqual([MARK.added.ringR, MARK.added.ringWidth, ...MARK.added.ringDash]);
    expect(at('changed')).toEqual([MARK.changed.ringR, 2.5, 0, 0]);
    expect(at('removed')).toEqual([MARK.removed.ringR, 2, 0, 0]);
    expect(at('edit')).toEqual([MARK.edit.ringR, 2.5, 0, 0]);
    r.draw(small(), camera({ zoom: 0.2 }), 1);
    expect(callsOf(gl, 'uniform4fv').filter((c) => c[1].uniform === 'u_markGeom').length).toBe(1); // a zoom is the shader's business
  });

  it('uploads MARK_MIN_PX as u_markMin to the node program and to both edge programs, once', () => {
    const { gl, r } = make();
    r.draw(small(), camera(), 0);
    const mins = callsOf(gl, 'uniform3fv').filter((c) => c[1].uniform === 'u_markMin');
    expect(mins.length).toBe(3); // nodes, straight edges, curved edges
    for (const c of mins) expect(Array.from(c[2])).toEqual([MARK_MIN_PX.ring, MARK_MIN_PX.edge, MARK_MIN_PX.gap].map(Math.fround));
    r.draw(small(), camera({ zoom: 0.2 }), 1);
    expect(callsOf(gl, 'uniform3fv').filter((c) => c[1].uniform === 'u_markMin').length).toBe(3);
  });

  it('draws nothing before it knows its size', () => {
    const gl = fakeGl();
    const r = createWebglRenderer(fakeCanvas({ webgl2: gl }), {});
    r.draw(small(), camera(), 0);
    expect(callsOf(gl, 'drawArraysInstanced').length).toBe(0);
  });

  it('redraws the last picture after a resize (the buffer is cleared by it)', () => {
    const { gl, r } = make();
    r.draw(small(), camera(), 0);
    const before = callsOf(gl, 'drawArraysInstanced').length;
    r.resize(400, 300, 1);
    expect(callsOf(gl, 'drawArraysInstanced').length).toBe(before * 2);
    expect(callsOf(gl, 'viewport').pop()).toEqual(['viewport', 0, 0, 400, 300]);
  });

  describe('when the context is lost', () => {
    it('keeps the browser from discarding it, draws nothing while it is gone, and never throws', () => {
      const { gl, canvas, r } = make();
      r.draw(small(), camera(), 0);
      const drawn = callsOf(gl, 'drawArraysInstanced').length;
      const event = canvas.fire('webglcontextlost');
      expect(event.defaultPrevented).toBe(true);
      expect(() => r.draw(small(), camera(), 1)).not.toThrow();
      expect(callsOf(gl, 'drawArraysInstanced').length).toBe(drawn);
    });

    it('rebuilds the programs and the buffers when it is restored, and draws the last picture again', () => {
      const { gl, canvas, r } = make();
      const s = small();
      r.draw(s, camera(), 0);
      const programs = callsOf(gl, 'createProgram').length;
      const drawn = callsOf(gl, 'drawArraysInstanced').length;
      const uploaded = uploads(gl).length;
      canvas.fire('webglcontextlost');
      r.draw(s, camera({ x: 9 }), 1); // while lost: remembered, not drawn
      canvas.fire('webglcontextrestored');
      expect(callsOf(gl, 'createProgram').length).toBe(programs * 2);
      expect(callsOf(gl, 'drawArraysInstanced').length).toBe(drawn * 2);
      expect(callsOf(gl, 'uniform3f').pop() .slice(2)).toEqual([9, 50, 1.5]); // the camera it was last given
      expect(uploads(gl).length).toBe(uploaded * 2); // the packed arrays went up again, with no new scene
    });
  });

  it('destroy stops listening and frees the GPU objects', () => {
    const { gl, canvas, r } = make();
    r.draw(small(), camera(), 0);
    r.destroy();
    expect(canvas.listeners.webglcontextlost).toEqual([]);
    expect(canvas.listeners.webglcontextrestored).toEqual([]);
    expect(callsOf(gl, 'deleteProgram').length).toBe(8);
    expect(callsOf(gl, 'deleteVertexArray').length).toBe(8);
    const drawn = callsOf(gl, 'drawArraysInstanced').length;
    r.draw(small(), camera(), 0); // after destroy: a no-op
    expect(callsOf(gl, 'drawArraysInstanced').length).toBe(drawn);
  });
});

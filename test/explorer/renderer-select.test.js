// @vitest-environment node
/**
 * createRenderer (TOPO-03): which renderer the explorer gets, and the fallbacks. The label layer
 * (labels.js) draws all the text, so neither renderer has an overlay of its own. Fake canvases and a
 * fake GL; never a real context.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fakeGl, fakeCanvas, callsOf, recordingCtx } from './fake-gl.js';
// @ts-expect-error plain JS modules, no declarations
import { createRenderer, rendererPreference } from '../../explorer/renderer.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene } from '../../explorer/scene.js';

const layers = { app: true, pkg: true, page: true, atom: true, molecule: true, token: true, tool: true, flow: true, table: true, rom: true, service: true, external: true, stack: false };
const node = (id        , type        , x        ) => ({ id, type, x, y: 0, r: 20, color: '#336699', label: id });
const st      = { nodes: [node('root', 'root', 0), node('app', 'app', 100)], edges: [{ from: 'root', to: 'app' }], view: 'orbit', flow: null, rings: { rings: [], clusters: [] }, selectedNode: null, searchQuery: '', isFreeform: false, activeLayers: layers, sim: null, sceneVersion: 1 };
const camera = { x: 0, y: 0, zoom: 1 };
const ctxLog = (standIn     ) => standIn.getContext('2d').log           ;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('rendererPreference', () => {
  it('reads ?renderer= from a query string', () => {
    expect(rendererPreference('?renderer=canvas2d')).toBe('canvas2d');
    expect(rendererPreference('?view=dataflow&renderer=webgl2')).toBe('webgl2');
    expect(rendererPreference('?renderer=bogus')).toBe(null);
    expect(rendererPreference('')).toBe(null);
    expect(rendererPreference(undefined       )).toBe(null);
  });
});

describe('createRenderer', () => {
  it('?renderer=canvas2d: the Canvas 2D renderer on the canvas itself, WebGL2 never asked for', () => {
    const canvas = fakeCanvas({ webgl2: fakeGl(), '2d': recordingCtx() });
    const r = createRenderer(canvas, { prefer: 'canvas2d' });
    expect(r.kind).toBe('canvas2d');
    expect(canvas.requested).toEqual(['2d']);
    expect(canvas.siblings).toEqual([]);
  });

  it('reads the preference from the page address by default', () => {
    vi.stubGlobal('location', { search: '?renderer=canvas2d' });
    const canvas = fakeCanvas({ webgl2: fakeGl(), '2d': recordingCtx() });
    expect(createRenderer(canvas).kind).toBe('canvas2d');
  });

  it('no WebGL2 context: the Canvas 2D renderer on the canvas, no stand-in canvas', () => {
    const canvas = fakeCanvas({ '2d': recordingCtx() });
    const r = createRenderer(canvas, { prefer: null });
    expect(r.kind).toBe('canvas2d');
    expect(canvas.requested).toEqual(['webgl2', '2d']);
    expect(canvas.siblings).toEqual([]);
  });

  it('a getContext that throws is no WebGL2 either', () => {
    const canvas = fakeCanvas({ '2d': recordingCtx() });
    const get = canvas.getContext;
    canvas.getContext = (type        ) => { if (type === 'webgl2') throw new Error('blocked'); return get(type); };
    expect(createRenderer(canvas, { prefer: null }).kind).toBe('canvas2d');
  });

  describe('with WebGL2', () => {
    const make = () => {
      const gl = fakeGl();
      const canvas = fakeCanvas({ webgl2: gl });
      const r = createRenderer(canvas, { prefer: null });
      return { gl, canvas, r };
    };

    it('is a webgl2 renderer, and asks the canvas for nothing but WebGL2', () => {
      const { canvas, r } = make();
      expect(r.kind).toBe('webgl2');
      expect(canvas.requested).toEqual(['webgl2']);
    });

    it('adds no canvas to the page: the label layer is the only text, and it is in index.html', () => {
      const { canvas } = make();
      expect(canvas.siblings).toEqual([]);
    });

    it('draws the GPU passes and no text', () => {
      const { gl, canvas, r } = make();
      r.resize(800, 600, 1);
      r.draw(buildScene(st), camera, 0);
      expect(callsOf(gl, 'drawArraysInstanced').length).toBeGreaterThan(0);
      expect(canvas.requested).toEqual(['webgl2']);
    });

    it('resizes the canvas', () => {
      const { canvas, r } = make();
      r.resize(640, 480, 2);
      expect([canvas.width, canvas.height]).toEqual([1280, 960]);
    });
  });

  describe('when a shader does not compile', () => {
    it('warns once and draws everything with Canvas 2D on a stand-in canvas (the map canvas can no longer give a 2d context)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const gl = fakeGl({ failCompile: true });
      const canvas = fakeCanvas({ webgl2: gl });
      const r = createRenderer(canvas, { prefer: null });
      const standIn = canvas.siblings[0];
      expect(r.kind).toBe('canvas2d');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/did not compile/);
      expect(canvas.requested).toEqual(['webgl2']);

      r.resize(800, 600, 1);
      r.draw(buildScene(st), camera, 0);
      expect(ctxLog(standIn).filter((c) => c[0] === 'arc').length).toBeGreaterThan(2); // the nodes and the edges' arrowheads
      expect(callsOf(gl, 'drawArraysInstanced').length).toBe(0);

      r.destroy();
      expect(standIn.removed).toBe(true);
    });
  });
});

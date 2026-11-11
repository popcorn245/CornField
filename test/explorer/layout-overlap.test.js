// @vitest-environment node
/**
 * The orbit layout never puts two nodes on top of each other (F02, issue #148): no two discs overlap in the default
 * layout, for the big synthetic map (generated in memory) and the sample fixture, whatever layers are on. The fit
 * and the zoom floor (F22) are held here too: the whole map fits at a desktop and a phone size, and zooming out from
 * the fit never zooms in.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeBig } from '../fixtures/big/make.js';
import { loadSample } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { computeDegreeCentrality, computeOrbitalLayout } from '../../explorer/layout.js';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { isNodeVisible } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { fitGraphToViewport, getMinZoom, fitPadding } from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { zoomAbout } from '../../explorer/camera.js';

const GAP = 2;
const saved = { ctx: state.ctx, nodes: state.nodes, edges: state.edges, view: state.view, width: state.width, height: state.height, camera: state.camera, activeLayers: state.activeLayers };
afterAll(() => Object.assign(state, saved));

function lay(topology) {
  state.ctx = { save() {}, restore() {}, font: '', measureText: (s) => ({ width: s.length * 6 }) };
  state.nodes = structuredClone(topology.nodes);
  state.edges = structuredClone(topology.edges);
  state.view = 'orbit';
  computeDegreeCentrality();
  computeOrbitalLayout();
}

function overlaps(nodes) {
  const bad = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r + GAP) bad.push(`${a.id} / ${b.id}`);
    }
  }
  return bad;
}

/** The layer sets the Layers menu makes by default (a fresh state) and with everything on */
const LAYER_SETS = {
  default: undefined,
  everything: Object.fromEntries(['app', 'pkg', 'page', 'atom', 'molecule', 'token', 'tool', 'flow', 'table', 'rom', 'service', 'cloud', 'web', 'stack', 'machine', 'container', 'device', 'house', 'persona'].map((k) => [k, true])),
};

describe.each([
  ['the big synthetic map', () => makeBig({ seed: 245 }).topology],
  ['the sample fixture', () => loadSample()],
])('%s', (_name, load) => {
  let topology;
  beforeAll(() => { topology = load(); lay(topology); });

  it('has no two nodes on one spot, and no two discs overlapping', () => {
    expect(overlaps(state.nodes)).toEqual([]);
  });

  for (const [label, layers] of Object.entries(LAYER_SETS)) {
    it(`holds for the nodes shown with the ${label} layers`, () => {
      state.activeLayers = layers ? { ...layers } : { ...saved.activeLayers };
      const shown = state.nodes.filter((n) => isNodeVisible(state, n));
      expect(shown.length).toBeGreaterThan(0);
      expect(overlaps(shown)).toEqual([]);
    });
  }
});

describe('a node with children of its own under a hub', () => {
  it('gets them in rings around it, counted in the cluster so the next one is clear', () => {
    const nodes = [{ id: 'root', type: 'root', r: 30, label: 'root' }, { id: 'tool', type: 'tool', r: 20, label: 'tool' }, { id: 'pile', type: 'service', r: 20, label: 'pile' },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `kid${i}`, type: 'external', r: 18, label: `kid ${i}` })),
      { id: 'tool2', type: 'tool', r: 20, label: 'tool2' }, { id: 'p2', type: 'service', r: 20, label: 'p2' }, { id: 'p2k', type: 'external', r: 18, label: 'p2k' }];
    const edges = [{ from: 'root', to: 'tool' }, { from: 'tool', to: 'pile' }, ...Array.from({ length: 30 }, (_, i) => ({ from: 'pile', to: `kid${i}` })),
      { from: 'root', to: 'tool2' }, { from: 'tool2', to: 'p2' }, { from: 'p2', to: 'p2k' }];
    lay({ nodes, edges });
    expect(overlaps(state.nodes)).toEqual([]);
  });
});

describe.each([[1440, 900], [390, 844]])('the fit at %i x %i', (w, h) => {
  beforeAll(() => {
    lay(makeBig({ seed: 245 }).topology);
    state.activeLayers = { ...saved.activeLayers };
    state.width = w; state.height = h;
    state.camera = { x: 0, y: 0, zoom: 1 };
    fitGraphToViewport(fitPadding());
  });

  it('shows the whole map: every shown node inside the viewport', () => {
    const { camera } = state;
    for (const n of state.nodes.filter((x) => isNodeVisible(state, x))) {
      const sx = camera.x + n.x * camera.zoom, sy = camera.y + n.y * camera.zoom;
      expect(sx - n.r * camera.zoom).toBeGreaterThanOrEqual(-0.5);
      expect(sx + n.r * camera.zoom).toBeLessThanOrEqual(w + 0.5);
      expect(sy - n.r * camera.zoom).toBeGreaterThanOrEqual(-0.5);
      expect(sy + n.r * camera.zoom).toBeLessThanOrEqual(h + 0.5);
    }
  });

  it('is the floor of hand zoom, and zooming out from it never zooms in', () => {
    const floor = getMinZoom();
    expect(state.camera.zoom).toBeGreaterThanOrEqual(floor - 1e-9);
    expect(state.camera.zoom).toBeLessThan(0.25); // the old floor would have cut this map
    const out = zoomAbout(state.camera, 0.88, w / 2, h / 2, floor);
    expect(out.zoom).toBeLessThanOrEqual(state.camera.zoom);
    expect(zoomAbout({ ...state.camera, zoom: floor / 2 }, 0.88, 5, 5, floor).zoom).toBeLessThanOrEqual(floor / 2);
  });
});

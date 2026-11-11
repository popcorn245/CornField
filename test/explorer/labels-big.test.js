// @vitest-environment node
/**
 * Labels on the big synthetic map (spec 0008 D2, test/fixtures/big, seed 245), at the layers on at load: at the fitted zoom, 0.25, 0.5,
 * 1 and 2, no two labels touch, every label is 11 px or more on screen (a hub's title 13 px and bold), every node can be labelled at every
 * zoom (no cut-off), and how many are labelled at each zoom is held to the number the build measured. Text is measured with a fixed
 * width per glyph (0.55 of the size), so the numbers are the same wherever this runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeBig } from '../fixtures/big/make.js';
// @ts-expect-error plain JS modules, no declarations
import { computeDegreeCentrality, computeOrbitalLayout } from '../../explorer/layout.js';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene, LANDMARK_TYPES } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { chooseLabels, placeLabels, LABEL_PAD } from '../../explorer/labels.js';
// @ts-expect-error plain JS modules, no declarations
import { fitGraphToViewport, fitPadding } from '../../explorer/render.js';

const saved = { ctx: state.ctx, nodes: state.nodes, edges: state.edges, view: state.view, width: state.width, height: state.height, camera: state.camera, activeLayers: state.activeLayers };
afterAll(() => Object.assign(state, saved));

const measure = (text, size) => text.length * size * 0.55;
let scene, fitted;
const hubIds = () => new Set(scene.nodes.filter((n) => LANDMARK_TYPES.includes(n.type)).map((n) => n.id));

beforeAll(() => {
  state.ctx = { save() {}, restore() {}, font: '', measureText: (s) => ({ width: s.length * 6 }) };
  const topology = makeBig({ seed: 245 }).topology;
  state.nodes = structuredClone(topology.nodes);
  state.edges = structuredClone(topology.edges);
  state.view = 'orbit';
  state.activeLayers = { ...saved.activeLayers };
  computeDegreeCentrality();
  computeOrbitalLayout();
  state.sceneVersion = 1;
  scene = buildScene(state);
  state.width = 1440; state.height = 900; state.camera = { x: 0, y: 0, zoom: 1 };
  fitGraphToViewport(fitPadding());
  fitted = state.camera.zoom;
});

const touching = (placed, pad = 0) => {
  // Boxes are in zoom-scaled coordinates; a sweep over x finds every pair that touches
  const sorted = [...placed].sort((a, b) => a.l - b.l);
  const bad = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].l < sorted[i].r + pad; j++) {
      const a = sorted[i], b = sorted[j];
      if (a.t - pad < b.b && a.b + pad > b.t) bad.push(`${a.id} / ${b.id}`);
    }
  }
  return bad;
};

describe('labels on the big map at five zooms (spec 0008 D2)', () => {
  it('fits the whole map at a zoom a little over 0.13 at 1440 x 900', () => {
    expect(fitted).toBeGreaterThan(0.12);
    expect(fitted).toBeLessThan(0.2);
  });

  const zooms = () => [fitted, 0.25, 0.5, 1, 2];

  it('puts no two labels on top of each other, or within 2 px, at the fitted zoom, 0.25, 0.5, 1 and 2', () => {
    for (const zoom of zooms()) {
      const placed = placeLabels(scene, zoom, { measure });
      expect(placed.length, `zoom ${zoom}`).toBeGreaterThan(50);
      expect(touching(placed, LABEL_PAD), `zoom ${zoom}`).toEqual([]);
    }
  });

  it('draws every label 11 px or more on screen, and a hub\'s title 13 px or more and bold, at every zoom', () => {
    const hubs = hubIds();
    for (const zoom of zooms()) {
      for (const p of placeLabels(scene, zoom, { measure })) {
        expect(p.px, `${p.id} at ${zoom}`).toBeGreaterThanOrEqual(hubs.has(p.id) ? 13 : 11);
        expect(p.size * zoom).toBeCloseTo(p.px, 6);
        if (hubs.has(p.id)) expect(p.bold).toBe(true);
      }
      // and the items the layer draws say the same
      const items = chooseLabels(scene, { x: 0, y: 0, zoom }, { width: 1e6, height: 1e6 }, { measure, margin: 1e6, max: 1e6 }).filter((i) => i.kind === 'node');
      for (const i of items) expect(i.size * zoom).toBeGreaterThanOrEqual(11 - 1e-9);
    }
  });

  it('gives every node a chance at every zoom: nothing is cut off by zoom, even 0.25', () => {
    // At 0.25 the old rule labelled landmarks only. Now plain nodes (pages) are labelled too, and at 1 and 2 nearly everything is
    const byType = (zoom) => placeLabels(scene, zoom, { measure }).filter((p) => scene.nodes[p.index].type === 'page').length;
    expect(byType(fitted)).toBeGreaterThan(0);
    expect(byType(0.25)).toBeGreaterThan(50);
    expect(byType(1)).toBeGreaterThan(300);
  });

  it('names every cluster title that has room at the fitted zoom, the biggest clusters first, and more of them as the map is zoomed in', () => {
    const hubs = hubIds();
    const titles = (zoom) => placeLabels(scene, zoom, { measure }).filter((p) => hubs.has(p.id)).length;
    expect(titles(fitted)).toBeGreaterThanOrEqual(48); // 48 of 87 at 13 px at 1440 (the spec's measure of the packed layout); the placer does at least that
    expect(titles(0.5)).toBeGreaterThan(titles(fitted));
    expect(titles(1)).toBe(hubs.size); // every one at 1 (a hub is placed before the rest, so nothing but another hub can take its room)
  });

  it('labels, at each zoom, the number of nodes the build measured', () => {
    const count = (zoom) => placeLabels(scene, zoom, { measure }).length;
    // 824 nodes are shown at load. Measured by this build with the fixed glyph width above; a change to the placer or the layout moves them.
    const want = new Map([[0.25, 295], [0.5, 544], [1, 790], [2, 793]]);
    for (const [zoom, n] of want) {
      expect(count(zoom), `zoom ${zoom}`).toBeGreaterThanOrEqual(Math.floor(n * 0.97));
      expect(count(zoom), `zoom ${zoom}`).toBeLessThanOrEqual(Math.ceil(n * 1.03));
    }
    expect(count(fitted)).toBeGreaterThanOrEqual(120);
    expect(count(fitted)).toBeLessThanOrEqual(140);
  });

  it('labels about two thirds of the nodes at 0.5, against landmarks alone (about 90) before', () => {
    const labelled = placeLabels(scene, 0.5, { measure }).length;
    expect(labelled / scene.nodes.length).toBeGreaterThan(0.6);
    expect(labelled).toBeGreaterThan(scene.nodes.filter((n) => LANDMARK_TYPES.includes(n.type)).length * 5);
  });

  it('is stable: a pan changes which labels are in view, never which are placed, and the same map places the same labels', () => {
    const a = placeLabels(scene, 0.5, { measure }).map((p) => p.id);
    expect(placeLabels(scene, 0.5, { measure }).map((p) => p.id)).toEqual(a);
    const placed = placeLabels(scene, 0.5, { measure });
    const ids = (cam) => chooseLabels(scene, cam, { width: 1440, height: 900 }, { measure, placed }).filter((i) => i.kind === 'node').map((i) => i.id);
    const all = new Set(a);
    for (const cam of [{ x: 0, y: 0, zoom: 0.5 }, { x: 400, y: 300, zoom: 0.5 }, { x: 387, y: 311, zoom: 0.5 }]) for (const id of ids(cam)) expect(all.has(id)).toBe(true);
    // two views a few pixels apart place the same labels where they overlap
    const x = new Set(ids({ x: 400, y: 300, zoom: 0.5 }));
    const y = ids({ x: 387, y: 311, zoom: 0.5 });
    expect(y.length).toBeGreaterThan(50);
    expect(y.filter((id) => x.has(id)).length).toBeGreaterThan(y.length * 0.8);
  });

  it('places the labels for a zoom in under 10 ms on 824 nodes, and chooses from them in under 2 ms', () => {
    const median = (run) => { const t = []; for (let i = 0; i < 15; i++) { const t0 = performance.now(); run(); t.push(performance.now() - t0); } return t.sort((x, y) => x - y)[7]; };
    expect(median(() => placeLabels(scene, 0.5, { measure }))).toBeLessThan(10);
    const placed = placeLabels(scene, 0.5, { measure });
    expect(median(() => chooseLabels(scene, { x: 0, y: 0, zoom: 0.5 }, { width: 1440, height: 900 }, { measure, placed }))).toBeLessThan(2);
  });
});

/**
 * What a selection lights and where the camera goes (spec 0008 D5 and D6), as pure functions on the big fixture's own map and on small ones.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { activeSubgraph, linesByKind, farEnds, countOffScreen, selectionCamera, connectedLine, kindPanelWord, FRAME_MIN_ZOOM } from '../../explorer/selection-model.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene, getActiveSubgraph } from '../../explorer/scene.js';
import { makeBig } from '../fixtures/big/make.js';
// @ts-expect-error plain JS modules, no declarations
import { computeDegreeCentrality, computeOrbitalLayout } from '../../explorer/layout.js';
// @ts-expect-error plain JS modules, no declarations
import { state as shared } from '../../explorer/state.js';

const edges = [
  { from: 'root', to: 'app' },
  { from: 'app', to: 'page' }, { from: 'app', to: 'page2' },
  { from: 'page', to: 'tbl', kind: 'reads' }, { from: 'page', to: 'svc', kind: 'calls' },
  { from: 'page2', to: 'tbl2', kind: 'writes' }, { from: 'svc2', to: 'page2', kind: 'calls' },
  { from: 'page', to: 'comp', dashed: true },
  { from: 'far', to: 'svc', kind: 'calls' },
];

describe('one hop (D5)', () => {
  it('lights the node and everything one edge from it, of any kind: parent, children, reads, calls, usage', () => {
    const g = activeSubgraph({ id: 'page' }, edges);
    expect([...g.connectedNodeIds].sort()).toEqual(['app', 'comp', 'page', 'svc', 'tbl']);
    expect(g.connectedEdgeKeys.has('page2->tbl2')).toBe(false);
    expect(g.connectedEdgeKeys.has('far->svc')).toBe(false); // two hops away
  });
  it('lights an app\'s children, not what its children touch, until the switch is on', () => {
    const off = activeSubgraph({ id: 'app' }, edges);
    expect([...off.connectedNodeIds].sort()).toEqual(['app', 'page', 'page2', 'root']);
    expect([...off.childIds].sort()).toEqual(['page', 'page2']);
    const on = activeSubgraph({ id: 'app' }, edges, { throughChildren: true });
    expect([...on.connectedNodeIds].sort()).toEqual(['app', 'comp', 'page', 'page2', 'root', 'svc', 'svc2', 'tbl', 'tbl2']);
  });
  it('counts the lit lines by kind, in a fixed order, and keeps the others listed when one kind is chosen', () => {
    const g = activeSubgraph({ id: 'page' }, edges);
    expect(linesByKind(g).map((k) => `${k.word} ${k.count}`)).toEqual(['Owns 1', 'Links 1', 'Reads 1', 'Calls 1']);
    const calls = activeSubgraph({ id: 'page' }, edges, { kind: 'calls' });
    expect([...calls.connectedNodeIds].sort()).toEqual(['page', 'svc']);
    expect(calls.kind).toBe('calls');
    expect(linesByKind(calls).map((k) => k.kind)).toEqual(['ownership', 'usage', 'reads', 'calls']);
    expect(activeSubgraph({ id: 'page' }, edges, { kind: 'writes' }).kind).toBeNull(); // not among the lit lines: ignored
  });
  it('lists the far ends of a kind once each, with their direction', () => {
    const g = activeSubgraph({ id: 'page2' }, edges);
    expect(farEnds(g, 'calls')).toEqual([{ id: 'svc2', out: false }]);
    expect(farEnds(g, 'writes')).toEqual([{ id: 'tbl2', out: true }]);
  });
  it('says a kind\'s own word, and shows an unknown kind as the text it is', () => {
    expect(kindPanelWord('runs-on')).toBe('Runs on');
    expect(kindPanelWord('<b>x</b>')).toBe('<b>x</b>'); // text: the panel escapes it
    expect(kindPanelWord('__proto__')).toBe('__proto__');
    expect(activeSubgraph(null, edges)).toBeNull();
  });
});

describe('the camera rule (D6)', () => {
  const rect = { x: 0, y: 0, width: 1000, height: 700 };
  it('frames the node and its lit set when that fits at zoom 0.5 or closer', () => {
    const t = selectionCamera({ x: 0, y: 0, r: 20 }, [{ x: 0, y: 0, r: 20 }, { x: 300, y: 100, r: 20 }, { x: -200, y: -100, r: 20 }], rect);
    expect(t.framed).toBe(true);
    expect(t.zoom).toBeGreaterThanOrEqual(FRAME_MIN_ZOOM);
    expect(t.zoom).toBeLessThanOrEqual(1);
  });
  it('centres the node at zoom 1 when its lit set is too wide to frame', () => {
    const t = selectionCamera({ x: 100, y: 50, r: 20 }, [{ x: 100, y: 50, r: 20 }, { x: 5000, y: 0, r: 20 }], rect);
    expect(t).toMatchObject({ zoom: 1, framed: false, x: 500 - 100, y: 350 - 50 });
  });
  it('frames into the rect it is given, not the whole canvas', () => {
    const covered = { x: 400, y: 0, width: 600, height: 700 }; // a review column on the left
    const t = selectionCamera({ x: 0, y: 0, r: 20 }, [{ x: 0, y: 0, r: 20 }], covered);
    expect(t.x).toBeCloseTo(700, 0);
  });
  it('counts what is outside the visible rect', () => {
    const pts = [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 100, y: 2000 }];
    expect(countOffScreen(pts, { x: 100, y: 100, zoom: 1 }, { x: 0, y: 0, width: 400, height: 400 })).toBe(2);
    expect(connectedLine(27, 9)).toBe('27 connected · 9 off screen');
    expect(connectedLine(3, 0)).toBe('3 connected · all on screen');
  });
});

describe('on the big map', () => {
  const saved = { ctx: shared.ctx, nodes: shared.nodes, edges: shared.edges, view: shared.view, activeLayers: shared.activeLayers };
  const state = shared;
  beforeAll(() => {
    state.ctx = { save() {}, restore() {}, font: '', measureText: (t) => ({ width: t.length * 6 }) };
    const topology = makeBig({ seed: 245 }).topology;
    state.nodes = structuredClone(topology.nodes);
    state.edges = structuredClone(topology.edges);
    state.view = 'orbit';
    state.activeLayers = { ...saved.activeLayers };
    computeDegreeCentrality();
    computeOrbitalLayout();
  });
  afterAll(() => Object.assign(state, saved));
  const lit = (node, opts) => { const g = getActiveSubgraph(node, state.edges, opts); return { nodes: g.connectedNodeIds.size, edges: g.connectedEdgeKeys.size }; };
  it('lights far less of the map for the root, a big app and a service than the children\'s paths did', () => {
    const root = state.nodes.find((n) => n.type === 'root');
    const kids = (n) => state.edges.filter((e) => !e.kind && !e.dashed && e.from === n.id).length;
    const app = state.nodes.filter((n) => n.type === 'app').sort((a, b) => kids(b) - kids(a))[0];
    const one = lit(root); const wide = lit(root, { throughChildren: true });
    expect(one.nodes).toBeLessThan(wide.nodes / 4);
    expect(one.nodes).toBe(1 + state.edges.filter((e) => e.from === root.id || e.to === root.id).length);
    expect(lit(app).nodes).toBeLessThan(lit(app, { throughChildren: true }).nodes);
    state.sceneVersion = 1;
    const scene = buildScene({ ...state, selectedNode: app, throughChildren: false, selectedKind: null, scenario: null, searchQuery: '' });
    expect(scene.nodes.filter((n) => n.connected).length).toBeLessThanOrEqual(lit(app).nodes); // the scene draws only what the layers show
  });
});

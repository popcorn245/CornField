// The Work view's layers, search and shapes on the engine (spec 0012 D2, D4): the Layers menu's rows, a layer on its own set that leaves the map's alone,
// the shapes the renderers number, and search finding work from the map.
import { describe, it, expect } from 'vitest';
import { createInstance } from '../../explorer/instance.js';
import { createState } from '../../explorer/instance-state.js';
import { layerRows, setLayer, toggleAllLayers, toggleLayer, isOn } from '../../explorer/engine/layers.js';
import { workScene, setWorkGraph, enterWork, leaveWork, startLayers, applyFilters } from '../../explorer/work-model.js';
import { WORK_THEMES, WORK_KINDS } from '../../core/schema.js';
import { SHAPES } from '../../core/schema.js';
import { SHAPE_CODE } from '../../explorer/renderer-webgl.js';
import { searchNodes } from '../../explorer/search-model.js';
import { SHAPE_REACH } from '../../explorer/scene.js';

const map = [{ id: 'auth', label: 'auth', type: 'core' }, { id: 'api', label: 'api', type: 'app' }];
const graph = {
  nodes: [
    { id: 'pull:7', kind: 'pull', stage: 'build', title: 'Fix the sign-in loop', state: 'open', open: true, waiting: false, number: 7, updated: '2026-11-12T00:00:00Z' },
    { id: 'issue:3', kind: 'issue', stage: 'talk', title: 'Sign-in loops', state: 'open', open: true, waiting: false, number: 3, updated: '2026-11-11T00:00:00Z' },
  ],
  edges: [{ from: 'pull:7', to: 'auth', rel: 'changes' }, { from: 'pull:7', to: 'issue:3', rel: 'closes' }],
};
const open = () => {
  const state = createState();
  state.nodes = map.map((n) => ({ ...n }));
  state.edges = [];
  const inst = createInstance({ state, root: null });
  inst.store = { get: () => null, set: () => {}, remove: () => {} };
  setWorkGraph(state, graph, state.nodes);
  state.view = 'work';
  enterWork(state);
  return { state, inst };
};

describe('layers in the Work view (D4)', () => {
  it('lists the six kinds and the code they touch, with counts, and a layer is on its own set', () => {
    const { state, inst } = open();
    const before = { ...state.activeLayers };
    const { layers, overlays } = layerRows(inst);
    expect(layers.map((l) => l.key)).toEqual(['work-thread', 'work-issue', 'work-proposal', 'work-pull', 'work-run', 'work-deploy', 'work-drafts', 'work-code']);
    expect(overlays).toEqual([]);
    expect(layers.find((l) => l.key === 'work-pull').countText).toBe('1 open');
    expect(isOn(inst, 'work-pull')).toBe(true);
    toggleLayer(inst, 'work-pull');
    expect(isOn(inst, 'work-pull')).toBe(false);
    expect(state.workLayers['work-pull']).toBe(false);
    expect(state.activeLayers).toEqual(before); // the map's layers are not written
    setLayer(inst, 'work-pull', true);
    toggleAllLayers(inst, false);
    expect(Object.values(state.workLayers).every((v) => v === false)).toBe(true);
    expect(state.activeLayers).toEqual(before);
  });
  it('leaves the map\'s own rows and layers as they were', () => {
    const { state, inst } = open();
    toggleLayer(inst, 'work-issue');
    leaveWork(state);
    state.view = 'orbit';
    expect(layerRows(inst).layers.some((l) => l.key.startsWith('work-'))).toBe(false);
    expect(isOn(inst, 'app')).toBe(true);
    expect(state.workLayers).toBeNull();
  });
});

describe('shapes (D2)', () => {
  it('are among the map\'s five silhouettes, which both renderers and the shader number, and each has a reach for a hit', () => {
    for (const kind of WORK_KINDS) {
      expect(SHAPES).toContain(WORK_THEMES[kind].shape);
      expect(SHAPE_CODE[WORK_THEMES[kind].shape]).toBeGreaterThanOrEqual(0);
      expect(SHAPE_REACH[WORK_THEMES[kind].shape]).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('search (D2 and the Work view)', () => {
  it('finds a piece of work by #n, PR n, words of a title, and groups it under its layer\'s name', () => {
    const { nodes } = workScene(graph, map);
    const ids = (q) => searchNodes(nodes, q).matches.map((m) => m.node.id);
    expect(ids('#7')).toEqual(['pull:7']);
    expect(ids('PR 7')).toEqual(['pull:7']);
    expect(ids('sign-in')).toEqual(expect.arrayContaining(['pull:7', 'issue:3']));
    expect(searchNodes(nodes, '#7').groups[0].name).toBe('Pull requests');
  });
  it('lets the search piece read the work the page offers from another view', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../../explorer/pieces/search.js', import.meta.url), 'utf8');
    expect(src).toContain("inst.ask('search:more')");
    expect(src).toContain("inst.emit('work:open'");
  });
});

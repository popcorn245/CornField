/**
 * @vitest-environment node
 *
 * What a playing scenario does to the scene (TOPO-10): `state.scenario` (the player's
 * snapshot) lights the walk and dims the rest, the way the ROM walk always did, and makes the
 * current step stand out. Built through buildScene, from small hand-made states.
 */
import { describe, it, expect } from 'vitest';
import {
  DIM_ALPHA, buildScene, emphasiseScenario, packetPoint, edgePoint,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { createPlayer } from '../../explorer/scenario.js';

const node = (id        , type        , x = 0, y = 0, extra         = {}) => ({ id, type, x, y, r: 20, color: '#336699', label: id, ...extra });
const link = (from        , to        , extra         = {}) => ({ from, to, ...extra });

const nodes = [node('page', 'page', 0, 0), node('api', 'page', 200, 0), node('tbl', 'table', 400, 0), node('other', 'page', 600, 0), node('app', 'app', 300, 200)];
const edges = [
  link('page', 'api', { kind: 'calls', label: 'POST /meals' }),
  link('api', 'tbl', { kind: 'writes', label: 'meals' }),
  link('tbl', 'other', { kind: 'reads', label: 'meals' }),
  link('app', 'other'), // an ownership link, nothing to do with the walk
  link('app', 'page', { dashed: true }),
];

function mkState(extra         = {})      {
  return {
    nodes, edges,
    view: 'orbit', flow: null, rings: { rings: [], clusters: [] },
    camera: { x: 0, y: 0, zoom: 1 }, width: 800, height: 600,
    selectedNode: null, searchQuery: '', isFreeform: false,
    activeLayers: { app: true, pkg: true, page: true, atom: true, molecule: true, token: true, tool: true, flow: true, table: true, rom: true, service: true, external: true, stack: false },
    scenario: null, sceneVersion: 1,
    ...extra,
  };
}

const scenario = (extra         = {}) => ({
  id: 's', title: 'Saving a meal',
  steps: [
    { node: 'page', text: 'The page opens.' },
    { edge: { from: 'page', to: 'api', kind: 'calls' }, text: 'It calls POST /meals.' },
    { node: 'api', text: 'The API checks it.' },
    { edge: { from: 'api', to: 'tbl', kind: 'writes' }, text: 'It writes the row.' },
  ],
  ...extra,
});

/** A player standing on step `i` (or played to the end) */
function snap(i        , opts                                                         = {}) {
  const p = createPlayer(opts.scenario || scenario(), { stepMs: opts.stepMs ?? 1000 });
  p.goTo(i);
  if (opts.done) p.next();
  return p.snapshot();
}
const build = (i        , extra         = {}, opts      = {}, buildOpts         = {}) => buildScene(mkState({ scenario: snap(i, opts), ...extra }), buildOpts);
const nodeOf = (scene     , id        ) => scene.nodes.find((n     ) => n.id === id);
const edgeOf = (scene     , from        , to        ) => scene.edges.find((e     ) => e.from === from && e.to === to);

describe('a scenario on the scene', () => {
  it('is no change at all while none is playing', () => {
    const plain = buildScene(mkState());
    expect(buildScene(mkState({ scenario: null }))).toEqual(plain);
    expect(plain.nodes.every((n     ) => n.alpha === 1)).toBe(true);
  });

  it('lights the nodes the walk has reached and dims the rest', () => {
    const scene = build(2);
    expect(scene.nodes.filter((n     ) => n.connected).map((n     ) => n.id)).toEqual(['page', 'api']);
    expect(nodeOf(scene, 'tbl')).toMatchObject({ alpha: DIM_ALPHA, glow: 0, connected: false });
    expect(nodeOf(scene, 'other')).toMatchObject({ alpha: DIM_ALPHA });
  });

  it('puts the selected-style halo on the current node step, and keeps the visited ones faintly lit', () => {
    const scene = build(2);
    expect(nodeOf(scene, 'api')).toMatchObject({ alpha: 1, halo: 'selected', connected: true });
    const before = nodeOf(scene, 'page');
    expect(before.connected).toBe(true);
    expect(before.halo).toBe('none');
    expect(before.alpha).toBeLessThan(1);
    expect(before.alpha).toBeGreaterThan(DIM_ALPHA);
    expect(before.labelAlpha).toBe(before.alpha);
  });

  it('a search hit keeps its own halo (match wins over selected, as everywhere)', () => {
    const scene = build(2, { searchQuery: 'api' });
    expect(nodeOf(scene, 'api').halo).toBe('match');
  });

  it('draws the current edge step bright and wide, with a packet that makes one trip per step', () => {
    const scene = build(1, {}, { stepMs: 800 });
    const e = edgeOf(scene, 'page', 'api');
    expect(e).toMatchObject({ alpha: 1, glow: 14 });
    expect(e.width).toBeGreaterThanOrEqual(3.4);
    expect(e.packet).toMatchObject({ color: '#ffffff', speed: 1000 / 800 });
    expect(e.packet.radius).toBeGreaterThan(3.5);
    // both ends are the action: full strength, no halo
    expect(nodeOf(scene, 'page')).toMatchObject({ alpha: 1, halo: 'none' });
    expect(nodeOf(scene, 'api')).toMatchObject({ alpha: 1, halo: 'none' });
  });

  it('draws an edge the map keeps quiet (a page calling out) because the walk asks for it', () => {
    const quiet = [node('page', 'page'), node('svc', 'service', 100, 0)];
    const scene = buildScene(mkState({ nodes: quiet, edges: [link('page', 'svc', { kind: 'calls' })], scenario: snap(1, { scenario: { id: 'q', title: 'Q', steps: [{ node: 'page', text: 'a' }, { edge: { from: 'page', to: 'svc', kind: 'calls' }, text: 'b' }] } }) }));
    expect(edgeOf(scene, 'page', 'svc')).toMatchObject({ alpha: 1 });
    expect(buildScene(mkState({ nodes: quiet, edges: [link('page', 'svc', { kind: 'calls' })] })).edges).toEqual([]);
  });

  it('keeps earlier edge steps faintly lit, with no packet, and dims every other edge', () => {
    const scene = build(3);
    const visited = edgeOf(scene, 'page', 'api');
    expect(visited.alpha).toBeLessThan(1);
    expect(visited.alpha).toBeGreaterThan(0.04);
    expect(visited.packet).toBeNull();
    expect(edgeOf(scene, 'api', 'tbl')).toMatchObject({ alpha: 1, glow: 14 });
    expect(edgeOf(scene, 'tbl', 'other')).toMatchObject({ alpha: 0.04, packet: null });
    expect(edgeOf(scene, 'app', 'other').color).toBe('rgba(255, 255, 255, 0.02)'); // an ownership link outside the walk: the dimmed look
  });

  it('shows the label of the current edge step', () => {
    expect(edgeOf(build(3), 'api', 'tbl').label).toMatchObject({ text: 'meals' });
  });

  it('starts the packet at the beginning of the edge when the step begins, and ends the trip with the step', () => {
    const stepMs = 1000;
    const p = createPlayer(scenario(), { stepMs });
    p.goTo(3);
    p.play();
    p.tick(7000);
    const scene = buildScene(mkState({ scenario: p.snapshot() }));
    const e = edgeOf(scene, 'api', 'tbl');
    const start = edgePoint(e, 0);
    const at = (t        ) => packetPoint(e, t);
    expect(at(7000).x).toBeCloseTo(start.x, 5);
    expect(at(7500).x).toBeGreaterThan(start.x);
    expect(at(7999).x).toBeCloseTo(edgePoint(e, 1).x, 0);
  });

  it('describes no packet under reduced motion; the step is still lit', () => {
    const scene = build(1, {}, {}, { reduceMotion: true });
    expect(edgeOf(scene, 'page', 'api')).toMatchObject({ alpha: 1, glow: 14, packet: null });
  });

  it('wins over the selection, and a selected node outside the walk is dimmed with the rest', () => {
    const scene = build(1, { selectedNode: nodes[2] });
    expect(nodeOf(scene, 'tbl')).toMatchObject({ alpha: DIM_ALPHA, selected: true, connected: false });
  });

  it('lights only its own edge steps, unless the scenario links the nodes it visits', () => {
    const onlyNodes = { id: 'n', title: 'N', steps: [{ node: 'api', text: 'a' }, { node: 'tbl', text: 'b' }] };
    const plain = buildScene(mkState({ scenario: snap(1, { scenario: onlyNodes }) }));
    expect(edgeOf(plain, 'api', 'tbl')).toMatchObject({ alpha: 0.04 }); // visited both ends, but nobody said the edge
    const linked = buildScene(mkState({ scenario: snap(1, { scenario: { ...onlyNodes, linkNodes: true } }) }));
    expect(edgeOf(linked, 'api', 'tbl').alpha).toBeGreaterThan(0.04); // the ROM walk: the pipeline between what it reached
  });

  it('shows the whole walk once it is done: every visited node and edge lit as before, nothing singled out', () => {
    const scene = build(3, {}, { done: true });
    expect(scene.nodes.filter((n     ) => n.connected).map((n     ) => n.id)).toEqual(['page', 'api', 'tbl']);
    for (const id of ['page', 'api', 'tbl']) expect(nodeOf(scene, id)).toMatchObject({ alpha: 1, halo: 'none' });
    expect(edgeOf(scene, 'page', 'api')).toMatchObject({ alpha: 1, glow: 8 });
    expect(edgeOf(scene, 'api', 'tbl')).toMatchObject({ alpha: 1, glow: 8 });
    expect(edgeOf(scene, 'api', 'tbl').packet).not.toBeNull();
  });

  it('does not change the snapshot it reads', () => {
    const s = snap(2);
    const copy = { visited: { nodes: [...s.visited.nodes], edges: [...s.visited.edges] }, current: { ...s.current }, index: s.index };
    buildScene(mkState({ scenario: s }));
    expect({ visited: { nodes: [...s.visited.nodes], edges: [...s.visited.edges] }, current: { ...s.current }, index: s.index }).toEqual(copy);
  });

  it('leaves a step that points at nothing drawn alone (a layer off, an edge the map has not got)', () => {
    const ghost = { id: 'g', title: 'G', steps: [{ node: 'page', text: 'a' }, { edge: { from: 'page', to: 'nowhere', kind: 'calls' }, text: 'b' }, { node: 'ghost', text: 'c' }] };
    expect(() => build(2, {}, { scenario: ghost })).not.toThrow();
    const scene = build(2, { activeLayers: { ...mkState().activeLayers, page: false } }, { scenario: ghost });
    expect(scene.nodes.some((n     ) => n.id === 'page')).toBe(false);
  });
});

describe('composing with proposal marks', () => {
  it('never writes `mark`, on a node or an edge', () => {
    const marks = ['added', 'changed', 'removed', 'edit', 'none'];
    const scene      = {
      nodes: ['page', 'api', 'tbl'].map((id, i) => ({ id, alpha: 1, glow: 9, halo: 'none', mark: marks[i], connected: true, labelAlpha: 1 })),
      edges: [
        { key: 'page->api|calls', from: 'page', to: 'api', kind: 'calls', alpha: 1, width: 2.4, glow: 8, glowColor: '#fff', color: '#0ff', packet: null, mark: 'added' },
        { key: 'api->tbl|writes', from: 'api', to: 'tbl', kind: 'writes', alpha: 1, width: 2.4, glow: 8, glowColor: '#fff', color: '#0ff', packet: null, mark: 'removed' },
      ],
    };
    const state = mkState({ scenario: snap(3) });
    emphasiseScenario(scene, state.scenario, { reduceMotion: false });
    expect(scene.nodes.map((n     ) => n.mark)).toEqual(['added', 'changed', 'removed']);
    expect(scene.edges.map((e     ) => e.mark)).toEqual(['added', 'removed']);
    expect(scene.edges[1].packet).not.toBeNull(); // and it still lit the current step
    expect(scene.nodes[1].halo).toBe('none'); // an edge step: its ends are lit, not haloed
  });

});

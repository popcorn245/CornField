/**
 * @vitest-environment node
 *
 * Who does a step and where (spec 0029 section 3, PHY-01): the player hands the current step's
 * actor (its own, else the scenario's), its place (`at`), its checks and its expectation to the
 * explorer; a place is lit with the step, gets the step's halo, and the camera brings it into view.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { cameraFor, createPlayer, stepActor } from '../../explorer/scenario.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene } from '../../explorer/scene.js';

const scenario = (extra         = {}) => ({
  id: 'child-in-kitchen',
  title: 'A child in the kitchen',
  actor: 'child',
  steps: [
    { node: 'page-scan', at: 'room-kitchen', text: 'She scans the tag.' },
    { edge: { from: 'page-scan', to: 'table-tasks', kind: 'writes' }, check: { table: 'tasks', op: 'write', row: 'household' }, expect: 'allowed', text: 'She adds a task.' },
    { node: 'page-house', actor: 'adult', at: 'live-room-office', check: [], text: 'An adult opens House in the office.' },
  ],
  ...extra,
});
const at = (i        , sc         = scenario()) => {
  const p = createPlayer(sc);
  p.goTo(i);
  return p.snapshot();
};

describe('the actor of a step', () => {
  it('is the step\'s own, else the scenario\'s, else none', () => {
    const sc = scenario();
    expect(stepActor(sc, sc.steps[0])).toBe('child');
    expect(stepActor(sc, sc.steps[2])).toBe('adult');
    expect(stepActor({ ...sc, actor: undefined }, sc.steps[0])).toBeNull();
    expect(stepActor(null, null)).toBeNull();
  });
});

describe('the player\'s snapshot', () => {
  it('carries the current step\'s actor, place, checks and expectation', () => {
    expect(at(0).current).toEqual({ node: 'page-scan', text: 'She scans the tag.', actor: 'child', at: 'room-kitchen' });
    expect(at(1).current).toMatchObject({ actor: 'child', check: { table: 'tasks', op: 'write', row: 'household' }, expect: 'allowed' });
    expect(at(2).current).toMatchObject({ node: 'page-house', actor: 'adult', at: 'live-room-office', check: [] });
  });

  it('leaves the fields out of a step that has none, as before', () => {
    const plain = { id: 's', title: 'S', steps: [{ node: 'a', text: 'x' }] };
    expect(at(0, plain).current).toEqual({ node: 'a', text: 'x' });
  });

  it('counts a step\'s place among the nodes the walk has reached', () => {
    expect([...at(0).visited.nodes]).toEqual(['page-scan', 'room-kitchen']);
    expect([...at(2).visited.nodes]).toEqual(['page-scan', 'room-kitchen', 'table-tasks', 'page-house', 'live-room-office']);
  });
});

describe('the camera and a step\'s place', () => {
  const view = { width: 800, height: 600 };
  const camera = { x: 0, y: 0, zoom: 1 };
  const nodes = new Map([['near', { x: 300, y: 300 }], ['far', { x: 3000, y: 300 }]]);

  it('brings the place into view with the step', () => {
    const cam = cameraFor({ node: 'near', at: 'far', text: '' }, camera, view, nodes);
    expect(cam).not.toBeNull();
    expect(cam.zoom).toBeLessThan(1);
  });

  it('ignores a place that is not on the map (a live id with no live layer)', () => {
    expect(cameraFor({ node: 'near', at: 'live-room-kitchen', text: '' }, camera, view, nodes)).toBeNull();
  });
});

describe('a step\'s place on the scene', () => {
  const node = (id        , x = 0) => ({ id, type: 'page', x, y: 0, r: 20, color: '#336699', label: id });
  const state = (scn        ) => ({
    nodes: [node('page-scan', 0), node('table-tasks', 200), node('room-kitchen', 400), node('other', 600)],
    edges: [{ from: 'page-scan', to: 'table-tasks', kind: 'writes', label: 'tasks' }],
    view: 'orbit', flow: null, rings: { rings: [], clusters: [] },
    selectedNode: null, searchQuery: '', isFreeform: false,
    activeLayers: { page: true, table: true },
    scenario: scn, sceneVersion: 1,
  });
  const of = (scene     , id        ) => scene.nodes.find((n     ) => n.id === id);

  it('is lit with the step and gets the step\'s halo', () => {
    const scene = buildScene(state(at(0)));
    expect(of(scene, 'room-kitchen')).toMatchObject({ connected: true, alpha: 1, halo: 'selected' });
    expect(of(scene, 'page-scan')).toMatchObject({ connected: true, alpha: 1, halo: 'selected' });
    expect(of(scene, 'other').connected).toBe(false);
  });

  it('keeps its halo on an edge step, while the edge\'s ends get none', () => {
    const sc = scenario({ steps: [{ edge: { from: 'page-scan', to: 'table-tasks', kind: 'writes' }, at: 'room-kitchen', text: 'x' }] });
    const scene = buildScene(state(at(0, sc)));
    expect(of(scene, 'room-kitchen')).toMatchObject({ alpha: 1, halo: 'selected' });
    expect(of(scene, 'page-scan').halo).toBe('none');
  });

  it('changes nothing when the place is not on the map', () => {
    const sc = scenario({ steps: [{ node: 'page-scan', at: 'live-room-office', text: 'x' }] });
    const plain = scenario({ steps: [{ node: 'page-scan', text: 'x' }] });
    expect(buildScene(state(at(0, sc))).nodes).toEqual(buildScene(state(at(0, plain))).nodes);
  });
});

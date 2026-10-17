/**
 * The proposal format and the physical world (spec 0029 sections 1 and 3, PHY-01): a scenario's
 * `actor`, a step's `actor`, `at`, `check` and `expect`; live types in a proposal (they read `live`
 * in proposalStatus, never `pending`); and every committed proposal and the ROM walk still validate.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProposal, proposalStatus, proposalProblems } from '../../core/proposal.js';

import { SAMPLE, loadSample } from '../helpers.js';

/** A small map: an app with a page and a table */
const base = ()      => ({
  nodes: [
    { id: 'root', label: 'acme', type: 'root' },
    { id: 'app-a', label: 'a.example.test', type: 'app' },
    { id: 'page-home', label: '/', type: 'page' },
    { id: 'table-items', label: 'items', type: 'table', table: 'items' },
  ],
  edges: [
    { from: 'root', to: 'app-a' },
    { from: 'app-a', to: 'page-home' },
    { from: 'page-home', to: 'table-items', kind: 'writes', label: 'items.add' },
  ],
});
const minimal = (over                          = {})      => ({ version: 1, title: 'T', summary: 'S', ...over });
const errorsOf = (p         , t = base()) => validateProposal(t, p);
const messages = (p         , t = base()) => errorsOf(p, t).map((e     ) => `${e.path}: ${e.message}`);
const at = (p         , where        , t = base()) => errorsOf(p, t).filter((e     ) => e.path === where);

describe('validateProposal: actors, places, checks and expectations', () => {
  const persona = (id        ) => ({ id: `persona-${id}`, label: id, type: 'persona' });
  /** A proposal that adds two personas and one scenario with the given steps and scenario fields */
  const acted = (steps           , over                          = {}) => minimal({
    nodes: { add: [persona('child'), persona('adult')] },
    scenarios: [{ id: 's', title: 'S', steps, ...over }],
  });
  const step = (over                          = {}) => ({ node: 'page-home', text: 'x', ...over });

  it('accepts a scenario with an actor, and steps with their own actor, a place, checks and an expectation', () => {
    const p = acted([
      step({ at: 'live-room-kitchen' }),
      step({ actor: 'adult', at: 'app-a', check: { route: '/api/v1/rooms/[id]', method: 'PATCH' }, expect: 'refused' }),
      step({ check: [{ table: 'items', op: 'write', row: 'household' }, { table: 'items', op: 'read' }], expect: 'allowed' }),
      step({ check: [] }),
      { edge: { from: 'page-home', to: 'table-items', kind: 'writes' }, text: 'x', ms: 900 },
    ], { actor: 'child', stepMs: 1200, linkNodes: false });
    expect(messages(p)).toEqual([]);
  });

  it('every scenario written so far is unchanged and valid', () => {
    expect(messages(minimal({ scenarios: [{ id: 's', title: 'S', steps: [step(), { edge: { from: 'app-a', to: 'page-home' }, text: 'owns it' }] }] }))).toEqual([]);
  });

  it('wants an actor to be a persona on the map or added by the proposal', () => {
    expect(at(acted([step()], { actor: 'ghost' }), 'scenarios[0].actor')[0]).toMatchObject({ state: 'dangling', message: expect.stringMatching(/persona-ghost/) });
    expect(at(acted([step({ actor: 'ghost' })]), 'scenarios[0].steps[0].actor')).toHaveLength(1);
    expect(at(acted([step()], { actor: 'Child' }), 'scenarios[0].actor')[0].message).toMatch(/persona id/);
    expect(at(acted([step()], { actor: '' }), 'scenarios[0].actor')).toHaveLength(1);
    const onMap = { ...base(), nodes: [...base().nodes, { id: 'persona-guest', label: 'Guest', type: 'persona' }] };
    expect(messages(minimal({ scenarios: [{ id: 's', title: 'S', actor: 'guest', steps: [step()] }] }), onMap)).toEqual([]);
  });

  it('wants a place to be a node of the map or the proposal, or a live id', () => {
    expect(messages(acted([step({ at: 'table-items' })]))).toEqual([]);
    expect(messages(acted([step({ at: 'persona-child' })]))).toEqual([]);
    expect(messages(acted([step({ at: 'live-device-nfc-tag-4f' })]))).toEqual([]);
    expect(messages(acted([step({ at: 'live-floor-basement' })]))).toEqual([]);
    expect(at(acted([step({ at: 'nowhere' })]), 'scenarios[0].steps[0].at')[0]).toMatchObject({ state: 'dangling' });
    expect(at(acted([step({ at: 'live-shed-1' })]), 'scenarios[0].steps[0].at')[0].message).toMatch(/live-room-<id>/);
    expect(at(acted([step({ at: 3 })]), 'scenarios[0].steps[0].at')).toHaveLength(1);
  });

  it('holds a check to a route and a method, or a table, an op and a row', () => {
    const one = (check         ) => acted([step({ check })], { actor: 'child' });
    const path0 = 'scenarios[0].steps[0].check';
    expect(at(one({ route: 'rooms', method: 'PATCH' }), `${path0}.route`)).toHaveLength(1);
    expect(at(one({ route: '/x', method: 'FETCH' }), `${path0}.method`)).toHaveLength(1);
    expect(at(one({ route: '/x', method: 'patch' }), `${path0}.method`)).toHaveLength(1);
    expect(at(one({ route: '/x' }), `${path0}.method`)).toHaveLength(1);
    expect(at(one({ table: 'items', op: 'eat' }), `${path0}.op`)).toHaveLength(1);
    expect(at(one({ table: '', op: 'read' }), `${path0}.table`)).toHaveLength(1);
    expect(at(one({ table: 'items', op: 'read', row: 'mine' }), `${path0}.row`)).toHaveLength(1);
    expect(at(one({ route: '/x', method: 'GET', table: 'items' }), path0)[0].message).toMatch(/either/);
    expect(at(one({ route: '/x', method: 'GET', why: 'x' }), `${path0}.why`)).toHaveLength(1);
    expect(at(one({}), path0)).toHaveLength(1);
    expect(at(one('PATCH /x'), path0)).toHaveLength(1);
    expect(at(one([{ route: '/x', method: 'GET' }, { table: 'items', op: 'nope' }]), `${path0}[1].op`)).toHaveLength(1);
  });

  it('wants an expectation to be allowed or refused, on a step that has an actor', () => {
    expect(at(acted([step({ expect: 'maybe' })], { actor: 'child' }), 'scenarios[0].steps[0].expect')).toHaveLength(1);
    expect(at(acted([step({ expect: 'refused' })]), 'scenarios[0].steps[0].expect')[0].message).toMatch(/actor/);
    expect(messages(acted([step({ expect: 'refused', actor: 'child' })]))).toEqual([]);
  });

  it('names an unknown scenario key, and checks the timing fields', () => {
    expect(at(acted([step()], { actors: 'child' }), 'scenarios[0].actors')).toHaveLength(1);
    expect(at(acted([step()], { stepMs: -1 }), 'scenarios[0].stepMs')).toHaveLength(1);
    expect(at(acted([step()], { linkNodes: 'yes' }), 'scenarios[0].linkNodes')).toHaveLength(1);
    expect(at(acted([step({ ms: 'slow' })]), 'scenarios[0].steps[0].ms')).toHaveLength(1);
    expect(at(acted([step({ speed: 2 })]), 'scenarios[0].steps[0].speed')).toHaveLength(1);
  });
});

describe('validateProposal: live types in a proposal', () => {
  const live = (nodes          ) => minimal({ nodes: { add: nodes } });

  it('accepts floors, rooms and devices under live ids, and a device a code file derives under any id', () => {
    expect(messages(live([
      { id: 'live-floor-main', label: 'Main Floor', type: 'floor' },
      { id: 'live-room-kitchen', label: 'Kitchen', type: 'room', parent: 'live-floor-main' },
      { id: 'live-device-phone-a', label: 'Phone', type: 'device', kind: 'phone' },
      { id: 'device-camera-door', label: 'door', type: 'device', kind: 'camera', file: 'stacks/camera-stack/cameras.yml' },
    ]))).toEqual([]);
  });

  it('holds a live node to the live-id grammar, and a device to a known kind', () => {
    expect(at(live([{ id: 'room-kitchen', label: 'Kitchen', type: 'room' }]), 'nodes.add[0].id')[0].message).toMatch(/live-room-/);
    expect(at(live([{ id: 'live-room-kitchen', label: 'Kitchen', type: 'device', kind: 'phone' }]), 'nodes.add[0].id')).toHaveLength(1);
    expect(at(live([{ id: 'live-device-phone-a', label: 'Phone', type: 'device', kind: 'camera' }]), 'nodes.add[0].kind')).toHaveLength(1);
    expect(at(live([{ id: 'live-thing', label: 'x', type: 'page' }]), 'nodes.add[0].id')).toHaveLength(1);
    expect(at(live([{ id: 'device-phone-a', label: 'Phone', type: 'device', kind: 'phone' }]), 'nodes.add[0].id')[0].message).toMatch(/live-device-phone-/);
    expect(at(live([{ id: 'device-camera-a', label: 'Cam', type: 'device', kind: 'toaster', file: 'x' }]), 'nodes.add[0].kind')).toHaveLength(1);
  });
});

describe('proposalStatus: what the live layer draws (spec 0029 D9)', () => {
  const p = minimal({
    nodes: { add: [
      { id: 'live-room-kitchen', label: 'Kitchen', type: 'room' },
      { id: 'live-device-nfc-tag-1', label: 'Tag', type: 'device', kind: 'nfc-tag', parent: 'live-room-kitchen' },
      { id: 'machine-host', label: 'host', type: 'machine', parent: 'root' },
    ] },
    edges: { add: [{ from: 'live-room-kitchen', to: 'machine-host', dashed: true }, { from: 'machine-host', to: 'app-a', kind: 'calls' }] },
  });

  it('reads a live node, and an edge with a live end, as live, never pending', () => {
    const { items, summary } = proposalStatus(base(), p);
    const status = Object.fromEntries(items.map((i     ) => [`${i.kind} ${i.key}`, i.status]));
    expect(status).toEqual({
      'node live-room-kitchen': 'live',
      'node live-device-nfc-tag-1': 'live',
      'node machine-host': 'pending',
      'edge live-room-kitchen|machine-host|own': 'live',
      'edge machine-host|app-a|calls': 'pending',
    });
    expect(summary).toEqual({ total: 5, pending: 2, landed: 0, diverged: 0, live: 3 });
  });

  it('is not building because of a live item: only a landed code item starts the build', () => {
    expect(proposalProblems(base(), p).building).toBe(false);
  });
});

describe('every committed proposal of the sample repo (spec 0029 section 3)', () => {
  const real = loadSample();
  const dir = path.join(SAMPLE, 'docs/specs/proposals');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.review.json'));

  it.each(files)('%s validates', (file) => {
    const p = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    expect(proposalProblems(real, p).errors).toEqual([]);
  });

  it('a staged walk (romScenario) validates as a scenario', async () => {
    const { romScenario } = await import('../../explorer/scenario.js');
    const walk = romScenario({ table: 'orders', path: ['table-orders', 'page-api-orders', 'app-api', 'store-idb'], stages: [], labelOf: (id) => id });
    expect(walk.steps.length).toBeGreaterThan(3);
    expect(validateProposal(real, minimal({ scenarios: [walk] }))).toEqual([]);
  });

  it('the checkout proposal says who does a step and where, and asserts the refused one', () => {
    const p = JSON.parse(fs.readFileSync(path.join(dir, '0002-checkout.json'), 'utf8'));
    const actors = p.scenarios.flatMap((s) => [s.actor, ...s.steps.map((st) => st.actor)]).filter(Boolean);
    const places = p.scenarios.flatMap((s) => s.steps.map((st) => st.at)).filter(Boolean);
    expect(actors).toEqual(expect.arrayContaining(['child', 'adult']));
    expect(places).toEqual(['live-room-kitchen']);
    const refused = p.scenarios.find((s) => s.id === 'child-tries').steps.find((st) => st.expect === 'refused');
    expect(refused.check).toEqual({ table: 'orders', op: 'write' });
  });
});

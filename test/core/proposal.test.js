import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { validateProposal, applyProposal, proposalStatus, edgeKey, summarize, applyEdits } from '../../core/proposal.js';
import { NODE_THEMES, EDGE_KINDS, FLOW_KINDS } from '../../core/schema.js';
import * as cli from '../../core/index.js';
import { CORNFIELD as ROOT, SAMPLE } from '../helpers.js';

/** A small map: an app with a page, a table the page reads and writes, and a ROM stage */
const base = () => ({
  version: 1,
  nodes: [
    { id: 'root', label: 'acme', type: 'root', r: 28, color: NODE_THEMES.root.color, desc: 'The monorepo.' },
    { id: 'app-a', label: 'a.example.test', type: 'app', r: 24, color: NODE_THEMES.app.color, desc: 'App A.' },
    { id: 'page-home', label: '/', type: 'page', r: 18, color: NODE_THEMES.page.color, desc: 'Home.' },
    { id: 'table-items', label: 'items', type: 'table', r: 18, color: NODE_THEMES.table.color, desc: 'Items.', table: 'items' },
    { id: 'rom-render', label: 'Renderer', type: 'rom', r: 19, color: NODE_THEMES.rom.color, desc: 'Bakes pages.' },
  ],
  edges: [
    { from: 'root', to: 'app-a' },
    { from: 'app-a', to: 'page-home' },
    { from: 'app-a', to: 'table-items' },
    { from: 'table-items', to: 'page-home', kind: 'reads', keys: ['items:*'] },
    { from: 'page-home', to: 'table-items', kind: 'writes', label: 'items.add' },
    { from: 'rom-render', to: 'page-home', kind: 'flow', flow: 'rom', label: 'bakes' },
    { from: 'app-a', to: 'rom-render', kind: 'calls', label: 'asks' },
  ],
});

const proposal = (over                          = {})      => ({
  version: 1,
  spec: '0013',
  title: 'Meal planner',
  summary: 'One sentence the maintainer reads first.',
  nodes: {
    add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a', desc: 'The meal list.' }],
    change: [{ id: 'rom-render', set: { desc: 'Bakes pages and /meals.' }, why: 're-bakes /meals' }],
    remove: [{ id: 'page-home', why: 'replaced by /meals' }],
  },
  edges: {
    add: [{ from: 'page-meals', to: 'table-items', kind: 'writes', label: 'items.add' }],
    change: [{ from: 'app-a', to: 'rom-render', kind: 'calls', set: { label: 'asks twice' }, why: 'now it asks twice' }],
    remove: [{ from: 'rom-render', to: 'page-home', kind: 'flow', flow: 'rom', why: 'page is gone' }],
  },
  scenarios: [{
    id: 'add-a-meal',
    title: 'Add a meal',
    steps: [
      { node: 'page-meals', text: 'You submit the form on /meals.' },
      { edge: { from: 'page-meals', to: 'table-items', kind: 'writes' }, text: 'The page writes a row.' },
    ],
  }],
  ...over,
});

/** The smallest valid proposal, then one thing changed */
const minimal = (over                          = {})      => ({ version: 1, title: 'T', summary: 'S', ...over });

const errorsOf = (p         , t = base()) => validateProposal(t, p);
const messages = (p         , t = base()) => errorsOf(p, t).map((e) => `${e.path}: ${e.message}`);
/** The errors at a path, so a test says which rule it means */
const at = (p         , where        , t = base()) => errorsOf(p, t).filter((e) => e.path === where);

describe('the schema table', () => {
  it('is the one the package exports', () => {
    expect(cli.NODE_THEMES).toBe(NODE_THEMES);
    expect(cli.EDGE_KINDS).toBe(EDGE_KINDS);
    expect(cli.FLOW_KINDS).toBe(FLOW_KINDS);
  });
});

describe('the browser can import it', () => {
  const imports = (file        ) => [...fs.readFileSync(path.join(ROOT, 'core', file), 'utf8').matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  it('imports only the pure schema, and the schema imports nothing', () => {
    expect(imports('proposal.js')).toEqual(['./schema.js']);
    expect(imports('schema.js')).toEqual([]);
  });
  it('is on the server allowlist, with the schema it imports', async () => {
    const { BROWSER_CORE } = await import('../../server/server.js');
    expect(BROWSER_CORE).toEqual(expect.arrayContaining(['proposal.js', 'schema.js']));
  });
});

describe('edgeKey', () => {
  it('names an edge by from, to and kind; no kind is ownership; a flow names its flow', () => {
    expect(edgeKey({ from: 'a', to: 'b' })).toBe('a|b|own');
    expect(edgeKey({ from: 'a', to: 'b', kind: 'reads' })).toBe('a|b|reads');
    expect(edgeKey({ from: 'a', to: 'b', kind: 'flow', flow: 'rom' })).toBe('a|b|flow:rom');
    expect(edgeKey({ from: 'a', to: 'b', dashed: true }       )).toBe('a|b|own');
  });
});

describe('validateProposal: the document', () => {
  it('accepts the worked example', () => {
    expect(messages(proposal())).toEqual([]);
  });

  it('accepts the smallest proposal', () => {
    expect(errorsOf(minimal())).toEqual([]);
  });

  it('rejects something that is not an object', () => {
    for (const bad of [null, 'x', 3, [], undefined]) expect(errorsOf(bad).length, String(bad)).toBeGreaterThan(0);
  });

  it('wants version 1', () => {
    expect(at(minimal({ version: 2 }), 'version')).toHaveLength(1);
    expect(at({ title: 'T', summary: 'S' }, 'version')).toHaveLength(1);
    expect(at(minimal({ version: '1' }), 'version')).toHaveLength(1);
  });

  it('wants a title and a summary, and a spec only as a string', () => {
    expect(at(minimal({ title: '' }), 'title')).toHaveLength(1);
    expect(at(minimal({ summary: undefined }), 'summary')).toHaveLength(1);
    expect(at(minimal({ title: 4 }), 'title')).toHaveLength(1);
    expect(at(minimal({ spec: 13 }), 'spec')).toHaveLength(1);
    expect(at(minimal({ spec: '0013' }), 'spec')).toHaveLength(0);
  });

  it('rejects unknown top-level keys, and unknown keys in the nodes and edges blocks', () => {
    expect(at(minimal({ colour: 'red' }), 'colour')[0].message).toMatch(/unknown/i);
    expect(at(minimal({ nodes: { replace: [] } }), 'nodes.replace')).toHaveLength(1);
    expect(at(minimal({ edges: { move: [] } }), 'edges.move')).toHaveLength(1);
  });

  it('wants the lists to be arrays', () => {
    expect(at(minimal({ nodes: { add: {} } }), 'nodes.add')).toHaveLength(1);
    expect(at(minimal({ scenarios: 'x' }), 'scenarios')).toHaveLength(1);
    expect(at(minimal({ nodes: [] }), 'nodes')).toHaveLength(1);
  });
});

describe('validateProposal: nodes', () => {
  const add = (node                         ) => minimal({ nodes: { add: [node] } });

  it('wants an id, a label and a type on an added node', () => {
    expect(at(add({ label: 'x', type: 'page' }), 'nodes.add[0].id')).toHaveLength(1);
    expect(at(add({ id: 'x', type: 'page', label: '' }), 'nodes.add[0].label')).toHaveLength(1);
    expect(at(add({ id: 'x', label: '/x' }), 'nodes.add[0].type')).toHaveLength(1);
  });

  it('rejects an unknown node type and names the valid ones', () => {
    const [e] = at(add({ id: 'x', label: 'x', type: 'gizmo' }), 'nodes.add[0].type');
    expect(e.message).toMatch(/gizmo/);
    expect(e.message).toMatch(/table/);
  });

  it('rejects an added id that already exists', () => {
    expect(at(add({ id: 'page-home', label: '/x', type: 'page' }), 'nodes.add[0].id')[0].message).toMatch(/already/);
  });

  it('rejects an added id that is duplicated in the proposal', () => {
    const p = minimal({ nodes: { add: [{ id: 'x', label: '/x', type: 'page' }, { id: 'x', label: '/y', type: 'page' }] } });
    expect(at(p, 'nodes.add[1].id')[0].message).toMatch(/twice|duplicate/i);
  });

  it('holds an added page to the label rule topology validate applies', () => {
    expect(at(add({ id: 'p', label: 'meals', type: 'page' }), 'nodes.add[0].label')[0].message).toMatch(/slash/);
    expect(at(add({ id: 'p', label: '/a.html', type: 'page' }), 'nodes.add[0].label')[0].message).toMatch(/html/);
  });

  it('rejects a parent that is in neither the map nor the added nodes, and accepts one that is either', () => {
    expect(at(add({ id: 'x', label: '/x', type: 'page', parent: 'nope' }), 'nodes.add[0].parent')[0].message).toMatch(/nope/);
    expect(at(add({ id: 'x', label: '/x', type: 'page', parent: 'app-a' }), 'nodes.add[0].parent')).toHaveLength(0);
    const nested = minimal({ nodes: { add: [{ id: 'x', label: '/x', type: 'page', parent: 'y' }, { id: 'y', label: 'y.example', type: 'app', parent: 'root' }] } });
    expect(messages(nested)).toEqual([]);
  });

  it('rejects a parent the same proposal removes', () => {
    const p = minimal({ nodes: { add: [{ id: 'x', label: '/x', type: 'page', parent: 'app-a' }], remove: [{ id: 'app-a', why: 'gone' }] } });
    expect(at(p, 'nodes.add[0].parent')[0].message).toMatch(/removes/);
  });

  it('keeps the fields apply writes (mark, before) out of an added node', () => {
    expect(at(add({ id: 'x', label: '/x', type: 'page', mark: 'added' }), 'nodes.add[0].mark')).toHaveLength(1);
  });

  it('rejects a changed node that does not exist', () => {
    const p = minimal({ nodes: { change: [{ id: 'ghost', set: { desc: 'x' }, why: 'y' }] } });
    expect(at(p, 'nodes.change[0].id')[0].message).toMatch(/ghost/);
  });

  it('rejects a change whose set is empty, tries to change id or parent, or has no why', () => {
    const change = (c                         ) => minimal({ nodes: { change: [{ id: 'page-home', why: 'because', ...c }] } });
    expect(at(change({ set: {} }), 'nodes.change[0].set')).toHaveLength(1);
    expect(at(change({ set: 'x' }), 'nodes.change[0].set')).toHaveLength(1);
    expect(at(change({ set: { id: 'other' } }), 'nodes.change[0].set.id')[0].message).toMatch(/id/);
    expect(at(change({ set: { parent: 'root' } }), 'nodes.change[0].set.parent')).toHaveLength(1);
    expect(at(change({ set: { mark: 'added' } }), 'nodes.change[0].set.mark')).toHaveLength(1);
    expect(at(change({ set: { desc: 'x' }, why: '' }), 'nodes.change[0].why')).toHaveLength(1);
  });

  it('checks the type a change sets', () => {
    const p = minimal({ nodes: { change: [{ id: 'page-home', set: { type: 'gizmo' }, why: 'x' }] } });
    expect(at(p, 'nodes.change[0].set.type')).toHaveLength(1);
    const ok = minimal({ nodes: { change: [{ id: 'page-home', set: { type: 'service' }, why: 'x' }] } });
    expect(at(ok, 'nodes.change[0].set.type')).toHaveLength(0);
  });

  it('rejects a changed id twice, and a node both changed and removed', () => {
    const twice = minimal({ nodes: { change: [{ id: 'rom-render', set: { desc: 'a' }, why: 'x' }, { id: 'rom-render', set: { desc: 'b' }, why: 'x' }] } });
    expect(at(twice, 'nodes.change[1].id')).toHaveLength(1);
    const both = minimal({ nodes: { change: [{ id: 'rom-render', set: { desc: 'a' }, why: 'x' }], remove: [{ id: 'rom-render', why: 'x' }] } });
    expect(at(both, 'nodes.remove[0].id')).toHaveLength(1);
  });

  it('rejects a removed node that does not exist, or has no why', () => {
    expect(at(minimal({ nodes: { remove: [{ id: 'ghost', why: 'x' }] } }), 'nodes.remove[0].id')[0].message).toMatch(/ghost/);
    expect(at(minimal({ nodes: { remove: [{ id: 'page-home' }] } }), 'nodes.remove[0].why')).toHaveLength(1);
  });

  it('cannot change or remove a node the same proposal adds', () => {
    const p = minimal({ nodes: { add: [{ id: 'x', label: '/x', type: 'page' }], remove: [{ id: 'x', why: 'x' }] } });
    expect(at(p, 'nodes.remove[0].id')).toHaveLength(1);
  });
});

describe('validateProposal: edges', () => {
  const add = (edge                         , extra                          = {}) => minimal({ edges: { add: [edge] }, ...extra });

  it('wants from and to, and checks the kind', () => {
    expect(at(add({ to: 'page-home' }), 'edges.add[0].from')).toHaveLength(1);
    expect(at(add({ from: 'app-a' }), 'edges.add[0].to')).toHaveLength(1);
    const [e] = at(add({ from: 'app-a', to: 'rom-render', kind: 'teleports' }), 'edges.add[0].kind');
    expect(e.message).toMatch(/teleports/);
    expect(e.message).toMatch(/reads/);
  });

  it('accepts every kind topology.json uses, and no kind for ownership', () => {
    for (const kind of EDGE_KINDS.filter((k) => k !== 'flow')) {
      expect(at(add({ from: 'app-a', to: 'rom-render', kind }), 'edges.add[0].kind'), kind).toHaveLength(0);
    }
    expect(messages(add({ from: 'app-a', to: 'rom-render' }))).toEqual([]);
  });

  it('wants a known flow on a flow edge, and nowhere else', () => {
    expect(at(add({ from: 'app-a', to: 'rom-render', kind: 'flow' }), 'edges.add[0].flow')).toHaveLength(1);
    expect(at(add({ from: 'app-a', to: 'rom-render', kind: 'flow', flow: 'carrier-pigeon' }), 'edges.add[0].flow')).toHaveLength(1);
    expect(messages(add({ from: 'app-a', to: 'rom-render', kind: 'flow', flow: 'sync' }))).toEqual([]);
    expect(at(add({ from: 'app-a', to: 'rom-render', kind: 'reads', flow: 'sync' }), 'edges.add[0].flow')).toHaveLength(1);
  });

  it('rejects an end that is in neither the map nor the added nodes', () => {
    expect(at(add({ from: 'app-a', to: 'nowhere' }), 'edges.add[0].to')[0].message).toMatch(/nowhere/);
    expect(at(add({ from: 'nowhere', to: 'app-a' }), 'edges.add[0].from')).toHaveLength(1);
  });

  it('accepts an end that is an added node', () => {
    const p = minimal({ nodes: { add: [{ id: 'x', label: '/x', type: 'page', parent: 'app-a' }] }, edges: { add: [{ from: 'x', to: 'table-items', kind: 'writes' }] } });
    expect(messages(p)).toEqual([]);
  });

  it('rejects an added edge that already exists, kind taken into account', () => {
    expect(at(add({ from: 'page-home', to: 'table-items', kind: 'writes' }), 'edges.add[0]')[0].message).toMatch(/already/);
    expect(at(add({ from: 'page-home', to: 'table-items', kind: 'reads' }), 'edges.add[0]')).toHaveLength(0);
    expect(at(add({ from: 'app-a', to: 'page-home' }), 'edges.add[0]')).toHaveLength(1);
  });

  it('rejects an edge added twice, and one that repeats the ownership edge its parent already makes', () => {
    const twice = minimal({ edges: { add: [{ from: 'app-a', to: 'rom-render' }, { from: 'app-a', to: 'rom-render' }] } });
    expect(at(twice, 'edges.add[1]')).toHaveLength(1);
    const own = minimal({ nodes: { add: [{ id: 'x', label: '/x', type: 'page', parent: 'app-a' }] }, edges: { add: [{ from: 'app-a', to: 'x' }] } });
    expect(at(own, 'edges.add[0]')).toHaveLength(1);
  });

  it('rejects an edge added to a node the same proposal removes', () => {
    const p = minimal({ nodes: { remove: [{ id: 'rom-render', why: 'x' }] }, edges: { add: [{ from: 'app-a', to: 'rom-render', kind: 'calls' }] } });
    expect(at(p, 'edges.add[0].to')[0].message).toMatch(/removes/);
    const from = minimal({ nodes: { remove: [{ id: 'rom-render', why: 'x' }] }, edges: { add: [{ from: 'rom-render', to: 'app-a', kind: 'calls' }] } });
    expect(at(from, 'edges.add[0].from')).toHaveLength(1);
  });

  it('rejects a changed edge that does not exist, one with an empty set, one that moves its ends, and one with no why', () => {
    const change = (c                         ) => minimal({ edges: { change: [{ from: 'page-home', to: 'table-items', kind: 'writes', set: { label: 'x' }, why: 'y', ...c }] } });
    expect(messages(change({}))).toEqual([]);
    expect(at(change({ kind: 'reads' }), 'edges.change[0]')).toHaveLength(1);
    expect(at(change({ from: 'ghost' }), 'edges.change[0]')).toHaveLength(1);
    expect(at(change({ set: {} }), 'edges.change[0].set')).toHaveLength(1);
    expect(at(change({ set: { to: 'app-a' } }), 'edges.change[0].set.to')).toHaveLength(1);
    expect(at(change({ set: { kind: 'reads' } }), 'edges.change[0].set.kind')).toHaveLength(1);
    expect(at(change({ why: '' }), 'edges.change[0].why')).toHaveLength(1);
  });

  it('rejects a removed edge that does not exist, or has no why', () => {
    const remove = (r                         ) => minimal({ edges: { remove: [{ from: 'page-home', to: 'table-items', kind: 'writes', why: 'y', ...r }] } });
    expect(messages(remove({}))).toEqual([]);
    expect(at(remove({ kind: 'calls' }), 'edges.remove[0]')[0].message).toMatch(/does not exist/);
    expect(at(remove({ why: undefined }), 'edges.remove[0].why')).toHaveLength(1);
  });

  it('finds the edge by its kind: no kind means the ownership edge', () => {
    const own = minimal({ edges: { remove: [{ from: 'app-a', to: 'page-home', why: 'moved' }] } });
    expect(messages(own)).toEqual([]);
    const wrong = minimal({ edges: { remove: [{ from: 'table-items', to: 'page-home', why: 'moved' }] } });
    expect(at(wrong, 'edges.remove[0]')).toHaveLength(1);
  });

  it('finds a flow edge by its flow', () => {
    const p = minimal({ edges: { remove: [{ from: 'rom-render', to: 'page-home', kind: 'flow', flow: 'sync', why: 'x' }] } });
    expect(at(p, 'edges.remove[0]')).toHaveLength(1);
  });
});

describe('validateProposal: scenarios', () => {
  const scenario = (steps           , over                          = {}) => minimal({ scenarios: [{ id: 's', title: 'S', steps, ...over }] });

  it('wants unique scenario ids, a title, and at least one step', () => {
    const dup = minimal({ scenarios: [{ id: 's', title: 'A', steps: [{ node: 'app-a', text: 'x' }] }, { id: 's', title: 'B', steps: [{ node: 'app-a', text: 'x' }] }] });
    expect(at(dup, 'scenarios[1].id')).toHaveLength(1);
    expect(at(scenario([{ node: 'app-a', text: 'x' }], { id: '' }), 'scenarios[0].id')).toHaveLength(1);
    expect(at(scenario([{ node: 'app-a', text: 'x' }], { title: '' }), 'scenarios[0].title')).toHaveLength(1);
    expect(at(scenario([]), 'scenarios[0].steps')[0].message).toMatch(/at least one/);
    expect(at(scenario('x'       ), 'scenarios[0].steps')).toHaveLength(1);
  });

  it('wants exactly one of node or edge on a step', () => {
    expect(at(scenario([{ text: 'x' }]), 'scenarios[0].steps[0]')).toHaveLength(1);
    expect(at(scenario([{ node: 'app-a', edge: { from: 'root', to: 'app-a' }, text: 'x' }]), 'scenarios[0].steps[0]')).toHaveLength(1);
  });

  it('wants non-empty text, and no other keys', () => {
    expect(at(scenario([{ node: 'app-a' }]), 'scenarios[0].steps[0].text')).toHaveLength(1);
    expect(at(scenario([{ node: 'app-a', text: '  ' }]), 'scenarios[0].steps[0].text')).toHaveLength(1);
    expect(at(scenario([{ node: 'app-a', text: 'x', speed: 2 }]), 'scenarios[0].steps[0].speed')).toHaveLength(1);
  });

  it('accepts a step on a node of the map or an added node', () => {
    expect(messages(scenario([{ node: 'app-a', text: 'x' }]))).toEqual([]);
    const added = minimal({ nodes: { add: [{ id: 'x', label: '/x', type: 'page' }] }, scenarios: [{ id: 's', title: 'S', steps: [{ node: 'x', text: 'x' }] }] });
    expect(messages(added)).toEqual([]);
  });

  it('rejects a step on a node that is nowhere', () => {
    expect(at(scenario([{ node: 'nowhere', text: 'x' }]), 'scenarios[0].steps[0].node')[0].message).toMatch(/nowhere/);
  });

  it('accepts a step on a node or edge the proposal removes: the Diff view still draws it', () => {
    const p = minimal({
      nodes: { remove: [{ id: 'page-home', why: 'x' }] },
      edges: { remove: [{ from: 'page-home', to: 'table-items', kind: 'writes', why: 'x' }] },
      scenarios: [{ id: 's', title: 'S', steps: [{ node: 'page-home', text: 'the old way' }, { edge: { from: 'page-home', to: 'table-items', kind: 'writes' }, text: 'no longer' }] }],
    });
    expect(messages(p)).toEqual([]);
  });

  it('checks the edge of a step against the map and the added edges, and its kind', () => {
    expect(messages(scenario([{ edge: { from: 'page-home', to: 'table-items', kind: 'writes' }, text: 'x' }]))).toEqual([]);
    expect(at(scenario([{ edge: { from: 'page-home', to: 'table-items', kind: 'reads' }, text: 'x' }]), 'scenarios[0].steps[0].edge')[0].message).toMatch(/nothing/);
    expect(at(scenario([{ edge: { from: 'page-home' }, text: 'x' }]), 'scenarios[0].steps[0].edge.to')).toHaveLength(1);
    expect(at(scenario([{ edge: { from: 'page-home', to: 'table-items', kind: 'zap' }, text: 'x' }]), 'scenarios[0].steps[0].edge.kind')).toHaveLength(1);
    const withAdded = minimal({ nodes: { add: [{ id: 'x', label: '/x', type: 'page', parent: 'app-a' }] }, scenarios: [{ id: 's', title: 'S', steps: [{ edge: { from: 'app-a', to: 'x' }, text: 'owns it' }] }] });
    expect(messages(withAdded)).toEqual([]);
  });
});

describe('applyProposal', () => {
  const result = () => applyProposal(base(), proposal());
  const node = (id        , r = result()) => r.nodes.find((n     ) => n.id === id);
  const edge = (key        , r = result()) => r.edges.find((e     ) => edgeKey(e) === key);

  it('leaves its inputs untouched and returns new arrays', () => {
    const t = base();
    const p = proposal();
    const before = JSON.stringify([t, p]);
    const r = applyProposal(t, p);
    expect(JSON.stringify([t, p])).toBe(before);
    expect(r.nodes).not.toBe(t.nodes);
    expect(r.nodes[0]).not.toBe(t.nodes[0]);
  });

  it('marks everything the proposal does not touch as none', () => {
    expect(node('app-a').mark).toBe('none');
    expect(edge('root|app-a|own').mark).toBe('none');
    expect(node('app-a').before).toBeUndefined();
  });

  it('marks what the map already has in place instead of drawing it twice, once the build has landed', () => {
    const landed = applyProposal(applyProposal(base(), proposal()), proposal());
    const meals = landed.nodes.filter((n     ) => n.id === 'page-meals');
    expect(meals).toHaveLength(1);
    expect(meals[0].mark).toBe('added');
    const own = landed.edges.filter((e     ) => edgeKey(e) === 'app-a|page-meals|own');
    expect(own).toHaveLength(1);
    expect(own[0].mark).toBe('added');
  });

  it('adds a node with its colour and radius from the type, and an ownership edge from its parent', () => {
    const n = node('page-meals');
    expect(n).toMatchObject({ id: 'page-meals', label: '/meals', type: 'page', mark: 'added', color: NODE_THEMES.page.color, r: NODE_THEMES.page.r, desc: 'The meal list.' });
    expect(n.parent).toBeUndefined();
    expect(edge('app-a|page-meals|own')).toMatchObject({ from: 'app-a', to: 'page-meals', mark: 'added' });
  });

  it('adds the edges the proposal names, marked added', () => {
    expect(edge('page-meals|table-items|writes')).toMatchObject({ mark: 'added', label: 'items.add' });
  });

  it('marks a changed node with the new fields, what they were, and why', () => {
    const n = node('rom-render');
    expect(n).toMatchObject({ mark: 'changed', desc: 'Bakes pages and /meals.', why: 're-bakes /meals' });
    expect(n.before).toEqual({ desc: 'Bakes pages.' });
  });

  it('records a field that did not exist as null in before, and changes colour and radius with the type', () => {
    const r = applyProposal(base(), minimal({ nodes: { change: [{ id: 'page-home', set: { summary: 'new', type: 'service' }, why: 'x' }] } })       );
    const n = node('page-home', r);
    expect(n.before).toEqual({ summary: null, type: 'page', color: NODE_THEMES.page.color, r: NODE_THEMES.page.r });
    expect(n).toMatchObject({ type: 'service', color: NODE_THEMES.service.color, r: NODE_THEMES.service.r });
  });

  it('records only the fields whose value differs', () => {
    const r = applyProposal(base(), minimal({ nodes: { change: [{ id: 'page-home', set: { desc: 'Home.', label: '/start' }, why: 'x' }] } })       );
    expect(node('page-home', r).before).toEqual({ label: '/' });
  });

  it('marks a removed node and keeps it in the result, with its why', () => {
    expect(node('page-home')).toMatchObject({ mark: 'removed', why: 'replaced by /meals', label: '/' });
  });

  it('marks every edge of a removed node removed, and keeps them', () => {
    expect(edge('app-a|page-home|own')).toMatchObject({ mark: 'removed', why: 'replaced by /meals' });
    expect(edge('page-home|table-items|writes').mark).toBe('removed');
    expect(result().edges).toHaveLength(base().edges.length + 2);
  });

  it('marks a changed edge with before and why, and a removed edge with why', () => {
    expect(edge('table-items|page-home|reads')).toMatchObject({ mark: 'removed' });
    const r = applyProposal(base(), minimal({ edges: { change: [{ from: 'table-items', to: 'page-home', kind: 'reads', set: { label: 'read it' }, why: 'now labelled' }], remove: [{ from: 'rom-render', to: 'page-home', kind: 'flow', flow: 'rom', why: 'dead' }] } })       );
    expect(edge('table-items|page-home|reads', r)).toMatchObject({ mark: 'changed', label: 'read it', why: 'now labelled', before: { label: null } });
    expect(edge('rom-render|page-home|flow:rom', r)).toMatchObject({ mark: 'removed', why: 'dead' });
  });

  it('an edge removed by its own entry keeps that why, not the node\'s', () => {
    expect(edge('rom-render|page-home|flow:rom')).toMatchObject({ mark: 'removed', why: 'page is gone' });
  });

  it('is the base, marked none, for an empty proposal', () => {
    const r = applyProposal(base(), minimal()       );
    expect(r.nodes.map((n     ) => n.mark)).toEqual(Array(5).fill('none'));
    expect(r.edges.map((e     ) => e.mark)).toEqual(Array(7).fill('none'));
  });
});

describe('proposalStatus', () => {
  const statusOf = (t     , p      = proposal()) => proposalStatus(t, p);
  const item = (s     , kind        , op        , key        ) => s.items.find((i     ) => i.kind === kind && i.op === op && i.key === key);

  it('lists every node and edge item with its key; scenarios are not items', () => {
    const s = statusOf(base());
    expect(s.items.map((i     ) => `${i.kind}:${i.op}:${i.key}`)).toEqual([
      'node:add:page-meals', 'node:change:rom-render', 'node:remove:page-home',
      'edge:add:page-meals|table-items|writes', 'edge:change:app-a|rom-render|calls', 'edge:remove:rom-render|page-home|flow:rom',
    ]);
  });

  it('is all pending before the build, and counts it', () => {
    const s = statusOf(base());
    expect(s.items.map((i     ) => i.status)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(s.summary).toEqual({ total: 6, pending: 6, landed: 0, diverged: 0, live: 0 });
  });

  /** The map after the proposal was built exactly as approved */
  const built = () => {
    const r = applyProposal(base(), proposal());
    return {
      version: 1,
      nodes: r.nodes.filter((n     ) => n.mark !== 'removed').map(({ mark, before, why, ...n }     ) => n),
      edges: r.edges.filter((e     ) => e.mark !== 'removed').map(({ mark, before, why, ...e }     ) => e),
    };
  };

  it('is all landed when the map matches the proposal', () => {
    const s = statusOf(built());
    expect(s.items.map((i     ) => i.status)).toEqual(Array(6).fill('landed'));
    expect(s.summary).toEqual({ total: 6, pending: 0, landed: 6, diverged: 0, live: 0 });
  });

  it('an added node is diverged when it exists with another type, and when it hangs under another parent', () => {
    const t = built();
    t.nodes.find((n     ) => n.id === 'page-meals').type = 'service';
    expect(item(statusOf(t), 'node', 'add', 'page-meals').status).toBe('diverged');
    const u = built();
    u.edges = u.edges.filter((e     ) => edgeKey(e) !== 'app-a|page-meals|own');
    u.edges.push({ from: 'root', to: 'page-meals' });
    expect(item(statusOf(u), 'node', 'add', 'page-meals').status).toBe('diverged');
  });

  it('an added edge is diverged when the same ends are joined by another kind', () => {
    const t = built();
    t.edges.find((e     ) => edgeKey(e) === 'page-meals|table-items|writes').kind = 'calls';
    expect(item(statusOf(t), 'edge', 'add', 'page-meals|table-items|writes').status).toBe('diverged');
  });

  it('a removal is landed when the item is gone, pending while it is there', () => {
    const t = base();
    t.nodes = t.nodes.filter((n) => n.id !== 'page-home');
    t.edges = t.edges.filter((e) => e.from !== 'page-home' && e.to !== 'page-home');
    const s = statusOf(t);
    expect(item(s, 'node', 'remove', 'page-home').status).toBe('landed');
    expect(item(s, 'edge', 'remove', 'rom-render|page-home|flow:rom').status).toBe('landed');
    expect(item(statusOf(base()), 'node', 'remove', 'page-home').status).toBe('pending');
  });

  it('a change is landed when the set fields now hold, pending while they do not, diverged when its target is gone', () => {
    const t = base();
    t.nodes.find((n) => n.id === 'rom-render') .desc = 'Bakes pages and /meals.';
    expect(item(statusOf(t), 'node', 'change', 'rom-render').status).toBe('landed');
    expect(item(statusOf(base()), 'node', 'change', 'rom-render').status).toBe('pending');
    const gone = base();
    gone.nodes = gone.nodes.filter((n) => n.id !== 'rom-render');
    expect(item(statusOf(gone), 'node', 'change', 'rom-render').status).toBe('diverged');
    const e = base();
    (e.edges.find((x) => edgeKey(x) === 'app-a|rom-render|calls')       ).label = 'asks twice';
    expect(item(statusOf(e), 'edge', 'change', 'app-a|rom-render|calls').status).toBe('landed');
  });

  it('holds a proposal with nothing in it to no items', () => {
    expect(proposalStatus(base(), minimal()       )).toEqual({ items: [], summary: { total: 0, pending: 0, landed: 0, diverged: 0, live: 0 } });
  });
});

describe('state errors', () => {
  it('marks the mistakes that depend on what the map holds, and no others', () => {
    const p = minimal({ nodes: { add: [{ id: 'page-home', label: '/x', type: 'gizmo' }], remove: [{ id: 'ghost', why: 'x' }] } });
    const errors = errorsOf(p);
    expect(errors.find((e) => e.path === 'nodes.add[0].id')?.state).toBe('exists');
    expect(errors.find((e) => e.path === 'nodes.remove[0].id')?.state).toBe('missing-target');
    expect(errors.find((e) => e.path === 'nodes.add[0].type')?.state).toBeUndefined();
    expect(errors.find((e) => e.path === 'version')).toBeUndefined();
  });

  it('tells apart what a landing explains (exists, missing-target) from what it cannot (dangling)', () => {
    const p = minimal({
      nodes: { add: [{ id: 'x', label: '/x', type: 'page', parent: 'nope' }] },
      edges: { add: [{ from: 'page-home', to: 'table-items', kind: 'writes' }, { from: 'x', to: 'nowhere' }], remove: [{ from: 'a', to: 'b', why: 'w' }] },
      scenarios: [{ id: 's', title: 'S', steps: [{ node: 'nowhere', text: 't' }, { edge: { from: 'x', to: 'table-items', kind: 'calls' }, text: 't' }] }],
    });
    const tag = (where        ) => errorsOf(p).find((e) => e.path === where)?.state;
    expect(tag('nodes.add[0].parent')).toBe('dangling');
    expect(tag('edges.add[0]')).toBe('exists');
    expect(tag('edges.add[1].to')).toBe('dangling');
    expect(tag('edges.remove[0]')).toBe('missing-target');
    expect(tag('scenarios[0].steps[0].node')).toBe('dangling');
    expect(tag('scenarios[0].steps[1].edge')).toBe('dangling');
  });

  it('calls a step on something the proposal itself removes missing-target, not dangling: after the build it is gone', () => {
    const gone = (t     ) => { t.nodes = t.nodes.filter((n     ) => n.id !== 'page-home'); t.edges = t.edges.filter((e     ) => e.from !== 'page-home' && e.to !== 'page-home'); return t; };
    const p = minimal({
      nodes: { remove: [{ id: 'page-home', why: 'x' }] },
      scenarios: [{ id: 's', title: 'S', steps: [{ node: 'page-home', text: 'the old way' }, { edge: { from: 'page-home', to: 'table-items', kind: 'writes' }, text: 'the old write' }] }],
    });
    const errors = errorsOf(p, gone(base()));
    expect(errors.filter((e) => e.path.startsWith('scenarios')).map((e) => e.state)).toEqual(['missing-target', 'missing-target']);
  });
});

describe('summarize', () => {
  it('counts nodes and edges together, and the scenarios', () => {
    expect(summarize(proposal())).toEqual({ added: 2, changed: 2, removed: 2, scenarios: 1 });
    expect(summarize(minimal())).toEqual({ added: 0, changed: 0, removed: 0, scenarios: 0 });
  });
});

describe('applyEdits', () => {
  const p = () => proposal();
  const step = (i        ) => p().scenarios[0].steps[i];

  it('returns a new proposal and leaves the old one alone', () => {
    const before = JSON.stringify(p());
    const original = p();
    const next = applyEdits(original, [{ op: 'add-node', id: 'x', label: 'x', type: 'table' }]);
    expect(JSON.stringify(original)).toBe(before);
    expect(next).not.toBe(original);
    expect(applyEdits(original, [])).toEqual(original);
    expect(applyEdits(original, [])).not.toBe(original);
  });

  it('ignores the timestamp (at) an edit carries', () => {
    const a = applyEdits(p(), [{ op: 'add-node', id: 'x', label: 'x', type: 'table', at: 1700000000000 }]);
    expect(a.nodes.add.at(-1)).toEqual({ id: 'x', label: 'x', type: 'table' });
  });

  it('add-node appends an added node with its type, label, parent and desc', () => {
    const next = applyEdits(minimal(), [{ op: 'add-node', id: 'page-x', label: '/x', type: 'page', parent: 'app-a', desc: 'd' }]);
    expect(next.nodes.add).toEqual([{ id: 'page-x', label: '/x', type: 'page', parent: 'app-a', desc: 'd' }]);
    expect(messages(next)).toEqual([]);
  });

  it('add-node makes an id from the type and label when none is given, and keeps it unique', () => {
    const next = applyEdits(minimal(), [
      { op: 'add-node', label: 'Meal Planner!', type: 'service' },
      { op: 'add-node', label: 'Meal Planner!', type: 'service' },
    ]);
    expect(next.nodes.add.map((n     ) => n.id)).toEqual(['service-meal-planner', 'service-meal-planner-2']);
  });

  it('remove-node of a node in the map adds a removal with its why, and drops a change to it', () => {
    const next = applyEdits(minimal({ nodes: { change: [{ id: 'rom-render', set: { desc: 'x' }, why: 'y' }] } }), [{ op: 'remove-node', id: 'rom-render', why: 'not needed' }]);
    expect(next.nodes.remove).toEqual([{ id: 'rom-render', why: 'not needed' }]);
    expect(next.nodes.change).toEqual([]);
    expect(errorsOf(next)).toEqual([]);
  });

  it('remove-node gives a default why, and is idempotent', () => {
    const once = applyEdits(minimal(), [{ op: 'remove-node', id: 'rom-render' }]);
    expect(once.nodes.remove[0].why).toMatch(/\S/);
    expect(applyEdits(once, [{ op: 'remove-node', id: 'rom-render' }]).nodes.remove).toHaveLength(1);
  });

  it('remove-node of a node the proposal added drops it, its edges, its children and the steps that point at them', () => {
    const q = minimal({
      nodes: { add: [{ id: 'a', label: '/a', type: 'page', parent: 'app-a' }, { id: 'b', label: '/b', type: 'page', parent: 'a' }, { id: 'c', label: '/c', type: 'page', parent: 'app-a' }] },
      edges: { add: [{ from: 'a', to: 'table-items', kind: 'writes' }, { from: 'b', to: 'table-items', kind: 'writes' }, { from: 'c', to: 'table-items', kind: 'writes' }] },
      scenarios: [{ id: 's', title: 'S', steps: [{ node: 'a', text: '1' }, { node: 'c', text: '2' }, { edge: { from: 'b', to: 'table-items', kind: 'writes' }, text: '3' }, { edge: { from: 'app-a', to: 'a' }, text: '4' }] }],
    });
    const next = applyEdits(q, [{ op: 'remove-node', id: 'a' }]);
    expect(next.nodes.add.map((n     ) => n.id)).toEqual(['c']);
    expect(next.nodes.remove ?? []).toEqual([]);
    expect(next.edges.add).toEqual([{ from: 'c', to: 'table-items', kind: 'writes' }]);
    expect(next.scenarios[0].steps.map((s     ) => s.text)).toEqual(['2']);
    expect(messages(next)).toEqual([]);
  });

  it('add-edge appends an added edge', () => {
    const next = applyEdits(minimal(), [{ op: 'add-edge', from: 'app-a', to: 'rom-render', kind: 'triggers', label: 'asks' }]);
    expect(next.edges.add).toEqual([{ from: 'app-a', to: 'rom-render', kind: 'triggers', label: 'asks' }]);
    expect(messages(next)).toEqual([]);
  });

  it('remove-edge of an edge in the map adds a removal, and drops a change to it', () => {
    const next = applyEdits(
      minimal({ edges: { change: [{ from: 'page-home', to: 'table-items', kind: 'writes', set: { label: 'x' }, why: 'y' }] } }),
      [{ op: 'remove-edge', from: 'page-home', to: 'table-items', kind: 'writes', why: 'gone' }],
    );
    expect(next.edges.remove).toEqual([{ from: 'page-home', to: 'table-items', kind: 'writes', why: 'gone' }]);
    expect(next.edges.change).toEqual([]);
    expect(errorsOf(next)).toEqual([]);
  });

  it('remove-edge of an edge the proposal added drops it, and the steps that point at it', () => {
    const q = proposal();
    const next = applyEdits(q, [{ op: 'remove-edge', from: 'page-meals', to: 'table-items', kind: 'writes' }]);
    expect(next.edges.add).toEqual([]);
    expect(next.edges.remove).toHaveLength(1);
    expect(next.scenarios[0].steps).toHaveLength(1);
  });

  it('add-step appends to a scenario or inserts at an index, and makes the scenario when it is new', () => {
    const s = { node: 'app-a', text: 'Then this.' };
    expect(applyEdits(p(), [{ op: 'add-step', scenario: 'add-a-meal', step: s }]).scenarios[0].steps).toHaveLength(3);
    expect(applyEdits(p(), [{ op: 'add-step', scenario: 'add-a-meal', step: s, index: 0 }]).scenarios[0].steps[0]).toEqual(s);
    const fresh = applyEdits(p(), [{ op: 'add-step', scenario: 'new-one', title: 'New one', step: s }]);
    expect(fresh.scenarios[1]).toEqual({ id: 'new-one', title: 'New one', steps: [s] });
    const untitled = applyEdits(p(), [{ op: 'add-step', scenario: 'new-one', step: s }]);
    expect(untitled.scenarios[1].title).toBe('new-one');
  });

  it('edit-step rewords a step or retargets it, keeping exactly one of node and edge', () => {
    const reworded = applyEdits(p(), [{ op: 'edit-step', scenario: 'add-a-meal', index: 0, step: { text: 'Say it again.' } }]);
    expect(reworded.scenarios[0].steps[0]).toEqual({ node: 'page-meals', text: 'Say it again.' });
    const toEdge = applyEdits(p(), [{ op: 'edit-step', scenario: 'add-a-meal', index: 0, step: { edge: { from: 'app-a', to: 'page-meals' } } }]);
    expect(toEdge.scenarios[0].steps[0]).toEqual({ edge: { from: 'app-a', to: 'page-meals' }, text: step(0).text });
    const toNode = applyEdits(p(), [{ op: 'edit-step', scenario: 'add-a-meal', index: 1, step: { node: 'app-a' } }]);
    expect(toNode.scenarios[0].steps[1]).toEqual({ node: 'app-a', text: step(1).text });
  });

  it('move-step moves a step from one index to another', () => {
    const next = applyEdits(p(), [{ op: 'move-step', scenario: 'add-a-meal', from: 0, to: 1 }]);
    expect(next.scenarios[0].steps.map((s     ) => s.text)).toEqual([step(1).text, step(0).text]);
  });

  it('remove-step deletes a step; the scenario stays even when it is left empty (validate says so)', () => {
    const next = applyEdits(p(), [{ op: 'remove-step', scenario: 'add-a-meal', index: 0 }, { op: 'remove-step', scenario: 'add-a-meal', index: 0 }]);
    expect(next.scenarios[0].steps).toEqual([]);
    expect(at(next, 'scenarios[0].steps')).toHaveLength(1);
  });

  it('applies the edits in order', () => {
    const next = applyEdits(minimal(), [
      { op: 'add-node', id: 'x', label: 'x', type: 'table', parent: 'app-a' },
      { op: 'add-edge', from: 'page-home', to: 'x', kind: 'writes', label: 'x.add' },
      { op: 'add-step', scenario: 's', title: 'S', step: { node: 'x', text: 'It exists.' } },
      { op: 'remove-node', id: 'x' },
    ]);
    expect(next.nodes.add).toEqual([]);
    expect(next.edges.add).toEqual([]);
    expect(next.scenarios[0].steps).toEqual([]);
  });

  it('throws on an edit it cannot read', () => {
    expect(() => applyEdits(p(), [{ op: 'teleport' }       ])).toThrow(/teleport/);
    expect(() => applyEdits(p(), [{ op: 'remove-step', scenario: 'nope', index: 0 }])).toThrow(/nope/);
    expect(() => applyEdits(p(), [{ op: 'remove-step', scenario: 'add-a-meal', index: 9 }])).toThrow(/index/);
    expect(() => applyEdits(p(), [{ op: 'move-step', scenario: 'add-a-meal', from: 0, to: 9 }])).toThrow(/index/);
    expect(() => applyEdits(p(), [{ op: 'edit-step', scenario: 'add-a-meal', index: 9, step: { text: 'x' } }])).toThrow(/index/);
  });
});

describe('a real map (the sample repo)', () => {
  const real = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'topology.json'), 'utf8'));
  const byType = (type        ) => real.nodes.find((n     ) => n.type === type);

  /** A small realistic proposal: a page and a table under the first app that has a page */
  const realistic = () => {
    const app = real.nodes.find((n     ) => n.type === 'app' && real.edges.some((e     ) => e.from === n.id && !e.kind && real.nodes.find((m     ) => m.id === e.to)?.type === 'page'));
    const ownedPage = real.edges.find((e     ) => e.from === app.id && !e.kind && real.nodes.find((m     ) => m.id === e.to)?.type === 'page').to;
    const rom = byType('service');
    return {
      version: 1,
      spec: '0099',
      title: 'Meal planner',
      summary: 'A page that keeps the week\'s meals.',
      nodes: {
        add: [
          { id: 'page-test-meals', label: '/meals', type: 'page', parent: app.id, desc: 'The week.' },
          { id: 'table-test-meals', label: 'meals', type: 'table', parent: app.id, table: 'meals', desc: 'One row per meal.' },
        ],
        change: [{ id: rom.id, set: { desc: `${rom.desc} Also reads /meals.` }, why: 'reads /meals' }],
        remove: [{ id: ownedPage, why: 'replaced by /meals' }],
      },
      edges: {
        add: [{ from: 'page-test-meals', to: 'table-test-meals', kind: 'writes', label: 'meals.add' }, { from: 'table-test-meals', to: 'page-test-meals', kind: 'reads', keys: ['meals:*'] }],
        change: [],
        remove: [],
      },
      scenarios: [{ id: 'add-a-meal', title: 'Add a meal', steps: [{ node: 'page-test-meals', text: 'You submit the form.' }, { edge: { from: 'page-test-meals', to: 'table-test-meals', kind: 'writes' }, text: 'The page writes a row.' }] }],
    };
  };

  it('accepts a realistic proposal, applies it, and sees it as not yet built', () => {
    const p = realistic();
    expect(messages(p, real)).toEqual([]);
    const r = applyProposal(real, p);
    expect(r.nodes).toHaveLength(real.nodes.length + 2);
    expect(r.nodes.filter((n     ) => n.mark !== 'none').map((n     ) => n.mark).sort()).toEqual(['added', 'added', 'changed', 'removed']);
    const s = proposalStatus(real, p);
    expect(s.summary.pending).toBe(s.summary.total);
  });

  it('flags the same proposal once it points at something that is not there', () => {
    const p = realistic();
    (p.nodes.add[0]       ).parent = 'app-that-does-not-exist';
    expect(messages(p, real).join('\n')).toMatch(/app-that-does-not-exist/);
  });
});

describe('cornfield proposal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topology-proposal-test-'));
  const run = (...args          ) => spawnSync(process.execPath, [path.join(ROOT, 'cli/cornfield.js'), ...args, '--repo', SAMPLE], { encoding: 'utf8', cwd: ROOT });
  const write = (name        , body         ) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  };
  const real = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'topology.json'), 'utf8'));
  const app = real.nodes.find((n     ) => n.type === 'app').id;
  const good = { version: 1, spec: '0099', title: 'T', summary: 'S', nodes: { add: [{ id: 'page-cli-test', label: '/cli-test', type: 'page', parent: app }] }, scenarios: [{ id: 's', title: 'S', steps: [{ node: 'page-cli-test', text: 'Open it.' }] }] };

  it('prints the summary and the status table for a valid file and exits 0', () => {
    const res = run('proposal', write('good.json', good));
    expect(res.stdout).toMatch(/1 added/);
    expect(res.stdout).toMatch(/pending/);
    expect(res.stdout).toMatch(/page-cli-test/);
    expect(res.status).toBe(0);
  });

  it('prints each error and exits 1 for an invalid file', () => {
    const res = run('proposal', write('bad.json', { ...good, version: 7, nodes: { add: [{ id: 'x', label: 'x', type: 'gizmo' }] } }));
    expect(res.stdout + res.stderr).toMatch(/version/);
    expect(res.stdout + res.stderr).toMatch(/gizmo/);
    expect(res.status).toBe(1);
  });

  it('exits 1 for a file that is missing or is not JSON, and for no file', () => {
    expect(run('proposal', path.join(dir, 'nope.json')).status).toBe(1);
    expect(run('proposal', write('broken.json', '{ nope')).status).toBe(1);
    expect(run('proposal').status).toBe(1);
  });

  it('is cleaned up', () => {
    fs.rmSync(dir, { recursive: true, force: true });
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('proposalProblems (a proposal that has begun to land)', () => {
  const p = () => proposal();
  /** The map after the build landed everything */
  const built = () => {
    const r = applyProposal(base(), p());
    const clean = ({ mark, before, why, ...rest }     ) => rest;
    return { version: 1, nodes: r.nodes.filter((n     ) => n.mark !== 'removed').map(clean), edges: r.edges.filter((e     ) => e.mark !== 'removed').map(clean) };
  };

  it('reports every error before the build', () => {
    const q = p();
    q.nodes.add[0].parent = 'nowhere';
    const { errors, building } = cli.proposalProblems(base(), q);
    expect(building).toBe(false);
    expect(errors.some((e     ) => e.path === 'nodes.add[0].parent')).toBe(true);
  });

  it('is clean once everything landed: the added ids exist and the removed ones are gone, as they should', () => {
    expect(validateProposal(built(), p()).length).toBeGreaterThan(0);
    expect(cli.proposalProblems(built(), p())).toEqual({ errors: [], building: true });
  });

  it('still reports the structural mistakes of a proposal that has begun to land', () => {
    const q = p();
    q.nodes.add[0].type = 'gizmo';
    q.scenarios[0].steps = [];
    const { errors, building } = cli.proposalProblems(built(), q);
    expect(building).toBe(true);
    expect(errors.map((e     ) => e.path).sort()).toEqual(['nodes.add[0].type', 'scenarios[0].steps']);
  });

  it('is not fooled by a typo in a removal: an id that never existed is not a landing (a real map)', () => {
    const real = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'topology.json'), 'utf8'));
    const q = minimal({
      nodes: {
        add: [{ id: 'page-x-new', label: '/new', type: 'page', parent: 'app-nope-typo' }],
        remove: [{ id: 'page-typo-does-not-exist', why: 'gone' }],
      },
    });
    const { errors, building } = cli.proposalProblems(real, q);
    expect(building).toBe(false);
    expect(errors.map((e     ) => e.path).sort()).toEqual(['nodes.add[0].parent', 'nodes.remove[0].id']);
  });

  it('a removal of something that never existed does not start the build', () => {
    const q = minimal({ nodes: { remove: [{ id: 'ghost', why: 'x' }] } });
    expect(cli.proposalProblems(base(), q)).toMatchObject({ building: false, errors: [{ path: 'nodes.remove[0].id' }] });
  });

  it('a change whose set already holds does not start the build', () => {
    const q = minimal({ nodes: { change: [{ id: 'rom-render', set: { desc: 'Bakes pages.' }, why: 'x' }], add: [{ id: 'x', label: '/x', type: 'page', parent: 'nope' }] } });
    expect(cli.proposalProblems(base(), q).building).toBe(false);
    expect(cli.proposalProblems(base(), q).errors.some((e     ) => e.path === 'nodes.add[0].parent')).toBe(true);
  });

  it('an edge removal of an edge that never existed does not start the build', () => {
    const q = minimal({ edges: { remove: [{ from: 'app-a', to: 'table-items', kind: 'calls', why: 'x' }] } });
    expect(cli.proposalProblems(base(), q)).toMatchObject({ building: false, errors: [{ path: 'edges.remove[0]' }] });
  });

  it('only a landed addition starts the build', () => {
    const q = p();
    expect(cli.proposalProblems(base(), q).building).toBe(false);
    const half = base();
    half.nodes.push({ id: 'page-meals', label: '/meals', type: 'page', r: 18, color: NODE_THEMES.page.color }       );
    half.edges.push({ from: 'app-a', to: 'page-meals' });
    expect(cli.proposalProblems(half, q).building).toBe(true);
  });

  it('a proposal that only removes or changes is never building: its file goes red once it lands (delete it in that PR)', () => {
    const q = minimal({ nodes: { remove: [{ id: 'page-home', why: 'x' }] } });
    const t = base();
    t.nodes = t.nodes.filter((n) => n.id !== 'page-home');
    t.edges = t.edges.filter((e) => e.from !== 'page-home' && e.to !== 'page-home');
    expect(cli.proposalProblems(t, q)).toMatchObject({ building: false, errors: [{ state: 'missing-target' }] });
  });

  it('keeps reporting what a landing cannot explain, even while building', () => {
    const q = p();
    q.nodes.add.push({ id: 'page-orphan', label: '/orphan', type: 'page', parent: 'app-nowhere' });
    q.edges.add.push({ from: 'page-meals', to: 'table-nowhere', kind: 'writes' });
    q.scenarios[0].steps.push({ node: 'node-nowhere', text: 'lost' });
    const { errors, building } = cli.proposalProblems(built(), q);
    expect(building).toBe(true);
    expect(errors.map((e     ) => e.path).sort()).toEqual(['edges.add[1].to', 'nodes.add[1].parent', 'scenarios[0].steps[2].node']);
    expect(errors.every((e     ) => e.state === 'dangling')).toBe(true);
  });

  it('copes with a proposal too broken to have a status', () => {
    expect(cli.proposalProblems(base(), { version: 1, title: 'T', summary: 'S', nodes: { add: [null], remove: [{ id: 'ghost', why: 'x' }] } }).errors.length).toBeGreaterThan(0);
  });
});

describe('validateProposalFiles (what `cornfield validate` runs)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topology-proposal-files-'));
  const topology = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'topology.json'), 'utf8'));
  const app = topology.nodes.find((n     ) => n.type === 'app').id;
  const good = { version: 1, title: 'T', summary: 'S', nodes: { add: [{ id: 'page-files-test', label: '/files-test', type: 'page', parent: app }] } };

  it('checks every proposal and skips review files', () => {
    fs.writeFileSync(path.join(dir, '0001-good.json'), JSON.stringify(good));
    fs.writeFileSync(path.join(dir, '0002-bad.json'), JSON.stringify({ ...good, version: 9 }));
    fs.writeFileSync(path.join(dir, '0002-bad.review.json'), JSON.stringify({ verdict: 'approved' }));
    fs.writeFileSync(path.join(dir, '0003-broken.json'), '{ nope');
    const errors = cli.validateProposalFiles(topology, dir);
    expect(errors.some((e        ) => e.includes('0002-bad.json') && /version/.test(e))).toBe(true);
    expect(errors.some((e        ) => e.includes('0003-broken.json'))).toBe(true);
    expect(errors.some((e        ) => e.includes('0001-good.json'))).toBe(false);
    expect(errors.some((e        ) => e.includes('review'))).toBe(false);
  });

  it('tells the author of a proposal that adds nothing to delete it once it lands', () => {
    const only = { version: 1, title: 'T', summary: 'S', nodes: { remove: [{ id: 'page-that-is-gone', why: 'x' }] } };
    fs.writeFileSync(path.join(dir, '0004-only-removes.json'), JSON.stringify(only));
    const errors = cli.validateProposalFiles(topology, dir);
    expect(errors.find((e        ) => e.includes('0004-only-removes.json'))).toMatch(/delete it/);
    fs.rmSync(path.join(dir, '0004-only-removes.json'));
  });

  it('is silent when the directory is missing or holds only good proposals', () => {
    expect(cli.validateProposalFiles(topology, path.join(dir, 'nope'))).toEqual([]);
    fs.rmSync(path.join(dir, '0002-bad.json'));
    fs.rmSync(path.join(dir, '0003-broken.json'));
    expect(cli.validateProposalFiles(topology, dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

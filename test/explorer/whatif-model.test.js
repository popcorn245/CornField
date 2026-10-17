/**
 * What-if editing, the pure half (TOPO-11): the undo and redo list, localStorage, what a control's intent means as an edit,
 * the refusal of an edit that makes the proposal worse, the `edit` mark on the applied map, the scenario sync, hit-testing and the
 * words of the edits list. No DOM: these run in node.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import * as W from '../../explorer/whatif-model.js';
// @ts-expect-error plain JS modules, no declarations
import { applyProposal, edgeKey } from '../../core/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { showsNode, showsEdge, placeAddedNodes, proposalPanelHtml, fieldRows } from '../../explorer/proposal-model.js';

const node = (id        , type        , extra         = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, ...extra });
const base = {
  nodes: [node('root', 'root'), node('app-a', 'app'), node('page-old', 'page', { label: '/old' }), node('page-keep', 'page', { label: '/keep' }), node('table-t', 'table')],
  edges: [
    { from: 'root', to: 'app-a' }, { from: 'app-a', to: 'page-old' }, { from: 'app-a', to: 'page-keep' },
    { from: 'page-old', to: 'table-t', kind: 'reads', keys: ['a'], status: 'live', label: 'renders rows' },
  ],
};
const robot = () => ({
  version: 1, spec: '0013', title: 'Meals', summary: 'Adds /meals.',
  nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }], change: [], remove: [] },
  edges: { add: [{ from: 'page-meals', to: 'table-t', kind: 'writes', label: 'meals.add' }] },
  scenarios: [{ id: 'add-a-meal', title: 'Add a meal', steps: [{ node: 'page-meals', text: 'You open /meals.' }, { edge: { from: 'page-meals', to: 'table-t', kind: 'writes' }, text: 'It writes a row.' }] }],
});
const ctx = (extra         = {}) => ({ takenIds: new Set([...base.nodes.map((n) => n.id), 'page-meals']), scenarios: robot().scenarios, now: 1000, ...extra });
const empty = () => W.emptyWhatIf();

describe('the list', () => {
  const a = { op: 'add-node', label: 'A' };
  const b = { op: 'add-node', label: 'B' };
  it('undo takes the last edit back, redo puts it again, a new edit empties redo', () => {
    let wi = W.pushEdit(W.pushEdit(empty(), a), b);
    expect(wi.edits).toEqual([a, b]);
    wi = W.undo(wi);
    expect(wi).toEqual({ edits: [a], undone: [b] });
    expect(W.canRedo(wi)).toBe(true);
    expect(W.redo(wi)).toEqual({ edits: [a, b], undone: [] });
    expect(W.pushEdit(wi, { op: 'add-node', label: 'C' }).undone).toEqual([]);
  });

  it('undo and redo on nothing change nothing', () => {
    expect(W.undo(empty())).toEqual(empty());
    expect(W.redo(empty())).toEqual(empty());
    expect(W.canUndo(empty())).toBe(false);
    expect(W.hasEdits(empty())).toBe(false);
  });

  it('never changes the list it was given', () => {
    const wi = W.pushEdit(empty(), a);
    const frozen = JSON.stringify(wi);
    W.undo(wi); W.pushEdit(wi, b); W.withoutEditAt(wi, 0);
    expect(JSON.stringify(wi)).toBe(frozen);
  });

  it('takes one edit out of the middle, and leaves redo as it was', () => {
    const wi = { edits: [a, b, { op: 'add-node', label: 'C' }], undone: [{ op: 'x' }] };
    expect(W.withoutEditAt(wi, 1)).toEqual({ edits: [a, { op: 'add-node', label: 'C' }], undone: [{ op: 'x' }] });
  });
});

describe('localStorage', () => {
  it('keys a proposal by its source and slug', () => {
    expect(W.storageKey('0013-meals', 'topo-09')).toBe('topology-explorer:whatif:topo-09/0013-meals');
    expect(W.storageKey('0013-meals', null)).toBe('topology-explorer:whatif:checkout/0013-meals');
    expect(W.storageKey('0013-meals', 'topo-09')).not.toBe(W.storageKey('0013-meals', 'checkout'));
  });

  it('writes a versioned object and reads it back', () => {
    const wi = { edits: [{ op: 'add-node', label: 'A', at: 1 }], undone: [{ op: 'add-node', label: 'B', at: 2 }] };
    const text = W.serialize(wi, { slug: '0013-meals', source: 'topo-09', now: 5 });
    expect(JSON.parse(text)).toEqual({ version: 1, slug: '0013-meals', source: 'topo-09', savedAt: 5, edits: wi.edits, undone: wi.undone });
    expect(W.parseStored(text)).toEqual(wi);
  });

  it('reads nothing, nonsense, another version or a list of non-edits as an empty list', () => {
    for (const text of [null, '', 'not json', '[]', '{"version":2,"edits":[{"op":"x"}]}', '{"version":1}', '{"version":1,"edits":[1,"a",null,{"nope":1}]}']) {
      expect(W.parseStored(text          )).toEqual(empty());
    }
  });

  it('keeps no more than the most edits a proposal holds', () => {
    const edits = Array.from({ length: W.MAX_EDITS + 20 }, () => ({ op: 'add-node' }));
    expect(W.parseStored(JSON.stringify({ version: 1, edits })).edits).toHaveLength(W.MAX_EDITS);
  });
});

describe('intents become edits', () => {
  it('add-node: an id from the type and label, unique among the map and the proposal; trims; leaves out what is empty', () => {
    const e = W.editFromIntent({ type: 'add-node', nodeType: 'page', label: ' /meals ', parent: 'app-a', desc: '  ' }, ctx());
    expect(e).toEqual({ op: 'add-node', id: 'page-meals-2', label: '/meals', type: 'page', parent: 'app-a', at: 1000 });
    expect(W.editFromIntent({ type: 'add-node', nodeType: 'table', label: 'Meals', desc: 'rows' }, ctx())).toMatchObject({ id: 'table-meals', desc: 'rows' });
    expect('parent' in W.editFromIntent({ type: 'add-node', nodeType: 'table', label: 'Meals' }, ctx())).toBe(false);
  });

  it('add-node asks for a label and a known type, in plain words', () => {
    expect(W.editFromIntent({ type: 'add-node', nodeType: 'page', label: '  ' }, ctx())).toEqual({ error: 'Give the node a label.' });
    expect(W.editFromIntent({ type: 'add-node', nodeType: 'nonsense', label: 'x' }, ctx())).toEqual({ error: 'Pick a type for the node.' });
  });

  it('add-edge: from, to, an optional kind, a flow only for a flow edge', () => {
    expect(W.editFromIntent({ type: 'add-edge', from: 'page-old', to: 'table-t', kind: 'writes', label: ' x ' }, ctx())).toEqual({ op: 'add-edge', from: 'page-old', to: 'table-t', kind: 'writes', label: 'x', at: 1000 });
    expect(W.editFromIntent({ type: 'add-edge', from: 'a', to: 'b', kind: '' }, ctx())).toEqual({ op: 'add-edge', from: 'a', to: 'b', at: 1000 });
    expect(W.editFromIntent({ type: 'add-edge', from: 'a', to: 'b', kind: 'flow', flow: 'rom' }, ctx())).toMatchObject({ kind: 'flow', flow: 'rom' });
    expect('flow' in W.editFromIntent({ type: 'add-edge', from: 'a', to: 'b', kind: 'reads', flow: 'rom' }, ctx())).toBe(false);
    expect(W.editFromIntent({ type: 'add-edge', from: 'a', to: 'b', kind: 'flow' }, ctx())).toEqual({ error: 'Pick which flow the edge belongs to.' });
    expect(W.editFromIntent({ type: 'add-edge', from: 'a', to: 'a' }, ctx())).toEqual({ error: 'An edge joins two different nodes.' });
  });

  it('remove-node and remove-edge carry a reason the proposal can print', () => {
    expect(W.editFromIntent({ type: 'remove-node', id: 'page-old' }, ctx())).toMatchObject({ op: 'remove-node', id: 'page-old', why: expect.stringContaining('you') });
    const e = W.editFromIntent({ type: 'remove-edge', edge: { from: 'a', to: 'b', kind: 'reads', keys: ['x'], mark: 'edit' } }, ctx());
    expect(e).toMatchObject({ op: 'remove-edge', from: 'a', to: 'b', kind: 'reads' });
    expect('keys' in e || 'mark' in e).toBe(false); // only the fields that name the edge
  });

  it('add-step: points at a node or an edge, with words; a new scenario needs a title and gets an id from it', () => {
    expect(W.editFromIntent({ type: 'add-step', scenario: 'add-a-meal', node: 'table-t', text: ' It is stored. ' }, ctx())).toEqual({ op: 'add-step', scenario: 'add-a-meal', step: { node: 'table-t', text: 'It is stored.' }, at: 1000 });
    expect(W.editFromIntent({ type: 'add-step', scenario: 'add-a-meal', edge: { from: 'a', to: 'b', kind: 'reads', mark: 'x' }, text: 't', index: 1 }, ctx())).toMatchObject({ step: { edge: { from: 'a', to: 'b', kind: 'reads' } }, index: 1 });
    expect(W.editFromIntent({ type: 'add-step', scenario: 'add-a-meal', node: 'a', text: '' }, ctx())).toEqual({ error: 'Say what happens at this step.' });
    expect(W.editFromIntent({ type: 'add-step', scenario: 'add-a-meal', text: 'x' }, ctx())).toEqual({ error: 'Pick a node or an edge on the map first: the step points at it.' });
    expect(W.editFromIntent({ type: 'add-step', scenario: null, node: 'a', text: 'x' }, ctx())).toEqual({ error: 'Name the new scenario.' });
    expect(W.editFromIntent({ type: 'add-step', scenario: null, title: 'Add a meal', node: 'a', text: 'x' }, ctx())).toMatchObject({ scenario: 'add-a-meal-2', title: 'Add a meal' });
  });

  it('reword, move and delete a step map onto edit-step, move-step and remove-step', () => {
    expect(W.editFromIntent({ type: 'reword-step', scenario: 's', index: 1, text: ' new ' }, ctx())).toEqual({ op: 'edit-step', scenario: 's', index: 1, step: { text: 'new' }, at: 1000 });
    expect(W.editFromIntent({ type: 'reword-step', scenario: 's', index: 1, text: ' ' }, ctx())).toEqual({ error: 'A step needs some words.' });
    expect(W.editFromIntent({ type: 'move-step', scenario: 's', from: 0, to: 1 }, ctx())).toEqual({ op: 'move-step', scenario: 's', from: 0, to: 1, at: 1000 });
    expect(W.editFromIntent({ type: 'delete-step', scenario: 's', index: 0 }, ctx())).toEqual({ op: 'remove-step', scenario: 's', index: 0, at: 1000 });
    expect(W.editFromIntent({ type: 'dance' }, ctx())).toEqual({ error: 'That is not something the editor can do.' });
  });
});

describe('tryEdit', () => {
  const add = (extra        ) => ({ op: 'add-node', id: 'service-planner', label: 'Planner', type: 'service', at: 1, ...extra });

  it('applies an edit that keeps the proposal as sound as it was, and returns the effective proposal', () => {
    const r = W.tryEdit(base, robot(), empty(), add({ parent: 'app-a' }));
    expect(r.ok).toBe(true);
    expect(r.whatIf.edits).toHaveLength(1);
    expect(r.effective.nodes.add.map((n     ) => n.id)).toEqual(['page-meals', 'service-planner']);
    expect(r.errors).toEqual([]);
  });

  it('never changes the robot\'s proposal', () => {
    const p = robot();
    const frozen = JSON.stringify(p);
    W.tryEdit(base, p, empty(), add({}));
    W.tryEdit(base, p, empty(), { op: 'remove-node', id: 'page-old' });
    expect(JSON.stringify(p)).toBe(frozen);
  });

  it('refuses a structural error and leaves the list as it was, with the message', () => {
    const wi = W.pushEdit(empty(), add({}));
    const r = W.tryEdit(base, robot(), wi, add({ id: 'page-bad', type: 'page', label: 'no slash' }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/must start with a slash route/);
    expect(wi.edits).toHaveLength(1);
  });

  it('refuses a parent that is not on the map (dangling) and an unknown node type', () => {
    expect(W.tryEdit(base, robot(), empty(), add({ parent: 'nowhere' })).message).toMatch(/neither the map nor the added nodes/);
    expect(W.tryEdit(base, robot(), empty(), add({ type: 'nonsense' })).message).toMatch(/Unknown node type/);
  });

  it('refuses an edge the map already has, and one added twice', () => {
    const dup = W.tryEdit(base, robot(), empty(), { op: 'add-edge', from: 'page-old', to: 'table-t', kind: 'reads' });
    expect(dup.ok).toBe(false);
    expect(dup.message).toMatch(/already exists in the map/);
    const once = W.tryEdit(base, robot(), empty(), { op: 'add-edge', from: 'page-keep', to: 'table-t', kind: 'writes' });
    expect(once.ok).toBe(true);
    const twice = W.tryEdit(base, robot(), once.whatIf, { op: 'add-edge', from: 'page-keep', to: 'table-t', kind: 'writes' });
    expect(twice.ok).toBe(false);
    expect(twice.message).toMatch(/already added/);
  });

  it('refuses removing a node the robot\'s own edge ends at', () => {
    const r = W.tryEdit(base, robot(), empty(), { op: 'remove-node', id: 'table-t' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/is a node this proposal removes/);
  });

  it('allows removing a node a step points at: the step stays, and points at what goes away, which a proposal may show', () => {
    const p = robot();
    p.scenarios[0].steps.push({ node: 'page-keep', text: 'The old page.' }       );
    const r = W.tryEdit(base, p, empty(), { op: 'remove-node', id: 'page-keep', why: 'x' });
    expect(r.ok).toBe(true);
    expect(r.effective.scenarios[0].steps.at(-1)).toEqual({ node: 'page-keep', text: 'The old page.' });
  });

  it('lets the last step of a scenario go: an empty scenario is something to edit from, and the problem list says it', () => {
    const p = robot();
    p.scenarios[0].steps = [{ node: 'page-meals', text: 'Only step.' }       ];
    const r = W.tryEdit(base, p, empty(), { op: 'remove-step', scenario: 'add-a-meal', index: 0 });
    expect(r.ok).toBe(true);
    expect(r.errors.map((e     ) => e.message)).toContain('A scenario needs at least one step.');
  });

  it('does not refuse an edit because the robot\'s proposal already had a problem of its own', () => {
    const p = robot();
    p.nodes.add.push({ id: 'page-bad', label: 'no slash', type: 'page', parent: 'app-a' }       );
    expect(W.tryEdit(base, p, empty(), add({})).ok).toBe(true);
  });

  it('reports an edit applyEdits cannot read (a step that is not there) without its internals', () => {
    const r = W.tryEdit(base, robot(), empty(), { op: 'remove-step', scenario: 'add-a-meal', index: 9 });
    expect(r.ok).toBe(false);
    expect(r.message).toBe('index 9 is out of range (the scenario has 2 steps)');
  });

  it('stops at the most edits a proposal keeps', () => {
    const full = { edits: Array.from({ length: W.MAX_EDITS }, () => ({ op: 'add-edge', from: 'x', to: 'y' })), undone: [] };
    expect(W.tryEdit(base, robot(), full, add({})).message).toMatch(/as many edits/);
  });
});

describe('tryRemoveEdit and replay', () => {
  const e1 = { op: 'add-node', id: 'service-planner', label: 'Planner', type: 'service', parent: 'app-a', at: 1 };
  const e2 = { op: 'add-edge', from: 'service-planner', to: 'table-t', kind: 'calls', at: 2 };

  it('takes an edit out of the middle when nothing builds on it', () => {
    const r = W.tryRemoveEdit(base, robot(), { edits: [e1, { op: 'add-node', id: 'tool-x', label: 'X', type: 'tool', at: 3 }], undone: [] }, 0);
    expect(r.ok).toBe(true);
    expect(r.whatIf.edits.map((e     ) => e.id)).toEqual(['tool-x']);
  });

  it('refuses when a later edit builds on it, and says which way out there is', () => {
    const r = W.tryRemoveEdit(base, robot(), { edits: [e1, e2], undone: [] }, 0);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^A later edit builds on this one\. Remove that one first/);
  });

  it('replays a stored list in order', () => {
    const r = W.replay(base, robot(), { edits: [e1, e2], undone: [] });
    expect(r.dropped).toEqual([]);
    expect(r.whatIf.edits).toEqual([e1, e2]);
    expect(r.effective.edges.add).toHaveLength(2);
  });

  it('drops an edit the robot\'s newer proposal no longer fits, keeps the rest, and keeps redo', () => {
    const newer = robot();
    newer.nodes.add.push({ id: 'service-planner', label: 'Planner (robot)', type: 'service', parent: 'app-a' }       ); // the robot added the same id since
    const redo = { op: 'add-node', id: 'tool-y', label: 'Y', type: 'tool', at: 9 };
    const r = W.replay(base, newer, { edits: [e1, e2, { op: 'add-node', id: 'tool-x', label: 'X', type: 'tool', at: 3 }], undone: [redo] });
    expect(r.dropped.map((d     ) => d.edit)).toEqual([e1]);
    expect(r.whatIf.edits.map((e     ) => e.op === 'add-node' ? e.id : e.kind)).toEqual(['calls', 'tool-x']);
    expect(r.whatIf.undone).toEqual([redo]);
    expect(W.droppedText(1)).toBe('1 edit you made no longer fits this proposal and was dropped.');
    expect(W.droppedText(2)).toBe('2 edits you made no longer fit this proposal and were dropped.');
  });
});

describe('the edit mark', () => {
  const apply = (edits          ) => {
    const p = robot();
    const { effective } = W.evaluate(base, p, edits);
    const applied = applyProposal(base, effective);
    return { applied: W.markEdits(applied, p, effective), effective, p };
  };
  const mark = (list       , id        ) => list.find((x) => x.id === id);

  it('marks a node an edit adds, and the ownership edge of its parent, with an editOp of added', () => {
    const { applied } = apply([{ op: 'add-node', id: 'service-planner', label: 'Planner', type: 'service', parent: 'app-a' }]);
    expect(mark(applied.nodes, 'service-planner')).toMatchObject({ mark: 'edit', editOp: 'added' });
    const own = applied.edges.find((e     ) => e.from === 'app-a' && e.to === 'service-planner');
    expect(own).toMatchObject({ mark: 'edit', editOp: 'added' });
  });

  it('leaves the robot\'s own marks alone', () => {
    const { applied } = apply([{ op: 'add-node', id: 'service-planner', label: 'Planner', type: 'service' }]);
    expect(mark(applied.nodes, 'page-meals').mark).toBe('added');
    expect(applied.edges.find((e     ) => e.from === 'page-meals' && e.to === 'table-t').mark).toBe('added');
    expect(mark(applied.nodes, 'app-a').mark).toBe('none');
  });

  it('marks an edge an edit adds', () => {
    const { applied } = apply([{ op: 'add-edge', from: 'page-keep', to: 'table-t', kind: 'writes' }]);
    expect(applied.edges.find((e     ) => e.from === 'page-keep' && e.kind === 'writes')).toMatchObject({ mark: 'edit', editOp: 'added' });
  });

  it('marks a base node an edit removes, and every edge it had, as removed edits', () => {
    const { applied } = apply([{ op: 'remove-node', id: 'page-keep', why: 'x' }]);
    expect(mark(applied.nodes, 'page-keep')).toMatchObject({ mark: 'edit', editOp: 'removed' });
    expect(applied.edges.find((e     ) => e.to === 'page-keep')).toMatchObject({ mark: 'edit', editOp: 'removed' });
  });

  it('marks a base edge an edit removes, and not the one the robot already removed', () => {
    const p = robot();
    (p.edges       ).remove = [{ from: 'app-a', to: 'page-old', why: 'gone' }];
    const edits = [{ op: 'remove-edge', from: 'page-old', to: 'table-t', kind: 'reads', why: 'x' }];
    const { effective } = W.evaluate(base, p, edits);
    const applied = W.markEdits(applyProposal(base, effective), p, effective);
    expect(applied.edges.find((e     ) => e.kind === 'reads')).toMatchObject({ mark: 'edit', editOp: 'removed' });
    expect(applied.edges.find((e     ) => e.from === 'app-a' && e.to === 'page-old').mark).toBe('removed');
  });

  it('does nothing with no edits (the same proposal)', () => {
    const p = robot();
    const applied = applyProposal(base, p);
    expect(W.markEdits(applied, p, p)).toBe(applied);
    expect(applied.nodes.some((n     ) => n.mark === 'edit')).toBe(false);
  });

  it('a node the robot added that an edit drops is just gone', () => {
    const { applied } = apply([{ op: 'remove-node', id: 'page-meals' }]);
    expect(mark(applied.nodes, 'page-meals')).toBeUndefined();
  });

  it('is told apart from the robot\'s marks by the views: Before hides what you added, After what you removed, Diff shows both', () => {
    const { applied } = apply([{ op: 'add-node', id: 'service-planner', label: 'Planner', type: 'service', parent: 'app-a' }, { op: 'remove-node', id: 'page-keep', why: 'x' }]);
    const added = mark(applied.nodes, 'service-planner');
    const removed = mark(applied.nodes, 'page-keep');
    expect([showsNode('before', added), showsNode('diff', added), showsNode('after', added)]).toEqual([false, true, true]);
    expect([showsNode('before', removed), showsNode('diff', removed), showsNode('after', removed)]).toEqual([true, true, false]);
    expect(showsEdge('before', applied.edges.find((e     ) => e.to === 'service-planner'))).toBe(false);
  });

  it('is placed beside its parent like any added node', () => {
    const { applied } = apply([{ op: 'add-node', id: 'service-planner', label: 'Planner', type: 'service', parent: 'app-a' }]);
    applied.nodes.forEach((n     , i        ) => { if (n.mark !== 'added' && n.mark !== 'edit') { n.x = i * 200; n.y = 0; } });
    placeAddedNodes(applied.nodes, applied.edges);
    const parent = mark(applied.nodes, 'app-a');
    const kid = mark(applied.nodes, 'service-planner');
    expect(Math.hypot(kid.x - parent.x, kid.y - parent.y)).toBeLessThan(200);
  });

  it('is drawn violet by the scene: a ring and a violet edge; a removal is faded and struck through; none of it in the plain map', () => {
    const { applied } = apply([{ op: 'add-node', id: 'service-planner', label: 'Planner', type: 'service', parent: 'app-a' }, { op: 'remove-node', id: 'page-keep', why: 'x' }]);
    applied.nodes.forEach((n     , i        ) => { n.x = i * 100; n.y = 0; });
    const state = {
      nodes: applied.nodes, edges: applied.edges, view: 'orbit', flow: null, activeLayers: Object.fromEntries(W.NODE_TYPES.map((t        ) => [t, true])), selectedNode: null, searchQuery: '', scenario: null,
      proposal: { version: 1 }, proposalView: 'diff', rings: { rings: [], clusters: [] }, camera: { x: 0, y: 0, zoom: 1 }, width: 800, height: 600,
    };
    const scene = buildScene(state);
    const added = scene.nodes.find((n     ) => n.id === 'service-planner');
    const removed = scene.nodes.find((n     ) => n.id === 'page-keep');
    expect(added).toMatchObject({ mark: 'edit', labelStrike: false });
    expect(added.alpha).toBe(1);
    expect(removed).toMatchObject({ mark: 'edit', labelStrike: true });
    expect(removed.alpha).toBeLessThan(0.6);
    const edge = scene.edges.find((e     ) => e.to === 'service-planner');
    expect(edge).toMatchObject({ mark: 'edit', color: '#a78bfa', dash: null });
    const gone = scene.edges.find((e     ) => e.to === 'page-keep');
    expect(gone).toMatchObject({ mark: 'edit', color: '#a78bfa' });
    expect(gone.dash).not.toBeNull();
    // After hides the removal, Before hides the addition
    expect(buildScene({ ...state, proposalView: 'after' }).nodes.some((n     ) => n.id === 'page-keep')).toBe(false);
    expect(buildScene({ ...state, proposalView: 'before' }).nodes.some((n     ) => n.id === 'service-planner')).toBe(false);
  });

  it('the panel reads "Added by your edit" with its fields and "Removed by your edit"', () => {
    const { applied } = apply([{ op: 'add-node', id: 'service-planner', label: 'Planner', type: 'service', parent: 'app-a', desc: 'plans' }, { op: 'remove-node', id: 'page-keep', why: 'Removed by you, to see what it changes.' }]);
    const added = proposalPanelHtml(mark(applied.nodes, 'service-planner'));
    expect(added).toContain('Added by your edit');
    expect(added).toContain('plans');
    expect(added).not.toContain('editOp');
    expect(fieldRows(mark(applied.nodes, 'service-planner')).map((r     ) => r.field)).toContain('label');
    expect(proposalPanelHtml(mark(applied.nodes, 'page-keep'))).toContain('Removed by your edit');
  });
});

describe('the player follows the edits', () => {
  const before = robot().scenarios;
  it('does nothing when nothing plays, or when what plays is not a scenario of this proposal', () => {
    expect(W.scenarioSync(null, before, before)).toEqual({ action: 'none' });
    expect(W.scenarioSync('rom-products', before, before)).toEqual({ action: 'none' });
  });
  it('hands the player the edited scenario, or stops it when it is gone', () => {
    const after = [{ ...before[0], steps: before[0].steps.slice(1) }];
    expect(W.scenarioSync('add-a-meal', before, after)).toEqual({ action: 'update', scenario: after[0] });
    expect(W.scenarioSync('add-a-meal', before, [])).toEqual({ action: 'stop' });
  });
});

describe('nodeAtPoint', () => {
  const nodes = [{ id: 'a', x: 100, y: 100, r: 20 }, { id: 'b', x: 300, y: 100, r: 20 }];
  const camera = { x: 10, y: 0, zoom: 2 };
  it('finds the node under a screen point, through the camera', () => {
    expect(W.nodeAtPoint(nodes, camera, 10 + 200, 200)?.id).toBe('a');
    expect(W.nodeAtPoint(nodes, camera, 10 + 600, 200)?.id).toBe('b');
    expect(W.nodeAtPoint(nodes, camera, 400, 400)).toBeNull();
  });
  it('a touch reaches further than a mouse', () => {
    const near = { x: 10 + 200 + 50, y: 200 };
    expect(W.nodeAtPoint(nodes, camera, near.x, near.y)).toBeNull();
    expect(W.nodeAtPoint(nodes, camera, near.x, near.y, true)?.id).toBe('a');
  });
  it('the node drawn last wins where two overlap', () => {
    expect(W.nodeAtPoint([{ id: 'under', x: 0, y: 0, r: 20 }, { id: 'over', x: 5, y: 0, r: 20 }], { x: 0, y: 0, zoom: 1 }, 2, 0)?.id).toBe('over');
  });
});

describe('words', () => {
  const words = { nameOf: (id        ) => ({ 'app-a': 'tasks', 'page-meals': '/meals' }                          )[id] || id, scenarioTitle: () => 'Add a meal' };
  it('one plain line per edit', () => {
    const d = (e        ) => W.describeEdit(e, words);
    expect(d({ op: 'add-node', label: '/plan', type: 'page', parent: 'app-a' })).toBe('Added the page “/plan” under tasks');
    expect(d({ op: 'remove-node', id: 'page-meals' })).toBe('Removed /meals');
    expect(d({ op: 'add-edge', from: 'page-meals', to: 'table-t', kind: 'writes' })).toBe('Drew an edge /meals → table-t (writes)');
    expect(d({ op: 'add-edge', from: 'a', to: 'b', kind: 'flow', flow: 'rom' })).toBe('Drew an edge a → b (flow, rom)');
    expect(d({ op: 'remove-edge', from: 'app-a', to: 'page-meals' })).toBe('Removed the edge tasks → /meals (ownership)');
    expect(d({ op: 'add-step', scenario: 's', step: { text: 'Hello' } })).toBe('Added a step to “Add a meal”: Hello');
    expect(d({ op: 'edit-step', scenario: 's', index: 0 })).toBe('Reworded step 1 of “Add a meal”');
    expect(d({ op: 'move-step', scenario: 's', from: 0, to: 2 })).toBe('Moved step 1 of “Add a meal” to 3');
    expect(d({ op: 'remove-step', scenario: 's', index: 1 })).toBe('Deleted step 2 of “Add a meal”');
    expect(W.editsLabel(3)).toBe('Your edits (3)');
  });
});

describe('the edge key stays the proposal\'s', () => {
  it('edgeKey is what the mark compares by', () => {
    expect(edgeKey({ from: 'a', to: 'b' })).toBe('a|b|own');
  });
});

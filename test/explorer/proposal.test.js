/**
 * @vitest-environment node
 *
 * The pure half of the proposal overlay (TOPO-09, spec 0012 B2): what Before, Diff and After
 * show, the dimming, the counts chip, the address, the panel's before / after rows, and where an
 * added node is placed. buildScene is run on a small hand-made map with a proposal applied by the
 * real `applyProposal`, so what the views show is what a real proposal produces.
 */
import { describe, it, expect } from 'vitest';
import { loadSample } from '../helpers.js';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { applyProposal, summarize } from '../../core/proposal.js';
import {
  beforeOf, chipText, fieldRows, markIn, orderAddedLast, parseProposalQuery, pinLanes, placeAddedNodes, proposalPanelHtml, showsEdge, showsNode, touchedIds,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/proposal-model.js';
// @ts-expect-error plain JS modules, no declarations
import { buildDataFlow } from '../../explorer/flows.js';
// @ts-expect-error plain JS modules, no declarations
import { computeLaneLayout } from '../../explorer/layout.js';
// @ts-expect-error plain JS modules, no declarations
import { state as sharedState } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { MARK, PROPOSAL_DIM_ALPHA, buildScene, isNodeVisible } from '../../explorer/scene.js';

// ---------------------------------------------------------------------------
//  A small map and a proposal over it
// ---------------------------------------------------------------------------
const node = (id        , type        , x        , y        , extra         = {}) => ({ id, type, x, y, r: 20, color: '#336699', label: id, ...extra });
const base = {
  nodes: [
    node('root', 'root', 0, 0),
    node('app-a', 'app', 300, 0, { desc: 'old words' }),
    node('page-old', 'page', 300, 120),
    node('page-keep', 'page', 420, 60),
    node('table-t', 'table', -200, 0, { label: 'tasks' }),
    node('far-away', 'tool', -400, 300),
  ],
  edges: [
    { from: 'root', to: 'app-a' },
    { from: 'app-a', to: 'page-old' },
    { from: 'app-a', to: 'page-keep' },
    { from: 'page-keep', to: 'table-t', kind: 'writes', label: 'tasks.add', keys: [] },
    { from: 'page-old', to: 'table-t', kind: 'reads', keys: ['a'] },
    { from: 'root', to: 'far-away' },
  ],
};
const proposal = {
  version: 1, title: 'Meals', summary: 'Adds /meals.',
  nodes: {
    add: [{ id: 'page-new', label: '/meals', type: 'page', parent: 'app-a', desc: 'the meal planner' }],
    change: [{ id: 'app-a', set: { desc: 'new words', label: 'App A' }, why: 'mentions meals' }],
    remove: [{ id: 'page-old', why: 'replaced by /meals' }],
  },
  edges: { add: [{ from: 'page-new', to: 'table-t', kind: 'writes', label: 'meals.add', keys: [] }] },
};
const applied = () => applyProposal(base, proposal);

function mkState(view               , extra         = {})      {
  const { nodes, edges } = applied();
  return {
    nodes, edges, view: 'orbit', flow: null, rings: { rings: [], clusters: [] },
    camera: { x: 0, y: 0, zoom: 1 }, width: 800, height: 600, selectedNode: null, searchQuery: '', isFreeform: false,
    activeLayers: { app: true, pkg: true, page: true, atom: true, molecule: true, token: true, tool: true, flow: true, table: true, rom: true, service: true, external: true, stack: false },
    sim: null, sceneVersion: 1,
    ...(view ? { proposal, proposalView: view } : {}),
    ...extra,
  };
}
const ids = (scene     ) => scene.nodes.map((n     ) => n.id);
const sn = (scene     , id        ) => scene.nodes.find((n     ) => n.id === id);
const se = (scene     , from        , to        ) => scene.edges.find((e     ) => e.from === from && e.to === to);

// ---------------------------------------------------------------------------
//  The three views, through buildScene
// ---------------------------------------------------------------------------
describe('Before', () => {
  const scene = buildScene(mkState('before'));

  it('is the base map: what the proposal adds is hidden, what it removes is still there', () => {
    expect(ids(scene)).toEqual(['root', 'app-a', 'page-old', 'page-keep', 'table-t', 'far-away']);
    expect(se(scene, 'app-a', 'page-new')).toBeUndefined();
    expect(se(scene, 'page-new', 'table-t')).toBeUndefined();
    expect(se(scene, 'page-old', 'table-t')).toBeDefined();
  });

  it('reads a changed node as it was, and carries no marks and no dimming', () => {
    expect(sn(scene, 'app-a').label).toBe('app-a');
    for (const n of scene.nodes) { expect(n.mark, n.id).toBe('none'); expect(n.alpha, n.id).toBe(1); expect(n.labelStrike, n.id).toBe(false); }
    for (const e of scene.edges) expect(e.mark).toBe('none');
  });

  it('is the picture there would be with no proposal at all', () => {
    const plain = buildScene(mkState(null, { nodes: base.nodes.map((n) => ({ ...n })), edges: base.edges.map((e) => ({ ...e })) }));
    expect(scene.nodes).toEqual(plain.nodes);
    expect(scene.edges).toEqual(plain.edges);
  });
});

describe('After', () => {
  const scene = buildScene(mkState('after'));

  it('has what is added and changed, as normal, and hides what is removed with its edges', () => {
    expect(ids(scene)).toEqual(['root', 'app-a', 'page-keep', 'table-t', 'far-away', 'page-new']);
    expect(sn(scene, 'app-a').label).toBe('App A');
    expect(se(scene, 'app-a', 'page-new')).toBeDefined();
    expect(se(scene, 'page-new', 'table-t')).toBeDefined();
    expect(se(scene, 'app-a', 'page-old')).toBeUndefined();
    expect(se(scene, 'page-old', 'table-t')).toBeUndefined();
  });

  it('carries no marks and no dimming', () => {
    for (const n of scene.nodes) { expect(n.mark, n.id).toBe('none'); expect(n.alpha, n.id).toBe(1); }
    for (const e of scene.edges) { expect(e.mark).toBe('none'); expect(e.color).not.toBe(MARK.added.color); }
  });
});

describe('Diff', () => {
  const scene = buildScene(mkState('diff'));

  it('draws everything, with the marks', () => {
    expect(ids(scene)).toEqual(['root', 'app-a', 'page-old', 'page-keep', 'table-t', 'far-away', 'page-new']);
    expect(sn(scene, 'page-new').mark).toBe('added');
    expect(sn(scene, 'app-a').mark).toBe('changed');
    expect(sn(scene, 'page-old').mark).toBe('removed');
    expect(sn(scene, 'table-t').mark).toBe('none');
  });

  it('dims what the proposal does not touch, but keeps it drawn, and keeps what it touches at full strength', () => {
    expect(sn(scene, 'far-away').alpha).toBe(PROPOSAL_DIM_ALPHA);
    expect(sn(scene, 'far-away').labelAlpha).toBe(PROPOSAL_DIM_ALPHA);
    expect(sn(scene, 'far-away').glow).toBe(0);
    expect(sn(scene, 'page-keep').alpha).toBe(PROPOSAL_DIM_ALPHA); // an existing page the proposal does not touch
    expect(sn(scene, 'page-new').alpha).toBe(1);
    expect(sn(scene, 'app-a').alpha).toBe(1);
    // the end of an added edge is not marked itself, but it is part of the change
    expect(sn(scene, 'table-t').alpha).toBe(1);
  });

  it('fades a removed node and strikes its label through', () => {
    const removed = sn(scene, 'page-old');
    expect(removed.alpha).toBeCloseTo(MARK.removed.alpha);
    expect(removed.labelStrike).toBe(true);
    expect(sn(scene, 'page-new').labelStrike).toBe(false);
  });

  it('keeps the label of a marked node when zoomed out', () => {
    expect(sn(scene, 'page-new').labelKeep).toBe(true);
    expect(sn(scene, 'page-keep').labelKeep).toBe(false);
  });

  it('draws an added edge dashed in the added colour, a removed one red and faded, an untouched one dimmed', () => {
    const added = se(scene, 'page-new', 'table-t');
    expect(added.mark).toBe('added');
    expect(added.color).toBe(MARK.added.color);
    expect(added.dash).toEqual(MARK.added.edgeDash);
    const owns = se(scene, 'app-a', 'page-new'); // the ownership edge `parent` made
    expect(owns.mark).toBe('added');
    expect(owns.color).toBe(MARK.added.color);
    const removed = se(scene, 'page-old', 'table-t');
    expect(removed.mark).toBe('removed');
    expect(removed.color).toBe(MARK.removed.color);
    expect(removed.alpha).toBeLessThan(added.alpha);
    const untouched = se(scene, 'root', 'far-away');
    expect(untouched.mark).toBe('none');
    expect(untouched.alpha).toBe(PROPOSAL_DIM_ALPHA);
    expect(untouched.packet).toBeNull();
  });

  it('draws a marked edge of a kind that is usually quiet', () => {
    const quiet = { ...mkState('diff') };
    quiet.edges = [...quiet.edges, { from: 'page-new', to: 'table-t', kind: 'calls', mark: 'added', label: 'x' }, { from: 'page-keep', to: 'table-t', kind: 'calls', mark: 'none', label: 'y' }];
    const s = buildScene(quiet);
    expect(s.edges.filter((e     ) => e.kind === 'calls').map((e     ) => e.mark)).toEqual(['added']);
  });

  it('shows a selection over a dimmed node at the deeper of the two dimmings', () => {
    const s = buildScene(mkState('diff', { selectedNode: applied().nodes.find((n     ) => n.id === 'page-new') }));
    expect(sn(s, 'far-away').alpha).toBeLessThanOrEqual(PROPOSAL_DIM_ALPHA);
    expect(sn(s, 'page-new').halo).toBe('selected');
  });

  it('is a plain picture when no proposal is open, whatever the view says', () => {
    const s = buildScene(mkState(null, { proposalView: 'diff' }));
    expect(s.nodes.every((n     ) => n.mark === 'none' && n.alpha === 1)).toBe(true);
  });
});

describe('isNodeVisible', () => {
  it('follows the view', () => {
    const find = (st     , id        ) => st.nodes.find((n     ) => n.id === id);
    const before = mkState('before'), after = mkState('after'), diff = mkState('diff');
    expect(isNodeVisible(before, find(before, 'page-new'))).toBe(false);
    expect(isNodeVisible(after, find(after, 'page-old'))).toBe(false);
    expect(isNodeVisible(diff, find(diff, 'page-new'))).toBe(true);
    expect(isNodeVisible(diff, find(diff, 'page-old'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  The small pure pieces
// ---------------------------------------------------------------------------
describe('view rules', () => {
  it('shows an item by its mark', () => {
    expect(showsNode('before', { mark: 'added' })).toBe(false);
    expect(showsNode('before', { mark: 'removed' })).toBe(true);
    expect(showsNode('after', { mark: 'removed' })).toBe(false);
    expect(showsNode('after', { mark: 'added' })).toBe(true);
    expect(showsNode('diff', { mark: 'removed' })).toBe(true);
    expect(showsEdge('before', { mark: 'added' })).toBe(false);
    expect(showsEdge('after', { mark: 'removed' })).toBe(false);
  });

  it('keeps the mark only in Diff, except a what-if edit, which shows in every view', () => {
    expect(markIn('diff', { mark: 'added' })).toBe('added');
    expect(markIn('before', { mark: 'changed' })).toBe('none');
    expect(markIn('after', { mark: 'changed' })).toBe('none');
    expect(markIn('after', { mark: 'edit' })).toBe('edit');
    expect(markIn('before', {})).toBe('none');
  });

  it('puts back what a change replaced, and drops a field the item did not have', () => {
    const changed = applied().nodes.find((n     ) => n.id === 'app-a');
    expect(changed.desc).toBe('new words');
    const was = beforeOf(changed);
    expect(was.desc).toBe('old words');
    expect(was.label).toBe('app-a');
    expect(beforeOf({ id: 'x', mark: 'changed', desc: 'd', before: { desc: null } })).not.toHaveProperty('desc');
    const plain = { id: 'p', mark: 'none' };
    expect(beforeOf(plain)).toBe(plain);
  });
});

describe('touchedIds', () => {
  it('counts marked nodes and both ends of marked edges as touched, and their neighbours as near, but not a touched hub\'s untouched children', () => {
    const { nodes, edges } = applied();
    const { touched, near } = touchedIds(nodes, edges);
    expect([...touched].sort()).toEqual(['app-a', 'page-new', 'page-old', 'table-t']);
    expect(near.has('root')).toBe(true); // the app's parent
    expect(near.has('page-keep')).toBe(true); // writes to the touched table
    expect(near.has('far-away')).toBe(false);
  });

  it('is empty for a proposal that touches nothing', () => {
    const { touched } = touchedIds(base.nodes.map((n) => ({ ...n, mark: 'none' })), base.edges.map((e) => ({ ...e, mark: 'none' })));
    expect(touched.size).toBe(0);
  });
});

describe('chipText', () => {
  it('lists the counts in order and leaves out zeros', () => {
    expect(chipText({ added: 3, changed: 1, removed: 1 })).toBe('3 added · 1 changed · 1 removed');
    expect(chipText({ added: 2, changed: 0, removed: 0 })).toBe('2 added');
    expect(chipText({ added: 0, changed: 0, removed: 4 })).toBe('4 removed');
    expect(chipText({ added: 0, changed: 0, removed: 0 })).toBe('No changes');
    expect(chipText(null)).toBe('No changes');
  });

  it('reads what summarize counts', () => {
    expect(chipText(summarize(proposal))).toBe('2 added · 1 changed · 1 removed');
  });
});

describe('parseProposalQuery', () => {
  it('reads the slug, the source and the view', () => {
    expect(parseProposalQuery('?proposal=0013-meals')).toEqual({ slug: '0013-meals', source: null, view: null });
    expect(parseProposalQuery('?proposal=0013-meals&source=topo-09&proposalView=after')).toEqual({ slug: '0013-meals', source: 'topo-09', view: 'after' });
    expect(parseProposalQuery('?foo=1&proposal=a.b_c-d')).toMatchObject({ slug: 'a.b_c-d' });
  });

  it('is null without a proposal, and for a slug that cannot be a file name', () => {
    for (const q of ['', '?', '?view=dataflow', '?proposal=', '?proposal=../x', '?proposal=a/b', '?proposal=%2e%2e%2fx', '?proposal=.hidden', '?proposal=a%00b', '?proposal=C:\\x']) {
      expect(parseProposalQuery(q), q).toBeNull();
    }
  });

  it('ignores a view it does not know', () => {
    expect(parseProposalQuery('?proposal=x&proposalView=sideways')?.view).toBeNull();
  });
});

describe('the panel rows', () => {
  it('lists each changed field before and after', () => {
    const changed = applied().nodes.find((n     ) => n.id === 'app-a');
    expect(fieldRows(changed)).toEqual([
      { field: 'desc', before: 'old words', after: 'new words' },
      { field: 'label', before: 'app-a', after: 'App A' },
    ]);
  });

  it('prints a field that did not exist as nothing before', () => {
    const rows = fieldRows({ mark: 'changed', summary: 's', before: { summary: null, n: 1 }, n: 2 });
    expect(rows).toEqual([{ field: 'summary', before: '', after: 's' }, { field: 'n', before: '1', after: '2' }]);
  });

  it('lists what an added node was written with, without how it is drawn', () => {
    const added = applied().nodes.find((n     ) => n.id === 'page-new');
    const fields = fieldRows(added).map((r     ) => r.field);
    expect(fields).toEqual(['id', 'label', 'type', 'desc']);
    expect(fieldRows(added).find((r     ) => r.field === 'desc')).toEqual({ field: 'desc', before: '', after: 'the meal planner' });
  });

  it('has no rows for a removal or an untouched item', () => {
    expect(fieldRows(applied().nodes.find((n     ) => n.id === 'page-old'))).toEqual([]);
    expect(fieldRows(applied().nodes.find((n     ) => n.id === 'far-away'))).toEqual([]);
  });

  it('makes a block with the reason and the rows, escaped, and nothing for an untouched item', () => {
    const changed = applied().nodes.find((n     ) => n.id === 'app-a');
    const html = proposalPanelHtml(changed);
    expect(html).toContain('Changed by this proposal');
    expect(html).toContain('mentions meals');
    expect(html).toContain('old words');
    expect(html).toContain('new words');
    expect(proposalPanelHtml(applied().nodes.find((n     ) => n.id === 'page-old'))).toContain('replaced by /meals');
    expect(proposalPanelHtml(applied().nodes.find((n     ) => n.id === 'far-away'))).toBe('');
    expect(proposalPanelHtml({ id: 'x', mark: 'changed', why: '<img src=x onerror=alert(1)>', before: {} })).not.toContain('<img');
  });
});

describe('placeAddedNodes', () => {
  it('puts an added node near its parent and never moves an existing one', () => {
    const { nodes, edges } = applied();
    const before = new Map(nodes.filter((n     ) => n.mark !== 'added').map((n     ) => [n.id, [n.x, n.y]]));
    placeAddedNodes(nodes, edges);
    const added = nodes.find((n     ) => n.id === 'page-new');
    const parent = nodes.find((n     ) => n.id === 'app-a');
    expect(Number.isFinite(added.x) && Number.isFinite(added.y)).toBe(true);
    expect(Math.hypot(added.x - parent.x, added.y - parent.y)).toBeLessThan(260);
    for (const n of nodes.filter((x     ) => x.mark !== 'added')) expect([n.x, n.y], n.id).toEqual(before.get(n.id));
  });

  it('keeps clear of every other node', () => {
    const { nodes, edges } = applied();
    placeAddedNodes(nodes, edges);
    const added = nodes.find((n     ) => n.id === 'page-new');
    for (const n of nodes) if (n !== added) expect(Math.hypot(n.x - added.x, n.y - added.y), n.id).toBeGreaterThanOrEqual(74);
  });

  it('places several nodes apart, a child of an added node after its parent, in any order in the file', () => {
    const p = {
      version: 1, title: 't', summary: 's',
      nodes: { add: [
        { id: 'child', label: 'child', type: 'page', parent: 'mid' },
        { id: 'mid', label: 'mid', type: 'page', parent: 'app-a' },
        { id: 'sib', label: 'sib', type: 'page', parent: 'app-a' },
      ] },
    };
    const { nodes, edges } = applyProposal(base, p);
    placeAddedNodes(nodes, edges);
    const added = nodes.filter((n     ) => n.mark === 'added');
    for (const a of added) for (const b of added) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(74);
    const mid = added.find((n     ) => n.id === 'mid'), child = added.find((n     ) => n.id === 'child');
    expect(Math.hypot(child.x - mid.x, child.y - mid.y)).toBeLessThan(260);
  });

  it('places a node with no parent by what it connects to, or else beside the centre', () => {
    const p = {
      version: 1, title: 't', summary: 's',
      nodes: { add: [{ id: 'svc', label: 'svc', type: 'service' }, { id: 'lone', label: 'lone', type: 'service' }] },
      edges: { add: [{ from: 'svc', to: 'table-t', kind: 'writes', label: 'x', keys: [] }] },
    };
    const { nodes, edges } = applyProposal(base, p);
    placeAddedNodes(nodes, edges);
    const svc = nodes.find((n     ) => n.id === 'svc'), lone = nodes.find((n     ) => n.id === 'lone'), t = nodes.find((n     ) => n.id === 'table-t');
    expect(Math.hypot(svc.x - t.x, svc.y - t.y)).toBeLessThan(260);
    expect(Number.isFinite(lone.x) && Number.isFinite(lone.y)).toBe(true);
  });

  it('does nothing when nothing is added', () => {
    const { nodes, edges } = applyProposal(base, { version: 1, title: 't', summary: 's' });
    expect(() => placeAddedNodes(nodes, edges)).not.toThrow();
  });
});

describe('orderAddedLast', () => {
  it('moves added nodes to the end of their tier and keeps the order of the rest', () => {
    const flow = { tiers: [{ nodes: [{ id: 'a', mark: 'added' }, { id: 'b' }, { id: 'c', mark: 'added' }, { id: 'd' }] }, { nodes: [] }] };
    orderAddedLast(flow);
    expect(flow.tiers[0].nodes.map((n) => n.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(() => orderAddedLast(null)).not.toThrow();
  });
});

describe('pinLanes', () => {
  const topology = loadSample();
  // layout.js measures labels on a canvas; a fixed width per character is enough here
  sharedState.ctx = { save() {}, restore() {}, font: '', measureText: (s        ) => ({ width: s.length * 6 }) };

  const lanes = (nodes       , edges       ) => {
    const flow = buildDataFlow(nodes, edges);
    flow.tiers.forEach((t     ) => t.nodes.forEach((n     ) => { n.r = Math.min(n.r || 18, 13); }));
    return flow;
  };
  /** The base laid out alone, and the same map with a proposal over it, pinned to it */
  function both(proposal        ) {
    const baseNodes = topology.nodes.map((n     ) => ({ ...n }));
    const baseFlow = lanes(baseNodes, topology.edges);
    computeLaneLayout(baseFlow);
    const applied = applyProposal(topology, proposal);
    const flow = lanes(applied.nodes, applied.edges);
    orderAddedLast(flow);
    const pinned = pinLanes(flow, baseFlow);
    return { baseFlow, flow, pinned, applied };
  }
  const adds = {
    version: 1, title: 't', summary: 's',
    nodes: { add: [
      { id: 'table-new-a', label: 'new_a', type: 'table', parent: 'store-sqlite' },
      { id: 'table-new-b', label: 'new_b', type: 'table', parent: 'store-sqlite' },
      { id: 'svc-new', label: 'lib/new.ts', type: 'service', parent: 'app-api' },
      { id: 'ext-new', label: 'New system', type: 'external', kind: 'cloud' },
    ] },
  };

  it('keeps every node that was in a lane exactly where the base layout put it', () => {
    const { baseFlow, flow, pinned } = both(adds);
    expect(pinned).toBe(true);
    const was = new Map(baseFlow.tiers.flatMap((t     ) => t.nodes).map((n     ) => [n.id, n]));
    let kept = 0;
    for (const n of flow.tiers.flatMap((t     ) => t.nodes)) {
      const b      = was.get(n.id);
      if (!b) continue;
      kept++;
      expect([n.x, n.y, n.r], n.id).toEqual([b.x, b.y, b.r]);
    }
    expect(kept).toBe(was.size);
  });

  it('puts each added node in a free cell of its own lane, none on top of another node', () => {
    const { flow } = both(adds);
    const all = flow.tiers.flatMap((t     ) => t.nodes.map((n     ) => ({ n, tier: t.key })));
    const spots = new Set        ();
    for (const { n } of all) {
      expect(Number.isFinite(n.x) && Number.isFinite(n.y), n.id).toBe(true);
      const spot = `${Math.round(n.x)},${Math.round(n.y)}`;
      expect(spots.has(spot), `${n.id} at ${spot}`).toBe(false);
      spots.add(spot);
    }
    const tierOf = (id        ) => all.find((a     ) => a.n.id === id) .tier;
    expect(['table-new-a', 'table-new-b'].map(tierOf)).toEqual(['tables', 'tables']);
    expect(tierOf('svc-new')).toBe('services');
    expect(tierOf('ext-new')).toBe('outside');
  });

  it('keeps an added node inside its lane band and makes the bands cover it', () => {
    const { flow, baseFlow } = both(adds);
    const bottom = -flow.top + 40;
    for (const n of flow.tiers.flatMap((t     ) => t.nodes)) expect(n.y, n.id).toBeLessThanOrEqual(bottom - 20);
    expect(flow.top).toBeLessThanOrEqual(baseFlow.top);
    expect(flow.headers).toEqual(baseFlow.headers);
  });

  it('gives up, so the lanes are laid out afresh, when a tier gets its first node', () => {
    const baseFlow = lanes(topology.nodes.map((n     ) => ({ ...n })), topology.edges);
    computeLaneLayout(baseFlow);
    const thin = { ...baseFlow, tiers: baseFlow.tiers.map((t     ) => (t.key === 'browser' ? { ...t, nodes: [] } : t)) };
    expect(pinLanes(baseFlow, thin)).toBe(false);
  });

  it('is a plain pass for a proposal that adds nothing to the lanes', () => {
    const { baseFlow, flow, pinned } = both({ version: 1, title: 't', summary: 's', nodes: { add: [{ id: 'page-x', label: '/x', type: 'page', parent: 'app-web' }] } });
    expect(pinned).toBe(true);
    expect(flow.top).toBe(baseFlow.top);
  });
});

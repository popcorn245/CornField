// The Work view's pure half (spec 0012 D2 to D5, D8): the scene of an answer, the layout, the filters, the layers' rows, the panel's words, the addresses.
import { describe, it, expect } from 'vitest';
import { workScene, layoutWork, applyFilters, layerRowsOf, panelOf, touchedBy, workAddress, nodeForAddress, startLayers, CODE_LAYER, tagOf, REL_WORDS, byLane, newWorkState, setWorkGraph, enterWork, leaveWork, showWork, applyWorkLayout } from '../../explorer/work-model.js';
import { buildScene, isNodeVisible } from '../../explorer/scene.js';
import { WORK_KINDS, WORK_THEMES } from '../../core/schema.js';
import { createState } from '../../explorer/instance-state.js';
import { matchIds } from '../../explorer/search-match.js';
import { RELS } from '../../server/work-graph.js';

const map = [
  { id: 'notifications', label: 'notifications', type: 'service', x: 5, y: 5, r: 20 },
  { id: 'api-billing', label: 'api-billing', type: 'app', x: 1, y: 1, r: 24 },
  { id: 'invoices', label: 'invoices', type: 'table', x: 2, y: 2, r: 18 },
  { id: 'auth', label: 'auth', type: 'core', x: 3, y: 3, r: 20 },
];
const graph = {
  ok: true,
  nodes: [
    { id: 'thread:31', kind: 'thread', stage: 'talk', title: 'Alerts on failed payments', state: 'open', open: true, waiting: false, number: 31, updated: '2026-11-10T00:00:00Z' },
    { id: 'issue:14', kind: 'issue', stage: 'talk', title: 'Exports time out', state: 'open', open: true, waiting: false, number: 14, updated: '2026-11-12T00:00:00Z' },
    { id: 'proposal:0100-flow', kind: 'proposal', stage: 'decide', title: 'A new flow', state: 'to-decide', open: true, waiting: true, slug: '0100-flow', number: 21, updated: '2026-11-11T00:00:00Z' },
    { id: 'run:run-0123456789ABCDEFGHIJKLMNOP', kind: 'run', stage: 'build', title: 'code on issue #14', state: 'waiting', open: true, waiting: true, runId: 'run-0123456789ABCDEFGHIJKLMNOP', updated: '2026-11-12T01:00:00Z' },
    { id: 'pull:27', kind: 'pull', stage: 'build', title: 'Page exports in chunks', state: 'open', open: true, waiting: false, number: 27, updated: '2026-11-12T02:00:00Z' },
    { id: 'deploy:9', kind: 'deploy', stage: 'ship', title: 'api-billing restarted', state: 'success', open: false, waiting: false, deployId: 9, updated: '2026-11-12T03:00:00Z' },
    { id: '/flow/start', kind: 'code', planned: true, label: '/flow/start', type: 'page' },
  ],
  edges: [
    { from: 'thread:31', to: 'notifications', rel: 'mentions' },
    { from: 'issue:14', to: 'run:run-0123456789ABCDEFGHIJKLMNOP', rel: 'agent-on' },
    { from: 'run:run-0123456789ABCDEFGHIJKLMNOP', to: 'pull:27', rel: 'opened' },
    { from: 'pull:27', to: 'issue:14', rel: 'closes' },
    { from: 'pull:27', to: 'deploy:9', rel: 'shipped' },
    { from: 'pull:27', to: 'api-billing', rel: 'changes' },
    { from: 'pull:27', to: 'invoices', rel: 'changes' },
    { from: 'proposal:0100-flow', to: 'api-billing', rel: 'changes' },
    { from: 'proposal:0100-flow', to: '/flow/start', rel: 'adds' },
    { from: 'deploy:9', to: 'api-billing', rel: 'restarts' },
    { from: 'pull:27', to: 'gone-from-the-map', rel: 'changes' },
  ],
  problems: [],
};

describe('the scene of an answer (D2)', () => {
  const scene = workScene(graph, map);
  const byId = (id) => scene.nodes.find((n) => n.id === id);
  it('has a node of each kind, with its shape and a letter or mark', () => {
    for (const kind of WORK_KINDS) {
      const n = scene.nodes.find((x) => x.work === kind);
      expect(n, kind).toBeTruthy();
      expect(n.shape).toBe(WORK_THEMES[kind].shape);
      expect(n.letters).toBe(WORK_THEMES[kind].letters);
    }
    expect(['circle', 'diamond', 'hexagon', 'rounded-square', 'square']).toEqual(expect.arrayContaining([...new Set(WORK_KINDS.map((k) => WORK_THEMES[k].shape))]));
  });
  it('labels say the kind and the number', () => {
    expect(byId('pull:27').label).toMatch(/^PR #27 · /);
    expect(byId('issue:14').label).toMatch(/^Issue #14 · /);
    expect(byId('thread:31').label).toMatch(/^Thread #31 · /);
    expect(byId('proposal:0100-flow').label).toMatch(/^Spec 0100 · /);
    expect(byId('deploy:9').label).toMatch(/^Deploy · /);
    expect(tagOf(byId('run:run-0123456789ABCDEFGHIJKLMNOP').item)).toBe('Run KLMNOP');
  });
  it('draws only the code that work touches, a planned node as planned, and no edge to what is nowhere', () => {
    const code = scene.nodes.filter((n) => !n.work).map((n) => n.id).sort();
    expect(code).toEqual(['/flow/start', 'api-billing', 'invoices', 'notifications']);
    expect(byId('/flow/start').planned).toBe(true);
    expect(byId('auth')).toBeUndefined();
    expect(scene.edges.some((e) => e.to === 'gone-from-the-map')).toBe(false);
    expect(scene.edges).toHaveLength(10);
    expect(byId('api-billing').touches).toBe(3);
  });
  it('gives each line its rel, its words and whether it joins work to work', () => {
    const closes = scene.edges.find((e) => e.kind === 'closes');
    expect(closes).toMatchObject({ from: 'pull:27', to: 'issue:14', tone: 'work', word: 'closes' });
    expect(scene.edges.find((e) => e.kind === 'adds').tone).toBe('code');
    for (const rel of RELS) expect(REL_WORDS[rel], rel).toBeTruthy();
  });
  it('leaves the map\'s own nodes alone', () => {
    expect(map[1].x).toBe(1);
    expect(byId('api-billing')).not.toBe(map[1]);
  });
});

describe('the layout (D3)', () => {
  it('puts the lanes left to right, then the code, most touched first; newest and waiting first within a lane', () => {
    const { nodes } = workScene(graph, map);
    const laid = layoutWork(nodes);
    const x = (id) => nodes.find((n) => n.id === id).x;
    expect(x('thread:31')).toBe(x('issue:14'));
    expect(x('thread:31')).toBeLessThan(x('proposal:0100-flow'));
    expect(x('proposal:0100-flow')).toBeLessThan(x('pull:27'));
    expect(x('pull:27')).toBeLessThan(x('deploy:9'));
    expect(x('deploy:9')).toBeLessThan(x('api-billing'));
    // the issue is newer than the thread: first in Talk; the waiting run before the newer-or-older pull request
    expect(nodes.find((n) => n.id === 'issue:14').y).toBeLessThan(nodes.find((n) => n.id === 'thread:31').y);
    expect(nodes.find((n) => n.id === 'run:run-0123456789ABCDEFGHIJKLMNOP').y).toBeLessThan(nodes.find((n) => n.id === 'pull:27').y);
    // the code: api-billing touches three pieces of work, so it is first
    const code = nodes.filter((n) => !n.work).sort((a, b) => a.y - b.y);
    expect(code[0].id).toBe('api-billing');
    expect(laid.lanes.map((l) => l.title.text)).toEqual(['Talk', 'Decide', 'Build', 'Ship', 'Code it touches']);
    expect(byLane({ waiting: true, updated: 'a', id: 'a' }, { waiting: false, updated: 'z', id: 'b' })).toBeLessThan(0);
  });
  it('runs the lanes top to bottom on a phone, with the code beside them', () => {
    const { nodes } = workScene(graph, map);
    const laid = layoutWork(nodes, { phone: true });
    const y = (id) => nodes.find((n) => n.id === id).y;
    expect(y('thread:31')).toBeLessThan(y('proposal:0100-flow'));
    expect(y('proposal:0100-flow')).toBeLessThan(y('pull:27'));
    expect(laid.lanes.map((l) => l.title.text)).toEqual(['Talk', 'Decide', 'Build · Ship', 'Code it touches']);
    const widest = Math.max(...nodes.filter((n) => n.work).map((n) => n.x));
    expect(Math.min(...nodes.filter((n) => !n.work).map((n) => n.x))).toBeGreaterThan(widest);
  });
  it('starts a long lane again in another column', () => {
    const many = { nodes: Array.from({ length: 45 }, (_, i) => ({ id: `proposal:p${i}`, kind: 'proposal', stage: 'decide', title: `s${i}`, state: 'approved', open: true, waiting: false, slug: `p${i}`, updated: `2026-11-01T00:${String(i).padStart(2, '0')}:00Z` })), edges: [] };
    const { nodes } = workScene(many, map);
    layoutWork(nodes);
    expect(new Set(nodes.map((n) => n.x)).size).toBe(3);
    expect(Math.max(...nodes.map((n) => n.y))).toBeLessThan(21 * 64);
  });
});

describe('layers, and Waiting on you (D3, D4)', () => {
  it('hides a kind whose layer is off, and the code only that kind touched', () => {
    const { nodes, edges } = workScene(graph, map);
    const layers = { ...startLayers(), 'work-deploy': false, 'work-pull': false, 'work-run': false };
    applyFilters(nodes, edges, { layers });
    expect(nodes.find((n) => n.id === 'pull:27').hidden).toBe(true);
    expect(nodes.find((n) => n.id === 'invoices').hidden).toBe(true); // only the pull request touched it
    expect(nodes.find((n) => n.id === 'api-billing').hidden).toBe(false); // the proposal still does
    applyFilters(nodes, edges, { layers: { ...startLayers(), [CODE_LAYER]: false } });
    expect(nodes.filter((n) => !n.work).every((n) => n.hidden)).toBe(true);
    expect(nodes.filter((n) => n.work).every((n) => !n.hidden)).toBe(true);
  });
  it('dims all but what waits', () => {
    const { nodes, edges } = workScene(graph, map);
    applyFilters(nodes, edges, { waiting: true });
    expect(nodes.filter((n) => !n.dim).map((n) => n.id).sort()).toEqual(['proposal:0100-flow', 'run:run-0123456789ABCDEFGHIJKLMNOP']);
    applyFilters(nodes, edges, { waiting: false });
    expect(nodes.some((n) => n.dim)).toBe(false);
  });
  it('lists the six kinds and the code, with their counts in words', () => {
    const rows = layerRowsOf(workScene(graph, map).nodes);
    expect(rows.map((r) => r.label)).toEqual(['Threads', 'Issues', 'Proposals', 'Agent runs', 'Pull requests', 'Deploys', 'Code they touch']);
    const text = Object.fromEntries(rows.map((r) => [r.label, r.countText]));
    expect(text.Proposals).toBe('1 to decide');
    expect(text['Agent runs']).toBe('1 waiting');
    expect(text['Pull requests']).toBe('1 open');
    expect(text['Code they touch']).toBe('4');
  });
});

describe('the scene draws it (D2, D3)', () => {
  const stateOf = () => {
    const state = createState();
    state.nodes = map.map((n) => ({ ...n }));
    state.edges = [];
    state.view = 'orbit';
    const mapState = { nodes: state.nodes, edges: state.edges, rings: state.rings };
    setWorkGraph(state, graph, state.nodes);
    state.view = 'work';
    enterWork(state);
    applyWorkLayout(state);
    return { state, mapState };
  };
  it('draws the kinds in their shapes and colour tokens, lines by kind, and the lanes', () => {
    const { state } = stateOf();
    const scene = buildScene(state);
    const shapes = Object.fromEntries(scene.nodes.filter((n) => n.work).map((n) => [n.work, n.shape]));
    expect(shapes).toEqual({ thread: 'circle', issue: 'circle', proposal: 'diamond', run: 'hexagon', pull: 'rounded-square', deploy: 'square' });
    expect(scene.nodes.find((n) => n.id === 'issue:14').letters).toBe('!');
    expect(scene.nodes.find((n) => n.id === '/flow/start').mark).toBe('added'); // planned: drawn as added
    expect(scene.decor.lanes).toHaveLength(5);
    const dash = (kind) => scene.edges.find((e) => e.kind === kind).dash;
    expect(dash('closes')).toBeNull();
    expect(dash('mentions')).not.toBeNull();
    expect(dash('adds')).not.toBeNull();
    expect(dash('mentions')).not.toEqual(dash('adds'));
  });
  it('names a line beside it when a node at either end is selected, and dims all but the neighbours', () => {
    const { state } = stateOf();
    state.selectedNode = state.nodes.find((n) => n.id === 'pull:27');
    const scene = buildScene(state);
    const lit = scene.edges.filter((e) => e.label).map((e) => `${e.from}>${e.to}:${e.label.text}`).sort();
    expect(lit).toContain('pull:27>issue:14:closes');
    expect(lit).toContain('pull:27>api-billing:changes');
    expect(lit).toContain('run:run-0123456789ABCDEFGHIJKLMNOP>pull:27:opened'); // selected at the line's end
    expect(scene.edges.find((e) => e.kind === 'adds').label).toBeNull();
    expect(scene.nodes.find((n) => n.id === 'thread:31').alpha).toBeLessThan(0.5);
    expect(scene.nodes.find((n) => n.id === 'issue:14').alpha).toBe(1);
  });
  it('dims what does not wait, hides what a layer hid, and the search finds #27, PR 27, a slug and words of a title', () => {
    const { state } = stateOf();
    state.work.waiting = true;
    applyFilters(state.work.nodes, state.work.edges, { layers: state.work.layers, waiting: true });
    let scene = buildScene(state);
    expect(scene.nodes.find((n) => n.id === 'proposal:0100-flow').alpha).toBe(1);
    expect(scene.nodes.find((n) => n.id === 'pull:27').alpha).toBeLessThan(0.5);
    state.work.layers['work-deploy'] = false;
    applyFilters(state.work.nodes, state.work.edges, { layers: state.work.layers, waiting: false });
    expect(isNodeVisible(state, state.nodes.find((n) => n.id === 'deploy:9'))).toBe(false);
    scene = buildScene(state);
    expect(scene.nodes.some((n) => n.id === 'deploy:9')).toBe(false);
    const ids = (q) => [...matchIds(state.nodes, q)].sort();
    expect(ids('#27')).toEqual(['pull:27']);
    expect(ids('PR 27')).toEqual(['pull:27']);
    expect(ids('pr 21')).toEqual(['proposal:0100-flow']);
    expect(ids('0100-flow')).toEqual(['proposal:0100-flow']);
    expect(ids('exports')).toEqual(expect.arrayContaining(['pull:27', 'issue:14']));
    expect(ids('#14')).toContain('issue:14');
  });
  it('puts the map back, layers and all, when the view is left', () => {
    const { state } = stateOf();
    const mapNodes = state.work.saved.nodes;
    const layers = { ...state.activeLayers };
    state.work.layers['work-pull'] = false;
    leaveWork(state);
    state.view = 'orbit';
    expect(state.nodes).toBe(mapNodes);
    expect(state.workLayers).toBeNull();
    expect(state.activeLayers).toEqual(layers);
    expect(buildScene(state).nodes.some((n) => n.work)).toBe(false);
  });
});

describe('the node panel (D5)', () => {
  const { nodes, edges } = workScene(graph, map);
  it('says kind, title, state pills, and what it is connected to, each a node to select', () => {
    const p = panelOf(nodes.find((n) => n.id === 'pull:27'), nodes, edges, { now: Date.parse('2026-11-13T00:00:00Z') });
    expect(p.kind).toBe('Pull request');
    expect(p.title).toBe('Page exports in chunks');
    expect(p.pills[0]).toMatchObject({ text: 'Open', state: 'open' });
    expect(p.links.map((l) => `${l.rel}|${l.id}`)).toEqual(expect.arrayContaining(['closes|issue:14', 'opened by|run:run-0123456789ABCDEFGHIJKLMNOP', 'shipped in|deploy:9', 'changes|api-billing', 'changes|invoices']));
    expect(p.links[0].work).toBeTruthy(); // work before code
    expect(p.says).toMatch(/Work panel/);
  });
  it('a proposal waiting on you says so; a node of code lists the work touching it', () => {
    const p = panelOf(nodes.find((n) => n.id === 'proposal:0100-flow'), nodes, edges);
    expect(p.pills.map((x) => x.text)).toEqual(['To decide', 'Waiting on you', 'PR #21']);
    expect(p.links.find((l) => l.id === '/flow/start').planned).toBe(true);
    const t = touchedBy(nodes.find((n) => n.id === 'api-billing'), nodes, edges);
    expect(t.map((x) => x.id).sort()).toEqual(['deploy:9', 'proposal:0100-flow', 'pull:27']);
    expect(t[0].waiting).toBe(true);
  });
});

describe('addresses (D8)', () => {
  it('reads ?view=work, ?pr=, ?issue=, ?run=, ?thread= and ?spec=', () => {
    expect(workAddress('?view=work')).toEqual({ view: true });
    expect(workAddress('?pr=21')).toEqual({ view: true, kind: 'pull', key: '21' });
    expect(workAddress('?issue=14')).toEqual({ view: true, kind: 'issue', key: '14' });
    expect(workAddress('?thread=31')).toEqual({ view: true, kind: 'thread', key: '31' });
    expect(workAddress('?run=run-0123456789ABCDEFGHIJKLMNOP')).toEqual({ view: true, kind: 'run', key: 'run-0123456789ABCDEFGHIJKLMNOP' });
    expect(workAddress('?spec=0100')).toEqual({ view: true, kind: 'proposal', key: '0100' });
    expect(workAddress('?view=dataflow')).toBeNull();
    expect(workAddress('')).toBeNull();
    expect(workAddress('?pr=abc').bad).toMatch(/not a pull request number/);
    expect(workAddress('?run=x').bad).toMatch(/not a run id/);
  });
  it('finds the node an address names', () => {
    const { nodes } = workScene(graph, map);
    expect(nodeForAddress(workAddress('?pr=27'), nodes)).toBe('pull:27');
    expect(nodeForAddress(workAddress('?spec=0100'), nodes)).toBe('proposal:0100-flow');
    expect(nodeForAddress(workAddress('?spec=0100-flow'), nodes)).toBe('proposal:0100-flow');
    expect(nodeForAddress(workAddress('?run=run-0123456789ABCDEFGHIJKLMNOP'), nodes)).toBe('run:run-0123456789ABCDEFGHIJKLMNOP');
    expect(nodeForAddress(workAddress('?issue=999'), nodes)).toBeNull();
  });
});

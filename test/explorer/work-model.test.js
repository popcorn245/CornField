// The Work view's pure half (spec 0012 D2 to D5, D8): the scene of an answer, the layout, the filters, the layers' rows, the panel's words, the addresses.
import { describe, it, expect } from 'vitest';
import { workScene, layoutWork, applyFilters, layerRowsOf, panelOf, touchedBy, workAddress, nodeForAddress, startLayers, CODE_LAYER, DRAFT_LAYER, DRAWN_CHARS, workPanelHtml, codePanelHtml, arrowTarget, landingWords, tagOf, REL_WORDS, byLane, newWorkState, setWorkGraph, enterWork, leaveWork, showWork, applyWorkLayout } from '../../explorer/work-model.js';
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
    expect(laid.lanes.map((l) => l.name)).toEqual(['Talk', 'Decide', 'Build', 'Ship', 'Code it touches']);
    expect(laid.lanes.map((l) => l.count)).toEqual([2, 1, 2, 1, 4]); // each lane's title says how many it holds (the page draws it in screen space)
    expect(laid.lanes.every((l) => l.title === null && l.note === null)).toBe(true);
    expect(byLane({ waiting: true, updated: 'a', id: 'a' }, { waiting: false, updated: 'z', id: 'b' })).toBeLessThan(0);
  });
  it('runs the lanes top to bottom on a phone, with the code beside them', () => {
    const { nodes } = workScene(graph, map);
    const laid = layoutWork(nodes, { phone: true });
    const y = (id) => nodes.find((n) => n.id === id).y;
    expect(y('thread:31')).toBeLessThan(y('proposal:0100-flow'));
    expect(y('proposal:0100-flow')).toBeLessThan(y('pull:27'));
    expect(laid.lanes.map((l) => l.name)).toEqual(['Talk', 'Decide', 'Build · Ship', 'Code it touches']);
    const widest = Math.max(...nodes.filter((n) => n.work).map((n) => n.x));
    expect(Math.min(...nodes.filter((n) => !n.work).map((n) => n.x))).toBeGreaterThan(widest);
  });
  it('cuts a long lane into columns that fit the screen, in a staggered grid with room for a name under each node', () => {
    const many = { nodes: Array.from({ length: 45 }, (_, i) => ({ id: `proposal:p${i}`, kind: 'proposal', stage: 'decide', title: `s${i}`, state: 'approved', open: true, waiting: false, slug: `p${i}`, updated: `2026-11-01T00:${String(i).padStart(2, '0')}:00Z` })), edges: [] };
    const { nodes } = workScene(many, map);
    const laid = layoutWork(nodes, { width: 1440, height: 800 });
    const columns = new Set(nodes.map((n) => n.x)).size;
    expect(columns).toBeGreaterThan(1);
    expect(columns).toBeLessThan(45);
    // no two nodes closer than a disc and its name need, at the zoom the first fit shows
    const z = laid.fit.zoom;
    for (const a of nodes) for (const b of nodes) {
      if (a === b) continue;
      const dx = Math.abs(a.x - b.x) * z;
      const dy = Math.abs(a.y - b.y) * z;
      expect(dx >= 20 || dy >= 20).toBe(true);
    }
  });
  it('shows only what its layers show: hidden nodes take no place, and the lanes shrink', () => {
    const { nodes, edges } = workScene(graph, map);
    applyFilters(nodes, edges, { layers: { ...startLayers(), 'work-deploy': false, 'work-run': false, 'work-pull': false } });
    const laid = layoutWork(nodes, { width: 1440, height: 800 });
    expect(laid.lanes.find((l) => l.name === 'Ship').count).toBe(0);
    expect(laid.lanes.find((l) => l.name === 'Build').count).toBe(0);
    expect(laid.lanes.find((l) => l.name === 'Code it touches').count).toBe(nodes.filter((n) => !n.work && !n.hidden).length);
  });
  it('fits the lanes under the toggles with room for the names at the edges, and keeps every shown node inside', () => {
    const { nodes } = workScene(graph, map);
    for (const [phone, width, height] of [[false, 1440, 848], [false, 1024, 700], [true, 390, 788]]) {
      const laid = layoutWork(nodes, { phone, width, height });
      const { fit, bounds } = laid;
      expect(fit.zoom).toBeGreaterThan(0);
      expect(fit.zoom).toBeLessThanOrEqual(1);
      if (!phone) { expect(fit.minX).toBeLessThan(bounds.x); expect(fit.maxX).toBeGreaterThan(bounds.w); } // room for the names at the edges (a phone's are tags, and need less)
      for (const n of nodes) { expect(n.x).toBeGreaterThanOrEqual(bounds.x); expect(n.x).toBeLessThanOrEqual(bounds.w); expect(n.y).toBeGreaterThanOrEqual(bounds.y); expect(n.y).toBeLessThanOrEqual(bounds.h); }
      // the engine's fit of the box (padding p) shows it at the zoom the layout was made for
      const p = width < 640 ? 44 : 96;
      const raw = Math.min((width - 2 * p) / (fit.maxX - fit.minX), (height - 2 * p) / (fit.maxY - fit.minY));
      expect(Math.min(1, raw)).toBeCloseTo(fit.zoom, 5);
    }
  });
  it('names each node by its tag and the start of its title (a phone: the tag), the whole name staying the node\'s', () => {
    const { nodes } = workScene({ nodes: [{ id: 'issue:3', kind: 'issue', stage: 'talk', title: 'A very long title that goes on and on and on', state: 'open', open: true, waiting: false, number: 3, updated: '2026-11-12T00:00:00Z' }], edges: [] }, map);
    layoutWork(nodes, { width: 1440, height: 800 });
    expect(nodes[0].labelText.length).toBeLessThanOrEqual(DRAWN_CHARS + 1);
    expect(nodes[0].labelText.startsWith('Issue #3 · A very')).toBe(true);
    expect(nodes[0].label).toContain('A very long title');
    layoutWork(nodes, { phone: true, width: 390, height: 788 });
    expect(nodes[0].labelText).toBe('Issue #3');
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
  it('holds the local drafts in a layer of their own, off to start, and counts them there and not as proposals', () => {
    const withDrafts = { ...graph, nodes: [...graph.nodes, { id: 'proposal:0001-local', kind: 'proposal', stage: 'decide', title: 'A local draft', state: 'local', open: true, waiting: false, slug: '0001-local', number: null, updated: '2026-11-01T00:00:00Z' }], edges: [...graph.edges, { from: 'proposal:0001-local', to: 'invoices', rel: 'changes' }] };
    const { nodes, edges } = workScene(withDrafts, map);
    const draft = nodes.find((n) => n.id === 'proposal:0001-local');
    expect(draft.draft).toBe(true);
    expect(startLayers()[DRAFT_LAYER]).toBe(false);
    applyFilters(nodes, edges, { layers: startLayers() });
    expect(draft.hidden).toBe(true);
    const rows = layerRowsOf(nodes);
    expect(rows.find((r) => r.label === 'Drafts').countText).toBe('1 local');
    expect(rows.find((r) => r.label === 'Proposals').count).toBe(1); // the one on a pull request
    // nothing in Decide but the proposal on a pull request, and the lane for the drafts is not there
    const laid = layoutWork(nodes, { width: 1440, height: 800 });
    expect(laid.lanes.map((l) => l.name)).not.toContain('Drafts');
    expect(laid.lanes.find((l) => l.name === 'Decide').count).toBe(1);
    // on: drawn, in a lane of their own beside Decide
    applyFilters(nodes, edges, { layers: { ...startLayers(), [DRAFT_LAYER]: true } });
    expect(draft.hidden).toBe(false);
    const on = layoutWork(nodes, { width: 1440, height: 800 });
    expect(on.lanes.map((l) => l.name)).toEqual(['Talk', 'Decide', 'Drafts', 'Build', 'Ship', 'Code it touches']);
    expect(on.lanes.find((l) => l.name === 'Drafts').count).toBe(1);
    // the proposals' layer off leaves the drafts to their own
    applyFilters(nodes, edges, { layers: { ...startLayers(), [DRAFT_LAYER]: true, 'work-proposal': false } });
    expect(draft.hidden).toBe(false);
    expect(nodes.find((n) => n.id === 'proposal:0100-flow').hidden).toBe(true);
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
    expect(rows.map((r) => r.label)).toEqual(['Threads', 'Issues', 'Proposals', 'Pull requests', 'Agent runs', 'Deploys', 'Drafts', 'Code they touch']);
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
  it('names a node by the start of its name, keeps the names of what waits, and places the rest by the map\'s own placing', () => {
    const { state } = stateOf();
    const scene = buildScene(state);
    const by = (id) => scene.nodes.find((n) => n.id === id);
    expect(by('pull:27').label).toBe('PR #27 · Page exports in…'); // cut at a word
    expect(by('proposal:0100-flow').labelKeep).toBe(true); // waits on you
    expect(by('run:run-0123456789ABCDEFGHIJKLMNOP').labelKeep).toBe(true);
    expect(by('pull:27').labelKeep).toBe(false); // the placing decides: no name for a node whose name would run into another
    expect(by('issue:14').labelKeep).toBe(false);
    state.selectedNode = state.nodes.find((n) => n.id === 'pull:27');
    const lit = buildScene(state);
    expect(lit.nodes.find((n) => n.id === 'pull:27').labelKeep).toBe(true); // the selected one and its neighbours keep theirs
    expect(lit.nodes.find((n) => n.id === 'issue:14').labelKeep).toBe(true);
    expect(lit.nodes.find((n) => n.id === 'thread:31').labelKeep).toBe(false);
    applyWorkLayout(state, { phone: true });
    expect(buildScene(state).nodes.find((n) => n.id === 'pull:27').label).toBe('PR #27'); // a phone: the tag alone
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

describe('the panel keeps the forge\'s words as text and its links as web links (spec 0012, security)', () => {
  const hostile = {
    nodes: [
      { id: 'issue:7', kind: 'issue', stage: 'talk', title: '<img src=x onerror=alert(1)>"\'', state: 'open', open: true, waiting: false, number: 7, author: '<b>me</b>', url: 'javascript:alert(1)', updated: '2026-11-12T00:00:00Z' },
      { id: 'pull:8', kind: 'pull', stage: 'build', title: '<script>alert(2)</script>', state: 'open', open: true, waiting: false, number: 8, url: 'https://forge.example.test/pull/8"><script>x</script>', updated: '2026-11-12T00:00:00Z' },
      { id: 'run:run-0123456789ABCDEFGHIJKLMNOP', kind: 'run', stage: 'build', title: 'ok', state: 'done', open: false, waiting: false, runId: 'run-0123456789ABCDEFGHIJKLMNOP', url: 'data:text/html,<b>x</b>', updated: '2026-11-12T00:00:00Z' },
      { id: 'deploy:1', kind: 'deploy', stage: 'ship', title: 'd', state: 'success', open: false, waiting: false, deployId: 1, url: null, updated: '2026-11-12T00:00:00Z' },
    ],
    edges: [{ from: 'issue:7', to: 'pull:8', rel: 'closes' }],
  };
  const html = (id) => {
    const { nodes, edges } = workScene(hostile, map);
    const node = nodes.find((n) => n.id === id);
    return workPanelHtml(panelOf(node, nodes, edges), node, { checks: '<i>checks</i>' });
  };
  it('escapes every title, author and label', () => {
    for (const id of ['issue:7', 'pull:8']) {
      const out = html(id);
      expect(out).not.toMatch(/<img|<script|<b>|<i>/);
      expect(out).toContain('&lt;');
    }
  });
  it('links to the forge only for an http or https address, and the address cannot leave its attribute', () => {
    expect(html('issue:7')).not.toContain('href=');
    expect(html('run:run-0123456789ABCDEFGHIJKLMNOP')).not.toContain('href=');
    expect(html('deploy:1')).not.toContain('href=');
    const out = html('pull:8');
    expect(out).toMatch(/href="https:\/\/forge\.example\.test\/pull\/8&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/);
    expect(out).toContain('rel="noreferrer"');
    expect((out.match(/href=/g) || []).length).toBe(1);
  });
  it('escapes the code panel too', () => {
    const { nodes } = workScene(hostile, [{ id: '"><x>', label: '<u>x</u>', type: 'page', x: 0, y: 0, r: 9 }]);
    const out = codePanelHtml({ id: '"><x>', label: '<u>x</u>' }, [{ rel: 'changed by', id: 'pull:8', label: '<script>', work: 'pull' }]);
    expect(out).not.toMatch(/<script|<x>|<u>/);
    expect(nodes.length).toBeGreaterThan(0);
  });
});

describe('the keyboard (N, P and the arrows)', () => {
  it('goes to the nearest shown node that way, and to none when there is none', () => {
    const { nodes } = workScene(graph, map);
    layoutWork(nodes, { width: 1440, height: 800 });
    const at = (id) => nodes.find((n) => n.id === id);
    const right = arrowTarget(nodes, at('thread:31'), 'ArrowRight');
    expect(right.x).toBeGreaterThan(at('thread:31').x);
    expect(['proposal', 'run', 'pull', 'deploy'].includes(right.work) || right.work === undefined).toBe(true);
    expect(arrowTarget(nodes, at('thread:31'), 'ArrowLeft')).toBeNull();
    const down = arrowTarget(nodes, at('issue:14'), 'ArrowDown');
    expect(down.id).toBe('thread:31'); // the next in the lane
    expect(arrowTarget(nodes, at('thread:31'), 'ArrowDown')).toBeNull();
    expect(arrowTarget(nodes, null, 'ArrowDown')).toBeNull();
    at('proposal:0100-flow').hidden = true;
    expect(arrowTarget(nodes, at('thread:31'), 'ArrowRight').id).not.toBe('proposal:0100-flow');
  });
  it('steps through the lanes in order, code last, and says where it is', () => {
    const { nodes } = workScene(graph, map);
    const laid = layoutWork(nodes, { width: 1440, height: 800 });
    const work = laid.order.filter((id) => nodes.find((n) => n.id === id).work);
    expect(work.slice(0, 2)).toEqual(['issue:14', 'thread:31']); // Talk, newest first
    expect(laid.order.indexOf('proposal:0100-flow')).toBeGreaterThan(laid.order.indexOf('thread:31'));
    expect(laid.order.indexOf('api-billing')).toBeGreaterThan(laid.order.indexOf('deploy:9')); // code after the lanes, the most touched first
    expect(new Set(laid.order).size).toBe(nodes.length);
    const words = landingWords(nodes.find((n) => n.id === 'proposal:0100-flow'), 2, 24);
    expect(words).toMatch(/^Spec 0100 · A new flow, proposal, .*waiting on you, 3 of 24$/);
    expect(landingWords(nodes.find((n) => n.id === 'api-billing'), 0, 5)).toMatch(/^api-billing, code, \d+ pieces? of work touch it, 1 of 5$/);
  });
});

describe('two spec pull requests with one slug (the server\'s second id form)', () => {
  const two = { nodes: [
    { id: 'proposal:0100-flow', kind: 'proposal', stage: 'decide', title: 'A new flow', state: 'to-decide', open: true, waiting: true, slug: '0100-flow', number: 21, updated: '2026-11-11T00:00:00Z' },
    { id: 'proposal:0100-flow@23', kind: 'proposal', stage: 'decide', title: 'A new flow, again', state: 'draft-pr', open: true, waiting: false, slug: '0100-flow', number: 23, updated: '2026-11-10T00:00:00Z' },
  ], edges: [] };
  it('keeps both as nodes, each its own, found by its number and by the slug', () => {
    const { nodes } = workScene(two, map);
    expect(nodes.map((n) => n.id)).toEqual(['proposal:0100-flow', 'proposal:0100-flow@23']);
    expect(nodeForAddress({ kind: 'pull', key: '23' }, nodes)).toBe('proposal:0100-flow@23');
    expect(nodeForAddress({ kind: 'pull', key: '21' }, nodes)).toBe('proposal:0100-flow');
    expect(nodeForAddress({ kind: 'proposal', key: '0100-flow' }, nodes)).toBe('proposal:0100-flow'); // the open one updated last
    const laid = layoutWork(nodes, { width: 1440, height: 800 });
    expect(new Set(laid.order).size).toBe(2);
    const out = workPanelHtml(panelOf(nodes[1], nodes, []), nodes[1], {});
    expect(out).toContain('data-id="proposal:0100-flow@23"');
  });
});

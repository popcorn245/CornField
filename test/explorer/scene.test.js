/**
 * @vitest-environment node
 *
 * The scene contract (TOPO-02, spec 0012 A1): buildScene turns the explorer's state into a
 * plain description of one picture. These tests build scenes from small hand-made states and
 * check every decision the old render.js made: layer visibility, which edge kinds are drawn only
 * for the selection, focus dimming, halos, label level of detail, edge styles, the data-flow
 * preset, the ROM simulation's subgraph, and that the scene never depends on the camera.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { loadSample } from '../helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  ARROW, CORE_RATIO, DIM_ALPHA, HALO, LABEL_ZOOM,
  buildScene, createSceneCache, edgePoint, getActiveSubgraph, isNodeVisible, labelAt, packetPoint, parseColor,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { createPlayer } from '../../explorer/scenario.js';
// @ts-expect-error plain JS modules, no declarations
import { buildDataFlow } from '../../explorer/flows.js';
// @ts-expect-error plain JS modules, no declarations
import { computeDegreeCentrality, computeLaneLayout, computeOrbitalLayout } from '../../explorer/layout.js';
// @ts-expect-error plain JS modules, no declarations
import { state as sharedState } from '../../explorer/state.js';

// ---------------------------------------------------------------------------
//  Small hand-made states
// ---------------------------------------------------------------------------
const node = (id        , type        , x = 0, y = 0, extra         = {}) => ({ id, type, x, y, r: 20, color: '#336699', label: id, ...extra });
const link = (from        , to        , extra         = {}) => ({ from, to, ...extra });

function mkState(nodes       , edges       , extra         = {})      {
  return {
    nodes, edges,
    view: 'orbit', flow: null, rings: { rings: [], clusters: [] },
    camera: { x: 0, y: 0, zoom: 1 }, width: 800, height: 600,
    selectedNode: null, searchQuery: '', isFreeform: false,
    activeLayers: { app: true, pkg: true, page: true, atom: true, molecule: true, token: true, tool: true, flow: true, table: true, rom: true, service: true, cloud: true, web: true, stack: false },
    scenario: null, sceneVersion: 1,
    ...extra,
  };
}
const ids = (scene     ) => scene.nodes.map((n     ) => n.id);
const byId = (scene     , id        ) => scene.nodes.find((n     ) => n.id === id);
const edge = (scene     , from        , to        ) => scene.edges.find((e     ) => e.from === from && e.to === to);

describe('layer visibility', () => {
  const all = ['root', 'app', 'pkg', 'page', 'atom', 'molecule', 'token', 'tool', 'core', 'store', 'rom', 'table', 'service', 'external', 'stack']
    .map((type, i) => node(type === 'root' ? 'root' : `n-${type}`, type, i * 10, 0));
  const st = (layers         = {}) => mkState(all, [], { activeLayers: { ...mkState([], []).activeLayers, ...layers } });

  it('draws every node whose layer is on, and the infra layer starts off', () => {
    const scene = buildScene(st());
    expect(ids(scene)).toEqual(all.map((n) => n.id).filter((id) => id !== 'n-stack'));
  });

  it('hides a node when its own layer is off, in node order', () => {
    expect(ids(buildScene(st({ page: false, token: false })))).toEqual(all.map((n) => n.id).filter((id) => !['n-page', 'n-token', 'n-stack'].includes(id)));
  });

  it('always draws the root', () => {
    const layers = Object.fromEntries(Object.keys(mkState([], []).activeLayers).map((k) => [k, false]));
    expect(ids(buildScene(st(layers)))).toEqual(['root']);
  });

  it('draws the core types while packages or atoms are on', () => {
    expect(ids(buildScene(st({ pkg: false })))).toContain('n-core');
    expect(ids(buildScene(st({ atom: false })))).toContain('n-core');
    expect(ids(buildScene(st({ pkg: false, atom: false })))).not.toContain('n-core');
  });

  it('draws stores and ROM nodes only while the data-flow layer is on, and ROM needs its own layer too', () => {
    expect(ids(buildScene(st({ flow: false })))).not.toContain('n-store');
    expect(ids(buildScene(st({ flow: false })))).not.toContain('n-rom');
    expect(ids(buildScene(st({ rom: false })))).not.toContain('n-rom');
    expect(ids(buildScene(st({ rom: false })))).toContain('n-store');
  });

  it('draws infra only when the stack layer is turned on', () => {
    expect(ids(buildScene(st({ stack: true })))).toContain('n-stack');
  });

  it('isNodeVisible agrees with the scene', () => {
    const s = st({ page: false });
    const drawn = new Set(ids(buildScene(s)));
    for (const n of all) expect(isNodeVisible(s, n), n.id).toBe(drawn.has(n.id));
  });

  it('draws an edge only when both of its nodes are drawn', () => {
    const s = mkState([node('a', 'app'), node('p', 'page'), node('q', 'page')], [link('a', 'p'), link('a', 'q')], { activeLayers: { ...mkState([], []).activeLayers, page: false } });
    expect(buildScene(s).edges).toHaveLength(0);
    expect(buildScene(mkState([node('a', 'app'), node('p', 'page')], [link('a', 'p'), link('a', 'missing')])).edges).toHaveLength(1);
  });
});

describe('cloud on the map (spec 0031, CLOUD-06)', () => {
  const nodes = [
    node('ext-cloudflare', 'external', 0, 0, { kind: 'cloud' }), node('ext-public-web', 'external', 100, 0, { kind: 'web' }),
    node('ext-old', 'external', 200, 0), // no kind: drawn with Cloud
    node('svc', 'service', 300, 0), node('svc2', 'service', 300, 100), node('svc3', 'service', 300, 200), node('svc4', 'service', 300, 300),
  ];
  const edges = [
    link('svc', 'ext-cloudflare', { kind: 'calls', status: 'live' }),
    link('svc2', 'ext-cloudflare', { kind: 'calls', when: 'deploy', status: 'live' }),
    link('svc3', 'ext-cloudflare', { kind: 'calls', when: 'renew', status: 'live' }),
    link('svc4', 'ext-cloudflare', { kind: 'calls', when: 'deploy', status: 'proposed' }),
    link('svc', 'ext-public-web', { kind: 'calls', status: 'live', when: 'run' }),
  ];
  const st = (layers         = {}) => mkState(nodes, edges, { activeLayers: { ...mkState([], []).activeLayers, ...layers } });

  it('has a Cloud layer and a Public web layer; a kind-less external goes with Cloud', () => {
    expect(ids(buildScene(st()))).toEqual(expect.arrayContaining(['ext-cloudflare', 'ext-public-web', 'ext-old']));
    expect(ids(buildScene(st({ web: false })))).not.toContain('ext-public-web');
    expect(ids(buildScene(st({ web: false })))).toContain('ext-cloudflare');
    const noCloud = ids(buildScene(st({ cloud: false })));
    expect(noCloud).toContain('ext-public-web');
    expect(noCloud).not.toContain('ext-cloudflare');
    expect(noCloud).not.toContain('ext-old');
  });

  it('draws a call solid when it bites now, dashed at the next deploy, dotted at the next renewal', () => {
    const scene = buildScene(st());
    expect(edge(scene, 'svc', 'ext-cloudflare').dash).toBeNull();
    expect(edge(scene, 'svc', 'ext-public-web').dash).toBeNull();
    const dashed = edge(scene, 'svc2', 'ext-cloudflare').dash;
    const dotted = edge(scene, 'svc3', 'ext-cloudflare').dash;
    expect(dashed).toHaveLength(2);
    expect(dotted).toHaveLength(2);
    expect(dotted[0]).toBeLessThan(dashed[0]);
    expect(edge(scene, 'svc4', 'ext-cloudflare').dash).toEqual([7, 5]); // proposed reads as proposed
  });
});

describe('which edge kinds are drawn', () => {
  const nodes = [
    node('app', 'app', 0, 0), node('page', 'page', 100, 0), node('page2', 'page', 100, 100), node('tbl', 'table', 200, 0),
    node('svc', 'service', 300, 0), node('ext', 'external', 400, 0), node('tok', 'token', 0, 100), node('stk', 'stack', 0, 200), node('atom', 'atom', 200, 200),
  ];
  const edges = [
    link('app', 'page'), // ownership
    link('page', 'atom', { dashed: true }), // usage
    link('tbl', 'page', { kind: 'reads', keys: ['x'] }),
    link('page', 'tbl', { kind: 'writes', label: 'goals.add' }),
    link('app', 'stk', { kind: 'runs-on' }),
    link('page', 'ext', { kind: 'calls', label: 'asks' }), // a page's own call: quiet
    link('svc', 'ext', { kind: 'calls' }),
    link('svc', 'tbl', { kind: 'triggers' }),
    link('ext', 'page2', { kind: 'delivers' }),
    link('page', 'tok', { kind: 'uses', vars: ['--a'] }),
    link('page2', 'atom', { kind: 'extends' }),
    link('app', 'svc', { kind: 'flow', flow: 'api', status: 'live', label: 'calls the API' }),
  ];
  const kinds = (scene     ) => scene.edges.map((e     ) => `${e.from}>${e.to}:${e.kind}`);
  const layers = (extra         = {}) => ({ ...mkState([], []).activeLayers, stack: true, ...extra });

  it('with nothing selected draws ownership, usage, reads, writes, runs-on, flow, service calls and triggers, and delivers; not a page\'s calls, uses or extends', () => {
    const scene = buildScene(mkState(nodes, edges, { activeLayers: layers() }));
    expect(kinds(scene)).toEqual([
      'app>page:ownership', 'page>atom:usage', 'tbl>page:reads', 'page>tbl:writes', 'app>stk:runs-on',
      'svc>ext:calls', 'svc>tbl:triggers', 'ext>page2:delivers', 'app>svc:flow',
    ]);
  });

  it('draws the selection\'s quiet edges (a page call, token use, inheritance) when it is selected', () => {
    const scene = buildScene(mkState(nodes, edges, { activeLayers: layers(), selectedNode: nodes[1] }));
    expect(kinds(scene)).toEqual(expect.arrayContaining(['page>ext:calls', 'page>tok:uses']));
    expect(kinds(scene)).not.toContain('page2>atom:extends'); // page2 is not in page's focus
    const other = buildScene(mkState(nodes, edges, { activeLayers: layers(), selectedNode: nodes[2] }));
    expect(kinds(other)).toContain('page2>atom:extends');
    expect(kinds(other)).not.toContain('page>ext:calls');
  });

  it('follows the layer switches: table, flow and infra', () => {
    expect(kinds(buildScene(mkState(nodes, edges, { activeLayers: layers({ table: false }) })))).not.toContain('tbl>page:reads');
    expect(kinds(buildScene(mkState(nodes, edges, { activeLayers: layers({ table: false }) })))).toContain('svc>ext:calls'); // the table nodes go with the layer, other edges stay
    expect(kinds(buildScene(mkState(nodes, edges, { activeLayers: layers({ flow: false }) })))).not.toContain('app>svc:flow');
    expect(kinds(buildScene(mkState(nodes, edges, { activeLayers: layers({ stack: false }) })))).not.toContain('app>stk:runs-on');
  });

  it('gives every drawn edge a unique key and mark none', () => {
    const scene = buildScene(mkState(nodes, [...edges, link('app', 'page', { kind: 'flow', flow: 'outbox', status: 'live' })], { activeLayers: layers() }));
    expect(new Set(scene.edges.map((e     ) => e.key)).size).toBe(scene.edges.length);
    expect(scene.edges.every((e     ) => e.mark === 'none')).toBe(true);
    expect(scene.nodes.every((n     ) => n.mark === 'none')).toBe(true);
  });
});

describe('ownership and usage edges', () => {
  const nodes = [node('a', 'app', 0, 0), node('b', 'page', 100, 0), node('c', 'page', 200, 0), node('d', 'page', 300, 0)];
  const edges = [link('a', 'b'), link('b', 'c', { dashed: true }), link('c', 'd')];

  it('are straight lines between the centres: solid and faint, usage dashed and indigo', () => {
    const scene = buildScene(mkState(nodes, edges));
    expect(edge(scene, 'a', 'b')).toMatchObject({ x1: 0, y1: 0, x2: 100, y2: 0, r1: 20, r2: 20, color: 'rgba(255, 255, 255, 0.16)', width: 1.4, dash: null, curve: null, arrow: false, glow: 0, packet: null, alpha: 1 });
    expect(edge(scene, 'b', 'c')).toMatchObject({ color: 'rgba(129, 140, 248, 0.35)', width: 1.2, dash: [4, 4], kind: 'usage' });
  });

  it('light up when they touch the selection, and fade out when they do not', () => {
    const scene = buildScene(mkState(nodes, edges, { selectedNode: nodes[0] }));
    expect(edge(scene, 'a', 'b')).toMatchObject({ color: '#ffffff', width: 2.4, glow: 10, glowColor: 'rgba(255, 255, 255, 0.8)', dash: null });
    expect(edge(scene, 'c', 'd')).toMatchObject({ color: 'rgba(255, 255, 255, 0.02)', width: 0.8, dash: null });
    const tail = buildScene(mkState(nodes, edges, { selectedNode: nodes[3] }));
    expect(edge(tail, 'b', 'c')).toMatchObject({ color: 'rgba(255, 255, 255, 0.02)', dash: [4, 4] }); // faint but still dashed
    const focus = buildScene(mkState(nodes, edges, { selectedNode: nodes[1] }));
    expect(edge(focus, 'b', 'c')).toMatchObject({ color: '#818cf8', width: 2.0, glow: 8, glowColor: 'rgba(129, 140, 248, 0.7)', dash: [5, 4] });
  });
});

describe('flow edges', () => {
  const nodes = [node('a', 'app', 0, 0), node('t', 'table', 200, 0, { r: 30 }), node('p', 'page', 100, 100)];
  const flow = link('a', 't', { kind: 'flow', flow: 'outbox', status: 'live', label: 'writes rows' });
  const proposed = link('t', 'a', { kind: 'flow', flow: 'sync', status: 'proposed', label: 'later' });
  const reads = link('t', 'p', { kind: 'reads', keys: ['k'], label: 'reads' });
  const writes = link('p', 't', { kind: 'writes', label: 'p.add' });

  it('curve to one side, trimmed to the node circles, with an arrowhead', () => {
    const e = edge(buildScene(mkState(nodes, [flow])), 'a', 't');
    // bowed by 18% of the length to the side of the line; trimmed to radius + 3 at the source and radius + 9 at the target
    expect(e.curve).toEqual({ cx: 100 + 0, cy: 0 + 200 * 0.18 });
    expect(e.arrow).toBe(true);
    expect(Math.hypot(e.x1 - 0, e.y1 - 0)).toBeCloseTo(23, 5);
    expect(Math.hypot(e.x2 - 200, e.y2 - 0)).toBeCloseTo(39, 5);
    expect(e.r1).toBe(20);
    expect(e.r2).toBe(30);
    expect(e).toMatchObject({ color: '#f59e0b', dash: null, kind: 'flow', alpha: 0.45, width: 1.6, glow: 0 });
    expect(ARROW.length).toBe(9);
  });

  it('draw a proposed flow dashed, and a pair of opposite flows on different sides', () => {
    const scene = buildScene(mkState(nodes, [flow, proposed]));
    expect(edge(scene, 't', 'a').dash).toEqual([7, 5]);
    expect(edge(scene, 'a', 't').curve .cy).toBeGreaterThan(0);
    expect(edge(scene, 't', 'a').curve .cy).toBeLessThan(0);
  });

  it('are quiet without a selection: no packet, no label; data edges fainter', () => {
    const scene = buildScene(mkState(nodes, [flow, reads, writes]));
    expect(scene.edges.every((e     ) => e.packet === null && e.label === null)).toBe(true);
    expect(edge(scene, 'a', 't').alpha).toBe(0.45);
    expect(edge(scene, 't', 'p').alpha).toBe(0.12);
    expect(edge(scene, 'p', 't').kind).toBe('writes');
  });

  it('carry a packet, a label and a glow when they are in the selection\'s focus, and fade out otherwise', () => {
    const extra = node('z', 'page', 0, 300);
    const other = link('z', 'p', { kind: 'flow', flow: 'api', status: 'live', label: 'unrelated' });
    const scene = buildScene(mkState([...nodes, extra], [flow, other], { selectedNode: nodes[0] }));
    const focus = edge(scene, 'a', 't');
    expect(focus).toMatchObject({ alpha: 1, width: 2.4, glow: 8, glowColor: '#f59e0b' });
    expect(focus.packet).toMatchObject({ color: '#ffffff', glowColor: '#f59e0b', radius: 3.5, glow: 10 });
    expect(focus.packet.speed).toBeCloseTo(1000 / 2600, 10);
    expect(focus.label).toMatchObject({ text: 'writes rows', color: '#f59e0b', italic: false });
    const mid = edgePoint(focus, 0.5);
    expect(focus.label.x).toBeCloseTo(mid.x, 10);
    expect(focus.label.y).toBeCloseTo(mid.y - 6, 10);
    const far = edge(scene, 'z', 'p');
    expect(far).toMatchObject({ alpha: 0.04, packet: null, label: null, glow: 0 });
  });

  it('label a table\'s data edges only for the page end that is selected', () => {
    const forPage = buildScene(mkState(nodes, [reads, writes], { selectedNode: nodes[2] }));
    expect(edge(forPage, 't', 'p').label).not.toBeNull();
    expect(edge(forPage, 'p', 't').label).not.toBeNull();
    const forTable = buildScene(mkState(nodes, [reads, writes], { selectedNode: nodes[1] }));
    expect(edge(forTable, 't', 'p').label).toBeNull(); // a table's edges converge: their page labels them
    expect(edge(forTable, 'p', 't').label).toBeNull();
  });

  it('describe no packet at all under reduced motion', () => {
    const s = mkState(nodes, [flow], { selectedNode: nodes[0] });
    expect(edge(buildScene(s), 'a', 't').packet).not.toBeNull();
    expect(edge(buildScene(s, { reduceMotion: true }), 'a', 't').packet).toBeNull();
  });

  it('give each packet a stable phase from its ids, so a rebuilt scene keeps the dot where it was', () => {
    const s = mkState(nodes, [flow], { selectedNode: nodes[0] });
    const a = edge(buildScene(s), 'a', 't').packet.phase;
    expect(a).toBe(((1 * 7 + 1 * 13) % 10) / 10);
    expect(edge(buildScene(s), 'a', 't').packet.phase).toBe(a);
  });

  it('move a packet along the edge as a function of time alone', () => {
    const s = mkState(nodes, [{ ...flow, phase: 0.25 }], { selectedNode: nodes[0] });
    const e = edge(buildScene(s), 'a', 't');
    const p0 = packetPoint(e, 0);
    expect(p0.x).toBeCloseTo(edgePoint(e, 0.25).x, 10);
    const period = 2600; // one trip takes 2.6 s
    expect(packetPoint(e, period).x).toBeCloseTo(p0.x, 6);
    expect(packetPoint(e, period / 4).x).toBeCloseTo(edgePoint(e, 0.5).x, 6);
    expect(edgePoint(e, 0)).toEqual({ x: e.x1, y: e.y1 });
    expect(edgePoint(e, 1).x).toBeCloseTo(e.x2, 10);
  });
});

describe('focus, dimming and halos', () => {
  const nodes = [node('root', 'root', 0, 0), node('app', 'app', 100, 0), node('kid', 'page', 200, 0), node('far', 'page', 300, 300), node('tool', 'tool', 400, 400)];
  const edges = [link('root', 'app'), link('app', 'kid'), link('root', 'far')];

  it('with no selection nothing is dimmed, nothing has a halo, every node is connected', () => {
    const scene = buildScene(mkState(nodes, edges));
    for (const n of scene.nodes) expect(n).toMatchObject({ alpha: 1, labelAlpha: 1, halo: 'none', connected: true, selected: false, match: false });
  });

  it('glows 15 for root and app nodes and 9 for the rest', () => {
    const scene = buildScene(mkState(nodes, edges));
    expect(byId(scene, 'root').glow).toBe(15);
    expect(byId(scene, 'app').glow).toBe(15);
    expect(byId(scene, 'kid').glow).toBe(9);
  });

  it('marks the selection, its children and its parent, and dims the rest to 0.07 without glow', () => {
    const scene = buildScene(mkState(nodes, edges, { selectedNode: nodes[1] }));
    expect(byId(scene, 'app')).toMatchObject({ halo: 'selected', selected: true, alpha: 1 });
    expect(byId(scene, 'kid')).toMatchObject({ halo: 'child', alpha: 1, connected: true });
    expect(byId(scene, 'root')).toMatchObject({ halo: 'none', alpha: 1, connected: true }); // the parent
    expect(byId(scene, 'far')).toMatchObject({ alpha: DIM_ALPHA, labelAlpha: DIM_ALPHA, glow: 0, connected: false, labelColor: 'rgba(255, 255, 255, 0.3)' });
    expect(byId(scene, 'tool')).toMatchObject({ alpha: 0.07, glow: 0 });
    expect(byId(scene, 'kid').labelColor).toBe('#f8fafc');
  });

  it('getActiveSubgraph walks children, parent and everything touching them', () => {
    const g = getActiveSubgraph(nodes[1], edges);
    expect([...g.connectedNodeIds].sort()).toEqual(['app', 'kid', 'root']);
    expect([...g.childIds]).toEqual(['kid']);
    expect([...g.connectedEdgeKeys].sort()).toEqual(['app->kid', 'root->app']);
    expect(g.selectedId).toBe('app');
    expect(getActiveSubgraph(null, edges)).toBeNull();
  });

  it('puts a halo on a search match, case-insensitively, and the match look wins over the selection', () => {
    const scene = buildScene(mkState(nodes, edges, { searchQuery: 'KI' }));
    expect(byId(scene, 'kid')).toMatchObject({ halo: 'match', match: true });
    expect(byId(scene, 'app').match).toBe(false);
    const both = buildScene(mkState(nodes, edges, { searchQuery: 'app', selectedNode: nodes[1] }));
    expect(byId(both, 'app')).toMatchObject({ halo: 'match', match: true, selected: true });
    expect(buildScene(mkState(nodes, edges, { searchQuery: '' })).nodes.some((n     ) => n.match)).toBe(false);
  });

  it('has one look per halo kind', () => {
    expect(Object.keys(HALO).sort()).toEqual(['child', 'match', 'selected']);
    expect(HALO.match.ring).toBe('#f59e0b');
    expect(HALO.selected.ring).toBe('#818cf8');
    expect(CORE_RATIO).toBe(0.32);
  });
});

describe('label level of detail', () => {
  const nodes = [node('root', 'root'), node('app', 'app'), node('page', 'page', 50, 0), node('hit', 'page', 90, 0, { label: 'zebra' }), node('kid', 'page', 120, 0), node('tbl', 'table'), node('far', 'page')];
  const edges = [link('app', 'kid')];
  const scene = buildScene(mkState(nodes, edges, { searchQuery: 'zeb' }));
  const shown = (s     , zoom        ) => s.nodes.map((n     ) => labelAt(n, zoom, s)).map((l     , i        ) => (l ? s.nodes[i].id : null)).filter(Boolean);

  it('says in the scene which nodes keep a label when zoomed out: landmarks and matches', () => {
    expect(scene.nodes.filter((n     ) => n.labelKeep).map((n     ) => n.id)).toEqual(['root', 'app', 'hit']);
  });

  it('labels everything at zoom 0.6 and above', () => {
    expect(LABEL_ZOOM).toBe(0.6);
    expect(shown(scene, 0.6)).toEqual(scene.nodes.map((n     ) => n.id));
    expect(shown(scene, 1)).toHaveLength(scene.nodes.length);
  });

  it('labels only landmarks and matches below 0.6', () => {
    expect(shown(scene, 0.59)).toEqual(['root', 'app', 'hit']);
  });

  it('also keeps the selection and what is connected to it', () => {
    const focus = buildScene(mkState(nodes, edges, { selectedNode: nodes[1] }));
    expect(shown(focus, 0.3).sort()).toEqual(['app', 'kid', 'root'].sort());
    const picked = buildScene(mkState(nodes, edges, { selectedNode: nodes[2] }));
    expect(shown(picked, 0.3)).toContain('page');
  });

  it('draws a label below the circle at the base size, 12 for root and app, 11 for the rest, bold for those two', () => {
    const l = labelAt(byId(scene, 'app'), 1, scene);
    expect(l).toMatchObject({ text: 'app', x: 0, size: 12, bold: true, color: '#f8fafc', alpha: 1 });
    expect(l.y).toBe(0 + 20 + 12 + 3);
    expect(labelAt(byId(scene, 'page'), 1, scene)).toMatchObject({ size: 11, bold: false });
  });

  it('draws it larger when zoomed out, up to 2.2 times, so it stays readable', () => {
    expect(labelAt(byId(scene, 'app'), 0.5, scene).size).toBe(Math.round(12 * 1.5)); // 0.75 / 0.5
    expect(labelAt(byId(scene, 'app'), 0.3, scene).size).toBe(Math.round(12 * 2.2)); // capped
    expect(labelAt(byId(scene, 'app'), 0.3, scene).y).toBe(20 + 26 + 3);
    expect(labelAt(byId(scene, 'app'), 0.59, scene).size).toBe(Math.round(12 * (0.75 / 0.59)));
  });

  it('labels every node in the data-flow view, a little larger when zoomed out', () => {
    const flowNodes = [node('browser', 'store', 0, 0), node('api', 'app', 100, 0), node('t', 'table', 200, 0)];
    const flow = { ids: new Set(flowNodes.map((n) => n.id)), edges: [], headers: [], top: -100, tiers: [] };
    const preset = buildScene(mkState(flowNodes, [], { view: 'dataflow', flow }));
    expect(preset.preset).toBe(true);
    for (const zoom of [0.2, 0.4, 0.6, 1]) expect(shown(preset, zoom)).toHaveLength(3);
    expect(labelAt(byId(preset, 't'), 1, preset).size).toBe(11);
    expect(labelAt(byId(preset, 't'), 0.8, preset).size).toBe(11);
    expect(labelAt(byId(preset, 't'), 0.5, preset).size).toBe(Math.round(11 * 1.6)); // 0.8 / 0.5
    expect(labelAt(byId(preset, 't'), 0.3, preset).size).toBe(Math.round(11 * 1.8)); // capped
  });
});

describe('orbital rings and the grid', () => {
  const rings = { rings: [{ x: 0, y: 0, r: 100 }, { x: 0, y: 0, r: 200 }], clusters: [{ x: 50, y: 50, radii: [30, 60] }] };
  const nodes = [node('a', 'app')];

  it('describes the rings dashed and faint, the cluster rings fainter still', () => {
    const { decor } = buildScene(mkState(nodes, [], { rings }));
    expect(decor.rings).toHaveLength(4);
    expect(decor.rings[0]).toEqual({ x: 0, y: 0, r: 100, color: 'rgba(66, 153, 225, 0.14)', width: 1, dash: [4, 6] });
    expect(decor.rings[2]).toEqual({ x: 50, y: 50, r: 30, color: 'rgba(66, 153, 225, 0.08)', width: 1, dash: [4, 6] });
    expect(decor.lanes).toEqual([]);
  });

  it('dims the rings while something is selected', () => {
    const { decor } = buildScene(mkState(nodes, [], { rings, selectedNode: nodes[0] }));
    expect(decor.rings[0].color).toBe('rgba(66, 153, 225, 0.04)');
    expect(decor.rings[3].color).toBe('rgba(66, 153, 225, 0.03)');
  });

  it('draws no rings in freeform mode', () => {
    expect(buildScene(mkState(nodes, [], { rings, isFreeform: true })).decor.rings).toEqual([]);
  });

  it('always carries the grid, every 48 units, over the viewport plus 200', () => {
    expect(buildScene(mkState(nodes, [])).decor.grid).toEqual({ size: 48, color: 'rgba(255, 255, 255, 0.035)', width: 0.5, margin: 200 });
  });
});

describe('the data-flow preset', () => {
  const nodes = [node('store-idb', 'store', -200, 0), node('app-api', 'app', 0, 0), node('tbl', 'table', 200, 0), node('hidden', 'page', 500, 0), node('app-x', 'app', 0, 80)];
  const flow = {
    ids: new Set(['store-idb', 'app-api', 'tbl']),
    edges: [
      link('store-idb', 'app-api', { kind: 'flow', flow: 'outbox', status: 'live', label: 'outbox' }),
      link('app-api', 'tbl', { kind: 'writes', label: 'rows' }),
      link('tbl', 'app-api', { kind: 'reads', keys: [] }),
    ],
    headers: [
      { title: 'Browser', note: 'saved on the device first', x: -200, left: -230, right: -170, rows: 1 },
      { title: 'API', note: 'the one writer', x: 0, left: -30, right: 30, rows: 1 },
      { title: 'Tables', note: 'rows', x: 200, left: 170, right: 230, rows: 1 },
    ],
    top: -100,
  };
  const scene = buildScene(mkState(nodes, [link('app-x', 'hidden')], { view: 'dataflow', flow, rings: { rings: [{ x: 0, y: 0, r: 50 }], clusters: [] } }));

  it('draws only the nodes of the preset, ignoring the layer switches', () => {
    expect(ids(scene)).toEqual(['store-idb', 'app-api', 'tbl']);
    const off = buildScene(mkState(nodes, [], { view: 'dataflow', flow, activeLayers: Object.fromEntries(Object.keys(mkState([], []).activeLayers).map((k) => [k, false])) }));
    expect(ids(off)).toEqual(['store-idb', 'app-api', 'tbl']);
  });

  it('draws the preset\'s own edges (not the topology\'s), all curved with an arrowhead and a packet, bright', () => {
    expect(scene.edges.map((e     ) => `${e.from}>${e.to}`)).toEqual(['store-idb>app-api', 'app-api>tbl', 'tbl>app-api']);
    for (const e of scene.edges) expect(e).toMatchObject({ arrow: true, alpha: expect.any(Number) });
    expect(scene.edges.every((e     ) => e.packet && e.curve)).toBe(true);
    expect(edge(scene, 'store-idb', 'app-api')).toMatchObject({ alpha: 0.65, width: 2 });
    expect(edge(scene, 'app-api', 'tbl')).toMatchObject({ alpha: 0.2, width: 1.6 }); // data edges: fainter and thinner
    expect(scene.edges.every((e     ) => e.label === null)).toBe(true); // labels only for the selection
  });

  it('describes a titled band per tier with an arrow between them, and draws no rings', () => {
    expect(scene.decor.rings).toEqual([]);
    expect(scene.decor.lanes).toHaveLength(3);
    const [first, , last] = scene.decor.lanes;
    expect(first).toMatchObject({ x: -242, y: -70, w: 84, radius: 14, fill: 'rgba(66, 153, 225, 0.05)', stroke: 'rgba(66, 153, 225, 0.18)', strokeWidth: 1 });
    expect(first.h).toBe(210); // from top + 30 = -70 down to the mirrored bottom, 140
    expect(first.title).toEqual({ text: 'Browser', x: -200, y: -96, size: 15, bold: true, color: '#e2e8f0' });
    expect(first.note).toEqual({ text: 'saved on the device first', x: -200, y: -78, size: 11, bold: false, color: '#94a3b8' });
    expect(first.arrow).toEqual({ text: '→', x: -100, y: -92, size: 18, bold: true, color: 'rgba(148, 163, 184, 0.5)' });
    expect(last.arrow).toBeNull();
  });

  it('puts the band between flow.top + 30 and the mirrored bottom', () => {
    const lane = scene.decor.lanes[0];
    expect(lane.y).toBe(flow.top + 30);
    expect(lane.y + lane.h).toBe(-flow.top + 40);
  });

  it('puts a packet on every edge, and a label on the selection\'s', () => {
    const picked = buildScene(mkState(nodes, [], { view: 'dataflow', flow, selectedNode: nodes[0] }));
    expect(edge(picked, 'store-idb', 'app-api').label).toMatchObject({ text: 'outbox' });
    expect(edge(picked, 'store-idb', 'app-api').packet).not.toBeNull();
    expect(edge(picked, 'tbl', 'app-api').packet).toBeNull(); // not in the focus
  });

  it('falls back to the orbital view\'s rings while the preset has not been built', () => {
    const noFlow = buildScene(mkState(nodes, [], { view: 'dataflow', flow: null, rings: { rings: [{ x: 0, y: 0, r: 50 }], clusters: [] } }));
    expect(noFlow.nodes).toEqual([]);
    expect(noFlow.decor.rings).toHaveLength(1);
  });
});

describe('the ROM simulation (a scenario that links the nodes it visits; see scenario-scene.test.ts for the rest)', () => {
  const nodes = [node('tbl', 'table', 0, 0), node('rom', 'rom', 100, 0), node('page', 'page', 200, 0), node('other', 'page', 300, 0)];
  const edges = [link('tbl', 'rom', { kind: 'flow', flow: 'rom', status: 'live', label: 'dep' }), link('rom', 'page', { kind: 'flow', flow: 'rom', status: 'live' }), link('page', 'other')];
  const walk = (path          , done = false) => {
    const p = createPlayer({ id: 'rom', title: 'ROM', linkNodes: true, steps: path.map((id) => ({ node: id, text: id })) }, { stepMs: 420 });
    p.goTo(path.length - 1);
    if (done) p.next();
    return p.snapshot();
  };

  it('lights up what the walk has reached and dims the rest', () => {
    const scene = buildScene(mkState(nodes, edges, { scenario: walk(['tbl', 'rom'], true), selectedNode: nodes[3] }));
    expect(scene.nodes.filter((n     ) => n.connected).map((n     ) => n.id)).toEqual(['tbl', 'rom']);
    expect(byId(scene, 'page')).toMatchObject({ alpha: DIM_ALPHA, glow: 0 });
    expect(byId(scene, 'rom')).toMatchObject({ alpha: 1, halo: 'none' }); // no selection halo: the walk wins over the selection
    const lit = edge(scene, 'tbl', 'rom');
    expect(lit).toMatchObject({ alpha: 1, glow: 8 });
    expect(lit.packet).not.toBeNull();
    expect(lit.label).toMatchObject({ text: 'dep' });
    expect(edge(scene, 'rom', 'page')).toMatchObject({ alpha: 0.04, packet: null });
  });

  it('grows as the walk does, and never mutates the walk', () => {
    const before = buildScene(mkState(nodes, edges, { scenario: walk(['tbl']) }));
    const snapshot = walk(['tbl', 'rom', 'page']);
    const after = buildScene(mkState(nodes, edges, { scenario: snapshot }));
    expect(before.nodes.filter((n     ) => n.connected)).toHaveLength(1);
    expect(after.nodes.filter((n     ) => n.connected)).toHaveLength(3);
    expect([...snapshot.visited.nodes]).toEqual(['tbl', 'rom', 'page']);
  });
});

describe('purity', () => {
  const deepFreeze = (o     )      => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  const nodes = [node('app', 'app', 0, 0), node('p', 'page', 100, 0), node('t', 'table', 200, 0)];
  const edges = [link('app', 'p'), link('p', 't', { kind: 'writes', label: 'x' }), link('app', 't', { kind: 'flow', flow: 'api', status: 'live', label: 'f' })];

  it('does not write to the state (a frozen state builds the same scene)', () => {
    const live = mkState(structuredClone(nodes), structuredClone(edges), { selectedNode: nodes[0], searchQuery: 'p' });
    const frozen = deepFreeze(structuredClone(live));
    expect(buildScene(frozen)).toEqual(buildScene(live));
  });

  it('does not depend on the camera or the size of the viewport', () => {
    const base = mkState(nodes, edges, { selectedNode: nodes[1] });
    const moved = { ...base, camera: { x: -900, y: 420, zoom: 0.27 }, width: 123, height: 45 };
    expect(buildScene(moved)).toEqual(buildScene(base));
  });

  it('does not write the phase back onto the edges (the old drawing code did)', () => {
    const e = structuredClone(edges);
    buildScene(mkState(nodes, e, { selectedNode: nodes[0] }));
    expect(e.every((x     ) => x.phase === undefined)).toBe(true);
  });

  it('returns plain data a worker or a test can clone', () => {
    const scene = buildScene(mkState(nodes, edges, { selectedNode: nodes[0] }));
    expect(structuredClone(scene)).toEqual(scene);
    expect(JSON.parse(JSON.stringify(scene)).nodes).toHaveLength(scene.nodes.length);
  });
});

describe('the scene cache', () => {
  it('builds once per scene version: a camera change or a packet frame never rebuilds', () => {
    const s = mkState([node('a', 'app')], []);
    const cache = createSceneCache();
    const first = cache.get(s);
    expect(cache.builds).toBe(1);
    for (let frame = 0; frame < 50; frame++) {
      s.camera.x += 3; s.camera.zoom *= 1.01; // pan and zoom
      expect(cache.get(s)).toBe(first);
    }
    expect(cache.builds).toBe(1);
    s.sceneVersion++;
    const second = cache.get(s);
    expect(second).not.toBe(first);
    expect(cache.builds).toBe(2);
    expect(second.version).toBe(s.sceneVersion);
  });

  it('builds with the builder it was given', () => {
    const cache = createSceneCache(() => ({ marker: 1 }       ));
    expect(cache.get(mkState([], []))).toEqual({ marker: 1 });
  });
});

describe('parseColor', () => {
  it('reads hex and rgb()/rgba() into [r, g, b, a]', () => {
    expect(parseColor('#818cf8')).toEqual([129, 140, 248, 1]);
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColor('rgba(66, 153, 225, 0.14)')).toEqual([66, 153, 225, 0.14]);
    expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3, 1]);
    expect(parseColor('nonsense')).toEqual([0, 0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
//  A real map (the sample repo), both views
// ---------------------------------------------------------------------------
describe('on a real map', () => {
  const topology = loadSample();
  const saved = { ctx: sharedState.ctx, nodes: sharedState.nodes, edges: sharedState.edges, view: sharedState.view, flow: sharedState.flow };
  // layout.js measures labels on a canvas; a fixed width per character is enough here
  sharedState.ctx = { save() {}, restore() {}, font: '', measureText: (s        ) => ({ width: s.length * 6 }) };
  sharedState.nodes = structuredClone(topology.nodes);
  sharedState.edges = structuredClone(topology.edges);
  computeDegreeCentrality();
  computeOrbitalLayout();
  sharedState.flow = buildDataFlow(sharedState.nodes, sharedState.edges);

  afterAll(() => Object.assign(sharedState, saved));

  const finite = (scene     ) => {
    for (const n of scene.nodes) expect([n.x, n.y, n.r].every(Number.isFinite), n.id).toBe(true);
    for (const e of scene.edges) expect([e.x1, e.y1, e.x2, e.y2].every(Number.isFinite), e.key).toBe(true);
    expect(new Set(scene.edges.map((e     ) => e.key)).size).toBe(scene.edges.length);
  };

  it('builds the orbit scene: no NaN, unique edge keys, a ring or more', () => {
    sharedState.view = 'orbit';
    const scene = buildScene(sharedState);
    expect(scene.nodes.length).toBeGreaterThan(30);
    expect(scene.edges.length).toBeGreaterThan(40);
    finite(scene);
    expect(scene.decor.rings.length).toBeGreaterThan(0);
  });

  it('builds the data-flow scene: the six lanes, a packet on every edge', () => {
    computeLaneLayout(sharedState.flow);
    sharedState.view = 'dataflow';
    const scene = buildScene(sharedState);
    expect(scene.decor.lanes).toHaveLength(6);
    expect(scene.nodes).toHaveLength(sharedState.flow.ids.size);
    expect(scene.edges.length).toBe(sharedState.flow.edges.length);
    expect(scene.edges.every((e     ) => e.packet)).toBe(true);
    finite(scene);
  });

  it('builds a focused scene for every kind of node without throwing', () => {
    sharedState.view = 'orbit';
    const types = new Set        ();
    for (const n of sharedState.nodes) {
      if (types.has(n.type)) continue;
      types.add(n.type);
      const scene = buildScene({ ...sharedState, selectedNode: n });
      expect(byId(scene, n.id)?.halo ?? 'selected').toBe('selected');
      finite(scene);
    }
    expect(types.size).toBeGreaterThan(8);
  });
});

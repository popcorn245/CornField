/**
 * @vitest-environment node
 *
 * The synthetic topology the explorer is measured on (TOPO-01, spec 0012 A6): the same
 * seed gives the same map, the counts are exact, and every node and edge is valid by the same
 * checks `topology.js validate` makes on the real map.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateTopology, parseFixtureQuery, FIXTURE_LIMITS, TYPE_MIX } from '../../core/fixture.js';
import { NODE_THEMES } from '../../core/schema.js';
import { validateTopology } from '../../core/validate.js';
import { computeDegreeCentrality, computeOrbitalLayout } from '../../explorer/layout.js';
import { state } from '../../explorer/state.js';

// The mix the generator scales: a real map's share of node types (one root and the TYPE_MIX)
const real = { nodes: [{ type: 'root' }, ...Object.entries(TYPE_MIX).flatMap(([type, n]) => Array.from({ length: n }, () => ({ type })))] };

const kindOf = (e     ) => (e.kind === 'flow' ? `flow:${e.flow}` : e.kind || (e.dashed ? 'dashed' : 'own'));
const tally = (items       , f                    ) => {
  const out                         = {};
  for (const x of items) out[f(x)] = (out[f(x)] || 0) + 1;
  return out;
};

describe('generateTopology', () => {
  it('has the topology.json shape, 5,000 nodes and 15,000 edges by default', () => {
    const t = generateTopology();
    expect(Object.keys(t)).toEqual(['version', 'updatedAt', 'nodes', 'edges']);
    expect(t.nodes).toHaveLength(5000);
    expect(t.edges).toHaveLength(15000);
    expect(typeof t.version).toBe('string');
    expect(Number.isNaN(Date.parse(t.updatedAt))).toBe(false);
  });

  it('gives the same output for the same seed and a different one for another', () => {
    const a = JSON.stringify(generateTopology({ nodes: 800, edges: 2400, seed: 7 }));
    expect(JSON.stringify(generateTopology({ nodes: 800, edges: 2400, seed: 7 }))).toBe(a);
    expect(JSON.stringify(generateTopology({ nodes: 800, edges: 2400, seed: 8 }))).not.toBe(a);
    // the defaults are seed 1
    expect(JSON.stringify(generateTopology({ nodes: 800, edges: 2400 }))).toBe(JSON.stringify(generateTopology({ nodes: 800, edges: 2400, seed: 1 })));
  });

  it('never touches Math.random', () => {
    const real = Math.random;
    Math.random = () => { throw new Error('Math.random called'); };
    try {
      expect(generateTopology({ nodes: 300, edges: 900 }).nodes).toHaveLength(300);
    } finally {
      Math.random = real;
    }
  });

  it('is exact for other sizes, down to the smallest and up to a dense map', () => {
    for (const [nodes, edges] of [[FIXTURE_LIMITS.minNodes, FIXTURE_LIMITS.minNodes * 3], [1000, 1000], [1000, 9000], [12345, 40000]]) {
      const t = generateTopology({ nodes, edges, seed: 3 });
      expect([nodes, t.nodes.length, t.edges.length]).toEqual([nodes, nodes, edges]);
    }
  });

  it('is valid by the checks topology.js validate makes (types, colours, radii, edge kinds and ends)', () => {
    const t = generateTopology({ nodes: 5000, edges: 15000, seed: 1 });
    expect(validateTopology(t).filter((e        ) => !e.startsWith('[OpenCollection]'))).toEqual([]);
    for (const n of t.nodes) {
      expect(NODE_THEMES[n.type], n.id).toBeTruthy();
      expect(n.color, n.id).toBe(NODE_THEMES[n.type].color);
      expect(n.r, n.id).toBe(NODE_THEMES[n.type].r);
    }
  });

  it('has unique node ids, no edge to a missing node, no self edge and no duplicate edge', () => {
    const t = generateTopology({ nodes: 5000, edges: 15000, seed: 1 });
    const ids = new Set        (t.nodes.map((n     ) => n.id));
    expect(ids.size).toBe(t.nodes.length);
    const seen = new Set        ();
    for (const e of t.edges) {
      expect(ids.has(e.from) && ids.has(e.to), `${e.from} -> ${e.to}`).toBe(true);
      expect(e.from).not.toBe(e.to);
      const key = `${e.from}|${e.to}|${kindOf(e)}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it('keeps the real map\'s mix of node types and edge kinds', () => {
    const t = generateTopology({ nodes: 5000, edges: 15000, seed: 1 });
    const types = tally(t.nodes, (n) => n.type);
    const realTypes = tally(real.nodes, (n) => n.type);
    expect(types.root).toBe(1);
    for (const [type, count] of Object.entries(realTypes)                      ) {
      if (type === 'root') continue;
      const want = (count / real.nodes.length) * 5000;
      // every type is there, and in about the real share (pages dominate). A rare type (a few dozen in 5000)
      // may drift by a handful of nodes as the real map moves under the snapshot the generator holds.
      expect(types[type], type).toBeGreaterThan(0);
      const off = Math.abs(types[type] - want);
      expect(want >= 100 ? off / want < 0.15 : off <= 25, `${type} ${types[type]} vs ${want.toFixed(0)}`).toBe(true);
    }
    const kinds = tally(t.edges, kindOf);
    for (const k of ['own', 'dashed', 'reads', 'writes', 'uses', 'extends', 'triggers', 'calls', 'delivers', 'runs-on']) {
      expect(kinds[k], k).toBeGreaterThan(0);
    }
    expect(Object.keys(kinds).filter((k) => k.startsWith('flow:')).length).toBeGreaterThanOrEqual(5);
    // data edges are the bulk of the map, as in the real one (reads + writes ~ 39 %)
    expect((kinds.reads + kinds.writes) / 15000).toBeGreaterThan(0.25);
  });

  it('has an ownership tree: every node but root and the hubs the real map also leaves free has one parent, all reaching root', () => {
    const t = generateTopology({ nodes: 5000, edges: 15000, seed: 1 });
    const parent = new Map                ();
    for (const e of t.edges) {
      if (e.kind || e.dashed) continue;
      expect(parent.has(e.to), `two parents for ${e.to}`).toBe(false);
      parent.set(e.to, e.from);
    }
    const byId = new Map             (t.nodes.map((n     ) => [n.id, n]));
    const type = (id        ) => byId.get(id).type;
    for (const n of t.nodes) {
      if (n.type === 'page') expect(type(parent.get(n.id) ), n.id).toBe('app');
      if (n.type === 'atom' || n.type === 'core' || n.type === 'token') expect(type(parent.get(n.id) ), n.id).toBe('pkg');
      if (n.type === 'table') expect(type(parent.get(n.id) ), n.id).toBe('store');
      if (n.type === 'app' || n.type === 'pkg' || n.type === 'stack') expect(parent.get(n.id), n.id).toBe('root');
    }
    // the nodes without a parent are the free hubs the real map also has: stores with tables, outside systems, ROM stages
    const free = (n     ) => n.id !== 'root' && !parent.has(n.id);
    expect([...new Set(t.nodes.filter(free).map((n     ) => n.type))].sort()).toEqual(['external', 'rom', 'store']);
    // and every other node reaches root (or a free hub) within a few hops, so there is no ownership cycle
    for (const n of t.nodes) {
      let id = n.id;
      let hops = 0;
      while (parent.has(id)) { id = parent.get(id) ; expect(hops++, n.id).toBeLessThan(6); }
      expect(id === 'root' || free(byId.get(id)), n.id).toBe(true);
    }
  });

  it('has the labels the explorer expects: pages start with a slash, tables name their SQL table', () => {
    const t = generateTopology({ nodes: 1500, edges: 4500, seed: 2 });
    for (const n of t.nodes) {
      expect(typeof n.label).toBe('string');
      expect(n.label.length).toBeGreaterThan(0);
      if (n.type === 'page') expect(n.label.startsWith('/')).toBe(true);
      if (n.type === 'table') expect(n.table).toBeTruthy();
    }
  });

  it('lets the orbit layout place every node of the 5k map without NaN, and fast', () => {
    const t = generateTopology({ nodes: 5000, edges: 15000, seed: 1 });
    // layout.js measures labels on a canvas; a fixed width per character is enough here
    state.ctx = { save() {}, restore() {}, font: '', measureText: (s        ) => ({ width: s.length * 6 }) }       ;
    state.nodes = t.nodes;
    state.edges = t.edges;
    const t0 = performance.now();
    computeDegreeCentrality();
    computeOrbitalLayout();
    const ms = performance.now() - t0;
    for (const n of state.nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y), n.id).toBe(true);
    // a loose bound: the layout is O(hubs x nodes); this only catches a blow-up
    expect(ms).toBeLessThan(5000);
  });

  it('generates the 5k map in under 500 ms (typically ~30 ms) and the 50k limit in under 5 s', () => {
    generateTopology({ nodes: 500, edges: 1500 }); // warm the JIT
    const t0 = performance.now();
    generateTopology({ nodes: 5000, edges: 15000, seed: 1 });
    const small = performance.now() - t0;
    expect(small).toBeLessThan(500);
    const t1 = performance.now();
    generateTopology({ nodes: FIXTURE_LIMITS.maxNodes, edges: FIXTURE_LIMITS.maxNodes * 3, seed: 1 });
    expect(performance.now() - t1).toBeLessThan(5000);
  });

  it('refuses sizes outside its limits', () => {
    expect(() => generateTopology({ nodes: FIXTURE_LIMITS.minNodes - 1, edges: 1000 })).toThrow(RangeError);
    expect(() => generateTopology({ nodes: FIXTURE_LIMITS.maxNodes + 1, edges: 1000 })).toThrow(RangeError);
    expect(() => generateTopology({ nodes: 1000, edges: 999 })).toThrow(RangeError); // fewer edges than the ownership tree needs
    expect(() => generateTopology({ nodes: 1000, edges: 1000 * FIXTURE_LIMITS.maxEdgesPerNode + 1 })).toThrow(RangeError);
    expect(() => generateTopology({ nodes: 1000.5, edges: 3000 })).toThrow(RangeError);
    expect(() => generateTopology({ nodes: 1000, edges: 3000, seed: Number.NaN })).toThrow(RangeError);
  });
});

describe('parseFixtureQuery', () => {
  const q = (s        ) => parseFixtureQuery(new URLSearchParams(s));

  it('defaults to 5,000 nodes, 15,000 edges, seed 1', () => {
    expect(q('')).toEqual({ nodes: 5000, edges: 15000, seed: 1 });
  });

  it('reads nodes, edges and seed; edges default to three per node', () => {
    expect(q('nodes=2000&edges=7000&seed=9')).toEqual({ nodes: 2000, edges: 7000, seed: 9 });
    expect(q('nodes=2000')).toEqual({ nodes: 2000, edges: 6000, seed: 1 });
  });

  it('throws a RangeError naming the problem for anything out of range or not a whole number', () => {
    for (const bad of ['nodes=abc', 'nodes=10', 'nodes=50001', 'nodes=1.5', 'nodes=-4', 'nodes=2000&edges=100', 'nodes=2000&edges=999999', 'seed=x', 'nodes=']) {
      expect(() => q(bad), bad).toThrow(RangeError);
    }
  });
});

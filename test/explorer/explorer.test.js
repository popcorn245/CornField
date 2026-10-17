/**
 * @vitest-environment node
 *
 * The data-flow preset (MAP-07): the topology folded into browser -> app servers -> API ->
 * tables -> services -> outside, and the lane layout that places it. Runs on a real map, the sample
 * repo's topology.json.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { buildDataFlow } from '../../explorer/flows.js';
// @ts-expect-error plain JS modules, no declarations
import { computeLaneLayout, computeOrbitalLayout, computeDegreeCentrality } from '../../explorer/layout.js';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';

import { loadSample } from '../helpers.js';

const topology = loadSample();

// layout.js measures labels on a canvas; a fixed width per character is enough here
state.ctx = { save() {}, restore() {}, font: '', measureText: (s        ) => ({ width: s.length * 6 }) };

describe('data-flow preset', () => {
  let flow     ;
  beforeAll(() => { flow = buildDataFlow(topology.nodes, topology.edges); });

  it('has the six tiers in order, each with nodes', () => {
    expect(flow.tiers.map((t     ) => t.key)).toEqual(['browser', 'servers', 'api', 'tables', 'services', 'outside']);
    for (const tier of flow.tiers) expect(tier.nodes.length, tier.key).toBeGreaterThan(0);
  });

  it('puts the device store, the API, every table and every service on the map', () => {
    const ids = flow.ids               ;
    expect(ids.has('store-idb')).toBe(true);
    expect(ids.has('app-api')).toBe(true);
    for (const n of topology.nodes.filter((x     ) => x.type === 'table' || x.type === 'service' || x.type === 'external')) expect(ids.has(n.id), n.id).toBe(true);
  });

  it('keeps only edges between nodes of the preset, lifts endpoints to the API and draws each once', () => {
    const ids = flow.ids               ;
    const seen = new Set        ();
    for (const e of flow.edges) {
      expect(ids.has(e.from) && ids.has(e.to), `${e.from} -> ${e.to}`).toBe(true);
      expect(e.from).not.toBe(e.to);
      const key = `${e.from}|${e.to}|${e.kind}|${e.flow || ''}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
    expect(flow.edges.some((e     ) => e.kind === 'writes' && e.from === 'app-api')).toBe(true);
    expect(flow.edges.some((e     ) => e.kind === 'reads' && e.to === 'app-api')).toBe(true);
    expect(flow.edges.some((e     ) => e.kind === 'calls' && e.to.startsWith('ext-'))).toBe(true);
    expect(flow.edges.some((e     ) => e.kind === 'flow' && e.flow === 'outbox' && e.from === 'store-idb')).toBe(true);
  });

  it('shows the self-hosted services as their containers in Outside, called and calling back', () => {
    const outside = flow.tiers.find((t     ) => t.key === 'outside').nodes.map((n     ) => n.id);
    const four = ['container-nextcloud', 'container-homeassistant'];
    for (const id of four) expect(outside, id).toContain(id);
    const has = (from        , to        , kind        , label         ) => flow.edges.some((e     ) => e.from === from && e.to === to && e.kind === kind && (!label || e.label === label));
    expect(has('app-api', 'container-nextcloud', 'calls', 'files the receipt')).toBe(true);
    expect(has('svc-job-digest', 'container-homeassistant', 'calls', 'says it on the speakers')).toBe(true);
    // its webhook reaches the API (the endpoint is lifted to its app)
    expect(has('container-nextcloud', 'app-api', 'delivers', 'a file changed')).toBe(true);
    // What a container pulls or calls itself is not drawn here
    expect(flow.edges.some((e     ) => e.kind === 'calls' && e.from.startsWith('container-'))).toBe(false);
  });

  it('lays the tiers out left to right with every node placed and no two on the same spot', () => {
    computeLaneLayout(flow);
    const firstX = flow.tiers.map((t     ) => Math.min(...t.nodes.map((n     ) => n.x)));
    expect([...firstX].sort((a, b) => a - b)).toEqual(firstX);
    const spots = new Set        ();
    for (const n of flow.tiers.flatMap((t     ) => t.nodes)) {
      expect(Number.isFinite(n.x) && Number.isFinite(n.y), n.id).toBe(true);
      const spot = `${Math.round(n.x)},${Math.round(n.y)}`;
      expect(spots.has(spot), spot).toBe(false);
      spots.add(spot);
    }
    expect(flow.headers).toHaveLength(6);
  });
});

describe('orbital layout', () => {
  it('places every node of the topology without NaN', () => {
    state.nodes = structuredClone(topology.nodes);
    state.edges = structuredClone(topology.edges);
    computeDegreeCentrality();
    computeOrbitalLayout();
    for (const n of state.nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y), n.id).toBe(true);
  });
});

/**
 * @vitest-environment node
 *
 * The big map generator (test/fixtures/big/make.js): deterministic for a seed, exactly 922 nodes and 3,632 edges in the 19 types
 * with their counts, the edge mix of a real map, and its output validates: the schema, the paths the map cites, the cloud file,
 * every proposal (and its mockup), and the retro theme's config and contrast. In memory except the last test, which writes the
 * repo to a temp folder (no server is started).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { makeBig, writeBig, COUNTS, NODE_TOTAL, EDGE_TOTAL, EDGE_MIX, PROPOSAL_COUNT } from './fixtures/big/make.js';
// @ts-expect-error plain JS module, no declarations
import { validateTopology, validateRepo } from '../core/validate.js';
// @ts-expect-error plain JS module, no declarations
import { missingPaths } from '../core/sync.js';
// @ts-expect-error plain JS module, no declarations
import { cloudNodeProblems } from '../core/cloud.js';
// @ts-expect-error plain JS module, no declarations
import { proposalProblems, summarize } from '../core/proposal.js';
// @ts-expect-error plain JS module, no declarations
import { loadConfig, loadDerivers } from '../core/config.js';

const FOLDER = 'docs/specs/proposals/';
const big = makeBig();

describe('the big map', () => {
  it('is deterministic for a seed, and another seed makes another map', () => {
    expect(makeBig().files).toEqual(big.files);
    expect(makeBig({ seed: 7 }).files['topology.json']).not.toBe(big.files['topology.json']);
  });

  it('has exactly the nodes, types and edges asked for', () => {
    expect(big.topology.nodes).toHaveLength(NODE_TOTAL);
    expect(big.topology.edges).toHaveLength(EDGE_TOTAL);
    expect(big.counts).toEqual(COUNTS);
    expect(Object.values(COUNTS).reduce((a, b) => a + b, 0)).toBe(922);
    const mix = {};
    for (const e of big.topology.edges) mix[e.kind || 'own'] = (mix[e.kind || 'own'] || 0) + 1;
    expect(mix).toEqual(EDGE_MIX);
  });

  it('has the service and external kinds, and labels of a spread of lengths', () => {
    const kinds = new Set(big.topology.nodes.filter((n) => n.type === 'service').map((n) => n.kind));
    expect([...kinds].sort()).toEqual(['client', 'dispatch', 'effects', 'hook', 'job', 'scheduler', 'timer', 'webhook']);
    expect(new Set(big.topology.nodes.filter((n) => n.type === 'external').map((n) => n.kind))).toEqual(new Set(['cloud', 'web']));
    const lengths = big.topology.nodes.map((n) => n.label.length).sort((a, b) => a - b);
    expect(lengths[Math.floor(lengths.length / 2)]).toBeGreaterThanOrEqual(10);
    expect(lengths.at(-1)).toBeLessThanOrEqual(45);
    expect(lengths.at(-1)).toBeGreaterThanOrEqual(35);
  });

  it('validates: the schema, the cited paths, the cloud file', () => {
    expect(validateTopology(big.topology)).toEqual([]);
    expect(missingPaths(big.topology, new Set(Object.keys(big.files).flatMap((f) => f.split('/').map((_, i, p) => p.slice(0, i + 1).join('/')))))).toEqual([]);
    expect(cloudNodeProblems(big.topology.nodes, JSON.parse(big.files['topology.cloud.json']))).toEqual([]);
  });

  it('has about 70 valid proposals, six of them rich, one with a mockup', () => {
    expect(big.proposals).toHaveLength(PROPOSAL_COUNT);
    let mockups = 0;
    for (const slug of big.proposals) {
      const proposal = JSON.parse(big.files[`${FOLDER}${slug}.json`]);
      expect(proposalProblems(big.topology, proposal).errors, slug).toEqual([]);
      for (const m of proposal.mockups || []) { mockups++; expect(big.files[`${FOLDER}${m.path}`], m.path).toBeTruthy(); }
    }
    expect(mockups).toBeGreaterThanOrEqual(1);
    const rich = big.proposals.filter((s) => /^01\d\d-/.test(s));
    expect(rich).toHaveLength(6);
    for (const slug of rich) {
      const sum = summarize(JSON.parse(big.files[`${FOLDER}${slug}.json`]));
      expect(sum.added, slug).toBeGreaterThan(0);
      expect(sum.changed, slug).toBeGreaterThan(0);
      expect(sum.removed, slug).toBeGreaterThan(0);
      expect(sum.scenarios, slug).toBeGreaterThanOrEqual(3);
    }
  });

  it('with project layers, `validate` warns without failing about a layer that matches nothing and a theme token that names nothing (spec 0009)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-big-test-'));
    try {
      writeBig(dir, { theme: 'retro', layers: true });
      const config = await loadConfig(dir, { env: { CORNFIELD_DATA: path.join(dir, '.data') } });
      const derivers = await loadDerivers(config);
      const clean = await validateRepo({ config, derivers });
      expect(clean.errors).toEqual([]);
      expect(clean.warnings.filter((w) => /layers\.add|--corn-map-(kind|group)-/.test(w))).toEqual([]); // the rig's example is a good one
      config.layers = { ...config.layers, add: [...config.layers.add, { key: 'nothing', label: 'Nothing', match: { kind: 'no-such-kind' } }] };
      fs.appendFileSync(path.join(dir, config.theme.css), '\n:root { --corn-map-kind-service-timr: auto; }\n');
      const { errors, warnings } = await validateRepo({ config, derivers });
      expect(errors).toEqual([]);
      expect(warnings).toContain('layers.add[3] "nothing" matches no node on the map: its row will not show.');
      expect(warnings.some((w) => w.startsWith('theme: --corn-map-kind-service-timr in the standard theme names a kind no service on the map has'))).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('writes a repo that passes `cornfield validate`, in the default theme and in retro (config and contrast)', async () => {
    for (const theme of [null, 'retro']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-big-test-'));
      try {
        writeBig(dir, { theme });
        const config = await loadConfig(dir, { env: { CORNFIELD_DATA: path.join(dir, '.data') } });
        const derivers = await loadDerivers(config);
        const { errors } = await validateRepo({ config, derivers });
        expect(errors, String(theme)).toEqual([]);
        expect(Boolean(config.theme && config.theme.css)).toBe(theme === 'retro');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });
});

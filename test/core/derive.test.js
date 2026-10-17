/**
 * @vitest-environment node
 *
 * The deriver contract (core/derive.js, docs/derivers.md): what a deriver must be, the order derivers run
 * in and what each sees, and how sync treats what they own.
 */
import { describe, it, expect } from 'vitest';
import { deriveTopology, deriverProblems, DERIVER_CONTRACT } from '../../core/derive.js';
import { planSync } from '../../core/sync.js';
import { SAMPLE } from '../helpers.js';

const deriver = (extra = {}) => ({ name: 'd', contract: DERIVER_CONTRACT, derive: () => ({ nodes: [], edges: [] }), ...extra });

describe('deriverProblems', () => {
  it('accepts a deriver of this contract', () => {
    expect(DERIVER_CONTRACT).toBe(1);
    expect(deriverProblems(deriver())).toEqual([]);
    expect(deriverProblems(deriver({ owns: ['pkg'], validate: () => [] }))).toEqual([]);
  });

  it('names a missing name, another contract, no derive, and bad owns or validate', () => {
    expect(deriverProblems(null)).toEqual(['A deriver is an object with a name, a contract and derive().']);
    const out = deriverProblems({ contract: 2, owns: 'pkg', validate: 3 }).join('\n');
    for (const want of ['needs a "name"', 'written for contract 2', 'no derive(ctx)', '"owns" is a list', '"validate" is a function']) expect(out).toContain(want);
  });
});

describe('deriveTopology', () => {
  it('runs the derivers in order, each seeing what the ones before made, the config, its options and the committed map', async () => {
    const seen = [];
    const first = deriver({ name: 'first', owns: ['pkg'], derive: () => ({ nodes: [{ id: 'pkg-a', type: 'pkg', label: 'a' }], edges: [], info: { n: 1 }, evidence: [{ match: { kind: 'host', value: 'x.example.org' } }] }) });
    const second = deriver({
      name: 'second',
      derive: (ctx) => {
        seen.push({ nodes: ctx.nodes.map((n) => n.id), info: ctx.info, options: ctx.options, title: ctx.config.title, evidence: ctx.evidence.length, map: ctx.map.nodes.map((n) => n.id), reads: typeof ctx.read });
        return { nodes: [{ id: 'tool-b', type: 'tool', label: 'b' }], edges: [{ from: 'pkg-a', to: 'tool-b', dashed: true }], warnings: ['careful'], problems: ['wrong'], ownedIds: ['tool-b'], pageOwners: ['app-x'] };
      },
    });
    const out = await deriveTopology({ root: SAMPLE, config: { title: 'T' }, derivers: [{ deriver: first }, { deriver: second, options: { k: 2 } }], map: { nodes: [{ id: 'by-hand' }] } });
    expect(seen).toEqual([{ nodes: ['pkg-a'], info: { first: { n: 1 } }, options: { k: 2 }, title: 'T', evidence: 1, map: ['by-hand'], reads: 'function' }]);
    expect(out).toMatchObject({ warnings: ['careful'], problems: ['wrong'], ownedTypes: ['pkg'], ownedIds: ['tool-b'], pageOwners: ['app-x'] });
    expect(out.nodes.map((n) => n.id)).toEqual(['pkg-a', 'tool-b']);
  });

  it('refuses two derivers making one node, and says which deriver failed', async () => {
    const a = deriver({ name: 'a', derive: () => ({ nodes: [{ id: 'x', type: 'tool', label: 'x' }], edges: [] }) });
    const b = deriver({ name: 'b', derive: () => ({ nodes: [{ id: 'x', type: 'tool', label: 'x' }], edges: [] }) });
    await expect(deriveTopology({ root: SAMPLE, derivers: [{ deriver: a }, { deriver: b }] })).rejects.toThrow(/Deriver "b" makes node "x", which deriver "a" already made/);
    const broken = deriver({ name: 'broken', derive: () => { throw new Error('cannot read the routes'); } });
    await expect(deriveTopology({ root: SAMPLE, derivers: [{ deriver: broken }] })).rejects.toThrow(/Deriver "broken" failed: cannot read the routes/);
    await expect(deriveTopology({ root: SAMPLE, derivers: [{ deriver: { name: 'old', contract: 0, derive() {} } }] })).rejects.toThrow(/contract 0/);
  });
});

describe('planSync and what derivers own', () => {
  const derived = { nodes: [{ id: 'root', type: 'root', label: 'r' }, { id: 'pkg-a', type: 'pkg', label: 'a', file: 'a' }], edges: [{ from: 'root', to: 'pkg-a' }], ownedTypes: ['root', 'pkg'] };

  it('adds what is derived with its theme and a description, and a second plan changes nothing', () => {
    const { next, changes } = planSync({ nodes: [], edges: [] }, derived);
    expect(changes).toEqual(['add root root (r)', 'add pkg pkg-a (a)', 'add edge root|pkg-a|own']);
    expect(next.nodes[1]).toMatchObject({ id: 'pkg-a', color: '#06b6d4', r: 24, desc: 'The a workspace package (a).' });
    expect(planSync(next, derived).changes).toEqual([]);
  });

  it('removes a node of an owned type the code no longer shows, and keeps one of a type nobody owns, with its edges', () => {
    const map = planSync({ nodes: [], edges: [] }, derived).next;
    map.nodes.push({ id: 'pkg-gone', type: 'pkg', label: 'gone' }, { id: 'app-hand', type: 'app', label: 'by hand' });
    map.edges.push({ from: 'root', to: 'app-hand' }, { from: 'app-hand', to: 'pkg-a', kind: 'flow', flow: 'api', status: 'live', label: 'calls' });
    const { next, changes } = planSync(map, derived);
    expect(changes).toEqual(['remove pkg pkg-gone (gone)']);
    expect(next.nodes.map((n) => n.id)).toEqual(['root', 'pkg-a', 'app-hand']);
    expect(next.edges).toContainEqual({ from: 'app-hand', to: 'pkg-a', kind: 'flow', flow: 'api', status: 'live', label: 'calls' });
  });

  it('keeps a hand-written description and drops a stored position', () => {
    const map = planSync({ nodes: [], edges: [] }, derived).next;
    map.nodes[1] = { ...map.nodes[1], desc: 'Written by a person.', x: 10, y: 20 };
    const { next, changes } = planSync(map, derived);
    expect(changes).toEqual(['pkg-a: drop x/y (the explorer lays the map out itself)']);
    expect(next.nodes[1].desc).toBe('Written by a person.');
    expect('x' in next.nodes[1]).toBe(false);
  });
});

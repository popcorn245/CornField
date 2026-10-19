/**
 * @vitest-environment node
 *
 * The deriver kit (core/deriver-kit.js, `cornfield/deriver-kit`): a deriver a repo writes, tested against a
 * fixture repo with one import, as the guide (docs/deriver-kit.md) shows it. Imported by the package's own
 * name, so the export map is what is tested.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { defineDeriver, fixtureRepo, runDeriver, checkDeriver, runProblems, DERIVER_CONTRACT } from 'cornfield/deriver-kit';
import { SAMPLE } from '../helpers.js';

/** The guide's example: one page node per route file of an app the starter deriver found */
const routes = defineDeriver({
  name: 'routes',
  contract: 1,
  derive(ctx) {
    const app = ctx.options.app || 'pkg-api';
    if (!ctx.nodes.some((n) => n.id === app)) throw new Error(`no node "${app}" to hang the routes from`);
    const files = ctx.walk('packages/api/routes', (f) => f.endsWith('.js'));
    const page = (f) => `page-${path.posix.basename(f, '.js')}`;
    return {
      nodes: files.map((f) => ({ id: page(f), type: 'page', label: `/${path.posix.basename(f, '.js')}`, file: f })),
      edges: files.map((f) => ({ from: app, to: page(f) })),
      pageOwners: [app],
      warnings: files.length ? [] : ['no routes in packages/api/routes'],
    };
  },
});

const API = {
  'package.json': { name: 'acme', private: true, workspaces: ['packages/*'], type: 'module' },
  'packages/api/package.json': { name: '@acme/api' },
  'packages/api/index.js': 'export const api = 1;\n',
  'packages/api/routes/cart.js': 'export default () => "cart";\n',
  'packages/api/routes/login.js': 'export default () => "login";\n',
};

describe('defineDeriver', () => {
  it('returns a deriver of this contract as it is, and refuses one that is not, saying why', () => {
    expect(DERIVER_CONTRACT).toBe(1);
    expect(defineDeriver(routes)).toBe(routes);
    expect(() => defineDeriver({ name: 'old', contract: 0, derive() {} })).toThrow(/written for contract 0; this cornfield speaks contract 1/);
    expect(() => defineDeriver({ name: 'x', contract: 1 })).toThrow(/no derive\(ctx\)/);
  });
});

describe('fixtureRepo', () => {
  it('writes files (objects as JSON), adds, reads and removes them, and cleans up', () => {
    const repo = fixtureRepo({ 'a/b.txt': 'hi', 'c.json': { x: 1 } });
    try {
      expect(repo.read('a/b.txt')).toBe('hi');
      expect(JSON.parse(repo.read('c.json'))).toEqual({ x: 1 });
      repo.write({ 'd.txt': 'more' }).remove('a');
      expect(fs.existsSync(path.join(repo.root, 'a'))).toBe(false);
      expect(() => repo.write({ '../escape.txt': 'no' })).toThrow(/leaves the fixture repo/);
    } finally {
      repo.cleanup();
    }
    expect(fs.existsSync(repo.root)).toBe(false);
  });

  it('copies a folder of yours first, then the files over it', () => {
    const repo = fixtureRepo({ 'extra.md': '# x' }, { from: SAMPLE });
    try {
      expect(fs.existsSync(path.join(repo.root, 'topology.json'))).toBe(true);
      expect(repo.read('extra.md')).toBe('# x');
      expect(fs.existsSync(path.join(SAMPLE, 'extra.md'))).toBe(false);
    } finally {
      repo.cleanup();
    }
    expect(() => fixtureRepo({}, { from: path.join(SAMPLE, 'nope') })).toThrow(/is not a folder/);
  });
});

describe('runDeriver and checkDeriver', () => {
  it("tests a deriver on a fixture repo after a built-in, and returns its nodes, the synced map and every check's verdict", async () => {
    const run = await checkDeriver(routes, { files: API, before: [{ use: 'starter' }] });
    expect(run.nodes.map((n) => [n.id, n.label, n.file])).toEqual([
      ['page-cart', '/cart', 'packages/api/routes/cart.js'],
      ['page-login', '/login', 'packages/api/routes/login.js'],
    ]);
    expect(run.edges).toEqual([{ from: 'pkg-api', to: 'page-cart' }, { from: 'pkg-api', to: 'page-login' }]);
    expect(run.topology.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['root', 'pkg-api', 'page-cart', 'page-login']));
    expect(run.changes).toContain('add page page-cart (/cart)');
    expect(runProblems(run)).toEqual([]);
    // The throwaway repo is gone once the run is over
    expect(fs.existsSync(run.root)).toBe(false);
  });

  it('hands the deriver its options, and runs on a repo folder of yours (left as it was)', async () => {
    const repo = fixtureRepo(API);
    try {
      const run = await runDeriver(routes, { root: repo.root, before: ['starter'], options: { app: 'pkg-api' }, config: { title: 'Acme' } });
      expect(run.nodes).toHaveLength(2);
      expect(fs.existsSync(path.join(repo.root, 'topology.json'))).toBe(false);
      repo.remove('packages/api/routes');
      expect((await runDeriver(routes, { root: repo.root, before: ['starter'] })).warnings).toEqual(['no routes in packages/api/routes']);
    } finally {
      repo.cleanup();
    }
  });

  it('says why a deriver would fail validate: the schema, missing files, its problems, its validate, nodes nothing owns', async () => {
    const sloppy = defineDeriver({
      name: 'sloppy',
      contract: 1,
      derive: () => ({
        nodes: [
          { id: 'page-x', type: 'page', label: 'x', file: 'x.js' },
          { id: 'thing', type: 'gadget', label: 'thing' },
          { id: 'svc-y', type: 'tool', label: 'y', file: 'y.js' },
        ],
        edges: [{ from: 'svc-y', to: 'nowhere' }],
        problems: ['the routes file moved'],
      }),
      validate: () => ['checked the map and did not like it'],
    });
    const err = await checkDeriver(sloppy, { files: { 'y.js': '' } }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^Deriver "sloppy" would fail cornfield validate/);
    const text = err.problems.join('\n');
    expect(text).toContain('problem: the routes file moved');
    expect(text).toContain('schema: Page node "page-x" label "x" must start with a slash route');
    expect(text).toContain('schema: Node "thing" has unknown type: "gadget"');
    expect(text).toContain('schema: Edge #0 references non-existent \'to\' node: "nowhere"');
    expect(text).toContain('paths: Node "page-x" has file "x.js", which is not in the repo');
    expect(text).toContain('validate: checked the map and did not like it');
    expect(text).toContain('owns: it makes "svc-y" but does not own it');
    expect(err.run.nodes).toHaveLength(3);
    // A deriver that means to leave its nodes to people can say so
    const loose = defineDeriver({ name: 'loose', contract: 1, derive: () => ({ nodes: [{ id: 'tool-z', type: 'tool', label: 'z', file: 'z.js' }], edges: [] }) });
    await expect(checkDeriver(loose, { files: { 'z.js': '' }, allowUnowned: true })).resolves.toMatchObject({ unowned: ['tool-z'] });
  });

  it('syncs over a committed map, and names a deriver that throws and a deriver that is not one', async () => {
    const owned = defineDeriver({ name: 'tools', contract: 1, owns: ['tool'], derive: () => ({ nodes: [{ id: 'tool-a', type: 'tool', label: 'a', file: 'a.js' }], edges: [] }) });
    const map = { nodes: [{ id: 'tool-old', type: 'tool', label: 'old', r: 19, color: '#f43f5e', desc: 'Gone.' }], edges: [] };
    const run = await checkDeriver(owned, { files: { 'a.js': '' }, map });
    expect(run.changes).toEqual(['remove tool tool-old (old)', 'add tool tool-a (a)']);
    const broken = defineDeriver({ name: 'broken', contract: 1, derive: () => { throw new Error('cannot read the routes'); } });
    await expect(runDeriver(broken, { files: {} })).rejects.toThrow(/Deriver "broken" failed: cannot read the routes/);
    await expect(runDeriver({ name: 'nope' }, { files: {} })).rejects.toThrow(/contract/);
    await expect(runDeriver(owned, {})).rejects.toThrow(/needs a repo/);
    await expect(runDeriver(owned, { files: {}, before: ['nonesuch'] })).rejects.toThrow(/not a built-in deriver/);
  });
});

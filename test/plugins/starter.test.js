/**
 * @vitest-environment node
 *
 * The starter deriver: a map of any JavaScript repo with no plugin code. Packages from npm workspaces (or
 * the top-level folders, or the config's list), the imports between them, a dependency that is declared and
 * never imported, and with `modules: true` one node per source file.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import starter, { importsOf, packageIds } from '../../plugins/starter/index.js';
import { deriveTopology } from '../../core/derive.js';
import { planSync } from '../../core/sync.js';
import { SAMPLE } from '../helpers.js';

const made = [];
/** A repo on disk from { 'path': text } */
function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-starter-'));
  made.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof text === 'string' ? text : JSON.stringify(text));
  }
  return root;
}
afterAll(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });

const derive = (root, options = {}) => deriveTopology({ root, derivers: [{ deriver: starter, options }] });
const links = (out) => out.edges.filter((e) => e.dashed).map((e) => `${e.from} -> ${e.to}: ${e.label}`).sort();

describe('importsOf', () => {
  it('reads import, export from, import() and require(), once each, and never a commented one', () => {
    const src = [
      "import a from './a.js';",
      "import { b, c } from '@x/b';",
      "import './side-effect.js';",
      "export * from './d.js';",
      "export { e } from './e.js';",
      "const f = await import('./f.js');",
      "const g = require('g');",
      "// import nope from './nope.js';",
      "/* import nope2 from './nope2.js'; */",
      "import a2 from './a.js';",
    ].join('\n');
    expect(importsOf(src)).toEqual(['./a.js', '@x/b', './side-effect.js', './d.js', './e.js', './f.js', 'g']);
  });
});

describe('packageIds', () => {
  it('names a package by its folder, and by its whole path where two folders share a name', () => {
    expect(Object.fromEntries(packageIds(['packages/web', 'packages/api', 'apps/web']))).toEqual({ 'packages/web': 'pkg-packages-web', 'packages/api': 'pkg-api', 'apps/web': 'pkg-apps-web' });
  });
});

describe('on an npm-workspaces repo', () => {
  const root = repo({
    'package.json': { name: 'shop', workspaces: ['packages/*'] },
    'packages/ui/package.json': { name: '@shop/ui', description: 'Buttons and cards' },
    'packages/ui/src/index.js': "export const button = () => '<button>';",
    'packages/web/package.json': { name: '@shop/web', dependencies: { '@shop/ui': '*', '@shop/util': '*' } },
    'packages/web/src/index.js': "import { button } from '@shop/ui';\nimport { cart } from './cart.js';\nexport const page = () => button() + cart();",
    'packages/web/src/cart.js': "export const cart = () => '';",
    'packages/web/src/cart.test.js': "import { cart } from './cart.js';",
    'packages/util/package.json': { name: '@shop/util' },
    'packages/util/index.js': 'export const id = (x) => x;',
    'notes.txt': 'not a package',
  });

  it('makes the root and a package node per workspace, with its name and description', async () => {
    const out = await derive(root);
    expect(out.nodes.map((n) => [n.id, n.type, n.label])).toEqual([
      ['root', 'root', 'shop'], ['pkg-ui', 'pkg', '@shop/ui'], ['pkg-util', 'pkg', '@shop/util'], ['pkg-web', 'pkg', '@shop/web'],
    ]);
    expect(out.nodes.find((n) => n.id === 'pkg-ui')).toMatchObject({ file: 'packages/ui', summary: 'Buttons and cards' });
    expect(out.edges.filter((e) => !e.dashed && !e.kind).map((e) => `${e.from}>${e.to}`)).toEqual(['root>pkg-ui', 'root>pkg-util', 'root>pkg-web']);
    expect(out.ownedTypes).toEqual(['root', 'pkg', 'core']);
  });

  it('draws an import between packages, and a dependency nothing imports as declared', async () => {
    expect(links(await derive(root))).toEqual([
      'pkg-web -> pkg-ui: imports',
      'pkg-web -> pkg-util: declared in package.json, not imported',
    ]);
  });

  it('with modules: one node per source file under its package, the imports between them, tests left out', async () => {
    const out = await derive(root, { modules: true });
    const modules = out.nodes.filter((n) => n.type === 'core').map((n) => n.file);
    expect(modules).toEqual(['packages/ui/src/index.js', 'packages/util/index.js', 'packages/web/src/cart.js', 'packages/web/src/index.js']);
    expect(links(out)).toEqual(expect.arrayContaining([
      'core-packages-web-src-index -> core-packages-web-src-cart: imports',
      'core-packages-web-src-index -> core-packages-ui-src-index: imports',
    ]));
    const withTests = await derive(root, { modules: true, tests: true });
    expect(withTests.nodes.some((n) => n.file === 'packages/web/src/cart.test.js')).toBe(true);
  });

  it('gives sync a map that is stable: a second sync changes nothing', async () => {
    const out = await derive(root, { modules: true });
    const first = planSync({ nodes: [], edges: [] }, out);
    expect(first.changes.length).toBeGreaterThan(0);
    expect(planSync(first.next, out).changes).toEqual([]);
  });

  it('removes a package and its edges once its folder is gone, and keeps a hand-written node', async () => {
    const out = await derive(root);
    const { next } = planSync({ nodes: [], edges: [] }, out);
    next.nodes.push({ id: 'tool-notes', type: 'tool', label: 'Notes', desc: 'By hand.' });
    next.edges.push({ from: 'root', to: 'tool-notes' });
    fs.rmSync(path.join(root, 'packages/util'), { recursive: true });
    const again = planSync(next, await derive(root));
    expect(again.changes).toEqual(expect.arrayContaining(['remove pkg pkg-util (@shop/util)']));
    expect(again.next.nodes.map((n) => n.id)).toEqual(['root', 'pkg-ui', 'pkg-web', 'tool-notes']);
    expect(again.next.edges.some((e) => e.to === 'pkg-util' || e.from === 'pkg-util')).toBe(false);
  });
});

describe('on a repo with no workspaces', () => {
  it('takes each top-level folder with source files as a package, and the config can name its own', async () => {
    const root = repo({
      'package.json': { name: 'tool' },
      'lib/a.js': "import '../bin/b.js';",
      'bin/b.js': '',
      'docs/readme.md': '# no code',
      'test/a.test.js': '',
    });
    const out = await derive(root);
    expect(out.nodes.filter((n) => n.type === 'pkg').map((n) => n.file)).toEqual(['bin', 'lib']);
    expect(links(out)).toEqual(['pkg-lib -> pkg-bin: imports']);
    const named = await derive(root, { packages: ['lib'] });
    expect(named.nodes.filter((n) => n.type === 'pkg').map((n) => n.file)).toEqual(['lib']);
  });

  it('warns, and still makes the root, when there is nothing to map', async () => {
    const out = await derive(repo({ 'README.md': 'hello' }));
    expect(out.nodes.map((n) => n.id)).toEqual(['root']);
    expect(out.warnings[0]).toMatch(/no packages found/);
  });
});

describe('on the sample repo', () => {
  it('finds its three packages and that web and api both import shared', async () => {
    const out = await derive(SAMPLE);
    expect(out.nodes.filter((n) => n.type === 'pkg').map((n) => n.label)).toEqual(['@acme/api', '@acme/shared', '@acme/web']);
    expect(links(out)).toEqual(['pkg-api -> pkg-shared: imports', 'pkg-web -> pkg-shared: imports']);
  });
});

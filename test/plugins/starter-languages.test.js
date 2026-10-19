/**
 * @vitest-environment node
 *
 * The starter deriver beyond JavaScript (SRC-04): Python packages and imports, Go modules, Rust crates,
 * read the way it reads npm workspaces. One fixture repo per language (test/fixtures/python, go, rust):
 * packages from their manifests, the imports between them, a dependency declared and never imported, and
 * a test file left out. The manifests' TOML goes through plugins/starter/toml.js.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import starter from '../../plugins/starter/index.js';
import { parseToml } from '../../plugins/starter/toml.js';
import { pythonImports, goImports, rustUses, docSummary, pyName } from '../../plugins/starter/languages.js';
import { deriveTopology } from '../../core/derive.js';
import { planSync } from '../../core/sync.js';
import { CORNFIELD } from '../helpers.js';

const FIXTURES = path.join(CORNFIELD, 'test', 'fixtures');
const made = [];
/** A repo on disk from { 'path': text } */
function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-langs-'));
  made.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof text === 'string' ? text : JSON.stringify(text));
  }
  return root;
}
afterAll(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });

const derive = (root, options = {}) => deriveTopology({ root, config: { title: 'pantry' }, derivers: [{ deriver: starter, options }] });
const pkgs = (out) => out.nodes.filter((n) => n.type === 'pkg').map((n) => `${n.id} ${n.label} ${n.file ?? '.'}`);
const links = (out) => out.edges.filter((e) => e.dashed).map((e) => `${e.from} -> ${e.to}: ${e.label}`).sort();

describe('parseToml', () => {
  it('reads tables, arrays of tables, dotted and quoted keys, strings, arrays and inline tables', () => {
    const text = [
      '# a manifest',
      'title = "pantry" # the name',
      "literal = 'C:\\path'",
      'multi = """',
      'two\\',
      '   lines"""',
      'n = 1_000',
      'f = 1.5',
      'yes = true',
      'when = 2026-10-19 12:00:00',
      '[package]',
      'name = "pantry-cli"',
      'tags = [',
      '  "a", # first',
      '  "b",',
      ']',
      '[dependencies]',
      'core = { path = "../core", features = ["x"] }',
      'serde.workspace = true',
      '"quoted.key" = "\\u00e9"',
      '[[bin]]',
      'name = "one"',
      '[[bin]]',
      'name = "two"',
      '[a.b]',
      'c = []',
    ].join('\n');
    expect(parseToml(text)).toEqual({
      title: 'pantry', literal: 'C:\\path', multi: 'twolines', n: 1000, f: 1.5, yes: true, when: '2026-10-19 12:00:00',
      package: { name: 'pantry-cli', tags: ['a', 'b'] },
      dependencies: { core: { path: '../core', features: ['x'] }, serde: { workspace: true }, 'quoted.key': 'é' },
      bin: [{ name: 'one' }, { name: 'two' }],
      a: { b: { c: [] } },
    });
  });

  it('says on which line it cannot read', () => {
    expect(() => parseToml('a = 1\nb = "open')).toThrow(/TOML line 2: a string is not closed/);
    expect(() => parseToml('a = [1 2]')).toThrow(/needs a comma/);
  });
});

describe('the import readers', () => {
  it('reads Python imports, relative ones and parenthesised lists, never a docstring or a comment', () => {
    const src = '"""Docs.\n\nimport nope\n"""\nimport os, a.b as ab\nfrom x.y import (\n  z,\n  w as v,\n)\nfrom .. import up  # import nope2\nfrom .m import n\n';
    expect(pythonImports(src)).toEqual([
      { module: 'os', level: 0, names: [] }, { module: 'a.b', level: 0, names: [] },
      { module: 'x.y', level: 0, names: ['z', 'w'] }, { module: '', level: 2, names: ['up'] }, { module: 'm', level: 1, names: ['n'] },
    ]);
  });

  it('reads Go import lines and blocks, with an alias, never a commented one', () => {
    expect(goImports('package a\n// import "nope"\nimport "fmt"\nimport x "example.test/x"\nimport (\n  "a/b"\n  _ "c/d"\n)\n')).toEqual(['fmt', 'example.test/x', 'a/b', 'c/d']);
  });

  it('reads the crate names Rust code uses, never one in a string or a comment', () => {
    expect(rustUses('use pantry_core::Item;\nextern crate old;\n// nope::x\nfn f() { let s = "str::x"; other::call(); std::mem::drop(1); self::g(); }\n').sort()).toEqual(['old', 'other', 'pantry_core']);
  });

  it('reads what a file says it is, and normalises Python names', () => {
    expect(docSummary('#!/usr/bin/env python\n"""Reads the shelves. More."""\n', 'python')).toBe('Reads the shelves.');
    expect(docSummary('// Package shelf reads the shelves.\npackage shelf\n', 'go')).toBe('Package shelf reads the shelves.');
    expect(docSummary('//! Reads the shelves.\n//! More.\nuse x;\n', 'rust')).toBe('Reads the shelves.');
    expect(docSummary('x = 1\n', 'python')).toBeNull();
    expect(pyName('Pantry_Utils')).toBe('pantry-utils');
  });
});

describe('on the Python fixture', () => {
  it('makes a package per pyproject.toml (PEP 621 or Poetry), the imports between them, and a declared one', async () => {
    const out = await derive(path.join(FIXTURES, 'python'));
    expect(pkgs(out)).toEqual(['pkg-api pantry-api packages/api', 'pkg-core pantry-core packages/core', 'pkg-utils pantry-utils packages/utils']);
    expect(out.nodes.find((n) => n.id === 'pkg-core').summary).toBe("The pantry's items and their rules");
    // A docstring's example and a test's import are not imports: utils is declared only
    expect(links(out)).toEqual(['pkg-api -> pkg-core: imports', 'pkg-api -> pkg-utils: declared in pyproject.toml, not imported']);
  });

  it('with modules: a node per file (tests left out), relative and absolute imports to the file they name', async () => {
    const out = await derive(path.join(FIXTURES, 'python'), { modules: true });
    expect(out.nodes.filter((n) => n.type === 'core').map((n) => n.file)).toEqual([
      'packages/api/pantry_api/__init__.py', 'packages/api/pantry_api/routes.py', 'packages/api/pantry_api/server.py',
      'packages/core/src/pantry_core/__init__.py', 'packages/core/src/pantry_core/models.py', 'packages/utils/pantry_utils/__init__.py',
    ]);
    expect(links(out).filter((l) => l.startsWith('core-'))).toEqual([
      'core-packages-api-pantry-api-routes -> core-packages-core-src-pantry-core-init: imports',
      'core-packages-api-pantry-api-server -> core-packages-api-pantry-api-routes: imports',
      'core-packages-api-pantry-api-server -> core-packages-core-src-pantry-core-models: imports',
      'core-packages-core-src-pantry-core-init -> core-packages-core-src-pantry-core-models: imports',
    ]);
    expect(out.nodes.find((n) => n.file === 'packages/api/pantry_api/server.py').summary).toBe("The API's entry point.");
  });
});

describe('on the Go fixture', () => {
  it("makes a package per go.work module, named by its module path, and a required module nothing imports", async () => {
    const out = await derive(path.join(FIXTURES, 'go'), { modules: true });
    expect(pkgs(out)).toEqual(['pkg-api example.test/pantry/api api', 'pkg-shared example.test/pantry/shared shared', 'pkg-tools example.test/pantry/tools tools']);
    // main_test.go imports tools: a test, left out
    expect(links(out)).toEqual(['pkg-api -> pkg-shared: imports', 'pkg-api -> pkg-tools: required in go.mod, not imported']);
    expect(out.nodes.filter((n) => n.type === 'core').map((n) => n.file)).toEqual(['api/main.go', 'shared/format/format.go', 'tools/tools.go']);
    expect(out.info.starter.packages.map((p) => p.language)).toEqual(['go', 'go', 'go']);
  });
});

describe('on the Rust fixture', () => {
  it('makes a package per workspace member, the crates the code uses, and a renamed dependency never used', async () => {
    const out = await derive(path.join(FIXTURES, 'rust'));
    expect(pkgs(out)).toEqual(['pkg-cli pantry-cli crates/cli', 'pkg-core pantry-core crates/core', 'pkg-macros pantry-macros crates/macros']);
    expect(links(out)).toEqual(['pkg-cli -> pkg-core: imports', 'pkg-cli -> pkg-macros: declared in Cargo.toml, not used']);
  });

  it('gives sync a stable map: a second sync changes nothing', async () => {
    const out = await derive(path.join(FIXTURES, 'rust'), { modules: true });
    const first = planSync({ nodes: [], edges: [] }, out);
    expect(planSync(first.next, out).changes).toEqual([]);
  });
});

describe('finding packages without a workspace', () => {
  it("finds each go.mod and Cargo.toml, a crate at the root, and never goes into target, vendor or .venv", async () => {
    const root = repo({
      'Cargo.toml': '[package]\nname = "tool"\n',
      'src/main.rs': 'use helper::x;\nfn main() {}\n',
      'helper/Cargo.toml': '[package]\nname = "helper"\n',
      'helper/src/lib.rs': '',
      'target/debug/build.rs': 'use helper::y;',
      'svc/go.mod': 'module example.test/svc\n',
      'svc/main.go': 'package main\n',
      'svc/vendor/x/x.go': 'package x\n',
      'py/pyproject.toml': '[project]\nname = "py-tool"\n',
      'py/py_tool/__init__.py': '',
      'py/.venv/lib/site.py': 'import nope',
    });
    const out = await derive(root, { modules: true });
    expect(pkgs(out)).toEqual(['pkg-root tool .', 'pkg-helper helper helper', 'pkg-py py-tool py', 'pkg-svc example.test/svc svc']);
    expect(out.nodes.filter((n) => n.type === 'core').map((n) => n.file)).toEqual(['helper/src/lib.rs', 'py/py_tool/__init__.py', 'src/main.rs', 'svc/main.go']);
    expect(links(out)).toEqual(['pkg-root -> pkg-helper: imports']);
  });

  it('reads a uv workspace, and keeps the JavaScript folders beside the other languages', async () => {
    const uv = repo({
      'pyproject.toml': '[project]\nname = "root-app"\n\n[tool.uv.workspace]\nmembers = ["libs/*"]\n',
      'main.py': 'import libone\n',
      'libs/one/pyproject.toml': '[project]\nname = "libone"\n',
      'libs/one/libone.py': '',
      'libs/two/pyproject.toml': '[project]\nname = "libtwo"\n',
    });
    const out = await derive(uv);
    expect(pkgs(out)).toEqual(['pkg-root root-app .', 'pkg-one libone libs/one', 'pkg-two libtwo libs/two']);
    expect(links(out)).toEqual(['pkg-root -> pkg-one: imports']);

    const mixed = repo({ 'package.json': { name: 'site' }, 'web/index.js': '', 'api/go.mod': 'module example.test/api\n', 'api/main.go': 'package main\n' });
    expect(pkgs(await derive(mixed))).toEqual(['pkg-api example.test/api api', 'pkg-web web web']);
  });

  it('takes the language of a folder the config names from its manifest, else from most of its files', async () => {
    const root = repo({ 'scripts/a.py': 'import b\n', 'scripts/b.py': '', 'tools/go.mod': 'module example.test/tools\n', 'tools/t.go': 'package t\n' });
    const out = await derive(root, { packages: ['scripts', 'tools'], modules: true });
    expect(out.info.starter.packages.map((p) => `${p.dir} ${p.language}`)).toEqual(['scripts python', 'tools go']);
    expect(out.nodes.filter((n) => n.type === 'core').map((n) => n.file)).toEqual(['scripts/a.py', 'scripts/b.py', 'tools/t.go']);
  });

  it('says which manifest it cannot read', async () => {
    await expect(derive(repo({ 'x/Cargo.toml': '[package\nname = 1' }))).rejects.toThrow(/x\/Cargo.toml is not TOML the starter can read/);
  });
});

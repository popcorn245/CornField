/**
 * @module plugins/starter
 *
 * The starter deriver: a map of any JavaScript, Python, Go or Rust repo with zero plugin code. It reads
 * the packages and the imports between them.
 *
 *  - **Packages.** The npm workspaces of the root package.json (`workspaces: ["packages/*"]`, or
 *    `{ packages: [...] }`); the Go modules (the `use` folders of `go.work`, else each folder with a
 *    `go.mod`); the Rust crates (a Cargo workspace's `members`, else each `Cargo.toml` with a `[package]`);
 *    the Python packages (a uv workspace's `members`, else each folder with a `pyproject.toml`, `setup.py`
 *    or `setup.cfg`). With none of these, each top-level folder that holds source files. The option
 *    `packages` replaces all of it with your own list of folders (a trailing `/*` means each folder in it);
 *    each folder's language is its manifest's, else the one most of its files are in.
 *  - **Modules** (option `modules: true`): one node per source file, under its package.
 *  - **Imports.** In JavaScript, every `import … from`, `export … from`, `import()` and `require()`: a
 *    relative one to the file it names, a bare one to the workspace package of that name. In Python,
 *    `import a.b` and `from a import b` (relative ones too) to the package that holds module `a`; in Go,
 *    an import path under another module's path; in Rust, `use other_crate::…`, `extern crate` and
 *    `other_crate::` paths. An import from one package into another is a dashed edge between them (between
 *    the modules too, with `modules: true`, for JavaScript and Python, whose imports name a file), labelled
 *    with what it is. A dependency a manifest declares on another package of the repo (package.json,
 *    pyproject.toml, go.mod `require`, Cargo.toml) that no file imports is a dashed edge labelled "declared".
 *
 * What it makes:
 *
 *   root                      the repo (its package.json name, else the config's title)
 *   pkg-<folder>              a package: label its manifest's name (package.json or pyproject.toml name, Go
 *                             module path, crate name; else the folder), file the folder
 *   core-<path>               a module (with `modules: true`): label the file name, file its path
 *
 * Options: `{ packages?: string[], modules?: boolean, tests?: boolean, extensions?: string[] }`
 * (`extensions` replaces every language's own). Test files (`*.test.*`, `*.spec.*`, `test_*.py`,
 * `*_test.py`, `*_test.go`, folders named test, tests or __tests__) are left out unless `tests: true`; so
 * are a language's own build and environment folders (`target`, `.venv`, `__pycache__`, `vendor` …).
 */

import { LANGUAGES, TEST_FILES, docSummary, expandMembers, goImports, goManifest, goWorkDirs, manifestLanguage, pyName, pythonImports, pythonManifest, rustManifest, rustName, rustUses } from './languages.js';

const DEFAULT_EXTENSIONS = LANGUAGES.js.extensions;
const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__fixtures__', 'fixtures']);
const SKIP_TOP = new Set(['node_modules', 'dist', 'build', 'coverage', 'docs', 'test', 'tests', 'vendor', 'target']);
const ALL_EXTENSIONS = Object.values(LANGUAGES).flatMap((l) => l.extensions);
const DECLARED = { js: 'declared in package.json, not imported', python: 'declared in pyproject.toml, not imported', go: 'required in go.mod, not imported', rust: 'declared in Cargo.toml, not used' };

/**
 * The first sentence of a file's leading doc comment (after an `@module` line), or null: what a module says it is.
 * @param {string} source
 */
export function summaryOf(source) {
  const m = /^(?:#![^\n]*\n)?\s*\/\*\*([\s\S]*?)\*\//.exec(source);
  if (!m) return null;
  const text = m[1].split('\n').map((l) => l.replace(/^\s*\* ?/, '')).filter((l) => !/^@\w+/.test(l.trim())).join(' ').replace(/\s+/g, ' ').trim();
  const first = /^(.+?[.!?])(?:\s|$)/.exec(text);
  const out = (first ? first[1] : text).trim();
  return out ? (out.length > 200 ? `${out.slice(0, 197)}…` : out) : null;
}

/** `pkg-<folder>` and `core-<path>` ids: lower-case words joined by dashes */
export const slugOf = (p) => p.toLowerCase().replace(/\.[a-z]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
export const packageId = (dir) => `pkg-${slugOf(dir)}`;
/** Package ids for a set of folders: the folder's own name, or its whole path where two share a name */
export function packageIds(dirs) {
  const base = (d) => d.split('/').pop();
  const count = new Map();
  for (const d of dirs) count.set(base(d), (count.get(base(d)) || 0) + 1);
  return new Map(dirs.map((d) => [d, packageId(count.get(base(d)) > 1 ? d : base(d))]));
}
export const moduleId = (file) => `core-${slugOf(file)}`;

/**
 * The specifiers a source file imports, in order, without duplicates.
 * @param {string} source
 * @returns {string[]}
 */
export function importsOf(source) {
  // Comments out first, so an example in a doc comment is not an import
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const out = new Set();
  const patterns = [
    /(?:^|[;\s])import\s+(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
    /(?:^|[;\s])export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+['"]([^'"\n]+)['"]/g,
    /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** The package folders a list of patterns names: `dir` itself, or `dir/*` for each folder in it */
function expandPatterns(patterns, io) {
  const dirs = [];
  for (const raw of patterns) {
    const p = String(raw).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (p.endsWith('/*')) {
      const base = p.slice(0, -2);
      for (const name of io.list(base)) if (!name.startsWith('.') && io.isDir(`${base}/${name}`)) dirs.push(`${base}/${name}`);
    } else if (io.isDir(p)) dirs.push(p);
  }
  return [...new Set(dirs)].sort();
}

const readJson = (io, rel) => {
  if (!io.exists(rel)) return null;
  try { return JSON.parse(io.read(rel)); } catch (err) { throw new Error(`${rel} is not valid JSON: ${err.message}`); }
};
const join = (dir, name) => (dir ? `${dir}/${name}` : name);

/** Every file under `dir` that `test` accepts, not going into the folders `prune` names */
function walkPruned(io, dir, prune, test) {
  if (!prune.length) return io.walk(dir, test);
  const skip = new Set(prune);
  return io.list(dir).flatMap((name) => {
    const child = join(dir, name);
    if (!io.isDir(child)) return test(child) ? [child] : [];
    if (skip.has(name) || name.endsWith('.egg-info')) return [];
    return walkPruned(io, child, prune, test);
  }).filter((f) => !f.split('/').some((s) => s === 'node_modules' || s === '.git'));
}

/** The language most of a folder's source files are in (JavaScript when there are none) */
function languageOf(io, dir) {
  const by = manifestLanguage(io, dir);
  if (by) return by;
  let best = 'js';
  let most = 0;
  for (const [lang, { extensions }] of Object.entries(LANGUAGES)) {
    const n = io.walk(dir, (f) => extensions.some((e) => f.endsWith(e))).length;
    if (n > most) { best = lang; most = n; }
  }
  return best;
}

/** A package: `{ dir, lang, name, summary, manifest, deps }` (`deps` are names in the language's own terms) */
function packageAt(io, dir, lang) {
  if (lang === 'js') {
    const manifest = readJson(io, join(dir, 'package.json'));
    const deps = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'].flatMap((f) => Object.keys(manifest?.[f] || {}));
    return { dir, lang, name: manifest?.name || dir, summary: manifest?.description || null, manifest, deps };
  }
  const m = lang === 'python' && manifestLanguage(io, dir) === 'python' ? pythonManifest(io, dir)
    : lang === 'go' && io.exists(join(dir, 'go.mod')) ? goManifest(io, dir)
      : lang === 'rust' && io.exists(join(dir, 'Cargo.toml')) ? rustManifest(io, dir)
        : { name: null, summary: null, deps: [] };
  return { dir, lang, name: m.name || dir || 'root', summary: m.summary || null, manifest: m, deps: Array.isArray(m.deps) ? m.deps : Object.keys(m.deps || {}) };
}

/** The Go, Rust and Python packages of a repo that names none: `[{ dir, lang }]` */
function otherPackages(io) {
  const found = [];
  const manifests = io.walk('', (f) => /(?:^|\/)(?:go\.mod|Cargo\.toml|pyproject\.toml|setup\.py|setup\.cfg)$/.test(f))
    .filter((f) => !f.split('/').some((s) => SKIP_TOP.has(s) || TEST_DIRS.has(s) || LANGUAGES.python.prune.includes(s)));
  const dirsWith = (re) => [...new Set(manifests.filter((f) => re.test(f)).map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')))];

  const work = goWorkDirs(io);
  for (const dir of work || dirsWith(/(?:^|\/)go\.mod$/)) if (io.exists(join(dir, 'go.mod'))) found.push({ dir, lang: 'go' });

  const cargoRoot = io.exists('Cargo.toml') ? rustManifest(io, '') : null;
  const crates = cargoRoot?.workspace && Array.isArray(cargoRoot.workspace.members)
    ? [...expandMembers(io, cargoRoot.workspace.members), ...(cargoRoot.isPackage ? [''] : [])]
    : dirsWith(/(?:^|\/)Cargo\.toml$/).filter((d) => rustManifest(io, d).isPackage);
  for (const dir of crates) if (io.exists(join(dir, 'Cargo.toml'))) found.push({ dir, lang: 'rust' });

  let pyDirs = dirsWith(/(?:^|\/)(?:pyproject\.toml|setup\.py|setup\.cfg)$/);
  const members = uvMembers(io);
  if (members) pyDirs = [...expandMembers(io, members), ...(pythonManifest(io, '').name ? [''] : [])];
  // A pyproject.toml beside a go.mod or a Cargo.toml (a build of bindings) is that package's, not a second one
  for (const dir of pyDirs) if (!found.some((p) => p.dir === dir) && manifestLanguage(io, dir) === 'python' && (dir !== '' || pythonManifest(io, '').name)) found.push({ dir, lang: 'python' });
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** The members of a uv workspace (`[tool.uv.workspace] members`), or null */
function uvMembers(io) {
  if (!io.exists('pyproject.toml')) return null;
  const text = io.read('pyproject.toml');
  if (!/^\s*\[tool\.uv\.workspace\]/m.test(text)) return null;
  const m = /\[tool\.uv\.workspace\][^[]*?members\s*=\s*\[([^\]]*)\]/s.exec(text);
  return m ? [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]) : [];
}

/** The repo's packages: `[{ dir, lang, name, summary, manifest, deps }]` */
function findPackages(io, options) {
  const rootManifest = readJson(io, 'package.json') || {};
  const ws = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : rootManifest.workspaces?.packages;
  if (Array.isArray(options.packages)) return expandPatterns(options.packages, io).map((dir) => packageAt(io, dir, languageOf(io, dir)));
  const others = otherPackages(io);
  let js = [];
  if (Array.isArray(ws) && ws.length) js = expandPatterns(ws, io);
  else {
    // Each top-level folder with source files: JavaScript ones beside the other languages' packages, any language with none
    const ext = options.extensions || (others.length ? DEFAULT_EXTENSIONS : ALL_EXTENSIONS);
    const near = (d) => others.some((p) => p.dir === '' || p.dir === d || p.dir.startsWith(`${d}/`));
    js = io.list('').filter((d) => !d.startsWith('.') && !SKIP_TOP.has(d) && io.isDir(d) && !near(d) && io.walk(d, (f) => ext.some((e) => f.endsWith(e))).length > 0);
  }
  const jsPackages = js.map((dir) => packageAt(io, dir, others.length || (Array.isArray(ws) && ws.length) ? 'js' : languageOf(io, dir)));
  return [...jsPackages, ...others.filter((p) => !js.includes(p.dir)).map((p) => packageAt(io, p.dir, p.lang))].sort((a, b) => a.dir.localeCompare(b.dir));
}

/** The file a relative import from `from` names, among `files` (extension and index guesses as Node and bundlers make them) */
function resolveRelative(from, spec, files, extensions) {
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const parts = [];
  for (const seg of `${base}/${spec}`.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const target = parts.join('/');
  const candidates = [target, ...extensions.map((e) => `${target}${e}`), ...extensions.map((e) => `${target}/index${e}`)];
  // A TypeScript file imported by its .js name
  if (/\.[cm]?js$/.test(target)) candidates.push(target.replace(/\.([cm]?)js$/, '.$1ts'));
  return candidates.find((c) => files.has(c)) || null;
}

/** The folders a Python package's modules are imported from: the package folder, and its `src` when it has one */
const pythonRoots = (io, dir) => [dir, join(dir, 'src')].filter((d) => d === dir || io.isDir(d));

/** The top-level module names a Python package can be imported by */
function pythonTops(io, p) {
  const tops = new Set();
  if (p.manifest?.name) tops.add(String(p.manifest.name).toLowerCase().replace(/[-.]+/g, '_'));
  for (const root of pythonRoots(io, p.dir)) {
    for (const name of io.list(root)) {
      const at = join(root, name);
      if (io.isDir(at) && io.exists(join(at, '__init__.py'))) tops.add(name);
      else if (/^[A-Za-z_]\w*\.py$/.test(name) && !['setup.py', 'conftest.py'].includes(name)) tops.add(name.slice(0, -3));
    }
  }
  return tops;
}

/** The file a dotted Python module names under one of `roots`, among `files`: `a/b.py` or `a/b/__init__.py` */
function pythonFile(roots, dotted, files) {
  const rel = dotted.split('.').filter(Boolean).join('/');
  for (const root of roots) {
    for (const c of rel ? [join(root, `${rel}.py`), join(root, `${rel}/__init__.py`)] : [join(root, '__init__.py')]) if (files.has(c)) return c;
  }
  return null;
}

const starter = {
  name: 'starter',
  contract: 1,
  owns: ['root', 'pkg', 'core'],

  derive(ctx) {
    const options = ctx.options || {};
    const extOf = (lang) => options.extensions || LANGUAGES[lang].extensions;
    const isTest = (f, lang) => (TEST_FILES[lang] || TEST_FILES.js).test(f) || TEST_FILES.js.test(f) || f.split('/').some((s) => TEST_DIRS.has(s));
    const isSourceOf = (lang) => (f) => extOf(lang).some((e) => f.endsWith(e)) && (options.tests || !isTest(f, lang));
    const rootManifest = readJson(ctx, 'package.json') || {};
    const packages = findPackages(ctx, options);
    const nodes = [{ id: 'root', label: rootManifest.name || ctx.config?.title || 'repo', type: 'root', ...(ctx.exists('package.json') ? { file: 'package.json' } : {}) }];
    const edges = [];
    const warnings = [];

    const ids = packageIds(packages.map((p) => p.dir));
    const pid = (dir) => ids.get(dir);
    const fileOwner = new Map(); // source file -> its package
    for (const p of packages) {
      nodes.push({ id: pid(p.dir), label: p.name, type: 'pkg', ...(p.dir ? { file: p.dir } : {}), ...(p.summary ? { summary: p.summary } : {}) });
      edges.push({ from: 'root', to: pid(p.dir) });
      for (const f of walkPruned(ctx, p.dir, LANGUAGES[p.lang].prune, isSourceOf(p.lang))) {
        // a file of a nested package belongs to the deepest package
        const prev = fileOwner.get(f);
        if (!prev || p.dir.length > prev.dir.length) fileOwner.set(f, p);
      }
    }
    const files = new Set(fileOwner.keys());
    if (options.modules) {
      for (const [f, p] of [...fileOwner].sort(([a], [b]) => a.localeCompare(b))) {
        const summary = p.lang === 'js' ? summaryOf(ctx.read(f)) : docSummary(ctx.read(f), p.lang);
        nodes.push({ id: moduleId(f), label: f.slice(f.lastIndexOf('/') + 1), type: 'core', file: f, ...(summary ? { summary } : {}) });
        edges.push({ from: pid(p.dir), to: moduleId(f) });
      }
    }

    const byName = new Map(packages.filter((p) => p.lang === 'js').map((p) => [p.name, p]));
    const pyTop = new Map();
    for (const p of packages.filter((x) => x.lang === 'python')) for (const t of pythonTops(ctx, p)) if (!pyTop.has(t)) pyTop.set(t, p);
    const pyByName = new Map(packages.filter((p) => p.lang === 'python').map((p) => [pyName(p.name), p]));
    const goMods = packages.filter((p) => p.lang === 'go' && p.manifest?.name).sort((a, b) => b.manifest.name.length - a.manifest.name.length);
    const goOf = (spec) => goMods.find((p) => spec === p.manifest.name || spec.startsWith(`${p.manifest.name}/`)) || null;
    const crates = new Map(packages.filter((p) => p.lang === 'rust' && p.manifest?.name).map((p) => [rustName(p.manifest.name), p]));
    const crateByName = new Map(packages.filter((p) => p.lang === 'rust' && p.manifest?.name).map((p) => [p.manifest.name, p]));

    const pkgLinks = new Map(); // "fromDir|toDir" -> Set of what links them
    const modLinks = new Set();
    const link = (a, b, why) => {
      if (a.dir === b.dir) return;
      const k = `${a.dir}|${b.dir}`;
      if (!pkgLinks.has(k)) pkgLinks.set(k, new Set());
      pkgLinks.get(k).add(why);
    };
    const jsTargets = (file) => importsOf(ctx.read(file)).map((spec) => {
      if (spec.startsWith('.')) {
        const target = resolveRelative(file, spec, files, extOf('js'));
        return { target, pkg: target ? fileOwner.get(target) : null };
      }
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      const pkg = byName.get(name) || null;
      if (!pkg) return { target: null, pkg: null };
      const sub = spec.slice(name.length).replace(/^\//, '');
      const m = pkg.manifest || {};
      const exp = typeof m.exports === 'string' ? m.exports : m.exports?.['.'];
      // The file a bare import lands on: the subpath, else the package's entry, else the usual places of one
      const entries = sub ? [sub, `src/${sub}`] : [exp, m.module, m.main, 'index.js', 'src/index.js'].filter((v) => typeof v === 'string');
      const target = entries.map((e) => resolveRelative(`${pkg.dir}/x`, `./${e.replace(/^\.\//, '')}`, files, extOf('js'))).find(Boolean) || null;
      return { target, pkg };
    });
    const pyTargets = (file) => pythonImports(ctx.read(file)).flatMap(({ module, level, names }) => {
      if (level > 0) {
        // From the file's folder, up a folder per dot after the first
        let base = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
        for (let k = 1; k < level; k++) base = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
        const found = names.length ? names.map((n) => pythonFile([base], module ? `${module}.${n}` : n, files) || pythonFile([base], module, files)) : [pythonFile([base], module, files)];
        return [...new Set(found.filter(Boolean))].map((target) => ({ target, pkg: fileOwner.get(target) }));
      }
      const pkg = pyTop.get(module.split('.')[0]);
      if (!pkg) return [];
      const roots = pythonRoots(ctx, pkg.dir);
      // `from a import b`: the submodule a/b.py when there is one, else a itself
      const found = names.length ? names.map((n) => pythonFile(roots, `${module}.${n}`, files) || pythonFile(roots, module, files)) : [pythonFile(roots, module, files)];
      const targets = [...new Set(found)];
      return targets.map((target) => ({ target, pkg }));
    });
    const goTargets = (file) => goImports(ctx.read(file)).map((spec) => ({ target: null, pkg: goOf(spec) }));
    const rustTargets = (file, owner) => {
      const renamed = owner.manifest?.deps || {};
      return rustUses(ctx.read(file)).map((name) => ({ target: null, pkg: crates.get(name) || crateByName.get(renamed[name]) || null }));
    };
    const TARGETS = { js: jsTargets, python: pyTargets, go: goTargets, rust: rustTargets };

    for (const [file, owner] of fileOwner) {
      for (const { target, pkg } of TARGETS[owner.lang](file, owner)) {
        if (!pkg) continue;
        link(owner, pkg, 'imports');
        if (options.modules && target && target !== file) modLinks.add(`${file}|${target}`);
      }
    }
    // What a manifest declares and nothing imports
    const declaredOn = (p, name) => {
      if (p.lang === 'js') return byName.get(name);
      if (p.lang === 'python') return pyByName.get(pyName(name));
      if (p.lang === 'go') return goMods.find((g) => g.manifest.name === name);
      return crateByName.get(p.manifest?.deps?.[name] || name) || crates.get(name);
    };
    const declaredWhy = new Map();
    for (const p of packages) {
      for (const name of p.deps) {
        const to = declaredOn(p, name);
        if (to && to.dir !== p.dir && !pkgLinks.get(`${p.dir}|${to.dir}`)?.has('imports')) {
          link(p, to, 'declared');
          declaredWhy.set(`${p.dir}|${to.dir}`, DECLARED[p.lang]);
        }
      }
    }
    for (const [k, why] of [...pkgLinks].sort(([a], [b]) => a.localeCompare(b))) {
      const [a, b] = k.split('|');
      edges.push({ from: pid(a), to: pid(b), dashed: true, label: why.has('imports') ? 'imports' : declaredWhy.get(k) || DECLARED.js });
    }
    for (const k of [...modLinks].sort()) {
      const [a, b] = k.split('|');
      edges.push({ from: moduleId(a), to: moduleId(b), dashed: true, label: 'imports' });
    }
    if (!packages.length) warnings.push('starter: no packages found (no npm workspaces, Go modules, Rust crates or Python packages, and no top-level folder with source files). Set derivers: [{ use: "starter", options: { packages: ["src"] } }].');
    return { nodes, edges, warnings, info: { packages: packages.map((p) => ({ id: pid(p.dir), dir: p.dir, name: p.name, language: p.lang })) } };
  },
};

export default starter;

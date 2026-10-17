/**
 * @module plugins/starter
 *
 * The starter deriver: a map of any JavaScript repo with zero plugin code. It reads the packages and
 * the imports between them.
 *
 *  - **Packages.** The npm workspaces of the root package.json (`workspaces: ["packages/*"]`, or
 *    `{ packages: [...] }`); with none, each top-level folder that holds JavaScript. The option
 *    `packages` replaces both with your own list of folders (a trailing `/*` means each folder in it).
 *  - **Modules** (option `modules: true`): one node per source file, under its package.
 *  - **Imports.** Every `import … from`, `export … from`, `import()` and `require()` is resolved: a
 *    relative one to the file it names, a bare one to the workspace package of that name. An import
 *    from one package into another is a dashed edge between them (between the modules too, with
 *    `modules: true`), labelled with what it is. A dependency a package.json declares on another
 *    workspace package and that no file imports is a dashed edge labelled "declared".
 *
 * What it makes:
 *
 *   root                      the repo (its package.json name)
 *   pkg-<folder>              a package: label its package.json name (or the folder), file the folder
 *   core-<path>               a module (with `modules: true`): label the file name, file its path
 *
 * Options: `{ packages?: string[], modules?: boolean, tests?: boolean, extensions?: string[] }`.
 * Test files (`*.test.*`, `*.spec.*`, folders named test, tests or __tests__) are left out unless
 * `tests: true`.
 */

const DEFAULT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'];
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__fixtures__', 'fixtures']);
const SKIP_TOP = new Set(['node_modules', 'dist', 'build', 'coverage', 'docs', 'test', 'tests', 'vendor']);

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

/** The repo's packages: `[{ dir, name, manifest }]` */
function findPackages(io, options) {
  const rootManifest = readJson(io, 'package.json') || {};
  const ws = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : rootManifest.workspaces?.packages;
  let dirs;
  if (Array.isArray(options.packages)) dirs = expandPatterns(options.packages, io);
  else if (Array.isArray(ws) && ws.length) dirs = expandPatterns(ws, io);
  else {
    const ext = options.extensions || DEFAULT_EXTENSIONS;
    dirs = io.list('').filter((d) => !d.startsWith('.') && !SKIP_TOP.has(d) && io.isDir(d) && io.walk(d, (f) => ext.some((e) => f.endsWith(e))).length > 0);
  }
  return dirs.map((dir) => {
    const manifest = readJson(io, `${dir}/package.json`);
    return { dir, name: manifest?.name || dir, manifest };
  });
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

const starter = {
  name: 'starter',
  contract: 1,
  owns: ['root', 'pkg', 'core'],

  derive(ctx) {
    const options = ctx.options || {};
    const extensions = options.extensions || DEFAULT_EXTENSIONS;
    const isSource = (f) => extensions.some((e) => f.endsWith(e)) && (options.tests || (!TEST_FILE.test(f) && !f.split('/').some((s) => TEST_DIRS.has(s))));
    const rootManifest = readJson(ctx, 'package.json') || {};
    const packages = findPackages(ctx, options);
    const nodes = [{ id: 'root', label: rootManifest.name || ctx.config?.title || 'repo', type: 'root', ...(ctx.exists('package.json') ? { file: 'package.json' } : {}) }];
    const edges = [];
    const warnings = [];

    const byName = new Map(packages.map((p) => [p.name, p]));
    const ids = packageIds(packages.map((p) => p.dir));
    const pid = (dir) => ids.get(dir);
    const fileOwner = new Map(); // source file -> its package
    for (const p of packages) {
      nodes.push({ id: pid(p.dir), label: p.name, type: 'pkg', file: p.dir, ...(p.manifest?.description ? { summary: p.manifest.description } : {}) });
      edges.push({ from: 'root', to: pid(p.dir) });
      for (const f of ctx.walk(p.dir, isSource)) {
        // a file of a nested package belongs to the deepest package
        const prev = fileOwner.get(f);
        if (!prev || p.dir.length > prev.dir.length) fileOwner.set(f, p);
      }
    }
    const files = new Set(fileOwner.keys());
    if (options.modules) {
      for (const [f, p] of [...fileOwner].sort(([a], [b]) => a.localeCompare(b))) {
        const summary = summaryOf(ctx.read(f));
        nodes.push({ id: moduleId(f), label: f.slice(f.lastIndexOf('/') + 1), type: 'core', file: f, ...(summary ? { summary } : {}) });
        edges.push({ from: pid(p.dir), to: moduleId(f) });
      }
    }

    const pkgLinks = new Map(); // "fromDir|toDir" -> Set of what links them
    const modLinks = new Set();
    const link = (a, b, why) => {
      if (a.dir === b.dir) return;
      const k = `${a.dir}|${b.dir}`;
      if (!pkgLinks.has(k)) pkgLinks.set(k, new Set());
      pkgLinks.get(k).add(why);
    };
    for (const [file, owner] of fileOwner) {
      for (const spec of importsOf(ctx.read(file))) {
        let target = null;
        let targetPkg = null;
        if (spec.startsWith('.')) {
          target = resolveRelative(file, spec, files, extensions);
          targetPkg = target ? fileOwner.get(target) : null;
        } else {
          const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          targetPkg = byName.get(name) || null;
          if (targetPkg) {
            const sub = spec.slice(name.length).replace(/^\//, '');
            const m = targetPkg.manifest || {};
            const exp = typeof m.exports === 'string' ? m.exports : m.exports?.['.'];
            // The file a bare import lands on: the subpath, else the package's entry, else the usual places of one
            const entries = sub ? [sub, `src/${sub}`] : [exp, m.module, m.main, 'index.js', 'src/index.js'].filter((v) => typeof v === 'string');
            target = entries.map((e) => resolveRelative(`${targetPkg.dir}/x`, `./${e.replace(/^\.\//, '')}`, files, extensions)).find(Boolean) || null;
          }
        }
        if (!targetPkg) continue;
        link(owner, targetPkg, 'imports');
        if (options.modules && target && target !== file) modLinks.add(`${file}|${target}`);
      }
    }
    // What a package.json declares and nothing imports
    for (const p of packages) {
      for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
        for (const name of Object.keys(p.manifest?.[field] || {})) {
          const to = byName.get(name);
          if (to && to.dir !== p.dir && !pkgLinks.get(`${p.dir}|${to.dir}`)?.has('imports')) link(p, to, 'declared');
        }
      }
    }
    for (const [k, why] of [...pkgLinks].sort(([a], [b]) => a.localeCompare(b))) {
      const [a, b] = k.split('|');
      edges.push({ from: pid(a), to: pid(b), dashed: true, label: why.has('imports') ? 'imports' : 'declared in package.json, not imported' });
    }
    for (const k of [...modLinks].sort()) {
      const [a, b] = k.split('|');
      edges.push({ from: moduleId(a), to: moduleId(b), dashed: true, label: 'imports' });
    }
    if (!packages.length) warnings.push('starter: no packages found (no npm workspaces and no top-level folder with source files). Set derivers: [{ use: "starter", options: { packages: ["src"] } }].');
    return { nodes, edges, warnings, info: { packages: packages.map((p) => ({ id: pid(p.dir), dir: p.dir, name: p.name })) } };
  },
};

export default starter;

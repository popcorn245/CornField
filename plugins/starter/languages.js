/**
 * @module plugins/starter/languages
 *
 * What the starter deriver reads in Python, Go and Rust, the way it reads npm workspaces in JavaScript:
 * the packages a repo holds (their manifests, names and descriptions), the dependencies they declare, and
 * what each source file imports. Pure: text in, names out (the manifests' TOML through plugins/starter/toml.js).
 *
 *  - **Python**: a folder with `pyproject.toml` (`[project]`, or `[tool.poetry]`), `setup.py` or `setup.cfg`;
 *    a uv workspace's `members`. `import a.b`, `from a.b import c`, `from . import d`.
 *  - **Go**: the `use` folders of `go.work`, else every folder with a `go.mod`; `module` is its name.
 *    `import "x/y"` and `import ( … )` blocks.
 *  - **Rust**: a Cargo workspace's `members`, else every folder with a `Cargo.toml` that has a `[package]`.
 *    `use crate_name::…`, `extern crate crate_name`, and `crate_name::` paths in the code.
 */

import { parseToml } from './toml.js';

export const LANGUAGES = {
  js: { extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'], prune: [] },
  python: { extensions: ['.py'], prune: ['.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', 'build', 'site-packages'] },
  go: { extensions: ['.go'], prune: ['vendor', 'testdata'] },
  rust: { extensions: ['.rs'], prune: ['target'] },
};

/** Test files of each language, beside the folders named test, tests or __tests__ */
export const TEST_FILES = {
  js: /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  python: /(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/,
  go: /_test\.go$/,
  rust: /(?:^|\/)(?:benches|examples)\//,
};

const readToml = (io, rel) => {
  try { return parseToml(io.read(rel)); } catch (err) { throw new Error(`${rel} is not TOML the starter can read: ${err.message}`); }
};
const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** PEP 503: a Python distribution name, compared lower case with runs of - _ . as one - */
export const pyName = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '-');
/** A Rust crate as the code names it: dashes are underscores */
export const rustName = (n) => String(n).replace(/-/g, '_');

/** The language a folder's manifest says, or null */
export function manifestLanguage(io, dir) {
  if (io.exists(join(dir, 'package.json'))) return 'js';
  if (io.exists(join(dir, 'go.mod'))) return 'go';
  if (io.exists(join(dir, 'Cargo.toml'))) return 'rust';
  if (['pyproject.toml', 'setup.py', 'setup.cfg'].some((f) => io.exists(join(dir, f)))) return 'python';
  return null;
}

// ---------------------------------------------------------------------------
//  Manifests
// ---------------------------------------------------------------------------

/**
 * A Python package's name, description and declared dependencies (distribution names).
 * @returns {{ name: string | null, summary: string | null, deps: string[] }}
 */
export function pythonManifest(io, dir) {
  const out = { name: null, summary: null, deps: [] };
  const py = join(dir, 'pyproject.toml');
  if (io.exists(py)) {
    const t = readToml(io, py);
    const project = isObj(t.project) ? t.project : {};
    const poetry = isObj(t.tool?.poetry) ? t.tool.poetry : {};
    out.name = project.name || poetry.name || null;
    out.summary = project.description || poetry.description || null;
    const reqs = [
      ...(Array.isArray(project.dependencies) ? project.dependencies : []),
      ...Object.values(isObj(project['optional-dependencies']) ? project['optional-dependencies'] : {}).flat(),
      ...Object.values(isObj(t['dependency-groups']) ? t['dependency-groups'] : {}).flat(),
    ].filter((r) => typeof r === 'string');
    out.deps.push(...reqs.map((r) => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(r)?.[1]).filter(Boolean));
    for (const group of [poetry.dependencies, poetry['dev-dependencies'], ...Object.values(isObj(poetry.group) ? poetry.group : {}).map((g) => g && g.dependencies)]) {
      if (isObj(group)) out.deps.push(...Object.keys(group).filter((k) => k.toLowerCase() !== 'python'));
    }
  }
  const cfg = join(dir, 'setup.cfg');
  if (!out.name && io.exists(cfg)) {
    const text = io.read(cfg);
    out.name = /^\s*name\s*=\s*(\S+)/m.exec(text)?.[1] || null;
    out.summary = out.summary || /^\s*description\s*=\s*(.+)$/m.exec(text)?.[1].trim() || null;
  }
  const setup = join(dir, 'setup.py');
  if (!out.name && io.exists(setup)) out.name = /\bname\s*=\s*['"]([^'"]+)['"]/.exec(io.read(setup))?.[1] || null;
  out.deps = [...new Set(out.deps.map(pyName))];
  return out;
}

/** A Go module's path and the modules it requires */
export function goManifest(io, dir) {
  const text = io.read(join(dir, 'go.mod')).replace(/\/\/[^\n]*/g, '');
  const name = /^\s*module\s+(\S+)/m.exec(text)?.[1] || null;
  const deps = [];
  for (const m of text.matchAll(/^\s*require\s+(?:\(([^)]*)\)|(\S+))/gm)) {
    if (m[2]) deps.push(m[2]);
    else for (const l of m[1].split('\n')) { const w = l.trim().split(/\s+/)[0]; if (w) deps.push(w); }
  }
  return { name, summary: null, deps };
}

/** A Rust crate's name, description, and its dependencies as the code names them: `{ code name: crate name }` */
export function rustManifest(io, dir) {
  const t = readToml(io, join(dir, 'Cargo.toml'));
  const pkg = isObj(t.package) ? t.package : {};
  const deps = {};
  const tables = [t.dependencies, t['dev-dependencies'], t['build-dependencies'], ...Object.values(isObj(t.target) ? t.target : {}).flatMap((x) => (isObj(x) ? [x.dependencies, x['dev-dependencies'], x['build-dependencies']] : []))];
  for (const table of tables) {
    if (!isObj(table)) continue;
    for (const [k, v] of Object.entries(table)) deps[rustName(k)] = isObj(v) && typeof v.package === 'string' ? v.package : k;
  }
  return { name: typeof pkg.name === 'string' ? pkg.name : null, summary: typeof pkg.description === 'string' ? pkg.description : null, deps, isPackage: isObj(t.package), workspace: isObj(t.workspace) ? t.workspace : null };
}

/** The folders a workspace's member patterns name (`crates/*`, `packages/*`, `cli`), from `base` */
export function expandMembers(io, patterns, base = '') {
  const dirs = [];
  for (const raw of patterns || []) {
    const p = join(base, String(raw).replace(/^\.\//, '').replace(/\/+$/, ''));
    if (p.endsWith('/*')) {
      const parent = p.slice(0, -2);
      for (const name of io.list(parent)) if (!name.startsWith('.') && io.isDir(join(parent, name))) dirs.push(join(parent, name));
    } else if (io.isDir(p)) dirs.push(p);
  }
  return [...new Set(dirs)];
}

/** The `use` folders of a go.work */
export function goWorkDirs(io) {
  if (!io.exists('go.work')) return null;
  const text = io.read('go.work').replace(/\/\/[^\n]*/g, '');
  const out = [];
  for (const m of text.matchAll(/^\s*use\s+(?:\(([^)]*)\)|(\S+))/gm)) {
    const words = m[2] ? [m[2]] : m[1].split(/\s+/).filter(Boolean);
    for (const w of words) out.push(w.replace(/^\.\/?/, '').replace(/\/+$/, ''));
  }
  return out.filter((d) => d === '' || io.isDir(d));
}

// ---------------------------------------------------------------------------
//  What a file says it is
// ---------------------------------------------------------------------------

/** The first sentence of a text, at most 200 characters, or null */
export function firstSentence(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const first = /^(.+?[.!?])(?:\s|$)/.exec(t);
  const out = (first ? first[1] : t).trim();
  return out ? (out.length > 200 ? `${out.slice(0, 197)}…` : out) : null;
}

/**
 * The first sentence of a file's leading doc text, or null: a Python module docstring, the comment above a
 * Go `package` clause, a Rust file's `//!` lines.
 * @param {string} source
 * @param {'python' | 'go' | 'rust'} lang
 */
export function docSummary(source, lang) {
  if (lang === 'python') {
    const m = /^(?:\s*#[^\n]*\n)*\s*[rRuU]?("""|''')([\s\S]*?)\1/.exec(source);
    return m ? firstSentence(m[2]) : null;
  }
  if (lang === 'go') {
    const m = /^((?:[ \t]*\/\/[^\n]*\n)+)[ \t]*package\s/m.exec(source);
    return m ? firstSentence(m[1].split('\n').map((l) => l.replace(/^\s*\/\/\s?/, '')).join(' ')) : null;
  }
  if (lang === 'rust') {
    const lines = source.split('\n');
    const doc = [];
    for (const l of lines) {
      if (/^\s*\/\/!/.test(l)) doc.push(l.replace(/^\s*\/\/!\s?/, ''));
      else if (doc.length || l.trim()) break;
    }
    return doc.length ? firstSentence(doc.join(' ')) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
//  Imports
// ---------------------------------------------------------------------------

/** Python source without comments and string bodies (a docstring's example is not an import) */
const pythonCode = (s) => s.replace(/("""|''')[\s\S]*?\1/g, '""').replace(/#[^\n]*/g, '');

/**
 * What a Python file imports: `{ module, level, names }` (level: the leading dots of a relative import).
 * @param {string} source
 */
export function pythonImports(source) {
  // One line per statement: backslash continuations and parenthesised lists joined
  const code = pythonCode(source).replace(/\\\n/g, ' ').replace(/\(([^)]*)\)/g, (_, inner) => `(${inner.replace(/\n/g, ' ')})`);
  const out = [];
  for (const raw of code.split('\n')) {
    const l = raw.trim();
    let m = /^import\s+(.+)$/.exec(l);
    if (m) {
      for (const part of m[1].split(',')) {
        const mod = part.trim().split(/\s+/)[0];
        if (/^[\w.]+$/.test(mod)) out.push({ module: mod, level: 0, names: [] });
      }
      continue;
    }
    m = /^from\s+(\.*)([\w.]*)\s+import\s+\(?([^)]*)\)?$/.exec(l);
    if (m) {
      const names = m[3].split(',').map((n) => n.trim().split(/\s+/)[0]).filter((n) => /^\w+$/.test(n));
      out.push({ module: m[2], level: m[1].length, names });
    }
  }
  return out;
}

/** Go source without comments */
const goCode = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** What a Go file imports: the import paths */
export function goImports(source) {
  const code = goCode(source);
  const out = new Set();
  for (const m of code.matchAll(/\bimport\s+(?:\(([^)]*)\)|((?:[\w.]+\s+)?"[^"]+"))/g)) {
    const block = m[1] ?? m[2];
    for (const q of block.matchAll(/"([^"]+)"/g)) out.add(q[1]);
  }
  return [...out];
}

/** Rust source without comments, strings and chars */
const rustCode = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/r#*"[\s\S]*?"#*/g, '""').replace(/"(?:\\.|[^"\\])*"/g, '""');

/** The crate names a Rust file uses: `use x::…`, `extern crate x`, and `x::` paths (filter them by the workspace's crates) */
export function rustUses(source) {
  const code = rustCode(source);
  const out = new Set();
  for (const m of code.matchAll(/\bextern\s+crate\s+(\w+)/g)) out.add(m[1]);
  for (const m of code.matchAll(/(?<![\w:])(?:::)?([a-z_][a-z0-9_]*)::/g)) out.add(m[1]);
  for (const k of ['crate', 'self', 'super', 'std', 'core', 'alloc']) out.delete(k);
  return [...out];
}

/**
 * @module core/deriver-kit
 *
 * The deriver kit: the types of the deriver contract and a test kit for the derivers a repo writes to put
 * its own code on the map (its routes, jobs, queues, whatever cornfield does not know). One import,
 * `cornfield/deriver-kit`, holds all of it:
 *
 *   import { defineDeriver, fixtureRepo, runDeriver, checkDeriver } from 'cornfield/deriver-kit';
 *
 *  - `defineDeriver(d)`: a deriver, checked against the contract now rather than at the first sync, and
 *    typed for the editor.
 *  - `fixtureRepo(files)`: a throwaway repo on disk from `{ path: text }`, or copied from a folder of yours.
 *  - `runDeriver(d, { root | files, options, before })`: what `cornfield sync` and `validate` would make of
 *    it on that repo, without touching a map: its nodes and edges, the map a first sync writes, and every
 *    check `validate` runs on them.
 *  - `checkDeriver(d, …)`: the same, and throws one readable error listing every problem. Works in any
 *    test runner (vitest, node:test, jest, mocha) or none.
 *
 * The contract itself is written down in docs/derivers.md; this guide is docs/deriver-kit.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DERIVER_CONTRACT, deriveTopology, deriverProblems } from './derive.js';
import { planSync, missingPaths } from './sync.js';
import { validateTopology } from './validate.js';
import { repoReader, repoPaths } from './repo.js';
import { BUILTIN_DERIVERS, CORNFIELD_DIR, DEFAULTS } from './config.js';

export { DERIVER_CONTRACT, deriverProblems };

// ---------------------------------------------------------------------------
//  Types (JSDoc: an editor reads them from `cornfield/deriver-kit`)
// ---------------------------------------------------------------------------

/**
 * A node of the map. `type` is one of core/schema.js NODE_THEMES (`app`, `page`, `pkg`, `core`, `service`,
 * `table`, `store`, `external`, `tool`…); which other fields a type carries is in core/sync.js DERIVED_FIELDS.
 * @typedef {object} MapNode
 * @property {string} id unique on the map; by convention `<type>-<name>` (`page-cart`, `svc-mailer`)
 * @property {string} type
 * @property {string} label what the map shows (a page's starts with `/`)
 * @property {string} [file] the file or folder it stands for, relative to the repo (`validate` checks it is there)
 * @property {string} [summary] one line about it, from the code
 * @property {string} [desc] a description; leave it out and `sync` writes one a person can replace
 */

/**
 * An edge of the map. With no `kind` and no `dashed` it is ownership (the parent owns the child); `dashed`
 * is a usage link; a `kind` (core/schema.js EDGE_KINDS: `flow`, `reads`, `writes`, `calls`…) is a typed edge
 * with its own required fields.
 * @typedef {object} MapEdge
 * @property {string} from a node id
 * @property {string} to a node id
 * @property {boolean} [dashed]
 * @property {string} [kind]
 * @property {string} [label]
 */

/**
 * An outside service the code reaches, for the cloud registry (core/cloud.js).
 * @typedef {object} Evidence
 * @property {{ kind: string, value: string }} match what was found (`{ kind: 'host', value: 'api.example.org' }`)
 * @property {string} from the node that reaches it
 * @property {string} [label]
 * @property {string} [file] where it was found
 */

/**
 * The readers a deriver gets, rooted at the repo (core/repo.js). Paths are relative, with forward slashes;
 * text is read with LF line ends.
 * @typedef {object} RepoReader
 * @property {string} root the repo's absolute folder
 * @property {(rel: string) => string} read
 * @property {(rel: string) => boolean} exists
 * @property {(rel: string) => boolean} isDir
 * @property {(rel: string) => string[]} list a folder's entries, sorted
 * @property {(rel: string, test?: (file: string) => boolean) => string[]} walk every file under a folder that `test` accepts, skipping node_modules, .git and the like
 */

/**
 * What `derive(ctx)` is handed.
 * @typedef {RepoReader & {
 *   config: Record<string, any>,
 *   options: Record<string, any>,
 *   nodes: readonly MapNode[],
 *   edges: readonly MapEdge[],
 *   evidence: readonly Evidence[],
 *   info: Record<string, any>,
 *   map: { nodes: MapNode[], edges: MapEdge[] },
 * }} DeriverContext
 *   `config` the whole loaded config, `options` this deriver's own, `nodes` / `edges` / `evidence` / `info`
 *   what the derivers before it made (read-only), `map` the committed topology.json (empty before the first sync)
 */

/**
 * What `derive(ctx)` returns (or resolves to).
 * @typedef {object} DeriverResult
 * @property {MapNode[]} nodes
 * @property {MapEdge[]} edges
 * @property {string[]} [warnings] printed by `sync` and `status`, never fatal
 * @property {string[]} [problems] fail `validate`
 * @property {string[]} [ownedIds] single nodes it owns though their type is not in `owns`
 * @property {string[]} [pageOwners] apps whose pages it reads: `sync` removes their other pages
 * @property {Evidence[]} [evidence] outside services the code reaches
 * @property {any} [info] anything, handed to later derivers as `ctx.info[name]`
 */

/**
 * A deriver, contract 1 (docs/derivers.md).
 * @typedef {object} Deriver
 * @property {string} name shown in messages; the key of its `info`
 * @property {1} contract the contract it was written for (DERIVER_CONTRACT)
 * @property {string[]} [owns] node types it derives every node of: `sync` removes any other node of them
 * @property {(ctx: DeriverContext) => DeriverResult | Promise<DeriverResult>} derive
 * @property {(ctx: RepoReader & { config: Record<string, any>, options: Record<string, any> }, topology: { nodes: MapNode[], edges: MapEdge[] }) => string[] | Promise<string[]>} [validate]
 *   more checks `validate` runs on the committed map
 */

/**
 * A deriver to run before the one under test: a built-in's name (`'starter'`), a deriver, or `{ deriver | use, options }`.
 * @typedef {string | Deriver | { deriver?: Deriver, use?: string, options?: Record<string, any> }} BeforeEntry
 */

/**
 * What `runDeriver` found.
 * @typedef {object} DeriverRun
 * @property {string} root the repo it ran on
 * @property {MapNode[]} nodes what this deriver made
 * @property {MapEdge[]} edges
 * @property {string[]} warnings this deriver's warnings
 * @property {string[]} problems this deriver's own problems (they fail `validate`)
 * @property {any} info this deriver's `info`
 * @property {DeriverResult} result what `derive` returned, as it returned it
 * @property {object} derived every deriver's output merged, as `sync` sees it (core/derive.js)
 * @property {{ nodes: MapNode[], edges: MapEdge[] }} topology the map a sync writes from it (over `map`, or an empty one)
 * @property {string[]} changes what that sync changed
 * @property {string[]} schemaProblems the schema's verdict on that map (core/validate.js validateTopology)
 * @property {string[]} pathProblems files the map names that are not in the repo
 * @property {string[]} validateProblems what the deriver's own `validate` says of that map
 * @property {string[]} driftProblems what a second sync would still change (a stable deriver changes nothing)
 * @property {string[]} unowned nodes it makes that it does not own: a sync never removes them once the code drops them
 */

// ---------------------------------------------------------------------------
//  Writing one
// ---------------------------------------------------------------------------

/**
 * A deriver, checked against the contract (a name, `contract: 1`, `derive`, a list `owns`, a function
 * `validate`). Returns it as it is; typed, so an editor checks `derive(ctx)` and its result.
 * @template {Deriver} T
 * @param {T} deriver
 * @returns {T}
 * @throws {TypeError} naming what is wrong
 */
export function defineDeriver(deriver) {
  const problems = deriverProblems(deriver);
  if (problems.length) throw new TypeError(problems.join(' '));
  return deriver;
}

// ---------------------------------------------------------------------------
//  A repo to run it on
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FixtureRepo
 * @property {string} root its absolute folder
 * @property {(files: Record<string, string | object>) => FixtureRepo} write adds or replaces files (an object is written as JSON)
 * @property {(rel: string) => void} remove deletes one file or folder of it
 * @property {(rel: string) => string} read
 * @property {() => void} cleanup deletes the whole repo (also `using repo = fixtureRepo(…)`)
 */

/** Refuses a path that leaves the fixture */
function inside(root, rel) {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`"${rel}" leaves the fixture repo.`);
  return abs;
}

/**
 * A throwaway repo on disk, in the system's temp folder.
 * @param {Record<string, string | object>} [files] `{ 'apps/api/routes/cart.js': 'export …' }`; an object value is written as JSON
 * @param {{ from?: string }} [opts] `from`: a folder to copy first (your own fixture, `test/fixtures/my-repo`), then `files` over it
 * @returns {FixtureRepo}
 */
export function fixtureRepo(files = {}, { from } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-fixture-')));
  if (from) {
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) throw new Error(`fixtureRepo: ${from} is not a folder.`);
    fs.cpSync(from, root, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)$/.test(src) });
  }
  const repo = {
    root,
    write(more) {
      for (const [rel, content] of Object.entries(more)) {
        const abs = inside(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
      }
      return repo;
    },
    remove(rel) { fs.rmSync(inside(root, rel), { recursive: true, force: true }); },
    read: (rel) => fs.readFileSync(inside(root, rel), 'utf8'),
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
    [Symbol.dispose]() { repo.cleanup(); },
  };
  return repo.write(files);
}

// ---------------------------------------------------------------------------
//  Running it
// ---------------------------------------------------------------------------

/** A `before` entry as `{ deriver, options }`, loading a built-in by name */
async function entryOf(e) {
  const use = typeof e === 'string' ? e : e && !e.derive && typeof e.use === 'string' ? e.use : null;
  if (use) {
    if (!BUILTIN_DERIVERS[use]) throw new Error(`"${use}" is not a built-in deriver (${Object.keys(BUILTIN_DERIVERS).join(', ')}); pass the deriver itself.`);
    const mod = await import(pathToFileURL(path.join(CORNFIELD_DIR, BUILTIN_DERIVERS[use])).href);
    return { deriver: mod.default, options: (typeof e === 'object' && e.options) || {} };
  }
  if (e && typeof e.derive === 'function') return { deriver: e, options: {} };
  if (e && e.deriver) return { deriver: e.deriver, options: e.options || {} };
  throw new Error('A "before" entry is a built-in name, a deriver, or { deriver, options }.');
}

/** A config as `loadConfig` would give it for a repo with no config file, with `config` over it */
function configFor(root, config) {
  const base = structuredClone({ ...DEFAULTS, sources: { ...DEFAULTS.sources }, personas: { ...DEFAULTS.personas }, cloud: { ...DEFAULTS.cloud } });
  return { ...base, title: path.basename(root), ...config, root, configFile: null };
}

/**
 * Runs a deriver on a repo as `cornfield sync` and `validate` would, and reports what they would make of it.
 * Nothing is written to the repo.
 * @param {Deriver} deriver
 * @param {{
 *   root?: string, files?: Record<string, string | object>, options?: Record<string, any>,
 *   config?: Record<string, any>, before?: BeforeEntry[], map?: { nodes: MapNode[], edges: MapEdge[] } | null,
 * }} [opts]
 *   `root` a repo folder, or `files` for a throwaway one (removed after); `options` the deriver's own;
 *   `config` keys over the defaults; `before` the derivers that run first (`['starter']`); `map` a committed
 *   map to sync over (default: a first sync)
 * @returns {Promise<DeriverRun>}
 */
export async function runDeriver(deriver, { root, files, options = {}, config = {}, before = [], map = null } = {}) {
  const bad = deriverProblems(deriver);
  if (bad.length) throw new TypeError(bad.join(' '));
  if (!root && !files) throw new Error('runDeriver needs a repo: { root } or { files }.');
  if (root && files) throw new Error('runDeriver takes { root } or { files }, not both: write the files with fixtureRepo(…).write().');
  const temp = root ? null : fixtureRepo(files);
  try {
    const dir = root ? path.resolve(root) : temp.root;
    const cfg = configFor(dir, config);
    let result;
    // The deriver under test, wrapped to keep what it returned, with `this` as the deriver
    const watched = { ...deriver, derive: async (ctx) => (result = await deriver.derive.call(deriver, ctx)) };
    const derivers = [...(await Promise.all(before.map(entryOf))), { deriver: watched, options }];
    const committed = map ? { nodes: map.nodes || [], edges: map.edges || [] } : { nodes: [], edges: [] };
    const derived = await deriveTopology({ root: dir, config: cfg, derivers, map: committed });
    const own = result || {};
    const { next, changes } = planSync(committed, derived);
    const topology = { nodes: next.nodes, edges: next.edges };
    const driftProblems = planSync(next, derived).changes.map((c) => `a second sync still changes: ${c}`);
    const ownedTypes = new Set(derived.ownedTypes);
    const ownedIds = new Set(derived.ownedIds);
    const pageApps = new Set(derived.pageOwners);
    const parentOf = new Map(derived.edges.filter((e) => !e.kind && !e.dashed).map((e) => [e.to, e.from]));
    const unowned = (own.nodes || [])
      .filter((n) => !ownedTypes.has(n.type) && !ownedIds.has(n.id) && !(n.type === 'page' && pageApps.has(parentOf.get(n.id))))
      .map((n) => n.id);
    let validateProblems = [];
    if (typeof deriver.validate === 'function') {
      try {
        validateProblems = await deriver.validate.call(deriver, { ...repoReader(dir), config: cfg, options }, topology);
      } catch (err) {
        validateProblems = [`validate() threw: ${err.message}`];
      }
    }
    return {
      root: dir,
      nodes: own.nodes || [],
      edges: own.edges || [],
      warnings: own.warnings || [],
      problems: own.problems || [],
      info: own.info,
      result: own,
      derived,
      topology,
      changes,
      schemaProblems: validateTopology(topology),
      pathProblems: missingPaths({ nodes: topology.nodes.filter((n) => (own.nodes || []).some((m) => m.id === n.id)), edges: [] }, repoPaths(dir)),
      validateProblems,
      driftProblems,
      unowned,
    };
  } finally {
    temp?.cleanup();
  }
}

/**
 * Every problem in a run, one line each: the deriver's own problems, the schema, files that are not
 * there, its `validate`, drift on a second sync, and (unless `allowUnowned`) nodes nothing owns.
 * @param {DeriverRun} run
 * @param {{ allowUnowned?: boolean }} [opts]
 * @returns {string[]}
 */
export function runProblems(run, { allowUnowned = false } = {}) {
  return [
    ...run.problems.map((p) => `problem: ${p}`),
    ...run.schemaProblems.map((p) => `schema: ${p}`),
    ...run.pathProblems.map((p) => `paths: ${p}`),
    ...run.validateProblems.map((p) => `validate: ${p}`),
    ...run.driftProblems.map((p) => `drift: ${p}`),
    ...(allowUnowned ? [] : run.unowned.map((id) => `owns: it makes "${id}" but does not own it (add its type to "owns", or its id to "ownedIds"): sync would keep it after the code drops it`)),
  ];
}

/**
 * `runDeriver`, then throws if anything `cornfield validate` would fail on (see `runProblems`). The one call
 * a test needs: `const run = await checkDeriver(myDeriver, { files: { … } })`.
 * @param {Deriver} deriver
 * @param {Parameters<typeof runDeriver>[1] & { allowUnowned?: boolean }} [opts]
 * @returns {Promise<DeriverRun>} the run, to assert on its nodes and edges
 * @throws {Error} listing every problem
 */
export async function checkDeriver(deriver, { allowUnowned, ...opts } = {}) {
  const run = await runDeriver(deriver, opts);
  const problems = runProblems(run, { allowUnowned });
  if (problems.length) {
    const err = new Error(`Deriver "${deriver.name}" would fail cornfield validate (${problems.length}):\n  - ${problems.join('\n  - ')}`);
    err.problems = problems;
    err.run = run;
    throw err;
  }
  return run;
}

/**
 * @module core/derive
 *
 * Running the derivers: the plugins that read a repo's code and say which nodes and edges the map
 * must hold. cornfield ships some (plugins/starter, plugins/personas, plugins/cloud); a repo can add
 * its own in cornfield.config.js. The contract is versioned (`DERIVER_CONTRACT`) and written down in
 * docs/derivers.md.
 *
 * A deriver, contract 1:
 *
 *   {
 *     name: 'starter',                 // shown in messages
 *     contract: 1,                     // the contract it was written for
 *     owns?: ['pkg'],                  // node types it derives every node of: `sync` removes any other node of them
 *     derive(ctx) → {                  // may be async
 *       nodes: Node[], edges: Edge[],
 *       warnings?: string[],           // printed by `sync` and `status`, never fatal
 *       problems?: string[],           // fail `validate`
 *       ownedIds?: string[],           // single nodes it owns even though their type is not in `owns`
 *       pageOwners?: string[],         // apps whose pages it reads: `sync` removes their other pages
 *       evidence?: Evidence[],         // what outside services the code reaches, for the cloud registry (core/cloud.js)
 *       info?: object,                 // anything else, handed to later derivers as ctx.info[name]
 *     },
 *     validate?(ctx, topology) → string[]   // extra checks `validate` runs on the committed map
 *   }
 *
 * `ctx` is `{ root, read, exists, isDir, list, walk, config, options, nodes, edges, evidence, info, map }`:
 * the repo readers (core/repo.js), the whole config, this deriver's own options, what the derivers
 * before it made (read-only), so a later one can attach edges to earlier nodes, and `map`, the committed
 * topology.json (`{ nodes, edges }`, empty before the first sync), whose hand-written nodes a deriver may
 * point at. Derivers run in the
 * order the config lists them. A deriver that no longer recognises the code it reads throws, rather
 * than guessing; the error names it.
 *
 * The contract's types (JSDoc) and a test kit for a repo's own derivers are core/deriver-kit.js,
 * exported as `cornfield/deriver-kit`.
 */

import { repoReader } from './repo.js';
import { claimKey, edgeCategory } from './sync.js';

/** The deriver contract this cornfield speaks */
export const DERIVER_CONTRACT = 1;

/**
 * What is wrong with a deriver object, before it runs.
 * @param {any} d
 * @returns {string[]}
 */
export function deriverProblems(d) {
  const name = d && typeof d.name === 'string' && d.name ? d.name : '(no name)';
  const problems = [];
  if (!d || typeof d !== 'object') return ['A deriver is an object with a name, a contract and derive().'];
  if (typeof d.name !== 'string' || !d.name) problems.push('A deriver needs a "name".');
  if (d.contract !== DERIVER_CONTRACT) problems.push(`Deriver "${name}" is written for contract ${JSON.stringify(d.contract)}; this cornfield speaks contract ${DERIVER_CONTRACT}.`);
  if (typeof d.derive !== 'function') problems.push(`Deriver "${name}" has no derive(ctx) function.`);
  if (d.owns !== undefined && (!Array.isArray(d.owns) || d.owns.some((t) => typeof t !== 'string'))) problems.push(`Deriver "${name}": "owns" is a list of node types.`);
  if (d.validate !== undefined && typeof d.validate !== 'function') problems.push(`Deriver "${name}": "validate" is a function.`);
  return problems;
}

/**
 * Runs every deriver over the repo and merges what they made.
 * @param {{ root: string, config?: object, derivers: { deriver: object, options?: object }[], map?: { nodes: any[], edges: any[] } | null }} opts
 * @returns {Promise<{ nodes: any[], edges: any[], warnings: string[], problems: string[], ownedTypes: string[], ownedIds: string[], pageOwners: string[], evidence: any[], info: Record<string, any>, madeBy: Record<string, string>, claims: string[] }>}
 *   `madeBy` names the deriver of each node; `claims` (core/sync.js `claimKey`) say, per deriver and edge
 *   category, at which end and of which type its own nodes sit, so `sync` only takes away an edge the
 *   deriver that emits its kind would have made
 */
export async function deriveTopology({ root, config = {}, derivers, map = null }) {
  const io = repoReader(root);
  const committed = map && Array.isArray(map.nodes) ? { nodes: map.nodes, edges: Array.isArray(map.edges) ? map.edges : [] } : { nodes: [], edges: [] };
  const out = { nodes: [], edges: [], warnings: [], problems: [], ownedTypes: [], ownedIds: [], pageOwners: [], evidence: [], info: {} };
  const seen = new Map();
  const emitted = [];
  for (const { deriver, options = {} } of derivers) {
    const bad = deriverProblems(deriver);
    if (bad.length) throw new Error(bad.join(' '));
    let result;
    try {
      result = await deriver.derive({ ...io, config, options, nodes: out.nodes, edges: out.edges, evidence: out.evidence, info: out.info, map: committed });
    } catch (err) {
      throw new Error(`Deriver "${deriver.name}" failed: ${err.message}`, { cause: err });
    }
    result = result || {};
    for (const n of result.nodes || []) {
      if (seen.has(n.id)) throw new Error(`Deriver "${deriver.name}" makes node "${n.id}", which deriver "${seen.get(n.id)}" already made.`);
      seen.set(n.id, deriver.name);
      out.nodes.push(n);
    }
    out.edges.push(...(result.edges || []));
    emitted.push([deriver.name, result.edges || []]);
    out.warnings.push(...(result.warnings || []));
    out.problems.push(...(result.problems || []));
    out.ownedIds.push(...(result.ownedIds || []));
    out.pageOwners.push(...(result.pageOwners || []));
    out.evidence.push(...(result.evidence || []));
    for (const t of deriver.owns || []) if (!out.ownedTypes.includes(t)) out.ownedTypes.push(t);
    if (result.info !== undefined) out.info[deriver.name] = result.info;
  }
  const typeOf = new Map(out.nodes.map((n) => [n.id, n.type]));
  const claims = new Set();
  for (const [name, edges] of emitted) {
    for (const e of edges) {
      for (const end of ['from', 'to']) if (seen.get(e[end]) === name) claims.add(claimKey(name, edgeCategory(e), end, typeOf.get(e[end])));
    }
  }
  return { ...out, madeBy: Object.fromEntries(seen), claims: [...claims] };
}

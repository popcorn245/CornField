/**
 * @module core/sync
 *
 * Keeping `topology.json` true to the code. The derivers (core/derive.js) say what the code shows;
 * `planSync(topology, derived)` works out what `cornfield sync` must change so the map matches:
 * derived nodes added, updated or removed, derived edges replaced, and hand-written edges that lost
 * an end dropped. Hand-written parts (descriptions, flows, render notes, anything of a type no deriver
 * owns) are kept. `cornfield validate` runs the same plan and fails when it is not empty (drift).
 *
 * Pure: no files are read here. The CLI reads and writes.
 */

import { NODE_THEMES } from './schema.js';

/** Per type, the fields the code decides; the rest (desc, render notes…) are hand-written */
export const DERIVED_FIELDS = {
  root: ['label', 'file'],
  app: ['label', 'file', 'url', 'upstreams', 'stack', 'deployed', 'vars'],
  pkg: ['label', 'file', 'summary'],
  page: ['label', 'file', 'methods', 'render_fn', 'render', 'external'],
  table: ['label', 'type', 'table', 'model', 'file'],
  atom: ['label', 'file', 'vars'],
  molecule: ['label', 'type', 'file', 'model', 'table', 'vars'],
  core: ['label', 'file', 'summary'],
  token: ['label', 'file', 'vars'],
  service: ['label', 'kind', 'file', 'triggers', 'jobs', 'mechanisms', 'summary'],
  // A cloud node's fields come from topology.cloud.json (core/cloud.js)
  external: ['label', 'kind', 'file', 'host', 'modules', 'summary', 'desc', 'roles', 'breaks', 'plan'],
  stack: ['label', 'file', 'services'],
  persona: ['label', 'file', 'desc', 'role', 'groups', 'account'],
  machine: ['label', 'file', 'hostname', 'virtual', 'code'],
  // `selfHosted` and `summary` on a container are a person's call (an outside system you run yourself), so they stay hand-written
  container: ['label', 'file', 'stack', 'service', 'image', 'ports'],
  device: ['label', 'file', 'kind', 'camera', 'enabled'],
  tool: ['label', 'file', 'url'],
  store: ['label', 'file'],
};

/** An edge's category: `own` (ownership), `dashed` (a usage link), `flow:<flow>`, or its kind */
export const edgeCategory = (e) => (e.kind === 'flow' ? `flow:${e.flow}` : e.kind || (e.dashed ? 'dashed' : 'own'));

/** A deriver's claim: it emits `category` edges with a node of its own, of `type`, at `end` ('from' or 'to') */
export const claimKey = (deriver, category, end, type) => `${deriver}|${category}|${end}|${type}`;

/** How an edge is told apart when the map is compared with the code */
export const syncEdgeKey = (e) => `${e.from}|${e.to}|${e.kind === 'flow' ? `flow:${e.flow}` : e.kind || (e.dashed ? 'dashed' : 'own')}`;

/** The description `sync` writes on a node it adds; a hand-written one replaces it */
export function defaultDesc(n) {
  if (n.type === 'root') return `${n.label}: the repo.`;
  if (n.type === 'table') return `SQL table ${n.table}${n.model ? `, the ${n.model} model` : ''} (${n.file}).`;
  if (n.type === 'service') return `${n.summary ? `${n.summary} ` : ''}A ${n.kind} service (${n.file})${n.triggers ? `, started by: ${n.triggers.join('; ')}` : ''}.`;
  if (n.type === 'external') return n.desc ?? `${n.summary || n.label}${n.host ? ` Runs here as ${n.host}.` : ''}`;
  if (n.type === 'stack') return `Docker compose stack (${n.file}): ${(n.services || []).map((s) => s.name).join(', ')}.`;
  if (n.type === 'pkg') return `${n.summary || `The ${n.label} workspace package`} (${n.file}).`;
  if (n.type === 'token') return `${(n.vars || []).length} design tokens (${n.file}).`;
  if (n.type === 'app') return n.deployed ? `Served at ${n.url} → ${(n.upstreams || []).join(', ')}${n.stack ? ` [${n.stack}]` : ''}.` : 'Not deployed by any stack in this repo.';
  if (n.type === 'persona') return n.desc;
  if (n.type === 'machine') return `Machine ${n.hostname}${n.virtual ? ', a virtual machine' : ''} (${n.file})${n.code ? `, runs ${n.code.join(', ')}` : ''}.`;
  if (n.type === 'container') return `Container ${n.label}: service ${n.service} of ${n.stack} (${n.file})${n.image ? `, image ${n.image}` : ''}${(n.ports || []).length ? `, ports ${n.ports.join(', ')}` : ''}.`;
  if (n.type === 'device') return `A ${n.kind} (${n.file})${n.enabled === false ? ', turned off there' : ''}.`;
  if (n.type === 'tool' || n.type === 'store') return `${n.label} (${n.file}).`;
  if (n.type === 'core' && n.summary) return `${n.summary} (${n.file})`;
  if (n.type === 'page') return n.methods ? `${n.methods.join(' · ')} ${n.label}` : `Rendered by ${n.render_fn || n.file} (${n.file}).`;
  return `<${n.label}>${n.model ? `, a record element for ${n.table} (${n.model})` : ''}, defined in ${n.file}.`;
}

// A repo path cited in prose: dir/dir/file.ext, or anything under a common top-level directory
const CITED_PATH = /(?:^|[\s(`'"[])((?:[\w@.-]+\/)+[\w@-]+\.(?:json|js|ts|mjs|md|html|css|yml|yaml|sql|astro|sh)|(?:apps|packages|scripts|docs|stacks|core|server|explorer|plugins|cli)\/[\w@./-]*[\w@-])/g;

/**
 * Paths a node or edge names that are not in the repo: a `file` that is gone, or a path cited in a
 * description, summary, render note or edge label. A cited path may be relative to an app or package
 * (`lib/outbox.ts`), so it counts when it is a path suffix of anything in the repo.
 * @param {{ nodes: any[], edges: any[] }} topology
 * @param {Set<string>} paths every path in the repo (core/repo.js `repoPaths`)
 * @returns {string[]}
 */
export function missingPaths(topology, paths) {
  const all = [...paths];
  const exists = (p) => paths.has(p) || all.some((q) => q.endsWith(`/${p}`));
  const found = [];
  const check = (where, text) => {
    for (const m of String(text || '').matchAll(CITED_PATH)) {
      const p = m[1].replace(/\/+$/, '');
      if (!exists(p)) found.push(`${where} cites ${p}, which is not in the repo`);
    }
  };
  for (const n of topology.nodes) {
    for (const f of String(n.file || '').split(/,\s*/).filter(Boolean)) {
      if (!paths.has(f)) found.push(`Node "${n.id}" has file "${f}", which is not in the repo`);
    }
    check(`Node "${n.id}" description`, n.desc);
    check(`Node "${n.id}" summary`, n.summary);
    check(`Node "${n.id}" render note`, n.render?.note);
  }
  for (const e of topology.edges) check(`Edge ${e.from} -> ${e.to} label`, e.label);
  return found;
}

/** The nodes whose description is still the one `sync` generated, counted per app (null: no app above it) */
export function placeholderCounts(topology) {
  const parent = {};
  topology.edges.forEach((e) => { if (!e.kind && !e.dashed && !parent[e.to]) parent[e.to] = e.from; });
  const byId = new Map(topology.nodes.map((n) => [n.id, n]));
  const appOf = (id) => {
    for (let cur = id, hops = 0; cur && hops < 8; cur = parent[cur], hops++) if (byId.get(cur)?.type === 'app') return cur;
    return null;
  };
  const counts = new Map();
  for (const n of topology.nodes) {
    // A description a file decides (a persona's, a cloud node's) is not a placeholder
    if (!n.desc || !NODE_THEMES[n.type] || n.desc !== defaultDesc(n) || DERIVED_FIELDS[n.type]?.includes('desc')) continue;
    const app = appOf(n.id);
    counts.set(app, (counts.get(app) || 0) + 1);
  }
  return counts;
}

/**
 * What `sync` would change to make topology.json match the code: derived nodes added, updated or
 * removed, derived edges replaced, and hand-written edges that lost an end.
 * @param {{ nodes: any[], edges: any[] }} topology the map as committed (an empty one for a first sync)
 * @param {{ nodes: any[], edges: any[], ownedTypes?: string[], ownedIds?: string[], pageOwners?: string[], madeBy?: Record<string, string>, claims?: string[] }} derived
 *   what core/derive.js returned: `ownedTypes` are the types whose every node comes from a deriver,
 *   `ownedIds` single nodes a deriver owns, `pageOwners` the apps whose pages a deriver reads, `madeBy`
 *   the deriver that made each node, `claims` which edges each deriver speaks for (`claimKey`)
 * @returns {{ next: object, changes: string[] }} the next topology and one line per change (empty when in sync)
 */
export function planSync(topology, derived) {
  const changes = [];
  const ownedTypes = new Set(derived.ownedTypes || []);
  const dById = new Map(derived.nodes.map((n) => [n.id, n]));
  // Pages are owned only under apps whose routes a deriver reads; any other app keeps its hand-written pages
  const pageApps = new Set(derived.pageOwners || []);
  const parent = {};
  topology.edges.forEach((e) => { if (!e.kind && !e.dashed && !parent[e.to]) parent[e.to] = e.from; });
  const ownedIds = new Set(derived.ownedIds || []);
  // A page under an app that has left the code goes with it
  const typeOfNode = new Map(topology.nodes.map((n) => [n.id, n.type]));
  const gone = (id) => typeOfNode.get(id) === 'app' && ownedTypes.has('app') && !dById.has(id);
  const owned = (n) => ownedTypes.has(n.type) || ownedIds.has(n.id) || (n.type === 'page' && (pageApps.has(parent[n.id]) || gone(parent[n.id])));
  const short = (v) => (v === undefined ? '∅' : JSON.stringify(v).slice(0, 60));

  const nodes = [];
  for (const n0 of topology.nodes) {
    // The explorer lays nodes out itself and never reads a stored position
    let n = n0;
    if ('x' in n || 'y' in n) {
      const { x, y, ...rest } = n;
      n = rest;
      changes.push(`${n.id}: drop x/y (the explorer lays the map out itself)`);
    }
    const d = dById.get(n.id);
    if (!d) {
      if (owned(n)) changes.push(`remove ${n.type} ${n.id} (${n.label})`);
      else nodes.push(n);
      continue;
    }
    const next = { ...n };
    for (const f of DERIVED_FIELDS[d.type] || ['label', 'file']) {
      let v = f === 'type' ? d.type : d[f];
      // A page's render mode comes from the code, its note stays hand-written
      if (f === 'render' && v && next.render) v = { ...next.render, ...v };
      if (f === 'render' && !v) continue;
      if (v === undefined || v === null) {
        if (f in next && !['label', 'type', 'file'].includes(f)) { changes.push(`${n.id}: ${f} ${short(next[f])} → ∅`); delete next[f]; }
      } else if (JSON.stringify(next[f]) !== JSON.stringify(v)) {
        changes.push(`${n.id}: ${f} ${short(next[f])} → ${short(v)}`);
        next[f] = v;
      }
    }
    if (next.type !== d.type) { changes.push(`${n.id}: type ${next.type} → ${d.type}`); next.type = d.type; }
    const theme = NODE_THEMES[next.type];
    if (theme && (next.color !== theme.color || next.r === undefined)) { next.color = theme.color; next.r = next.r ?? theme.r; }
    nodes.push(next);
  }
  const have = new Set(topology.nodes.map((n) => n.id));
  for (const d of derived.nodes) {
    if (have.has(d.id)) continue;
    const theme = NODE_THEMES[d.type] || { r: 18, color: '#94a3b8' };
    const fresh = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null && v !== undefined));
    nodes.push({ ...fresh, r: theme.r, color: theme.color, desc: d.desc ?? defaultDesc(d) });
    changes.push(`add ${d.type} ${d.id} (${d.label})`);
  }

  const ids = new Set(nodes.map((n) => n.id));
  // Which edges are the derivers': an edge of a category some deriver emits (an ownership edge, a usage link,
  // `reads`, a `flow` of one kind …) that touches what they derive. Ownership: the child is derived (a parent,
  // derived or hand-written, owning a derived node). A usage link (dashed): both ends are derived. Any other
  // kind: an end is a node of the deriver that emits the kind, at the end where that deriver puts such a node
  // (`claims`, from core/derive.js). The cloud deriver's `calls` go into its externals, so a hand-written
  // `calls` into a compose container stays; the compose deriver's `runs-on` go from an app into its stacks,
  // so a hand-written `runs-on` from a stack to a machine stays. Without `claims` (a plan built by hand),
  // either end being derived is enough. Everything else is hand-written and stays, unless an end is gone.
  const category = edgeCategory;
  const derivedKinds = new Set(derived.edges.map(category));
  const claims = Array.isArray(derived.claims) ? new Set(derived.claims) : null;
  const madeBy = derived.madeBy || {};
  const typeOf = (id) => dById.get(id)?.type || typeOfNode.get(id);
  const claimed = (e, c, end) => !!madeBy[e[end]] && claims.has(claimKey(madeBy[e[end]], c, end, typeOf(e[end])));
  const derivedCategory = (e) => {
    const c = category(e);
    if (!derivedKinds.has(c)) return false;
    if (c === 'own') return dById.has(e.to);
    if (c === 'dashed') return dById.has(e.from) && dById.has(e.to);
    if (claims) return claimed(e, c, 'from') || claimed(e, c, 'to');
    return dById.has(e.from) || dById.has(e.to);
  };
  const wanted = new Map(derived.edges.map((e) => [syncEdgeKey(e), e]));
  const edges = [];
  const kept = new Set();
  for (const e of topology.edges) {
    // An edge a deriver makes as it stands is the deriver's, whatever its ends
    if (derivedCategory(e) || wanted.has(syncEdgeKey(e))) {
      const d = wanted.get(syncEdgeKey(e));
      if (!d) { changes.push(`remove edge ${syncEdgeKey(e)}`); continue; }
      if (kept.has(syncEdgeKey(e))) continue;
      if (JSON.stringify(e) !== JSON.stringify(d)) changes.push(`update edge ${syncEdgeKey(e)}`);
      edges.push(d);
      kept.add(syncEdgeKey(e));
    } else if (!ids.has(e.from) || !ids.has(e.to)) {
      changes.push(`drop hand-written edge ${syncEdgeKey(e)}${e.label ? ` "${e.label}"` : ''}: an end no longer exists`);
    } else edges.push(e);
  }
  for (const [k, d] of wanted) if (!kept.has(k)) { edges.push(d); changes.push(`add edge ${k}`); }

  return { next: { ...topology, nodes, edges }, changes };
}

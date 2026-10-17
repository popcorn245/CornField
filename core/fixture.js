/**
 * @module core/fixture
 *
 * A synthetic topology to measure the explorer on (TOPO-01, spec 0012 A6). The real map
 * has ~470 nodes; the renderer has to hold a median frame under 8 ms on a map ten times that, so
 * this builds one: default 5,000 nodes and 15,000 edges, in the shape of `topology.json`
 * (`{ version, updatedAt, nodes, edges }`), with the real map's share of node types and of
 * edge kinds and a believable ownership tree (root → apps → pages, packages → components and
 * tokens, a store → its tables, a stack per few apps) so the orbit, lanes and freeform layouts
 * work on it as they do on the real map.
 *
 * Pure and deterministic: a seeded PRNG, no `Math.random`, no clock, no files. The same
 * `{ nodes, edges, seed }` always returns the same object. It is generated in memory (the server
 * serves it at /topology-fixture.json) and never written into the repo.
 *
 * What it does not have: the real descriptions, file paths or flows. A node's `desc` is one
 * line, and nothing here is checked against the code (`validateTopology(fixture)` runs the
 * schema checks only, which it passes).
 */

import { NODE_THEMES, FLOW_KINDS } from './schema.js';

export const FIXTURE_LIMITS = Object.freeze({
  minNodes: 100,
  maxNodes: 50_000,
  /** Edges per node: at least one (the ownership tree takes nearly all of that) and at most this */
  maxEdgesPerNode: 10,
});

/** Nodes of each type in topology.json, minus root (as of 2026-10-15; tool 8 with spec 0044): the mix the fixture scales to its size */
export const TYPE_MIX = {
  app: 42, page: 318, pkg: 15, core: 5, token: 9, atom: 14, molecule: 27, tool: 8,
  store: 7, table: 75, rom: 3, service: 36, external: 40, stack: 14, persona: 5,
  // spec 0029 PHY-03 (2026-10-13): the compose files' containers, the machines of a world file, the cameras
  container: 67, machine: 4, device: 2,
  // spec 0031 CLOUD-02 (2026-10-15): store 7 and external 44 (the cloud file, its 39 services and the public web, beside the self-hosted four)
  // spec 0031 CLOUD-03 (2026-10-15): external 40, every one with a kind (the self-hosted four are their containers)
};

/** Node id prefixes, as in the real map */
const PREFIX = {
  app: 'app', page: 'page', pkg: 'pkg', core: 'core', token: 'token', atom: 'atom', molecule: 'mol', tool: 'tool',
  store: 'store', table: 'table', rom: 'rom', service: 'svc', external: 'ext', stack: 'stack', persona: 'persona',
  container: 'container', machine: 'machine', device: 'device-camera',
};

/**
 * The edges that are not the ownership tree, as counted in topology.json: [kind, how many].
 * `dashed` is a usage link (a page uses a component), `flow` is split over FLOW_KINDS below.
 */
const EDGE_MIX = [
  ['dashed', 214], ['flow', 38], ['reads', 370], ['writes', 191], ['uses', 28],
  ['extends', 28], ['triggers', 20], ['calls', 105], ['delivers', 5], ['runs-on', 53],
];

/** Which node types each kind connects, [from, to, weight], from the real map's edges */
const PAIRS = {
  dashed: [['page', 'atom', 43], ['page', 'molecule', 42], ['page', 'core', 42], ['app', 'pkg', 26], ['pkg', 'pkg', 18], ['tool', 'token', 11], ['atom', 'token', 15], ['page', 'pkg', 8], ['molecule', 'token', 5], ['app', 'app', 2]],
  flow: [['app', 'store', 5], ['store', 'app', 2], ['app', 'app', 12], ['page', 'app', 3], ['tool', 'page', 5], ['store', 'table', 1], ['table', 'rom', 1], ['rom', 'rom', 3], ['page', 'store', 1], ['pkg', 'store', 2], ['table', 'page', 1]],
  reads: [['table', 'page', 310], ['table', 'app', 17], ['table', 'service', 43]],
  writes: [['page', 'table', 159], ['service', 'table', 32]],
  uses: [['atom', 'token', 10], ['molecule', 'token', 5], ['core', 'token', 2], ['app', 'token', 11]],
  extends: [['atom', 'core', 13], ['molecule', 'core', 14], ['core', 'core', 1]],
  triggers: [['page', 'service', 6], ['store', 'service', 3], ['service', 'service', 11]],
  calls: [['service', 'service', 39], ['service', 'external', 5], ['page', 'external', 6], ['container', 'external', 17], ['machine', 'external', 6], ['external', 'external', 2], ['service', 'container', 7], ['page', 'container', 23]],
  delivers: [['external', 'page', 1], ['device', 'container', 2], ['container', 'page', 2]],
  'runs-on': [['app', 'stack', 35], ['stack', 'machine', 15], ['pkg', 'machine', 2], ['machine', 'machine', 1]],
};

/** How often each flow kind occurs (topology.json: outbox 5, trigger 1, model 3, rom 5, changes 2, read 6, sync 3, build 5, api 8) */
const FLOW_WEIGHT = { outbox: 5, trigger: 1, model: 3, rom: 5, changes: 2, read: 6, sync: 3, build: 5, api: 8 };

const WORDS = ['cart', 'shop', 'tasks', 'notes', 'budget', 'photos', 'recipes', 'meals', 'pantry', 'garden', 'house', 'rooms', 'devices', 'bills', 'goals', 'pets', 'play', 'quests', 'loot', 'maps', 'chat', 'inbox', 'feed', 'search', 'login', 'logout', 'profile', 'settings', 'admin', 'reports', 'stats', 'events', 'calendar', 'reminders', 'tags', 'lists', 'orders', 'items', 'stock', 'labels', 'scan', 'import', 'export', 'sync', 'status', 'health', 'queue', 'jobs', 'logs', 'users', 'groups', 'invites', 'tokens', 'keys', 'media', 'albums', 'files', 'forms', 'cards', 'charts', 'grid'];
const ACTIONS = ['add', 'set', 'remove', 'clear', 'update', 'archive', 'toggle', 'move'];

// ---------------------------------------------------------------------------
//  Random numbers
// ---------------------------------------------------------------------------

/** mulberry32: a small, fast 32-bit generator with good spread; returns floats in [0, 1) */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `total` split over `weights` in proportion, whole numbers, largest remainder first; none below `min` */
function allocate(total, weights, min = 0) {
  const sum = weights.reduce((s, w) => s + w, 0);
  const raw = weights.map((w) => (w / sum) * total);
  const out = raw.map((r) => Math.max(min, Math.floor(r)));
  let left = total - out.reduce((s, n) => s + n, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length) { out[order[k][1]]++; left--; }
  // The floor and the minimum can overshoot: take the excess from the largest
  for (; left < 0; left++) out[out.indexOf(Math.max(...out))]--;
  return out;
}

/** A picker over `n` items where item 0 is the most likely: index = floor(n * u^power) */
const skewed = (rand, n, power) => Math.min(n - 1, Math.floor(n * rand() ** power));

/** Picks an index by weight, with a binary search over the running total */
function weightedPicker(weights, rand) {
  const cumulative = [];
  weights.reduce((s, w, i) => (cumulative[i] = s + w), 0);
  const total = cumulative[cumulative.length - 1];
  return () => {
    const x = rand() * total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] > x) hi = mid; else lo = mid + 1;
    }
    return lo;
  };
}

// ---------------------------------------------------------------------------
//  The map
// ---------------------------------------------------------------------------

const isCount = (n) => Number.isInteger(n);

/**
 * @param {{ nodes?: number, edges?: number, seed?: number }} [options]
 * @returns {{ version: string, updatedAt: string, nodes: object[], edges: object[] }}
 * @throws {RangeError} for a size outside FIXTURE_LIMITS, or edges below the nodes (the ownership tree needs one each)
 */
export function generateTopology({ nodes: nodeCount = 5000, edges: edgeCount = 15000, seed = 1 } = {}) {
  const { minNodes, maxNodes, maxEdgesPerNode } = FIXTURE_LIMITS;
  if (!isCount(nodeCount) || nodeCount < minNodes || nodeCount > maxNodes) throw new RangeError(`nodes must be a whole number from ${minNodes} to ${maxNodes}`);
  if (!isCount(edgeCount) || edgeCount < nodeCount || edgeCount > nodeCount * maxEdgesPerNode) throw new RangeError(`edges must be a whole number from nodes (${nodeCount}) to ${maxEdgesPerNode} per node (${nodeCount * maxEdgesPerNode})`);
  if (!Number.isInteger(seed)) throw new RangeError('seed must be a whole number');

  const rand = prng(seed);
  const pickWord = () => WORDS[Math.floor(rand() * WORDS.length)];

  // 1. Nodes, per type in the real mix (root is one more)
  const types = Object.keys(TYPE_MIX);
  const counts = allocate(nodeCount - 1, types.map((t) => TYPE_MIX[t]), 1);
  const nodes = [{ id: 'root', label: 'fixture', type: 'root', r: NODE_THEMES.root.r, color: NODE_THEMES.root.color, desc: 'Synthetic fixture root (core/fixture.js).' }];
  /** type -> its nodes in creation order */
  const byType = { root: [nodes[0]] };
  types.forEach((type, k) => {
    const theme = NODE_THEMES[type];
    byType[type] = [];
    for (let i = 0; i < counts[k]; i++) {
      const word = pickWord();
      const id = `${PREFIX[type]}-fx-${i}`;
      const node = { id, label: labelOf(type, word, i), type, r: theme.r, color: theme.color, desc: `Fixture ${type} ${i}.` };
      if (type === 'table') node.table = `${word}_${i}`;
      if (type === 'device') Object.assign(node, { kind: 'camera', file: 'stacks/fixture/cameras.yml' });
      // Every external has a kind (spec 0031); the fixture's are cloud services
      if (type === 'external') Object.assign(node, { kind: 'cloud', roles: ['runtime'], breaks: `Fixture: what uses ${node.label} fails.`, plan: { tier: 'free' } });
      if (type === 'page') {
        node.file = `apps/fixture/src/pages/${word}-${i}.astro`;
        if (rand() < 0.2) node.render = { now: 'build', rom: rand() < 0.5 ? 'bake' : 'skip' };
      }
      byType[type].push(node);
      nodes.push(node);
    }
  });

  // 2. The ownership tree: solid edges, one parent each
  const edges = [];
  const keys = new Set();
  const add = (edge) => {
    const key = `${edge.from}|${edge.to}|${edge.kind === 'flow' ? `flow:${edge.flow}` : edge.kind || (edge.dashed ? 'dashed' : 'own')}`;
    if (edge.from === edge.to || keys.has(key)) return false;
    keys.add(key);
    edges.push(edge);
    return true;
  };
  const own = (from, to) => add({ from: from.id, to: to.id });

  /** Gives each node a parent drawn from `parents`, a few of them far busier than the rest */
  const assign = (children, parents, power) => {
    if (!parents.length) return;
    // Ranking the parents by a weight 1/(rank+1)^power: an app with a hundred pages and a long tail with a few
    const pick = weightedPicker(parents.map((_, i) => 1 / (i + 1) ** power), rand);
    children.forEach((child) => own(parents[pick()], child));
  };
  const { app, pkg, store } = byType;
  byType.app.forEach((n) => own(nodes[0], n));
  byType.pkg.forEach((n) => own(nodes[0], n));
  byType.stack.forEach((n) => own(nodes[0], n));
  byType.machine.forEach((n) => own(nodes[0], n));
  // Containers and cameras belong to a stack (spec 0029)
  assign(byType.container, byType.stack, 0.3);
  assign(byType.device, byType.stack, 1);
  assign(byType.page, app, 0.7);
  // Components: mostly owned by an app's own folder (as in the real map), the rest by the packages
  const ownedByApp = byType.molecule.filter((_, i) => i % 3 !== 0);
  assign(ownedByApp, app, 0.9);
  assign(byType.molecule.filter((_, i) => i % 3 === 0), pkg, 0.5);
  for (const type of ['core', 'atom', 'token']) assign(byType[type], pkg, 0.5);
  assign(byType.service, app, 1.0);
  // Tools hang from the root, an app, or another tool; a few outside systems belong to an app, the rest stand free
  byType.tool.forEach((tool, i) => {
    if (i % 5 === 3) own(app[i % app.length], tool);
    else if (i % 5 === 4 && i > 0) own(byType.tool[i - 1], tool);
    else own(nodes[0], tool);
  });
  assign(byType.external.filter((_, i) => i % 3 === 0), app, 1.0);
  // Stores: the first is the device store, owned by a package and with no tables; the others hold the tables
  if (store.length > 1) own(pkg[0], store[0]);
  assign(byType.table, store.length > 1 ? store.slice(1) : store, 1.1);
  // Personas: one store holds the personas file (spec 0029)
  assign(byType.persona, store.slice(-1), 1);
  const tree = edges.length;

  // 3. Everything else, in the real mix of kinds, scaled to what is left
  const extra = edgeCount - tree;
  const quotas = allocate(extra, EDGE_MIX.map(([, n]) => n));
  const flowKinds = FLOW_KINDS.filter((k) => FLOW_WEIGHT[k]);
  const flowPick = weightedPicker(flowKinds.map((k) => FLOW_WEIGHT[k]), rand);

  const makers = {
    dashed: (from, to) => ({ from: from.id, to: to.id, dashed: true }),
    flow: (from, to) => {
      const flow = flowKinds[flowPick()];
      return { from: from.id, to: to.id, kind: 'flow', flow, status: 'live', label: `${flow} flow from ${from.label} to ${to.label}` };
    },
    reads: (from, to) => ({ from: from.id, to: to.id, kind: 'reads', status: 'live', keys: [`${from.table}/*`], label: `renders ${from.table} rows` }),
    writes: (from, to) => ({ from: from.id, to: to.id, kind: 'writes', status: 'live', label: `${to.table}.${ACTIONS[Math.floor(rand() * ACTIONS.length)]}` }),
    uses: (from, to) => {
      const n = 1 + Math.floor(rand() * 6);
      return { from: from.id, to: to.id, kind: 'uses', label: `${n} vars`, vars: Array.from({ length: n }, (_, i) => `--pop-fx-${i}`) };
    },
    extends: (from, to) => ({ from: from.id, to: to.id, kind: 'extends', label: `extends ${to.label}` }),
    triggers: (from, to) => ({ from: from.id, to: to.id, kind: 'triggers', status: 'live', label: `starts ${to.label}` }),
    calls: (from, to) => ({ from: from.id, to: to.id, kind: 'calls', status: 'live', label: 'imports' }),
    delivers: (from, to) => ({ from: from.id, to: to.id, kind: 'delivers', status: 'live', label: `${from.label} webhook` }),
    // Only app → stack carries the Caddyfile mappings; code on a machine (stack, package, virtual machine) has none
    'runs-on': (from, to) => ({
      from: from.id, to: to.id, kind: 'runs-on', status: 'live', label: `${from.label} → ${to.label}`,
      ...(from.type === 'app' ? { mappings: [{ host: from.label, upstream: `${to.label}:3000`, service: to.label, port: '3000' }] } : {}),
    }),
  };

  /** Adds up to `quota` edges of `kind`, trying random pairs; returns how many it could not place */
  const fill = (kind, quota) => {
    // Pairs whose two ends both exist, weighted as in the real map
    const pairs = PAIRS[kind].filter(([a, b]) => byType[a].length && byType[b].length && (a !== b || byType[a].length > 1));
    if (!pairs.length) return quota;
    const pickPair = weightedPicker(pairs.map(([, , w]) => w), rand);
    let placed = 0;
    for (let tries = quota * 30 + 100; placed < quota && tries > 0; tries--) {
      const [a, b] = pairs[pickPair()];
      // Tables and the services are shared by many; the pick leans to the first few of a type, which makes hubs
      const from = byType[a][skewed(rand, byType[a].length, a === 'table' ? 1.6 : 1.2)];
      const to = byType[b][skewed(rand, byType[b].length, b === 'table' ? 1.6 : 1.2)];
      if (add(makers[kind](from, to))) placed++;
    }
    return quota - placed;
  };

  let short = 0;
  EDGE_MIX.forEach(([kind], i) => { short += fill(kind, quotas[i]); });
  // A kind with few possible pairs (a tiny map) hands what it could not place to the data edges, which have the room
  for (const kind of ['reads', 'writes', 'dashed']) {
    if (short > 0) short = fill(kind, short);
  }
  if (short > 0) throw new RangeError(`a ${nodeCount}-node map has no room for ${edgeCount} distinct edges: ask for fewer edges`);

  return { version: '1.0.0', updatedAt: '2026-01-01T00:00:00.000Z', nodes, edges };
}

/** The label a node of `type` gets: pages are routes, apps are hosts, the rest are names */
function labelOf(type, word, i) {
  switch (type) {
    case 'page': return `/${word}-${i}`;
    case 'app': return `${word}-${i}.example.test`;
    case 'pkg': return `@acme/${word}-${i}`;
    case 'atom': return `pop-${word}-${i}`;
    case 'molecule': return `pop-${word}-card-${i}`;
    case 'token': return `--${word}-${i}-*`;
    case 'table': return `${word}_${i}`;
    case 'service': return `lib/${word}-${i}.ts`;
    case 'stack': return `${word}-stack-${i}`;
    case 'persona': return `${word}-persona-${i}`;
    case 'container': return `${word}-${i}`;
    case 'machine': return `host-${word}-${i}`;
    case 'device': return `Camera ${word}_${i}`;
    case 'external': return `${word}-cloud-${i}`;
    case 'store': return i === 0 ? 'IndexedDB (fixture)' : `sqlite-${i}`;
    case 'rom': return `ROM · ${word}-${i}`;
    case 'core': return `Pop${word[0].toUpperCase()}${word.slice(1)}-${i}`;
    default: return `${word}-${i} (:${6000 + i})`;
  }
}

/**
 * The fixture a request asks for: `nodes`, `edges` and `seed` from the query string, each a whole
 * number. Defaults are the spec's 5,000 / 15,000 / 1; with only `nodes`, three edges per node.
 * @param {URLSearchParams} params
 * @returns {{ nodes: number, edges: number, seed: number }}
 * @throws {RangeError} naming the parameter that is wrong
 */
export function parseFixtureQuery(params) {
  const whole = (name, fallback) => {
    if (!params.has(name)) return fallback;
    const raw = params.get(name);
    if (!/^-?\d+$/.test(raw)) throw new RangeError(`${name} must be a whole number, got "${raw}"`);
    return Number(raw);
  };
  const nodes = whole('nodes', 5000);
  const edges = whole('edges', params.has('nodes') ? nodes * 3 : 15000);
  const seed = whole('seed', 1);
  // The generator's own limits, checked here so the server can answer 400 before it generates anything
  const { minNodes, maxNodes, maxEdgesPerNode } = FIXTURE_LIMITS;
  if (nodes < minNodes || nodes > maxNodes) throw new RangeError(`nodes must be from ${minNodes} to ${maxNodes}`);
  if (edges < nodes || edges > nodes * maxEdgesPerNode) throw new RangeError(`edges must be from nodes (${nodes}) to ${maxEdgesPerNode} per node (${nodes * maxEdgesPerNode})`);
  return { nodes, edges, seed };
}

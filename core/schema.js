/**
 * @module core/schema
 *
 * What a `topology.json` node and edge may be: the node types with their colour and radius, and the
 * edge kinds, the physical world's rules (spec 0029: live types and ids, which ends an edge kind
 * may join) and the cloud's (spec 0031: the kinds of external, a cloud node's fields, `when` and `side`). Pure data and small pure checks with no imports, so the CLI (cli/cornfield.js), the proposal checks
 * (core/proposal.js) and the explorer in the browser all read the one table.
 */

/** The flow kind the code derives (app → API calls, MAP-08); `planSync` replaces every edge of it */
export const DERIVED_FLOW = 'api';

export const NODE_THEMES = {
  root:     { color: '#f59e0b', r: 28 },
  app:      { color: '#6366f1', r: 24 },
  page:     { color: '#38bdf8', r: 18 },  // Mandatory Sky Blue for all pages
  pkg:      { color: '#06b6d4', r: 24 },  // Vibrant Cyan for Packages / Libraries
  core:     { color: '#14b8a6', r: 20 },
  token:    { color: '#ec4899', r: 20 },
  atom:     { color: '#10b981', r: 19 },
  molecule: { color: '#a855f7', r: 21 },
  tool:     { color: '#f43f5e', r: 19 },
  store:    { color: '#fb923c', r: 20 },  // Storage tiers & data-flow endpoints (ADR 0020)
  table:    { color: '#fde047', r: 18 },  // One model table; pages read and write it
  rom:      { color: '#f0abfc', r: 19 },  // Render on Mutation pipeline stage
  service:  { color: '#84cc16', r: 20 },  // An API module that runs on a timer, a webhook or a change hook (MAP-03)
  external: { color: '#94a3b8', r: 21 },  // An outside system the API calls or that calls it
  stack:    { color: '#a8a29e', r: 22 },  // One docker-compose stack: its containers, ports and the domains it serves (MAP-06)
  // The physical world (spec 0029). Derived from code: machine, container, persona, and a device with a `file`
  machine:   { color: '#78716c', r: 26 },  // A computer the code runs on, by hostname
  container: { color: '#d6d3d1', r: 12 },  // One service of a stack
  persona:   { color: '#fb7185', r: 22 },  // An archetype a scenario can act as; never a real person
  device:    { color: '#2dd4bf', r: 14 },  // A camera, phone, NFC tag or Home Assistant device; `kind` says which (DEVICE_KINDS)
  // Live only: drawn from the live layer, never in topology.json (LIVE_TYPES)
  floor:     { color: '#a3e635', r: 20 },  // A level of the house
  room:      { color: '#bef264', r: 16 },  // A room, with its box on the floor plan
};

/** Kinds of data-flow edge (edge.kind === 'flow'); see docs/adr/0020 */
export const FLOW_KINDS = ['outbox', 'changes', 'trigger', 'sync', 'model', 'rom', 'read', 'build', DERIVED_FLOW];

/**
 * Table ↔ page edges. `reads` (table → page) carries the dependency keys the render
 * looks at; `writes` (page → table) is a form or action on the page that mutates it.
 */
export const DATA_EDGE_KINDS = ['reads', 'writes'];

/**
 * Edges between the API's services and what surrounds them (MAP-03), all derived:
 * `calls` (service or endpoint → service or external: it imports or reaches it; the ends spec 0031
 * widens are in EDGE_ENDS),
 * `triggers` (scheduler, store or webhook endpoint → service: what starts it) and
 * `delivers` (external → webhook endpoint: the outside system pushes to it).
 */
export const SERVICE_EDGE_KINDS = ['calls', 'triggers', 'delivers'];

/**
 * App → stack (MAP-06), derived from the Caddyfile and the compose files: `runs-on` says a
 * stack's service serves the app's domain, and its `mappings` are the Caddyfile host → upstream → service:port.
 * It also says where code runs (spec 0029): stack, package or virtual machine → machine (EDGE_ENDS).
 */
export const STACK_EDGE_KINDS = ['runs-on'];

/**
 * Every `edge.kind` a topology edge may carry. No kind is the ownership edge (parent → child, or
 * dashed for a looser dependency); `flow` also names its `flow` (one of FLOW_KINDS).
 */
export const EDGE_KINDS = ['flow', ...DATA_EDGE_KINDS, 'uses', 'extends', ...SERVICE_EDGE_KINDS, ...STACK_EDGE_KINDS];

// ---------------------------------------------------------------------------
//  The physical world (spec 0029 section 1): no new edge kinds, wider ends
// ---------------------------------------------------------------------------

/** What a `device` node is; one type so the Layers menu has one Devices toggle (spec 0029 D2) */
export const DEVICE_KINDS = ['camera', 'phone', 'nfc-tag', 'home-assistant'];

/** Types that only the live layer draws: `validate` refuses them in topology.json */
export const LIVE_TYPES = ['floor', 'room'];

/** Every id the live layer makes starts with this, so it can never collide with a derived one */
export const LIVE_ID_PREFIX = 'live-';

/**
 * The node types each edge kind may join, as [from type, to type] pairs. Kinds not listed here keep
 * their own rules in `topology.js validate`.
 *  - `runs-on`: app → stack (with `mappings`), and stack → machine, package → machine, machine → machine
 *    (a virtual machine on its host), with a label and no `mappings`
 *  - `delivers`: external → endpoint (a webhook), device → container (a camera's stream, an HA device),
 *    and container → endpoint (a self-hosted service's webhook, spec 0031 section 3)
 *  - `calls` (spec 0031 section 1): service or endpoint → service or external, and tool → endpoint, as
 *    before; into an external also from an app (what the visitor's browser fetches, or an app's server),
 *    a container, a machine or another external (a zone delegated from the registrar); and service,
 *    endpoint or app → container (a self-hosted service is called where it runs)
 */
export const EDGE_ENDS = {
  'runs-on': [['app', 'stack'], ['stack', 'machine'], ['pkg', 'machine'], ['machine', 'machine']],
  delivers: [['external', 'page'], ['device', 'container'], ['container', 'page']],
  calls: [
    ['service', 'service'], ['service', 'external'], ['page', 'service'], ['page', 'external'], ['tool', 'page'],
    ['app', 'external'], ['container', 'external'], ['machine', 'external'], ['external', 'external'],
    ['service', 'container'], ['page', 'container'], ['app', 'container'],
    // cornfield: a repo's CI, a package, a module or the repo itself may reach outside too (plugins/cloud)
    ['tool', 'external'], ['pkg', 'external'], ['core', 'external'], ['root', 'external'],
  ],
};

/**
 * A dashed ownership edge (no kind, `dashed: true`) from a room places a code-derived machine or device
 * in the room its linked inventory item is in. Only the live layer draws it (rooms are live). From a
 * container or an external node it places a Home Assistant service device (software, spec 0031 section
 * 3.1) on the container that serves its host, or on the cloud node whose registry entry claims it.
 */
export const PLACEMENT_ENDS = [['room', 'machine'], ['room', 'device'], ['container', 'device'], ['external', 'device']];

/** Whether a from type and a to type are one of the pairs */
export const endsAllowed = (pairs, from, to) => pairs.some(([a, b]) => a === from && b === to);

/** The pairs in words, for a message: "external -> page, device -> container, or container -> page" */
export function describeEnds(pairs) {
  const words = pairs.map(([a, b]) => `${a} -> ${b}`);
  return words.length > 1 ? `${words.slice(0, -1).join(', ')}, or ${words[words.length - 1]}` : words.join('');
}

/** The node a persona (an entry of the personas file) is drawn as */
export const personaNodeId = (id) => `persona-${id}`;

/**
 * Reads a live id: `live-floor-<id>`, `live-room-<id>` or `live-device-<kind>-<id>` (kind one of DEVICE_KINDS).
 * @param {unknown} id
 * @returns {{ type: string, id: string, kind?: string } | null} `type` is floor, room or device; `kind` is set for a device
 */
export function parseLiveId(id) {
  if (typeof id !== 'string' || !id.startsWith(LIVE_ID_PREFIX)) return null;
  const rest = id.slice(LIVE_ID_PREFIX.length);
  for (const type of LIVE_TYPES) if (rest.startsWith(`${type}-`) && rest.length > type.length + 1) return { type, id: rest.slice(type.length + 1) };
  if (!rest.startsWith('device-')) return null;
  const tail = rest.slice('device-'.length);
  const kind = DEVICE_KINDS.find((k) => tail.startsWith(`${k}-`) && tail.length > k.length + 1);
  return kind ? { type: 'device', kind, id: tail.slice(kind.length + 1) } : null;
}

/** A node only the live layer can hold: a floor, a room, a device that no code file derives, or anything with a live id */
export function isLiveNode(node) {
  if (!node) return false;
  if (typeof node.id === 'string' && node.id.startsWith(LIVE_ID_PREFIX)) return true;
  return LIVE_TYPES.includes(node.type) || (node.type === 'device' && !node.file);
}

/**
 * What is wrong with a physical-world node in topology.json (which holds only what the code derives).
 * @param {{ id?: string, type?: string, kind?: string, file?: string }} node
 * @param {{ requireKind?: boolean }} [opts] passed to externalNodeProblems
 * @returns {string[]}
 */
export function committedNodeProblems(node, opts = {}) {
  const problems = [];
  const id = node.id;
  if (typeof id === 'string' && id.startsWith(LIVE_ID_PREFIX)) problems.push(`Node "${id}" has a live id ("${LIVE_ID_PREFIX}…"): live nodes are drawn by the live layer and never committed.`);
  if (LIVE_TYPES.includes(node.type)) problems.push(`Node "${id}" is a ${node.type}: floors and rooms come from the live layer and are never in topology.json.`);
  if (node.type === 'device') {
    if (!node.file) problems.push(`Device node "${id}" has no 'file': only a device derived from code (a camera) is committed; the rest come from the live layer.`);
    if (!DEVICE_KINDS.includes(node.kind)) problems.push(`Device node "${id}" has kind "${node.kind}". Valid kinds: ${DEVICE_KINDS.join(', ')}`);
  }
  problems.push(...externalNodeProblems(node, opts));
  return problems;
}

// ---------------------------------------------------------------------------
//  The cloud (spec 0031 section 1): `external` gains a kind, `calls` two fields
// ---------------------------------------------------------------------------

/** What an `external` node is: a cloud service (one per registry entry) or the public web (one node); no new type (spec 0031 D1) */
export const EXTERNAL_KINDS = ['cloud', 'web'];

/** What a cloud service is to the house: called while running, where software comes from, an account (by role, never a person) */
export const CLOUD_ROLES = ['runtime', 'software', 'account'];

/** A cloud service's plan (D9): a tier, never a price; `off` is an account closed or not had yet */
export const PLAN_TIERS = ['free', 'paid', 'unknown', 'off'];

/** The keys a cloud node's `plan` may have */
const PLAN_KEYS = ['tier', 'note'];

/**
 * When an outage of a cloud node bites, on a `calls` edge into it: `run` (the default, as soon as it is
 * down), `deploy` (the next deploy, rebuild, CI run, first run or reinstall), `renew` (the next certificate renewal)
 */
export const CALL_WHEN = ['run', 'deploy', 'renew'];

/** Who makes a call, on an app → external `calls` edge: `browser`, the visitor's browser and not our server */
export const CALL_SIDES = ['browser'];

/**
 * What is wrong with an `external` node's kind and cloud fields (any other node passes).
 *  - `kind`, when set, is one of EXTERNAL_KINDS; with `requireKind` it must be set (the registry, CLOUD-02,
 *    draws every external with one; until then the derived externals have none)
 *  - a `cloud` node has `roles` (one or more of CLOUD_ROLES, each once), a `breaks` line and a `plan`
 *    (`{ tier, note? }`, tier one of PLAN_TIERS)
 *  - `roles` and `plan` belong only on a cloud node: the public web has neither (it is not cloud)
 * @param {Record<string, any>} node an external (any other node passes): its id, type, kind, roles, breaks and plan are read
 * @param {{ requireKind?: boolean }} [opts]
 * @returns {string[]}
 */
export function externalNodeProblems(node, { requireKind = false } = {}) {
  if (!node || node.type !== 'external') return [];
  const problems = [];
  const name = `External node "${node.id}"`;
  if (node.kind === undefined) {
    if (requireKind) problems.push(`${name} has no "kind": one of ${EXTERNAL_KINDS.join(', ')}.`);
  } else if (!EXTERNAL_KINDS.includes(node.kind)) {
    problems.push(`${name} has kind "${node.kind}". Valid kinds: ${EXTERNAL_KINDS.join(', ')}`);
  }
  if (node.kind !== 'cloud') {
    for (const key of ['roles', 'plan']) if (node[key] !== undefined) problems.push(`${name} has "${key}": only a cloud node (kind "cloud") has roles and a plan.`);
    if (node.breaks !== undefined && (typeof node.breaks !== 'string' || !node.breaks.trim())) problems.push(`${name} has an empty "breaks": say what fails when it is down, or leave it out.`);
    return problems;
  }
  const roles = node.roles;
  if (!Array.isArray(roles) || roles.length === 0) problems.push(`${name} is a cloud node with no "roles": one or more of ${CLOUD_ROLES.join(', ')}.`);
  else {
    for (const role of roles) if (!CLOUD_ROLES.includes(role)) problems.push(`${name} has role "${role}". Valid roles: ${CLOUD_ROLES.join(', ')}`);
    if (new Set(roles).size !== roles.length) problems.push(`${name} names a role twice.`);
  }
  if (typeof node.breaks !== 'string' || !node.breaks.trim()) problems.push(`${name} is a cloud node with no "breaks": the line that says what fails when it is down.`);
  const plan = node.plan;
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) problems.push(`${name} is a cloud node with no "plan": { tier } with tier one of ${PLAN_TIERS.join(', ')}.`);
  else {
    if (!PLAN_TIERS.includes(plan.tier)) problems.push(`${name} has plan tier "${plan.tier}". Valid tiers: ${PLAN_TIERS.join(', ')}`);
    if (plan.note !== undefined && (typeof plan.note !== 'string' || !plan.note.trim())) problems.push(`${name} has a plan "note" that is not words.`);
    for (const key of Object.keys(plan)) if (!PLAN_KEYS.includes(key)) problems.push(`${name} has "${key}" in its plan: a plan has only ${PLAN_KEYS.join(' and ')} (a tier, never a price).`);
  }
  return problems;
}

/**
 * What is wrong with a `when` or a `side` on an edge, given its two end nodes (only their `type` and `kind` are read).
 *  - `when` (one of CALL_WHEN) goes only on a `calls` edge into a cloud node (or an external with no kind yet)
 *  - `side` (one of CALL_SIDES) goes only on a `calls` edge from an app to an external
 * @param {Record<string, any>} edge its kind, when and side are read
 * @param {{ type?: string, kind?: string } | undefined} from
 * @param {{ type?: string, kind?: string } | undefined} to
 * @returns {string[]}
 */
export function callFieldProblems(edge, from, to) {
  const problems = [];
  const intoCloud = to?.type === 'external' && (to.kind === undefined || to.kind === 'cloud');
  if (edge.when !== undefined) {
    if (!CALL_WHEN.includes(/** @type {string} */ (edge.when))) problems.push(`has when "${edge.when}". Valid values: ${CALL_WHEN.join(', ')}`);
    if (edge.kind !== 'calls') problems.push('has "when", which goes only on a calls edge.');
    else if (!intoCloud) problems.push('has "when" but does not go into a cloud node: only an outage of a cloud service is timed.');
  }
  if (edge.side !== undefined) {
    if (!CALL_SIDES.includes(/** @type {string} */ (edge.side))) problems.push(`has side "${edge.side}". Valid values: ${CALL_SIDES.join(', ')}`);
    if (edge.kind !== 'calls') problems.push('has "side", which goes only on a calls edge.');
    else if (from?.type !== 'app' || to?.type !== 'external') problems.push('has "side", which goes only on an app -> external calls edge (the visitor\'s browser makes the call).');
  }
  return problems;
}

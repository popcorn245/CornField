/**
 * @module core/proposal
 *
 * A proposal is the one place unbuilt architecture is written down (spec 0012 B1): a JSON file
 * beside the spec that says which nodes and edges a change would add, change and remove, and the
 * scenarios (step by step walks over the map) that show what it does. `topology.json` stays
 * derived from the code; a proposal never edits it. This module reads a proposal against the map:
 *
 *  - `validateProposal(topology, proposal)`  the mistakes in a proposal, as `{ path, message }`
 *  - `proposalProblems(topology, proposal)`  the same mistakes minus the ones a landing explains, once the build has begun
 *  - `applyProposal(topology, proposal)`     the map with the change drawn in: `{ nodes, edges }`, each carrying a `mark`
 *  - `proposalStatus(topology, proposal)`    once the code is built, which items landed as approved
 *  - `summarize(proposal)`                   the counts chip: `{ added, changed, removed, scenarios }`
 *  - `applyEdits(proposal, edits)`           the maintainer's what-if edits folded into a new proposal
 *  - `edgeKey(edge)`                         how an edge is told apart: from + to + kind
 *
 * Pure: no imports of Node, no DOM, no clock. The CLI (cli/cornfield.js), the vitest suite and the
 * explorer in the browser (served by the server, explorer/) all import this one file.
 *
 * The file format
 * ---------------
 *   { version: 1, spec?: "0013", title, summary,
 *     nodes?:     { add?: [{ id, label, type, parent?, desc?, …any node field }],
 *                   change?: [{ id, set: { …fields }, why }],
 *                   remove?: [{ id, why }] },
 *     edges?:     { add?: [{ from, to, kind?, flow?, label?, … }],
 *                   change?: [{ from, to, kind?, flow?, set: { …fields }, why }],
 *                   remove?: [{ from, to, kind?, flow?, why }] },
 *     scenarios?: [{ id, title, steps: [{ node } | { edge: { from, to, kind?, flow? } }, + text, + ms?,
 *                    + actor?, at?, check?, expect?], stepMs?, linkNodes?, actor?, down? }] }
 *
 *  - An edge is identified by `from` + `to` + `kind`. No `kind` is the ownership edge (parent → child);
 *    a `flow` edge also names its `flow` (one of FLOW_KINDS), and that is part of its identity.
 *  - `parent` on an added node adds the ownership edge `parent → id`; `parent` is not a node field and
 *    cannot be set by a change (move a node by removing and adding the ownership edge).
 *  - An added node's `color` always comes from its type, its `r` from the entry or else the type
 *    (the table is core/schema.js, the same one `sync` and `validate` use).
 *  - `mark`, `before` and `why` on a result belong to `applyProposal`; a proposal may not set `mark`
 *    or `before` on an added item, nor `mark`, `before` or `why` in a `set`.
 *  - A scenario step may point at anything that is in the map or added by the proposal, **including
 *    what the proposal removes**: the Diff view still draws removed items, so a scenario can show the
 *    old path ("this call goes away") as well as the new one.
 *  - After the build: `topology.js validate` stops reporting "already exists" / "does not exist" once an
 *    ADDED item exists as proposed (see `state` on ProposalError). A proposal that only removes or changes
 *    never shows it has landed, so delete it (or close its spec) in the PR that lands it.
 *  - Who and where (spec 0029 section 3), all optional: a scenario's `actor` is a persona id (the node
 *    `persona-<id>` must be in the map or added); a step's own `actor` wins over it. `at` is where the step
 *    happens: a node of the map or the proposal, or a live id (`live-room-<id>`, `live-floor-<id>`,
 *    `live-device-<kind>-<id>`) that only the live layer can resolve. `check` is one check or a list:
 *    `{ route, method }` or `{ table, op, row? }`; `check: []` says the step is no permission question.
 *    `expect` is `allowed` or `refused`, on a step that has an actor (its own or the scenario's).
 *  - Outages (spec 0031 section 8): a scenario's `down` lists the nodes it takes down, each an `external` of
 *    kind `cloud` in the map or the proposal (its kind may come from the proposal's add or change). The player
 *    hands it on (explorer/scenario.js); what breaks is worked out from the map, never written here.
 *  - The cloud (spec 0031 section 1): an added external's `kind`, when set, is one of EXTERNAL_KINDS; `when` and
 *    `side` on an added edge are held to topology-schema.js's `callFieldProblems` (a calls edge into a cloud node;
 *    side only app -> external).
 *  - Live types (spec 0029 D9): a floor, a room or a device no code file derives is drawn by the live layer
 *    and never lands in topology.json. Its id is a live id of its type, and `proposalStatus` reads it, and
 *    every added edge with a live end, as `live`, never `pending`.
 *  - Not checked here, on purpose: the direction and required fields per edge kind (`reads` needs
 *    `keys`, `writes` needs a label…). Those rules belong to `topology.json`, where `validate` holds
 *    the derived map to them; a proposal is a sketch.
 */

import { NODE_THEMES, EDGE_KINDS, FLOW_KINDS, DEVICE_KINDS, EXTERNAL_KINDS, LIVE_ID_PREFIX, parseLiveId, isLiveNode, personaNodeId, callFieldProblems } from './schema.js';

const TOP_KEYS = ['version', 'spec', 'title', 'summary', 'nodes', 'edges', 'scenarios'];
const SCENARIO_KEYS = ['id', 'title', 'steps', 'stepMs', 'linkNodes', 'actor', 'down'];
const STEP_KEYS = ['node', 'edge', 'text', 'ms', 'actor', 'at', 'check', 'expect'];
/** What a step's `check` may ask (spec 0029 section 3): a route and a method, or a table, an op and a row shape */
export const CHECK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const CHECK_OPS = ['read', 'write', 'delete'];
export const CHECK_ROWS = ['own', 'household', 'others', 'shared-read', 'shared-write'];
/** What a step may assert its checks answer */
export const EXPECTS = ['allowed', 'refused'];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIVE_GRAMMAR = `live-room-<id>, live-floor-<id> or live-device-<kind>-<id> (kind one of ${DEVICE_KINDS.join(', ')})`;
const OPS = ['add', 'change', 'remove'];
/** Fields only `applyProposal` writes */
const RESERVED = ['mark', 'before'];
const RESERVED_IN_SET = ['mark', 'before', 'why'];
/** What names an edge: a change may not set them */
const EDGE_IDENTITY = ['from', 'to', 'kind', 'flow'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
/** @param {any} v @returns {any} */
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const asList = (v) => (Array.isArray(v) ? v : []);
const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Structural equality for JSON values, whatever the key order */
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => same(a[k], b[k]));
}

/**
 * How an edge is told apart from the others: `from|to|kind`. No kind is the ownership edge (`own`,
 * dashed or not); a flow edge reads `flow:<its flow>`.
 * @param {{from: string, to: string, kind?: string, flow?: string}} edge
 * @returns {string}
 */
export function edgeKey(edge) {
  return `${edge.from}|${edge.to}|${edge.kind === 'flow' ? `flow:${edge.flow}` : edge.kind || 'own'}`;
}

/** The ownership edge an added node's `parent` makes */
const ownershipEdge = (node) => ({ from: node.parent, to: node.id });

/**
 * @typedef {{ path: string, message: string, state?: 'exists' | 'missing-target' | 'dangling' }} ProposalError
 *   `path` is where in the proposal the mistake is, as written: `nodes.add[0].type`, `scenarios[1].steps[2].node`.
 *   `state` marks a mistake that depends on what the map holds, and says which:
 *   - `'exists'`         an added node or edge is already in the map
 *   - `'missing-target'` a changed or removed node or edge is not in the map (a step that points at something
 *                        this proposal removes is this too)
 *   - `'dangling'`       a parent, an edge end or a step target that is in neither the map nor the proposal
 *   Once the code is built the first two are expected (the added thing exists, the removed thing is gone), so
 *   `topology.js validate` skips them for a proposal whose additions have begun to land; `'dangling'` is
 *   never explained by a landing and is always reported. No `state` means a structural mistake.
 */

/**
 * Everything wrong with a proposal, read against the map it would change. An empty list is a valid proposal.
 * @param {{ nodes: object[], edges: object[] }} topology the base map (topology.json)
 * @param {any} proposal the parsed proposal file (anything: a file that is not an object is an error, not a crash)
 * @returns {ProposalError[]}
 */
export function validateProposal(topology, proposal) {
  /** @type {ProposalError[]} */
  const errors = [];
  /** `state` (see ProposalError) marks a mistake that depends on what the map holds now */
  const err = (path, message, state) => errors.push(state ? { path, message, state } : { path, message });
  if (!isObject(proposal)) {
    err('', 'A proposal is a JSON object.');
    return errors;
  }

  for (const key of Object.keys(proposal)) {
    if (!TOP_KEYS.includes(key)) err(key, `Unknown key "${key}". A proposal has: ${TOP_KEYS.join(', ')}.`);
  }
  if (proposal.version !== 1) err('version', `"version" must be the number 1 (got ${JSON.stringify(proposal.version)}).`);
  if (!isText(proposal.title)) err('title', '"title" must be a non-empty string.');
  if (!isText(proposal.summary)) err('summary', '"summary" must be a non-empty string: the one sentence the maintainer reads first.');
  if (proposal.spec !== undefined && !isText(proposal.spec)) err('spec', '"spec" must be the spec number as a string, like "0013".');

  /** Reads `proposal[block]` as { add, change, remove } and returns the three lists */
  const readBlock = (block) => {
    const value = proposal[block];
    if (value === undefined) return { add: [], change: [], remove: [] };
    if (!isObject(value)) {
      err(block, `"${block}" must be an object with add, change and remove lists.`);
      return { add: [], change: [], remove: [] };
    }
    const lists = {};
    for (const key of Object.keys(value)) if (!OPS.includes(key)) err(`${block}.${key}`, `Unknown key "${key}" in "${block}". Use add, change or remove.`);
    for (const op of OPS) {
      if (value[op] === undefined) lists[op] = [];
      else if (!Array.isArray(value[op])) { err(`${block}.${op}`, `"${block}.${op}" must be a list.`); lists[op] = []; }
      else lists[op] = value[op];
    }
    return lists;
  };
  const nodes = readBlock('nodes');
  const edges = readBlock('edges');

  const baseNodes = new Map(asList(topology?.nodes).map((n) => [n.id, n]));
  const baseEdgeKeys = new Set(asList(topology?.edges).map(edgeKey));

  // Ids first: a parent or an edge end may be an added node written further down
  const addedIds = new Map();
  nodes.add.forEach((n, i) => { if (isObject(n) && isText(n.id) && !addedIds.has(n.id)) addedIds.set(n.id, i); });
  const removedIds = new Set(nodes.remove.filter((n) => isObject(n) && isText(n.id)).map((n) => n.id));
  const exists = (id) => baseNodes.has(id) || addedIds.has(id);

  // --- nodes.add
  const seenAdd = new Set();
  /** Ownership edges the added nodes make, by key, with where they came from */
  const addedEdgeKeys = new Map();
  nodes.add.forEach((n, i) => {
    const p = `nodes.add[${i}]`;
    if (!isObject(n)) return err(p, 'An added node is an object with an id, a label and a type.');
    if (!isText(n.id)) err(`${p}.id`, 'An added node needs an "id".');
    else if (baseNodes.has(n.id)) err(`${p}.id`, `Node "${n.id}" already exists in the map. Use nodes.change to change it.`, 'exists');
    else if (seenAdd.has(n.id)) err(`${p}.id`, `Node "${n.id}" is added twice.`);
    if (isText(n.id)) seenAdd.add(n.id);
    if (!isText(n.label)) err(`${p}.label`, 'An added node needs a "label".');
    if (!isText(n.type)) err(`${p}.type`, 'An added node needs a "type".');
    else if (!NODE_THEMES[n.type]) err(`${p}.type`, `Unknown node type "${n.type}". Valid types: ${Object.keys(NODE_THEMES).join(', ')}.`);
    else if (n.type === 'page' && isText(n.label)) {
      if (!n.label.startsWith('/')) err(`${p}.label`, `A page label "${n.label}" must start with a slash route (like "/meals"), as topology validate demands.`);
      if (n.label.includes('.html')) err(`${p}.label`, `A page label "${n.label}" must not contain ".html".`);
    }
    for (const key of RESERVED) if (key in n) err(`${p}.${key}`, `"${key}" is set when the proposal is applied; leave it out.`);
    if (n.type === 'device' && !DEVICE_KINDS.includes(n.kind)) err(`${p}.kind`, `A device needs "kind", one of: ${DEVICE_KINDS.join(', ')}.`);
    if (n.type === 'external' && n.kind !== undefined && !EXTERNAL_KINDS.includes(n.kind)) err(`${p}.kind`, `An external's "kind" is one of: ${EXTERNAL_KINDS.join(', ')} (or none, until the registry draws it).`);
    if (isText(n.id) && NODE_THEMES[n.type] && isLiveNode(n)) {
      // Only the live layer draws it, so its id is the live id it will have there
      const live = parseLiveId(n.id);
      const want = n.type === 'device' ? `live-device-${DEVICE_KINDS.includes(n.kind) ? n.kind : '<kind>'}-<id>` : `live-${n.type}-<id>`;
      if (!live || live.type !== n.type) {
        err(`${p}.id`, ['floor', 'room', 'device'].includes(n.type)
          ? `"${n.id}" is a ${n.type} only the live layer draws${n.type === 'device' ? ' (no code file derives it)' : ''}: its id must be ${want}.`
          : `"${n.id}" starts with "${LIVE_ID_PREFIX}", which only the live layer's floors, rooms and devices use (${LIVE_GRAMMAR}).`);
      } else if (live.kind && DEVICE_KINDS.includes(n.kind) && live.kind !== n.kind) {
        err(`${p}.kind`, `"${n.id}" names the kind "${live.kind}" but the node says "${n.kind}".`);
      }
    }
    if (n.parent !== undefined) {
      if (!isText(n.parent)) err(`${p}.parent`, '"parent" must be the id of a node.');
      else if (n.parent === n.id) err(`${p}.parent`, 'A node cannot be its own parent.');
      else if (!exists(n.parent)) err(`${p}.parent`, `Parent "${n.parent}" is in neither the map nor the added nodes.`, 'dangling');
      else if (removedIds.has(n.parent)) err(`${p}.parent`, `Parent "${n.parent}" is a node this proposal removes.`);
      else if (isText(n.id)) addedEdgeKeys.set(edgeKey(ownershipEdge(n)), `nodes.add[${i}].parent`);
    }
  });

  // --- nodes.change
  const changedIds = new Set();
  nodes.change.forEach((c, i) => {
    const p = `nodes.change[${i}]`;
    if (!isObject(c)) return err(p, 'A changed node is an object with an id, a set and a why.');
    if (!isText(c.id)) err(`${p}.id`, 'A changed node needs an "id".');
    else if (addedIds.has(c.id)) err(`${p}.id`, `Node "${c.id}" is added by this proposal: change its entry in nodes.add instead.`);
    else if (!baseNodes.has(c.id)) err(`${p}.id`, `Node "${c.id}" does not exist in the map, so it cannot be changed.`, 'missing-target');
    else if (changedIds.has(c.id)) err(`${p}.id`, `Node "${c.id}" is changed twice: merge the two sets.`);
    if (isText(c.id)) changedIds.add(c.id);
    if (!isObject(c.set) || Object.keys(c.set).length === 0) err(`${p}.set`, '"set" must be an object of the fields to change.');
    else {
      if ('id' in c.set) err(`${p}.set.id`, 'A change cannot set "id": it names the node.');
      if ('parent' in c.set) err(`${p}.set.parent`, '"parent" is not a node field: remove the ownership edge and add a new one.');
      for (const key of RESERVED_IN_SET) if (key in c.set) err(`${p}.set.${key}`, `"${key}" is set when the proposal is applied; leave it out of "set".`);
      if ('type' in c.set && !NODE_THEMES[c.set.type]) err(`${p}.set.type`, `Unknown node type "${c.set.type}". Valid types: ${Object.keys(NODE_THEMES).join(', ')}.`);
    }
    if (!isText(c.why)) err(`${p}.why`, 'A change needs a "why": the reason the maintainer reads.');
  });

  // --- nodes.remove
  const seenRemove = new Set();
  nodes.remove.forEach((r, i) => {
    const p = `nodes.remove[${i}]`;
    if (!isObject(r)) return err(p, 'A removed node is an object with an id and a why.');
    if (!isText(r.id)) err(`${p}.id`, 'A removed node needs an "id".');
    else if (addedIds.has(r.id)) err(`${p}.id`, `Node "${r.id}" is added by this proposal: drop its entry from nodes.add instead of removing it.`);
    else if (!baseNodes.has(r.id)) err(`${p}.id`, `Node "${r.id}" does not exist in the map, so it cannot be removed.`, 'missing-target');
    else if (seenRemove.has(r.id)) err(`${p}.id`, `Node "${r.id}" is removed twice.`);
    else if (changedIds.has(r.id)) err(`${p}.id`, `Node "${r.id}" is both changed and removed.`);
    if (isText(r.id)) seenRemove.add(r.id);
    if (!isText(r.why)) err(`${p}.why`, 'A removal needs a "why".');
  });

  /** A node as the proposal leaves it (its own add, else the map's with any change's `set`), for its type and kind; undefined when it is nowhere */
  const changeOf = new Map(nodes.change.filter((c) => isObject(c) && isText(c.id) && isObject(c.set)).map((c) => [c.id, c.set]));
  const addedNodeOf = new Map(nodes.add.filter((n) => isObject(n) && isText(n.id)).map((n) => [n.id, n]));
  const nodeOf = (id) => addedNodeOf.get(id) || (baseNodes.has(id) ? { ...baseNodes.get(id), ...(changeOf.get(id) || {}) } : undefined);

  /** Checks the shape of an edge reference; returns its key, or null when it cannot be read */
  const readEdge = (e, p) => {
    if (!isText(e.from)) err(`${p}.from`, 'An edge needs a "from" node id.');
    if (!isText(e.to)) err(`${p}.to`, 'An edge needs a "to" node id.');
    let valid = isText(e.from) && isText(e.to);
    if (e.kind !== undefined && !EDGE_KINDS.includes(e.kind)) {
      err(`${p}.kind`, `Unknown edge kind "${e.kind}". Valid kinds: ${EDGE_KINDS.join(', ')} (or none, for ownership).`);
      valid = false;
    }
    if (e.kind === 'flow') {
      if (!FLOW_KINDS.includes(e.flow)) { err(`${p}.flow`, `A flow edge needs "flow", one of: ${FLOW_KINDS.join(', ')}.`); valid = false; }
    } else if (e.flow !== undefined) err(`${p}.flow`, '"flow" only goes on an edge of kind "flow".');
    return valid ? edgeKey(e) : null;
  };
  const describe = (e) => `${e.from} -> ${e.to}${e.kind ? ` (${e.kind === 'flow' ? `flow ${e.flow}` : e.kind})` : ' (ownership)'}`;

  // --- edges.add
  const seenEdge = new Map([...addedEdgeKeys]);
  edges.add.forEach((e, i) => {
    const p = `edges.add[${i}]`;
    if (!isObject(e)) return err(p, 'An added edge is an object with from, to and optionally a kind.');
    const key = readEdge(e, p);
    for (const key2 of RESERVED) if (key2 in e) err(`${p}.${key2}`, `"${key2}" is set when the proposal is applied; leave it out.`);
    for (const end of ['from', 'to']) {
      if (!isText(e[end])) continue;
      if (!exists(e[end])) err(`${p}.${end}`, `Node "${e[end]}" is in neither the map nor the added nodes.`, 'dangling');
      else if (removedIds.has(e[end])) err(`${p}.${end}`, `Node "${e[end]}" is a node this proposal removes, so an edge cannot be added to it.`);
    }
    const from = nodeOf(e.from);
    const to = nodeOf(e.to);
    if (from && to) {
      for (const field of ['when', 'side']) {
        if (e[field] === undefined) continue;
        for (const problem of callFieldProblems({ kind: e.kind, [field]: e[field] }, from, to)) err(`${p}.${field}`, `The edge ${problem}`);
      }
    }
    if (!key) return;
    if (baseEdgeKeys.has(key)) err(p, `Edge ${describe(e)} already exists in the map.`, 'exists');
    else if (seenEdge.has(key)) err(p, `Edge ${describe(e)} is already added by ${seenEdge.get(key)}.`);
    seenEdge.set(key, seenEdge.get(key) || p);
  });

  /** Shared by change and remove: the edge must be in the map, named once */
  const seenTouched = new Map();
  const existingEdge = (e, p, op) => {
    const key = readEdge(e, p);
    if (!key) return null;
    if (!baseEdgeKeys.has(key)) err(p, `Edge ${describe(e)} does not exist in the map, so it cannot be ${op === 'change' ? 'changed' : 'removed'}.`, 'missing-target');
    else if (seenTouched.has(key)) err(p, `Edge ${describe(e)} is already ${seenTouched.get(key)} by this proposal.`);
    else seenTouched.set(key, op === 'change' ? 'changed' : 'removed');
    return key;
  };

  edges.change.forEach((e, i) => {
    const p = `edges.change[${i}]`;
    if (!isObject(e)) return err(p, 'A changed edge is an object with from, to, set and why.');
    existingEdge(e, p, 'change');
    if (!isObject(e.set) || Object.keys(e.set).length === 0) err(`${p}.set`, '"set" must be an object of the fields to change.');
    else {
      for (const key of EDGE_IDENTITY) if (key in e.set) err(`${p}.set.${key}`, `A change cannot set "${key}": it names the edge. Remove the edge and add a new one.`);
      for (const key of RESERVED_IN_SET) if (key in e.set) err(`${p}.set.${key}`, `"${key}" is set when the proposal is applied; leave it out of "set".`);
    }
    if (!isText(e.why)) err(`${p}.why`, 'A change needs a "why".');
  });

  edges.remove.forEach((e, i) => {
    const p = `edges.remove[${i}]`;
    if (!isObject(e)) return err(p, 'A removed edge is an object with from, to and why.');
    existingEdge(e, p, 'remove');
    if (!isText(e.why)) err(`${p}.why`, 'A removal needs a "why".');
  });

  // --- who does a step, where, and what is asked (spec 0029 section 3)
  function checkActor(actor, p) {
    if (!isText(actor) || !KEBAB.test(actor)) return err(p, `"actor" must be a persona id: lower-case words joined by dashes, like "child" (got ${JSON.stringify(actor)}).`);
    const id = personaNodeId(actor);
    if (!exists(id)) err(p, `Actor "${actor}" is no persona: "${id}" is in neither the map nor the added nodes.`, 'dangling');
  }
  function checkAt(place, p) {
    if (!isText(place)) return err(p, `"at" must be a node id or a live id (${LIVE_GRAMMAR}).`);
    if (exists(place) || parseLiveId(place)) return;
    if (place.startsWith(LIVE_ID_PREFIX)) err(p, `"${place}" is not a live id: write ${LIVE_GRAMMAR}.`);
    else err(p, `Step happens nowhere: "${place}" is in neither the map nor the added nodes, and is not a live id.`, 'dangling');
  }
  const SHAPE = 'A check is { route, method } or { table, op, row? }';
  function checkOne(c, p) {
    if (!isObject(c)) return err(p, `${SHAPE}.`);
    const route = 'route' in c || 'method' in c;
    const table = 'table' in c || 'op' in c || 'row' in c;
    if (route && table) return err(p, `${SHAPE}: either one, not both.`);
    if (!route && !table) return err(p, `${SHAPE}.`);
    const keys = route ? ['route', 'method'] : ['table', 'op', 'row'];
    for (const key of Object.keys(c)) if (!keys.includes(key)) err(`${p}.${key}`, `Unknown key "${key}" in a ${route ? 'route' : 'table'} check. It has: ${keys.join(', ')}.`);
    if (route) {
      if (!isText(c.route) || !c.route.startsWith('/')) err(`${p}.route`, '"route" must be a path starting with a slash, as the map labels it ("/api/v1/rooms/[id]") or a concrete one.');
      if (!CHECK_METHODS.includes(c.method)) err(`${p}.method`, `"method" must be one of: ${CHECK_METHODS.join(', ')}.`);
    } else {
      if (!isText(c.table)) err(`${p}.table`, '"table" must be the SQL table name.');
      if (!CHECK_OPS.includes(c.op)) err(`${p}.op`, `"op" must be one of: ${CHECK_OPS.join(', ')}.`);
      if (c.row !== undefined && !CHECK_ROWS.includes(c.row)) err(`${p}.row`, `"row" must be one of: ${CHECK_ROWS.join(', ')}.`);
    }
  }
  function checkChecks(check, p) {
    if (Array.isArray(check)) check.forEach((c, k) => checkOne(c, `${p}[${k}]`));
    else checkOne(check, p);
  }

  /** An outage scenario's `down` (spec 0031 section 8): cloud nodes of the map or the proposal, each once */
  function checkDown(down, p) {
    if (!Array.isArray(down)) return err(p, '"down" must be a list of the cloud node ids the scenario takes down.');
    if (down.length === 0) return err(p, '"down" needs at least one cloud node id; leave it out for a scenario that is no outage.');
    const seen = new Set();
    down.forEach((id, k) => {
      const dp = `${p}[${k}]`;
      if (!isText(id)) return err(dp, '"down" holds node ids: strings like "ext-cloudflare".');
      if (seen.has(id)) return err(dp, `"${id}" is down twice.`);
      seen.add(id);
      const node = nodeOf(id);
      if (!node) return err(dp, `Down node "${id}" is in neither the map nor the added nodes.`, removedIds.has(id) ? 'missing-target' : 'dangling');
      if (node.type !== 'external' || node.kind !== 'cloud') {
        const what = node.type !== 'external' ? `a ${node.type}` : node.kind === undefined ? 'an external with no kind' : `an external of kind ${node.kind}`;
        err(dp, `"${id}" is ${what}: only an external of kind cloud can be down (a container, a stack or a machine is the House view's; the public web is never down as a whole).`);
      }
    });
  }

  // --- scenarios
  // A step may point at what the proposal removes; after the build that thing is gone, which is not a typo
  const removedEdgeKeys = new Set(edges.remove.filter((e) => isObject(e) && isText(e.from) && isText(e.to)).map(edgeKey));
  const removedByProposal = (key, e) => removedEdgeKeys.has(key) || removedIds.has(e.from) || removedIds.has(e.to);
  if (proposal.scenarios !== undefined && !Array.isArray(proposal.scenarios)) err('scenarios', '"scenarios" must be a list.');
  const seenScenario = new Set();
  asList(proposal.scenarios).forEach((s, i) => {
    const p = `scenarios[${i}]`;
    if (!isObject(s)) return err(p, 'A scenario is an object with an id, a title and steps.');
    if (!isText(s.id)) err(`${p}.id`, 'A scenario needs an "id".');
    else if (seenScenario.has(s.id)) err(`${p}.id`, `Scenario id "${s.id}" is used twice.`);
    if (isText(s.id)) seenScenario.add(s.id);
    if (!isText(s.title)) err(`${p}.title`, 'A scenario needs a "title".');
    for (const key of Object.keys(s)) if (!SCENARIO_KEYS.includes(key)) err(`${p}.${key}`, `Unknown key "${key}" in a scenario. A scenario has: ${SCENARIO_KEYS.join(', ')}.`);
    if (s.stepMs !== undefined && !isPositive(s.stepMs)) err(`${p}.stepMs`, '"stepMs" must be a positive number of milliseconds.');
    if (s.linkNodes !== undefined && typeof s.linkNodes !== 'boolean') err(`${p}.linkNodes`, '"linkNodes" must be true or false.');
    if (s.actor !== undefined) checkActor(s.actor, `${p}.actor`);
    if (s.down !== undefined) checkDown(s.down, `${p}.down`);
    if (!Array.isArray(s.steps)) return err(`${p}.steps`, '"steps" must be a list.');
    if (s.steps.length === 0) return err(`${p}.steps`, 'A scenario needs at least one step.');
    s.steps.forEach((step, j) => {
      const sp = `${p}.steps[${j}]`;
      if (!isObject(step)) return err(sp, 'A step is an object with a "node" or an "edge", and some "text".');
      for (const key of Object.keys(step)) if (!STEP_KEYS.includes(key)) err(`${sp}.${key}`, `Unknown key "${key}" in a step. A step has "node" or "edge", and "text"; optionally ${STEP_KEYS.slice(3).join(', ')}.`);
      if (!isText(step.text)) err(`${sp}.text`, 'A step needs "text": what happens at this point.');
      if (step.ms !== undefined && !isPositive(step.ms)) err(`${sp}.ms`, '"ms" must be a positive number of milliseconds.');
      if (step.actor !== undefined) checkActor(step.actor, `${sp}.actor`);
      if (step.at !== undefined) checkAt(step.at, `${sp}.at`);
      if (step.check !== undefined) checkChecks(step.check, `${sp}.check`);
      if (step.expect !== undefined) {
        if (!EXPECTS.includes(step.expect)) err(`${sp}.expect`, `"expect" must be one of: ${EXPECTS.join(', ')}.`);
        else if (step.actor === undefined && s.actor === undefined) err(`${sp}.expect`, '"expect" needs an actor, on the step or its scenario: a step with no actor is never checked.');
      }
      if ((step.node === undefined) === (step.edge === undefined)) err(sp, 'A step points at exactly one of "node" or "edge".');
      if (step.node !== undefined) {
        if (!isText(step.node)) err(`${sp}.node`, '"node" must be a node id.');
        else if (!exists(step.node)) err(`${sp}.node`, `Step points at nothing: node "${step.node}" is in neither the map nor the added nodes.`, removedIds.has(step.node) ? 'missing-target' : 'dangling');
      }
      if (step.edge !== undefined) {
        if (!isObject(step.edge)) return err(`${sp}.edge`, '"edge" must be an object with from and to.');
        const key = readEdge(step.edge, `${sp}.edge`);
        if (key && !baseEdgeKeys.has(key) && !seenEdge.has(key)) err(`${sp}.edge`, `Step points at nothing: edge ${describe(step.edge)} is in neither the map nor the added edges.`, removedByProposal(key, step.edge) ? 'missing-target' : 'dangling');
      }
    });
  });

  return errors;
}

const THEME_FALLBACK = NODE_THEMES.external;

/**
 * The map with the proposal drawn in. Both arrays are new, and nothing passed in is changed; but
 * values nested inside a base node or edge (a `render` object, a `keys` list) are shared with the
 * input, so treat the result as read-only apart from its own top-level fields (the layout writes x, y).
 *
 * Every node and edge carries `mark`:
 *  - `none`     untouched
 *  - `added`    from the proposal; an added node has `color` and `r` from its type; `parent` became an ownership edge
 *  - `changed`  the `set` fields are applied; `before` holds the old value of each field that differs
 *               (`null` for a field the item did not have) and `why` the reason
 *  - `removed`  kept in the result with its `why`; the viewer hides it in the After view. Every edge of
 *               a removed node is marked removed too
 *
 * An added node or edge the map already has (the build has landed) is not drawn twice: the map's own is marked `added`.
 *
 * Order: the map's nodes then the added ones; the map's edges, the ownership edges of added nodes,
 * then the added edges. Run `validateProposal` first: an invalid proposal is applied as far as it can be read.
 * @param {{ nodes: object[], edges: object[] }} topology
 * @param {object} proposal
 * @returns {{ nodes: object[], edges: object[] }}
 */
export function applyProposal(topology, proposal) {
  const nodes = topology.nodes.map((n) => ({ ...n, mark: 'none' }));
  const edges = topology.edges.map((e) => ({ ...e, mark: 'none' }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byKey = new Map();
  for (const e of edges) {
    const key = edgeKey(e);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }
  const block = (name) => ({ add: asList(proposal[name]?.add), change: asList(proposal[name]?.change), remove: asList(proposal[name]?.remove) });
  const pn = block('nodes');
  const pe = block('edges');

  /** Sets fields on an item, noting what each was */
  const change = (item, set, why) => {
    const before = {};
    const put = (field, value) => {
      if (same(item[field], value)) return;
      before[field] = item[field] === undefined ? null : item[field];
      item[field] = clone(value);
    };
    for (const [field, value] of Object.entries(set || {})) put(field, value);
    item.mark = 'changed';
    item.before = before;
    item.why = why;
  };

  for (const c of pn.change) {
    const node = byId.get(c.id);
    if (!node) continue;
    const set = { ...c.set };
    // A new type brings its colour and radius, unless the change says otherwise
    const theme = NODE_THEMES[set.type];
    if (theme) {
      if (!('color' in set)) set.color = theme.color;
      if (!('r' in set)) set.r = theme.r;
    }
    change(node, set, c.why);
  }
  for (const c of pe.change) for (const e of byKey.get(edgeKey(c)) || []) change(e, c.set, c.why);
  for (const r of pe.remove) {
    for (const e of byKey.get(edgeKey(r)) || []) {
      delete e.before;
      e.mark = 'removed';
      e.why = r.why;
    }
  }
  for (const r of pn.remove) {
    const node = byId.get(r.id);
    if (!node) continue;
    node.mark = 'removed';
    node.why = r.why;
    for (const e of edges) {
      if ((e.from === r.id || e.to === r.id) && e.mark !== 'removed') {
        delete e.before;
        e.mark = 'removed';
        e.why = r.why;
      }
    }
  }

  const ownership = [];
  // What the map already has (the build has landed) is marked in place, not drawn a second time
  const addEdge = (e) => {
    const there = byKey.get(edgeKey(e));
    if (there) there.forEach((x) => { if (x.mark === 'none') x.mark = 'added'; });
    else edges.push({ ...clone(e), mark: 'added' });
  };
  for (const a of pn.add) {
    const { parent, ...fields } = clone(a);
    const theme = NODE_THEMES[a.type] || THEME_FALLBACK;
    const there = byId.get(a.id);
    if (there) { if (there.mark === 'none') there.mark = 'added'; }
    else nodes.push({ ...fields, color: theme.color, r: a.r ?? theme.r, mark: 'added' });
    if (parent) ownership.push({ from: parent, to: a.id });
  }
  for (const o of ownership) addEdge(o);
  for (const a of pe.add) addEdge(a);
  return { nodes, edges };
}

/**
 * @typedef {'pending' | 'landed' | 'diverged' | 'live'} ItemStatus
 * @typedef {{ kind: 'node' | 'edge', op: 'add' | 'change' | 'remove', key: string, status: ItemStatus }} StatusItem
 *   `key` is the node id, or the edge's `edgeKey`
 */

/**
 * After the code is built, did what was approved land? Each node and edge item (scenarios are not
 * items) is read against the map as it is now:
 *
 *  - an **added** item is `landed` when it exists, `diverged` when it exists as something else (a node
 *    of another type, or not under the proposed parent; an edge whose ends are joined by another kind),
 *    else `pending`
 *  - a **removal** is `landed` when the item is gone, else `pending`
 *  - a **change** is `landed` when every `set` field now holds that value, `pending` while one does not,
 *    and `diverged` when the item itself is gone (it was removed, or renamed, instead)
 *
 * A change whose values already held when it was written reads `landed` at once: the status compares
 * values, not history.
 *
 * What only the live layer draws (spec 0029 D9: an added floor, room or device no code file derives, and
 * every added edge with an end that is one) never lands in topology.json, so it reads `live`, never `pending`;
 * the explorer marks it present or absent against the live layer.
 * @param {{ nodes: object[], edges: object[] }} topology the map as it is now
 * @param {object} proposal
 * @returns {{ items: StatusItem[], summary: { total: number, pending: number, landed: number, diverged: number, live: number } }}
 */
export function proposalStatus(topology, proposal) {
  const nodes = new Map(topology.nodes.map((n) => [n.id, n]));
  const edgeByKey = new Map();
  const kindsBetween = new Map();
  const parents = new Map();
  for (const e of topology.edges) {
    const key = edgeKey(e);
    if (!edgeByKey.has(key)) edgeByKey.set(key, e);
    const pair = `${e.from}|${e.to}`;
    if (!kindsBetween.has(pair)) kindsBetween.set(pair, new Set());
    kindsBetween.get(pair).add(key);
    if (!e.kind && !e.dashed) {
      if (!parents.has(e.to)) parents.set(e.to, new Set());
      parents.get(e.to).add(e.from);
    }
  }
  const holds = (item, set) => Object.entries(set || {}).every(([k, v]) => same(item[k], v));
  const list = (block, op) => asList(proposal?.[block]?.[op]);
  const liveAdds = new Set(list('nodes', 'add').filter((a) => isObject(a) && isLiveNode(a)).map((a) => a.id));
  const liveEnd = (id) => liveAdds.has(id) || (typeof id === 'string' && id.startsWith(LIVE_ID_PREFIX));

  const items = [];
  const push = (kind, op, key, status) => items.push({ kind, op, key, status });

  for (const a of list('nodes', 'add')) {
    if (liveAdds.has(a.id)) { push('node', 'add', a.id, 'live'); continue; }
    const n = nodes.get(a.id);
    push('node', 'add', a.id, !n ? 'pending' : n.type !== a.type || (a.parent && !parents.get(a.id)?.has(a.parent)) ? 'diverged' : 'landed');
  }
  for (const c of list('nodes', 'change')) {
    const n = nodes.get(c.id);
    push('node', 'change', c.id, !n ? 'diverged' : holds(n, c.set) ? 'landed' : 'pending');
  }
  for (const r of list('nodes', 'remove')) push('node', 'remove', r.id, nodes.has(r.id) ? 'pending' : 'landed');

  for (const a of list('edges', 'add')) {
    const key = edgeKey(a);
    if (liveEnd(a.from) || liveEnd(a.to)) { push('edge', 'add', key, 'live'); continue; }
    const other = [...(kindsBetween.get(`${a.from}|${a.to}`) || [])].some((k) => k !== key);
    push('edge', 'add', key, edgeByKey.has(key) ? 'landed' : other ? 'diverged' : 'pending');
  }
  for (const c of list('edges', 'change')) {
    const key = edgeKey(c);
    const e = edgeByKey.get(key);
    push('edge', 'change', key, !e ? 'diverged' : holds(e, c.set) ? 'landed' : 'pending');
  }
  for (const r of list('edges', 'remove')) {
    const key = edgeKey(r);
    push('edge', 'remove', key, edgeByKey.has(key) ? 'pending' : 'landed');
  }

  const summary = { total: items.length, pending: 0, landed: 0, diverged: 0, live: 0 };
  for (const i of items) summary[i.status]++;
  return { items, summary };
}

/**
 * What is wrong with a proposal (spec 0012 B1), read against the map. The build has begun when something the
 * proposal ADDS now exists as proposed (a node of that type under that parent, or the edge): that is the only
 * evidence a typo cannot fake. From then on the mistakes a landing explains, an added id that now exists
 * ('exists') and a removed or changed target that is gone ('missing-target'), are expected and skipped;
 * 'dangling' ones (a parent, an edge end or a step that points at nothing) and structural ones always count.
 * A proposal with no additions (only removals or changes) is never "building": once its items are gone the
 * file reports them missing, so delete it (or close its spec) in the PR that lands it.
 * @param {{ nodes: object[], edges: object[] }} topology
 * @param {unknown} proposal
 * @returns {{ errors: ProposalError[], building: boolean }}
 */
export function proposalProblems(topology, proposal) {
  const all = validateProposal(topology, proposal);
  let building = false;
  if (all.some((e) => e.state === 'exists' || e.state === 'missing-target')) {
    try {
      building = proposalStatus(topology, proposal).items.some((i) => i.op === 'add' && i.status === 'landed');
    } catch {
      // Too malformed to have a status: it is held to every error
    }
  }
  return { errors: building ? all.filter((e) => e.state !== 'exists' && e.state !== 'missing-target') : all, building };
}

/**
 * The numbers behind the counts chip ("3 added · 1 changed · 1 removed"): nodes and edges counted together.
 * @param {object} proposal
 * @returns {{ added: number, changed: number, removed: number, scenarios: number }}
 */
export function summarize(proposal) {
  const count = (op) => asList(proposal?.nodes?.[op]).length + asList(proposal?.edges?.[op]).length;
  return { added: count('add'), changed: count('change'), removed: count('remove'), scenarios: asList(proposal?.scenarios).length };
}

/**
 * What-if edits, as the viewer and the what-if agent write them. Every edit is `{ op, …fields }`; an
 * `at` (a timestamp) may ride along and is ignored here. Indexes are 0-based positions in the
 * scenario's `steps`.
 *
 * @typedef {{ op: 'add-node', id?: string, label: string, type: string, parent?: string, desc?: string }} AddNode
 *   Adds a node. Without an `id` one is made from the type and label (`service-meal-planner`), made unique among the added nodes.
 *   Any other node field rides along.
 * @typedef {{ op: 'remove-node', id: string, why?: string }} RemoveNode
 *   A node of the map: lists it under nodes.remove with `why` (default "Removed while editing.") and drops a change to it.
 *   A node the proposal added: drops it with everything the proposal hung on it (its edges, the nodes under it, the steps that point at them).
 * @typedef {{ op: 'add-edge', from: string, to: string, kind?: string, flow?: string, label?: string }} AddEdge
 *   Adds an edge. Any other edge field rides along.
 * @typedef {{ op: 'remove-edge', from: string, to: string, kind?: string, flow?: string, why?: string }} RemoveEdge
 *   An edge of the map: lists it under edges.remove and drops a change to it. An edge the proposal added: drops it and the steps that point at it.
 * @typedef {{ op: 'add-step', scenario: string, step: Step, index?: number, title?: string }} AddStep
 *   Inserts the step at `index` (default: the end). An unknown `scenario` id makes the scenario, titled `title` (default: the id).
 * @typedef {{ op: 'edit-step', scenario: string, index: number, step: Partial<Step> }} EditStep
 *   Merges `step` into the step: `text` rewords it; `node` or `edge` retargets it (setting one removes the other).
 * @typedef {{ op: 'move-step', scenario: string, from: number, to: number }} MoveStep
 *   Takes the step at `from` and puts it at `to`.
 * @typedef {{ op: 'remove-step', scenario: string, index: number }} RemoveStep
 *   Deletes the step. A scenario left with no steps stays (validateProposal reports it) so the next edit can fill it.
 * @typedef {(AddNode | RemoveNode | AddEdge | RemoveEdge | AddStep | EditStep | MoveStep | RemoveStep) & { at?: number }} Edit
 *   `at` is the time the edit was made (ms since the epoch); kept by the viewer for its undo list, ignored here.
 * @typedef {{ node?: string, edge?: { from: string, to: string, kind?: string, flow?: string }, text: string, ms?: number, actor?: string, at?: string, check?: object | object[], expect?: 'allowed' | 'refused' }} Step
 */

/** A label as an id part: lower case, dashes between runs of letters and digits ('node' when nothing is left). The server imports this file in the browser, which cannot take the models' slugify (the allowlist would have to serve its whole graph) */
export const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'node';
const stripEdit = ({ op, at, ...fields }) => fields;
const edgeOf = (e) => Object.fromEntries(['from', 'to', 'kind', 'flow'].filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
const stepPointsAt = (step, ids, keys) => (step.node !== undefined && ids.has(step.node))
  || (isObject(step.edge) && (ids.has(step.edge.from) || ids.has(step.edge.to) || keys.has(edgeKey(step.edge))));

/**
 * A new proposal with a list of what-if edits folded in, in order. The input is not changed.
 * An edit it cannot read (an unknown `op`, a scenario that is not there, a step index out of range)
 * throws an Error that names the edit; everything the edit makes wrong in the proposal's own terms
 * (an unknown type, a missing parent) is left for `validateProposal` to report.
 * @param {object} proposal
 * @param {Edit[]} edits
 * @returns {object}
 */
export function applyEdits(proposal, edits) {
  const next = clone(proposal);
  const list = (block, op) => {
    if (!isObject(next[block])) next[block] = {};
    if (!Array.isArray(next[block][op])) next[block][op] = [];
    return next[block][op];
  };
  const scenarios = () => (Array.isArray(next.scenarios) ? next.scenarios : (next.scenarios = []));
  /** Drops every step that points at a dropped node or edge */
  const dropSteps = (ids, keys) => {
    for (const s of scenarios()) if (Array.isArray(s.steps)) s.steps = s.steps.filter((step) => !stepPointsAt(step, ids, keys));
    // An outage of a dropped node is no outage: it leaves `down`, and an emptied `down` goes
    for (const s of scenarios()) {
      if (!Array.isArray(s.down)) continue;
      s.down = s.down.filter((id) => !ids.has(id));
      if (s.down.length === 0) delete s.down;
    }
  };

  asList(edits).forEach((edit, n) => {
    const fail = (message) => { throw new Error(`edit #${n + 1} (${edit?.op}): ${message}`); };
    const scenarioOf = () => scenarios().find((s) => s.id === edit.scenario) || fail(`no scenario "${edit.scenario}"`);
    const stepIndex = (steps, i, label = 'index') => {
      if (!Number.isInteger(i) || i < 0 || i >= steps.length) fail(`${label} ${i} is out of range (the scenario has ${steps.length} step${steps.length === 1 ? '' : 's'})`);
      return i;
    };

    switch (edit?.op) {
      case 'add-node': {
        const fields = stripEdit(edit);
        if (!fields.id) {
          const taken = new Set(list('nodes', 'add').map((a) => a.id));
          const base = `${fields.type ?? 'node'}-${slug(fields.label)}`;
          let id = base;
          for (let k = 2; taken.has(id); k++) id = `${base}-${k}`;
          fields.id = id;
        }
        list('nodes', 'add').push({ id: fields.id, ...fields });
        break;
      }
      case 'remove-node': {
        const adds = list('nodes', 'add');
        if (adds.some((a) => a.id === edit.id)) {
          // Dropping an added node drops what hangs on it: the nodes under it, their edges, the steps that point at them
          const gone = new Set([edit.id]);
          for (let grew = true; grew;) {
            grew = false;
            for (const a of adds) if (!gone.has(a.id) && gone.has(a.parent)) { gone.add(a.id); grew = true; }
          }
          next.nodes.add = adds.filter((a) => !gone.has(a.id));
          const edgeAdds = list('edges', 'add');
          const dropped = edgeAdds.filter((e) => gone.has(e.from) || gone.has(e.to));
          next.edges.add = edgeAdds.filter((e) => !dropped.includes(e));
          dropSteps(gone, new Set(dropped.map(edgeKey)));
        } else {
          next.nodes.change = list('nodes', 'change').filter((c) => c.id !== edit.id);
          const removes = list('nodes', 'remove');
          if (!removes.some((r) => r.id === edit.id)) removes.push({ id: edit.id, why: edit.why || 'Removed while editing.' });
        }
        break;
      }
      case 'add-edge':
        list('edges', 'add').push(stripEdit(edit));
        break;
      case 'remove-edge': {
        const key = edgeKey(edit);
        const adds = list('edges', 'add');
        if (adds.some((e) => edgeKey(e) === key)) {
          next.edges.add = adds.filter((e) => edgeKey(e) !== key);
          dropSteps(new Set(), new Set([key]));
        } else {
          next.edges.change = list('edges', 'change').filter((e) => edgeKey(e) !== key);
          const removes = list('edges', 'remove');
          if (!removes.some((e) => edgeKey(e) === key)) removes.push({ ...edgeOf(edit), why: edit.why || 'Removed while editing.' });
        }
        break;
      }
      case 'add-step': {
        let scenario = scenarios().find((s) => s.id === edit.scenario);
        if (!scenario) scenarios().push((scenario = { id: edit.scenario, title: edit.title || edit.scenario, steps: [] }));
        if (!Array.isArray(scenario.steps)) scenario.steps = [];
        const index = edit.index ?? scenario.steps.length;
        if (!Number.isInteger(index) || index < 0 || index > scenario.steps.length) fail(`index ${index} is out of range (the scenario has ${scenario.steps.length} step${scenario.steps.length === 1 ? '' : 's'})`);
        scenario.steps.splice(index, 0, clone(edit.step));
        break;
      }
      case 'edit-step': {
        const steps = scenarioOf().steps;
        const i = stepIndex(steps, edit.index);
        const patch = clone(edit.step) || {};
        const merged = { ...steps[i] };
        if ('node' in patch) delete merged.edge;
        if ('edge' in patch) delete merged.node;
        steps[i] = Object.assign(merged, patch);
        break;
      }
      case 'move-step': {
        const steps = scenarioOf().steps;
        const from = stepIndex(steps, edit.from, 'from index');
        const to = stepIndex(steps, edit.to, 'to index');
        const [moved] = steps.splice(from, 1);
        steps.splice(to, 0, moved);
        break;
      }
      case 'remove-step': {
        const steps = scenarioOf().steps;
        steps.splice(stepIndex(steps, edit.index), 1);
        break;
      }
      default:
        fail(`unknown op "${edit?.op}". Known: add-node, remove-node, add-edge, remove-edge, add-step, edit-step, move-step, remove-step`);
    }
  });
  return next;
}

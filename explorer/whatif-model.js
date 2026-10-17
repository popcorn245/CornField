/**
 * @module explorer/whatif-model
 *
 * The pure half of what-if editing (spec 0012 B4, TOPO-11): no DOM, no `window`, no clock. The
 * maintainer's edits are a list of operations kept apart from the robot's proposal; the map is drawn from
 * `applyEdits(proposal, edits)` (core/proposal.js), and `state.proposal` is never touched.
 * whatif.js (the controls, the keyboard, the drag that draws an edge, localStorage) is the half that
 * touches the page; everything it decides lives here so it can be tested without one.
 *
 *   WhatIf                    { edits: Edit[], undone: Edit[] }: what is applied, and what Undo took back
 *   pushEdit / undo / redo    the list; a new edit empties `undone`; each returns a new WhatIf
 *   editFromIntent            what a click on a control means, as an edit (`{ op, ..., at }`)
 *   tryEdit                   an edit applied only when it does not make the proposal worse (else a plain-words refusal)
 *   replay                    a stored list laid over a proposal again, dropping what no longer fits
 *   markEdits                 gives the items the edits added or removed the `edit` mark (the map's view of them)
 *   storageKey / serialize / parseStored   what goes to localStorage
 *   nodeAtPoint               the drag that draws an edge: which node is under the pointer
 *   describeEdit              one line per edit, for the "Your edits" list
 *
 * What an edit looks like on the map: an item an edit ADDS (a node, an edge, the ownership edge of its
 * parent) carries `mark: 'edit'` and `editOp: 'added'`; an item an edit REMOVES keeps being drawn, in violet
 * with the red look of a removal (faded, label struck through), `mark: 'edit'`, `editOp: 'removed'`. So the
 * Before view hides what you added and the After view hides what you removed, exactly as for the robot's own
 * marks, and Diff shows both in violet. A node the robot's proposal added that an edit drops is simply gone.
 */

import { applyEdits, edgeKey, slug, validateProposal } from '../core/proposal.js';
import { EDGE_KINDS, FLOW_KINDS, NODE_THEMES } from '../core/schema.js';

export const NODE_TYPES = Object.keys(NODE_THEMES);
/** What the edge picker offers: no kind is the ownership edge (parent to child) */
export const EDGE_CHOICES = [{ value: '', label: 'Ownership (parent to child)' }, ...EDGE_KINDS.map((k) => ({ value: k, label: k }))];
export { FLOW_KINDS };

/** Edits are kept this many to a proposal; a runaway list must not fill localStorage */
export const MAX_EDITS = 500;

const asList = (v) => (Array.isArray(v) ? v : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------
//  The list: edits, undo, redo
// ---------------------------------------------------------------------------

/** @returns {{ edits: object[], undone: object[] }} */
export const emptyWhatIf = () => ({ edits: [], undone: [] });
export const canUndo = (wi) => wi.edits.length > 0;
export const canRedo = (wi) => wi.undone.length > 0;
export const hasEdits = (wi) => wi.edits.length > 0 || wi.undone.length > 0;

/** A new edit goes on the end; whatever Undo had taken back can no longer be redone */
export const pushEdit = (wi, edit) => ({ edits: [...wi.edits, edit], undone: [] });
export const undo = (wi) => (canUndo(wi) ? { edits: wi.edits.slice(0, -1), undone: [...wi.undone, wi.edits[wi.edits.length - 1]] } : wi);
export const redo = (wi) => (canRedo(wi) ? { edits: [...wi.edits, wi.undone[wi.undone.length - 1]], undone: wi.undone.slice(0, -1) } : wi);
/** The list without the edit at `index` (what a row's remove does); Redo is left alone */
export const withoutEditAt = (wi, index) => ({ edits: wi.edits.filter((_, i) => i !== index), undone: wi.undone });

// ---------------------------------------------------------------------------
//  localStorage
// ---------------------------------------------------------------------------

export const STORAGE_PREFIX = 'topology-explorer:whatif:';
export const STORAGE_VERSION = 1;

/** The key a proposal's edits are kept under: its source (where the server found it) and its slug */
export const storageKey = (slug, source) => `${STORAGE_PREFIX}${source || 'checkout'}/${slug}`;

/**
 * What is written to localStorage:
 * `{ "version": 1, "slug", "source", "savedAt": <ms>, "edits": Edit[], "undone": Edit[] }`
 * @returns {string}
 */
export function serialize(wi, { slug, source, now }) {
  return JSON.stringify({ version: STORAGE_VERSION, slug, source: source || 'checkout', savedAt: now, edits: wi.edits, undone: wi.undone });
}

/** Reads what `serialize` wrote; anything else (no text, bad JSON, another version, not edits) is an empty list */
export function parseStored(text) {
  try {
    const data = JSON.parse(text);
    if (!isObject(data) || data.version !== STORAGE_VERSION) return emptyWhatIf();
    const clean = (list) => asList(list).filter((e) => isObject(e) && typeof e.op === 'string').slice(0, MAX_EDITS);
    return { edits: clean(data.edits), undone: clean(data.undone) };
  } catch {
    return emptyWhatIf();
  }
}

// ---------------------------------------------------------------------------
//  Applying edits, and refusing the ones that make things worse
// ---------------------------------------------------------------------------

/**
 * The proposal with the edits folded in, and what is wrong with it.
 * @returns {{ effective: object, errors: object[], failed: string|null }} `failed`: an edit `applyEdits` could not read (then `effective` is the proposal as it was)
 */
export function evaluate(base, proposal, edits) {
  try {
    const effective = applyEdits(proposal, edits);
    return { effective, errors: validateProposal(base, effective), failed: null };
  } catch (err) {
    return { effective: proposal, errors: validateProposal(base, proposal), failed: err.message || String(err) };
  }
}

/**
 * The errors that stop an edit: the structural ones (no `state`), a `dangling` one (something points at
 * nothing), and `exists` (what it adds is already on the map). A scenario left with no steps is allowed, and so is a `missing-target` one: a step
 * may point at what the proposal removes ("this call goes away"), and the problem list says so.
 */
const blocking = (e) => (!e.state || e.state === 'dangling' || e.state === 'exists') && !EMPTY_SCENARIO.test(e.path);
/** A scenario with no steps left (the last step deleted, or the node its steps pointed at dropped) is a state to edit from, not a mistake: the problem list says it */
const EMPTY_SCENARIO = /^scenarios\[\d+\]\.steps$/;

/**
 * Did the `after` errors gain a blocking one that `before` did not have? Compared by message, so a proposal that
 * arrives with problems of its own (the robot's) does not stop every edit, and a path that moved because a list
 * grew does not count as new. Returns the first such message in plain words, or null.
 */
export function newBlockingProblem(before, after) {
  const seen = new Map();
  for (const e of before) if (blocking(e)) seen.set(e.message, (seen.get(e.message) || 0) + 1);
  for (const e of after) {
    if (!blocking(e)) continue;
    const left = seen.get(e.message) || 0;
    if (left > 0) seen.set(e.message, left - 1);
    else return e.message;
  }
  return null;
}

/**
 * Adds an edit to the list unless it makes the proposal worse.
 * @param {{nodes: object[], edges: object[]}} base the pristine map
 * @param {object} proposal the robot's proposal (never changed)
 * @param {{edits: object[], undone: object[]}} wi
 * @param {object} edit
 * @returns {{ ok: true, whatIf: {edits: object[], undone: object[]}, effective: object, errors: object[] } | { ok: false, message: string }}
 */
export function tryEdit(base, proposal, wi, edit) {
  if (wi.edits.length >= MAX_EDITS) return { ok: false, message: `That is as many edits as one proposal keeps (${MAX_EDITS}). Send these back first.` };
  const before = evaluate(base, proposal, wi.edits);
  const next = pushEdit(wi, edit);
  const after = evaluate(base, proposal, next.edits);
  if (after.failed) return { ok: false, message: after.failed.replace(/^edit #\d+ \([^)]*\): /, '') };
  const problem = newBlockingProblem(before.errors, after.errors);
  if (problem) return { ok: false, message: problem };
  return { ok: true, whatIf: next, effective: after.effective, errors: after.errors };
}

/**
 * Takes the edit at `index` out of the middle of the list, unless a later edit builds on it.
 * @returns {{ ok: true, whatIf: object, effective: object, errors: object[] } | { ok: false, message: string }}
 */
export function tryRemoveEdit(base, proposal, wi, index) {
  const before = evaluate(base, proposal, wi.edits);
  const next = withoutEditAt(wi, index);
  const after = evaluate(base, proposal, next.edits);
  if (after.failed) return { ok: false, message: 'A later edit builds on this one. Remove that one first.' };
  const problem = newBlockingProblem(before.errors, after.errors);
  if (problem) return { ok: false, message: `A later edit builds on this one. Remove that one first (${problem})` };
  return { ok: true, whatIf: next, effective: after.effective, errors: after.errors };
}

/**
 * A stored list laid over a proposal again. The robot may have rewritten the proposal since the edits were made, so an edit
 * that no longer fits (it cannot be read, or it makes the proposal worse) is dropped, and the rest are kept in order.
 * @returns {{ whatIf: {edits: object[], undone: object[]}, dropped: {edit: object, message: string}[], effective: object, errors: object[] }}
 */
export function replay(base, proposal, wi) {
  let kept = emptyWhatIf();
  const dropped = [];
  let effective = proposal;
  let errors = validateProposal(base, proposal);
  for (const edit of wi.edits) {
    const result = tryEdit(base, proposal, kept, edit);
    if (result.ok) {
      kept = { edits: result.whatIf.edits, undone: [] };
      effective = result.effective;
      errors = result.errors;
    } else dropped.push({ edit, message: result.message });
  }
  kept.undone = wi.undone;
  return { whatIf: kept, dropped, effective, errors };
}

// ---------------------------------------------------------------------------
//  Intents: what a control means, as an edit
// ---------------------------------------------------------------------------

/** An id for a new node: from its type and label, unique among the map's nodes and the ones the proposal already adds */
export function newNodeId(type, label, taken) {
  const root = `${type || 'node'}-${slug(label)}`;
  let id = root;
  for (let k = 2; taken.has(id); k++) id = `${root}-${k}`;
  return id;
}

/** A scenario id for a new scenario: from its title, unique among the scenarios there are */
export function newScenarioId(title, scenarios) {
  const taken = new Set(asList(scenarios).map((s) => s.id));
  const root = slug(title) || 'scenario';
  let id = root;
  for (let k = 2; taken.has(id); k++) id = `${root}-${k}`;
  return id;
}

/**
 * The kind the edge picker starts on, from what the two ends are (the maintainer changes it when it is wrong); '' is an ownership edge.
 * @param {string} [fromType]
 * @param {string} [toType]
 */
export function suggestKind(fromType, toType) {
  if (fromType === 'page' && toType === 'table') return 'writes';
  if (fromType === 'table' && toType === 'page') return 'reads';
  if ((fromType === 'service' || fromType === 'page') && (toType === 'external' || toType === 'service')) return 'calls';
  if (fromType === 'app' && toType === 'stack') return 'runs-on';
  return '';
}

const edgeFields = (e) => Object.fromEntries(['from', 'to', 'kind', 'flow'].filter((k) => e[k] !== undefined && e[k] !== '').map((k) => [k, e[k]]));

/**
 * What a click on a control means, as an edit `{ op, ..., at }` (the shapes of `applyEdits`). Pure: `ctx` says what is on the
 * map and what time it is.
 *
 *  - `{ type: 'add-node', nodeType, label, parent?, desc? }`
 *  - `{ type: 'remove-node', id }`
 *  - `{ type: 'add-edge', from, to, kind?, flow?, label? }`
 *  - `{ type: 'remove-edge', edge }`
 *  - `{ type: 'add-step', scenario, node? | edge?, text, index?, title? }`   `scenario` null makes a new one from `title`
 *  - `{ type: 'reword-step', scenario, index, text }`
 *  - `{ type: 'move-step', scenario, from, to }`
 *  - `{ type: 'delete-step', scenario, index }`
 *
 * @param {object} intent
 * @param {{ takenIds: Set<string>, scenarios: object[], now: number }} ctx
 * @returns {object} the edit, or `{ error: string }` when the intent says too little to make one
 */
export function editFromIntent(intent, ctx) {
  const at = ctx.now;
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  switch (intent?.type) {
    case 'add-node': {
      const label = text(intent.label);
      if (!label) return { error: 'Give the node a label.' };
      if (!NODE_TYPES.includes(intent.nodeType)) return { error: 'Pick a type for the node.' };
      const node = { op: 'add-node', id: newNodeId(intent.nodeType, label, ctx.takenIds), label, type: intent.nodeType };
      if (text(intent.parent)) node.parent = text(intent.parent);
      if (text(intent.desc)) node.desc = text(intent.desc);
      return { ...node, at };
    }
    case 'remove-node':
      return { op: 'remove-node', id: intent.id, why: 'Removed by you, to see what it changes.', at };
    case 'add-edge': {
      if (!intent.from || !intent.to) return { error: 'An edge goes from one node to another.' };
      if (intent.from === intent.to) return { error: 'An edge joins two different nodes.' };
      const edge = edgeFields({ from: intent.from, to: intent.to, kind: intent.kind, flow: intent.kind === 'flow' ? intent.flow : undefined });
      if (edge.kind === 'flow' && !FLOW_KINDS.includes(edge.flow)) return { error: 'Pick which flow the edge belongs to.' };
      if (text(intent.label)) edge.label = text(intent.label);
      return { op: 'add-edge', ...edge, at };
    }
    case 'remove-edge':
      return { op: 'remove-edge', ...edgeFields(intent.edge), why: 'Removed by you, to see what it changes.', at };
    case 'add-step': {
      const words = text(intent.text);
      if (!words) return { error: 'Say what happens at this step.' };
      if (!intent.node && !intent.edge) return { error: 'Pick a node or an edge on the map first: the step points at it.' };
      const step = intent.node ? { node: intent.node, text: words } : { edge: edgeFields(intent.edge), text: words };
      const known = intent.scenario && asList(ctx.scenarios).some((s) => s.id === intent.scenario);
      if (known) return { op: 'add-step', scenario: intent.scenario, step, ...(intent.index !== undefined ? { index: intent.index } : {}), at };
      const title = text(intent.title);
      if (!title) return { error: 'Name the new scenario.' };
      return { op: 'add-step', scenario: newScenarioId(title, ctx.scenarios), title, step, at };
    }
    case 'reword-step': {
      const words = text(intent.text);
      if (!words) return { error: 'A step needs some words.' };
      return { op: 'edit-step', scenario: intent.scenario, index: intent.index, step: { text: words }, at };
    }
    case 'move-step':
      return { op: 'move-step', scenario: intent.scenario, from: intent.from, to: intent.to, at };
    case 'delete-step':
      return { op: 'remove-step', scenario: intent.scenario, index: intent.index, at };
    default:
      return { error: 'That is not something the editor can do.' };
  }
}

// ---------------------------------------------------------------------------
//  The picture: the edit mark
// ---------------------------------------------------------------------------

const idsOf = (list) => new Set(asList(list).filter(isObject).map((x) => x.id));
const keysOf = (list) => new Set(asList(list).filter(isObject).map(edgeKey));
const minus = (a, b) => new Set([...a].filter((x) => !b.has(x)));

/**
 * Gives the items the edits added or removed the `edit` mark, on the applied map (`applyProposal(base, effective)`), by comparing
 * what the effective proposal says with what the robot's says. Writes `mark: 'edit'` and `editOp: 'added' | 'removed'` on those
 * nodes and edges and nothing else; everything the robot's proposal did stays as `applyProposal` marked it.
 *  - a node an edit adds, and the ownership edge of its parent, and an edge an edit adds: `added`
 *  - a base node an edit removes, every edge it had, and a base edge an edit removes: `removed`
 * @param {{nodes: object[], edges: object[]}} applied
 * @param {object} robot the proposal as the robot wrote it
 * @param {object} effective the proposal with the edits in
 * @returns {{nodes: object[], edges: object[]}} `applied`
 */
export function markEdits(applied, robot, effective) {
  if (robot === effective) return applied;
  const editAddedNodes = minus(idsOf(effective?.nodes?.add), idsOf(robot?.nodes?.add));
  const editRemovedNodes = minus(idsOf(effective?.nodes?.remove), idsOf(robot?.nodes?.remove));
  const editAddedEdges = minus(keysOf(effective?.edges?.add), keysOf(robot?.edges?.add));
  const editRemovedEdges = minus(keysOf(effective?.edges?.remove), keysOf(robot?.edges?.remove));
  const robotRemovedNodes = idsOf(robot?.nodes?.remove);
  const robotRemovedEdges = keysOf(robot?.edges?.remove);

  for (const n of applied.nodes) {
    if (editAddedNodes.has(n.id) && n.mark === 'added') { n.mark = 'edit'; n.editOp = 'added'; }
    else if (editRemovedNodes.has(n.id) && n.mark === 'removed') { n.mark = 'edit'; n.editOp = 'removed'; }
  }
  for (const e of applied.edges) {
    const key = edgeKey(e);
    if (e.mark === 'added' && (editAddedEdges.has(key) || (!e.kind && editAddedNodes.has(e.to)))) { e.mark = 'edit'; e.editOp = 'added'; }
    else if (e.mark === 'removed') {
      const byRobot = robotRemovedEdges.has(key) || robotRemovedNodes.has(e.from) || robotRemovedNodes.has(e.to);
      if (!byRobot && (editRemovedEdges.has(key) || editRemovedNodes.has(e.from) || editRemovedNodes.has(e.to))) { e.mark = 'edit'; e.editOp = 'removed'; }
    }
  }
  return applied;
}

// ---------------------------------------------------------------------------
//  The scenario player follows the edits
// ---------------------------------------------------------------------------

/**
 * What the scenario that is playing should become after an edit.
 * @param {string|null} playingId the id of the scenario on the player, or null
 * @param {object[]} before the scenarios before the edit
 * @param {object[]} after the scenarios after it
 * @returns {{ action: 'none' } | { action: 'update', scenario: object } | { action: 'stop' }}
 *   `none`: nothing is playing, or what is playing is not a scenario of this proposal (the ROM walk); `update`: hand the player the edited
 *   scenario (it keeps the step it is on); `stop`: the scenario is gone
 */
export function scenarioSync(playingId, before, after) {
  if (!playingId || !asList(before).some((s) => s.id === playingId)) return { action: 'none' };
  const now = asList(after).find((s) => s.id === playingId);
  return now ? { action: 'update', scenario: now } : { action: 'stop' };
}

// ---------------------------------------------------------------------------
//  Hit-testing for the drag that draws an edge
// ---------------------------------------------------------------------------

/**
 * The node under a screen point, or null: the last drawn one wins, as in input.js. A touch has a larger reach.
 * @param {{id: string, x: number, y: number, r: number}[]} nodes the nodes to test (the caller leaves out the hidden ones)
 * @param {{x: number, y: number, zoom: number}} camera
 */
export function nodeAtPoint(nodes, camera, sx, sy, isTouch = false) {
  const minReach = isTouch ? 32 : 12;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const dist = Math.hypot(camera.x + n.x * camera.zoom - sx, camera.y + n.y * camera.zoom - sy);
    if (dist <= Math.max(n.r * camera.zoom + (isTouch ? 16 : 6), minReach)) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
//  Words
// ---------------------------------------------------------------------------

const kindWord = (e) => (e.kind === 'flow' ? `flow, ${e.flow}` : e.kind || 'ownership');

/**
 * One line for the "Your edits" list.
 * @param {object} edit
 * @param {{ nameOf: (id: string) => string, scenarioTitle: (id: string) => string }} words
 */
export function describeEdit(edit, { nameOf, scenarioTitle }) {
  const ends = (e) => `${nameOf(e.from)} → ${nameOf(e.to)}`;
  const where = (id) => `“${scenarioTitle(id)}”`;
  switch (edit.op) {
    case 'add-node': return `Added the ${edit.type} “${edit.label}”${edit.parent ? ` under ${nameOf(edit.parent)}` : ''}`;
    case 'remove-node': return `Removed ${nameOf(edit.id)}`;
    case 'add-edge': return `Drew an edge ${ends(edit)} (${kindWord(edit)})`;
    case 'remove-edge': return `Removed the edge ${ends(edit)} (${kindWord(edit)})`;
    case 'add-step': return `Added a step to ${where(edit.scenario)}: ${edit.step?.text ?? ''}`;
    case 'edit-step': return `Reworded step ${edit.index + 1} of ${where(edit.scenario)}`;
    case 'move-step': return `Moved step ${edit.from + 1} of ${where(edit.scenario)} to ${edit.to + 1}`;
    case 'remove-step': return `Deleted step ${edit.index + 1} of ${where(edit.scenario)}`;
    default: return `An edit the editor does not know (${edit.op})`;
  }
}

/** "Your edits (3)" */
export const editsLabel = (n) => `Your edits (${n})`;
/** How a dropped edit is reported when a stored list is laid over a changed proposal */
export const droppedText = (n) => `${plural(n, 'edit')} you made no longer ${n === 1 ? 'fits' : 'fit'} this proposal and ${n === 1 ? 'was' : 'were'} dropped.`;


/**
 * @module explorer/check-model
 *
 * Checked scenarios, the pure half (spec 0029 sections 3, 5 and 9, PHY-10): the tool's side, no
 * DOM, no fetch, no storage. check.js runs it in the page; the tests run it in node.
 *
 * A **checker** (a plugin's adapter, e.g. plugins/house/browser.js) asks the production
 * rules whether a persona may do something. The tool knows no API; a checker has
 *
 *     name                                  what the chip and the bar may call it
 *     apps?    string[]                     the app node ids whose endpoint pages it can ask about
 *                                           (left out: any page with `methods`)
 *     max?     number                       the most checks one request may hold (default 100)
 *     check(items, { signal }) → Promise<CheckResult[]>
 *
 *     CheckItem    { id, actor, route, method } | { id, actor, table, op, row? }
 *                  actor { role, groups } or { account: false }
 *     CheckResult  { id, allowed, status, reason, rule?, checked }
 *
 * and throws an error with a `reason` when it cannot answer: `no-token`, `forbidden`, `unavailable`
 * (the live chip's words, live-model.js `failureWords`), or `bad-check` with the `checkId` it refused
 * (the batch is asked again without it). No checker means no checks: every step reads "Not checked".
 *
 * What lives here:
 *  - `stepChecks(step, map, checker)`: the checks a step asks, in the spec's order: its own `check`; else an
 *    endpoint node the checker understands → its route with GET (or its first method); else a `writes` edge
 *    into a table → `{ table, op: 'write' }`, a `reads` edge from one → `{ table, op: 'read' }`; else none.
 *  - `planChecks(scenario, map, checker, { as })`: every step's plan and ONE batch of items for the scenario.
 *  - `runChecks(checker, items, { signal })`: asks the batch (in requests of `max`), dropping a refused check.
 *  - `stepVerdict(plan, answer)`: a step's state: `none` (no actor: plays as before), `pending`,
 *    `allowed`, `refused` (the production reason and rule), `unchecked` (nothing to ask), `unavailable`
 *    (the checker did not answer), with `mismatch` when the step's `expect` disagrees (amber).
 *  - `verdictWords(verdict, label)`: the bar's and the sheet's words; `paintVerdict(scene, scn)`: the colours.
 */

import { personaNodeId } from '../core/schema.js';

/** The most checks one request holds, unless the checker says otherwise (the API's limit) */
export const MAX_BATCH = 100;

/**
 * The colours a checked step is drawn in, on its node or its edge. The red is brighter than a `writes`
 * edge's own (#f87171), so a refused write reads as refused, not as a write.
 */
export const VERDICT_COLOR = { allowed: '#4ade80', refused: '#ff2d55', mismatch: '#fbbf24' };
const VERDICT_GLOW = 18;
const VERDICT_EDGE_WIDTH = 4.5;

const asList = (check) => (check === undefined ? null : Array.isArray(check) ? check : [check]);
const isOwnership = (e) => !e.kind && !e.dashed;

/**
 * The persona node a scenario's actor names: `persona-<id>` (a what-if one too), or a node with that id.
 * @returns {object|null}
 */
export function personaFor(nodes, actor) {
  if (!actor) return null;
  const want = personaNodeId(actor);
  return nodes.find((n) => n.type === 'persona' && (n.id === want || n.id === actor)) || null;
}

/** A persona as the checker's actor: `{ account: false }`, or its role and groups (groups left out ask as none) */
export function actorOf(persona) {
  if (persona.account === false) return { account: false };
  return { role: persona.role, groups: Array.isArray(persona.groups) ? [...persona.groups] : [] };
}

/** A persona's label without the live count ("Adult", not "Adult · 2 people") */
export const personaLabel = (persona) => (persona ? persona.codeLabel || persona.label || persona.id : '');

/**
 * What the map says about a node, for deriving checks. Built once per map.
 * @param {object[]} nodes
 * @param {object[]} edges
 */
export function mapIndex(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const owner = new Map();
  for (const e of edges) if (isOwnership(e) && !owner.has(e.to)) owner.set(e.to, e.from);
  return { nodes, byId, owner };
}

/** The table a node stands for: its `table`, its label, or the id without `table-` when it is not on the map */
function tableOf(index, id) {
  const n = index.byId.get(id);
  if (n) return n.type === 'table' ? n.table || n.label || null : null;
  return typeof id === 'string' && id.startsWith('table-') ? id.slice('table-'.length) : null;
}

/** Whether the checker can ask about this node: a page with methods, under one of the checker's apps */
function isEndpoint(index, node, checker) {
  if (!node || node.type !== 'page' || !Array.isArray(node.methods) || node.methods.length === 0) return false;
  if (!checker || !Array.isArray(checker.apps)) return true;
  return checker.apps.includes(index.owner.get(node.id));
}

/**
 * The checks a step asks: its own, else derived from its node or edge, else none (an empty list).
 * @param {object} step
 * @param {ReturnType<typeof mapIndex>} index
 * @param {object|null} checker
 * @returns {object[]}
 */
export function stepChecks(step, index, checker) {
  const own = asList(step && step.check);
  if (own) return own.map((c) => ({ ...c }));
  if (!step) return [];
  if (step.node !== undefined) {
    const node = index.byId.get(step.node);
    if (!isEndpoint(index, node, checker)) return [];
    const methods = node.methods.map((m) => String(m).toUpperCase());
    return [{ route: node.label, method: methods.includes('GET') ? 'GET' : methods[0] }];
  }
  if (step.edge && step.edge.kind === 'writes') {
    const table = tableOf(index, step.edge.to);
    return table ? [{ table, op: 'write' }] : [];
  }
  if (step.edge && step.edge.kind === 'reads') {
    const table = tableOf(index, step.edge.from);
    return table ? [{ table, op: 'read' }] : [];
  }
  return [];
}

/**
 * @typedef {object} StepPlan
 * @property {number} index
 * @property {string|null} actor         the persona id the step acts as (the As menu's, the step's own, the scenario's), or null
 * @property {string} actorLabel         its label ("Child")
 * @property {'none'|'ask'|'unchecked'} kind  `none` no actor; `unchecked` nothing to ask (or an unknown persona); `ask` it has items
 * @property {string} [why]              for `unchecked`: why, in plain words
 * @property {object[]} checks           what it asks, each with its batch `id`
 * @property {'allowed'|'refused'|undefined} expect
 */

/**
 * Every step's plan and the scenario's one batch of checks.
 * @param {{ actor?: string, steps?: object[] }} scenario
 * @param {ReturnType<typeof mapIndex>} index
 * @param {object|null} checker
 * @param {{ as?: string|null }} [opts] `as`: a persona id that acts every step (the As menu)
 * @returns {{ steps: StepPlan[], items: object[], key: string }} `key` changes only when what is asked changes
 */
export function planChecks(scenario, index, checker, { as = null } = {}) {
  const steps = [];
  const items = [];
  (scenario && Array.isArray(scenario.steps) ? scenario.steps : []).forEach((step, i) => {
    const actor = as || step.actor || scenario.actor || null;
    const plan = { index: i, actor, actorLabel: '', kind: 'none', checks: [], expect: step.expect };
    steps.push(plan);
    if (!actor) return;
    const persona = personaFor(index.nodes, actor);
    plan.actorLabel = persona ? personaLabel(persona) : actor;
    if (!persona) { plan.kind = 'unchecked'; plan.why = `no persona "${actor}" on the map`; return; }
    const checks = stepChecks(step, index, checker);
    if (checks.length === 0) {
      plan.kind = 'unchecked';
      plan.why = Array.isArray(step.check) ? 'this step is not a permission question' : 'nothing in this step to ask';
      return;
    }
    plan.kind = 'ask';
    const who = actorOf(persona);
    plan.checks = checks.map((c, k) => ({ id: `s${i + 1}-${k + 1}`, ...c }));
    plan.checks.forEach((c) => items.push({ ...c, actor: who }));
  });
  return { steps, items, key: JSON.stringify(items) };
}

/** An error a checker throws when it cannot answer (the tests make them; a plugin makes its own) */
export function checkError(reason, extra = {}) {
  const err = new Error(extra.message || reason);
  err.reason = reason;
  Object.assign(err, extra);
  return err;
}

/**
 * Asks a batch: in requests of the checker's `max`, one after another. A check the checker refuses as
 * malformed (`bad-check` naming it) is left out and the rest asked again; it comes back in `bad`.
 * @returns {Promise<{ results: Map<string, object>, bad: Map<string, string> }>} throws when the checker cannot answer
 */
export async function runChecks(checker, items, { signal } = {}) {
  const results = new Map();
  const bad = new Map();
  if (!checker) throw checkError('no-checker', { message: 'no permission checker' });
  const max = checker.max > 0 ? checker.max : MAX_BATCH;
  let left = items.slice();
  while (left.length) {
    const chunk = left.slice(0, max);
    let answer;
    try {
      answer = await checker.check(chunk, { signal });
    } catch (err) {
      const id = err && err.reason === 'bad-check' ? err.checkId : null;
      if (id && chunk.some((c) => c.id === id)) {
        bad.set(id, err.message || 'the checker refused this check');
        left = left.filter((c) => c.id !== id);
        continue;
      }
      throw err;
    }
    for (const r of answer || []) if (r && typeof r.id === 'string') results.set(r.id, r);
    left = left.slice(chunk.length);
  }
  return { results, bad };
}

/**
 * @typedef {object} Verdict
 * @property {'none'|'pending'|'allowed'|'refused'|'unchecked'|'unavailable'} state
 * @property {boolean} mismatch   the step's `expect` disagrees with the answer (amber)
 * @property {string} [expect]
 * @property {string} [reason]    refused: the production message, word for word
 * @property {string} [rule]      refused: the constant or gate that refused
 * @property {string} [why]       unchecked or unavailable: why, in plain words
 * @property {string} actor       the persona's label ("Child"), '' for none
 * @property {object[]} checks    what was asked, each with its result when there is one
 */

/**
 * A step's verdict from its plan and the batch's answer.
 * @param {StepPlan|undefined} plan
 * @param {{ status: 'idle'|'pending'|'ok'|'failed', results?: Map<string, object>, bad?: Map<string, string>, error?: any }} answer
 * @returns {Verdict}
 */
export function stepVerdict(plan, answer) {
  const base = { mismatch: false, actor: plan ? plan.actorLabel : '', checks: [] };
  if (!plan || plan.kind === 'none') return { ...base, state: 'none' };
  if (plan.expect) base.expect = plan.expect;
  if (plan.kind === 'unchecked') return { ...base, state: 'unchecked', why: plan.why };
  if (!answer || answer.status === 'idle' || answer.status === 'pending') return { ...base, state: 'pending', checks: plan.checks };
  if (answer.status === 'failed') return { ...base, state: 'unavailable', why: unavailableWords(answer.error), checks: plan.checks };

  const checks = plan.checks.map((c) => ({ ...c, result: answer.results.get(c.id) || null }));
  const badOne = plan.checks.find((c) => answer.bad && answer.bad.has(c.id));
  if (badOne) return { ...base, state: 'unchecked', why: answer.bad.get(badOne.id), checks };
  if (checks.some((c) => !c.result)) return { ...base, state: 'unavailable', why: 'the checker gave no answer for this step', checks };
  const refused = checks.find((c) => c.result.allowed !== true);
  const state = refused ? 'refused' : 'allowed';
  const verdict = { ...base, state, checks };
  if (refused) {
    verdict.reason = refused.result.reason || `refused (${refused.result.status})`;
    if (refused.result.rule) verdict.rule = refused.result.rule;
  }
  verdict.mismatch = !!plan.expect && plan.expect !== state;
  return verdict;
}

/** Why a checker did not answer, in the live chip's words */
export function unavailableWords(error) {
  const reason = error && error.reason;
  if (reason === 'no-checker') return 'no permission checker';
  if (reason === 'no-token') return `no token${error.hint ? ` (${error.hint})` : ''}`;
  if (reason === 'forbidden') return "the token is not an admin's";
  return 'the checker is not answering';
}

/** One check in words: "PATCH /api/v1/rooms/[id]", "tasks · write · household" */
export function checkWords(c) {
  if (c.route !== undefined) return `${String(c.method || '').toUpperCase()} ${c.route}`;
  return [c.table, c.op, c.row].filter(Boolean).join(' · ');
}

/**
 * The bar's and the sheet's words for a verdict: a short `pill` for the head (shown on the phone's
 * peek too) and a full `line` with the reason, and the `tone` that colours both. null for `none`.
 * @param {Verdict} v
 * @returns {{ tone: string, pill: string, line: string, detail: string } | null}
 */
export function verdictWords(v) {
  if (!v || v.state === 'none') return null;
  const as = v.actor ? ` as ${v.actor}` : '';
  const asked = v.checks.map(checkWords).join(', ');
  const detail = asked ? `${asked}${as}` : v.actor ? `As ${v.actor}` : '';
  const refusal = () => `${v.reason}${v.rule ? ` (${v.rule})` : ''}`;
  if (v.state === 'pending') return { tone: 'pending', pill: 'Checking…', line: `Checking${as}…`, detail };
  if (v.state === 'unchecked') return { tone: 'unchecked', pill: 'Not checked', line: `Not checked: ${v.why}`, detail };
  if (v.state === 'unavailable') return { tone: 'unavailable', pill: 'Unavailable', line: `Not checked: live layer unavailable (${v.why})`, detail };
  if (v.mismatch) {
    const line = v.state === 'refused' ? `Expected allowed, but refused: ${refusal()}` : 'Expected refused, but allowed';
    return { tone: 'mismatch', pill: `Expected ${v.expect}`, line, detail };
  }
  if (v.state === 'refused') return { tone: 'refused', pill: '✕ Refused', line: `Refused: ${refusal()}`, detail };
  return { tone: 'allowed', pill: '✓ Allowed', line: 'Allowed', detail };
}

/** Whether a drawn edge is the one a step names: same ends and kind (and flow); no kind = an ownership or usage link (scene.js's rule) */
function isStepEdge(drawn, step) {
  if (drawn.from !== step.from || drawn.to !== step.to) return false;
  if (!step.kind) return drawn.kind === 'ownership' || drawn.kind === 'usage';
  return drawn.kind === step.kind && (!step.flow || drawn.key.split('|')[2] === step.flow);
}

/**
 * Colours the current step of a playing scenario by its verdict, in a built scene (after
 * `emphasiseScenario`): red refused, green allowed, amber when `expect` disagrees; a step that was not
 * checked keeps its colours. A refused edge's packet stops halfway: the write does not go through.
 * Changes only `color`, `glow`, `glowColor`, `width` and the packet: never `mark`.
 * @param {object} scene
 * @param {{ done?: boolean, current: { node?: string, edge?: object }, verdict?: Verdict }} scn the player's snapshot, with the verdict check.js put on it
 */
export function paintVerdict(scene, scn) {
  const v = scn && scn.verdict;
  if (!v || scn.done) return;
  const color = v.mismatch ? VERDICT_COLOR.mismatch : VERDICT_COLOR[v.state];
  if (!color) return;
  const { node, edge } = scn.current;
  if (node !== undefined) {
    const n = scene.nodes.find((x) => x.id === node);
    if (n) { n.color = color; n.glow = Math.max(n.glow || 0, VERDICT_GLOW); }
  } else if (edge) {
    scene.edges.forEach((e) => {
      if (!isStepEdge(e, edge)) return;
      e.color = color;
      e.glowColor = color;
      e.glow = Math.max(e.glow || 0, VERDICT_GLOW);
      e.width = Math.max(e.width || 0, VERDICT_EDGE_WIDTH);
      if (e.packet) e.packet = v.state === 'refused' && !v.mismatch ? { ...e.packet, color, glowColor: color, speed: 0, phase: 0.5 } : { ...e.packet, glowColor: color };
    });
  }
}

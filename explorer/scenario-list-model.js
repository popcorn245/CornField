/**
 * @module explorer/scenario-list-model
 *
 * The review column's two lists, the pure half (spec 0006, D1, D2, D4; no DOM, no storage of its own, tested in Node).
 *
 *  - `changeRows(nodes, edges, proposal)`: the list of changes, one row for each marked node and each edge the proposal
 *    names (the ownership edge a `parent` adds, and the edges of a removed node, are consequences: not rows).
 *  - `buildScenarioList({ scenarios, nodes, edges, proposal, verdicts, seen })`: the scenarios grouped by who acts in them.
 *
 * "Applies to" means "acts in" (D2): a scenario is under a persona when that persona is its `actor` or the `actor` of
 * any of its steps; a step's own `actor` wins over the scenario's. A scenario with no actor anywhere is under **Anyone**,
 * the last group. The groups follow the order of the personas on the map (the personas file's order). A scenario that
 * several personas act in is listed under each of them.
 *
 * Everything here is data from a project's files (persona labels, scenario titles, step text): it comes out as plain
 * strings, and the page puts them in with `textContent` or escapes them. Anything that becomes an element id or a
 * `data-*` value is made safe first (`safeKey`).
 *
 * The record of what was seen (a tick per scenario: "Read" once its steps were opened, "Played" once it played to the end)
 * is kept by the browser only (`seenKey`, `readSeen`, `writeSeen`): information, never a gate, never part of a review.
 */

import { edgeKey } from '../core/proposal.js';
import { MARK_WORDS, MARKS } from './proposal-model.js';

const asList = (v) => (Array.isArray(v) ? v : []);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A value as a token that is safe in an element id or a `data-*` attribute: letters, digits, dashes and underscores */
export const safeKey = (value) => String(value ?? '').replace(/[^A-Za-z0-9_-]+/g, '_') || '_';

const personaId = (node) => String(node.id).replace(/^persona-/, '');
/** A persona's label without the live count ("Adult", not "Adult · 2 people") */
const personaName = (node) => node.codeLabel || node.label || personaId(node);

/**
 * The rows of the changes list: every marked node, then the proposal's own marked edges, by mark.
 * @param {{ id: string, label?: string, type?: string, mark?: string }[]} nodes the map as the proposal draws it
 * @param {{ from: string, to: string, kind?: string, mark?: string }[]} edges
 * @param {{ edges?: { add?: any[], change?: any[], remove?: any[] } } | null} proposal
 * @returns {{ kind: 'node' | 'edge', key: string, mark: string, word: string, name: string, type: string }[]}
 */
export function changeRows(nodes, edges, proposal) {
  const said = new Set(['add', 'change', 'remove'].flatMap((op) => asList(proposal?.edges?.[op]).map(edgeKey)));
  const label = (id) => (nodes.find((n) => n.id === id) || { label: id }).label || id;
  const rows = [];
  for (const mark of [...MARKS, 'edit']) {
    for (const n of nodes.filter((x) => x.mark === mark)) {
      rows.push({ kind: 'node', key: n.id, mark, word: MARK_WORDS[mark], name: String(n.label ?? n.id), type: String(n.type ?? '') });
    }
    for (const e of edges.filter((x) => x.mark === mark && said.has(edgeKey(x)))) {
      rows.push({ kind: 'edge', key: edgeKey(e), mark, word: MARK_WORDS[mark], name: `${label(e.from)} → ${label(e.to)}`, type: String(e.kind || 'ownership') });
    }
  }
  return rows;
}

/**
 * The personas that act in a scenario (D2): its own `actor` and the `actor` of any of its steps.
 * @returns {string[]} the distinct persona ids, in the order they first act
 */
export function actorsOf(scenario) {
  const out = [];
  const add = (id) => { if (typeof id === 'string' && id && !out.includes(id)) out.push(id); };
  add(scenario?.actor);
  for (const step of asList(scenario?.steps)) add(step?.actor);
  return out;
}

/**
 * A step's verdict in words, for the list (D4): "Allowed", "Refused: <reason>", "Expected refused, was allowed",
 * "Not checked: <why>"; nothing for a step with no actor.
 * @param {{ state: string, mismatch?: boolean, expect?: string, reason?: string, why?: string } | null | undefined} v a check-model Verdict
 * @returns {{ words: string, state: 'success' | 'failure' | '', tone: string } | null}
 */
export function stepVerdictWords(v, words = {}) {
  const notChecked = words.notChecked || 'Not checked';
  if (!v || v.state === 'none') return null;
  if (v.state === 'pending') return { words: 'Checking…', state: '', tone: 'pending' };
  if (v.state === 'unchecked') return { words: `${notChecked}: ${v.why || 'nothing to ask'}`, state: '', tone: 'unchecked' };
  if (v.state === 'unavailable') return { words: `${notChecked}: the checker did not answer${v.why ? ` (${v.why})` : ''}`, state: '', tone: 'unavailable' };
  if (v.mismatch) {
    const words = v.state === 'refused' ? `Expected allowed, was refused${v.reason ? `: ${v.reason}` : ''}` : 'Expected refused, was allowed';
    return { words, state: 'failure', tone: 'mismatch' };
  }
  if (v.state === 'refused') return { words: `Refused: ${v.reason || 'no reason given'}`, state: v.expect === 'refused' ? 'success' : 'failure', tone: 'refused' };
  return { words: 'Allowed', state: 'success', tone: 'allowed' };
}

/**
 * The scenario's steps as rows: number, who acts, the node it touches, the node's mark, the text and the verdict.
 * @param {object} scenario
 * @param {{ nodes: any[], edges: any[], changeKeys: Set<string>, verdicts?: any[] | null, words?: { notChecked?: string }, label: (id: string) => string, personaLabel: (id: string) => string }} ctx
 */
function stepRows(scenario, ctx) {
  return asList(scenario.steps).map((step, i) => {
    const actor = (step && step.actor) || scenario.actor || null;
    let where = '';
    let mark = '';
    let touched = [];
    if (step && step.edge) {
      where = `${ctx.label(step.edge.from)} → ${ctx.label(step.edge.to)}`;
      touched = [`edge:${edgeKey(step.edge)}`, `node:${step.edge.from}`, `node:${step.edge.to}`];
      const e = ctx.edges.find((x) => edgeKey(x) === edgeKey(step.edge));
      if (e && e.mark && e.mark !== 'none' && ctx.changeKeys.has(`edge:${edgeKey(e)}`)) mark = e.mark;
    } else if (step && step.node !== undefined) {
      where = ctx.label(step.node);
      touched = [`node:${step.node}`];
      const n = ctx.nodes.find((x) => x.id === step.node);
      if (n && n.mark && n.mark !== 'none') mark = n.mark;
    }
    const v = ctx.verdicts ? stepVerdictWords(ctx.verdicts[i], ctx.words) : null;
    return {
      index: i,
      number: i + 1,
      actor,
      actorLabel: actor ? ctx.personaLabel(actor) : '',
      where,
      mark,
      markWord: mark ? MARK_WORDS[mark] || '' : '',
      text: String((step && step.text) ?? ''),
      verdict: actor ? v : null,
      touched,
    };
  });
}

/** The sentence a screen reader gets for a step: "Step 2 of 3, as Adult: checkout page, Added. You pay. Allowed." */
export function stepSentence(step, total) {
  const where = [step.where, step.markWord].filter(Boolean).join(', ');
  const head = `Step ${step.number} of ${total}${step.actorLabel ? `, as ${step.actorLabel}` : ''}${where ? `: ${where}` : ''}.`;
  return [head, step.text, step.verdict ? `${step.verdict.words}${/[.!?…]$/.test(step.verdict.words) ? '' : '.'}` : ''].filter(Boolean).join(' ');
}

/**
 * The sentence the player says for the step it is on (D5), the same words the list uses: "Step 2 of 3, as Adult: checkout page, Added. You pay. Allowed."
 * @param {{ snap: { index: number, total: number, current: { node?: string, edge?: { from: string, to: string, kind?: string, flow?: string }, text?: string, actor?: string }, verdict?: any }, nodes: any[], edges: any[], words?: { notChecked?: string } }} input
 */
export function currentStepSentence({ snap, nodes, edges, words = {} }) {
  const cur = snap.current || {};
  const label = (id) => String((nodes.find((n) => n.id === id) || { label: id }).label ?? id);
  const persona = cur.actor ? nodes.find((n) => n.type === 'persona' && (n.id === `persona-${cur.actor}` || n.id === cur.actor)) : null;
  let where = '';
  let mark = '';
  if (cur.edge) {
    where = `${label(cur.edge.from)} → ${label(cur.edge.to)}`;
    const e = edges.find((x) => edgeKey(x) === edgeKey(cur.edge));
    if (e && e.mark && e.mark !== 'none') mark = e.mark;
  } else if (cur.node !== undefined) {
    where = label(cur.node);
    const n = nodes.find((x) => x.id === cur.node);
    if (n && n.mark && n.mark !== 'none') mark = n.mark;
  }
  const verdict = cur.actor ? stepVerdictWords(snap.verdict, words) : null;
  const step = {
    number: snap.index + 1, actorLabel: cur.actor ? (persona ? personaName(persona) : String(cur.actor)) : '', where,
    markWord: mark ? MARK_WORDS[mark] || '' : '', text: String(cur.text ?? ''), verdict,
  };
  return stepSentence(step, snap.total);
}

/** "Allowed", "Refused" counts for a row once its checks are in: "3 allowed · 1 refused" ('' before) */
function verdictSummary(rows) {
  const count = (state) => rows.filter((r) => r.verdict && r.verdict.tone === state).length;
  const parts = [[count('allowed'), 'allowed'], [count('refused'), 'refused'], [count('mismatch'), 'not as expected']].filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
  return parts.join(' · ');
}

/**
 * The scenarios grouped by persona.
 * @param {object} input
 * @param {object[]} input.scenarios the open proposal's scenarios (with what-if edits in)
 * @param {any[]} input.nodes the map as drawn (personas are nodes of type `persona`; marks on the changed ones)
 * @param {any[]} input.edges
 * @param {object | null} [input.proposal] for the list of changes it counts "walks 3 of 9 changes" against
 * @param {Map<string, any[]> | null} [input.verdicts] scenario id -> its steps' check-model verdicts, for the scenarios that were checked
 * @param {{ played?: string[], read?: string[] } | null} [input.seen] what this browser has seen
 * @param {{ notChecked?: string }} [input.words] the project's own words (`strings`)
 * @returns {{
 *   total: number,
 *   personaCount: number,
 *   groups: { key: string, persona: string | null, label: string, anyone: boolean, heading: string, scenarios: any[] }[],
 *   notInAny: string[],
 *   coverage: string,
 *   playedLine: string,
 * }}
 */
export function buildScenarioList({ scenarios, nodes, edges, proposal = null, verdicts = null, seen = null, words = {} }) {
  const list = asList(scenarios);
  const personas = nodes.filter((n) => n.type === 'persona');
  const byPersona = new Map(personas.map((n) => [personaId(n), n]));
  const label = (id) => String((nodes.find((n) => n.id === id) || { label: id }).label ?? id);
  const personaLabel = (id) => (byPersona.has(id) ? personaName(byPersona.get(id)) : String(id));
  const rows = changeRows(nodes, edges, proposal);
  const changeKeys = new Set(rows.map((r) => `${r.kind}:${r.key}`));
  const played = new Set(asList(seen?.played));
  const read = new Set(asList(seen?.read));

  const built = list.map((s, index) => {
    const checked = verdicts && verdicts.get(s.id);
    const steps = stepRows(s, { nodes, edges, changeKeys, verdicts: checked || null, words, label, personaLabel });
    const walked = new Set(steps.flatMap((st) => st.touched).filter((k) => changeKeys.has(k)));
    const count = steps.length;
    const parts = [plural(count, 'step')];
    if (changeKeys.size > 0) parts.push(`walks ${walked.size} of ${plural(changeKeys.size, 'change')}`);
    const done = verdictSummary(steps);
    return {
      index,
      id: String(s.id ?? ''),
      key: `${index}-${safeKey(s.id)}`,
      title: String(s.title ?? s.id ?? ''),
      actors: actorsOf(s),
      steps,
      stepCount: count,
      summary: parts.join(' · '),
      verdictSummary: done,
      seen: played.has(String(s.id)) ? 'played' : read.has(String(s.id)) ? 'read' : '',
    };
  });

  // Personas in the personas file's order, then an actor the map has no persona for (a proposal that is wrong about it), then Anyone
  const order = [...byPersona.keys()];
  for (const sc of built) for (const a of sc.actors) if (!order.includes(a)) order.push(a);
  const groups = [];
  for (const id of order) {
    const mine = built.filter((sc) => sc.actors.includes(id));
    if (!mine.length) continue;
    const name = personaLabel(id);
    groups.push({ key: safeKey(id), persona: id, label: name, anyone: false, heading: `${name} · ${plural(mine.length, 'scenario')}`, scenarios: mine });
  }
  const anyone = built.filter((sc) => sc.actors.length === 0);
  if (anyone.length) groups.push({ key: 'anyone', persona: null, label: 'Anyone', anyone: true, heading: `Anyone · ${plural(anyone.length, 'scenario')}`, scenarios: anyone });

  const acting = new Set(built.flatMap((sc) => sc.actors));
  const notInAny = built.length ? personas.filter((n) => !acting.has(personaId(n))).map(personaName) : [];
  const playedN = built.filter((sc) => sc.seen === 'played').length;
  return {
    total: built.length,
    personaCount: groups.filter((g) => !g.anyone).length,
    groups,
    notInAny,
    coverage: notInAny.length ? `Not in any scenario: ${notInAny.join(', ')}` : '',
    playedLine: built.length && playedN ? `${playedN} of ${built.length} ${built.length === 1 ? 'scenario' : 'scenarios'} played` : '',
  };
}

/** The proposal's one-line facts for the phone's peek and the opening announcement: "6 changes · 3 scenarios for 2 personas" */
export function reviewCounts(changeCount, list) {
  const parts = [plural(changeCount, 'change')];
  if (list.total > 0) parts.push(`${plural(list.total, 'scenario')}${list.personaCount > 0 ? ` for ${plural(list.personaCount, 'persona')}` : ''}`);
  return parts.join(' · ');
}

/** What the page says when a proposal opens (D5): "Opened Checkout: 6 changes, 3 scenarios for 2 personas." */
export function reviewOpenedWords(title, changeCount, list) {
  return `Opened ${title}: ${reviewCounts(changeCount, list).replace(' · ', ', ')}.`;
}

// ---------------------------------------------------------------------------
//  What was seen: a record in the browser, never a gate
// ---------------------------------------------------------------------------

/** The browser key one proposal's record is kept under: its source, its name and the PR head it was read at ('' when not known) */
export const seenKey = (source, slug, head = '') => `cornfield.seen.${source || 'checkout'}/${slug || ''}@${head || ''}`;

/**
 * What this browser saw of a proposal. A blocked, missing or garbled store reads as nothing seen.
 * @param {{ getItem(key: string): string | null } | null} storage
 * @returns {{ played: string[], read: string[] }}
 */
export function readSeen(storage, key) {
  const none = { played: [], read: [] };
  try {
    const raw = storage && storage.getItem(key);
    if (!raw) return none;
    const v = JSON.parse(raw);
    const ids = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string').slice(0, 200) : []);
    return { played: ids(v && v.played), read: ids(v && v.read) };
  } catch { return none; }
}

/**
 * Adds a scenario to the record and keeps it. Played includes read.
 * @param {{ getItem(key: string): string | null, setItem(key: string, value: string): void } | null} storage
 * @param {string} key
 * @param {string} scenarioId
 * @param {'read' | 'played'} how
 * @returns {{ played: string[], read: string[] }} the record now, kept or not
 */
export function writeSeen(storage, key, scenarioId, how) {
  const now = readSeen(storage, key);
  const id = String(scenarioId);
  if (how === 'played') { if (!now.played.includes(id)) now.played.push(id); now.read = now.read.filter((x) => x !== id); } else if (!now.read.includes(id) && !now.played.includes(id)) now.read.push(id);
  try { if (storage) storage.setItem(key, JSON.stringify(now)); } catch { /* storage blocked or full: it counts for this visit only */ }
  return now;
}

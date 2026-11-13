/**
 * @module explorer/work-model
 *
 * The pure half of the Work view (spec 0012 D1 to D5, D8): the map of work, from the server's answer to `GET /api/forge/work-graph`
 * (server/work-graph.js: `{ ok, nodes, edges, problems }`) to nodes the scene draws, where they sit, what a layer hides, what the node panel
 * says of one, what search finds and what an address asks for. No DOM, no state, no fetch: work-view.js (the page's half) holds those.
 *
 *   - `workScene(graph, mapNodes)`   the nodes and edges of the Work view: the work, the code it touches (copies of the map's nodes, and the planned
 *                                    ones a proposal adds), and the lines between them with their words
 *   - `layoutWork(nodes, edges, { phone })`  where each node sits, and the lanes behind them; writes `x`, `y` and `r` on the nodes it is given
 *   - `applyFilters(nodes, edges, { layers, waiting })`  sets `hidden` (a layer is off) and `dim` ("Waiting on you" is on) on the nodes
 *   - `layerRowsOf(nodes)`           the Layers menu's rows in the Work view, each with its count in words
 *   - `panelOf(node, nodes, edges)`  what the node panel says of a work node (kind, pills, the connected list, the words saying what comes next)
 *   - `workAddress(search)`          what `?view=work`, `?pr=`, `?issue=`, `?run=`, `?thread=` and `?spec=` ask for
 */

import { NODE_THEMES, WORK_KINDS, WORK_THEMES, workType } from '../core/schema.js';
import { relativeTime } from './review-model.js';
import { SPEC_STATE_WORDS } from './waiting-model.js';

/** The words of a kind of work, singular and as a layer */
export const KIND_WORDS = Object.freeze({ thread: 'Thread', issue: 'Issue', proposal: 'Proposal', run: 'Agent run', pull: 'Pull request', deploy: 'Deploy' });
export const LAYER_WORDS = Object.freeze({ thread: 'Threads', issue: 'Issues', proposal: 'Proposals', run: 'Agent runs', pull: 'Pull requests', deploy: 'Deploys' });
/** The key of the one layer that holds the code the work touches, and a kind's key (the node type it has in the Work view) */
export const CODE_LAYER = 'work-code';
export const layerKey = workType;
export const LAYER_KEYS = Object.freeze([...WORK_KINDS.map(workType), CODE_LAYER]);
export const CODE_LAYER_WORDS = 'Code they touch';

/** The lanes, in order: the stage each holds (server/work-graph.js STAGES) and its title */
export const LANES = Object.freeze([
  { key: 'talk', title: 'Talk' },
  { key: 'decide', title: 'Decide' },
  { key: 'build', title: 'Build' },
  { key: 'ship', title: 'Ship' },
]);
export const CODE_LANE_TITLE = 'Code it touches';

/** The words beside a line: the rel as the line reads from its start, and as the node at its end reads it (a connection listed in the node panel) */
export const REL_WORDS = Object.freeze({
  became: ['became', 'came from'],
  discusses: ['discusses', 'discussed in'],
  'agent-on': ['agent on it', 'works on'],
  opened: ['opened', 'opened by'],
  closes: ['closes', 'closed by'],
  implements: ['implements', 'built by'],
  shipped: ['shipped in', 'shipped'],
  changes: ['changes', 'changed by'],
  adds: ['adds', 'added by'],
  mentions: ['mentions', 'mentioned in'],
  restarts: ['restarts', 'restarted by'],
});
/** The word on the map for a line (once, from its start): the same as `REL_WORDS[rel][0]` */
export const relWord = (rel) => (Object.hasOwn(REL_WORDS, rel) ? REL_WORDS[rel][0] : String(rel));

/** The most characters of a title on the map (the whole title is the node panel's) */
export const LABEL_CHARS = 34;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const text = (v) => (typeof v === 'string' ? v : '');
const isWork = (kind) => typeof kind === 'string' && Object.hasOwn(WORK_THEMES, kind);

/** The number of a spec: the leading digits of its slug ("0100-flow" is "0100"), else the slug */
const specNumber = (slug) => { const m = /^(\d{2,6})(?:-|$)/.exec(slug); return m ? m[1] : slug; };

/** What a piece of work is called on the map, short: "PR #27", "Issue #14", "Thread #31", "Spec 0100", "Run abc123", "Deploy" */
export function tagOf(item) {
  switch (item.kind) {
    case 'pull': return `PR #${item.number}`;
    case 'issue': return `Issue #${item.number}`;
    case 'thread': return `Thread #${item.number}`;
    case 'proposal': return `Spec ${specNumber(text(item.slug))}`;
    case 'run': return `Run ${text(item.runId).slice(-6)}`;
    default: return 'Deploy';
  }
}

/** What a search reads of a piece of work besides its label: `#21`, `PR 21`, `pull request 21`, the slug, the run id, the title */
export function termsOf(item) {
  const terms = [tagOf(item), text(item.title), KIND_WORDS[item.kind]];
  const n = item.number;
  if (Number.isInteger(n)) terms.push(`#${n}`, String(n), `pr ${n}`, `pull ${n}`, `pull request ${n}`, `issue ${n}`, `thread ${n}`);
  if (item.slug) terms.push(item.slug, specNumber(item.slug), `spec ${specNumber(item.slug)}`);
  if (item.runId) terms.push(item.runId);
  if (item.name) terms.push(item.name);
  return terms.filter((t) => typeof t === 'string' && t !== '');
}

/** A node the graph names that the map does not hold: a planned one, by its type (an unknown type reads as a page) */
const plannedType = (type) => (typeof type === 'string' && Object.hasOwn(NODE_THEMES, type) ? type : 'page');

/**
 * The scene of the Work view.
 * @param {{ nodes?: object[], edges?: { from: string, to: string, rel: string }[] } | null} graph the server's answer
 * @param {{ id: string, label?: string, type?: string }[]} mapNodes the map's nodes (the code a piece of work touches is found among them by id)
 * @returns {{ nodes: object[], edges: object[], counts: { work: number, code: number, waiting: number } }}
 */
export function workScene(graph, mapNodes) {
  const items = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph && graph.edges) ? graph.edges : [];
  const onMap = new Map((mapNodes || []).map((n) => [n.id, n]));
  const work = new Map();
  const planned = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== 'string') continue;
    if (item.kind === 'code') { if (item.planned === true) planned.set(item.id, item); continue; }
    if (isWork(item.kind)) work.set(item.id, item);
  }
  // The edges that join two things on this map: work to work, or work to code the map holds or a proposal plans
  const edges = [];
  const seen = new Set();
  for (const e of links) {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string' || !Object.hasOwn(REL_WORDS, e.rel)) continue;
    const from = work.has(e.from) ? 'work' : null;
    const to = work.has(e.to) ? 'work' : onMap.has(e.to) || planned.has(e.to) ? 'code' : null;
    if (!from || !to) continue;
    const key = `${e.from}->${e.to}|${e.rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: e.from, to: e.to, kind: e.rel, tone: to === 'work' ? 'work' : 'code', word: relWord(e.rel) });
  }
  // The code that work touches, and by how many pieces of it
  const touched = new Map();
  for (const e of edges) if (e.tone === 'code') touched.set(e.to, (touched.get(e.to) || new Set()).add(e.from));

  const nodes = [];
  for (const item of work.values()) {
    const theme = WORK_THEMES[item.kind];
    const title = text(item.title) || tagOf(item);
    nodes.push({
      id: item.id, type: workType(item.kind), work: item.kind, label: item.kind === 'deploy' ? `Deploy · ${clip(title, LABEL_CHARS)}` : `${tagOf(item)} · ${clip(title, LABEL_CHARS)}`,
      title, item, r: theme.r, color: theme.color, letters: theme.letters, terms: termsOf(item), groupName: LAYER_WORDS[item.kind],
      waiting: item.waiting === true, updated: text(item.updated), stage: text(item.stage), x: 0, y: 0,
    });
  }
  let code = 0;
  for (const [id, by] of touched) {
    const base = onMap.get(id);
    const plan = planned.get(id);
    if (!base && !plan) continue;
    code++;
    nodes.push(base
      ? { ...base, x: 0, y: 0, r: CODE_R, touches: by.size, hidden: false, dim: false }
      : { id, type: plannedType(plan.type), label: text(plan.label) || id, planned: true, r: CODE_R, touches: by.size, x: 0, y: 0, groupName: CODE_LAYER_WORDS });
  }
  const waiting = nodes.filter((n) => n.waiting).length;
  return { nodes, edges, counts: { work: work.size, code, waiting } };
}
/** The radius of a node of code in the Work view: small beside the work it is touched by */
export const CODE_R = 9;

// ---------------------------------------------------------------------------
//  Where it sits
// ---------------------------------------------------------------------------

/** Waiting first, then the newest, then by id: the order within a lane (spec 0012 D3) */
export const byLane = (a, b) => (a.waiting === b.waiting ? 0 : a.waiting ? -1 : 1) || (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Most touched first, then by name: the order of the code */
export const byTouch = (a, b) => (b.touches || 0) - (a.touches || 0) || String(a.label).localeCompare(String(b.label)) || (a.id < b.id ? -1 : 1);

const DESK = { colGap: 230, rowGap: 78, codeRow: 34, codeRows: 18, codeColGap: 250, top: 0 };
const PHONE = { perRow: 3, colGap: 110, rowGap: 74, bandGap: 74, codeRow: 34, codeRows: 18, codeColGap: 150 };
const LANE_FILL = 'rgba(66, 153, 225, 0.05)';
const LANE_STROKE = 'rgba(66, 153, 225, 0.18)';

const lane = (title, note, x, y, w, h) => ({
  x, y, w, h, radius: 14, fill: LANE_FILL, stroke: LANE_STROKE, strokeWidth: 1,
  title: { text: title, x: x + w / 2, y: y + 22, size: 15, bold: true, color: '#e2e8f0' },
  note: { text: note, x: x + w / 2, y: y + 40, size: 11, bold: false, color: '#94a3b8' },
  arrow: null,
});
const noteOf = (n) => `${n} ${n === 1 ? 'item' : 'items'}`;

/**
 * Where the nodes sit: four lanes of work, then the code it touches (spec 0012 D3). On a desktop the lanes run left to right, on a phone top to bottom
 * (Build and Ship share one band), with the code in a column beside them. Writes `x`, `y` and `r` on the nodes and returns the lanes behind them, as the
 * scene draws a lane (`SceneLane`: scene.js).
 * @param {object[]} nodes the nodes of `workScene`
 * @param {{ phone?: boolean }} [opts]
 * @returns {{ lanes: object[], bounds: { x: number, y: number, w: number, h: number } }}
 */
export function layoutWork(nodes, { phone = false } = {}) {
  const by = (key) => nodes.filter((n) => n.work && n.stage === key).sort(byLane);
  const stages = LANES.map((l) => ({ ...l, nodes: by(l.key) }));
  // A kind of work the server gave no stage still has a lane: the kind's own
  const known = new Set(stages.flatMap((s) => s.nodes.map((n) => n.id)));
  const lost = nodes.filter((n) => n.work && !known.has(n.id));
  for (const n of lost) { const home = { thread: 'talk', issue: 'talk', proposal: 'decide', run: 'build', pull: 'build', deploy: 'ship' }[n.work]; stages.find((s) => s.key === home).nodes.push(n); }
  stages.forEach((s) => s.nodes.sort(byLane));
  const code = nodes.filter((n) => !n.work).sort(byTouch);
  return phone ? layoutPhone(stages, code) : layoutDesk(stages, code);
}

function layoutDesk(stages, code) {
  const { colGap, rowGap, codeRow, codeRows, codeColGap } = DESK;
  const rows = Math.max(1, ...stages.map((s) => s.nodes.length));
  const codeCols = Math.max(1, Math.ceil(code.length / codeRows));
  const heightWork = (rows - 1) * rowGap;
  const heightCode = (Math.min(code.length, codeRows) - 1) * codeRow;
  const innerH = Math.max(heightWork, heightCode, 0);
  const top = -64; // the band starts above the first node: its title and note
  const bandH = innerH + 64 + 56;
  const lanes = [];
  stages.forEach((s, i) => {
    const cx = i * colGap;
    s.nodes.forEach((n, j) => { n.x = cx; n.y = j * rowGap; });
    lanes.push(lane(s.title, noteOf(s.nodes.length), cx - colGap / 2 + 14, top, colGap - 28, bandH));
  });
  const x0 = stages.length * colGap - colGap / 2 + 14;
  const codeW = codeCols * codeColGap - 28 + 28;
  code.forEach((n, k) => { const col = Math.floor(k / codeRows); n.x = x0 + 24 + col * codeColGap; n.y = (k % codeRows) * codeRow; });
  if (code.length) lanes.push(lane(CODE_LANE_TITLE, noteOf(code.length), x0, top, codeW, bandH));
  const right = code.length ? x0 + codeW : x0 - 14;
  return { lanes, bounds: { x: -colGap / 2, y: top, w: right + colGap / 2, h: bandH } };
}

function layoutPhone(stages, code) {
  const { perRow, colGap, rowGap, bandGap, codeRow, codeRows, codeColGap } = PHONE;
  // Three bands: Talk, Decide, and Build with Ship after it in one
  const bands = [stages[0], stages[1], { key: 'build-ship', title: 'Build · Ship', nodes: [...stages[2].nodes, ...stages[3].nodes] }];
  const width = perRow * colGap;
  const lanes = [];
  let y = 0;
  for (const b of bands) {
    const rows = Math.max(1, Math.ceil(b.nodes.length / perRow));
    b.nodes.forEach((n, k) => { n.x = (k % perRow) * colGap + colGap / 2; n.y = y + 56 + Math.floor(k / perRow) * rowGap; });
    const h = 56 + (rows - 1) * rowGap + 52;
    lanes.push(lane(b.title, noteOf(b.nodes.length), 0, y, width, h));
    y += h + bandGap - 56 + 6;
  }
  const bottom = y;
  const codeCols = Math.max(1, Math.ceil(code.length / codeRows));
  const x0 = width + 16;
  code.forEach((n, k) => { n.x = x0 + 14 + Math.floor(k / codeRows) * codeColGap; n.y = 56 + (k % codeRows) * codeRow; });
  const codeW = codeCols * codeColGap;
  if (code.length) lanes.push(lane(CODE_LANE_TITLE, noteOf(code.length), x0, 0, codeW, Math.max(56 + (Math.min(code.length, codeRows) - 1) * codeRow + 52, 120)));
  return { lanes, bounds: { x: 0, y: 0, w: x0 + (code.length ? codeW : 0), h: Math.max(bottom, 56 + Math.min(code.length, codeRows) * codeRow) } };
}

// ---------------------------------------------------------------------------
//  Layers and "Waiting on you"
// ---------------------------------------------------------------------------

/** The layers as the Work view starts them: every one on */
export const startLayers = () => Object.fromEntries(LAYER_KEYS.map((k) => [k, true]));

/**
 * Sets `hidden` and `dim` on the nodes. A piece of work is hidden when its layer is off; code when its layer is off or every piece of work that touches it is
 * hidden (only code that work touches is drawn). With "Waiting on you" on, everything that does not wait is dimmed.
 */
export function applyFilters(nodes, edges, { layers = startLayers(), waiting = false } = {}) {
  const on = (key) => layers[key] !== false;
  const shown = new Set();
  for (const n of nodes) { n.hidden = n.work ? !on(workType(n.work)) : false; if (n.work && !n.hidden) shown.add(n.id); }
  const reached = new Set();
  for (const e of edges) if (e.tone === 'code' && shown.has(e.from)) reached.add(e.to);
  for (const n of nodes) {
    if (!n.work) n.hidden = !on(CODE_LAYER) || !reached.has(n.id);
    n.dim = waiting && !n.waiting;
  }
  return nodes;
}

/** The Layers menu's rows in the Work view: `{ key, label, color, desc, countText }`, the six kinds and the code they touch */
export function layerRowsOf(nodes) {
  const of = (kind) => nodes.filter((n) => n.work === kind);
  const word = (n, w) => `${n} ${w}`;
  const rows = WORK_KINDS.map((kind) => {
    const list = of(kind);
    const open = list.filter((n) => n.item.open === true).length;
    const waiting = list.filter((n) => n.waiting).length;
    const countText = kind === 'proposal' ? (waiting ? word(waiting, 'to decide') : String(list.length))
      : kind === 'run' ? (waiting ? word(waiting, 'waiting') : String(list.length))
      : kind === 'pull' || kind === 'issue' ? word(open, 'open')
      : String(list.length);
    return { key: workType(kind), label: LAYER_WORDS[kind], color: WORK_THEMES[kind].color, desc: `${KIND_WORDS[kind]} nodes: ${list.length}`, countText, count: list.length };
  });
  const codeCount = nodes.filter((n) => !n.work).length;
  rows.push({ key: CODE_LAYER, label: CODE_LAYER_WORDS, color: NODE_THEMES.page.color, desc: 'The code the work touches', countText: String(codeCount), count: codeCount });
  return rows;
}

/** How many wait on the maintainer in this answer (spec 0010 D1's number: the server worked it out) */
export const waitingCountOf = (nodes) => nodes.filter((n) => n.waiting).length;

// ---------------------------------------------------------------------------
//  The node panel
// ---------------------------------------------------------------------------

const PILL_OF = { open: 'open', closed: 'closed', merged: 'merged', success: 'success', failure: 'failure', running: 'running', queued: 'queued', waiting: 'waiting', done: 'done', failed: 'failed', stopped: 'stopped' };

/** A word for a piece of work's own state: "Open", "Merged", "To decide", "Failed" */
export function stateWordsOf(item) {
  if (item.kind === 'proposal') return SPEC_STATE_WORDS[item.state] || text(item.state) || 'Proposal';
  if (item.kind === 'pull') return item.state === 'open' ? (item.draft ? 'Draft' : 'Open') : item.state === 'merged' ? 'Merged' : 'Closed';
  if (item.kind === 'deploy') return ({ success: 'Succeeded', failure: 'Failed', running: 'Running', queued: 'Waiting', cancelled: 'Cancelled', skipped: 'Skipped', neutral: 'Finished' })[item.state] || text(item.state);
  if (item.kind === 'run') return text(item.state).replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return item.open ? 'Open' : 'Closed';
}

/** The public `data-corn-state` word of a piece of work's state (corn-state.js), or '' */
export function pillStateOf(item) {
  if (item.waiting) return 'waiting';
  if (item.kind === 'pull') return item.draft ? 'draft' : PILL_OF[item.state] || '';
  if (item.kind === 'proposal') return ({ 'to-decide': 'waiting', changed: 'waiting', approved: 'success', 'sent-back': 'sent-back', 'draft-pr': 'draft' })[item.state] || '';
  if (item.kind === 'run') return ({ requested: 'requested', claimed: 'claimed', working: 'working', waiting: 'waiting', quiet: 'waiting', done: 'done', failed: 'failed', stopped: 'stopped' })[item.state] || '';
  return PILL_OF[item.state] || (item.open ? 'open' : 'closed');
}

/** What the page says of what comes next, under the connections: what the action in the Work panel will do (the actions move here in step 3) */
export function saysOf(item) {
  switch (item.kind) {
    case 'proposal': return item.waiting ? 'This waits on you. Open it in the Work panel to open the review, approve or send it back.' : 'Open it in the Work panel for the review.';
    case 'pull': return item.state === 'open' ? 'Open it in the Work panel to merge when the checks pass, or run the failed ones again.' : 'Nothing waits on you.';
    case 'issue': return item.open ? 'Open it in the Work panel to start an agent on it.' : 'Nothing waits on you.';
    case 'run': return item.waiting ? 'This waits on your answer. Open it in the Work panel to answer, continue or stop it.' : item.open ? 'Open it in the Work panel to follow it or stop it.' : 'Nothing waits on you.';
    case 'thread': return 'Open it in the Work panel to read it and reply.';
    default: return 'Open it in the Work panel for its logs, or to run it again.';
  }
}

/**
 * What the node panel says of a piece of work (the page draws it: work-view.js).
 * @param {object} node a node of the Work view (a piece of work)
 * @param {object[]} nodes every node of the view
 * @param {object[]} edges every edge of the view
 * @param {{ now?: number }} [opts]
 */
export function panelOf(node, nodes, edges, { now = Date.now() } = {}) {
  const item = node.item;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pills = [{ text: stateWordsOf(item), state: pillStateOf(item) }];
  if (item.waiting) pills.push({ text: 'Waiting on you', state: 'waiting' });
  if (item.kind === 'proposal' && Number.isInteger(item.number)) pills.push({ text: `PR #${item.number}`, state: '' });
  if (item.kind === 'run' && item.runKind) pills.push({ text: text(item.runKind), state: '' });
  const meta = [item.author ? text(item.author) : '', relativeTime(item.updated, now)].filter(Boolean).join(' · ');
  const links = [];
  for (const e of edges) {
    const out = e.from === node.id;
    const other = byId.get(out ? e.to : e.from);
    if (!other || (!out && e.to !== node.id)) continue;
    links.push({ rel: REL_WORDS[e.kind][out ? 0 : 1], id: other.id, label: other.label, work: other.work || '', code: !other.work, planned: other.planned === true });
  }
  // Work first (in the order of the lanes), then code; the same words together
  const rank = (l) => (l.work ? LANES.findIndex((x) => x.key === (byId.get(l.id).stage || '')) : 9);
  links.sort((a, b) => rank(a) - rank(b) || a.rel.localeCompare(b.rel) || a.label.localeCompare(b.label));
  return { kind: KIND_WORDS[item.kind], tag: tagOf(item), title: node.title, color: WORK_THEMES[item.kind].color, pills, meta, links, says: saysOf(item), url: text(item.url) };
}

/** The work that touches a node of code, as the node panel lists it: `{ rel, id, label, work }` */
export function touchedBy(node, nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = [];
  for (const e of edges) {
    if (e.to !== node.id) continue;
    const from = byId.get(e.from);
    if (from && from.work) out.push({ rel: REL_WORDS[e.kind][1], id: from.id, label: from.label, work: from.work, waiting: from.waiting });
  }
  return out.sort((a, b) => Number(b.waiting) - Number(a.waiting) || a.label.localeCompare(b.label));
}

/** The checks line of a pull request, from `GET /api/forge/pulls/<n>`'s `checks` ("1 failed, 1 still running", "All 3 passed", "No checks") */
export { checksWords } from './forge-panel-model.js';

// ---------------------------------------------------------------------------
//  Addresses and search
// ---------------------------------------------------------------------------

const NUMBER = /^[1-9][0-9]{0,8}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * What an address asks of the Work view (spec 0012 D8): `{ view: true }` for `?view=work`, and which node to select for `?pr=`, `?issue=`, `?thread=`, `?run=`
 * and `?spec=` (a number or a slug). One link asks for one node: the first of them in that order. A value that cannot be a name is `{ bad }`. Null when it asks nothing.
 * @param {string} search
 * @returns {{ view: boolean, kind?: string, key?: string, bad?: string } | null}
 */
export function workAddress(search) {
  const params = new URLSearchParams(search || '');
  const asks = [['pr', 'pull'], ['issue', 'issue'], ['thread', 'thread'], ['run', 'run'], ['spec', 'proposal']];
  for (const [param, kind] of asks) {
    if (!params.has(param)) continue;
    const value = params.get(param) || '';
    const good = kind === 'run' ? /^run-[0-9A-Za-z]{26}$/.test(value) : kind === 'proposal' ? SLUG.test(value) : NUMBER.test(value);
    if (!good) return { view: true, kind, bad: `${value ? `"${value.slice(0, 40)}"` : 'That'} is not ${kind === 'pull' ? 'a pull request number' : kind === 'issue' ? 'an issue number' : kind === 'thread' ? 'a thread number' : kind === 'run' ? 'a run id' : 'a spec number or name'}.` };
    return { view: true, kind, key: value };
  }
  return params.get('view') === 'work' ? { view: true } : null;
}

/** The id of the node an address names, among the nodes of the view, or null (a spec by its number, `0100`, or by its whole slug) */
export function nodeForAddress(ask, nodes) {
  if (!ask || !ask.kind) return null;
  const mine = nodes.filter((n) => n.work === ask.kind);
  const hit = ask.kind === 'proposal'
    ? mine.find((n) => n.item.slug === ask.key) || mine.find((n) => specNumber(text(n.item.slug)) === ask.key)
    : ask.kind === 'run' ? mine.find((n) => n.item.runId === ask.key) : mine.find((n) => String(n.item.number) === ask.key);
  return hit ? hit.id : null;
}

/** The address a node of work has in the page (`?pr=27`), so a link can be given; null for a node that has none (a deploy) */
export function addressOf(node) {
  const i = node && node.item;
  if (!i) return null;
  if (i.kind === 'pull') return `?pr=${i.number}`;
  if (i.kind === 'issue') return `?issue=${i.number}`;
  if (i.kind === 'thread') return `?thread=${i.number}`;
  if (i.kind === 'run') return `?run=${encodeURIComponent(i.runId)}`;
  if (i.kind === 'proposal') return `?spec=${encodeURIComponent(i.slug)}`;
  return null;
}

/** The words a screen reader hears when the view opens: "Work: 14 pieces of work, 3 waiting on you, and the 9 nodes of code they touch." */
export function openedWords({ work, code, waiting }) {
  const w = `${work} ${work === 1 ? 'piece' : 'pieces'} of work`;
  const c = code ? `, and the ${code} ${code === 1 ? 'node' : 'nodes'} of code ${code === 1 ? 'it touches' : 'they touch'}` : '';
  return `Work: ${w}${waiting ? `, ${waiting} waiting on you` : ''}${c}.`;
}

// ---------------------------------------------------------------------------
//  The view on the state (the same way house-model.js holds the House view's)
// ---------------------------------------------------------------------------

/** What the Work view keeps on the state (`state.work`): the answer, the scene made of it, the layers, the toggle, and the map it stands in for while it is open */
export const newWorkState = () => ({ status: 'idle', graph: null, nodes: [], edges: [], lanes: [], counts: { work: 0, code: 0, waiting: 0 }, problems: [], layers: startLayers(), waiting: false, saved: null, bounds: null });

/** Makes the scene of an answer (`workScene`), keeps the node a selection named, and sets the filters; the layout is `applyWorkLayout`'s */
export function setWorkGraph(state, graph, mapNodes) {
  const w = state.work || (state.work = newWorkState());
  const scene = workScene(graph, mapNodes);
  w.graph = graph;
  w.nodes = scene.nodes;
  w.edges = scene.edges;
  w.counts = scene.counts;
  w.problems = Array.isArray(graph && graph.problems) ? graph.problems : [];
  applyFilters(w.nodes, w.edges, { layers: w.layers, waiting: w.waiting });
  return w;
}

/** Puts the Work view's nodes on the state, keeping the map's to put back (`leaveWork`) */
export function enterWork(state) {
  const w = state.work || (state.work = newWorkState());
  if (!w.saved) w.saved = { nodes: state.nodes, edges: state.edges, rings: state.rings };
  showWork(state);
}

/** The Work view's nodes, edges, layers and lanes on the state (the answer changed, or the view opened) */
export function showWork(state) {
  const w = state.work;
  state.nodes = w.nodes;
  state.edges = w.edges;
  state.rings = { rings: [], clusters: [] };
  state.workLayers = w.layers;
  state.workRows = layerRowsOf(w.nodes);
  state.workLanes = w.lanes;
  state.selectedNode = state.selectedNode ? w.nodes.find((n) => n.id === state.selectedNode.id) || null : null; // the same id is the same selection
  state.selectedEdge = null;
}

/** The map's nodes, edges and layers as they were */
export function leaveWork(state) {
  const w = state.work;
  if (!w || !w.saved) return;
  state.nodes = w.saved.nodes;
  state.edges = w.saved.edges;
  state.rings = w.saved.rings;
  w.saved = null;
  state.workLayers = null;
  state.workRows = null;
  state.workLanes = null;
  state.selectedNode = state.selectedNode ? state.nodes.find((n) => n.id === state.selectedNode.id) || null : null;
  state.selectedEdge = null;
}

/** Lays the Work view out (writes on its nodes) and keeps its lanes for the scene */
export function applyWorkLayout(state, { phone = false } = {}) {
  const w = state.work;
  if (!w) return;
  const laid = layoutWork(w.nodes, { phone });
  w.lanes = laid.lanes;
  w.bounds = laid.bounds;
  state.workLanes = w.lanes;
  state.workRows = layerRowsOf(w.nodes);
}

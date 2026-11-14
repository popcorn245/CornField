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

import { NODE_THEMES } from '../core/schema.js';
import { WORK_KINDS, WORK_THEMES, WORK_EDGE_THEMES, workType } from '../core/schema.js';
import { relativeTime } from './review-model.js';
import { SPEC_STATE_WORDS, specStateOf } from './waiting-model.js';
import { runName, canAnswer } from './runs-model.js';
import { cornState } from './corn-state.js';
import { escapeHtml as esc } from '../core/text.js';
import { safeUrl } from './pieces/work-common.js';

/** The words of a kind of work, singular and as a layer */
export const KIND_WORDS = Object.freeze({ thread: 'Thread', issue: 'Issue', proposal: 'Proposal', run: 'Agent run', pull: 'Pull request', deploy: 'Deploy' });
export const LAYER_WORDS = Object.freeze({ thread: 'Threads', issue: 'Issues', proposal: 'Proposals', run: 'Agent runs', pull: 'Pull requests', deploy: 'Deploys' });
/** The key of the one layer that holds the code the work touches, and a kind's key (the node type it has in the Work view) */
export const CODE_LAYER = 'work-code';
/** The layer of the proposals that are only files in the checkout (`state: 'local'`): nobody has asked anyone to decide them, so it starts off (spec 0012 D4) */
export const DRAFT_LAYER = 'work-drafts';
export const layerKey = workType;
/** The rows of the Layers menu, in order (the mock's: threads, issues, proposals, pull requests, agent runs, deploys; then the drafts and the code) */
export const KIND_ORDER = Object.freeze(['thread', 'issue', 'proposal', 'pull', 'run', 'deploy']);
export const LAYER_KEYS = Object.freeze([...KIND_ORDER.map(workType), DRAFT_LAYER, CODE_LAYER]);
export const CODE_LAYER_WORDS = 'Code they touch';
export const DRAFT_LAYER_WORDS = 'Drafts';
/** A proposal that is only a file in the checkout: no pull request holds it, so nobody has been asked to decide it */
export const isDraft = (item) => !!item && item.kind === 'proposal' && item.state === 'local';

/** The lanes, in order: the stage each holds (server/work-graph.js STAGES) and its title */
export const LANES = Object.freeze([
  { key: 'talk', title: 'Talk' },
  { key: 'decide', title: 'Decide' },
  { key: 'build', title: 'Build' },
  { key: 'ship', title: 'Ship' },
]);
/** The local drafts, when their layer is on, have a lane of their own beside Decide (they are the Decide stage's, and not many people have been asked about them) */
export const DRAFT_LANE_TITLE = 'Drafts';
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

/** The most characters of a title in a node's name (the whole title is the node panel's), and of the whole text drawn under a node on a desktop (its tag and the start of its title: a lane is not much wider
 * than that on screen); on a phone a piece of work is drawn as its tag alone */
export const LABEL_CHARS = 34;
export const DRAWN_CHARS = 28;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** The same, cut at a word when one is near the end of what fits */
const clipWords = (s, n) => { if (s.length <= n) return s; const cut = s.slice(0, n - 1); const sp = cut.lastIndexOf(' '); return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`; };
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
 * The node of a piece of work: what the scene draws and the node panel shows for it. `item` is a node of the server's graph, or an old piece of work made
 * by `oldItem` (older than the graph's 14 days, or past its caps: the Work list reaches it, and the node panel shows it by the same path, `old: true`).
 */
export function workNode(item, degree = 0) {
  const theme = WORK_THEMES[item.kind];
  const title = text(item.title) || tagOf(item);
  const draft = isDraft(item);
  return {
    id: item.id, type: workType(item.kind), work: item.kind, shape: theme.shape, label: item.kind === 'deploy' ? `Deploy · ${clip(title, LABEL_CHARS)}` : `${tagOf(item)} · ${clip(title, LABEL_CHARS)}`,
    title, item, r: theme.r, color: theme.color, letters: theme.letters, terms: termsOf(item), groupName: draft ? DRAFT_LAYER_WORDS : LAYER_WORDS[item.kind],
    draft, waiting: item.waiting === true, updated: text(item.updated), stage: text(item.stage), degree, x: 0, y: 0,
  };
}

/** What the Work list holds that the graph does not: a node for it, drawn nowhere (`old`), for the node panel */
export const oldNode = (item) => ({ ...workNode(item), old: true });

/**
 * A piece of work the graph does not hold (older than its 14 days, or past its caps), as a node of the graph would give it, made from what the Work list read
 * of it: a pull request or an issue of the lists, a thread, a run of the runs list, a deploy, a proposal of the specs list. Null for a kind or a shape it cannot read.
 * Every word of it is the forge's: the panel escapes it, and `url` is an http(s) link or nothing.
 * @param {string} kind pull | issue | thread | run | deploy | proposal
 * @param {object} src the list's own item
 */
export function oldItem(kind, src) {
  if (!src || typeof src !== 'object') return null;
  const who = (a) => (a && typeof a.login === 'string' ? a.login : null);
  const base = { kind, title: text(src.title), url: safeUrl(src.url), updated: text(src.updatedAt) || text(src.createdAt), waiting: false };
  const num = Number.isInteger(src.number) ? src.number : null;
  switch (kind) {
    case 'pull': return num === null ? null : { ...base, id: `pull:${num}`, stage: 'build', state: text(src.state), open: src.state === 'open', number: num, draft: src.draft === true, author: who(src.author) };
    case 'issue': return num === null ? null : { ...base, id: `issue:${num}`, stage: 'talk', state: text(src.state), open: src.state === 'open', number: num, author: who(src.author) };
    case 'thread': return num === null ? null : { ...base, id: `thread:${num}`, stage: 'talk', state: text(src.state), open: src.state === 'open', number: num, threadKind: text(src.kind), author: who(src.author) };
    case 'run': return typeof src.runId === 'string' ? { ...base, id: `run:${src.runId}`, stage: 'build', title: runName(src), state: text(src.status), open: src.open === true, waiting: canAnswer(src), runId: src.runId, number: null, url: safeUrl(src.report && src.report.url) || safeUrl(src.comment && src.comment.url) || safeUrl(src.pull && src.pull.url), updated: text(src.lastActivity) || text(src.requestedAt), runKind: text(src.kind), requestedBy: src.requestedBy ?? null } : null;
    case 'deploy': return typeof src.id === 'string' ? { ...base, id: `deploy:${src.id}`, stage: 'ship', title: text(src.title) || text(src.name), state: text(src.state), open: src.state === 'queued' || src.state === 'running', deployId: src.id, number: null, updated: text(src.updatedAt) || text(src.createdAt), name: text(src.name), branch: text(src.branch), sha: text(src.sha), author: who(src.actor) } : null;
    case 'proposal': {
      if (typeof src.slug !== 'string') return null;
      const { state, counted } = specStateOf(src);
      const pull = src.pull && Number.isInteger(src.pull.number) ? src.pull : null;
      return { ...base, id: `proposal:${src.slug}`, stage: 'decide', title: text(src.title) || src.slug, state, open: true, waiting: counted, slug: src.slug, number: pull ? pull.number : null, url: safeUrl(pull && pull.url), updated: text(pull && (pull.updatedAt || pull.createdAt)), draft: state === 'local', author: who(pull && pull.author), source: text(src.source) };
    }
    default: return null;
  }
}

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

  const degree = new Map();
  for (const e of edges) { degree.set(e.from, (degree.get(e.from) || 0) + 1); degree.set(e.to, (degree.get(e.to) || 0) + 1); }
  const nodes = [];
  for (const item of work.values()) nodes.push(workNode(item, degree.get(item.id) || 0));
  let code = 0;
  for (const [id, by] of touched) {
    const base = onMap.get(id);
    const plan = planned.get(id);
    if (!base && !plan) continue;
    code++;
    nodes.push(base
      ? { ...base, x: 0, y: 0, r: CODE_R, touches: by.size, degree: by.size, hidden: false, dim: false }
      : { id, type: plannedType(plan.type), label: text(plan.label) || id, planned: true, r: CODE_R, touches: by.size, degree: by.size, x: 0, y: 0, groupName: CODE_LAYER_WORDS });
  }
  const waiting = nodes.filter((n) => n.waiting).length;
  return { nodes, edges, counts: { work: work.size, code, waiting } };
}

/**
 * One line of the Work view for the scene (spec 0012 D2, D3): a work-to-work link solid, `mentions` dotted, `adds` dashed; the word of its rel beside a lit one. The scene calls it
 * for every line (`state.workEdge`, put there by `showWork`), so the map's own code carries no table of the Work view's lines.
 * @param {object} edge the line, `{ from, to, kind, tone, word }`
 * @param {object} source the node it starts at
 * @param {object} target the node it ends at
 * @param {boolean} connected whether it joins the selection's neighbourhood
 * @param {boolean} focused whether a node is selected
 * @param {string} key the line's key
 * @param {{ PROPOSED_DASH: number[], USAGE_DASH: number[] }} dashes the map's two dash patterns
 * @param {Partial<Record<'work' | 'code' | 'adds', string>>} [colors] what the theme's `--corn-work-edge-<name>` tokens say (`state.workEdgeColors`); a name it does not set is drawn in its default (core/schema.js WORK_EDGE_THEMES)
 */
export function workEdge(edge, source, target, connected, focused, key, dashes, colors) {
  const lit = focused && connected;
  const name = edge.kind === 'adds' ? 'adds' : edge.tone === 'work' ? 'work' : 'code';
  const color = (colors && colors[name]) || WORK_EDGE_THEMES[name];
  const faded = source.dim === true && target.dim === true; // "Waiting on you" is on and neither end waits
  return {
    key, from: edge.from, to: edge.to, kind: edge.kind,
    x1: source.x, y1: source.y, x2: target.x, y2: target.y, r1: source.r, r2: target.r,
    color, width: lit ? 2.4 : 1.4, alpha: faded ? 0.12 : focused ? (connected ? 1 : 0.08) : 0.35,
    dash: edge.kind === 'adds' ? dashes.PROPOSED_DASH : edge.kind === 'mentions' ? dashes.USAGE_DASH : null,
    ticks: 0, curve: null, arrow: false, end: null, glow: 0, glowColor: null,
    label: lit ? { text: typeof edge.word === 'string' && edge.word ? edge.word : edge.kind, x: (source.x + target.x) / 2, y: (source.y + target.y) / 2, color, italic: false } : null,
    packet: null, mark: 'none', live: false,
  };
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

/**
 * The sizes the layout works in. World units, laid out for the zoom the first fit will have, so a name under a node (11 px at least, whatever the zoom: labels.js) has
 * the room on screen it needs: a cell is wide enough for a name, a row tall enough for a disc and a name under it, and lanes next to each other are staggered by half a row
 * so a name that runs past its lane lands between the next lane's. `margin` is what the first fit leaves on screen around the lanes, in px (the names at the edge, and the toggles at the top).
 */
const DESK = { cell: 200, row: 70, codeCell: 190, codeRow: 44, gap: 14, pad: 6, margin: { x: 100, top: 56, bottom: 24 }, caps: [100, 64, 48, 40, 32, 28, 24, 20, 18, 16, 14, 12, 10, 9, 8, 7, 6, 5] };
const PHONE = { cell: 104, row: 84, codeCell: 150, codeRow: 40, gap: 12, pad: 4, margin: { x: 36, top: 112, bottom: 16 } };
/** A lane's title (screen px) the first node sits under, and a name under a node (its gap and its line, px) */
const TITLE_PX = 40;
const NAME_PX = 22;
const LANE_FILL = 'rgba(66, 153, 225, 0.05)';
const LANE_STROKE = 'rgba(66, 153, 225, 0.18)';

/** A lane behind the nodes (`SceneLane`: scene.js, with no text of its own: its title is a line of the page, in screen space, work-view.js), and what the title says */
const lane = (key, title, count, x, y, w, h) => ({ key, name: title, count, x, y, w, h, radius: 14, fill: LANE_FILL, stroke: LANE_STROKE, strokeWidth: 1, title: null, note: null, arrow: null });

/** The text drawn under a node: a piece of work's tag and the start of its title (a phone: the tag), the name of a node of code (a phone: the start of it) */
function nameNodes(nodes, phone) {
  for (const n of nodes) {
    if (n.work) { const tag = tagOf(n.item); n.labelText = phone ? tag : `${tag} · ${clipWords(n.title, Math.max(8, DRAWN_CHARS - tag.length - 3))}`; }
    else n.labelText = clip(String(n.label), phone ? 12 : 32);
  }
}

/** The zoom that shows `w` by `h` world units with the margins left around them, on a screen `v.width` by `v.height`; at most 1 */
const zoomFor = (w, h, v, m) => Math.min(1, Math.max(1, v.width - 2 * m.x) / Math.max(1, w), Math.max(1, v.height - m.top - m.bottom) / Math.max(1, h));

/** The box the camera fits (engine/render.js `fitTarget`): the lanes, and around them the margins at the zoom that shows them; the engine's own padding `p` is taken out of it */
function fitBoxOf(w, h, z, m, p, v) {
  const minY = -(m.top - p) / z;
  // as tall as the screen shows at that zoom, so the lanes stay under the toggles when they are shorter than the screen (the fit centres the box)
  return { minX: -(m.x - p) / z, maxX: w + (m.x - p) / z, minY, maxY: Math.max(h + (m.bottom - p) / z, minY + (v.height - 2 * p) / z), zoom: z };
}

/**
 * Where the nodes sit: four lanes of work, then the code it touches (spec 0012 D3), made for the screen it is on. A desktop's lanes run left to right, and a lane (the
 * drafts' and the code's most of all) is cut into as many columns as show the most of it at once; a phone's run top to bottom (Talk, Decide, Build and Ship in one), with the code in
 * columns beside them. Only what is not hidden is laid out. Writes `x`, `y` and `labelText` on the nodes and returns the lanes behind them and the box the first fit shows.
 * @param {object[]} nodes the nodes of `workScene`
 * @param {{ phone?: boolean, width?: number, height?: number, padding?: number }} [opts] the map's size in px, and the engine's padding around a fit
 * @returns {{ lanes: object[], order: string[], bounds: { x: number, y: number, w: number, h: number }, fit: { minX: number, maxX: number, minY: number, maxY: number, zoom: number } }}
 */
export function layoutWork(nodes, { phone = false, width = 1200, height = 800, padding = phone ? 44 : 96 } = {}) {
  nameNodes(nodes, phone);
  const shown = nodes.filter((n) => !n.hidden);
  const mine = (key) => shown.filter((n) => n.work && !n.draft && n.stage === key).sort(byLane);
  const stages = LANES.map((l) => ({ ...l, nodes: mine(l.key) }));
  // A kind of work the server gave no stage still has a lane: the kind's own
  const known = new Set(stages.flatMap((s) => s.nodes.map((n) => n.id)));
  for (const n of shown.filter((x) => x.work && !x.draft && !known.has(x.id))) stages.find((s) => s.key === { thread: 'talk', issue: 'talk', proposal: 'decide', run: 'build', pull: 'build', deploy: 'ship' }[n.work]).nodes.push(n);
  stages.forEach((s) => s.nodes.sort(byLane));
  const drafts = shown.filter((n) => n.draft).sort(byLane);
  const code = shown.filter((n) => !n.work).sort(byTouch);
  const v = { width: Math.max(160, width), height: Math.max(160, height) };
  return phone ? layoutPhone(stages, drafts, code, v, padding) : layoutDesk(stages, drafts, code, v, padding);
}

/** How many columns a lane of `n` nodes has when a column holds at most `cap`, and how tall they are */
const cut = (n, cap) => { const cols = Math.max(1, Math.ceil(n / cap)); return { cols, rows: Math.max(1, Math.ceil(n / cols)) }; };

function layoutDesk(stages, drafts, code, v, p) {
  const c = DESK;
  // Left to right: Talk, Decide, the drafts (when they are shown), Build, Ship, then the code
  const lanes = [stages[0], stages[1], ...(drafts.length ? [{ key: 'drafts', title: DRAFT_LANE_TITLE, nodes: drafts }] : []), stages[2], stages[3], ...(code.length ? [{ key: 'code', title: CODE_LANE_TITLE, nodes: code, code: true }] : [])];
  const plan = (z, cap) => {
    const room = TITLE_PX / z;
    const below = NAME_PX / z;
    let left = 0;
    let tall = 0;
    const parts = lanes.map((l, i) => {
      const cell = l.code ? c.codeCell : c.cell;
      const row = l.code ? c.codeRow : c.row;
      const r = l.code ? CODE_R : 20;
      const { cols, rows } = cut(l.nodes.length, cap);
      const w = cols * cell + 2 * c.pad;
      const stagger = cols > 1 || i % 2 ? 0.5 : 0;
      const h = room + 2 * r + (rows - 1 + stagger) * row + below + 8;
      tall = Math.max(tall, h);
      const part = { l, i, cell, row, r, cols, rows, x: left, w, h };
      left += w + c.gap;
      return part;
    });
    return { parts, w: left - c.gap, h: tall, room };
  };
  let z = 0.6;
  let best = null;
  for (let pass = 0; pass < 3; pass++) {
    best = null;
    for (const cap of c.caps) {
      const g = plan(z, cap);
      const fit = zoomFor(g.w, g.h, v, c.margin);
      if (!best || fit > best.fit * 1.01) best = { g, fit, cap };
    }
    z = best.fit;
  }
  const { g } = best;
  const out = [];
  for (const part of g.parts) {
    const { l, i, cell, row, r, cols, rows } = part;
    l.nodes.forEach((n, j) => {
      const col = Math.floor(j / rows);
      n.x = part.x + c.pad + (col + 0.5) * cell;
      n.y = g.room + r + (j % rows + ((i + col) % 2) * 0.5) * row;
    });
    out.push(lane(l.key, l.title, l.nodes.length, part.x, 0, part.w, g.h));
  }
  return { lanes: out, order: g.parts.flatMap((part) => part.l.nodes.map((n) => n.id)), bounds: { x: 0, y: 0, w: g.w, h: g.h }, fit: fitBoxOf(g.w, g.h, z, c.margin, p, v) };
}

function layoutPhone(stages, drafts, code, v, p) {
  const c = PHONE;
  const bands = [stages[0], stages[1], ...(drafts.length ? [{ key: 'drafts', title: DRAFT_LANE_TITLE, nodes: drafts }] : []), { key: 'build-ship', title: 'Build · Ship', nodes: [...stages[2].nodes, ...stages[3].nodes] }];
  const plan = (z, perRow, codeCols) => {
    const room = TITLE_PX / z;
    const below = NAME_PX / z;
    const wBand = perRow * c.cell + 2 * c.pad;
    let y = 0;
    const parts = bands.map((b) => {
      const rows = Math.max(1, Math.ceil(b.nodes.length / perRow));
      const h = room + 40 + (rows - 1 + (perRow > 1 ? 0.5 : 0)) * c.row + below + 8;
      const part = { b, rows, y, h };
      y += h + c.gap;
      return part;
    });
    const hBands = y - c.gap;
    const codeRows = Math.max(1, Math.ceil(code.length / codeCols));
    const wCode = code.length ? codeCols * c.codeCell + 2 * c.pad : 0;
    const hCode = code.length ? room + 2 * CODE_R + (codeRows - 1 + (codeCols > 1 ? 0.5 : 0)) * c.codeRow + below + 8 : 0;
    return { parts, wBand, wCode, hBands, hCode, codeRows, room, w: wBand + (code.length ? c.gap + wCode : 0), h: Math.max(hBands, hCode) };
  };
  let z = 0.5;
  let best = null;
  for (let pass = 0; pass < 3; pass++) {
    best = null;
    for (const perRow of [2, 3, 4]) {
      for (const codeCols of code.length ? [1, 2, 3] : [1]) {
        const g = plan(z, perRow, codeCols);
        const fit = zoomFor(g.w, g.h, v, c.margin);
        if (!best || fit > best.fit * 1.01) best = { g, fit, perRow, codeCols };
      }
    }
    z = best.fit;
  }
  const { g, perRow, codeCols } = best;
  const out = [];
  for (const part of g.parts) {
    part.b.nodes.forEach((n, j) => { n.x = c.pad + (j % perRow + 0.5) * c.cell; n.y = part.y + g.room + 20 + (Math.floor(j / perRow) + ((j % perRow) % 2) * 0.5) * c.row; });
    out.push(lane(part.b.key, part.b.title, part.b.nodes.length, 0, part.y, g.wBand, part.h));
  }
  if (code.length) {
    const x0 = g.wBand + c.gap;
    code.forEach((n, j) => { const col = Math.floor(j / g.codeRows); n.x = x0 + c.pad + (col + 0.5) * c.codeCell; n.y = g.room + CODE_R + (j % g.codeRows + (col % 2) * 0.5) * c.codeRow; });
    out.push(lane('code', CODE_LANE_TITLE, code.length, x0, 0, g.wCode, g.hCode));
  }
  return { lanes: out, order: [...g.parts.flatMap((part) => part.b.nodes.map((n) => n.id)), ...code.map((n) => n.id)], bounds: { x: 0, y: 0, w: g.w, h: g.h }, fit: fitBoxOf(g.w, g.h, z, c.margin, p, v) };
}

// ---------------------------------------------------------------------------
//  Layers and "Waiting on you"
// ---------------------------------------------------------------------------

/** The layers as the Work view starts them: every one on but the drafts (the local proposals nobody has been asked to decide) */
export const startLayers = () => Object.fromEntries(LAYER_KEYS.map((k) => [k, k !== DRAFT_LAYER]));

/**
 * Sets `hidden` and `dim` on the nodes. A piece of work is hidden when its layer is off; code when its layer is off or every piece of work that touches it is
 * hidden (only code that work touches is drawn). With "Waiting on you" on, everything that does not wait is dimmed.
 */
export function applyFilters(nodes, edges, { layers = startLayers(), waiting = false } = {}) {
  const on = (key) => layers[key] !== false;
  const shown = new Set();
  for (const n of nodes) { n.hidden = n.draft ? !on(DRAFT_LAYER) : n.work ? !on(workType(n.work)) : false; if (n.work && !n.hidden) shown.add(n.id); }
  const reached = new Set();
  for (const e of edges) if (e.tone === 'code' && shown.has(e.from)) reached.add(e.to);
  for (const n of nodes) {
    if (!n.work) n.hidden = !on(CODE_LAYER) || !reached.has(n.id);
    n.dim = waiting && !n.waiting;
  }
  return nodes;
}

/** The Layers menu's rows in the Work view: `{ key, label, color, desc, countText }`, the six kinds, the local drafts and the code they touch */
export function layerRowsOf(nodes) {
  const of = (kind) => nodes.filter((n) => n.work === kind && !n.draft);
  const word = (n, w) => `${n} ${w}`;
  const rows = KIND_ORDER.map((kind) => {
    const list = of(kind);
    const open = list.filter((n) => n.item.open === true).length;
    const waiting = list.filter((n) => n.waiting).length;
    const countText = kind === 'proposal' ? (waiting ? word(waiting, 'to decide') : String(list.length))
      : kind === 'run' ? (waiting ? word(waiting, 'waiting') : String(list.length))
      : kind === 'pull' || kind === 'issue' ? word(open, 'open')
      : String(list.length);
    return { key: workType(kind), label: LAYER_WORDS[kind], color: WORK_THEMES[kind].color, desc: `${KIND_WORDS[kind]} nodes: ${list.length}`, countText, count: list.length };
  });
  const drafts = nodes.filter((n) => n.draft).length;
  rows.push({ key: DRAFT_LAYER, label: DRAFT_LAYER_WORDS, color: WORK_THEMES.proposal.color, desc: 'Proposals that are only files in the checkout: no pull request holds them, nobody has been asked to decide them', countText: word(drafts, 'local'), count: drafts });
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

/** What the node panel says of what comes next, above the actions: what each will do */
export function saysOf(item) {
  switch (item.kind) {
    case 'proposal': return item.waiting ? 'This waits on you. Review opens it over the map (Before, Diff, After); there you approve it or send it back.' : 'Review opens it over the map (Before, Diff, After).';
    case 'pull': return item.state === 'open' ? 'Land it merges this pull request at the head shown, once every check has passed; a failed check can be run again.' : 'Nothing waits on you.';
    case 'issue': return item.open ? 'Start an agent asks a runner to work on this issue; a confirm step shows what will be asked.' : 'Nothing waits on you.';
    case 'run': return item.waiting ? 'This waits on your answer: reply, continue or stop it.' : item.open ? 'You can stop it while it works.' : 'Nothing waits on you.';
    case 'thread': return 'A thread is a conversation on the forge: read it here, and reply there.';
    default: return 'Its logs are on the forge; here is what it restarted.';
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

// ---------------------------------------------------------------------------
//  The panel's markup: every word that came from the forge is escaped, every link goes through `safeUrl` (an http or https address, else no link)
// ---------------------------------------------------------------------------
const pill = (p) => `<span class="hx-forge-state${p.state ? ` hx-forge-state--${esc(p.state)}` : ''}" data-corn="state-pill"${cornState(p.state) ? ` data-corn-state="${esc(cornState(p.state))}"` : ''}>${esc(p.text)}</span>`;
const dotOf = (kind, color) => { const c = typeof color === 'function' ? color(kind) : ''; return `<span class="hx-work-dot" data-corn="swatch" data-work-kind="${esc(kind || 'code')}" aria-hidden="true"${c ? ` data-style="background-color: ${esc(c)}"` : ''}></span>`; };
const linkButton = (l) => `<button type="button" class="hx-linkbtn" data-corn="node-link" data-action="select-node" data-id="${esc(l.id)}">${esc(l.label)}</button>`;

/**
 * The node panel's markup for a piece of work (`panelOf`'s answer): its state, what it is connected to (each a button that selects that node), the words saying what the
 * actions will do, the place the actions go (`forge-detail`: the Work piece fills it, pieces/work-paint.js `paintDetail`: Land it, the checks, a run's answer field, Start an agent ...),
 * and a link to the forge when the address is a web one and the actions do not carry it.
 * @param {ReturnType<typeof panelOf>} p
 * @param {object} node
 * @param {{ color?: (kind: string) => string }} [opts] `color`: a kind's colour as the map draws it
 */
export function workPanelHtml(p, node, { color = () => '' } = {}) {
  const url = safeUrl(p.url);
  const kind = node.item.kind;
  const links = node.old
    ? '<div class="hx-fact" data-corn="section"><div class="hx-fact-k">Connected</div><div class="hx-fact-v hx-faint">Its links are not drawn here: it is older than the 14 days the map of work covers, or past its limits.</div></div>'
    : p.links.length
      ? `<div class="hx-fact" data-corn="section"><div class="hx-fact-k">Connected</div><div class="hx-fact-v"><ul class="hx-work-links" data-corn="work-links">${p.links.map((l) => `<li data-corn="work-link"><span class="hx-work-rel">${esc(l.rel)}</span>${dotOf(l.work, color)}${linkButton(l)}${l.planned ? ' <span class="hx-faint">planned</span>' : ''}</li>`).join('')}</ul></div></div>`
      : '<div class="hx-fact" data-corn="section"><div class="hx-fact-k">Connected</div><div class="hx-fact-v hx-faint">Nothing it is linked to is drawn.</div></div>';
  // A pull request's (a spec's too) and a deploy's own actions carry their link to the forge; the others get it here
  const specPull = kind === 'proposal' && Number.isInteger(node.item.number); // its pull request's actions carry the link
  const out = url && kind !== 'pull' && kind !== 'deploy' && !specPull ? `<a class="hx-btn hx-btn--quiet hx-foot-btn" data-corn-kind="quiet" data-corn="open-link" href="${esc(url)}" target="_blank" rel="noreferrer">Open on the forge ↗</a>` : '';
  const actions = `<div class="hx-work-actions" data-corn="work-actions"><p class="hx-faint">${esc(p.says)}</p><section id="forge-detail" class="hx-forge-detail" data-corn="work-detail" aria-label="Actions" data-work-kind="${esc(kind)}" data-work-ref="${esc(node.id)}"></section>${out}</div>`;
  return `<div class="hx-work-head" data-corn="work-head"><p class="hx-work-pills" data-corn="work-pills">${p.pills.map(pill).join(' ')}</p><p class="hx-faint">${esc(p.tag)}${p.meta ? ` · ${esc(p.meta)}` : ''}</p></div>${links}${actions}`;
}

/** The node panel's section for a node of code in the Work view: the work that touches it, and "Show on the map" (a planned node is not on the map yet) */
export function codePanelHtml(node, touching, { color = () => '' } = {}) {
  const list = touching.length
    ? `<ul class="hx-work-links" data-corn="work-links">${touching.map((l) => `<li data-corn="work-link"><span class="hx-work-rel">${esc(l.rel)}</span>${dotOf(l.work, color)}${linkButton(l)}</li>`).join('')}</ul>`
    : '<p class="hx-faint">No work touches it now.</p>';
  const show = node.planned ? '' : `<button type="button" class="hx-btn hx-btn--secondary hx-foot-btn" data-corn-kind="secondary" data-work-action="show-on-map" data-id="${esc(node.id)}">Show on the map</button>`;
  return `<div class="hx-fact" data-corn="section"><div class="hx-fact-k">Work</div><div class="hx-fact-v">${node.planned ? '<p class="hx-faint">Planned: a proposal adds it, and the map does not hold it yet.</p>' : ''}${list}${show}</div></div>`;
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

// ---------------------------------------------------------------------------
//  The keyboard (N and P step through the lanes; an arrow goes to the nearest node that way)
// ---------------------------------------------------------------------------

/** The node an arrow goes to from `from`: the nearest shown node that way, a little more for each step aside; null when there is none (and the first of `order` when nothing is selected) */
export function arrowTarget(nodes, from, key) {
  const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[key];
  if (!dir) return null;
  const shown = nodes.filter((n) => !n.hidden && n.x !== undefined);
  if (!from) return null;
  let best = null;
  let bestScore = Infinity;
  for (const n of shown) {
    if (n === from || n.id === from.id) continue;
    const along = (n.x - from.x) * dir[0] + (n.y - from.y) * dir[1];
    if (along < 1) continue;
    const aside = Math.abs((n.x - from.x) * dir[1]) + Math.abs((n.y - from.y) * dir[0]);
    if (aside > (dir[0] ? 2 * along + 60 : 0.6 * along + 40)) continue; // a cone: Down stays in its column, Right may reach a lane whose rows are a little off
    const score = along + 3 * aside;
    if (score < bestScore) { best = n; bestScore = score; }
  }
  return best;
}

/** What a screen reader hears when the keyboard lands on a node of the Work view: its name, its kind and state, what waits, and its place in the lanes */
export function landingWords(node, index, count) {
  if (!node.work) return `${node.label}, code${node.planned ? ', planned' : ''}, ${node.touches || 0} ${node.touches === 1 ? 'piece' : 'pieces'} of work touch it, ${index + 1} of ${count}`;
  const item = node.item;
  return `${node.label}, ${KIND_WORDS[item.kind].toLowerCase()}${node.draft ? ' (a local draft)' : ''}, ${stateWordsOf(item).toLowerCase()}${node.waiting ? ', waiting on you' : ''}, ${index + 1} of ${count}`;
}

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

/** The id of the node an address or a row of the Work list names, among the nodes of the view, or null (a spec by its number, `0100`, or by its whole slug; a deploy by its id) */
export function nodeForAddress(ask, nodes) {
  if (!ask || !ask.kind) return null;
  const mine = nodes.filter((n) => n.work === ask.kind);
  if (ask.kind === 'pull' && !mine.some((n) => String(n.item.number) === ask.key)) { const spec = nodes.find((n) => n.work === 'proposal' && String(n.item.number) === ask.key); if (spec) return spec.id; } // a spec's pull request is its proposal
  if (ask.kind === 'issue' && !mine.some((n) => String(n.item.number) === ask.key)) { const idea = nodes.find((n) => n.work === 'thread' && String(n.item.number) === ask.key); if (idea) return idea.id; } // an idea is an issue on the forge, drawn as a thread
  const hit = ask.kind === 'proposal'
    ? mine.find((n) => n.item.slug === ask.key) || mine.find((n) => specNumber(text(n.item.slug)) === ask.key)
    : ask.kind === 'run' ? mine.find((n) => n.item.runId === ask.key) : ask.kind === 'deploy' ? mine.find((n) => n.item.deployId === ask.key) : mine.find((n) => String(n.item.number) === ask.key);
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
export const newWorkState = () => ({ status: 'idle', graph: null, nodes: [], edges: [], lanes: [], counts: { work: 0, code: 0, waiting: 0 }, problems: [], layers: startLayers(), waiting: false, saved: null, bounds: null, fit: null, order: [], updating: false, stale: '', lastError: '' });

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
  state.workEdge = workEdge; // the scene draws the Work view's lines with it (scene.js)
  state.nodes = w.nodes;
  state.edges = w.edges;
  state.rings = { rings: [], clusters: [] };
  state.workLayers = w.layers; // set only while the view is open (leaveWork clears it): the layer code reads its presence as the Work view
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

/** Lays the Work view out for the map's size (writes on its nodes), and keeps its lanes for the scene and the box the first fit shows (`state.work.fit`: engine/render.js) */
export function applyWorkLayout(state, { phone = false } = {}) {
  const w = state.work;
  if (!w) return;
  const laid = layoutWork(w.nodes, { phone, width: state.width || (phone ? 390 : 1200), height: state.height || (phone ? 760 : 800), padding: (state.width || 1200) < 640 ? 44 : 96 }); // the engine's own padding around a fit in this view (engine/render.js `fitPadding`)
  w.lanes = laid.lanes;
  w.order = laid.order;
  w.bounds = laid.bounds;
  w.fit = laid.fit;
  state.workLanes = w.lanes;
  state.workRows = layerRowsOf(w.nodes);
}

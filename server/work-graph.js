/**
 * @module server/work-graph
 *
 * The map of work in one answer (spec 0012 D2, D3 and D7): the pieces of work of six kinds as nodes, how they link to each other and to
 * the code they touch as edges, and a line for everything that could not be read. `GET /api/forge/work-graph` (server/forge-routes.js)
 * answers `{ ok, nodes, edges, problems }` from `workGraph`.
 *
 *   Kind      Id                    Stage    Comes from
 *   thread    thread:<n>            talk     an idea (an issue with the threads label) or a spec PR's conversation (server/threads.js's rules)
 *   issue     issue:<n>             talk     an issue that is not an idea
 *   proposal  proposal:<slug>       decide   a proposal of an open or recent spec PR (`number` says which), else one in the checkout or a worktree;
 *                                           another spec PR holding the same slug is `proposal:<slug>@<n>` (each counts, as the Specs list's rows do)
 *   run       run:<runId>           build    an agent run (server/agent-runs.js)
 *   pull      pull:<n>              build    a pull request that is not a spec PR
 *   deploy    deploy:<id>           ship     a workflow run the config says is a deploy (server/deploys.js)
 *
 * Every node: `{ id, kind, stage, title, state, open, waiting, url, updated, ...}` and its number (`number`), slug (`slug`), run id (`runId`) or
 * deploy id (`deployId`). `waiting` is spec 0010 D1's rule, worked out by the same functions the page's number uses (explorer/waiting-model.js
 * `specStateOf`, explorer/runs-model.js `canAnswer`): a spec to decide, a run waiting on an answer; nothing else asks the maintainer a question.
 * The code a proposal adds, and the map does not hold yet, comes as `{ id, kind: 'code', planned: true, label, type }`; the code that exists is
 * on the map the page already has, and is only named by edges.
 *
 *   Rel         From -> to                          Comes from
 *   became      thread -> proposal                  the spec PR's text names the thread (`Thread: #n`, `Closes #n`: core/mentions.js `threadOfPull`, `closesOf`)
 *   discusses   thread -> proposal                  a spec PR's conversation, by its slug; an idea's `cornfield-thread` block that names a slug
 *   agent-on    issue or thread or proposal -> run  the run's refs (`issue`, `thread`, `proposal`)
 *   opened      run -> pull or proposal             the pull request the run opened (`run.pull`); a spec PR is its proposals
 *   closes      pull or proposal -> issue or thread `Closes #n` in the text (core/mentions.js `closesOf`); never a spec PR's conversation (a forge closes only issues)
 *   implements  pull -> proposal                    the pull request closes the build issue of the proposal (the marker pipeline.js `buildMarker` writes), or a code run on the proposal opened it
 *   shipped     pull or proposal -> deploy          the deploy ran at the pull request's merge commit (its head, when the forge gave none)
 *   changes     pull, proposal, run -> code         a PR's files (explorer/forge-panel-model.js `litFor`, renames included), a proposal's changed and removed nodes, a run's nodes (`litOfRun`)
 *   adds        proposal -> code                    the nodes a proposal adds: planned ones, until the map holds them
 *   mentions    thread, issue -> code               the `[[mentions]]` of its text (explorer/forge-panel-model.js `mentionsOf`, `messageNodes`; core/mentions.js)
 *   restarts    deploy -> code                      what the config says the deploy restarted (explorer/forge-panel-model.js `litForDeploy`)
 *
 * Never an edge to an id that is neither a node of the answer, nor a node of the map, nor a planned one. A map node whose id looks like a work
 * node's (`pull:3`) is left out, and said in `problems`, so an id names one thing.
 *
 * **Which work.** Open, and closed, merged or finished within `WINDOW_DAYS` (`inWindow`). The closed lists are asked for what moved in the window
 * (pull requests most recently updated first, issues updated since its start), so an old issue closed today is in it; a list that comes back
 * full, or deploys older than the workflow runs read, are said in `problems`.
 *
 * **What it costs.** A pull request's files are read once for a head commit and kept for good (server/proposal-pulls.js `filesAt`, which the
 * spec listing keeps by too), and so is a proposal's file at that head; a warm answer asks the forge for the lists only (open pull requests, recent
 * closed ones, issues, runs), a thread's comments again only when its last activity moved, and a spec PR's review state as the listing does (kept
 * five minutes per head). Every open pull request's files are read (kept per head and shared with the Specs list, which reads the same ones), so
 * every open spec PR is drawn and counted; at most `MAX_OPEN_PULLS` other open pull requests are drawn, and `MAX_PULL_FILES` files of each; what
 * is left out is named in `problems`, as is every source that could not be read: the rest of the graph is still answered.
 *
 * @typedef {{ source: string, text: string }} Problem
 */

import fs from 'node:fs';
import { DEFAULT_LIMIT, ForgeError } from './forge.js';
import { filesAt, forgeWords, pullProposals, readPullProposal, reviewStates } from './proposal-pulls.js';
import { listProposalFiles } from './files.js';
import { deploysOf } from './deploys.js';
import { ideaLabel } from '../core/config.js';
import { closesOf, linksOf, threadOfPull } from '../core/mentions.js';
import { litFor, litForDeploy, mentionsOf, messageNodes } from '../explorer/forge-panel-model.js';
import { canAnswer, litOfRun, runName } from '../explorer/runs-model.js';
import { specStateOf } from '../explorer/waiting-model.js';

/** Work older than this is not drawn once it is over (spec 0012 D2); the Work list reaches further back */
export const WINDOW_DAYS = 14;
/** The most open pull requests drawn (spec PRs are proposals, and all drawn), and the most recently closed ones; the rest is named in `problems` */
export const MAX_OPEN_PULLS = 50;
export const MAX_RECENT_PULLS = 50;
/** The most files of one pull request drawn as edges */
export const MAX_PULL_FILES = 300;
/** What each source is asked for (the open pull requests: all of them, as the Specs list asks) */
export const LIST_PULLS = 100;
export const LIST_ISSUES = 200;
export const LIST_RECENT_ISSUES = 100;
export const LIST_RUNS = 100;
export const MAX_THREADS = 100;
export const MAX_LOCAL_PROPOSALS = 100;
/** The longest text of a pull request or issue that is read for `Closes #n` and `[[mentions]]` */
export const BODY_READ = 20_000;
/** How many pull requests have their files, or threads their comments, asked at once */
const PARALLEL = 6;
const DAY_MS = 86_400_000;
/** How many numbers a `problems` line names */
const NAMED = 12;

export const KINDS = Object.freeze(['thread', 'issue', 'proposal', 'run', 'pull', 'deploy']);
export const STAGES = Object.freeze(['talk', 'decide', 'build', 'ship']);
export const RELS = Object.freeze(['became', 'discusses', 'agent-on', 'opened', 'closes', 'implements', 'shipped', 'changes', 'adds', 'mentions', 'restarts']);

const STAGE_OF = Object.freeze({ thread: 'talk', issue: 'talk', proposal: 'decide', run: 'build', pull: 'build', deploy: 'ship' });

// ---------------------------------------------------------------------------
//  The pure half
// ---------------------------------------------------------------------------

/** The stage (lane) of a kind of work: talk, decide, build or ship; null for a kind that is not work */
export const stageOf = (kind) => STAGE_OF[kind] ?? null;

/** Whether a time (ISO text) is within `days` of `nowMs`, a time in the future included; a time that is missing or not a date is not */
export function inWindow(iso, nowMs, days = WINDOW_DAYS) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t >= nowMs - days * DAY_MS;
}

/** Whether a piece of work is drawn: it is open, or it ended within the window (`ended`: when) */
export const isDrawn = (open, ended, nowMs, days = WINDOW_DAYS) => open === true || inWindow(ended, nowMs, days);

/** The marker of the build issue pipeline.js opens for a spec PR's proposal: `{ pull, slug }`, or null (server/pipeline.js `buildMarker` writes it) */
export function buildMarkerOf(body) {
  const m = /<!-- cornfield-build pull\/([1-9]\d{0,8}) ([A-Za-z0-9][A-Za-z0-9._-]*) -->/.exec(String(body ?? ''));
  return m ? { pull: Number(m[1]), slug: m[2] } : null;
}

const list = (v) => (Array.isArray(v) ? v : []);
const text = (v) => (typeof v === 'string' ? v : '');

/**
 * What a proposal does to the map: the nodes it adds (`{ id, label, type }`), and the ids it changes or removes. Anything that is not a proposal does nothing.
 * @param {any} proposal
 * @returns {{ adds: { id: string, label: string, type: string | null }[], changes: string[] }}
 */
export function touchesOf(proposal) {
  const nodes = proposal !== null && typeof proposal === 'object' ? proposal.nodes : null;
  const adds = list(nodes && nodes.add).filter((n) => n && typeof n.id === 'string' && n.id !== '').map((n) => ({ id: n.id, label: text(n.label) || n.id, type: text(n.type) || null }));
  const changes = [...list(nodes && nodes.change), ...list(nodes && nodes.remove)].map((n) => (typeof n === 'string' ? n : n && n.id)).filter((id) => typeof id === 'string' && id !== '');
  return { adds, changes: [...new Set(changes)] };
}

/**
 * The map's nodes a pull request's files are (a rename lights the old path's node too), from the page's own rule (`litFor`), at most `MAX_PULL_FILES` files.
 * @param {{ path: string, previousPath?: string | null, status: string }[]} files
 * @param {{ id: string, file?: string }[]} nodes
 * @returns {string[]}
 */
export function nodesOfFiles(files, nodes) {
  return [...litFor({ files: files.slice(0, MAX_PULL_FILES), checks: [] }, nodes).changed];
}

/** The order of the answer: newest first, then by id, so the same facts are the same bytes (the ETag) */
const newest = (a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Runs `fn` over `items`, `PARALLEL` at a time, keeping the order */
async function each(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) {
      const at = next++;
      out[at] = await fn(items[at], at);
    }
  }));
  return out;
}

/** An id of the work graph's own: a map node with one would be two things */
const WORK_ID = /^(?:thread|issue|proposal|run|pull|deploy):/;
/** A link the page may open: http(s) only; anything else (a runner's report saying `javascript:`) is no link */
const webUrl = (u) => (typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u) ? u : null);
const DATE = (iso) => String(iso).slice(0, 10);

const numbers = (ns) => `${ns.slice(0, NAMED).map((n) => `#${n}`).join(', ')}${ns.length > NAMED ? ` and ${ns.length - NAMED} more` : ''}`;

/** What a thread's comments said, kept by the time of the thread's last activity: `${number}` -> `{ stamp, refs, proposal }` */
const threadMemos = new WeakMap();

/** The errors that say the forge as a whole cannot be asked now: with nothing else read, the answer is that error, not an empty graph */
const wholeForge = (err) => err instanceof ForgeError && ['rate-limited', 'unavailable', 'unauthorized'].includes(err.code);

// ---------------------------------------------------------------------------
//  The graph
// ---------------------------------------------------------------------------

/**
 * @param {import('./forge.js').Forge} forge the forge as the signed-in maintainer
 * @param {any} config
 * @param {{ nodes?: { id: string, file?: string, label?: string, type?: string, stack?: string }[] } | null} map the repo's map (null: not read)
 * @param {{ where?: any, runs?: { list: () => Promise<{ runs: any[] }> } | null, now?: () => number }} [opts]
 *   `where` is the server's (`root`, `proposals`, the worktrees; also the key what is kept by head is kept under), `runs` the agent runs of the repo
 * @returns {Promise<{ nodes: object[], edges: { from: string, to: string, rel: string }[], problems: Problem[] }>}
 * @throws {ForgeError} when the forge as a whole could not be asked and nothing of it was read (rate-limited, away, the token refused)
 */
export async function workGraph(forge, config, map, { where = config, runs = null, now = Date.now } = {}) {
  const nowMs = now();
  /** @type {Problem[]} */
  const problems = [];
  const say = (source, words) => problems.push({ source, text: words });
  const allMapNodes = map && Array.isArray(map.nodes) ? map.nodes : [];
  if (!map) say('map', 'The map could not be read, so no work is drawn on the code it touches (run cornfield sync).');
  const workLike = allMapNodes.filter((n) => typeof n.id === 'string' && WORK_ID.test(n.id)).map((n) => n.id);
  if (workLike.length) say('map', `${workLike.length === 1 ? 'A map node has' : `${workLike.length} map nodes have`} an id the work graph uses for work (${workLike.slice(0, NAMED).join(', ')}), so no work is drawn on ${workLike.length === 1 ? 'it' : 'them'}: rename ${workLike.length === 1 ? 'it' : 'them'} in the map.`);
  const mapNodes = workLike.length ? allMapNodes.filter((n) => !workLike.includes(n.id)) : allMapNodes;
  const mapIds = new Set(mapNodes.map((n) => n.id));
  const label = ideaLabel(config);
  const attempt = async (fn) => { try { return { value: await fn() }; } catch (err) { return { err }; } };

  // What each source gives, read at once; a source that fails says so and the rest goes on
  const windowStart = new Date(nowMs - WINDOW_DAYS * DAY_MS).toISOString();
  const [openPulls, closedPulls, openIssues, closedIssues, deployRuns, runList, localFiles] = await Promise.all([
    // every open one, as the Specs list asks (it reads the same files, kept by head), so every open spec PR is here
    attempt(() => forge.pulls({ state: 'open' })),
    attempt(() => forge.pulls({ state: 'closed', limit: LIST_PULLS, sort: 'updated' })),
    attempt(() => forge.issues({ state: 'open', labels: [], limit: LIST_ISSUES })),
    attempt(() => forge.issues({ state: 'closed', labels: [], limit: LIST_RECENT_ISSUES, since: windowStart })),
    attempt(() => forge.runs({ limit: LIST_RUNS })),
    attempt(async () => {
      if (!runs) throw new Error('no store');
      return (await runs.list()).runs;
    }),
    attempt(() => listProposalFiles(where)),
  ]);
  const forgeRead = [openPulls, closedPulls, openIssues, closedIssues, deployRuns];
  const failed = forgeRead.find((r) => r.err && wholeForge(r.err));
  if (failed && forgeRead.every((r) => r.err)) throw failed.err;
  const fail = (source, what, r) => say(source, `${what} could not be read: ${forgeWords(r.err)}`);
  if (openPulls.err) fail('pulls', 'The open pull requests', openPulls);
  if (closedPulls.err) fail('pulls', 'The recently closed pull requests', closedPulls);
  if (openIssues.err) fail('issues', 'The open issues', openIssues);
  if (closedIssues.err) fail('issues', 'The recently closed issues', closedIssues);
  if (deployRuns.err) fail('deploys', 'The deploys', deployRuns);
  if (runList.err) say('runs', runs ? `The agent runs could not be read: ${forgeWords(runList.err)}` : 'Agent runs are not kept here (they need sign-in and a forge), so none are drawn.');
  if (localFiles.err) say('proposals', `The proposals in the checkout could not be read: ${forgeWords(localFiles.err)}`);

  /** @type {Map<string, any>} id -> node */
  const nodes = new Map();
  /** @type {{ from: string, to: string, rel: string }[]} */
  const edges = [];
  const edge = (from, to, rel) => edges.push({ from, to, rel });
  /** @type {Map<string, { id: string, label: string, type: string | null }>} */
  const planned = new Map();
  const put = (node) => { nodes.set(node.id, { stage: stageOf(node.kind), waiting: false, ...node }); return node; };
  /** A proposal's `adds`: to the map's node, or a planned one; never one with a work node's id */
  const addsOf = (id, adds) => {
    for (const a of adds) {
      if (WORK_ID.test(a.id)) continue;
      if (!mapIds.has(a.id) && !planned.has(a.id)) planned.set(a.id, a);
      edge(id, a.id, 'adds');
    }
  };

  // ---- pull requests (and the spec PRs among them) ----
  const byUpdate = (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b.number - a.number);
  const openAll = (openPulls.value ?? []).slice().sort(byUpdate);
  const isOpen = new Set(openAll.map((p) => p.number));
  // A pull request closed between the two lists is in both: it is the open one here
  const closedAll = (closedPulls.value ?? []).filter((p) => !isOpen.has(p.number));
  const recentAll = closedAll.filter((p) => isDrawn(false, p.mergedAt || p.closedAt || p.updatedAt, nowMs)).sort(byUpdate);
  const recentShown = recentAll.slice(0, MAX_RECENT_PULLS);
  if (recentAll.length > recentShown.length) say('pulls', `${recentAll.length} pull requests were closed in the last ${WINDOW_DAYS} days: the ${MAX_RECENT_PULLS} newest are drawn, ${numbers(recentAll.slice(MAX_RECENT_PULLS).map((p) => p.number))} are left out.`);
  const lastClosed = (closedPulls.value ?? []).at(-1);
  if ((closedPulls.value ?? []).length >= LIST_PULLS && lastClosed && inWindow(lastClosed.updatedAt, nowMs)) {
    say('pulls', `Only the ${LIST_PULLS} most recently updated closed pull requests were read (back to ${DATE(lastClosed.updatedAt)}); one closed before that in the last ${WINDOW_DAYS} days is not drawn.`);
  }
  const listed = [...openAll, ...recentShown];

  // A pull request's files, once for a head commit (kept), and the proposals its files add or change
  const gotFiles = await each(listed, (pull) => attempt(() => filesAt(forge, where, pull)));
  const unread = [];
  const cut = [];
  const filesOf = new Map();
  /** @type {Map<number, any[]>} number -> the proposal entries of a spec PR */
  const specEntries = new Map();
  for (const [i, pull] of listed.entries()) {
    if (gotFiles[i].err) { unread.push(pull.number); continue; }
    const files = gotFiles[i].value;
    filesOf.set(pull.number, files.slice(0, MAX_PULL_FILES));
    try {
      const found = await pullProposals(forge, where, pull);
      if (found.length) specEntries.set(pull.number, found);
    } catch (err) { say('proposals', `The proposals of pull request #${pull.number} could not be found: ${forgeWords(err)}`); }
    if (files.length > MAX_PULL_FILES && !specEntries.has(pull.number)) cut.push(pull);
  }
  // The open pull requests drawn as pull requests: every spec PR is a proposal and drawn; of the rest, the most recently updated
  const openPlain = openAll.filter((p) => !specEntries.has(p.number));
  const openShown = openPlain.slice(0, MAX_OPEN_PULLS);
  if (openPlain.length > openShown.length) {
    const many = openAll.length >= DEFAULT_LIMIT ? `${DEFAULT_LIMIT} or more` : String(openPlain.length);
    say('pulls', `${many} pull requests are open: the ${MAX_OPEN_PULLS} most recently updated are drawn, ${numbers(openPlain.slice(MAX_OPEN_PULLS).map((p) => p.number))} are left out.`);
  }
  const shownSet = new Set([...openShown, ...openAll.filter((p) => specEntries.has(p.number)), ...recentShown].map((p) => p.number));
  const pulls = listed.filter((p) => shownSet.has(p.number));
  for (const n of [...specEntries.keys()]) if (!shownSet.has(n)) specEntries.delete(n);
  const unreadShown = unread.filter((n) => shownSet.has(n));
  if (unreadShown.length) {
    const first = gotFiles.find((r) => r.err);
    say('pulls', `The files of ${unreadShown.length === 1 ? 'pull request' : 'pull requests'} ${numbers(unreadShown)} could not be read, so what ${unreadShown.length === 1 ? 'it changes' : 'they change'} is not drawn: ${forgeWords(first.err)}`);
  }
  const cutShown = cut.filter((p) => shownSet.has(p.number)).map((p) => `#${p.number} changes ${gotFiles[listed.indexOf(p)].value.length}`);
  if (cutShown.length) say('pulls', `Only the first ${MAX_PULL_FILES} files of a pull request are drawn: ${cutShown.slice(0, NAMED).join(', ')}${cutShown.length > NAMED ? ` and ${cutShown.length - NAMED} more` : ''} files.`);

  // The proposals of the spec PRs: their files at the head (kept by it), and the review state of the open ones
  const allEntries = [...specEntries.values()].flat();
  const parsed = new Map();
  let unreadFile = 0;
  let firstUnread = null;
  await each(allEntries, async (entry) => {
    try {
      parsed.set(entry, JSON.parse(await readPullProposal(forge, where, entry)));
    } catch (err) { unreadFile++; firstUnread ??= err instanceof SyntaxError ? `not valid JSON: ${err.message}` : forgeWords(err); }
  });
  if (unreadFile) say('proposals', `${unreadFile} proposal ${unreadFile === 1 ? 'file' : 'files'} in spec pull requests could not be read, so what ${unreadFile === 1 ? 'it adds and changes is' : 'they add and change are'} not drawn: ${firstUnread}`);
  const pullOf = new Map(pulls.map((p) => [p.number, p]));
  const openEntries = allEntries.filter((e) => pullOf.get(e.pull.number).state === 'open');
  let states = [];
  try { states = await reviewStates(forge, where, openEntries, { now: () => nowMs }); } catch { states = []; }
  const stateOf = new Map(openEntries.map((e, i) => [e, states[i] || { pushedAt: null, review: null }]));
  if ([...stateOf.values()].some((s) => s.review && s.review.error)) say('proposals', 'The review of some spec pull requests could not be read, so they are not counted as waiting on you.');

  /** the proposals of each pull request: number -> ids; and the node ids of a number, for `opened` and `shipped` */
  const byPull = new Map();
  /** a spec PR's proposal by `${number} ${slug}` -> its id: the first spec PR to hold a slug (open ones first, the most recently updated first) is `proposal:<slug>` */
  const proposalAt = new Map();
  /** the nodes each proposal changes, drawn once every planned node is known: a proposal may change what another adds */
  const changed = [];
  for (const [n, entries] of specEntries) {
    const pull = pullOf.get(n);
    for (const entry of entries) {
      const proposal = parsed.get(entry);
      const id = nodes.has(`proposal:${entry.slug}`) ? `proposal:${entry.slug}@${n}` : `proposal:${entry.slug}`;
      proposalAt.set(`${n} ${entry.slug}`, id);
      let state;
      let waiting = false;
      if (pull.state === 'open') {
        const got = stateOf.get(entry);
        const read = specStateOf({ pull: { draft: pull.draft, createdAt: pull.createdAt, updatedAt: pull.updatedAt, pushedAt: got.pushedAt }, review: got.review });
        state = read.state;
        waiting = read.counted;
      } else state = pull.state;
      put({
        id, kind: 'proposal', title: text(proposal && proposal.title) || entry.slug, state, open: pull.state === 'open', waiting, slug: entry.slug, number: n, url: webUrl(pull.url), updated: pull.updatedAt, draft: pull.draft,
        author: pull.author ? pull.author.login : null,
      });
      byPull.set(n, [...(byPull.get(n) || []), id]);
      if (proposal) {
        const t = touchesOf(proposal);
        addsOf(id, t.adds);
        changed.push([id, t.changes]);
      }
    }
  }

  for (const pull of pulls) {
    if (specEntries.has(pull.number)) continue;
    const id = `pull:${pull.number}`;
    put({ id, kind: 'pull', title: pull.title, state: pull.state, open: pull.state === 'open', number: pull.number, url: webUrl(pull.url), updated: pull.updatedAt, draft: pull.draft, author: pull.author ? pull.author.login : null });
    byPull.set(pull.number, [id]);
    if (filesOf.has(pull.number)) for (const to of nodesOfFiles(filesOf.get(pull.number), mapNodes)) edge(id, to, 'changes');
  }

  // ---- local proposals (the checkout and its worktrees): the PR's wins ----
  const local = new Map();
  for (const f of localFiles.value ?? []) if (!nodes.has(`proposal:${f.slug}`) && !local.has(f.slug)) local.set(f.slug, f);
  const locals = [...local.values()].map((f) => {
    let at = null;
    try { at = fs.statSync(f.file).mtime.toISOString(); } catch { at = null; }
    return { f, at: at ?? new Date(0).toISOString() };
  }).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.f.slug < b.f.slug ? -1 : 1));
  if (locals.length > MAX_LOCAL_PROPOSALS) say('proposals', `${locals.length} proposals are drafts in the checkout: the ${MAX_LOCAL_PROPOSALS} most recently written are drawn.`);
  for (const { f, at } of locals.slice(0, MAX_LOCAL_PROPOSALS)) {
    const proposal = f.parsed && f.parsed.proposal;
    const id = `proposal:${f.slug}`;
    put({ id, kind: 'proposal', title: text(proposal && proposal.title) || f.slug, state: 'local', open: true, waiting: false, slug: f.slug, number: null, url: null, updated: at, draft: true, source: f.source });
    const t = touchesOf(proposal);
    addsOf(id, t.adds);
    changed.push([id, t.changes]);
  }
  for (const [from, ids] of changed) for (const to of ids) if (mapIds.has(to) || planned.has(to)) edge(from, to, 'changes');

  // ---- issues, and the ideas among them as threads ----
  const isIdea = (issue) => label !== null && issue.labels.some((l) => l.toLowerCase() === label.toLowerCase());
  if ((openIssues.value ?? []).length >= LIST_ISSUES) say('issues', `${LIST_ISSUES} or more issues are open: the ${LIST_ISSUES} newest are drawn, the older ones are not.`);
  if ((closedIssues.value ?? []).length >= LIST_RECENT_ISSUES) say('issues', `${LIST_RECENT_ISSUES} or more closed issues moved in the last ${WINDOW_DAYS} days: the ${LIST_RECENT_ISSUES} newest are read, the rest are not drawn.`);
  const openNumbers = new Set((openIssues.value ?? []).map((i) => i.number));
  const issues = [...(openIssues.value ?? []), ...(closedIssues.value ?? []).filter((i) => !openNumbers.has(i.number) && isDrawn(false, i.closedAt || i.updatedAt, nowMs))];
  const ideas = [];
  for (const issue of issues) {
    if (isIdea(issue)) { ideas.push(issue); continue; }
    const open = issue.state === 'open';
    const id = `issue:${issue.number}`;
    put({ id, kind: 'issue', title: issue.title, state: issue.state, open, number: issue.number, url: webUrl(issue.url), updated: issue.updatedAt, author: issue.author ? issue.author.login : null });
    for (const to of messageNodes(text(issue.body).slice(0, BODY_READ), mapNodes).nodes.map((n) => n.id)) edge(id, to, 'mentions');
  }

  // ---- threads: ideas, and the conversations of the spec PRs ----
  if (label === null) say('threads', 'Threads are off in this config (threads: false), so no thread is drawn.');
  else {
    const ideaItems = ideas.slice(0, MAX_THREADS);
    const specThreads = [...specEntries.keys()].filter((n) => pullOf.get(n).state === 'open');
    if (ideas.length > ideaItems.length) say('threads', `${ideas.length} ideas are in the window: the ${MAX_THREADS} newest are drawn.`);
    let memo = threadMemos.get(where);
    if (!memo) threadMemos.set(where, (memo = new Map()));
    const all = [
      ...ideaItems.map((item) => ({ kind: 'idea', item, texts: [text(item.body).slice(0, BODY_READ)], comments: item.comments ?? 0 })),
      ...specThreads.map((n) => ({ kind: 'proposal', item: pullOf.get(n), texts: [], comments: null })),
    ];
    let unreadThreads = 0;
    let firstThread = null;
    const read = await each(all, async (t) => {
      const key = `${t.kind}:${t.item.number}`;
      const kept = memo.get(key);
      if (kept && kept.stamp === t.item.updatedAt) return kept;
      let comments = [];
      // Nothing to ask for an idea that has no comment: its text is the issue's
      if (!(t.kind === 'idea' && t.comments === 0)) {
        try { comments = await forge.comments(t.item.number); } catch (err) { unreadThreads++; firstThread ??= forgeWords(err); return null; }
      }
      const links = linksOf([...t.texts, ...comments.map((c) => text(c.body).slice(0, BODY_READ))]);
      const done = { stamp: t.item.updatedAt, refs: links.refs, proposal: links.proposal };
      memo.set(key, done);
      if (memo.size > 400) memo.delete(memo.keys().next().value);
      return done;
    });
    if (unreadThreads) say('threads', `The comments of ${unreadThreads} ${unreadThreads === 1 ? 'thread' : 'threads'} could not be read, so what ${unreadThreads === 1 ? 'it mentions is' : 'they mention are'} not drawn: ${firstThread}`);
    all.forEach((t, i) => {
      const links = read[i];
      const { item } = t;
      const id = `thread:${item.number}`;
      put({ id, kind: 'thread', title: item.title, state: item.state, open: item.state === 'open', number: item.number, url: webUrl(item.url), updated: item.updatedAt, threadKind: t.kind, author: item.author ? item.author.login : null });
      if (t.kind === 'proposal') for (const to of byPull.get(item.number) || []) edge(id, to, 'discusses');
      if (!links) return;
      for (const to of mentionsOf(links.refs, mapNodes).ids) edge(id, to, 'mentions');
      if (links.proposal && nodes.has(`proposal:${links.proposal}`)) edge(id, `proposal:${links.proposal}`, 'discusses');
    });
  }

  /** The node of an issue's or an idea's number, whichever it is here; with `issueOnly`, never a spec PR's conversation (a pull request, which no keyword closes) */
  const talkNode = (n, issueOnly = false) => {
    if (nodes.has(`issue:${n}`)) return `issue:${n}`;
    const thread = nodes.get(`thread:${n}`);
    return thread && !(issueOnly && thread.threadKind === 'proposal') ? thread.id : null;
  };

  // ---- what a pull request or a spec PR says it closes, and what it implements ----
  const buildOf = new Map();
  for (const issue of issues) { const marker = buildMarkerOf(issue.body); if (marker) buildOf.set(issue.number, marker); }
  for (const pull of pulls) {
    const froms = byPull.get(pull.number) || [];
    if (!froms.length) continue;
    const spec = specEntries.has(pull.number);
    const named = [...closesOf(text(pull.body).slice(0, BODY_READ), forge.repo)];
    const threadN = spec ? threadOfPull(text(pull.body).slice(0, BODY_READ)) : null;
    if (threadN !== null && !named.includes(threadN)) named.push(threadN);
    for (const n of named) {
      const to = talkNode(n, true);
      if (!to) continue;
      if (spec && to.startsWith('thread:')) { for (const from of froms) edge(to, from, 'became'); continue; }
      for (const from of froms) edge(from, to, 'closes');
      // The build issue names its spec PR and slug: that proposal, else the slug's own node
      const marker = buildOf.get(n);
      const built = marker && (proposalAt.get(`${marker.pull} ${marker.slug}`) || (nodes.has(`proposal:${marker.slug}`) ? `proposal:${marker.slug}` : null));
      if (!spec && built) edge(froms[0], built, 'implements');
    }
  }

  // ---- runs ----
  for (const run of runList.value ?? []) {
    const ended = run.lastActivity || (run.report && run.report.at) || run.requestedAt;
    if (!isDrawn(run.open === true, ended, nowMs)) continue;
    const id = `run:${run.runId}`;
    put({
      id, kind: 'run', title: runName(run), state: run.status, open: run.open === true, waiting: canAnswer(run), runId: run.runId, number: null, url: webUrl(run.report && run.report.url) || webUrl(run.comment && run.comment.url) || webUrl(run.pull && run.pull.url),
      updated: ended, requestedBy: run.requestedBy ?? null,
    });
    const about = [run.refs && run.refs.issue, run.refs && run.refs.thread].filter((n) => n != null).map(talkNode).filter(Boolean);
    for (const from of new Set(about)) edge(from, id, 'agent-on');
    const slug = run.refs && run.refs.proposal;
    if (typeof slug === 'string' && nodes.has(`proposal:${slug}`)) edge(`proposal:${slug}`, id, 'agent-on');
    if (run.pull && run.pull.number != null) {
      for (const to of byPull.get(run.pull.number) || []) {
        edge(id, to, 'opened');
        if (typeof slug === 'string' && to.startsWith('pull:') && run.kind === 'code' && nodes.has(`proposal:${slug}`)) edge(to, `proposal:${slug}`, 'implements');
      }
    }
    for (const to of litOfRun(run).changed) if (mapIds.has(to)) edge(id, to, 'changes');
  }

  // ---- deploys ----
  const lastRun = (deployRuns.value ?? []).at(-1);
  if ((deployRuns.value ?? []).length >= LIST_RUNS && lastRun && inWindow(lastRun.createdAt, nowMs)) {
    say('deploys', `Only the ${LIST_RUNS} newest workflow runs were read (back to ${DATE(lastRun.createdAt)}); a deploy before that in the last ${WINDOW_DAYS} days is not drawn.`);
  }
  const deploys = deploysOf(deployRuns.value ?? [], config.deploys).filter((d) => isDrawn(d.state === 'queued' || d.state === 'running', d.updatedAt || d.createdAt, nowMs));
  const shippedAt = new Map();
  for (const pull of pulls) {
    const sha = pull.state === 'merged' ? pull.mergeSha || (pull.head && pull.head.sha) : null;
    if (sha) shippedAt.set(sha, [...(shippedAt.get(sha) || []), pull.number]);
  }
  for (const d of deploys) {
    const id = `deploy:${d.id}`;
    put({ id, kind: 'deploy', title: d.title || d.name, state: d.state, open: d.state === 'queued' || d.state === 'running', deployId: d.id, number: null, url: webUrl(d.url), updated: d.updatedAt || d.createdAt, name: d.name, branch: d.branch, sha: d.sha, author: d.actor ? d.actor.login : null });
    for (const n of shippedAt.get(d.sha) || []) for (const from of byPull.get(n) || []) edge(from, id, 'shipped');
    for (const to of litForDeploy(d, mapNodes).nodes.map((x) => x.id)) edge(id, to, 'restarts');
  }

  // ---- the answer: every edge ends at a node that is there, once; the same facts in the same order ----
  const known = (id) => nodes.has(id) || mapIds.has(id) || planned.has(id);
  const seen = new Set();
  const kept = edges.filter((e) => {
    const key = `${e.from}\u0000${e.to}\u0000${e.rel}`;
    if (seen.has(key) || !known(e.from) || !known(e.to) || e.from === e.to) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const out = [...nodes.values()].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || newest(a, b));
  const plannedOut = [...planned.values()].filter((p) => kept.some((e) => e.to === p.id)).sort((a, b) => (a.id < b.id ? -1 : 1)).map((p) => ({ id: p.id, kind: 'code', planned: true, label: p.label, type: p.type }));
  return { nodes: [...out, ...plannedOut], edges: kept, problems };
}

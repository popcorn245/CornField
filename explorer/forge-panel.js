/**
 * @module explorer/forge-panel
 *
 * The Work panel (CF-07, CF-42, spec 0001 section 4; it began as the issues and PRs panel): Specs, PRs, Issues, Threads, Runs and Deploys, in
 * the order of the loop. Specs lists the proposals the header's Proposals menu lists (proposal.js `proposalListing`), a row opens one. A selection
 * (a PR, a thread, a deploy) REPLACES the list, with a back control named by the list; the State, Label and Author selects sit behind one Filter
 * chip; Release notes is an action at the foot of the PRs list; `openForge({ tab })` opens it on a tab, and any `data-action="toggle-forge"` toggles it.
 * The text below describes each view as it was built.
 *
 * The repo's pull requests and issues, from whichever forge
 * the config names, read through the server (`/api/forge/…`, server/forge-routes.js; the signed-in maintainer's own
 * token never leaves it). A header button opens it: a slide-over from the left from 768px, a bottom sheet on a phone
 * (sheets.js). With no forge in the config, or no sign-in (Stage 1: there is nobody to ask the forge as, and the
 * server answers 403), the button and the panel stay hidden and nothing else changes.
 *
 *   - Two lists, Pull requests and Issues, with filters on what is loaded: state, label, author and a search
 *     box. A row links out to the forge; a pull request's row selects it.
 *   - A selected pull request asks for its files and the checks on its head. Each file lights the node whose
 *     `file` holds it (the deepest one), a failing check lights the test files its name names, and the rest of the
 *     map fades back (`state.forgeLit`, painted by scene.js). A file on no node is listed, with the others, as not on
 *     the map. Each node has a button that selects it on the map.
 *   - The third tab, Agents, groups the work by what it belongs to (explorer/agents-model.js): one group per proposal
 *     (the spec PR and the work on it), per issue (its pull requests and branches) and one for the rest, with the work
 *     made by an agent marked and why. Nothing is launched (ADR 0007); a pull request there selects like any other.
 *   - A fourth tab, Deploys (PIPE-03, docs/deploys.md): the latest workflow runs that are deploys, each with the nodes
 *     the config says it restarted. Selecting one lights those nodes (a stack brings its containers; a failed deploy lights
 *     them red) through the same paint path, turning on the layers they are on; a deploy no `deploys.restarts` names is listed and says it lights nothing.
 *     Only one thing is selected at a time, a pull request or a deploy.
 *   - A Threads tab (docs/threads.md): the ideas (issues labelled `idea`) and the spec PRs' conversations, newest activity first.
 *     Opening one shows its messages, read-only, with a link out to the forge to reply (writing happens there, spec 0005 D6), and
 *     lights the nodes its text mentions (`[[node-id]]`, `[[repo/path]]`, a `cornfield-thread` block; core/mentions.js) the way a
 *     pull request lights its files. "New idea" opens an issue with the label as the signed-in maintainer: a POST to cornfield's
 *     own server, which guards, counts and audits it. A node's panel lists the threads that mention it (`state.threadIndex`).
 *   - Keys: Tab reaches the header button, Enter opens the panel with the focus on its title; Escape closes it and
 *     gives the focus back to the button. What happens (a list loaded, a pull request selected, what it lights, a
 *     failure) is said through the map's live region (`announce`, keyboard.js). Closed, the panel is `inert`.
 *   - Actions (CF-08), on a selected pull request, for a signed-in maintainer: Land it, when it is open, ready and every
 *     check is green, and Re-run on a failed or cancelled check the forge can run again. Where a button is not shown the panel says
 *     why. Land it opens a confirm dialog that shows exactly what will land (the pull request, its head commit, where
 *     it goes, how, each check); a scrim covers the page, the dialog is `aria-modal`, Tab stays inside, Escape and Cancel close it and give the
 *     focus back, and it is announced. What is sent is the head that was shown: a push since is refused by the server,
 *     which checks everything again (server/forge-actions.js). While one is in flight the buttons are off.
 *   - With `proposals.approveLands` on, a spec pull request that was approved and is waiting for its checks says **Will land when
 *     checks pass** (read from `GET /api/forge/pulls/<n>/landing`, the server's own state) with a **Cancel** that POSTs to
 *     `…/landing/cancel` (server/lander.js). With the key off the panel asks nothing and shows nothing more.
 *   - The pipeline's own steps (PIPE-05, server/pipeline.js), each one button with a confirm step that shows exactly what
 *     will be made, read from the server first (the plan, with a digest the server must find again):
 *       1. an open issue in the Issues list has **Start a spec …**: a branch, a stub proposal and a draft spec pull request;
 *       2. a selected spec pull request whose latest maintainer review approves a proposal has **Open the build issue …**:
 *          an issue linking the pull request and the proposal, with the node changes as a checklist;
 *       3. **Land it** (above) is the third step.
 *     Asking a step again finds what the first ask made and says so; it makes nothing twice. No step starts an agent.
 *   - Errors and rate limits are a line in the panel, in the words the server gives; a stale answer says it is old.
 *   - A third tab, Release notes (PIPE-04): the pull requests merged since a tag, grouped by what they changed on the
 *     map, as Markdown to preview and Copy (the clipboard, else the selected text to copy by hand). "Post as draft"
 *     asks first (the tag, and in words what will and will not happen), then POSTs once to the server, which makes the
 *     notes again itself and has the forge keep them as a DRAFT release; nothing is published and no tag is made. The
 *     page never sends the text of the notes, only the tag. The result, or the forge's refusal, is a line in words.
 *
 *   - Agent runs (issue #80, spec 0005, explorer/runs-model.js): **Start an agent** on an open issue and on an issue or proposal group of the Agents
 *     tab opens a dialog (kind, a profile when the config lists any, a brief, and in words what it will do) and POSTs once to
 *     `/api/agent-runs`; the Agents tab lists the runs with their state, links and a **Stop**, which asks the runner to stop. cornfield only
 *     asks: the request is a comment on the forge, as the maintainer. A refusal (the limit, a run already open) is said in the dialog, with
 *     a way to ask on purpose where the rule allows it.
 *
 * What is asked, which words and which nodes are forge-panel-model.js, tested without a page.
 */

import { state, nodeById, escHtml, touchScene, onSceneTouch } from './state.js';
import { render, isNodeVisible } from './render.js';
import { selectNode, repaintThreads } from './panels.js';
import { announce, centreOn } from './keyboard.js';
import { trapTab } from './focusables.js';
import { isPhone, registerSheet, expandSheet, collapseSheet } from './sheets.js';
import { relativeTime } from './review-model.js';
import { LAYER_DEFS, toggleLayer } from './layers.js';
import { WORK_URL, groupWork, filterGroups, groupWords, workStatus, markWords } from './agents-model.js';
import {
  RUNS_URL, runsUrl, stopUrl, runOnThread, threadRunWords, runOnPull, pullRunWords, canRetry, retryRefs, retryWords, limitsFromFields, defaultLimits, LIMIT_KEYS, briefUrl, answerUrl, answerBody, answerWordsFor, KINDS, aboutWords, statusWords, statusWhy, runMeta, canStop, runsStatus, runnerState, runnerWords, triggerNotice, totalsLines, handLines, startBody, startWords, stopWords, confirmStartWords, litOfRun, changeWords,
} from './runs-model.js';
import { runsHtml, totalsHtml, loadingRowsHtml, runPillHtml } from './runs-view.js';
import { setRunsOnMap, clearRunsOnMap } from './runs-map.js';
import {
  STATES, defaultFilters, listUrl, pullUrl, serverState, filterItems, facetsOf, stateWords, metaWords, checkWords, checksWords, litFor, errorWords,
  landingUrl, cancelLandingUrl, landingWords, mergeBlock, rerunWhy, confirmMerge, mergeBody, actionUrl, actionWords,
  specBlock, buildOffers, planUrl, confirmSpec, confirmBuild, specBody, buildBody, existingWords,
  listKeyOf, litForDeploy, nodesForRestarts, deployWords, deployMeta, emptyWords, approvalWarning,
  DRAFTS_URL, notesUrl, sinceChoices, notesSummary, validTag, confirmWords, postedWords, draftRequest,
  threadsUrl, threadUrl, issueUrl, IDEAS_URL, threadKindWords, threadMeta, litForThread, mentionsIndex, ideaRequest, ideaWords,
} from './forge-panel-model.js';
import { cornStateAttr, stateIconHtml } from './corn-state.js';
import { sayResult, clearResult, resultOf, showResultIn, resetFeedbackForTests } from './feedback.js';
import { isOffline, initConnection, notSentWords, resetConnectionForTests } from './connection.js';
import { proposalListing, onProposalListing, loadProposalList, hooks as proposalHooks } from './proposal.js';
import { specRowHtml, mergeSpecs } from './proposal-model.js';
import { t } from './strings.js';

const $ = (id) => document.getElementById(id);
const FORGE_NAMES = { github: 'GitHub', forgejo: 'Forgejo' };
const SEARCH_ANNOUNCE_MS = 500;

/** What is shown: the lists loaded, the filters, the selected pull request with its files and checks */
const ui = {
  config: null,
  open: false,
  kind: 'specs', // the tab: specs | pulls | issues | threads | work (Runs) | deploys; 'notes' is the Release notes view, reached from the PRs list
  filtersOpen: false, // the Filter chip's box
  filters: defaultFilters(),
  lists: {}, // `${kind}|${server state}` -> { items, at, rate, stale }
  work: null, // { grouped, problem, at, rate, stale } of the Agents tab
  workFilters: { agentsOnly: false, finished: false },
  loading: false,
  error: '',
  selected: null, // the pull request's number
  selectedOn: '', // the tab it was selected on ('pulls' or 'work')
  detail: null, // { pull, files, checks, at, rate, stale } of the selected one
  landing: null, // what waits to land on its approval for the selected pull request ({ slug, by, since }), or null
  detailError: '',
  lit: null, // litFor(detail, nodes)
  thread: null, // the selected thread's number (Threads tab)
  threadDetail: null, // { thread, at, rate, stale } of the selected one: its messages, as written
  threadError: '',
  litThread: null, // litForThread(thread, nodes)
  idea: freshIdea(), // the New idea form
  deploy: null, // the selected deploy's id; the deploy itself is `deployItem`
  deployItem: null,
  litDeploy: null, // litForDeploy(deployItem, nodes)
  nodesSeen: null, // the `state.nodes` the lights were worked out for
  busy: '', // the action in flight ('merge', or 'rerun:<check id>'), so a second click does nothing
  note: null, // { text, ok }: what the last action came to, for the selected pull request
  confirm: null, // { opener: selector, kind: 'merge' | 'spec' | 'build', plan?, n?, slug? } while the confirm dialog is open
  actNote: null, // { text, ok, url }: what the last pipeline step came to
  notes: freshNotes(), // the Release notes view
  runs: null, // { data, error } of the Agents tab's runs: what /api/agent-runs answered
  runNote: null, // { text, ok }: what the last Stop came to
  runSel: null, // the run lit on the map (Light on the map), by id
  runnerSaid: null, // the runner state last shown ('online', 'offline', 'none'; null off the pull transport), so a change is said once
  runTimelines: new Set(), // the runs whose timeline is open
  runReplies: new Map(), // the reply typed so far for each waiting run, so a repaint (the runs are looked at again) keeps it
  agent: null, // { opener, refs, posting, retryOf, filled } while the Start an agent dialog is open
  retrying: false, // a Start again reading its run's whole brief, so a second click does nothing
};

/** The Release notes view: the draft loaded for a tag, and where the confirm step is */
function freshNotes() {
  return { since: '', data: null, loading: false, error: '', confirm: false, posting: false, message: '', bad: false, link: null };
}

/** The New idea form: whether it is open, one send in flight, and what the last send came to */
function freshIdea() {
  // `opener` is the id of the node whose panel button that opened the form ('' when the bar's own button did), `node` the node it was about
  return { open: false, busy: false, message: '', bad: false, link: null, opener: '', node: null };
}

let wired = false;
let runsTimer = 0;
/** How often the runs are read again while one is open */
export const RUNS_POLL_MS = 60_000;
let threadToken = 0;
let indexToken = 0;
let indexLoading = false;
let indexCache = null; // { items, nodes, map } the mentions index for the list and map it was made from
let listToken = 0;
let pullToken = 0;
let notesToken = 0;
let searchTimer = null;
let offScene = null;
let offListing = null;
let now = () => Date.now();

const forgeName = () => FORGE_NAMES[ui.config && ui.config.forge && ui.config.forge.type] || 'the forge';
const listKey = () => listKeyOf(ui.kind, ui.filters.state);
const current = () => (ui.kind === 'work' ? ui.work : ui.kind === 'specs' ? specsList() : ui.lists[listKey()]) || null;
/** The proposals the Proposals menu lists (proposal.js reads them), as a list of the panel's own shape; null before the first answer */
function specsList() {
  const { entries, problem, forgeProblem, at } = proposalListing();
  // One row for a proposal, however many places it is in: its spec PR and the copy in a checkout or a worktree are one (mergeSpecs)
  return entries ? { items: mergeSpecs(entries), at: at ? new Date(at).toISOString() : '', rate: '', stale: '', problem: problem || forgeProblem || '' } : null;
}
const groupsShown = () => (ui.work ? filterGroups(ui.work.grouped.groups, ui.workFilters) : []);
const plural = (n, word, more = `${word}s`) => `${n} ${n === 1 ? word : more}`;
const kindWords = () => ({ specs: 'spec', pulls: 'pull request', issues: 'issue', threads: 'thread', deploys: 'deploy' })[ui.kind] || 'piece of work';
/** A link only if it is the forge's web address: a forge's JSON is data, not trusted markup */
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

// ---------------------------------------------------------------------------
//  Asking the server
// ---------------------------------------------------------------------------

/** A failed answer in words (the model's), said as offline when the browser is, and naming what could not be loaded */
const failWords = (res, what = '') => errorWords(res.status, res.body, { offline: isOffline(), what });

/** One GET (or the one POST, with its JSON); `{ ok, status, body }`, with a status of null when the server did not answer */
async function request(url, refresh, post) {
  try {
    // Refresh sends `Cache-Control: no-cache`, which the server takes as "ask the forge again"
    const init = post ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post) } : refresh ? { cache: 'reload' } : {};
    const res = await fetch(url, init);
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    return { ok: !!res.ok && !!body && body.ok !== false, status: res.status, body };
  } catch {
    return { ok: false, status: null, body: null };
  }
}

/** Loads the Agents tab: everything it groups, in one answer */
async function loadWork(refresh, token) {
  ui.loading = true;
  ui.error = '';
  paint();
  const [res] = await Promise.all([request(WORK_URL, refresh), loadRuns(refresh)]);
  if (token !== listToken) return;
  ui.loading = false;
  if (res.ok) {
    const b = res.body;
    ui.work = { grouped: groupWork(b), problem: b.specsProblem || '', at: b.at, rate: b.rate || '', stale: b.stale || '' };
    announce(`${workStatus(groupsShown(), '', now())}${ui.work.stale ? '. This is an older answer' : ''}`);
  } else {
    ui.error = failWords(res, 'the work');
    announce(ui.error);
  }
  paint();
}

/** Loads the runs for the Agents tab (a refresh also has cornfield look at the forge for their reports first); a failure is a line, never a blank panel */
async function loadRuns(refresh, { say = true } = {}) {
  const before = ui.runs && ui.runs.data ? ui.runs.data.runs : null;
  const res = await request(runsUrl(refresh), refresh);
  ui.runs = res.ok && Array.isArray(res.body.runs) ? { data: res.body, error: '' } : { data: ui.runs && ui.runs.data, error: failWords(res, 'the runs') };
  if (!(ui.runs && ui.runs.data)) return;
  // The map shows the open runs' nodes; a run lit on the map follows its nodes; what changed is said, once the first answer is in
  setRunsOnMap(ui.runs.data.runs);
  syncRunsPoll();
  if (ui.runSel) relightRun();
  const said = say ? changeWords(before, ui.runs.data.runs) : [];
  // A runner appearing or going quiet is said once, when the state changes (the line itself is plain text, not a live region). The state last
  // shown is kept, not worked out again from the last listing: a runner that goes quiet is the same listing judged later
  const was = ui.runnerSaid;
  const is = runnerState(ui.runs.data.runnerPresence, now());
  ui.runnerSaid = is;
  if (say && was && is && was !== is) said.push(runnerWords(ui.runs.data.runnerPresence, now()));
  if (said.length) announce(said.join('. '));
}

/**
 * Looks at the runs again in `RUNS_POLL_MS`, but only while one is open: a run's answer that has none open disarms it, and the next answer
 * with one open (a run requested here, or a look from elsewhere) arms it again. One timer at most; never while the page is hidden or put
 * away (`pagehide`). So the marks on the map and the words follow the runs.
 */
function syncRunsPoll() {
  const open = !!(ui.runs && ui.runs.data && ui.runs.data.open > 0);
  if (!open || pageAway) {
    clearTimeout(runsTimer);
    runsTimer = 0;
    return;
  }
  if (runsTimer) return;
  runsTimer = setTimeout(async () => {
    runsTimer = 0;
    if (!(typeof document !== 'undefined' && document.hidden)) {
      await loadRuns(false);
      paint();
    }
    syncRunsPoll();
  }, RUNS_POLL_MS);
}
/** The page is being put away (closed, or into the back-forward cache): no look until it is shown again */
let pageAway = false;
function onPageHide() { pageAway = true; syncRunsPoll(); }
function onPageShow() { pageAway = false; syncRunsPoll(); }

/** Loads the list the kind and state name (again, past the server's cache, on a refresh) */
async function loadList(refresh = false, quiet = false) {
  const token = ++listToken;
  if (ui.kind === 'work') return loadWork(refresh, token);
  if (ui.kind === 'specs') return loadSpecs(token, quiet);
  const key = listKey();
  ui.loading = true;
  ui.error = '';
  paint();
  const res = await request(listUrl(ui.kind, ui.filters.state), refresh);
  if (token !== listToken) return;
  ui.loading = false;
  if (res.ok) {
    ui.lists[key] = { items: res.body.items || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '', problem: res.body.problem || '' };
    if (ui.kind === 'threads') {
      repaintThreads();
      // A thread's row names the state of the run that is about it (issue #104): the runs are read, once, when the tab is the first thing opened
      if (!ui.runs) loadRuns(false, { say: false }).then(() => { if (ui.open && ui.kind === 'threads') paint(); }, () => {});
    }
    if (!quiet) announce(`${plural(filterItems(ui.lists[key].items, ui.kind, ui.filters).length, kindWords())} shown${ui.lists[key].stale ? '. This is an older answer' : ''}`);
  } else {
    ui.error = failWords(res, `the ${kindWords()}s`);
    if (!quiet) announce(ui.error);
  }
  paintFilters();
  paint();
}

/** Loads the Specs tab: the proposals the server finds (the list the header's Proposals menu shows, proposal.js); always asked again, worktrees come and go */
async function loadSpecs(token, quiet) {
  ui.loading = true;
  ui.error = '';
  paint();
  await loadProposalList();
  if (token !== listToken) return;
  ui.loading = false;
  const { entries, problem } = proposalListing();
  if (!entries) ui.error = `Could not load the proposals. ${problem || 'cornfield did not answer.'}`;
  if (!quiet) announce(ui.error || `${plural(entries.length, 'spec')} shown`);
  paint();
}

/** The counts on the tabs, read quietly the first time the panel opens: the open pull requests and issues (the Threads and Runs counts come from what those tabs read anyway) */
function primeCounts() {
  for (const kind of ['pulls', 'issues']) {
    const key = listKeyOf(kind, 'open');
    if (ui.lists[key] || primed.has(kind) || kind === ui.kind) continue;
    primed.add(kind);
    request(listUrl(kind, 'open'), false).then((res) => {
      if (res.ok && !ui.lists[key]) ui.lists[key] = { items: res.body.items || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '', problem: res.body.problem || '' };
      if (ui.open) paint();
    });
  }
  if (!primed.has('threads')) { primed.add('threads'); ensureThreadsList(); }
  if (ui.kind !== 'specs' && !proposalListing().entries) loadProposalList();
}
const primed = new Set();

/** Selects a pull request: asks for its files and checks, then lights what they are on the map */
async function selectPull(n) {
  const token = ++pullToken;
  dropThread();
  ui.deploy = null;
  ui.deployItem = null;
  ui.litDeploy = null;
  ui.selected = n;
  ui.selectedOn = ui.kind; // the PRs list or the Runs tab's groups: its detail replaces that list only
  ui.detail = null;
  ui.landing = null;
  ui.detailError = '';
  ui.lit = null;
  ui.note = null;
  state.forgeLit = null;
  touchScene();
  render();
  paint();
  const res = await request(pullUrl(n), false);
  if (token !== pullToken) return;
  if (!res.ok) {
    ui.detailError = failWords(res, `pull request ${n}`);
    announce(ui.detailError);
    paint();
    return;
  }
  ui.detail = { pull: res.body.pull, files: res.body.files || [], checks: res.body.checks || [], specs: res.body.specs || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '' };
  relight();
  // The run that made it is on the detail: the runs are read once, if the config has any
  if (!ui.runs && ui.config.agents && ui.config.agents.runs) loadRuns(false, { say: false }).then(() => { if (ui.selected === n) paint(); }, () => {});
  await loadLanding(n, token);
  $('forge-panel').querySelector('.hx-forge-body').scrollTop = 0; // the pull request's files are what was asked for, not the row that was tapped
  announce(selectionWords());
}

/** Asks the server whether the selected pull request waits to land on its approval (a read of the server's own state, not of the forge); nothing is shown when it does not */
async function loadLanding(n, token) {
  if (!(ui.config && ui.config.forge && ui.config.forge.approveLands)) return; // the key is off: nothing to ask
  const res = await request(landingUrl(n), true);
  if (token !== pullToken || ui.selected !== n) return;
  ui.landing = res.ok && res.body && res.body.landing ? res.body.landing : null;
  paint();
}

/** Stops the landing that waits on the selected pull request: a POST from this page, then the pull request is read again */
async function cancelLanding(n) {
  if (ui.busy) return;
  ui.busy = 'landing';
  ui.note = null;
  paint();
  const res = await post(cancelLandingUrl(n), {});
  ui.busy = '';
  ui.note = { text: res.ok ? `Pull request #${n} will not land on its own. It stays open.` : `Not cancelled: ${(res.body && res.body.error) || 'cornfield did not answer.'}`, ok: res.ok };
  announce(ui.note.text);
  ui.landing = null;
  paint();
  if (ui.selected === n) await refreshForge({ quiet: true });
}

/** Lets go of the selected pull request: nothing is lit any more */
export function clearPull() {
  pullToken++;
  const had = ui.selected;
  if (ui.confirm) closeConfirm({ restoreFocus: false });
  ui.selected = null;
  ui.note = null;
  ui.detail = null;
  ui.landing = null;
  ui.detailError = '';
  ui.lit = null;
  state.forgeLit = null;
  touchScene();
  render();
  paint();
  if (had !== null) announce(`Pull request ${had} cleared`);
}

/** What the selected pull request lights, worked out again: for the nodes now on the map */
function relight() {
  ui.nodesSeen = state.nodes;
  if (ui.runSel) {
    const run = runById(ui.runSel);
    state.forgeLit = run ? litOfRun(run) : null;
  } else if (ui.threadDetail && ui.threadDetail.thread) {
    ui.litThread = litForThread(ui.threadDetail.thread, state.nodes);
    state.forgeLit = { changed: ui.litThread.changed, failing: ui.litThread.failing };
  } else if (ui.deployItem) {
    ui.litDeploy = litForDeploy(ui.deployItem, state.nodes);
    state.forgeLit = { changed: ui.litDeploy.changed, failing: ui.litDeploy.failing };
  } else if (ui.detail) {
    ui.lit = litFor(ui.detail, state.nodes);
    state.forgeLit = { changed: ui.lit.changed, failing: ui.lit.failing };
  } else {
    ui.lit = null;
    state.forgeLit = null;
  }
  touchScene();
  render();
  paint();
}

/** A proposal opening, or the live layer, changes the nodes: the lights follow them */
function onNodesChange() {
  if ((ui.detail || ui.deployItem || ui.threadDetail) && state.nodes !== ui.nodesSeen) relight();
  repaintThreads();
}

/** Selects a deploy: nothing to ask (the list holds what it restarted), so its nodes light at once */
export function selectDeploy(id) {
  const found = ui.lists.deploys && ui.lists.deploys.items.find((d) => d.id === id);
  if (!found) return;
  pullToken++;
  dropThread();
  ui.selected = null;
  ui.detail = null;
  ui.detailError = '';
  ui.lit = null;
  ui.deploy = id;
  ui.deployItem = found;
  // A container, a stack or a machine is on a layer that starts off: the layers the deploy's nodes are on come on, or nothing would light
  const turnedOn = [];
  for (const n of litForDeploy(found, state.nodes).nodes) {
    const layer = LAYER_DEFS.find((l) => l.key === n.type);
    if (layer && state.activeLayers[layer.key] === false) { toggleLayer(layer.key); turnedOn.push(layer.label); }
  }
  relight();
  $('forge-panel').querySelector('.hx-forge-body').scrollTop = 0; // the deploy's nodes are what was asked for, not the row that was tapped
  announce(deploySelectionWords(turnedOn));
}

/** Lets go of the selected deploy: nothing is lit any more */
export function clearDeploy() {
  const had = ui.deployItem;
  ui.deploy = null;
  ui.deployItem = null;
  ui.litDeploy = null;
  state.forgeLit = null;
  touchScene();
  render();
  paint();
  if (had) announce(`Deploy ${had.name} cleared`);
}

// ---------------------------------------------------------------------------
//  Threads
// ---------------------------------------------------------------------------

/** Forgets the selected thread without painting: another thing is being selected */
function dropThread() {
  ui.runSel = null;
  threadToken++;
  ui.thread = null;
  ui.threadDetail = null;
  ui.threadError = '';
  ui.litThread = null;
}

/** Selects a thread: asks for its messages (read-only), then lights the nodes they mention */
/** The thread a successful answer holds, or null (a failure, or an answer without one) */
const threadOf = (res) => (res && res.ok && res.body && res.body.thread && typeof res.body.thread === 'object' && Array.isArray(res.body.thread.messages) ? res.body.thread : null);

async function selectThread(n) {
  const token = ++threadToken;
  pullToken++;
  ui.runSel = null;
  ui.selected = null;
  ui.detail = null;
  ui.detailError = '';
  ui.lit = null;
  ui.landing = null;
  ui.deploy = null;
  ui.deployItem = null;
  ui.litDeploy = null;
  ui.thread = n;
  ui.threadDetail = null;
  ui.threadError = '';
  ui.litThread = null;
  state.forgeLit = null;
  touchScene();
  render();
  paint();
  const res = await request(threadUrl(n), false);
  if (token !== threadToken) return;
  // An answer without a thread in it is a failure too: nothing to show or light
  const thread = threadOf(res);
  if (!thread) {
    ui.threadError = res.ok ? `Thread ${n} could not be read: the answer had no thread in it. Refresh to ask again.` : failWords(res, `thread ${n}`);
    announce(ui.threadError);
    paint();
    return;
  }
  ui.threadDetail = { thread, at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '' };
  relight();
  $('forge-panel').querySelector('.hx-forge-body').scrollTop = 0; // the thread's messages are what was asked for, not the row that was tapped
  announce(threadSelectionWords());
}

/** Lets go of the selected thread: nothing is lit any more */
export function clearThread() {
  const had = ui.thread;
  dropThread();
  state.forgeLit = null;
  touchScene();
  render();
  paint();
  if (had !== null) announce(`Thread ${had} cleared`);
}

/** What a screen reader hears when a thread is selected */
function threadSelectionWords() {
  const { thread } = ui.threadDetail;
  const lit = ui.litThread ? ui.litThread.nodes.length : 0;
  const off = ui.litThread ? ui.litThread.unresolved.length : 0;
  return `Thread ${thread.number}, ${thread.title}: ${plural(thread.messages.length, 'message')}, ${lit ? `${plural(lit, 'node')} lit` : 'no node mentioned'}${off ? `, ${off} named that ${off === 1 ? 'is' : 'are'} not on the map` : ''}. Read-only: reply on ${forgeName()}.`;
}

/** Shows a thread from the map (a node's "Mentioned in"): the panel opens on the Threads tab with that thread selected */
function openThread(n) {
  if (ui.kind !== 'threads') {
    ui.kind = 'threads';
    ui.actNote = null;
    ui.filters = defaultFilters('threads');
  }
  openForge();
  paintFilters();
  selectThread(n);
}

/** The threads list for the node panel's "Mentioned in", read once (quietly) when a node is first selected, and when the Threads tab loads it */
function ensureThreadsList() {
  if (!ui.config || ui.config.threads === false || ui.lists['threads|open'] || indexLoading) return;
  indexLoading = true;
  const token = ++indexToken;
  request(threadsUrl('open'), false).then((res) => {
    indexLoading = false;
    if (token !== indexToken || !res.ok || ui.lists['threads|open']) return;
    ui.lists['threads|open'] = { items: res.body.items || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '', problem: res.body.problem || '' };
    repaintThreads();
    if (ui.open && ui.kind === 'threads') paint();
  });
}

/** The threads that mention a node on the map now, or null while the list has not been read */
function threadsFor(nodeId) {
  const list = ui.lists['threads|open'];
  if (!list) return null;
  if (!indexCache || indexCache.items !== list.items || indexCache.nodes !== state.nodes) indexCache = { items: list.items, nodes: state.nodes, map: mentionsIndex(list.items, state.nodes) };
  return indexCache.map.get(nodeId) || [];
}

// ---------------------------------------------------------------------------
//  New idea
// ---------------------------------------------------------------------------

/** Opens or closes the form; the focus goes to the title, or back to the button */
function toggleIdea(open) {
  ui.idea.open = open;
  if (open) { ui.idea.message = ''; ui.idea.opener = ''; ui.idea.node = null; }
  paintIdea();
  if (open) $('idea-title').focus(); else focusIdeaOpener();
}

/** Puts the focus back on what opened the form: the node panel's button while it is still there, else the New idea button */
function focusIdeaOpener() {
  const from = ui.idea.opener ? [...document.querySelectorAll('[data-thread-start]')].find((b) => b.dataset.threadStart === ui.idea.opener) : null;
  (from && !from.closest('[inert]') ? from : $('idea-open')).focus();
}

/** A node id that reads back as one mention: no brackets or line breaks, as core/mentions.js parses them */
const MENTIONABLE = /^[^[\]\r\n]{1,200}$/;

/** "Start a thread about this" (a node's panel): the New idea form, with the node's label as the title and its mention in the text */
function startThread(node) {
  if (!node || ui.idea.busy || !ui.config || ui.config.threads === false) return;
  if (ui.kind !== 'threads') {
    ui.kind = 'threads';
    ui.actNote = null;
    ui.filters = defaultFilters('threads');
  }
  openForge();
  paintFilters();
  ui.idea.open = true;
  ui.idea.message = '';
  ui.idea.bad = false;
  ui.idea.link = null;
  ui.idea.node = { id: node.id, label: node.label };
  ui.idea.opener = node.id;
  // Never lose a draft: a title already typed stays, and text already typed stays under the mention, which is added once (`.value` is
  // text, never markup, so the label and the id need no escaping here)
  const title = $('idea-title');
  if (title.value.trim() === '') title.value = String(node.label || node.id).slice(0, 256);
  const text = $('idea-body');
  const mention = MENTIONABLE.test(node.id) ? `[[${node.id}]]` : '';
  if (mention && !text.value.includes(mention)) text.value = text.value.trim() === '' ? `${mention}\n\n` : `${mention}\n\n${text.value}`;
  paintIdea();
  $('idea-title').focus();
}

/** The one write: a POST to cornfield's own server, which opens an issue with the label as the maintainer */
async function sendIdea() {
  if (ui.idea.busy) return;
  const asked = ideaRequest($('idea-title').value, $('idea-body').value);
  if (!asked) {
    ui.idea.message = 'Give the idea a title.';
    ui.idea.bad = true;
    ui.idea.link = null;
    paintIdea();
    announce(ui.idea.message);
    $('idea-title').focus();
    return;
  }
  ui.idea.busy = true;
  ui.idea.message = '';
  paintIdea();
  announce(`Opening the idea on ${forgeName()}`);
  const res = await post(IDEAS_URL, asked);
  ui.idea.busy = false;
  ui.idea.message = ideaWords(forgeName(), res);
  ui.idea.bad = !res.ok;
  ui.idea.link = res.ok && res.body.issue ? res.body.issue.url : null;
  if (res.ok) {
    ui.idea.open = false;
    $('idea-title').value = '';
    $('idea-body').value = '';
  }
  paintIdea();
  announce(ui.idea.message);
  if (res.ok) await afterIdea(res);
  else $('idea-title').focus();
}

/**
 * After an idea is opened: the list read again, the new thread selected (so what it mentions lights), the focus back on what opened
 * the form, and all of it said once. The idea is on the forge whatever happens here, so a failure is said, never thrown.
 */
async function afterIdea(res) {
  const about = ui.idea.node;
  const n = res.body && res.body.number;
  let trouble = '';
  try {
    // The new thread is shown where threads are: an idea opened from Specs goes on to the Threads tab
    if (ui.kind !== 'threads') { ui.kind = 'threads'; ui.actNote = null; ui.filters = defaultFilters('threads'); paintFilters(); }
    ui.lists = {};
    primed.clear(); // the tabs' counts are read again
    indexCache = null;
    await loadList(true, true);
    if (ui.open) primeCounts();
    ensureThreadsList();
    // The new thread is selected in the list, so what it mentions lights on the map once its messages are in
    if (Number.isInteger(n)) await selectThread(n);
  } catch (err) {
    trouble = ` The list could not be read again (${err instanceof Error ? err.message : err}); Refresh asks for it.`;
  }
  // Then the focus goes back to what opened the form: after the selection, which draws the node's panel (and its button) again
  try { focusIdeaOpener(); } catch { /* the page moved on */ }
  ui.idea.opener = '';
  ui.idea.node = null;
  const shown = ui.thread === n && ui.threadDetail && ui.threadDetail.thread ? ` ${threadSelectionWords()}` : ui.thread === n && ui.threadError ? ` ${ui.threadError}` : '';
  // Opened from a node: say that its "Mentioned in" lists the new thread
  const listed = about && (threadsFor(about.id) || []).some((t) => t.number === n);
  announce(`${ui.idea.message}${shown}${listed ? ` It is listed under Threads for ${about.label}.` : ''}${trouble}`);
}

/** The New idea bar and form, from `ui.idea`; typed text and the focus are left alone */
function paintIdea() {
  const bar = $('forge-idea');
  if (!bar) return;
  // An idea is a thread: with threads off (`threads: false`) there is no New idea, on Specs either
  bar.hidden = (ui.kind !== 'threads' && ui.kind !== 'specs') || !!detailKey() || !ui.config || ui.config.threads === false;
  $('idea-open').setAttribute('aria-expanded', String(ui.idea.open));
  $('idea-form').hidden = !ui.idea.open;
  $('idea-send').textContent = ui.idea.busy ? 'Opening …' : 'Open the idea';
  $('idea-send').disabled = ui.idea.busy;
  if (ui.idea.open) {
    const label = (ui.config && ui.config.threads && ui.config.threads.label) || 'idea';
    $('idea-words').textContent = `This opens an issue labelled "${label}" on ${forgeName()}, as you. The conversation lives there; cornfield keeps no copy of it.`;
  }
  const message = $('idea-message');
  message.hidden = !ui.idea.message;
  message.classList.toggle('hx-forge-msg--bad', ui.idea.bad);
  if (ui.idea.bad) message.dataset.cornState = 'failure'; else delete message.dataset.cornState;
  message.textContent = ui.idea.message;
  if (ui.idea.message && ui.idea.link && safeUrl(ui.idea.link)) {
    const link = document.createElement('a');
    link.className = 'hx-link';
    link.href = ui.idea.link;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = `Open it on ${forgeName()} (new tab)`;
    message.append(' ', link);
  }
}

/** What a screen reader hears when a deploy is selected */
function deploySelectionWords(turnedOn = []) {
  const { name, branch } = ui.deployItem;
  const lit = ui.litDeploy;
  const head = `Deploy ${name}${branch ? ` of ${branch}` : ''}, ${deployWords(ui.deployItem).toLowerCase()}`;
  if (!ui.deployItem.restarts.length) return `${head}. No node is mapped to it, so nothing is lit.`;
  const layers = turnedOn.length ? ` Turned on the ${turnedOn.join(' and ')} ${turnedOn.length === 1 ? 'layer' : 'layers'}.` : '';
  return `${head}: ${plural(lit.nodes.length, 'node')} restarted and lit${lit.missing.length ? `, ${lit.missing.length} named that ${lit.missing.length === 1 ? 'is' : 'are'} not on the map` : ''}.${layers}`;
}

/** What a screen reader hears when a pull request is selected */
function selectionWords() {
  const { pull, files, checks } = ui.detail;
  const mapped = ui.lit ? ui.lit.files.filter((f) => f.nodes.length).length : 0;
  const lit = ui.lit ? new Set([...ui.lit.changed, ...ui.lit.failing]).size : 0;
  return `Pull request ${pull.number}, ${pull.title}: ${plural(files.length, 'file')}, ${mapped} on the map${lit ? `, ${plural(lit, 'node')} lit` : ''}. ${checksWords(checks)}.`;
}

// ---------------------------------------------------------------------------
//  Release notes
// ---------------------------------------------------------------------------

/** Loads the draft for the tag chosen (again, past the server's cache, on a refresh) */
async function loadNotes(refresh = false) {
  const token = ++notesToken;
  const n = ui.notes;
  n.loading = true;
  n.error = '';
  n.message = '';
  closeNotesConfirm(false);
  paint();
  const res = await request(notesUrl(n.since), refresh);
  if (token !== notesToken) return;
  n.loading = false;
  if (res.ok) {
    n.data = res.body;
    announce(`Release notes drafted. ${notesSummary(n.data)}${n.data.stale ? ' This is an older answer' : ''}`);
  } else {
    n.error = failWords(res, 'the release notes');
    announce(n.error);
  }
  paint();
}

/** Says something about the last Copy or Post, on the page and to a screen reader */
function say(words, bad = false, link = null) {
  ui.notes.message = words;
  ui.notes.bad = bad;
  ui.notes.link = link;
  paintNotes();
  announce(words);
}

/** Copies the draft: the clipboard, else the text selected for the person to copy */
async function copyNotes() {
  const data = ui.notes.data;
  if (!data) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(data.markdown);
      say('Copied the release notes.');
      return;
    }
  } catch { /* blocked: try the old way */ }
  const area = $('notes-preview');
  area.focus();
  area.select();
  let copied = false;
  try { copied = typeof document.execCommand === 'function' && document.execCommand('copy'); } catch { copied = false; }
  say(copied ? 'Copied the release notes.' : 'Copying was blocked. The draft is selected: press Ctrl+C, or Command+C on a Mac.', !copied);
}

/** The confirm step: what will happen in words, and the tag to ask for (the one the server suggests, to change) */
function openNotesConfirm() {
  const n = ui.notes;
  if (!n.data || n.posting) return;
  if (!n.data.count) { say('There are no merged pull requests to put in a draft.', true); return; }
  n.confirm = true;
  n.message = '';
  $('notes-tag').value = n.data.suggestedTag || '';
  paintNotes();
  $('notes-tag').focus();
  announce('Post as a draft release. Check the tag, then create the draft.');
}

/** Closes the confirm step; the focus goes back to the button that opened it unless told not to */
function closeNotesConfirm(restoreFocus = true) {
  const n = ui.notes;
  if (!n.confirm) return;
  n.confirm = false;
  paintNotes();
  if (restoreFocus) $('notes-post').focus();
}

/** The one write: asks the server to have the forge keep the notes as a draft release for the tag typed */
async function postDraft() {
  const n = ui.notes;
  if (!n.confirm || n.posting || !n.data) return;
  const tag = $('notes-tag').value.trim();
  if (!validTag(tag)) { say('Give the tag the draft is for, like v0.2.0: letters, digits, dots, dashes and slashes, no spaces.', true); $('notes-tag').focus(); return; }
  n.posting = true;
  n.message = '';
  paintNotes();
  announce('Creating the draft release');
  const res = await request(DRAFTS_URL, false, draftRequest(tag, n.since));
  n.posting = false;
  if (res.ok) {
    n.confirm = false;
    say(postedWords({ forge: forgeName(), tag, count: res.body.count }), false, res.body.release && res.body.release.url);
    $('notes-post').focus();
    return;
  }
  say(res.status === 401 ? 'Your sign-in has ended. Sign in again to post a draft.' : failWords(res), true);
  $('notes-tag').focus();
}

/** The Release notes view, from `ui.notes`; the typed tag and the focus are left alone */
function paintNotes() {
  const n = ui.notes;
  const data = n.data;
  const since = $('notes-since');
  // The choices are drawn again only when they change, so the select keeps the focus while a draft is loaded for it
  const choices = (data ? sinceChoices(data) : [['', 'Latest tag']]).map(([v, l]) => option(v, l, false)).join('');
  if (since.dataset.choices !== choices) { since.innerHTML = choices; since.dataset.choices = choices; }
  since.value = n.since;
  const area = $('notes-preview');
  if (area.value !== (data ? data.markdown : '')) area.value = data ? data.markdown : '';
  $('notes-copy').disabled = !data;
  $('notes-post').disabled = !data;
  $('notes-post').setAttribute('aria-expanded', String(n.confirm));
  const confirm = $('notes-confirm');
  confirm.hidden = !n.confirm;
  if (n.confirm && data) {
    $('notes-confirm-words').textContent = confirmWords({ forge: forgeName(), repo: ui.config.forge.repo, tag: '', count: data.count });
    $('notes-confirm-yes').textContent = n.posting ? 'Creating …' : 'Create the draft';
  }
  const message = $('notes-message');
  message.hidden = !n.message;
  message.classList.toggle('hx-forge-msg--bad', n.bad);
  if (n.bad) message.dataset.cornState = 'failure'; else delete message.dataset.cornState;
  message.textContent = n.message;
  if (n.message && n.link && safeUrl(n.link)) {
    const link = document.createElement('a');
    link.className = 'hx-link';
    link.href = n.link;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = `Open the draft on ${forgeName()} (new tab)`;
    message.append(' ', link);
  }
}

// ---------------------------------------------------------------------------
//  Drawing
// ---------------------------------------------------------------------------

const option = (value, label, on) => `<option value="${escHtml(value)}"${on ? ' selected' : ''}>${escHtml(label)}</option>`;

/** Whether the Filter chip applies to the view: the proposals and the release notes have nothing to filter */
const filterable = () => ui.kind !== 'specs' && ui.kind !== 'notes';

/** How many filters are on: a state other than the default, a label, an author, a search; on Runs, its two checkboxes */
function activeFilters() {
  if (ui.kind === 'work') return Number(ui.workFilters.agentsOnly) + Number(ui.workFilters.finished);
  if (!filterable()) return 0;
  const f = ui.filters;
  return Number(f.state !== defaultFilters(ui.kind).state) + Number(!!f.label) + Number(!!f.author) + Number(!!f.text);
}

/** The Filter chip, its count, and the box behind it */
function paintChip() {
  const chip = $('forge-filter-chip');
  const box = $('forge-filter-box');
  const on = filterable() && !detailKey();
  const n = activeFilters();
  chip.hidden = !on;
  chip.setAttribute('aria-expanded', String(on && ui.filtersOpen));
  chip.setAttribute('aria-label', n ? `Filter, ${plural(n, 'filter')} on` : 'Filter');
  const count = chip.querySelector('.hx-forge-count');
  count.hidden = !n;
  count.textContent = String(n);
  chip.classList.toggle('is-on', n > 0);
  box.hidden = !(on && ui.filtersOpen);
}

/** The filters' choices: the states of the kind, the labels and authors of what is loaded */
function paintFilters() {
  $('forge-filters').hidden = ui.kind === 'work' || !filterable();
  $('forge-work-filters').hidden = ui.kind !== 'work';
  $('forge-work-agents').checked = ui.workFilters.agentsOnly;
  $('forge-work-finished').checked = ui.workFilters.finished;
  if (ui.kind === 'work' || !filterable()) return;
  const items = current() && ui.kind !== 'deploys' ? current().items : [];
  const { labels, authors } = facetsOf(items);
  if (ui.filters.label && !labels.includes(ui.filters.label)) ui.filters.label = '';
  if (ui.filters.author && !authors.includes(ui.filters.author)) ui.filters.author = '';
  $('forge-state').innerHTML = STATES[ui.kind].map(([v, l]) => option(v, l, v === ui.filters.state)).join('');
  $('forge-label').innerHTML = option('', 'Any label', !ui.filters.label) + labels.map((l) => option(l, l, l === ui.filters.label)).join('');
  $('forge-author').innerHTML = option('', 'Anyone', !ui.filters.author) + authors.map((a) => option(a, a, a === ui.filters.author)).join('');
  // A deploy has no labels and no author to pick: its list is filtered by state and the search
  $('forge-label').parentElement.hidden = ui.kind === 'deploys' || ui.kind === 'threads';
  $('forge-author').parentElement.hidden = ui.kind === 'deploys';
  // …and its search reads the workflow, what it ran for, the branch and who started it, not a number or a label
  $('forge-text').placeholder = ui.kind === 'deploys' ? 'Workflow, branch, commit, who' : ui.kind === 'threads' ? 'Title, number, author' : 'Title, number, label';
}

/** What a deploy lights, said short, for its row: how many nodes, or that it is not mapped */
function lightsWords(deploy) {
  if (!deploy.restarts.length) return 'Not mapped to a node';
  const { nodes } = nodesForRestarts(deploy.restarts, state.nodes);
  return nodes.length ? `Lights ${plural(nodes.length, 'node')}` : 'Names nodes not on the map';
}

function deployHtml(d) {
  const link = safeUrl(d.url);
  const out = link ? `<a class="hx-forge-out" href="${escHtml(link)}" target="_blank" rel="noreferrer" aria-label="Open deploy ${escHtml(d.name)} on ${escHtml(forgeName())} (new tab)">↗</a>` : '';
  return `<li class="hx-forge-item"><button type="button" class="hx-forge-row" data-forge-deploy="${escHtml(d.id)}" aria-pressed="${ui.deploy === d.id}" data-corn="row">
    <span class="hx-forge-title">${escHtml(d.name)}${d.title && d.title !== d.name ? `<span class="hx-faint"> · ${escHtml(d.title)}</span>` : ''}</span>
    <span class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(d.state)}" data-corn="state-pill"${cornStateAttr(d.state)}>${stateIconHtml(d.state)}${escHtml(deployWords(d))}</span> ${escHtml(deployMeta(d, now()))}</span>
    <span class="hx-forge-labels"><span class="hx-forge-label">${escHtml(lightsWords(d))}</span></span></button>${out}</li>`;
}

/** One thread in the list: a row that opens it, and a link out to the forge */
function threadHtml(t) {
  const link = safeUrl(t.url);
  const out = link ? `<a class="hx-forge-out" href="${escHtml(link)}" target="_blank" rel="noreferrer" aria-label="Open thread ${t.number} on ${escHtml(forgeName())} (new tab)">↗</a>` : '';
  const note = [t.proposals && t.proposals.length ? `Proposal ${t.proposals.map((p) => p.slug).join(', ')}` : '', t.idea ? `Idea #${t.idea}` : ''].filter(Boolean).join(' · ');
  // The run that is about this thread, as a word (issue #104): the Agents tab's list, read for every tab, says it; the row only names its state
  const runs = ui.runs && ui.runs.data ? ui.runs.data.runs : null;
  const run = runOnThread(runs, t.number);
  const runWord = run ? `${runPillHtml({ esc: escHtml }, run, threadRunWords(runs, t.number), ` data-thread-run="${escHtml(run.runId)}"`)} ` : '';
  return `<li class="hx-forge-item"><button type="button" class="hx-forge-row" data-forge-thread="${t.number}" aria-pressed="${ui.thread === t.number}" data-corn="row">
    <span class="hx-forge-title">${escHtml(t.title)}</span>
    <span class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(t.state)}" data-corn="state-pill"${cornStateAttr(t.state)}>${escHtml(t.state === 'open' ? 'Open' : 'Closed')}</span> ${runWord}<span class="hx-forge-label">${escHtml(threadKindWords(t))}</span> ${escHtml(threadMeta(t, now()))}</span>${note ? `<span class="hx-forge-meta">${escHtml(note)}</span>` : ''}</button>${out}</li>`;
}

function itemHtml(item, before = '', after = '') {
  if (ui.kind === 'deploys') return deployHtml(item);
  if (ui.kind === 'threads') return threadHtml(item);
  const link = safeUrl(item.url);
  const labels = item.labels.length ? `<span class="hx-forge-labels">${item.labels.map((l) => `<span class="hx-forge-label">${escHtml(l)}</span>`).join('')}</span>` : '';
  const inner = `<span class="hx-forge-title">${escHtml(item.title)}</span>
    <span class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(item.draft ? 'draft' : item.state)}" data-corn="state-pill"${cornStateAttr(item.draft ? 'draft' : item.state)}>${escHtml(stateWords(item))}</span> ${escHtml(metaWords(item, now()))}</span>${before}${after}${labels}`;
  const out = link ? `<a class="hx-forge-out" href="${escHtml(link)}" target="_blank" rel="noreferrer" aria-label="Open ${escHtml(item.head ? 'pull request' : 'issue')} ${item.number} on ${escHtml(forgeName())} (new tab)">↗</a>` : '';
  if (ui.kind !== 'issues') {
    return `<li class="hx-forge-item"><button type="button" class="hx-forge-row" data-forge-pr="${item.number}" aria-pressed="${ui.selected === item.number}" data-corn="row">${inner}</button>${out}</li>`;
  }
  // An issue has no more to show here: its row is the link out; an open one also starts its spec (step 1 of the pipeline)
  const spec = specBlock(item) === null
    ? `<button type="button" class="hx-btn hx-forge-act hx-forge-startspec" data-forge-spec="${item.number}" aria-label="Start a spec for issue ${item.number}"${ui.busy ? ' disabled' : ''}>Start a spec …</button>`
    : '';
  const agent = item.state === 'open'
    ? `<button type="button" class="hx-btn hx-forge-act hx-forge-startspec" data-forge-agent="issue:${item.number}" aria-label="${escHtml(t('startAgent'))} on issue ${item.number}">${escHtml(t('startAgent'))} …</button>`
    : '';
  return link
    ? `<li class="hx-forge-item"><a class="hx-forge-row" href="${escHtml(link)}" target="_blank" rel="noreferrer" data-corn="row">${inner}<span class="hx-sr-only"> (opens ${escHtml(forgeName())} in a new tab)</span></a>${spec}${agent}</li>`
    : `<li class="hx-forge-item"><div class="hx-forge-row" data-corn="row">${inner}</div>${spec}${agent}</li>`;
}

/** One piece of work in a group: a pull request (a row that selects it, as in the Pull requests tab) or a branch with none */
function workHtml(e) {
  const mark = e.mark ? `<span class="hx-forge-agentline"><span class="hx-forge-agent" title="Agent-made: ${escHtml(markWords(e.mark))}" data-corn="badge">Agent</span><span class="hx-forge-why hx-faint">${escHtml(markWords(e.mark))}</span></span>` : '';
  if (e.type === 'pull') {
    const also = e.issues.slice(1);
    const note = [e.proposal ? `Spec PR for ${e.proposal}` : '', also.length ? `Also closes ${also.map((n) => `#${n}`).join(', ')}` : ''].filter(Boolean);
    return itemHtml(e.pull, mark, note.length ? `<span class="hx-forge-meta">${escHtml(note.join(' · '))}</span>` : '');
  }
  return `<li class="hx-forge-item"><div class="hx-forge-row hx-forge-branch" data-corn="row"><span class="hx-forge-title"><span class="hx-sr-only">Branch </span><code class="hx-code">${escHtml(e.branch.name)}</code></span><span class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--draft" data-corn="state-pill" data-corn-state="draft">Branch</span> no pull request yet</span>${mark}</div></li>`;
}

/** The Agents tab's groups, each a heading and its work */
function groupsHtml(groups) {
  return groups.map((g, i) => {
    const link = g.issue && safeUrl(g.issue.url) ? ` <a class="hx-link hx-forge-gout" href="${escHtml(g.issue.url)}" target="_blank" rel="noreferrer" aria-label="Open issue ${g.number} on ${escHtml(forgeName())} (new tab)">↗</a>` : '';
    const startRef = g.kind === 'issue' && g.issue && g.issue.state === 'open' ? `issue:${g.number}` : g.kind === 'proposal' ? `proposal:${g.slug}` : null;
    const start = startRef ? ` <button type="button" class="hx-btn hx-forge-act" data-forge-agent="${escHtml(startRef)}" aria-label="${escHtml(t('startAgent'))} on ${escHtml(g.kind === 'issue' ? `issue ${g.number}` : `proposal ${g.slug}`)}">${escHtml(t('startAgent'))} …</button>` : '';
    return `<li class="hx-forge-group"><h3 class="hx-forge-gtitle" id="forge-group-${i}">${escHtml(g.title)}${link}</h3>${start}<p class="hx-forge-meta">${escHtml(groupWords(g))}</p><ul class="hx-forge-list" aria-labelledby="forge-group-${i}">${g.entries.map(workHtml).join('')}</ul></li>`;
  }).join('');
}

/** Which selection replaces the list now, as a key ('pr:12', 'thread:3', 'deploy:9004'), or '' while the list shows. A selection stays lit on the map but shows only on the tab it belongs to. */
function detailKey() {
  if (ui.kind === 'threads' && ui.thread !== null) return `thread:${ui.thread}`;
  if (ui.kind === 'deploys' && ui.deployItem) return `deploy:${ui.deploy}`;
  if (ui.selected !== null && ui.kind === ui.selectedOn) return `pr:${ui.selected}`;
  return '';
}

/** The back control of a detail: an arrow and the name of the list it returns to ("All pull requests") */
const backHtml = (action, words) => `<button type="button" class="hx-forge-back" data-action="${action}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg><span class="hx-forge-back-text">${escHtml(words)}</span></button>`;

/** The selected deploy: what it was, and the nodes it restarted (each a button that selects it on the map) */
function deployDetailHtml() {
  const d = ui.deployItem;
  const lit = ui.litDeploy;
  const url = safeUrl(d.url);
  const head = `${backHtml('clear-forge-deploy', 'All deploys')}<h3 class="hx-forge-detail-title">${escHtml(d.name)}</h3>
    <p class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(d.state)}" data-corn="state-pill"${cornStateAttr(d.state)}>${stateIconHtml(d.state)}${escHtml(deployWords(d))}</span> ${escHtml(deployMeta(d, now()))}${url ? ` · <a class="hx-link" href="${escHtml(url)}" target="_blank" rel="noreferrer">Open on ${escHtml(forgeName())} ↗</a>` : ''}</p>`;
  const stale = ui.lists.deploys && ui.lists.deploys.stale;
  let body;
  if (!d.restarts.length) {
    body = '<p class="hx-forge-notice" data-corn="notice">No node is mapped to this deploy, so nothing is lit. Say what it restarts under <code class="hx-code">deploys.restarts</code> in cornfield.config.js (docs/deploys.md).</p>';
  } else {
    const rows = lit.nodes.map((n) => `<li class="hx-forge-file"><button type="button" class="hx-forge-node" data-forge-node="${escHtml(n.id)}" aria-label="Show ${escHtml(n.label)} on the map${isNodeVisible(n) ? '' : ' (its layer is off)'}">${escHtml(n.label)}${isNodeVisible(n) ? '' : ' · layer off'}</button> <span class="hx-faint">${escHtml(n.type)}</span></li>`).join('');
    const missing = lit.missing.length ? `<p class="hx-forge-notice" data-corn="notice">${escHtml(lit.missing.join(', '))} ${lit.missing.length === 1 ? 'is' : 'are'} named in the config but not on the map.</p>` : '';
    const key = lit.nodes.length ? `<p class="hx-forge-key hx-faint"><span class="hx-mark-dot hx-mark-dot--${d.state === 'failure' ? 'removed' : 'changed'}" aria-hidden="true"></span>${d.state === 'failure' ? 'restarted by a deploy that failed' : 'restarted by this deploy'}</p>` : '';
    body = `<h4 class="hx-forge-sub">${escHtml(`Restarted: ${plural(lit.nodes.length, 'node')} on the map`)}</h4>${key}${rows ? `<ul class="hx-forge-files">${rows}</ul>` : ''}${missing}`;
  }
  return `${head}${stale ? `<p class="hx-forge-notice" data-corn="notice">${escHtml(`This is an older answer. ${stale}`)}</p>` : ''}${body}`;
}

/** A node button, as in a pull request's files: it selects the node on the map */
const nodeButton = (n) => `<button type="button" class="hx-forge-node" data-forge-node="${escHtml(n.id)}" aria-label="Show ${escHtml(n.label)} on the map${isNodeVisible(n) ? '' : ' (its layer is off)'}">${escHtml(n.label)}${isNodeVisible(n) ? '' : ' · layer off'}</button>`;

/** The selected thread: read-only, its messages as written, a way to reply on the forge, and the nodes its text lights */
function threadDetailHtml() {
  const head = (title) => `${backHtml('clear-forge-thread', 'All threads')}<h3 class="hx-forge-detail-title">${title}</h3>`;
  if (ui.threadError) return `${head(`Thread ${ui.thread}`)}<p class="hx-forge-notice" data-corn="notice">${escHtml(ui.threadError)}</p>`;
  if (!ui.threadDetail) return `${head(`Thread ${ui.thread}`)}<p class="hx-faint">Loading its messages …</p>`;
  const { thread: t, stale } = ui.threadDetail;
  const lit = ui.litThread;
  const url = safeUrl(t.url);
  const reply = url ? `<a class="hx-link" href="${escHtml(url)}" target="_blank" rel="noreferrer">Reply on ${escHtml(forgeName())} (new tab)</a>` : '';
  const named = [
    ...(t.proposals || []).map((p) => `Proposal <code class="hx-code">${escHtml(p.slug)}</code> in pull request #${p.pull}`),
    ...(t.kind === 'proposal' ? [`Spec pull request for <code class="hx-code">${escHtml((t.slugs || []).join(', '))}</code>`] : []),
    ...(t.idea ? [`Names idea #${t.idea}`] : []),
  ];
  const msgs = t.messages.map((m) => {
    const own = lit.perMessage.get(m.id) || { nodes: [], unresolved: [] };
    const link = safeUrl(m.url) ? ` <a class="hx-link" href="${escHtml(m.url)}" target="_blank" rel="noreferrer" aria-label="Open this message on ${escHtml(forgeName())} (new tab)">↗</a>` : '';
    const chips = own.nodes.length || own.unresolved.length
      ? `<span class="hx-forge-nodes hx-thread-nodes">${own.nodes.map(nodeButton).join('')}${own.unresolved.length ? `<span class="hx-faint">not on the map: ${own.unresolved.map((r) => `<code class="hx-code">${escHtml(r)}</code>`).join(' ')}</span>` : ''}</span>`
      : '';
    return `<li class="hx-thread-msg"><p class="hx-forge-meta"><strong class="hx-strong">${escHtml(m.author ? m.author.login : 'someone')}</strong>${m.opening ? ' opened this' : ''} · ${escHtml(relativeTime(m.createdAt, now()))}${link}</p><p class="hx-thread-body">${escHtml(m.body.trim() === '' ? '(no text)' : m.body)}${m.cut ? '\n… (cut here; the rest is on the forge)' : ''}</p>${chips}</li>`;
  }).join('');
  const key = lit.nodes.length ? `<p class="hx-forge-key hx-faint"><span class="hx-mark-dot hx-mark-dot--changed" aria-hidden="true"></span>a node this thread mentions</p>` : '';
  return `${head(`#${t.number} ${escHtml(t.title)}`)}
    <p class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(t.state)}" data-corn="state-pill"${cornStateAttr(t.state)}>${t.state === 'open' ? 'Open' : 'Closed'}</span> ${escHtml(threadKindWords(t))} · ${escHtml(threadMeta({ ...t, comments: t.messages.length - (t.kind === 'idea' ? 1 : 0) + (t.hidden || 0) }, now()))}</p>
    <p class="hx-forge-why hx-faint">Read-only here: a thread is a conversation on ${escHtml(forgeName())}, so you reply there. ${reply}</p>
    ${named.length ? `<p class="hx-forge-meta">${named.join(' · ')}</p>` : ''}
    ${stale ? `<p class="hx-forge-notice" data-corn="notice">${escHtml(`This is an older answer. ${stale}`)}</p>` : ''}
    <h4 class="hx-forge-sub">${escHtml(`Mentions: ${plural(lit.nodes.length, 'node')} on the map`)}</h4>
    ${key}
    ${lit.nodes.length ? `<span class="hx-forge-nodes hx-thread-nodes">${lit.nodes.map(nodeButton).join('')}</span>` : '<p class="hx-faint">No message mentions a node. Write [[node-id]] or [[repo/path]] in a message to point at the map.</p>'}
    ${lit.unresolved.length ? `<p class="hx-forge-notice" data-corn="notice">${escHtml(lit.unresolved.join(', '))} ${lit.unresolved.length === 1 ? 'is' : 'are'} mentioned but not on the map, so ${lit.unresolved.length === 1 ? 'it stays' : 'they stay'} text.</p>` : ''}
    <h4 class="hx-forge-sub">${escHtml(plural(t.messages.length, 'message'))}</h4>
    ${t.hidden ? `<p class="hx-forge-why hx-faint">${escHtml(plural(t.hidden, 'earlier message'))} not shown; they are on ${escHtml(forgeName())}.</p>` : ''}
    <ol class="hx-thread-msgs" aria-label="Messages">${msgs}</ol>`;
}

function detailHtml() {
  const shown = detailKey();
  if (shown.startsWith('thread:')) return threadDetailHtml();
  if (shown.startsWith('deploy:')) return deployDetailHtml();
  if (!shown) return '';
  const head = (title, meta) => `${backHtml('clear-forge-pr', ui.kind === 'work' ? 'All work' : 'All pull requests')}${meta || ''}<h3 class="hx-forge-detail-title">${title}</h3>`;
  if (ui.detailError) return `${head(`Pull request ${ui.selected}`)}<p class="hx-forge-notice" data-corn="notice">${escHtml(ui.detailError)}</p>`;
  if (!ui.detail) return `${head(`Pull request ${ui.selected}`)}<p class="hx-faint">Loading its files and checks …</p><ul class="hx-forge-list" aria-hidden="true">${loadingRowsHtml(4)}</ul>`;
  const { pull, checks, stale } = ui.detail;
  const lit = ui.lit;
  const mapped = lit.files.filter((f) => f.nodes.length).length;
  const url = safeUrl(pull.url);
  const failing = new Map(lit.checks.map((c) => [c.check.id, c]));

  const checkRows = checks.map((c) => {
    const failed = failing.get(c.id);
    const lights = failed
      ? `<span class="hx-faint hx-forge-lights">${failed.tests.length
        ? `Lights ${failed.tests.map((t) => `<code class="hx-code">${escHtml(t.path)}</code>${t.nodes.length ? '' : ' (not on the map)'}`).join(', ')}`
        : 'Names no test file, so lights nothing'}</span>`
      : '';
    const name = safeUrl(c.url) ? `<a class="hx-link" href="${escHtml(c.url)}" target="_blank" rel="noreferrer">${escHtml(c.name)}</a>` : `<span class="hx-name">${escHtml(c.name)}</span>`;
    const why = rerunWhy(c, forgeName());
    const again = c.state === 'failure' && c.canRerun
      ? `<button type="button" class="hx-btn hx-forge-act" data-forge-rerun="${escHtml(c.id)}" aria-label="Re-run ${escHtml(c.name)}"${ui.busy ? ' disabled' : ''}>Re-run</button>`
      : '';
    const whyNot = why ? `<span class="hx-faint hx-forge-lights">${escHtml(why)}</span>` : '';
    return `<li class="hx-forge-check"><span class="hx-forge-state hx-forge-state--${escHtml(c.state)}" data-corn="state-pill"${cornStateAttr(c.state)}>${stateIconHtml(c.state)}${escHtml(checkWords(c))}</span> ${name}${again}${lights}${whyNot}</li>`;
  }).join('');

  const fileRows = lit.files.map((f) => {
    const nodes = f.nodes.length
      ? f.nodes.map((n) => `<button type="button" class="hx-forge-node" data-forge-node="${escHtml(n.id)}" aria-label="Show ${escHtml(n.label)} on the map${isNodeVisible(n) ? '' : ' (its layer is off)'}">${escHtml(n.label)}${isNodeVisible(n) ? '' : ' · layer off'}</button>`).join('')
      : '<span class="hx-faint">not on the map</span>';
    const renamed = f.status === 'renamed' && f.previousPath ? `<span class="hx-faint"> from ${escHtml(f.previousPath)}</span>` : '';
    return `<li class="hx-forge-file"><span class="hx-forge-fstatus">${escHtml(f.status)}</span> <code class="hx-code">${escHtml(f.path)}</code>${renamed} <span class="hx-good">+${f.additions}</span> <span class="hx-forge-del">−${f.deletions}</span><span class="hx-forge-nodes">${nodes}</span></li>`;
  }).join('');

  // Land it is the one primary action, with Open on the forge beside it; a pull request that cannot land says why in one line
  const block = mergeBlock(ui.detail);
  const land = block
    ? `<button type="button" class="hx-btn hx-btn--approve" disabled data-corn-kind="approve">${escHtml(t('landIt'))}</button>`
    : `<button type="button" class="hx-btn hx-btn--approve hx-forge-act" data-forge-merge="${escHtml(String(pull.number))}"${ui.busy ? ' disabled' : ''} data-corn-kind="approve">${escHtml(t('landIt'))} …</button>`;
  const act = `<div class="hx-forge-cta">${land}${url ? `<a class="hx-btn hx-forge-open" href="${escHtml(url)}" target="_blank" rel="noreferrer">Open on ${escHtml(forgeName())} ↗</a>` : ''}</div>${block ? `<p class="hx-forge-why hx-faint">${escHtml(block)}</p>` : ''}${approvalWarning(ui.detail) ? `<p class="hx-forge-why hx-faint" data-corn="notice" data-corn-state="waiting">${escHtml(approvalWarning(ui.detail))}</p>` : ''}`;
  // A spec approved with `proposals.approveLands` waits for its checks: said here, with a way to stop it
  const waiting = ui.landing && pull.state === 'open'
    ? `<div class="hx-forge-step"><p class="hx-forge-notice hx-forge-notice--ok" role="status" data-corn="notice" data-corn-state="success">${escHtml(landingWords(ui.landing, now()))}</p><button type="button" class="hx-btn hx-forge-act" data-forge-landing-cancel="${pull.number}"${ui.busy ? ' disabled' : ''}>Cancel</button></div>`
    : '';
  const note = ui.note ? `<p class="hx-forge-notice${ui.note.ok ? ' hx-forge-notice--ok' : ''}" data-corn="notice"${ui.note.ok ? ' data-corn-state="success"' : ''}>${escHtml(ui.note.text)}</p>` : '';
  // Step 2 of the pipeline: a spec pull request with an approved proposal opens its build issue
  const offers = buildOffers(ui.detail);
  const build = offers.length
    ? `<h4 class="hx-forge-subact">Build issue</h4>${offers.map((o) => (o.offer
      ? `<div class="hx-forge-step"><button type="button" class="hx-btn hx-btn--approve hx-forge-act" data-forge-build="${escHtml(o.slug)}" aria-label="Open the build issue for ${escHtml(o.slug)}"${ui.busy ? ' disabled' : ''} data-corn-kind="approve">Open the build issue …</button><p class="hx-forge-why hx-faint"><code class="hx-code">${escHtml(o.slug)}</code> is approved. Opens a confirm step that shows the issue. Nothing is built.</p></div>`
      : `<p class="hx-forge-why hx-faint"><code class="hx-code">${escHtml(o.slug)}</code>: ${escHtml(o.why)}</p>`)).join('')}`
    : '';

  const key = lit.changed.size || lit.failing.size
    ? `<p class="hx-forge-key hx-faint">${lit.changed.size ? '<span class="hx-mark-dot hx-mark-dot--changed" aria-hidden="true"></span>a file this pull request changes ' : ''}${lit.failing.size ? '<span class="hx-mark-dot hx-mark-dot--removed" aria-hidden="true"></span>a test a failing check names' : ''}</p>`
    : '';
  // Its run: who is running it, their state, the time and the cost (the runs are read for the Runs tab, and once for the first PR selected)
  const runs = ui.runs && ui.runs.data ? ui.runs.data.runs : null;
  const made = runOnPull(runs, pull.number);
  const runSection = made
    ? `<h4 class="hx-forge-sub">Run</h4><p class="hx-forge-runline"${cornStateAttr(made.status)} data-corn="run">${runPillHtml({ esc: escHtml }, made, statusWords(made))} ${escHtml(pullRunWords(made, now(), { state: false }))}</p>`
    : '';
  const meta = `<p class="hx-forge-meta hx-forge-dmeta"><span class="hx-forge-state hx-forge-state--${escHtml(pull.draft ? 'draft' : pull.state)}" data-corn="state-pill"${cornStateAttr(pull.draft ? 'draft' : pull.state)}>${escHtml(stateWords(pull))}</span> <span data-corn="count">#${escHtml(String(pull.number))}</span> <span>${escHtml(pull.head.ref)} → ${escHtml(pull.base.ref)}</span> <span>${escHtml(pull.author ? pull.author.login : 'someone')}</span> <span>${escHtml(relativeTime(pull.createdAt || pull.updatedAt, now()))}</span></p>`;
  return `${head(escHtml(pull.title), meta)}
    ${act}
    ${stale ? `<p class="hx-forge-notice" data-corn="notice">${escHtml(`This is an older answer. ${stale}`)}</p>` : ''}
    ${note}
    ${waiting}
    ${build}
    <h4 class="hx-forge-sub">Checks: ${escHtml(checksWords(checks))}</h4>
    ${checks.length ? `<ul class="hx-forge-checks">${checkRows}</ul>` : ''}
    <h4 class="hx-forge-sub">${escHtml(plural(lit.files.length, 'file'))} changed, ${mapped} on the map</h4>
    ${key}
    <ul class="hx-forge-files">${fileRows}</ul>
    ${runSection}`;
}

/** How to find an element of the panel again after it is drawn anew, or null */
function findAgain(el) {
  if (!el || !el.dataset) return null;
  if (el.classList.contains('hx-forge-back') && el.closest('#forge-detail')) return '#forge-detail .hx-forge-back'; // the detail is drawn anew as its answer comes in
  if (el.dataset.forgePr) return `[data-forge-pr="${el.dataset.forgePr}"]`;
  if (el.dataset.forgeDeploy) return `[data-forge-deploy="${el.dataset.forgeDeploy}"]`;
  if (el.dataset.forgeThread) return `[data-forge-thread="${el.dataset.forgeThread}"]`;
  if (el.dataset.forgeNode) return `[data-forge-node="${el.dataset.forgeNode}"]`;
  if (el.dataset.forgeMerge) return '[data-forge-merge]';
  if (el.dataset.forgeSpec) return `[data-forge-spec="${el.dataset.forgeSpec}"]`;
  if (el.dataset.forgeBuild) return `[data-forge-build="${el.dataset.forgeBuild}"]`;
  if (el.dataset.forgeRerun) return `[data-forge-rerun="${el.dataset.forgeRerun}"]`;
  if (el.dataset.forgeAgent) return `[data-forge-agent="${el.dataset.forgeAgent}"]`;
  if (el.dataset.forgeStop) return `[data-forge-stop="${el.dataset.forgeStop}"]`;
  if (el.dataset.forgeRetry) return `[data-forge-retry="${el.dataset.forgeRetry}"]`;
  if (el.dataset.runReply) return `[data-run-reply="${el.dataset.runReply}"]`;
  if (el.dataset.runAnswer) return `[data-run-answer="${el.dataset.runAnswer}"][data-run-id="${el.dataset.runId}"]`;
  if (el.dataset.runSelect) return `[data-run-select="${el.dataset.runSelect}"]`;
  if (el.dataset.runTimeline) return `[data-run-timeline="${el.dataset.runTimeline}"]`;
  return null;
}

/** What the focus does when a selection replaces the list, and when it goes back: the key of the selection shown at the last paint, and the tab it was on */
let shownKey = '';
let shownKind = '';
let returnTo = null; // the selector of the row that opened the selection

const key0 = () => detailKey();

/** Everything the panel shows, from `ui` (a row or node button that had the focus has it again) */
function paint() {
  const panel = $('forge-panel');
  if (!panel) return;
  const had = panel.contains(document.activeElement) ? document.activeElement : null;
  const again = had ? findAgain(had) : null;
  // A list drawn again must not move what the person is looking at: the scroll of the panel stays where it was
  const scroller = panel.querySelector('.hx-forge-body');
  const scrolled = scroller ? scroller.scrollTop : 0;
  const keyBefore = shownKey;
  draw(panel);
  if (scroller && scrolled && key0() === keyBefore && scroller.scrollTop !== scrolled) scroller.scrollTop = scrolled;
  const back = again && panel.querySelector(again);
  if (back && back !== document.activeElement && !back.closest('[hidden]')) back.focus();
  // Retry was pressed and its notice is gone (the list is being read again): the focus goes to the panel's title, never to the page
  if (had && had.dataset && had.dataset.action === 'retry-forge' && !panel.contains(document.activeElement)) $('forge-title').focus();
  // A control of a run card that is no longer drawn (the run went on): the focus goes to that run's card, never to the page
  const hadRun = had && !had.isConnected && had.closest('[data-run]');
  if (hadRun && !panel.contains(document.activeElement)) {
    const card = [...panel.querySelectorAll('[data-run]')].find((c) => c.dataset.run === hadRun.dataset.run);
    if (card) card.focus();
  }
  // A selection replaces the list: the focus goes to its back control, and returns to the row when it is let go of
  // (a tab changed leaves the focus on the tab)
  const key = detailKey();
  if (key !== shownKey && shownKind === ui.kind) {
    if (key) {
      const target = panel.querySelector('#forge-detail .hx-forge-back');
      if (target && (had || !shownKey)) target.focus();
    } else {
      const row = returnTo && panel.querySelector(returnTo);
      if (row && !row.closest('[hidden]')) row.focus(); else $('forge-title').focus();
      returnTo = null;
    }
  }
  shownKey = key;
  shownKind = ui.kind;
}

/** The tabs' counts, where there is one: the proposals, the open pull requests and issues and threads, the runs still open */
function paintCounts() {
  const open = (key) => (ui.lists[key] ? ui.lists[key].items.length : null);
  const specs = specsList() && specsList().items;
  const runs = ui.runs && ui.runs.data ? ui.runs.data.open : null;
  const counts = { specs: specs ? specs.length : null, pulls: open('pulls|open'), issues: open('issues|open'), threads: ui.config && ui.config.threads === false ? null : open('threads|open'), work: runs };
  for (const btn of document.querySelectorAll('#forge-panel [data-forge-kind]')) {
    const n = counts[btn.dataset.forgeKind];
    const el = btn.querySelector('.hx-forge-count');
    if (!el) continue;
    el.hidden = !n;
    el.textContent = n ? String(n) : '';
  }
}

/** Says (on the panel's top, for the CSS) that the tabs run on past an edge: a fade shows on that side, so Deploys is not simply missing on a phone */
function paintTabsMore() {
  const top = document.querySelector('#forge-panel .hx-forge-top');
  const tabs = top && top.querySelector('.hx-forge-tabs');
  if (!tabs) return;
  const more = [];
  if (tabs.scrollLeft > 1) more.push('start');
  if (tabs.scrollWidth - tabs.clientWidth - tabs.scrollLeft > 1) more.push('end');
  if (more.length) top.dataset.more = more.join(' '); else delete top.dataset.more;
  // A row given the focus is scrolled clear of the fixed top, never left under it (its height changes with the theme and the width)
  const body = top.parentElement;
  if (body) body.style.scrollPaddingTop = `${top.offsetHeight}px`;
}

/** A notice line: its words, and a Retry that reads the tab again (for a failure or an older answer) */
function setNotice(el, words, retry) {
  el.hidden = !words;
  el.textContent = words;
  if (words && retry) {
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'hx-btn hx-forge-act';
    again.dataset.action = 'retry-forge';
    again.dataset.cornKind = 'quiet';
    again.textContent = 'Retry';
    el.append(' ', again);
  }
}

function draw(panel) {
  for (const btn of panel.querySelectorAll('[data-forge-kind]')) btn.setAttribute('aria-pressed', String(btn.dataset.forgeKind === (ui.kind === 'notes' ? 'pulls' : ui.kind)));
  paintCounts();
  const notes = ui.kind === 'notes';
  const specs = ui.kind === 'specs';
  const showing = detailKey();
  $('forge-filters').hidden = notes || ui.kind === 'work' || specs;
  $('forge-work-filters').hidden = ui.kind !== 'work';
  $('forge-bar').hidden = !!showing;
  paintChip();
  $('forge-list').hidden = notes || !!showing;
  $('forge-notes').hidden = !notes;
  $('notes-open').hidden = ui.kind !== 'pulls' || !!showing;
  $('forge-foot').hidden = notes || !!showing;
  if (notes) {
    drawNotes();
    return;
  }

  const list = current();
  const work = ui.kind === 'work';
  const groups = work ? groupsShown() : [];
  const shown = list && !work && !specs ? filterItems(list.items, ui.kind, ui.filters) : [];
  const status = $('forge-status');
  if (ui.loading && !list) status.textContent = work ? `Loading the work from ${forgeName()} …` : specs ? 'Looking for proposals …' : `Loading ${kindWords()}s from ${forgeName()} …`;
  else if (!list) status.textContent = '';
  else if (work) status.textContent = workStatus(groups, list.at, now());
  else if (specs) status.textContent = `${plural(list.items.length, 'proposal')}${list.at ? `, as of ${relativeTime(list.at, now())}` : ''}`;
  else status.textContent = `${shown.length} of ${plural(list.items.length, kindWords())}${list.at ? `, as of ${relativeTime(list.at, now())}` : ''}`;

  const notice = $('forge-notice');
  const words = ui.error || (list && list.stale ? `Showing an older answer. ${list.stale}` : '') || (specs && list && list.problem ? `The spec PRs could not be listed: ${list.problem}` : '') || (work && list && list.problem ? `Spec pull requests could not all be read: ${list.problem}` : '') || (ui.kind === 'threads' && list && list.problem ? `Some threads could not all be read: ${list.problem}` : '');
  setNotice(notice, words, !!words);

  const act = $('forge-act-note');
  if (act) {
    act.hidden = !ui.actNote;
    const link = ui.actNote && safeUrl(ui.actNote.url);
    act.className = `hx-forge-notice${ui.actNote && ui.actNote.ok ? ' hx-forge-notice--ok' : ''}`;
    if (ui.actNote && ui.actNote.ok) act.dataset.cornState = 'success'; else delete act.dataset.cornState;
    act.innerHTML = ui.actNote ? `${escHtml(ui.actNote.text)}${link ? ` <a class="hx-link" href="${escHtml(link)}" target="_blank" rel="noreferrer">Open on ${escHtml(forgeName())} ↗</a>` : ''}` : '';
  }

  const rows = $('forge-list');
  const empty = (words) => `<li class="hx-forge-empty hx-faint" data-corn="empty">${escHtml(words)}</li>`;
  rows.setAttribute('aria-busy', String(!!ui.loading && !list));
  // A list that is being read holds its height with rows of the right size, so nothing jumps when the data comes
  if (!list) rows.innerHTML = ui.loading ? loadingRowsHtml(4) : '';
  else if (specs) {
    const open = state.proposal ? { slug: state.proposalSlug, source: state.proposalSource } : null;
    rows.innerHTML = list.items.length ? list.items.map((e) => specRowHtml(e, { current: open })).join('') : empty(emptyWords('specs', forgeName()));
  }
  else if (work) rows.innerHTML = groups.length ? groupsHtml(groups) : empty(ui.work.grouped.groups.length ? 'No work matches these filters.' : emptyWords('work', forgeName()));
  else rows.innerHTML = shown.length ? shown.map((i) => itemHtml(i)).join('') : empty(list.items.length ? `No ${kindWords()} matches these filters.` : emptyWords(ui.kind, forgeName()));

  const detail = $('forge-detail');
  detail.hidden = !showing;
  detail.setAttribute('aria-label', showing.startsWith('thread:') ? 'Selected thread' : showing.startsWith('deploy:') ? 'Selected deploy' : 'Selected pull request');
  detail.innerHTML = detailHtml();

  paintIdea();
  $('forge-foot').hidden = $('notes-open').hidden && $('forge-idea').hidden;
  const rate = (showing && ((ui.threadDetail && ui.threadDetail.rate) || (ui.detail && ui.detail.rate))) || (list && list.rate) || '';
  $('forge-rate').textContent = rate;
  paintRuns();
  paintButton();
  paintTabsMore();
}

/** The runs of the Agents tab: state, what each is about, links, and Stop. A runner's words are escaped like any text from the forge. */
function paintRuns() {
  const box = $('forge-runs');
  if (!box) return;
  box.hidden = ui.kind !== 'work' || !!detailKey();
  if (box.hidden) return;
  const data = ui.runs && ui.runs.data;
  $('forge-runs-status').textContent = data ? runsStatus(data) : ui.loading ? 'Loading the runs …' : '';
  const note = $('forge-runs-note');
  const failed = ui.runs && ui.runs.error;
  const words = failed || (ui.runNote ? ui.runNote.text : '');
  note.className = `hx-forge-notice${!failed && ui.runNote && ui.runNote.ok ? ' hx-forge-notice--ok' : ''}`;
  if (!failed && ui.runNote && ui.runNote.ok) note.dataset.cornState = 'success'; else delete note.dataset.cornState;
  setNotice(note, words, !!failed);
  paintRunner('forge-runs-runner', data);
  const trig = $('forge-runs-trigger');
  if (trig) {
    const skipped = data ? triggerNotice(data) : '';
    trig.hidden = !skipped;
    trig.textContent = skipped;
  }
  const totals = $('forge-runs-totals');
  if (totals) {
    const lines = data ? totalsLines(data.totals) : [];
    totals.hidden = !lines.length;
    totals.innerHTML = totalsHtml(viewContext(), lines);
  }
  const hand = $('forge-runs-hand');
  if (hand) {
    const lines = data ? handLines(data) : [];
    hand.hidden = !lines.length;
    hand.innerHTML = lines.map((l) => `<li>${escHtml(l)}</li>`).join('');
  }
  const list = $('forge-runs-list');
  list.setAttribute('aria-busy', String(!data && !!ui.loading));
  if (!data) { list.innerHTML = ui.loading ? loadingRowsHtml(3) : ''; return; }
  patchList(list, data.runs.length ? runsHtml(viewContext(), data.runs) : '<li class="hx-forge-empty hx-faint" data-corn="empty">No agent has been asked for yet. Start one from an issue or a proposal: Issues, then Start an agent.</li>');
}

/**
 * Draws a list again without disturbing what the person is doing in it. The new rows are made first and set against the old by their key
 * (a run's id, a compare group's): a row that has not changed is left alone, a row that has is replaced, and **a row that holds the focus in
 * a field, or a reply typed and not sent, is kept as it is** (its result line is the one part brought up to date), so the caret, the
 * selection, the focus and the text stay where they were. A row whose field is no longer asked for is replaced like any other.
 */
function patchList(list, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const fresh = [...tpl.content.children];
  const keyOf = (el) => el.dataset.key || el.dataset.run || null;
  const old = new Map([...list.children].filter((el) => keyOf(el)).map((el) => [keyOf(el), el]));
  const typing = (el) => el.contains(document.activeElement) && document.activeElement.matches('input, textarea');
  const redraw = new Set(redrawRuns); // runs the page has just acted on: their cards say what the action did, so they are drawn anew (the focus is put back by hand)
  redrawRuns.clear();
  const unsent = (el) => [...el.querySelectorAll('[data-run-reply]')].some((f) => f.value !== '');
  const target = fresh.map((f) => {
    const was = keyOf(f) && old.get(keyOf(f));
    if (!was) return f;
    if (was.outerHTML === f.outerHTML) return was;
    const field = was.querySelector('[data-run-reply]');
    const twin = field && f.querySelector(`[data-run-reply="${field.dataset.runReply}"]`);
    if (!redraw.has(keyOf(f)) && (typing(was) || unsent(was)) && twin) {
      // The field stays (the very element, never taken out of the page, so the focus, caret, selection and a phone's keyboard stay);
      // everything around it is the new card's, so a state that changed is shown (graftAround)
      const theirs = twin.getAttribute('value') || '';
      graftAround(was, field, twin);
      // The typed text is in `ui.runReplies` as well, always (every keystroke); a field that differs from it was changed by the page itself
      if (field.value !== theirs) field.value = theirs;
      return was;
    }
    return f;
  });
  target.forEach((node, i) => {
    const at = list.children[i];
    if (at === node) return;
    if (at && keyOf(at) && keyOf(at) === keyOf(node)) at.replaceWith(node); else list.insertBefore(node, at || null);
  });
  while (list.children.length > target.length) list.lastElementChild.remove();
}

/**
 * Makes `root` (an old row) what `fresh` (its new drawing) is, except that `keep` (inside `root`) stays the same element in the same place,
 * standing for `twin` (its match inside `fresh`): at each level from `keep` up to `root`, the parent takes the new parent's attributes and
 * children, with the kept branch in its place. `keep` itself is never taken out of the page.
 */
function graftAround(root, keep, twin) {
  const sync = (to, from) => {
    for (const a of [...to.attributes]) if (!from.hasAttribute(a.name) && a.name !== 'value') to.removeAttribute(a.name);
    for (const a of [...from.attributes]) if (a.name !== 'value' && to.getAttribute(a.name) !== a.value) to.setAttribute(a.name, a.value);
  };
  sync(keep, twin);
  let w = keep;
  let f = twin;
  while (w !== root && w.parentElement && f.parentElement) {
    const wp = w.parentElement;
    const fp = f.parentElement;
    sync(wp, fp);
    const kids = [...fp.childNodes];
    const at = kids.indexOf(f);
    for (const n of [...wp.childNodes]) if (n !== w) n.remove();
    for (const n of kids.slice(0, at)) wp.insertBefore(n, w);
    for (const n of kids.slice(at + 1)) wp.append(n);
    w = wp;
    f = fp;
  }
}

/** The one line on whether a runner is polling (pull transport only), in the Runs view and the Start dialog; hidden where it does not apply */
function paintRunner(id, data) {
  const el = $(id);
  if (!el) return;
  const words = data ? runnerWords(data.runnerPresence, now()) : '';
  el.hidden = !words;
  el.textContent = words;
}

/** What the Runs view needs to know of the page */
function viewContext() {
  const f = ui.config && ui.config.forge;
  const base = f && safeUrl(f.url) ? f.url.replace(/\/+$/, '') : null;
  return {
    esc: escHtml, safeUrl, forgeName: forgeName(), forgeType: f ? f.type : 'github', repoUrl: base && f.repo ? `${base}/${f.repo}` : null,
    now: now(), nodes: state.nodes, selected: ui.runSel, timelines: ui.runTimelines, replies: ui.runReplies, busy: !!ui.busy,
    results: { get: (id) => resultOf(id) },
  };
}

const runById = (id) => ((ui.runs && ui.runs.data && ui.runs.data.runs) || []).find((r) => r.runId === id) || null;

/** The nodes of a selected run, worked out again (the runs were read again, or the map changed) */
function relightRun() {
  if (!runById(ui.runSel)) ui.runSel = null;
  relight();
}

/** Lights the nodes of a run on the map, like a pull request; the same button lets go of it */
function selectRun(id) {
  const run = runById(id);
  if (!run) return;
  if (ui.runSel === id) {
    ui.runSel = null;
    relight();
    announce(`Run ${id} no longer lit on the map`);
    return;
  }
  const had = ui.runSel;
  pullToken++;
  dropThread();
  Object.assign(ui, { selected: null, detail: null, detailError: '', lit: null, landing: null, note: null, deploy: null, deployItem: null, litDeploy: null });
  ui.runSel = id;
  relight();
  const n = (run.nodes || []).length;
  announce(n ? `Run ${id}: ${n} ${n === 1 ? 'node' : 'nodes'} lit on the map${had ? '' : ''}` : `Run ${id} has no node on the map yet`);
}

/** Opens or closes the timeline of a run (it stays open when the list is drawn again) */
function toggleTimeline(id) {
  if (ui.runTimelines.has(id)) ui.runTimelines.delete(id); else ui.runTimelines.add(id);
  paint();
}

/** The panel's lines for the Release notes view: the status, a failure, the rate limit; the rest is paintNotes */
function drawNotes() {
  const n = ui.notes;
  $('forge-status').textContent = n.loading && !n.data ? `Drafting the release notes from ${forgeName()} …` : n.data ? notesSummary(n.data) : '';
  const notice = $('forge-notice');
  const words = n.error || (n.data && n.data.stale ? `Showing an older answer. ${n.data.stale}` : '');
  setNotice(notice, words, !!words);
  $('forge-detail').hidden = true;
  paintIdea();
  $('forge-rate').textContent = (n.data && n.data.rate) || '';
  paintNotes();
  paintButton();
}

/** The toggles that open the panel (`data-action="toggle-forge"`: the header's, whatever it calls it) say whether it is open, and the old button which selection is lit */
function paintButton() {
  for (const toggle of document.querySelectorAll('[data-action="toggle-forge"]')) toggle.setAttribute('aria-expanded', String(ui.open));
  const btn = $('forge-btn');
  if (!btn) return;
  const lit = ui.selected !== null || !!ui.deployItem || ui.thread !== null || !!ui.runSel;
  const tag = $('forge-btn-lit');
  if (tag) {
    tag.hidden = !lit;
    tag.textContent = ui.runSel ? 'run' : ui.thread !== null ? `thread #${ui.thread}` : ui.deployItem ? 'deploy' : lit ? `#${ui.selected}` : '';
  }
  btn.setAttribute('aria-label', `${t('issuesAndPrs')}${ui.runSel ? ', a run lit on the map' : ui.thread !== null ? `, thread ${ui.thread} selected` : ui.deployItem ? ', a deploy selected' : lit ? `, pull request ${ui.selected} selected` : ''}`);
}

// ---------------------------------------------------------------------------
//  Actions: land a green pull request, re-run a failed check
// ---------------------------------------------------------------------------

/** One POST of JSON; `{ ok, status, body }`, with a status of null when the server did not answer */
async function post(url, payload) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    return { ok: !!res.ok && !!body && body.ok === true, status: res.status, body };
  } catch {
    return { ok: false, status: null, body: null };
  }
}

/** What an action came to: said on the panel and through the live region, and everything is read again from the forge */
async function finishAction(action, res, n) {
  const text = actionWords(action, res.status, res.body, n);
  ui.busy = '';
  ui.note = { text, ok: res.ok };
  announce(text);
  paint();
  if (res.status === null) return;
  // The other tabs' answers are from before it: they are read again when next shown (the server let go of its own copies)
  if (ui.kind === 'work') ui.lists = {};
  else { ui.lists = { [listKey()]: ui.lists[listKey()] }; ui.work = null; }
  // Whatever it came to (a refusal says the pull request is not what was shown), the panel looks again
  if (ui.selected === n) await refreshForge({ quiet: true });
}

/** Re-runs one failed check on the head that is shown */
async function rerunCheck(id) {
  if (ui.busy || !ui.detail) return;
  const { pull, checks } = ui.detail;
  const check = checks.find((c) => c.id === id);
  if (!check || check.state !== 'failure' || !check.canRerun) return;
  ui.busy = `rerun:${id}`;
  ui.note = null;
  announce(`Re-running ${check.name}`);
  paint();
  const res = await post(actionUrl(pull.number, 'rerun'), { sha: pull.head.sha, check: id });
  await finishAction('rerun', res, pull.number);
}

const confirmEl = () => $('forge-confirm');

/** While the confirm step is open the focus cannot leave it: a focus that lands elsewhere is brought back */
function keepFocusIn(e) {
  const el = confirmEl();
  if (ui.confirm && el && !el.contains(e.target)) el.querySelector('[data-action="forge-confirm-cancel"]').focus();
}

/** Fills and opens the confirm step; the focus goes to Cancel. `what` is the model's: title, lines, checks, previews, note */
function showConfirm(what, goLabel, state) {
  const el = confirmEl();
  const asCode = ['Commit', 'At commit', 'Branch', 'File', 'Proposal'];
  $('forge-confirm-title').textContent = what.title;
  $('forge-confirm-body').innerHTML = `<dl class="hx-confirm-facts">${what.lines.map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${asCode.includes(k) ? `<code class="hx-code">${escHtml(v)}</code>` : escHtml(v)}</dd>`).join('')}</dl>
    ${(what.checks || []).length ? `<ul class="hx-confirm-checks">${what.checks.map((c) => `<li><span class="hx-forge-state hx-forge-state--success" data-corn="state-pill" data-corn-state="success">${escHtml(c.words)}</span> ${escHtml(c.name)}</li>`).join('')}</ul>` : ''}
    ${(what.previews || []).map((pv) => `<p class="hx-confirm-label">${escHtml(pv.label)}</p><pre class="hx-confirm-pre" tabindex="0" role="region" aria-label="${escHtml(pv.label)}">${escHtml(pv.text)}</pre>`).join('')}
    <p class="hx-confirm-note">${escHtml(what.note)}</p>`;
  const go = el.querySelector('[data-action="forge-confirm-go"]');
  go.disabled = false;
  go.textContent = goLabel;
  go.removeAttribute('aria-busy');
  // The scrim covers the page for the pointer, aria-modal tells a reader the rest is out of play, and the focus stays in
  ui.confirm = state;
  document.addEventListener('focusin', keepFocusIn);
  el.hidden = false;
  el.querySelector('[data-action="forge-confirm-cancel"]').focus();
  announce(`${what.title} ${what.lines.map(([k, v]) => `${k}: ${v}`).join('. ')}. ${what.note} Cancel or ${goLabel}.`);
}

/** Opens the confirm step for landing the selected pull request: what will land, exactly */
function openConfirm(opener) {
  if (!confirmEl() || ui.confirm || ui.busy || !ui.detail || mergeBlock(ui.detail)) return;
  showConfirm(confirmMerge(ui.detail, forgeName(), ui.config && ui.config.forge && ui.config.forge.mergeMethod), t('landIt'), { opener, kind: 'merge' });
}

/** What a pipeline step came to, on the panel (with a link to what it made) and through the live region */
function stepNote(text, ok, url = null) {
  ui.actNote = { text, ok, url };
  announce(text);
  paint();
}

/** Forgets the lists of the other kind (a step made something there), so they are asked again when shown */
function forgetOtherLists() {
  for (const key of Object.keys(ui.lists)) if (!key.startsWith(`${ui.kind}|`)) delete ui.lists[key];
}

/**
 * A pipeline step, first half: reads the plan from the server (what would be made, from the forge now). A step that
 * was done before says so and stops; otherwise the confirm step shows the plan and nothing is made until it is confirmed.
 */
async function askPlan(action, n, slug, opener) {
  if (ui.busy || ui.confirm || !confirmEl()) return;
  ui.busy = `plan:${action}`;
  ui.actNote = null;
  announce(action === 'spec' ? `Looking at what a spec for issue ${n} would make` : `Looking at the build issue for ${slug}`);
  paint();
  const res = await request(planUrl(action, n, slug), true);
  ui.busy = '';
  // The button was off while it asked; it has the focus again whatever the answer is
  const refocus = () => { const back = $('forge-panel').querySelector(opener); if (back && !back.disabled && !ui.confirm) back.focus(); };
  if (!res.ok || !res.body || !res.body.plan) {
    stepNote(actionWords(action, res.status, res.body, n), false);
    refocus();
    return;
  }
  const { plan } = res.body;
  if (plan.existing) {
    stepNote(existingWords(action, plan), true, plan.existing.url);
    refocus();
    return;
  }
  paint();
  const what = action === 'spec' ? confirmSpec(plan, forgeName()) : confirmBuild(plan, forgeName());
  showConfirm(what, what.go, { opener, kind: action, plan, n, slug });
}

/** A pipeline step, second half: the plan that was shown is confirmed; the server plans again and must find the same */
async function confirmedStep() {
  if (ui.busy || !ui.confirm || !ui.confirm.plan) return;
  const { kind, plan, n } = ui.confirm;
  ui.busy = kind;
  ui.actNote = null;
  const go = confirmEl().querySelector('[data-action="forge-confirm-go"]');
  go.disabled = true;
  go.setAttribute('aria-busy', 'true');
  go.textContent = 'Working …';
  announce(kind === 'spec' ? `Starting the spec for issue ${n}` : `Opening the build issue for ${plan.slug}`);
  const res = await post(actionUrl(n, kind), kind === 'spec' ? specBody(plan) : buildBody(plan));
  closeConfirm();
  ui.busy = '';
  const made = res.body && (kind === 'spec' ? res.body.pull : res.body.issue);
  stepNote(actionWords(kind, res.status, res.body, n), res.ok, res.ok && made ? made.url : null);
  // Whatever it came to, it is read again: a refusal says the issue or the pull request is not what was shown
  if (res.status !== null) {
    forgetOtherLists();
    if (kind === 'build' && ui.selected === n) await refreshForge({ quiet: true });
    else await loadList(true, true);
  }
}

/** Closes the confirm step; the focus goes back to the button that opened it (or the panel's title if that is gone) */
function closeConfirm({ restoreFocus = true } = {}) {
  const el = confirmEl();
  if (!el || !ui.confirm) return;
  const { opener } = ui.confirm;
  ui.confirm = null;
  el.hidden = true;
  document.removeEventListener('focusin', keepFocusIn);
  if (!restoreFocus) return;
  const back = $('forge-panel').querySelector(opener) || $('forge-title');
  if (back && !back.disabled) back.focus();
}

/** Land it, confirmed: posts the head that was shown */
async function confirmedMerge() {
  if (ui.busy || !ui.detail || !ui.confirm || ui.confirm.kind !== 'merge') return;
  const { pull } = ui.detail;
  const body = mergeBody(ui.detail);
  ui.busy = 'merge';
  ui.note = null;
  const go = confirmEl().querySelector('[data-action="forge-confirm-go"]');
  go.disabled = true;
  go.setAttribute('aria-busy', 'true');
  go.textContent = 'Landing …';
  announce(`Landing pull request ${pull.number}`);
  const res = await post(actionUrl(pull.number, 'merge'), body);
  closeConfirm();
  await finishAction('merge', res, pull.number);
}

/** Keys inside the confirm step: Escape cancels, Tab stays between its two buttons, nothing reaches the map behind it */
function onConfirmKey(e) {
  e.stopPropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!ui.busy) closeConfirm();
    return;
  }
  trapTab(e, confirmEl());
}

function onConfirmClick(e) {
  const t = e.target;
  if (t === confirmEl()) { if (!ui.busy) closeConfirm(); return; } // the scrim
  const action = t.closest && t.closest('[data-action]');
  if (!action) return;
  if (action.dataset.action === 'forge-confirm-cancel') { if (!ui.busy) closeConfirm(); } else if (action.dataset.action === 'forge-confirm-go') { if (ui.confirm && ui.confirm.kind === 'merge') confirmedMerge(); else confirmedStep(); }
}

// ---------------------------------------------------------------------------
//  Agent runs: Start an agent, and Stop
// ---------------------------------------------------------------------------

const agentEl = () => $('agent-start');

/** While the dialog is open the focus cannot leave it */
function keepFocusInAgent(e) {
  const el = agentEl();
  if (ui.agent && el && !el.contains(e.target)) $('agent-kind').focus();
}

/**
 * Opens the Start an agent dialog for `issue:<n>` or `proposal:<slug>`; the focus goes to the first field. The limit fields hold what the request
 * starts from (the config's, for the profile). With `again` (a run that failed or was stopped) it is **Start again**: the same kind, refs,
 * profile, brief and limits filled in, all editable, and the request will carry `retryOf`. `brief` is that run's whole brief when the list's was cut
 */
async function openAgent(ref, opener, again = null, brief = null) {
  if (!agentEl() || ui.agent) return;
  const at = ref.indexOf(':');
  const type = ref.slice(0, at);
  const value = ref.slice(at + 1);
  const refs = again ? retryRefs(again) : type === 'proposal' ? { proposal: value } : { issue: Number(value) };
  ui.agent = { opener, refs, posting: false, retryOf: again ? again.runId : null };
  // The profiles the config lists come with the runs: asked for if the Agents tab has not been opened yet
  if (!ui.runs) { await loadRuns(false); if (ui.kind === 'work') paint(); }
  if (!ui.agent) return;
  const profiles = (ui.runs && ui.runs.data && ui.runs.data.profiles) || [];
  $('agent-start-about').textContent = `About ${aboutWords(refs)}`;
  paintRunner('agent-start-runner', ui.runs && ui.runs.data);
  const kind = again ? again.kind : 'code';
  // The old run's profile stays on offer even if the config no longer lists it: the server then says so, in its words
  const shown = again && again.profile && !profiles.includes(again.profile) ? [...profiles, again.profile] : profiles;
  $('agent-kind').innerHTML = KINDS.map(([v, l]) => option(v, l, v === kind)).join('');
  $('agent-profile').innerHTML = option('', 'No profile', !(again && again.profile)) + shown.map((p) => option(p, p, !!again && p === again.profile)).join('');
  $('agent-profile-field').hidden = !shown.length;
  $('agent-profile').value = again && again.profile ? again.profile : ''; // as well as `selected`, which not every DOM honours
  $('agent-start-title').textContent = again ? t('startAgain') : t('startAgent');
  const note = $('agent-retry-note');
  note.hidden = !again;
  note.textContent = again ? retryWords(again) : '';
  fillLimits(again ? again.limits || {} : limitDefaultsNow());
  $('agent-brief').value = brief ?? (again && typeof again.brief === 'string' ? again.brief : '');
  $('agent-force').checked = false;
  $('agent-force-field').hidden = true;
  $('agent-start-msg').hidden = true;
  $('agent-start-msg').textContent = '';
  $('agent-start-words').textContent = confirmStartWords(refs, forgeName());
  const go = $('agent-start-go');
  go.disabled = false;
  go.removeAttribute('aria-busy');
  go.textContent = t('askRunner');
  document.addEventListener('focusin', keepFocusInAgent);
  agentEl().hidden = false;
  $('agent-kind').focus();
  announce(`${again ? t('startAgain') : t('startAgent')} on ${aboutWords(refs)}. ${confirmStartWords(refs, forgeName())}`);
}

/** "Start again" on a run that failed or was stopped. A brief the list shows cut is read whole first: the dialog never starts from part of one */
async function startAgain(runId) {
  const run = ui.runs && ui.runs.data ? ui.runs.data.runs.find((r) => r.runId === runId) : null;
  if (!run || !canRetry(run) || ui.agent || ui.retrying) return;
  let brief = null;
  if (run.briefCut) {
    ui.retrying = true;
    const res = await request(briefUrl(runId), false);
    ui.retrying = false;
    if (!res.ok || typeof res.body.brief !== 'string') {
      ui.runNote = { text: `The brief of ${runId} could not be read, so Start again did not open: ${failWords(res)}`, ok: false };
      paint();
      announce(ui.runNote.text);
      return;
    }
    brief = res.body.brief;
  }
  const about = run.refs.proposal != null ? `proposal:${run.refs.proposal}` : `issue:${run.refs.issue ?? run.refs.thread}`;
  openAgent(about, `[data-forge-retry="${runId}"]`, run, brief);
}

/** Takes the person to another run of the list: the row scrolls into view and has the focus */
function goToRun(runId) {
  bringIntoView([...document.querySelectorAll('#forge-runs-list [data-run]')].find((r) => r.dataset.run === runId));
}

/** The limits the config gives a request under the chosen profile */
const limitDefaultsNow = () => defaultLimits(ui.runs && ui.runs.data && ui.runs.data.limits, $('agent-profile-field').hidden ? '' : $('agent-profile').value);
/** What the four limit fields hold, as text */
const limitFields = () => Object.fromEntries(LIMIT_KEYS.map((k) => [k, $(`agent-limit-${k}`).value]));

/** Fills the four limit fields (blank where `limits` has none) and remembers what was filled */
function fillLimits(limits) {
  for (const k of LIMIT_KEYS) {
    const field = $(`agent-limit-${k}`);
    field.value = limits && limits[k] != null ? String(limits[k]) : '';
    field.removeAttribute('aria-invalid');
    field.removeAttribute('aria-describedby');
  }
  if (ui.agent) ui.agent.filled = JSON.stringify(limitFields());
}

/** Another profile: its limits fill the fields, unless the person has typed in them */
function onAgentProfile() {
  if (ui.agent && ui.agent.filled === JSON.stringify(limitFields())) fillLimits(limitDefaultsNow());
}

/** Closes the dialog; the focus goes back to the button that opened it unless told not to */
function closeAgent({ restoreFocus = true } = {}) {
  const el = agentEl();
  if (!el || !ui.agent) return;
  const { opener } = ui.agent;
  ui.agent = null;
  el.hidden = true;
  document.removeEventListener('focusin', keepFocusInAgent);
  if (!restoreFocus) return;
  const back = document.querySelector(opener) || $('forge-title'); // the node panel's Start a run is an opener too
  if (back && !back.disabled) back.focus();
}

/** The one write: posts the choices once; a refusal stays in the dialog, in the server's words */
async function submitAgent(e) {
  e.preventDefault();
  if (!ui.agent || ui.agent.posting) return;
  ui.agent.posting = true;
  const go = $('agent-start-go');
  go.disabled = true;
  go.setAttribute('aria-busy', 'true');
  go.textContent = 'Asking …';
  $('agent-start-msg').hidden = true;
  const again = ui.agent.retryOf;
  const fields = limitFields();
  const limits = limitsFromFields(fields);
  // Each field that is not a number above zero is marked, and the first has the focus; the message says why
  const wrong = LIMIT_KEYS.filter((k) => limitsFromFields({ [k]: fields[k] }) === null);
  for (const k of LIMIT_KEYS) {
    const field = $(`agent-limit-${k}`);
    if (wrong.includes(k)) { field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', 'agent-start-msg'); } else { field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby'); }
  }
  if (limits === null) {
    ui.agent.posting = false;
    go.disabled = false;
    go.removeAttribute('aria-busy');
    go.textContent = t('askRunner');
    const bad = $('agent-start-msg');
    bad.textContent = `A limit is a number above zero, or blank for the config's (${wrong.join(', ')}).`;
    bad.hidden = false;
    $(`agent-limit-${wrong[0]}`).focus();
    announce(bad.textContent);
    return;
  }
  const res = await post(RUNS_URL, startBody({
    kind: $('agent-kind').value, profile: $('agent-profile-field').hidden ? '' : $('agent-profile').value, brief: $('agent-brief').value, refs: ui.agent.refs, force: $('agent-force').checked,
    limits, ...(again ? { retryOf: again } : {}),
  }));
  if (!ui.agent) return;
  ui.agent.posting = false;
  const text = startWords(res.status, res.body);
  if (res.ok) {
    closeAgent();
    ui.runNote = { text, ok: true };
    announce(text);
    await loadRuns(false);
    paint();
    return;
  }
  go.disabled = false;
  go.removeAttribute('aria-busy');
  go.textContent = t('askRunner');
  const msg = $('agent-start-msg');
  msg.textContent = text;
  msg.hidden = false;
  // The one-per-issue rule can be set aside on purpose; the cap cannot
  if (res.body && res.body.code === 'run-open') $('agent-force-field').hidden = false;
  announce(text);
}

/** Keys inside the dialog: Escape cancels, Tab stays inside, nothing reaches the map behind it */
function onAgentKey(e) {
  e.stopPropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!ui.agent || !ui.agent.posting) closeAgent();
    return;
  }
  trapTab(e, agentEl());
}

function onAgentClick(e) {
  const t = e.target;
  if (t === agentEl()) { if (ui.agent && !ui.agent.posting) closeAgent(); return; } // the scrim
  if (t.closest && t.closest('[data-action="agent-start-cancel"]') && ui.agent && !ui.agent.posting) closeAgent();
}

/** The runs whose card is drawn anew at the next paint, whatever holds the focus in it (the page itself changed what it says) */
const redrawRuns = new Set();

/** Gives the focus to the first of `selectors` that is there and not disabled, inside the card of a run (else the card itself) */
function focusInRun(runId, selectors) {
  const panel = $('forge-panel');
  const card = panel && [...panel.querySelectorAll('[data-run]')].find((c) => c.dataset.run === runId);
  if (!card) return;
  const to = selectors.map((sel) => card.querySelector(sel)).find((el) => el && !el.disabled) || card;
  if (to !== document.activeElement) to.focus();
  if (to.matches('input') && typeof to.setSelectionRange === 'function') to.setSelectionRange(to.value.length, to.value.length); // typing goes on at the end of what is there
}

/** Back online: a tab that could not be read is read again, so its error does not outlive the cause (the same function each time, added once) */
function readOnline() {
  if (ui.open && (ui.error || (ui.runs && ui.runs.error) || ui.detailError || (ui.kind === 'notes' && ui.notes.error))) refreshForge({ quiet: true });
}

/** Lets go of a reply that was not sent because its run stopped waiting: the field goes, and the focus goes to the run's card */
function discardReply(runId) {
  ui.runReplies.delete(runId);
  redrawRuns.add(runId);
  paint();
  focusInRun(runId, []);
}

/** Asks a run to stop: one POST, then the runs are read again. What it came to is said in the run's own card, and to a screen reader */
async function stopRun(runId) {
  if (ui.busy) return;
  ui.busy = 'stop';
  ui.runNote = null;
  clearResult(runId);
  announce('Asking this run to stop'); // the focus is in the run's card, whose controls name it
  paint();
  const res = await post(stopUrl(runId), {});
  ui.busy = '';
  sayResult(runId, res.status === null ? notSentWords('The stop request') : stopWords(res.status, res.body, 'this run'), res.ok);
  await loadRuns(false, { say: false });
  redrawRuns.add(runId);
  paint();
  // The Stop button is gone once the stop is asked for: the focus goes to the run's row, never to the page
  focusInRun(runId, [`[data-forge-stop="${runId}"]`]);
}

/** Answers a waiting run: Continue, Stop, or a reply with the text typed. One POST, then the runs are read again */
async function answerRun(runId, action) {
  if (ui.busy) return;
  const text = ui.runReplies.get(runId) || '';
  clearResult(runId);
  if (action === 'reply' && text.trim() === '') {
    sayResult(runId, 'Write a reply first.', false);
    paint();
    focusInRun(runId, [`[data-run-reply="${runId}"]`]);
    return;
  }
  // Where the focus goes back to once it is sent: the reply field after a reply (empty, for the next one), the button after Continue; while the
  // buttons are disabled the focus has nowhere to stay, so it is put back by hand. A run that no longer asks (a Stop) gets its Timeline button
  const back = action === 'reply' ? `[data-run-reply="${runId}"]` : `[data-run-answer="${action}"][data-run-id="${runId}"]`;
  ui.busy = 'answer';
  ui.runNote = null;
  announce(action === 'reply' ? 'Sending your reply' : 'Sending your answer');
  paint();
  const res = await post(answerUrl(runId), answerBody(action, text));
  ui.busy = '';
  if (res.ok && action === 'reply') ui.runReplies.delete(runId); // sent: the field is empty for the next; a reply that was not sent stays as it was typed
  const words = res.status === null ? notSentWords(action === 'reply' ? 'Your reply' : 'The answer') : answerWordsFor(res.status, res.body, 'this run', action);
  sayResult(runId, words, res.ok);
  await loadRuns(false, { say: false });
  redrawRuns.add(runId);
  paint();
  focusInRun(runId, [back, `[data-run-timeline="${runId}"]`]);
}

// ---------------------------------------------------------------------------
//  Opening and closing
// ---------------------------------------------------------------------------

export const isForgeOpen = () => ui.open;

/** What opened the panel (a toggle in the header), so Escape and Close give the focus back to it */
let openerEl = null;

/**
 * Opens the panel with the focus on its title; the first time, loads what its tab shows (the proposals, to start with).
 * `tab` opens it on that tab ('specs', 'pulls', 'issues', 'threads', 'work' for Runs, 'deploys'), whichever was shown last otherwise.
 */
export function openForge({ load = true, tab } = {}) {
  const panel = $('forge-panel');
  if (!panel || panel.hidden) return;
  if (tab && tab !== (ui.kind === 'notes' ? 'pulls' : ui.kind) && TABS.includes(tab)) { // the Release notes are one level down on PRs
    ui.kind = tab;
    ui.filters = defaultFilters(tab);
    ui.actNote = null;
  }
  ui.open = true;
  panel.inert = false;
  panel.classList.add('forge-open');
  if (isPhone()) expandSheet('forge');
  paintButton();
  const title = $('forge-title');
  title.focus();
  announce('Work');
  if (!load) return; // a deep link loads the list it wants itself (openTab)
  if (!tab) primeCounts(); // opened by a toggle, not for a tab: the other tabs' counts are read quietly
  if (ui.kind === 'notes') { if (!ui.notes.data && !ui.notes.loading) loadNotes(); else paint(); return; }
  if (ui.kind === 'specs' || !current()) { paintFilters(); loadList(); } else paint();
}

/** The tabs, in the order of the loop */
const TABS = ['specs', 'pulls', 'issues', 'threads', 'work', 'deploys'];

// ---------------------------------------------------------------------------
//  Deep links (explorer/deep-link.js): a run, an issue, a proposal's Start dialog
// ---------------------------------------------------------------------------

/** Shows `tab` in the panel, opened (and, on a phone, expanded), with its list read; resolves when the list is in */
async function openTab(tab) {
  ui.kind = tab;
  ui.filters = defaultFilters(tab); // a filter left from before must not hide what the link names
  ui.actNote = null;
  paintFilters();
  if (!ui.open) openForge({ load: false });
  if (isPhone()) expandSheet('forge');
  if (current()) paint(); else await loadList();
}

/** What a link names is not there: a line in the panel, said through the live region */
function linkMissing(words) {
  ui.actNote = { ok: false, text: words };
  paint();
  announce(words);
  return false;
}

/** Moves the focus to `el` (made focusable if it is a row) and brings it into view */
function bringIntoView(el) {
  if (!el) return;
  if (!el.matches('button, a, input, select, textarea')) el.setAttribute('tabindex', '-1');
  el.focus();
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
}

/** `?run=<runId>`: the Agents tab with that run lit and in view. A run that is not there is said, never a blank panel. */
export async function openRunLink(id) {
  if (!ui.config) return false;
  await openTab('work');
  if (!(ui.runs && ui.runs.data)) await loadRuns(false, { say: false });
  let run = runById(id);
  // A run asked for a moment ago may not be in what was read before: ask once more, past the cache
  if (!run && ui.runs && ui.runs.data) { await loadRuns(true, { say: false }); run = runById(id); }
  if (!run) return linkMissing(ui.runs && ui.runs.data ? `There is no run ${id}.` : (ui.runs && ui.runs.error) || 'The runs could not be read.');
  if (ui.runSel !== id) selectRun(id);
  paint();
  bringIntoView($('forge-runs-list').querySelector(`[data-run="${id}"]`));
  announce(`Run ${id}, in the Runs view`);
  return true;
}

/** `?issue=<n>`: the Issues tab with that issue's Start an agent button in view and focused, ready to press */
export async function openIssueLink(n) {
  if (!ui.config) return false;
  await openTab('issues');
  const list = current();
  if (!list) return linkMissing(ui.error || 'The issues could not be read.');
  const item = list.items.find((i) => i.number === n);
  if (!item) return issueNotListed(n);
  paint();
  const start = $('forge-list').querySelector(`[data-forge-agent="issue:${n}"]`);
  bringIntoView(start);
  announce(`Issue ${n}: ${item.title}. Start an agent is ready`);
  return true;
}

/** An issue the open list does not hold: asked for once, directly, so a closed one is called closed and a missing one missing */
async function issueNotListed(n) {
  const res = await request(issueUrl(n));
  if (res.ok && res.body.issue) {
    const { issue } = res.body;
    ui.actNote = { ok: false, text: issue.state === 'closed' ? `Issue ${n} is closed: ${issue.title}` : `Issue ${n} is open, but not in the list shown here: ${issue.title}`, url: issue.url };
    paint();
    announce(ui.actNote.text);
    return false;
  }
  return linkMissing(res.status === 404 ? `There is no issue ${n}.` : failWords(res, `issue ${n}`));
}

/** Whether the Start dialog can open now: the server runs agents and the page has the dialog (the node panel's "Start a run" asks) */
export const canStartAgent = () => !!(ui.config && ui.config.agents && agentEl());

/** `?proposal=<slug>&start=1`: the Start dialog on that proposal (the proposal itself is opened by proposal.js) */
export async function openProposalStart(slug, opener = '#forge-title') {
  if (!ui.config || !agentEl()) return false;
  await openAgent(`proposal:${slug}`, opener);
  return !!ui.agent;
}

/** Closes the panel. What a selected pull request lit stays lit (the button says which); Clear lets go of it. */
export function closeForge({ restoreFocus = true } = {}) {
  const panel = $('forge-panel');
  if (!panel || !ui.open) return;
  const hadFocus = panel.contains(document.activeElement);
  ui.open = false;
  panel.classList.remove('forge-open');
  panel.inert = true;
  collapseSheet('forge');
  paintButton();
  const back = openerEl && openerEl.isConnected ? openerEl : $('forge-btn');
  if (restoreFocus && hadFocus && back) back.focus();
  announce('Work closed');
}

export const toggleForge = () => (ui.open ? closeForge() : openForge());

/** Asks the forge again, past the server's cache: the list, and the selected pull request */
export async function refreshForge({ quiet = false } = {}) {
  if (!quiet) announce('Asking the forge again');
  if (ui.kind === 'notes') { await loadNotes(true); return; }
  const n = ui.selected;
  await loadList(true, quiet);
  if (ui.deployItem) {
    // The list is read again: the deploy as the forge now has it (still running, now finished), else the last copy
    const again = ui.lists.deploys && ui.lists.deploys.items.find((d) => d.id === ui.deploy);
    if (again) { ui.deployItem = again; relight(); }
    return;
  }
  if (ui.thread !== null) {
    const at = ui.thread;
    const token = ++threadToken;
    const res = await request(threadUrl(at), true);
    const thread = threadOf(res);
    if (token !== threadToken || !thread) return;
    ui.threadDetail = { thread, at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '' };
    relight();
    return;
  }
  if (n !== null && ui.selected === n) {
    const token = ++pullToken;
    const res = await request(pullUrl(n), true);
    if (token !== pullToken || !res.ok) return;
    ui.detail = { pull: res.body.pull, files: res.body.files || [], checks: res.body.checks || [], specs: res.body.specs || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '' };
    relight();
    await loadLanding(n, token);
  }
}

// ---------------------------------------------------------------------------
//  Events
// ---------------------------------------------------------------------------

/** After a filter changes: the list again, and how many it holds */
function filtersChanged(announceNow = true) {
  paint();
  const list = current();
  if (announceNow && list && ui.kind === 'work') announce(workStatus(groupsShown(), '', now()));
  else if (announceNow && list) announce(`${filterItems(list.items, ui.kind, ui.filters).length} of ${plural(list.items.length, kindWords())} shown`);
}

function onClick(e) {
  const t = e.target;
  if (!t.closest) return;
  const kind = t.closest('[data-forge-kind]');
  if (kind) {
    if (kind.dataset.forgeKind === ui.kind) return;
    ui.kind = kind.dataset.forgeKind;
    ui.actNote = null;
    ui.filters = defaultFilters(ui.kind);
    paintFilters();
    // The proposals are asked for again each time (worktrees come and go); the other lists keep what they have
    if (ui.kind === 'specs') { paint(); loadList(false, true); announce(current() ? `${plural(current().items.length, 'spec')} shown` : 'Looking for proposals'); } else if (current()) filtersChanged(); else { paint(); loadList(); }
    return;
  }
  const pr = t.closest('[data-forge-pr]');
  if (pr) {
    const n = Number(pr.dataset.forgePr);
    returnTo = findAgain(pr); // the row to give the focus back to when the selection is let go of
    if (ui.selected === n) clearPull(); else selectPull(n);
    return;
  }
  const thr = t.closest('[data-forge-thread]');
  if (thr) {
    const n = Number(thr.dataset.forgeThread);
    returnTo = findAgain(thr);
    if (ui.thread === n) clearThread(); else selectThread(n);
    return;
  }
  const dep = t.closest('[data-forge-deploy]');
  if (dep) {
    returnTo = findAgain(dep);
    if (ui.deploy === dep.dataset.forgeDeploy) clearDeploy(); else selectDeploy(dep.dataset.forgeDeploy);
    return;
  }
  const nodeBtn = t.closest('[data-forge-node]');
  if (nodeBtn) {
    const node = nodeById(nodeBtn.dataset.forgeNode);
    if (!node) return;
    selectNode(node);
    centreOn(node);
    if (isPhone()) collapseSheet('forge'); // the map and the node's sheet are what is wanted now
    announce(`${node.label}, ${node.type}`);
    return;
  }
  const agent = t.closest('[data-forge-agent]');
  if (agent) { openAgent(agent.dataset.forgeAgent, `[data-forge-agent="${agent.dataset.forgeAgent}"]`); return; }
  const stop = t.closest('[data-forge-stop]');
  if (stop) { stopRun(stop.dataset.forgeStop); return; }
  const retry = t.closest('[data-forge-retry]');
  if (retry) { startAgain(retry.dataset.forgeRetry); return; }
  const goto = t.closest('[data-run-goto]');
  if (goto) { goToRun(goto.dataset.runGoto); return; }
  const answer = t.closest('[data-run-answer]');
  if (answer) { answerRun(answer.dataset.runId, answer.dataset.runAnswer); return; }
  const discard = t.closest('[data-run-discard]');
  if (discard) { discardReply(discard.dataset.runDiscard); return; }
  const pick = t.closest('[data-run-select]');
  if (pick) { selectRun(pick.dataset.runSelect); return; }
  const timeline = t.closest('[data-run-timeline]');
  if (timeline) { toggleTimeline(timeline.dataset.runTimeline); return; }
  const unland = t.closest('[data-forge-landing-cancel]');
  if (unland) { cancelLanding(Number(unland.dataset.forgeLandingCancel)); return; }
  const merge = t.closest('[data-forge-merge]');
  if (merge) { openConfirm('[data-forge-merge]'); return; }
  const spec = t.closest('[data-forge-spec]');
  if (spec) { askPlan('spec', Number(spec.dataset.forgeSpec), null, `[data-forge-spec="${spec.dataset.forgeSpec}"]`); return; }
  const build = t.closest('[data-forge-build]');
  if (build && ui.selected !== null) { askPlan('build', ui.selected, build.dataset.forgeBuild, `[data-forge-build="${build.dataset.forgeBuild}"]`); return; }
  const rerun = t.closest('[data-forge-rerun]');
  if (rerun) { rerunCheck(rerun.dataset.forgeRerun); return; }
  const action = t.closest('[data-action]');
  if (!action) return;
  if (action.dataset.action === 'close-forge') closeForge();
  else if (action.dataset.action === 'refresh-forge' || action.dataset.action === 'retry-forge') refreshForge();
  else if (action.dataset.action === 'copy-notes') copyNotes();
  else if (action.dataset.action === 'post-notes') { if (ui.notes.confirm) closeNotesConfirm(); else openNotesConfirm(); }
  else if (action.dataset.action === 'confirm-notes') postDraft();
  else if (action.dataset.action === 'cancel-notes') { closeNotesConfirm(); announce('Cancelled. Nothing was posted.'); }
  else if (action.dataset.action === 'clear-forge-pr') clearPull();
  else if (action.dataset.action === 'clear-forge-deploy') clearDeploy();
  else if (action.dataset.action === 'clear-forge-thread') clearThread();
  else if (action.dataset.action === 'toggle-filters') { ui.filtersOpen = !ui.filtersOpen; paintChip(); }
  else if (action.dataset.action === 'open-notes') openNotes();
  else if (action.dataset.action === 'close-notes') closeNotes();
  else if (action.dataset.action === 'open-proposal' && isPhone()) collapseSheet('forge'); // the proposal's own bar and the map are what is wanted now
  else if (action.dataset.action === 'idea-open') toggleIdea(!ui.idea.open);
  else if (action.dataset.action === 'idea-send') {
    // Nothing of it may escape as an unhandled rejection: what went wrong is said, and the form is usable again
    sendIdea().catch((err) => {
      ui.idea.busy = false;
      ui.idea.message = `Something went wrong in the page: ${err instanceof Error ? err.message : err}`;
      ui.idea.bad = true;
      paintIdea();
      announce(ui.idea.message);
    });
  }
  else if (action.dataset.action === 'idea-cancel') { toggleIdea(false); announce('Cancelled. Nothing was opened.'); }
}

/** The Release notes view, from the PRs list: its own page with a way back */
function openNotes() {
  ui.kind = 'notes';
  ui.actNote = null;
  if (ui.notes.data || ui.notes.loading) { paint(); announce(`Release notes. ${ui.notes.data ? notesSummary(ui.notes.data) : ''}`); } else loadNotes();
  $('notes-title').focus();
}

/** Back from the Release notes to the PRs list, the focus on the button that opened them */
function closeNotes() {
  ui.kind = 'pulls';
  paint();
  $('notes-open').focus();
  announce('All pull requests');
}

function onChange(e) {
  const id = e.target.id;
  if (id === 'notes-since') {
    ui.notes.since = e.target.value;
    ui.notes.message = '';
    loadNotes();
  } else if (id === 'forge-state') {
    ui.filters.state = e.target.value;
    paintFilters();
    if (current()) filtersChanged(); else { paint(); loadList(); }
  } else if (id === 'forge-work-agents' || id === 'forge-work-finished') {
    if (id === 'forge-work-agents') ui.workFilters.agentsOnly = e.target.checked;
    else ui.workFilters.finished = e.target.checked;
    paint();
    announce(workStatus(groupsShown(), '', now()));
  } else if (id === 'forge-label') {
    ui.filters.label = e.target.value;
    filtersChanged();
  } else if (id === 'forge-author') {
    ui.filters.author = e.target.value;
    filtersChanged();
  }
}

function onInput(e) {
  if (e.target.dataset && e.target.dataset.runReply) {
    const id = e.target.dataset.runReply;
    ui.runReplies.set(id, e.target.value);
    // "Write a reply first" goes once something is written: a refusal does not outlive what it was about
    const said = resultOf(id);
    if (said && !said.ok && e.target.value.trim()) { clearResult(id); showResultIn(e.target.closest('[data-run]') && e.target.closest('[data-run]').querySelector(`[data-run-result="${id}"]`), id); }
    return;
  }
  if (e.target.id !== 'forge-text') return;
  ui.filters.text = e.target.value;
  filtersChanged(false);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => filtersChanged(), SEARCH_ANNOUNCE_MS);
}

/** Escape anywhere in the panel closes it, and the button has the focus again (a field's own Escape comes first) */
function onKey(e) {
  if (e.key === 'Enter' && e.target.dataset && e.target.dataset.runReply && !e.defaultPrevented) { e.preventDefault(); answerRun(e.target.dataset.runReply, 'reply'); return; }
  if (e.key === 'Enter' && e.target.id === 'notes-tag' && !e.defaultPrevented) { e.preventDefault(); postDraft(); return; }
  if (e.key === 'Escape' && !e.defaultPrevented && ui.notes.confirm && e.target.closest && e.target.closest('#notes-confirm')) {
    e.preventDefault();
    closeNotesConfirm();
    announce('Cancelled. Nothing was posted.');
    return;
  }
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (e.target.closest && e.target.closest('select, input, textarea')) return;
  e.preventDefault();
  closeForge();
}

/** Any `data-action="toggle-forge"` opens and closes the panel; one listener on the page, however many times the panel is wired */
let onToggle = null;
function wireToggles() {
  if (onToggle) document.removeEventListener('click', onToggle);
  onToggle = (e) => {
    const el = e.target.closest && e.target.closest('[data-action="toggle-forge"]');
    if (!el) return;
    openerEl = el;
    toggleForge();
  };
  document.addEventListener('click', onToggle);
}

/**
 * Wires the panel (main.js calls this once the config is read). With no forge in the config, or nobody signed in,
 * the button and the panel stay hidden, and this returns false.
 * @param {{ forge?: { type: string, repo: string } | null, signIn?: false | { login: string } }} config what `/cornfield/config.json` said
 * @param {{ clock?: () => number }} [opts] `clock` for the times shown (tests)
 * @returns {boolean} whether the panel is on
 */
export function initForgePanel(config, opts = {}) {
  const panel = $('forge-panel');
  if (!config || !config.forge || !config.signIn || !panel) return false;
  ui.config = config;
  proposalHooks.openSpecs = () => openForge({ tab: 'specs' }); // a bad proposal link's way on
  if (opts.clock) now = opts.clock;
  for (const toggle of document.querySelectorAll('[data-action="toggle-forge"]')) toggle.hidden = false;
  panel.hidden = false;
  // The Specs tab lists the proposals: the account menu's Proposals entry is only for a cornfield without the panel (no forge, or no sign-in)
  const proposalsEntry = $('proposal-wrap');
  if (proposalsEntry) proposalsEntry.hidden = true;
  // `threads: false` in the config turns the tab off; a server that does not say has threads
  const threadsOn = config.threads !== false;
  const tab = panel.querySelector('[data-forge-kind="threads"]');
  if (tab) tab.hidden = !threadsOn;
  state.threadIndex = threadsOn ? { for: threadsFor, ensure: ensureThreadsList, open: openThread, start: startThread, forge: forgeName } : null;
  registerSheet('forge', panel);
  paintFilters();
  paint();
  // The map shows the open runs whether or not the panel is open: read them once now, and again now and then while any is open
  if (config.agents && config.agents.runs) {
    loadRuns(false).then(() => { if (ui.kind === 'work') paint(); }, () => {});
  }
  if (!wired) {
    wired = true;
    initConnection();
    if (typeof window !== 'undefined') window.addEventListener('online', readOnline);
    const tabs = panel.querySelector('.hx-forge-tabs');
    if (tabs) tabs.addEventListener('scroll', paintTabsMore, { passive: true });
    if (typeof window !== 'undefined') window.addEventListener('resize', paintTabsMore);
    wireToggles();
    panel.addEventListener('click', onClick);
    panel.addEventListener('change', onChange);
    panel.addEventListener('input', onInput);
    panel.addEventListener('keydown', onKey);
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', onPageHide);
      window.addEventListener('pageshow', onPageShow);
    }
    const agent = agentEl();
    if (agent) {
      agent.addEventListener('click', onAgentClick);
      agent.addEventListener('keydown', onAgentKey);
      agent.querySelector('form').addEventListener('submit', submitAgent);
      $('agent-profile').addEventListener('change', onAgentProfile);
    }
    const confirm = confirmEl();
    if (confirm) {
      confirm.addEventListener('click', onConfirmClick);
      confirm.addEventListener('keydown', onConfirmKey);
    }
    offScene = onSceneTouch(onNodesChange);
    // The header's Proposals menu reads the same list: when it is read again the Specs tab and its count follow
    offListing = onProposalListing(() => { if (ui.open) paint(); });
    // A node's panel lists the threads that mention it; a click there shows one in this panel
    const drawer = $('spec-drawer');
    if (drawer) drawer.addEventListener('click', (e) => {
      const open = e.target.closest && e.target.closest('[data-thread-open]');
      if (open && state.threadIndex) { openThread(Number(open.dataset.threadOpen)); return; }
      const start = e.target.closest && e.target.closest('[data-thread-start]');
      if (start && state.threadIndex && state.selectedNode) startThread(state.selectedNode);
    });
  }
  return true;
}

/** For tests: forget the page this was wired to, and everything shown */
export function resetForgePanelForTests(clock = () => Date.now()) {
  if (ui.confirm) closeConfirm({ restoreFocus: false });
  if (ui.agent) closeAgent({ restoreFocus: false });
  if (onToggle) document.removeEventListener('click', onToggle);
  onToggle = null;
  openerEl = null;
  primed.clear();
  shownKey = '';
  shownKind = '';
  returnTo = null;
  if (offScene) offScene();
  offScene = null;
  if (offListing) offListing();
  offListing = null;
  clearTimeout(searchTimer);
  wired = false;
  now = clock;
  listToken++;
  pullToken++;
  notesToken++;
  threadToken++;
  indexToken++;
  indexLoading = false;
  indexCache = null;
  state.forgeLit = null;
  state.threadIndex = null;
  clearTimeout(runsTimer);
  runsTimer = 0;
  pageAway = false;
  clearRunsOnMap();
  Object.assign(ui, { runSel: null, runTimelines: new Set(), runReplies: new Map(), thread: null, threadDetail: null, threadError: '', litThread: null, idea: freshIdea(), config: null, open: false, kind: 'specs', filtersOpen: false, filters: defaultFilters(), lists: {}, work: null, workFilters: { agentsOnly: false, finished: false }, loading: false, error: '', selected: null, selectedOn: '', detail: null, landing: null, detailError: '', lit: null, deploy: null, deployItem: null, litDeploy: null, nodesSeen: null, busy: '', note: null, confirm: null, actNote: null, notes: freshNotes(), runs: null, runnerSaid: null, runNote: null, agent: null, retrying: false });
  resetFeedbackForTests();
  resetConnectionForTests();
}

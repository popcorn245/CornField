/**
 * @module explorer/forge-panel
 *
 * The issues and PRs panel (CF-07, spec 0001 section 4): the repo's pull requests and issues, from whichever forge
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
 *   - Keys: Tab reaches the header button, Enter opens the panel with the focus on its title; Escape closes it and
 *     gives the focus back to the button. What happens (a list loaded, a pull request selected, what it lights, a
 *     failure) is said through the map's live region (`announce`, keyboard.js). Closed, the panel is `inert`.
 *   - Actions (CF-08), on a selected pull request, for a signed-in maintainer: Land it, when it is open, ready and every
 *     check is green, and Re-run on a failed or cancelled check the forge can run again. Where a button is not shown the panel says
 *     why. Land it opens a confirm dialog that shows exactly what will land (the pull request, its head commit, where
 *     it goes, how, each check); a scrim covers the page, the dialog is `aria-modal`, Tab stays inside, Escape and Cancel close it and give the
 *     focus back, and it is announced. What is sent is the head that was shown: a push since is refused by the server,
 *     which checks everything again (server/forge-actions.js). While one is in flight the buttons are off.
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
 * What is asked, which words and which nodes are forge-panel-model.js, tested without a page.
 */

import { state, nodeById, escHtml, touchScene, onSceneTouch } from './state.js';
import { render, isNodeVisible } from './render.js';
import { selectNode } from './panels.js';
import { announce, centreOn } from './keyboard.js';
import { isPhone, registerSheet, expandSheet, collapseSheet } from './sheets.js';
import { relativeTime } from './review-model.js';
import { LAYER_DEFS, toggleLayer } from './layers.js';
import { WORK_URL, groupWork, filterGroups, groupWords, workStatus, markWords } from './agents-model.js';
import {
  STATES, defaultFilters, listUrl, pullUrl, serverState, filterItems, facetsOf, stateWords, metaWords, checkWords, checksWords, litFor, errorWords,
  mergeBlock, rerunWhy, confirmMerge, mergeBody, actionUrl, actionWords,
  specBlock, buildOffers, planUrl, confirmSpec, confirmBuild, specBody, buildBody, existingWords,
  listKeyOf, litForDeploy, nodesForRestarts, deployWords, deployMeta,
  DRAFTS_URL, notesUrl, sinceChoices, notesSummary, validTag, confirmWords, postedWords, draftRequest,
} from './forge-panel-model.js';

const $ = (id) => document.getElementById(id);
const FORGE_NAMES = { github: 'GitHub', forgejo: 'Forgejo' };
const SEARCH_ANNOUNCE_MS = 500;

/** What is shown: the lists loaded, the filters, the selected pull request with its files and checks */
const ui = {
  config: null,
  open: false,
  kind: 'pulls',
  filters: defaultFilters(),
  lists: {}, // `${kind}|${server state}` -> { items, at, rate, stale }
  work: null, // { grouped, problem, at, rate, stale } of the Agents tab
  workFilters: { agentsOnly: false, finished: false },
  loading: false,
  error: '',
  selected: null, // the pull request's number
  detail: null, // { pull, files, checks, at, rate, stale } of the selected one
  detailError: '',
  lit: null, // litFor(detail, nodes)
  deploy: null, // the selected deploy's id; the deploy itself is `deployItem`
  deployItem: null,
  litDeploy: null, // litForDeploy(deployItem, nodes)
  nodesSeen: null, // the `state.nodes` the lights were worked out for
  busy: '', // the action in flight ('merge', or 'rerun:<check id>'), so a second click does nothing
  note: null, // { text, ok }: what the last action came to, for the selected pull request
  confirm: null, // { opener: selector, kind: 'merge' | 'spec' | 'build', plan?, n?, slug? } while the confirm dialog is open
  actNote: null, // { text, ok, url }: what the last pipeline step came to
  notes: freshNotes(), // the Release notes view
};

/** The Release notes view: the draft loaded for a tag, and where the confirm step is */
function freshNotes() {
  return { since: '', data: null, loading: false, error: '', confirm: false, posting: false, message: '', bad: false, link: null };
}

let wired = false;
let listToken = 0;
let pullToken = 0;
let notesToken = 0;
let searchTimer = null;
let offScene = null;
let now = () => Date.now();

const forgeName = () => FORGE_NAMES[ui.config && ui.config.forge && ui.config.forge.type] || 'the forge';
const listKey = () => listKeyOf(ui.kind, ui.filters.state);
const current = () => (ui.kind === 'work' ? ui.work : ui.lists[listKey()]) || null;
const groupsShown = () => (ui.work ? filterGroups(ui.work.grouped.groups, ui.workFilters) : []);
const plural = (n, word, more = `${word}s`) => `${n} ${n === 1 ? word : more}`;
const kindWords = () => ({ pulls: 'pull request', issues: 'issue', deploys: 'deploy' })[ui.kind] || 'piece of work';
/** A link only if it is the forge's web address: a forge's JSON is data, not trusted markup */
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

// ---------------------------------------------------------------------------
//  Asking the server
// ---------------------------------------------------------------------------

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
  const res = await request(WORK_URL, refresh);
  if (token !== listToken) return;
  ui.loading = false;
  if (res.ok) {
    const b = res.body;
    ui.work = { grouped: groupWork(b), problem: b.specsProblem || '', at: b.at, rate: b.rate || '', stale: b.stale || '' };
    announce(`${workStatus(groupsShown(), '', now())}${ui.work.stale ? '. This is an older answer' : ''}`);
  } else {
    ui.error = errorWords(res.status, res.body);
    announce(ui.error);
  }
  paint();
}

/** Loads the list the kind and state name (again, past the server's cache, on a refresh) */
async function loadList(refresh = false, quiet = false) {
  const token = ++listToken;
  if (ui.kind === 'work') return loadWork(refresh, token);
  const key = listKey();
  ui.loading = true;
  ui.error = '';
  paint();
  const res = await request(listUrl(ui.kind, ui.filters.state), refresh);
  if (token !== listToken) return;
  ui.loading = false;
  if (res.ok) {
    ui.lists[key] = { items: res.body.items || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '' };
    if (!quiet) announce(`${plural(filterItems(ui.lists[key].items, ui.kind, ui.filters).length, kindWords())} shown${ui.lists[key].stale ? '. This is an older answer' : ''}`);
  } else {
    ui.error = errorWords(res.status, res.body);
    if (!quiet) announce(ui.error);
  }
  paintFilters();
  paint();
}

/** Selects a pull request: asks for its files and checks, then lights what they are on the map */
async function selectPull(n) {
  const token = ++pullToken;
  ui.deploy = null;
  ui.deployItem = null;
  ui.litDeploy = null;
  ui.selected = n;
  ui.detail = null;
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
    ui.detailError = errorWords(res.status, res.body);
    announce(ui.detailError);
    paint();
    return;
  }
  ui.detail = { pull: res.body.pull, files: res.body.files || [], checks: res.body.checks || [], specs: res.body.specs || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '' };
  relight();
  $('forge-panel').querySelector('.hx-forge-body').scrollTop = 0; // the pull request's files are what was asked for, not the row that was tapped
  announce(selectionWords());
}

/** Lets go of the selected pull request: nothing is lit any more */
export function clearPull() {
  pullToken++;
  const had = ui.selected;
  if (ui.confirm) closeConfirm({ restoreFocus: false });
  ui.selected = null;
  ui.note = null;
  ui.detail = null;
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
  if (ui.deployItem) {
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
  if ((ui.detail || ui.deployItem) && state.nodes !== ui.nodesSeen) relight();
}

/** Selects a deploy: nothing to ask (the list holds what it restarted), so its nodes light at once */
export function selectDeploy(id) {
  const found = ui.lists.deploys && ui.lists.deploys.items.find((d) => d.id === id);
  if (!found) return;
  pullToken++;
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
    n.error = errorWords(res.status, res.body);
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
  say(res.status === 401 ? 'Your sign-in has ended. Sign in again to post a draft.' : errorWords(res.status, res.body), true);
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

/** The filters' choices: the states of the kind, the labels and authors of what is loaded */
function paintFilters() {
  $('forge-filters').hidden = ui.kind === 'work' || ui.kind === 'notes';
  $('forge-work-filters').hidden = ui.kind !== 'work';
  $('forge-work-agents').checked = ui.workFilters.agentsOnly;
  $('forge-work-finished').checked = ui.workFilters.finished;
  if (ui.kind === 'work' || ui.kind === 'notes') return;
  const items = current() && ui.kind !== 'deploys' ? current().items : [];
  const { labels, authors } = facetsOf(items);
  if (ui.filters.label && !labels.includes(ui.filters.label)) ui.filters.label = '';
  if (ui.filters.author && !authors.includes(ui.filters.author)) ui.filters.author = '';
  $('forge-state').innerHTML = STATES[ui.kind].map(([v, l]) => option(v, l, v === ui.filters.state)).join('');
  $('forge-label').innerHTML = option('', 'Any label', !ui.filters.label) + labels.map((l) => option(l, l, l === ui.filters.label)).join('');
  $('forge-author').innerHTML = option('', 'Anyone', !ui.filters.author) + authors.map((a) => option(a, a, a === ui.filters.author)).join('');
  // A deploy has no labels and no author to pick: its list is filtered by state and the search
  $('forge-label').parentElement.hidden = ui.kind === 'deploys';
  $('forge-author').parentElement.hidden = ui.kind === 'deploys';
  // …and its search reads the workflow, what it ran for, the branch and who started it, not a number or a label
  $('forge-text').placeholder = ui.kind === 'deploys' ? 'Workflow, branch, commit, who' : 'Title, number, label';
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
  return `<li class="hx-forge-item"><button type="button" class="hx-forge-row" data-forge-deploy="${escHtml(d.id)}" aria-pressed="${ui.deploy === d.id}">
    <span class="hx-forge-title">${escHtml(d.name)}${d.title && d.title !== d.name ? `<span class="hx-faint"> · ${escHtml(d.title)}</span>` : ''}</span>
    <span class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(d.state)}">${escHtml(deployWords(d))}</span> ${escHtml(deployMeta(d, now()))}</span>
    <span class="hx-forge-labels"><span class="hx-forge-label">${escHtml(lightsWords(d))}</span></span></button>${out}</li>`;
}

function itemHtml(item, before = '', after = '') {
  if (ui.kind === 'deploys') return deployHtml(item);
  const link = safeUrl(item.url);
  const labels = item.labels.length ? `<span class="hx-forge-labels">${item.labels.map((l) => `<span class="hx-forge-label">${escHtml(l)}</span>`).join('')}</span>` : '';
  const inner = `<span class="hx-forge-title">${escHtml(item.title)}</span>
    <span class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(item.draft ? 'draft' : item.state)}">${escHtml(stateWords(item))}</span> ${escHtml(metaWords(item, now()))}</span>${before}${after}${labels}`;
  const out = link ? `<a class="hx-forge-out" href="${escHtml(link)}" target="_blank" rel="noreferrer" aria-label="Open ${escHtml(item.head ? 'pull request' : 'issue')} ${item.number} on ${escHtml(forgeName())} (new tab)">↗</a>` : '';
  if (ui.kind !== 'issues') {
    return `<li class="hx-forge-item"><button type="button" class="hx-forge-row" data-forge-pr="${item.number}" aria-pressed="${ui.selected === item.number}">${inner}</button>${out}</li>`;
  }
  // An issue has no more to show here: its row is the link out; an open one also starts its spec (step 1 of the pipeline)
  const spec = specBlock(item) === null
    ? `<button type="button" class="hx-btn hx-forge-act hx-forge-startspec" data-forge-spec="${item.number}" aria-label="Start a spec for issue ${item.number}"${ui.busy ? ' disabled' : ''}>Start a spec …</button>`
    : '';
  return link
    ? `<li class="hx-forge-item"><a class="hx-forge-row" href="${escHtml(link)}" target="_blank" rel="noreferrer">${inner}<span class="hx-sr-only"> (opens ${escHtml(forgeName())} in a new tab)</span></a>${spec}</li>`
    : `<li class="hx-forge-item"><div class="hx-forge-row">${inner}</div>${spec}</li>`;
}

/** One piece of work in a group: a pull request (a row that selects it, as in the Pull requests tab) or a branch with none */
function workHtml(e) {
  const mark = e.mark ? `<span class="hx-forge-agentline"><span class="hx-forge-agent" title="Agent-made: ${escHtml(markWords(e.mark))}">Agent</span><span class="hx-forge-why hx-faint">${escHtml(markWords(e.mark))}</span></span>` : '';
  if (e.type === 'pull') {
    const also = e.issues.slice(1);
    const note = [e.proposal ? `Spec PR for ${e.proposal}` : '', also.length ? `Also closes ${also.map((n) => `#${n}`).join(', ')}` : ''].filter(Boolean);
    return itemHtml(e.pull, mark, note.length ? `<span class="hx-forge-meta">${escHtml(note.join(' · '))}</span>` : '');
  }
  return `<li class="hx-forge-item"><div class="hx-forge-row hx-forge-branch"><span class="hx-forge-title"><span class="hx-sr-only">Branch </span><code class="hx-code">${escHtml(e.branch.name)}</code></span><span class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--draft">Branch</span> no pull request yet</span>${mark}</div></li>`;
}

/** The Agents tab's groups, each a heading and its work */
function groupsHtml(groups) {
  return groups.map((g, i) => {
    const link = g.issue && safeUrl(g.issue.url) ? ` <a class="hx-link hx-forge-gout" href="${escHtml(g.issue.url)}" target="_blank" rel="noreferrer" aria-label="Open issue ${g.number} on ${escHtml(forgeName())} (new tab)">↗</a>` : '';
    return `<li class="hx-forge-group"><h3 class="hx-forge-gtitle" id="forge-group-${i}">${escHtml(g.title)}${link}</h3><p class="hx-forge-meta">${escHtml(groupWords(g))}</p><ul class="hx-forge-list" aria-labelledby="forge-group-${i}">${g.entries.map(workHtml).join('')}</ul></li>`;
  }).join('');
}

/** The selected pull request: its checks, its files and the nodes they are */
/** The selected deploy: what it was, and the nodes it restarted (each a button that selects it on the map) */
function deployDetailHtml() {
  const d = ui.deployItem;
  const lit = ui.litDeploy;
  const url = safeUrl(d.url);
  const head = `<div class="hx-forge-detail-head"><h3 class="hx-forge-detail-title">${escHtml(d.name)}</h3><button type="button" class="hx-btn hx-btn--quiet" data-action="clear-forge-deploy">Clear</button></div>
    <p class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(d.state)}">${escHtml(deployWords(d))}</span> ${escHtml(deployMeta(d, now()))}${url ? ` · <a class="hx-link" href="${escHtml(url)}" target="_blank" rel="noreferrer">Open on ${escHtml(forgeName())} ↗</a>` : ''}</p>`;
  const stale = ui.lists.deploys && ui.lists.deploys.stale;
  let body;
  if (!d.restarts.length) {
    body = '<p class="hx-forge-notice">No node is mapped to this deploy, so nothing is lit. Say what it restarts under <code class="hx-code">deploys.restarts</code> in cornfield.config.js (docs/deploys.md).</p>';
  } else {
    const rows = lit.nodes.map((n) => `<li class="hx-forge-file"><button type="button" class="hx-forge-node" data-forge-node="${escHtml(n.id)}" aria-label="Show ${escHtml(n.label)} on the map${isNodeVisible(n) ? '' : ' (its layer is off)'}">${escHtml(n.label)}${isNodeVisible(n) ? '' : ' · layer off'}</button> <span class="hx-faint">${escHtml(n.type)}</span></li>`).join('');
    const missing = lit.missing.length ? `<p class="hx-forge-notice">${escHtml(lit.missing.join(', '))} ${lit.missing.length === 1 ? 'is' : 'are'} named in the config but not on the map.</p>` : '';
    const key = lit.nodes.length ? `<p class="hx-forge-key hx-faint"><span class="hx-mark-dot hx-mark-dot--${d.state === 'failure' ? 'removed' : 'changed'}" aria-hidden="true"></span>${d.state === 'failure' ? 'restarted by a deploy that failed' : 'restarted by this deploy'}</p>` : '';
    body = `<h4 class="hx-forge-sub">${escHtml(`Restarted: ${plural(lit.nodes.length, 'node')} on the map`)}</h4>${key}${rows ? `<ul class="hx-forge-files">${rows}</ul>` : ''}${missing}`;
  }
  return `${head}${stale ? `<p class="hx-forge-notice">${escHtml(`This is an older answer. ${stale}`)}</p>` : ''}${body}`;
}

function detailHtml() {
  if (ui.deployItem) return deployDetailHtml();
  if (ui.selected === null) return '';
  const head = (title, link) => `<div class="hx-forge-detail-head"><h3 class="hx-forge-detail-title">${title}</h3><button type="button" class="hx-btn hx-btn--quiet" data-action="clear-forge-pr">Clear</button></div>${link || ''}`;
  if (ui.detailError) return `${head(`Pull request ${ui.selected}`)}<p class="hx-forge-notice">${escHtml(ui.detailError)}</p>`;
  if (!ui.detail) return `${head(`Pull request ${ui.selected}`)}<p class="hx-faint">Loading its files and checks …</p>`;
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
    return `<li class="hx-forge-check"><span class="hx-forge-state hx-forge-state--${escHtml(c.state)}">${escHtml(checkWords(c))}</span> ${name}${again}${lights}${whyNot}</li>`;
  }).join('');

  const fileRows = lit.files.map((f) => {
    const nodes = f.nodes.length
      ? f.nodes.map((n) => `<button type="button" class="hx-forge-node" data-forge-node="${escHtml(n.id)}" aria-label="Show ${escHtml(n.label)} on the map${isNodeVisible(n) ? '' : ' (its layer is off)'}">${escHtml(n.label)}${isNodeVisible(n) ? '' : ' · layer off'}</button>`).join('')
      : '<span class="hx-faint">not on the map</span>';
    const renamed = f.status === 'renamed' && f.previousPath ? `<span class="hx-faint"> from ${escHtml(f.previousPath)}</span>` : '';
    return `<li class="hx-forge-file"><span class="hx-forge-fstatus">${escHtml(f.status)}</span> <code class="hx-code">${escHtml(f.path)}</code>${renamed} <span class="hx-good">+${f.additions}</span> <span class="hx-forge-del">−${f.deletions}</span><span class="hx-forge-nodes">${nodes}</span></li>`;
  }).join('');

  const block = mergeBlock(ui.detail);
  const act = block
    ? `<p class="hx-forge-why hx-faint">${pull.state === 'merged' ? '' : 'Cannot be landed from here. '}${escHtml(block)}</p>`
    : `<button type="button" class="hx-btn hx-btn--approve hx-forge-act" data-forge-merge="${pull.number}"${ui.busy ? ' disabled' : ''}>Land it …</button><p class="hx-forge-why hx-faint">Opens a confirm step that shows what will land. Never forced, never deployed.</p>`;
  const note = ui.note ? `<p class="hx-forge-notice${ui.note.ok ? ' hx-forge-notice--ok' : ''}">${escHtml(ui.note.text)}</p>` : '';
  // Step 2 of the pipeline: a spec pull request with an approved proposal opens its build issue
  const offers = buildOffers(ui.detail);
  const build = offers.length
    ? `<h4 class="hx-forge-subact">Build issue</h4>${offers.map((o) => (o.offer
      ? `<div class="hx-forge-step"><button type="button" class="hx-btn hx-btn--approve hx-forge-act" data-forge-build="${escHtml(o.slug)}" aria-label="Open the build issue for ${escHtml(o.slug)}"${ui.busy ? ' disabled' : ''}>Open the build issue …</button><p class="hx-forge-why hx-faint"><code class="hx-code">${escHtml(o.slug)}</code> is approved. Opens a confirm step that shows the issue. Nothing is built.</p></div>`
      : `<p class="hx-forge-why hx-faint"><code class="hx-code">${escHtml(o.slug)}</code>: ${escHtml(o.why)}</p>`)).join('')}`
    : '';

  const key = lit.changed.size || lit.failing.size
    ? `<p class="hx-forge-key hx-faint"><span class="hx-mark-dot hx-mark-dot--changed" aria-hidden="true"></span>a file this pull request changes <span class="hx-mark-dot hx-mark-dot--removed" aria-hidden="true"></span>a test a failing check names</p>`
    : '';
  return `${head(`#${pull.number} ${escHtml(pull.title)}`, `<p class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(pull.draft ? 'draft' : pull.state)}">${escHtml(stateWords(pull))}</span> ${escHtml(pull.head.ref)} → ${escHtml(pull.base.ref)}${url ? ` · <a class="hx-link" href="${escHtml(url)}" target="_blank" rel="noreferrer">Open on ${escHtml(forgeName())} ↗</a>` : ''}</p>`)}
    ${stale ? `<p class="hx-forge-notice">${escHtml(`This is an older answer. ${stale}`)}</p>` : ''}
    <h4 class="hx-forge-sub">Checks: ${escHtml(checksWords(checks))}</h4>
    ${checks.length ? `<ul class="hx-forge-checks">${checkRows}</ul>` : ''}
    ${build}
    <h4 class="hx-forge-subact">Land it</h4>
    ${note}
    ${act}
    <h4 class="hx-forge-sub">${escHtml(plural(lit.files.length, 'file'))} changed, ${mapped} on the map</h4>
    ${key}
    <ul class="hx-forge-files">${fileRows}</ul>`;
}

/** How to find an element of the panel again after it is drawn anew, or null */
function findAgain(el) {
  if (!el || !el.dataset) return null;
  if (el.dataset.forgePr) return `[data-forge-pr="${el.dataset.forgePr}"]`;
  if (el.dataset.forgeDeploy) return `[data-forge-deploy="${el.dataset.forgeDeploy}"]`;
  if (el.dataset.forgeNode) return `[data-forge-node="${el.dataset.forgeNode}"]`;
  if (el.dataset.forgeMerge) return '[data-forge-merge]';
  if (el.dataset.forgeSpec) return `[data-forge-spec="${el.dataset.forgeSpec}"]`;
  if (el.dataset.forgeBuild) return `[data-forge-build="${el.dataset.forgeBuild}"]`;
  if (el.dataset.forgeRerun) return `[data-forge-rerun="${el.dataset.forgeRerun}"]`;
  return null;
}

/** Everything the panel shows, from `ui` (a row or node button that had the focus has it again) */
function paint() {
  const panel = $('forge-panel');
  if (!panel) return;
  const again = panel.contains(document.activeElement) ? findAgain(document.activeElement) : null;
  draw(panel);
  const back = again && panel.querySelector(again);
  if (back && back !== document.activeElement) back.focus();
}

function draw(panel) {
  for (const btn of panel.querySelectorAll('[data-forge-kind]')) btn.setAttribute('aria-pressed', String(btn.dataset.forgeKind === ui.kind));
  const notes = ui.kind === 'notes';
  $('forge-filters').hidden = notes || ui.kind === 'work';
  $('forge-work-filters').hidden = ui.kind !== 'work';
  $('forge-list').hidden = notes;
  $('forge-notes').hidden = !notes;
  if (notes) {
    drawNotes();
    return;
  }

  const list = current();
  const work = ui.kind === 'work';
  const groups = work ? groupsShown() : [];
  const shown = list && !work ? filterItems(list.items, ui.kind, ui.filters) : [];
  const status = $('forge-status');
  if (ui.loading && !list) status.textContent = work ? `Loading the work from ${forgeName()} …` : `Loading ${kindWords()}s from ${forgeName()} …`;
  else if (!list) status.textContent = '';
  else if (work) status.textContent = workStatus(groups, list.at, now());
  else status.textContent = `${shown.length} of ${plural(list.items.length, kindWords())}${list.at ? `, as of ${relativeTime(list.at, now())}` : ''}`;

  const notice = $('forge-notice');
  const words = ui.error || (list && list.stale ? `Showing an older answer. ${list.stale}` : '') || (work && list && list.problem ? `Spec pull requests could not all be read: ${list.problem}` : '');
  notice.hidden = !words;
  notice.textContent = words;

  const act = $('forge-act-note');
  if (act) {
    act.hidden = !ui.actNote;
    const link = ui.actNote && safeUrl(ui.actNote.url);
    act.className = `hx-forge-notice${ui.actNote && ui.actNote.ok ? ' hx-forge-notice--ok' : ''}`;
    act.innerHTML = ui.actNote ? `${escHtml(ui.actNote.text)}${link ? ` <a class="hx-link" href="${escHtml(link)}" target="_blank" rel="noreferrer">Open on ${escHtml(forgeName())} ↗</a>` : ''}` : '';
  }

  const rows = $('forge-list');
  if (!list) rows.innerHTML = '';
  else if (work) rows.innerHTML = groups.length ? groupsHtml(groups) : `<li class="hx-forge-empty hx-faint">${ui.work.grouped.groups.length ? 'No work matches these filters.' : 'No work here yet.'}</li>`;
  else rows.innerHTML = shown.length ? shown.map((i) => itemHtml(i)).join('') : `<li class="hx-forge-empty hx-faint">${list.items.length ? `No ${kindWords()} matches these filters.` : `No ${kindWords()}s here.`}</li>`;

  const detail = $('forge-detail');
  detail.hidden = ui.selected === null && !ui.deployItem;
  detail.setAttribute('aria-label', ui.deployItem ? 'Selected deploy' : 'Selected pull request');
  detail.innerHTML = detailHtml();

  const rate = (ui.detail && ui.detail.rate) || (list && list.rate) || '';
  $('forge-rate').textContent = rate;
  paintButton();
}

/** The panel's lines for the Release notes view: the status, a failure, the rate limit; the rest is paintNotes */
function drawNotes() {
  const n = ui.notes;
  $('forge-status').textContent = n.loading && !n.data ? `Drafting the release notes from ${forgeName()} …` : n.data ? notesSummary(n.data) : '';
  const notice = $('forge-notice');
  const words = n.error || (n.data && n.data.stale ? `Showing an older answer. ${n.data.stale}` : '');
  notice.hidden = !words;
  notice.textContent = words;
  $('forge-detail').hidden = true;
  $('forge-rate').textContent = (n.data && n.data.rate) || '';
  paintNotes();
  paintButton();
}

/** The header button says which pull request is lit */
function paintButton() {
  const btn = $('forge-btn');
  if (!btn) return;
  const lit = ui.selected !== null || !!ui.deployItem;
  const tag = $('forge-btn-lit');
  tag.hidden = !lit;
  tag.textContent = ui.deployItem ? 'deploy' : lit ? `#${ui.selected}` : '';
  btn.setAttribute('aria-label', ui.deployItem ? 'Issues and pull requests, a deploy selected' : lit ? `Issues and pull requests, pull request ${ui.selected} selected` : 'Issues and pull requests');
  btn.setAttribute('aria-expanded', String(ui.open));
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
    ${(what.checks || []).length ? `<ul class="hx-confirm-checks">${what.checks.map((c) => `<li><span class="hx-forge-state hx-forge-state--success">${escHtml(c.words)}</span> ${escHtml(c.name)}</li>`).join('')}</ul>` : ''}
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
  showConfirm(confirmMerge(ui.detail, forgeName(), ui.config && ui.config.forge && ui.config.forge.mergeMethod), 'Land it', { opener, kind: 'merge' });
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
  if (e.key !== 'Tab') return;
  const buttons = [...confirmEl().querySelectorAll('button:not([disabled])')];
  if (!buttons.length) { e.preventDefault(); return; }
  const at = buttons.indexOf(document.activeElement);
  const next = e.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at === -1 || at === buttons.length - 1 ? 0 : at + 1);
  e.preventDefault();
  buttons[next].focus();
}

function onConfirmClick(e) {
  const t = e.target;
  if (t === confirmEl()) { if (!ui.busy) closeConfirm(); return; } // the scrim
  const action = t.closest && t.closest('[data-action]');
  if (!action) return;
  if (action.dataset.action === 'forge-confirm-cancel') { if (!ui.busy) closeConfirm(); } else if (action.dataset.action === 'forge-confirm-go') { if (ui.confirm && ui.confirm.kind === 'merge') confirmedMerge(); else confirmedStep(); }
}

// ---------------------------------------------------------------------------
//  Opening and closing
// ---------------------------------------------------------------------------

export const isForgeOpen = () => ui.open;

/** Opens the panel with the focus on its title; the first time, loads the pull requests */
export function openForge() {
  const panel = $('forge-panel');
  if (!panel || panel.hidden) return;
  ui.open = true;
  panel.inert = false;
  panel.classList.add('forge-open');
  if (isPhone()) expandSheet('forge');
  paintButton();
  const title = $('forge-title');
  title.focus();
  announce('Issues and pull requests');
  if (ui.kind === 'notes') { if (!ui.notes.data && !ui.notes.loading) loadNotes(); else paint(); return; }
  if (!current()) { paintFilters(); loadList(); } else paint();
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
  if (restoreFocus && hadFocus) $('forge-btn').focus();
  announce('Issues and pull requests closed');
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
  if (n !== null && ui.selected === n) {
    const token = ++pullToken;
    const res = await request(pullUrl(n), true);
    if (token !== pullToken || !res.ok) return;
    ui.detail = { pull: res.body.pull, files: res.body.files || [], checks: res.body.checks || [], specs: res.body.specs || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '' };
    relight();
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
    if (kind.dataset.forgeKind === 'notes') {
      ui.kind = 'notes';
      if (ui.notes.data || ui.notes.loading) { paint(); announce(`Release notes. ${ui.notes.data ? notesSummary(ui.notes.data) : ''}`); } else loadNotes();
      return;
    }
    ui.kind = kind.dataset.forgeKind;
    ui.actNote = null;
    ui.filters = defaultFilters(ui.kind);
    paintFilters();
    if (current()) filtersChanged(); else { paint(); loadList(); }
    return;
  }
  const pr = t.closest('[data-forge-pr]');
  if (pr) {
    const n = Number(pr.dataset.forgePr);
    if (ui.selected === n) clearPull(); else selectPull(n);
    return;
  }
  const dep = t.closest('[data-forge-deploy]');
  if (dep) {
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
  else if (action.dataset.action === 'refresh-forge') refreshForge();
  else if (action.dataset.action === 'copy-notes') copyNotes();
  else if (action.dataset.action === 'post-notes') { if (ui.notes.confirm) closeNotesConfirm(); else openNotesConfirm(); }
  else if (action.dataset.action === 'confirm-notes') postDraft();
  else if (action.dataset.action === 'cancel-notes') { closeNotesConfirm(); announce('Cancelled. Nothing was posted.'); }
  else if (action.dataset.action === 'clear-forge-pr') { clearPull(); $('forge-title').focus(); }
  else if (action.dataset.action === 'clear-forge-deploy') { clearDeploy(); $('forge-title').focus(); }
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
  if (e.target.id !== 'forge-text') return;
  ui.filters.text = e.target.value;
  filtersChanged(false);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => filtersChanged(), SEARCH_ANNOUNCE_MS);
}

/** Escape anywhere in the panel closes it, and the button has the focus again (a field's own Escape comes first) */
function onKey(e) {
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

/**
 * Wires the panel (main.js calls this once the config is read). With no forge in the config, or nobody signed in,
 * the button and the panel stay hidden, and this returns false.
 * @param {{ forge?: { type: string, repo: string } | null, signIn?: false | { login: string } }} config what `/cornfield/config.json` said
 * @param {{ clock?: () => number }} [opts] `clock` for the times shown (tests)
 * @returns {boolean} whether the panel is on
 */
export function initForgePanel(config, opts = {}) {
  const btn = $('forge-btn');
  const panel = $('forge-panel');
  if (!config || !config.forge || !config.signIn || !btn || !panel) return false;
  ui.config = config;
  if (opts.clock) now = opts.clock;
  btn.hidden = false;
  panel.hidden = false;
  registerSheet('forge', panel);
  paintFilters();
  paint();
  if (!wired) {
    wired = true;
    btn.addEventListener('click', toggleForge);
    panel.addEventListener('click', onClick);
    panel.addEventListener('change', onChange);
    panel.addEventListener('input', onInput);
    panel.addEventListener('keydown', onKey);
    const confirm = confirmEl();
    if (confirm) {
      confirm.addEventListener('click', onConfirmClick);
      confirm.addEventListener('keydown', onConfirmKey);
    }
    offScene = onSceneTouch(onNodesChange);
  }
  return true;
}

/** For tests: forget the page this was wired to, and everything shown */
export function resetForgePanelForTests(clock = () => Date.now()) {
  if (ui.confirm) closeConfirm({ restoreFocus: false });
  if (offScene) offScene();
  offScene = null;
  clearTimeout(searchTimer);
  wired = false;
  now = clock;
  listToken++;
  pullToken++;
  notesToken++;
  state.forgeLit = null;
  Object.assign(ui, { config: null, open: false, kind: 'pulls', filters: defaultFilters(), lists: {}, work: null, workFilters: { agentsOnly: false, finished: false }, loading: false, error: '', selected: null, detail: null, detailError: '', lit: null, deploy: null, deployItem: null, litDeploy: null, nodesSeen: null, busy: '', note: null, confirm: null, actNote: null, notes: freshNotes() });
}

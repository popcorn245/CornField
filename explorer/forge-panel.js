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
 *   - A third list, Deploys (PIPE-03, docs/deploys.md): the latest workflow runs that are deploys, each with the nodes
 *     the config says it restarted. Selecting one lights those nodes (a stack brings its containers; a failed deploy lights
 *     them red) through the same paint path, turning on the layers they are on; a deploy no `deploys.restarts` names is listed and says it lights nothing.
 *     Only one thing is selected at a time, a pull request or a deploy.
 *   - Keys: Tab reaches the header button, Enter opens the panel with the focus on its title; Escape closes it and
 *     gives the focus back to the button. What happens (a list loaded, a pull request selected, what it lights, a
 *     failure) is said through the map's live region (`announce`, keyboard.js). Closed, the panel is `inert`.
 *   - Errors and rate limits are a line in the panel, in the words the server gives; a stale answer says it is old.
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
import {
  STATES, defaultFilters, listUrl, listKeyOf, pullUrl, filterItems, facetsOf, stateWords, metaWords, checkWords, checksWords, litFor, errorWords,
  litForDeploy, nodesForRestarts, deployWords, deployMeta,
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
};

let wired = false;
let listToken = 0;
let pullToken = 0;
let searchTimer = null;
let offScene = null;
let now = () => Date.now();

const forgeName = () => FORGE_NAMES[ui.config && ui.config.forge && ui.config.forge.type] || 'the forge';
const listKey = () => listKeyOf(ui.kind, ui.filters.state);
const current = () => ui.lists[listKey()] || null;
const plural = (n, word, more = `${word}s`) => `${n} ${n === 1 ? word : more}`;
const kindWords = () => ({ pulls: 'pull request', issues: 'issue', deploys: 'deploy' })[ui.kind];
/** A link only if it is the forge's web address: a forge's JSON is data, not trusted markup */
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

// ---------------------------------------------------------------------------
//  Asking the server
// ---------------------------------------------------------------------------

/** One GET; `{ ok, status, body }`, with a status of null when the server did not answer */
async function request(url, refresh) {
  try {
    // Refresh sends `Cache-Control: no-cache`, which the server takes as "ask the forge again"
    const res = await fetch(url, refresh ? { cache: 'reload' } : {});
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    return { ok: !!res.ok && !!body && body.ok !== false, status: res.status, body };
  } catch {
    return { ok: false, status: null, body: null };
  }
}

/** Loads the list the kind and state name (again, past the server's cache, on a refresh) */
async function loadList(refresh = false) {
  const token = ++listToken;
  const key = listKey();
  ui.loading = true;
  ui.error = '';
  paint();
  const res = await request(listUrl(ui.kind, ui.filters.state), refresh);
  if (token !== listToken) return;
  ui.loading = false;
  if (res.ok) {
    ui.lists[key] = { items: res.body.items || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '' };
    announce(`${plural(filterItems(ui.lists[key].items, ui.kind, ui.filters).length, kindWords())} shown${ui.lists[key].stale ? '. This is an older answer' : ''}`);
  } else {
    ui.error = errorWords(res.status, res.body);
    announce(ui.error);
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
  ui.detail = { pull: res.body.pull, files: res.body.files || [], checks: res.body.checks || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '' };
  relight();
  $('forge-panel').querySelector('.hx-forge-body').scrollTop = 0; // the pull request's files are what was asked for, not the row that was tapped
  announce(selectionWords());
}

/** Lets go of the selected pull request: nothing is lit any more */
export function clearPull() {
  pullToken++;
  const had = ui.selected;
  ui.selected = null;
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
//  Drawing
// ---------------------------------------------------------------------------

const option = (value, label, on) => `<option value="${escHtml(value)}"${on ? ' selected' : ''}>${escHtml(label)}</option>`;

/** The filters' choices: the states of the kind, the labels and authors of what is loaded */
function paintFilters() {
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

function itemHtml(item) {
  if (ui.kind === 'deploys') return deployHtml(item);
  const link = safeUrl(item.url);
  const labels = item.labels.length ? `<span class="hx-forge-labels">${item.labels.map((l) => `<span class="hx-forge-label">${escHtml(l)}</span>`).join('')}</span>` : '';
  const inner = `<span class="hx-forge-title">${escHtml(item.title)}</span>
    <span class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(item.draft ? 'draft' : item.state)}">${escHtml(stateWords(item))}</span> ${escHtml(metaWords(item, now()))}</span>${labels}`;
  const out = link ? `<a class="hx-forge-out" href="${escHtml(link)}" target="_blank" rel="noreferrer" aria-label="Open ${escHtml(kindWords())} ${item.number} on ${escHtml(forgeName())} (new tab)">↗</a>` : '';
  if (ui.kind === 'pulls') {
    return `<li class="hx-forge-item"><button type="button" class="hx-forge-row" data-forge-pr="${item.number}" aria-pressed="${ui.selected === item.number}">${inner}</button>${out}</li>`;
  }
  // An issue has no more to show here: its row is the link out
  return link
    ? `<li class="hx-forge-item"><a class="hx-forge-row" href="${escHtml(link)}" target="_blank" rel="noreferrer">${inner}<span class="hx-sr-only"> (opens ${escHtml(forgeName())} in a new tab)</span></a></li>`
    : `<li class="hx-forge-item"><div class="hx-forge-row">${inner}</div></li>`;
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
    return `<li class="hx-forge-check"><span class="hx-forge-state hx-forge-state--${escHtml(c.state)}">${escHtml(checkWords(c))}</span> ${name}${lights}</li>`;
  }).join('');

  const fileRows = lit.files.map((f) => {
    const nodes = f.nodes.length
      ? f.nodes.map((n) => `<button type="button" class="hx-forge-node" data-forge-node="${escHtml(n.id)}" aria-label="Show ${escHtml(n.label)} on the map${isNodeVisible(n) ? '' : ' (its layer is off)'}">${escHtml(n.label)}${isNodeVisible(n) ? '' : ' · layer off'}</button>`).join('')
      : '<span class="hx-faint">not on the map</span>';
    const renamed = f.status === 'renamed' && f.previousPath ? `<span class="hx-faint"> from ${escHtml(f.previousPath)}</span>` : '';
    return `<li class="hx-forge-file"><span class="hx-forge-fstatus">${escHtml(f.status)}</span> <code class="hx-code">${escHtml(f.path)}</code>${renamed} <span class="hx-good">+${f.additions}</span> <span class="hx-forge-del">−${f.deletions}</span><span class="hx-forge-nodes">${nodes}</span></li>`;
  }).join('');

  const key = lit.changed.size || lit.failing.size
    ? `<p class="hx-forge-key hx-faint"><span class="hx-mark-dot hx-mark-dot--changed" aria-hidden="true"></span>a file this pull request changes <span class="hx-mark-dot hx-mark-dot--removed" aria-hidden="true"></span>a test a failing check names</p>`
    : '';
  return `${head(`#${pull.number} ${escHtml(pull.title)}`, `<p class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(pull.draft ? 'draft' : pull.state)}">${escHtml(stateWords(pull))}</span> ${escHtml(pull.head.ref)} → ${escHtml(pull.base.ref)}${url ? ` · <a class="hx-link" href="${escHtml(url)}" target="_blank" rel="noreferrer">Open on ${escHtml(forgeName())} ↗</a>` : ''}</p>`)}
    ${stale ? `<p class="hx-forge-notice">${escHtml(`This is an older answer. ${stale}`)}</p>` : ''}
    <h4 class="hx-forge-sub">Checks: ${escHtml(checksWords(checks))}</h4>
    ${checks.length ? `<ul class="hx-forge-checks">${checkRows}</ul>` : ''}
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

  const list = current();
  const shown = list ? filterItems(list.items, ui.kind, ui.filters) : [];
  const status = $('forge-status');
  if (ui.loading && !list) status.textContent = `Loading ${kindWords()}s from ${forgeName()} …`;
  else if (!list) status.textContent = '';
  else status.textContent = `${shown.length} of ${plural(list.items.length, kindWords())}${list.at ? `, as of ${relativeTime(list.at, now())}` : ''}`;

  const notice = $('forge-notice');
  const words = ui.error || (list && list.stale ? `Showing an older answer. ${list.stale}` : '');
  notice.hidden = !words;
  notice.textContent = words;

  const rows = $('forge-list');
  if (!list) rows.innerHTML = '';
  else rows.innerHTML = shown.length ? shown.map(itemHtml).join('') : `<li class="hx-forge-empty hx-faint">${list.items.length ? `No ${kindWords()} matches these filters.` : `No ${kindWords()}s here.`}</li>`;

  const detail = $('forge-detail');
  detail.hidden = ui.selected === null && !ui.deployItem;
  detail.setAttribute('aria-label', ui.deployItem ? 'Selected deploy' : 'Selected pull request');
  detail.innerHTML = detailHtml();

  const rate = (ui.detail && ui.detail.rate) || (list && list.rate) || '';
  $('forge-rate').textContent = rate;
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
export async function refreshForge() {
  announce('Asking the forge again');
  const n = ui.selected;
  await loadList(true);
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
    ui.detail = { pull: res.body.pull, files: res.body.files || [], checks: res.body.checks || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '' };
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
  if (announceNow && list) announce(`${filterItems(list.items, ui.kind, ui.filters).length} of ${plural(list.items.length, kindWords())} shown`);
}

function onClick(e) {
  const t = e.target;
  if (!t.closest) return;
  const kind = t.closest('[data-forge-kind]');
  if (kind) {
    if (kind.dataset.forgeKind === ui.kind) return;
    ui.kind = kind.dataset.forgeKind;
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
  const action = t.closest('[data-action]');
  if (!action) return;
  if (action.dataset.action === 'close-forge') closeForge();
  else if (action.dataset.action === 'refresh-forge') refreshForge();
  else if (action.dataset.action === 'clear-forge-pr') { clearPull(); $('forge-title').focus(); }
  else if (action.dataset.action === 'clear-forge-deploy') { clearDeploy(); $('forge-title').focus(); }
}

function onChange(e) {
  const id = e.target.id;
  if (id === 'forge-state') {
    ui.filters.state = e.target.value;
    paintFilters();
    if (current()) filtersChanged(); else { paint(); loadList(); }
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
    offScene = onSceneTouch(onNodesChange);
  }
  return true;
}

/** For tests: forget the page this was wired to, and everything shown */
export function resetForgePanelForTests(clock = () => Date.now()) {
  if (offScene) offScene();
  offScene = null;
  clearTimeout(searchTimer);
  wired = false;
  now = clock;
  listToken++;
  pullToken++;
  state.forgeLit = null;
  Object.assign(ui, { config: null, open: false, kind: 'pulls', filters: defaultFilters(), lists: {}, loading: false, error: '', selected: null, detail: null, detailError: '', lit: null, deploy: null, deployItem: null, litDeploy: null, nodesSeen: null });
}

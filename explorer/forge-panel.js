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
 *
 * What is asked, which words and which nodes are forge-panel-model.js, tested without a page.
 */

import { state, nodeById, escHtml, touchScene, onSceneTouch } from './state.js';
import { render, isNodeVisible } from './render.js';
import { selectNode } from './panels.js';
import { announce, centreOn } from './keyboard.js';
import { isPhone, registerSheet, expandSheet, collapseSheet } from './sheets.js';
import { relativeTime } from './review-model.js';
import {
  STATES, defaultFilters, listUrl, pullUrl, serverState, filterItems, facetsOf, stateWords, metaWords, checkWords, checksWords, litFor, errorWords,
  mergeBlock, rerunWhy, confirmMerge, mergeBody, actionUrl, actionWords,
  specBlock, buildOffers, planUrl, confirmSpec, confirmBuild, specBody, buildBody, existingWords,
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
  nodesSeen: null, // the `state.nodes` the lights were worked out for
  busy: '', // the action in flight ('merge', or 'rerun:<check id>'), so a second click does nothing
  note: null, // { text, ok }: what the last action came to, for the selected pull request
  confirm: null, // { opener: selector, kind: 'merge' | 'spec' | 'build', plan?, n?, slug? } while the confirm dialog is open
  actNote: null, // { text, ok, url }: what the last pipeline step came to
};

let wired = false;
let listToken = 0;
let pullToken = 0;
let searchTimer = null;
let offScene = null;
let now = () => Date.now();

const forgeName = () => FORGE_NAMES[ui.config && ui.config.forge && ui.config.forge.type] || 'the forge';
const listKey = () => `${ui.kind}|${serverState(ui.filters.state)}`;
const current = () => ui.lists[listKey()] || null;
const plural = (n, word, more = `${word}s`) => `${n} ${n === 1 ? word : more}`;
const kindWords = () => (ui.kind === 'pulls' ? 'pull request' : 'issue');
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
async function loadList(refresh = false, quiet = false) {
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
  if (ui.detail) {
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
  if (ui.detail && state.nodes !== ui.nodesSeen) relight();
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
  const items = current() ? current().items : [];
  const { labels, authors } = facetsOf(items);
  if (ui.filters.label && !labels.includes(ui.filters.label)) ui.filters.label = '';
  if (ui.filters.author && !authors.includes(ui.filters.author)) ui.filters.author = '';
  $('forge-state').innerHTML = STATES[ui.kind].map(([v, l]) => option(v, l, v === ui.filters.state)).join('');
  $('forge-label').innerHTML = option('', 'Any label', !ui.filters.label) + labels.map((l) => option(l, l, l === ui.filters.label)).join('');
  $('forge-author').innerHTML = option('', 'Anyone', !ui.filters.author) + authors.map((a) => option(a, a, a === ui.filters.author)).join('');
}

function itemHtml(item) {
  const link = safeUrl(item.url);
  const labels = item.labels.length ? `<span class="hx-forge-labels">${item.labels.map((l) => `<span class="hx-forge-label">${escHtml(l)}</span>`).join('')}</span>` : '';
  const inner = `<span class="hx-forge-title">${escHtml(item.title)}</span>
    <span class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(item.draft ? 'draft' : item.state)}">${escHtml(stateWords(item))}</span> ${escHtml(metaWords(item, now()))}</span>${labels}`;
  const out = link ? `<a class="hx-forge-out" href="${escHtml(link)}" target="_blank" rel="noreferrer" aria-label="Open ${escHtml(kindWords())} ${item.number} on ${escHtml(forgeName())} (new tab)">↗</a>` : '';
  if (ui.kind === 'pulls') {
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

/** The selected pull request: its checks, its files and the nodes they are */
function detailHtml() {
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

  const act = $('forge-act-note');
  if (act) {
    act.hidden = !ui.actNote;
    const link = ui.actNote && safeUrl(ui.actNote.url);
    act.className = `hx-forge-notice${ui.actNote && ui.actNote.ok ? ' hx-forge-notice--ok' : ''}`;
    act.innerHTML = ui.actNote ? `${escHtml(ui.actNote.text)}${link ? ` <a class="hx-link" href="${escHtml(link)}" target="_blank" rel="noreferrer">Open on ${escHtml(forgeName())} ↗</a>` : ''}` : '';
  }

  const rows = $('forge-list');
  if (!list) rows.innerHTML = '';
  else rows.innerHTML = shown.length ? shown.map(itemHtml).join('') : `<li class="hx-forge-empty hx-faint">${list.items.length ? `No ${kindWords()} matches these filters.` : `No ${kindWords()}s here.`}</li>`;

  const detail = $('forge-detail');
  detail.hidden = ui.selected === null;
  detail.innerHTML = detailHtml();

  const rate = (ui.detail && ui.detail.rate) || (list && list.rate) || '';
  $('forge-rate').textContent = rate;
  paintButton();
}

/** The header button says which pull request is lit */
function paintButton() {
  const btn = $('forge-btn');
  if (!btn) return;
  const lit = ui.selected !== null;
  const tag = $('forge-btn-lit');
  tag.hidden = !lit;
  tag.textContent = lit ? `#${ui.selected}` : '';
  btn.setAttribute('aria-label', lit ? `Issues and pull requests, pull request ${ui.selected} selected` : 'Issues and pull requests');
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
  // Whatever it came to (a refusal says the pull request is not what was shown), the panel looks again
  if (res.status !== null && ui.selected === n) await refreshForge({ quiet: true });
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
  const n = ui.selected;
  await loadList(true, quiet);
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
  if (announceNow && list) announce(`${filterItems(list.items, ui.kind, ui.filters).length} of ${plural(list.items.length, kindWords())} shown`);
}

function onClick(e) {
  const t = e.target;
  if (!t.closest) return;
  const kind = t.closest('[data-forge-kind]');
  if (kind) {
    if (kind.dataset.forgeKind === ui.kind) return;
    ui.kind = kind.dataset.forgeKind;
    ui.actNote = null;
    ui.filters = defaultFilters();
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
  else if (action.dataset.action === 'clear-forge-pr') { clearPull(); $('forge-title').focus(); }
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
  state.forgeLit = null;
  Object.assign(ui, { config: null, open: false, kind: 'pulls', filters: defaultFilters(), lists: {}, loading: false, error: '', selected: null, detail: null, detailError: '', lit: null, nodesSeen: null, busy: '', note: null, confirm: null, actNote: null });
}

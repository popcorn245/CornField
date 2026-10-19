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
import {
  STATES, defaultFilters, listUrl, pullUrl, serverState, filterItems, facetsOf, stateWords, metaWords, checkWords, checksWords, litFor, errorWords,
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
  loading: false,
  error: '',
  selected: null, // the pull request's number
  detail: null, // { pull, files, checks, at, rate, stale } of the selected one
  detailError: '',
  lit: null, // litFor(detail, nodes)
  nodesSeen: null, // the `state.nodes` the lights were worked out for
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
const listKey = () => `${ui.kind}|${serverState(ui.filters.state)}`;
const current = () => ui.lists[listKey()] || null;
const plural = (n, word, more = `${word}s`) => `${n} ${n === 1 ? word : more}`;
const kindWords = () => (ui.kind === 'pulls' ? 'pull request' : 'issue');
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
//  Release notes
// ---------------------------------------------------------------------------

/** Loads the draft for the tag chosen (again, past the server's cache, on a refresh) */
async function loadNotes(refresh = false) {
  const token = ++notesToken;
  const n = ui.notes;
  n.loading = true;
  n.error = '';
  n.message = '';
  closeConfirm(false);
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
function openConfirm() {
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
function closeConfirm(restoreFocus = true) {
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
  if (ui.kind === 'notes') return;
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
  // An issue has no more to show here: its row is the link out
  return link
    ? `<li class="hx-forge-item"><a class="hx-forge-row" href="${escHtml(link)}" target="_blank" rel="noreferrer">${inner}<span class="hx-sr-only"> (opens ${escHtml(forgeName())} in a new tab)</span></a></li>`
    : `<li class="hx-forge-item"><div class="hx-forge-row">${inner}</div></li>`;
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
  const notes = ui.kind === 'notes';
  $('forge-filters').hidden = notes;
  $('forge-list').hidden = notes;
  $('forge-notes').hidden = !notes;
  if (notes) {
    drawNotes();
    return;
  }

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
  detail.hidden = ui.selected === null;
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
  const lit = ui.selected !== null;
  const tag = $('forge-btn-lit');
  tag.hidden = !lit;
  tag.textContent = lit ? `#${ui.selected}` : '';
  btn.setAttribute('aria-label', lit ? `Issues and pull requests, pull request ${ui.selected} selected` : 'Issues and pull requests');
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
export async function refreshForge() {
  announce('Asking the forge again');
  if (ui.kind === 'notes') { await loadNotes(true); return; }
  const n = ui.selected;
  await loadList(true);
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
    if (kind.dataset.forgeKind === 'notes') {
      ui.kind = 'notes';
      if (ui.notes.data || ui.notes.loading) { paint(); announce(`Release notes. ${ui.notes.data ? notesSummary(ui.notes.data) : ''}`); } else loadNotes();
      return;
    }
    ui.kind = kind.dataset.forgeKind;
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
  const action = t.closest('[data-action]');
  if (!action) return;
  if (action.dataset.action === 'close-forge') closeForge();
  else if (action.dataset.action === 'refresh-forge') refreshForge();
  else if (action.dataset.action === 'copy-notes') copyNotes();
  else if (action.dataset.action === 'post-notes') { if (ui.notes.confirm) closeConfirm(); else openConfirm(); }
  else if (action.dataset.action === 'confirm-notes') postDraft();
  else if (action.dataset.action === 'cancel-notes') { closeConfirm(); announce('Cancelled. Nothing was posted.'); }
  else if (action.dataset.action === 'clear-forge-pr') { clearPull(); $('forge-title').focus(); }
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
    closeConfirm();
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
  notesToken++;
  state.forgeLit = null;
  Object.assign(ui, { config: null, open: false, kind: 'pulls', filters: defaultFilters(), lists: {}, loading: false, error: '', selected: null, detail: null, detailError: '', lit: null, nodesSeen: null, notes: freshNotes() });
}

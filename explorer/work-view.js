/**
 * @module explorer/work-view
 *
 * The Work view in cornfield's page (spec 0012 D1 to D5 and D8); its pure half is work-model.js, the server's half `GET /api/forge/work-graph`
 * (server/work-graph.js). Page code, as house.js is for the House view: it reads `location` and listens on `document`.
 *
 *   initWorkView({ offered })   once, after the config: the Work button of the view switch (shown when the config names a forge), the toggle, the clicks
 *   openWork({ select })        opens the view (the camera fits), asks the server for the work graph (once; again on Refresh and on the poll the Work
 *                               panel makes), and selects a node of it when `select` names one; closeWork() goes back to the map
 *   followWorkAddress()         `?view=work`, `?pr=`, `?issue=`, `?run=`, `?thread=` and `?spec=` (work-model.js `workAddress`)
 *
 * What it puts on the page: the view switch's Work button, with "waiting on you" as its badge (the number the Work button of the header says, in the same
 * words), the toggle at the top left of the stage ("All work" and "Waiting on you"), the map's own card while the answer is not there (signed out, not a
 * maintainer, offline: pieces/status.js), and a quiet line naming what the server could not read (`problems`). It answers the node panel's `work:panel`
 * ask with what a node says in the Work view. Every request goes through `credentialed`; every word that comes from the forge is escaped.
 */

import { state, pageInstance } from './state.js';
import { setView } from './view.js';
import { closeDrawer } from './panels.js';
import { announce } from './engine/keyboard.js';
import { credentialed } from './engine/connection.js';
import { selectNode } from './engine/selection.js';
import { closeProposal } from './engine/proposal.js';
import { signInUrl } from './engine/source.js';
import { mapStyleOf, workToken } from './engine/map-style.js';
import { t } from './engine/strings.js';
import { mount as mountStatus } from './pieces/status.js';
import { fitGraphToViewport, fitPadding, onPaint, render } from './render.js';
import { isPhone } from './sheets.js';
import { escapeHtml as esc } from '../core/text.js';
import { WORK_KINDS, WORK_THEMES } from '../core/schema.js';
import { workButtonName } from './waiting-model.js';
import { cornState } from './corn-state.js';
import { checksWords, pullUrl } from './forge-panel-model.js';
import { RUNS_POLL_MS, safeUrl } from './pieces/work-common.js';
import { openWorkAt } from './forge-panel.js';
import {
  CODE_LAYER, DRAFT_LAYER, KIND_WORDS, applyFilters, applyWorkLayout, layerRowsOf, newWorkState, nodeForAddress, openedWords, panelOf, setWorkGraph, showWork, touchedBy, workAddress,
} from './work-model.js';

const GRAPH_URL = '/api/forge/work-graph';
const $ = (id) => document.getElementById(id);

let wired = false;
let offered = false;
let els = null; // { stage, bar, all, waiting, busy, note, lanes, loading }
let laneEls = []; // the lanes' titles on the stage, in screen space: [{ el, name, count }]
let laneKey = null; // the lanes they were made for
let offPaint = null;
let card = null; // the map's own card (pieces/status.js)
let timer = 0;
let seq = 0; // the answer that is waited for: an older one is dropped
let pullDetail = new Map(); // pull number -> { head, text } what the checks said of the head (the node panel's line)
let wasOn = false;

const inst = () => pageInstance();
const work = () => state.work || (state.work = newWorkState());
const on = () => state.view === 'work';

/** Starts the Work view's machinery. Nothing is asked of the server until the view opens. */
export function initWorkView(opts = {}) {
  offered = opts.offered === true;
  const btn = $('preset-work-btn');
  if (btn) btn.hidden = !offered;
  work();
  mount();
  if (!wired) {
    wired = true;
    const i = inst();
    document.addEventListener('click', onClick);
    i.on('view', syncWork);
    i.on('layers', refilter);
    i.on('work:open', ({ id }) => openWork({ select: id }));
    i.on('search:more', () => (work().status === 'ok' && !on() ? work().nodes.filter((n) => n.work) : null));
    i.on('work:waiting', ({ total }) => paintBadge(total));
    i.on('work:panel', (node) => panelFor(node));
    mapStyleOf(i).onChange(() => { if (on()) { state.workRows = layerRowsOf(work().nodes).map(themed); i.emit('layers:redraw'); } });
  }
  syncWork();
}

/** The Work button's badge and its spoken name: "Work, 3 waiting on you" (the Work panel's own words: waiting-model.js) */
function paintBadge(total) {
  const btn = $('preset-work-btn');
  if (!btn) return;
  const n = Number.isFinite(total) ? total : 0;
  const badge = btn.querySelector('[data-corn="waiting-badge"]');
  if (badge) { badge.textContent = n ? String(n) : ''; badge.hidden = !n; }
  btn.setAttribute('aria-label', workButtonName(t(inst(), 'issuesAndPrs'), n, (key) => t(inst(), key)));
  if (els) paintBar();
}

// ---------------------------------------------------------------------------
//  The page's parts
// ---------------------------------------------------------------------------
function mount() {
  const stage = state.canvas ? state.canvas.parentElement : null;
  if (!stage || (els && els.stage === stage && stage.contains(els.bar))) return;
  const bar = document.createElement('div');
  bar.className = 'hx-work-bar';
  bar.dataset.corn = 'work-bar';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Show');
  bar.hidden = true;
  bar.innerHTML = '<button type="button" class="hx-work-chip" data-corn="work-chip" data-corn-kind="quiet" data-work-show="all" aria-pressed="true">All work</button>'
    + '<button type="button" class="hx-work-chip" data-corn="work-chip" data-corn-kind="quiet" data-work-show="waiting" aria-pressed="false">Waiting on you</button>'
    + '<span class="hx-work-busy" data-corn="work-busy" hidden>Updating…</span>';
  const note = document.createElement('p');
  note.className = 'hx-work-note';
  note.dataset.corn = 'work-note';
  note.hidden = true;
  // The lanes' titles: lines of the page over the map, in screen space, so they read at any zoom (the map draws the lanes' panels)
  const lanes = document.createElement('div');
  lanes.className = 'hx-work-lanes';
  lanes.dataset.corn = 'work-lanes';
  lanes.setAttribute('aria-hidden', 'true');
  lanes.hidden = true;
  // What the page shows while the first answer is on its way (a big repository takes seconds): the lanes, empty, and the words; the page stays usable under it
  const loading = document.createElement('div');
  loading.className = 'hx-work-loading';
  loading.dataset.corn = 'work-loading';
  loading.hidden = true;
  loading.innerHTML = `<div class="hx-work-skeleton" aria-hidden="true">${['Talk', 'Decide', 'Build', 'Ship', 'Code it touches'].map((name) => `<div class="hx-work-skel-lane"><span class="hx-work-lane-title">${name}</span><i></i><i></i><i></i><i></i></div>`).join('')}</div>`
    + '<p class="hx-work-loading-text" role="status" data-corn="work-loading-text">Reading the work from the forge. A big repository can take several seconds the first time; the page works meanwhile.</p>';
  stage.append(lanes, loading, bar, note);
  els = { stage, bar, all: bar.children[0], waiting: bar.children[1], busy: bar.children[2], note, lanes, loading };
  if (offPaint) offPaint();
  offPaint = onPaint(paintLanes);
  card = mountStatus(stage, inst(), { follow: false, onRetry: () => load({ again: true }), focusMap: () => { if (state.canvas) state.canvas.focus(); } });
}

/** The lanes' titles, over the map in screen space: centred over their lane and held under the toggles while the lane is in view (a phone's: at the lane's top left) */
function paintLanes(scene, camera) {
  if (!els) return;
  const w = work();
  const show = on() && w.status === 'ok' && w.lanes.length > 0;
  els.lanes.hidden = !show;
  if (!show) return;
  if (laneKey !== w.lanes) {
    laneKey = w.lanes;
    els.lanes.textContent = '';
    laneEls = w.lanes.map((l) => {
      const el = document.createElement('div');
      el.className = 'hx-work-lane-title';
      el.dataset.corn = 'work-lane-title';
      const name = document.createElement('span');
      name.textContent = l.name;
      const count = document.createElement('span');
      count.className = 'hx-work-lane-count';
      count.textContent = String(l.count);
      el.append(name, count);
      els.lanes.append(el);
      return { el, lane: l };
    });
  }
  const phone = isPhone();
  const top = phone ? 0 : STICKY_TOP;
  for (const { el, lane } of laneEls) {
    const left = camera.x + lane.x * camera.zoom;
    const right = left + lane.w * camera.zoom;
    const topPx = camera.y + lane.y * camera.zoom;
    const bottomPx = topPx + lane.h * camera.zoom;
    const seen = right > 0 && left < els.stage.clientWidth && bottomPx > 40 && topPx < els.stage.clientHeight;
    el.style.visibility = seen ? 'visible' : 'hidden';
    if (!seen) continue;
    const y = phone ? topPx + 8 : Math.min(Math.max(topPx + 10, top), bottomPx - 44);
    el.style.maxWidth = `${Math.max(40, right - left - 12)}px`;
    el.style.top = `${Math.round(y)}px`;
    if (phone) { el.style.left = `${Math.round(Math.max(left, 0) + 10)}px`; el.style.transform = 'none'; } else { el.style.left = `${Math.round((left + right) / 2)}px`; el.style.transform = 'translateX(-50%)'; }
  }
}
/** The line the lanes' titles hold under, in px from the top of the stage: below the toggles */
const STICKY_TOP = 58;

function paintBar() {
  if (!els) return;
  const w = work();
  const n = w.counts.waiting;
  els.bar.hidden = !on();
  els.all.setAttribute('aria-pressed', String(!w.waiting));
  els.waiting.setAttribute('aria-pressed', String(w.waiting));
  els.waiting.textContent = `Waiting on you · ${n}`;
  els.busy.hidden = !(on() && w.status === 'ok' && w.updating);
  els.loading.hidden = !(on() && w.status === 'loading');
  const lines = [...(w.stale ? [w.stale] : []), ...(w.lastError ? [w.lastError] : []), ...w.problems.map((p) => p.text)];
  els.note.hidden = !on() || !lines.length;
  els.note.textContent = lines.length ? lines.slice(0, 2).join(' ') + (lines.length > 2 ? ` and ${lines.length - 2} more.` : '') : '';
}

/** The view opened or closed: the button, the bar, the stage; the map's own layers are back when it closed (work-model.js `leaveWork`) */
function syncWork() {
  const open = on();
  const btn = $('preset-work-btn');
  if (btn) btn.setAttribute('aria-pressed', String(open));
  const stage = state.canvas ? state.canvas.parentElement : null;
  if (stage) stage.classList.toggle('is-work', open);
  paintBar();
  if (open !== wasOn) {
    if (open) { paintBadge(work().counts.waiting); inst().emit('layers:redraw'); } // the Layers menu lists the Work view's rows from the first moment, the answer here or not
    wasOn = open;
    clearTimeout(timer);
    if (open) timer = setTimeout(poll, RUNS_POLL_MS);
    else if (card) card.clear();
  }
}

function poll() {
  clearTimeout(timer);
  if (!on()) return;
  if (document.visibilityState !== 'hidden') load({ again: true, quiet: true });
  timer = setTimeout(poll, RUNS_POLL_MS);
}

// ---------------------------------------------------------------------------
//  Opening, and the answer
// ---------------------------------------------------------------------------

/**
 * Opens the Work view, asks for the work graph (once per opening; again on Refresh and on the poll), and selects `select` (a node id) when the answer has it.
 * @param {{ select?: string | null, ask?: { kind: string, key: string } | null }} [opts]
 * @returns {Promise<boolean>} whether the answer arrived
 */
export async function openWork({ select = null, ask = null } = {}) {
  const i = inst();
  if (!on()) {
    if (state.proposal) closeProposal(i); // a review holds the map: it ends before the view of work begins
    closeDrawer();
    setView('work');
  }
  syncWork();
  const ok = await load({ select, ask });
  return ok;
}

/** Back to the map (the Map button's way) */
export function closeWork() {
  if (!on()) return;
  closeDrawer();
  setView('orbit');
}

async function load({ select = null, ask = null, again = false, quiet = false } = {}) {
  const i = inst();
  const mine = ++seq;
  const w = work();
  const have = w.status === 'ok';
  if (!have) {
    // The first answer: the page says so at once (the lanes, empty, and the words) and stays usable; the answer may take seconds on a big repository
    w.status = 'loading';
    card.clear();
    paintBar();
    announce(i, 'Work: reading the work from the forge.');
  } else if (!quiet) { w.updating = true; paintBar(); } // a refresh keeps the last answer on the map until the new one is here
  let res;
  try {
    res = await credentialed(i)(GRAPH_URL, { headers: { accept: 'application/json', ...(again && !quiet ? { 'cache-control': 'no-cache' } : {}) } }); // Refresh asks the forge again
  } catch {
    if (mine !== seq) return false;
    return refuse(i.offline() ? { state: 'offline' } : { state: 'server', message: 'cornfield could not be reached.' }, quiet);
  }
  if (mine !== seq) return false;
  if (res.status === 401 || res.status === 403) return refuse({ state: 'sign-in', status: res.status, signIn: signInUrl(location.origin, location.href) }, quiet);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (mine !== seq) return false;
  if (!res.ok || !body || body.ok === false || !Array.isArray(body.nodes)) {
    const words = res.status === 404 ? 'This server does not answer for the map of work yet: update cornfield.' : body && typeof body.error === 'string' ? body.error.slice(0, 200) : `The server answered ${res.status}.`;
    return refuse({ state: 'server', message: words }, quiet);
  }
  return arrive(body, { select, ask, quiet });
}

/**
 * The answer could not be had. With nothing read yet, it is said in the map's own card. With an answer on the map, the map keeps it (a refresh that fails does not wipe
 * what is drawn): the line under the toggles says what failed, except for a sign-in that ended, which the card says over the map.
 */
function refuse(detail, quiet) {
  const w = work();
  w.updating = false;
  if (w.status === 'ok' && detail.state !== 'sign-in') {
    if (!quiet) { w.lastError = `Could not update the work: ${detail.state === 'offline' ? 'you are offline' : detail.message || 'it could not be read'}. This is what was read earlier.`; announce(inst(), 'Work: it could not be updated. Showing what was read earlier.'); }
    paintBar();
    return false;
  }
  if (quiet && w.status === 'ok') return false;
  w.status = detail.state;
  w.nodes = [];
  w.edges = [];
  w.counts = { work: 0, code: 0, waiting: 0 };
  w.problems = [];
  w.stale = '';
  w.lastError = '';
  if (on()) { showWork(state); applyWorkLayout(state, { phone: isPhone() }); inst().touchScene(); inst().emit('layers:redraw'); render(); }
  card.show(detail);
  paintBar();
  paintBadge(0);
  announce(inst(), `Work: ${detail.state === 'sign-in' ? (detail.status === 403 ? 'this map is for the maintainers.' : 'sign in to see the work.') : detail.state === 'offline' ? 'you are offline.' : 'it could not be read.'}`);
  return false;
}

function arrive(body, { select, ask, quiet }) {
  const i = inst();
  const w = work();
  const first = w.status !== 'ok';
  const before = state.selectedNode ? state.selectedNode.id : null;
  const base = state.baseNodes && state.baseNodes.length ? state.baseNodes : (w.saved ? w.saved.nodes : state.nodes);
  setWorkGraph(state, body, base);
  w.status = 'ok';
  w.updating = false;
  w.lastError = '';
  w.stale = typeof body.stale === 'string' ? body.stale.slice(0, 200) : '';
  card.clear();
  if (on()) {
    showWork(state);
    applyWorkLayout(state, { phone: isPhone() });
    state.workRows = layerRowsOf(w.nodes).map(themed);
    i.touchScene();
    i.emit('layers:redraw');
    if (first || !quiet) fitGraphToViewport(fitPadding()); // the lanes under the toggles, the names at the edge on screen too (work-model.js `layoutWork`)
    render();
    if (before && !state.selectedNode) i.emit('node:close');
  }
  paintBar();
  paintBadge(w.counts.waiting);
  const id = select || nodeForAddress(ask, w.nodes);
  if (id) pick(id);
  else if (ask && ask.kind) announce(i, `${ask.bad || `There is no ${KIND_WORDS[ask.kind].toLowerCase()} ${ask.key} in the work now.`}`);
  if (first || !quiet) announce(i, openedWords(w.counts));
  return true;
}

/** The row's dot is the colour the map draws the kind in, the theme's token when it sets one */
function themed(row) {
  const kind = WORK_KINDS.find((k) => `work-${k}` === row.key);
  const values = mapStyleOf(inst()).get().values;
  return kind && values[workToken(kind)] ? { ...row, color: values[workToken(kind)] } : row;
}

/** A layer went on or off: what is hidden is worked out again, the lanes are laid out for what is shown, and the camera fits them */
function refilter() {
  if (!on()) return;
  const w = work();
  applyFilters(w.nodes, w.edges, { layers: w.layers, waiting: w.waiting });
  const sel = state.selectedNode;
  applyWorkLayout(state, { phone: isPhone() });
  state.workRows = layerRowsOf(w.nodes).map(themed);
  inst().touchScene();
  if (sel && sel.hidden) inst().emit('node:close');
  fitGraphToViewport(fitPadding());
  render();
}

/** Selects a node of the view by id: the panel opens, the camera follows (as a search's choice does) */
export function pick(id, { frame = true, source = 'link' } = {}) {
  const node = state.nodes.find((n) => n.id === id);
  if (!node) return false;
  if (node.hidden) { work().layers[node.draft ? DRAFT_LAYER : node.work ? `work-${node.work}` : CODE_LAYER] = true; refilter(); }
  selectNode(inst(), node, { frame, source });
  return true;
}

/** "Waiting on you" on or off: everything that does not wait is dimmed (spec 0012 D3) */
function setWaiting(on_) {
  const w = work();
  if (w.waiting === on_) return;
  w.waiting = on_;
  applyFilters(w.nodes, w.edges, { layers: w.layers, waiting: w.waiting });
  inst().touchScene();
  paintBar();
  render();
  announce(inst(), on_ ? `Showing what waits on you: ${w.counts.waiting}.` : 'Showing all work.');
}

// ---------------------------------------------------------------------------
//  The node panel's words for a node
// ---------------------------------------------------------------------------
const pill = (p) => `<span class="hx-forge-state${p.state ? ` hx-forge-state--${esc(p.state)}` : ''}" data-corn="state-pill"${cornState(p.state) ? ` data-corn-state="${esc(cornState(p.state))}"` : ''}>${esc(p.text)}</span>`;
/** The kind's colour as the map draws it: the theme's token, else the default (the style goes on through `data-style`, which a host's CSP allows) */
const colorOf = (kind) => { const v = mapStyleOf(inst()).get().values[workToken(kind)]; return /^#[0-9a-f]{3,8}$/i.test(v || '') ? v : WORK_THEMES[kind] ? WORK_THEMES[kind].color : ''; };
const dot = (kind) => `<span class="hx-work-dot" data-corn="swatch" data-work-kind="${esc(kind || 'code')}" aria-hidden="true"${colorOf(kind) ? ` data-style="background-color: ${esc(colorOf(kind))}"` : ''}></span>`;
const linkButton = (l) => `<button type="button" class="hx-linkbtn" data-corn="node-link" data-action="select-node" data-id="${esc(l.id)}">${esc(l.label)}</button>`;

/** What the node panel shows for a node while the Work view is open (`work:panel`): a piece of work, replaced; a node of code, with the work that touches it first */
function panelFor(node) {
  if (!on() || !node) return undefined;
  const w = work();
  if (node.work) {
    const p = panelOf(node, w.nodes, w.edges);
    const links = p.links.length
      ? `<div class="hx-fact" data-corn="section"><div class="hx-fact-k">Connected</div><div class="hx-fact-v"><ul class="hx-work-links" data-corn="work-links">${p.links.map((l) => `<li data-corn="work-link"><span class="hx-work-rel">${esc(l.rel)}</span>${dot(l.work)}${linkButton(l)}${l.planned ? ' <span class="hx-faint">planned</span>' : ''}</li>`).join('')}</ul></div></div>`
      : '<div class="hx-fact" data-corn="section"><div class="hx-fact-k">Connected</div><div class="hx-fact-v hx-faint">Nothing it is linked to is drawn.</div></div>';
    const checks = node.item.kind === 'pull' ? `<div class="hx-fact" data-corn="section"><div class="hx-fact-k">Checks</div><div class="hx-fact-v" id="work-checks" data-corn="work-checks">${esc(checksLine(node))}</div></div>` : '';
    const open = `<div class="hx-work-actions" data-corn="work-actions"><p class="hx-faint">${esc(p.says)}</p><button type="button" class="hx-btn hx-btn--primary hx-foot-btn" data-corn-kind="primary" data-work-action="open-in-work" data-id="${esc(node.id)}">Open in Work</button>${safeUrl(p.url) ? `<a class="hx-btn hx-btn--quiet hx-foot-btn" data-corn-kind="quiet" data-corn="open-link" href="${esc(safeUrl(p.url))}" target="_blank" rel="noreferrer">Open on the forge ↗</a>` : ''}</div>`;
    if (node.item.kind === 'pull') loadChecks(node);
    return { replace: true, badge: p.kind, title: p.title, html: `<div class="hx-work-head" data-corn="work-head"><p class="hx-work-pills" data-corn="work-pills">${p.pills.map(pill).join(' ')}</p>${p.meta ? `<p class="hx-faint">${esc(p.tag)} · ${esc(p.meta)}</p>` : `<p class="hx-faint">${esc(p.tag)}</p>`}</div>${links}${checks}${open}` };
  }
  const touching = touchedBy(node, w.nodes, w.edges);
  const list = touching.length
    ? `<ul class="hx-work-links" data-corn="work-links">${touching.map((l) => `<li data-corn="work-link"><span class="hx-work-rel">${esc(l.rel)}</span>${dot(l.work)}${linkButton(l)}</li>`).join('')}</ul>`
    : '<p class="hx-faint">No work touches it now.</p>';
  const show = node.planned ? '' : `<button type="button" class="hx-btn hx-btn--secondary hx-foot-btn" data-corn-kind="secondary" data-work-action="show-on-map" data-id="${esc(node.id)}">Show on the map</button>`;
  return { replace: false, html: `<div class="hx-fact" data-corn="section"><div class="hx-fact-k">Work</div><div class="hx-fact-v">${node.planned ? '<p class="hx-faint">Planned: a proposal adds it, and the map does not hold it yet.</p>' : ''}${list}${show}</div></div>` };
}

/** What the checks of a pull request's head say, once read; "Reading the checks…" until then */
const checksLine = (node) => {
  const got = pullDetail.get(node.item.number);
  return got ? got.text : 'Reading the checks…';
};

/** The checks are not in the graph: they are read from the pull request's own route when its node is opened, and painted into the panel when they arrive */
async function loadChecks(node) {
  const n = node.item.number;
  const i = inst();
  let text = 'The checks could not be read.';
  try {
    const res = await credentialed(i)(pullUrl(n), { headers: { accept: 'application/json' } });
    const body = res.ok ? await res.json() : null;
    if (body && Array.isArray(body.checks)) text = checksWords(body.checks);
  } catch { /* said in the panel */ }
  pullDetail.set(n, { text });
  const el = document.getElementById('work-checks');
  if (el && state.selectedNode && state.selectedNode.id === node.id) el.textContent = text;
}

// ---------------------------------------------------------------------------
//  Clicks
// ---------------------------------------------------------------------------
function onClick(e) {
  const t_ = e.target && e.target.closest ? e.target : null;
  if (!t_) return;
  if (t_.closest('[data-action="preset-work"]')) { if (on()) closeWork(); else openWork(); return; }
  if (t_.closest('[data-action="refresh-forge"]') && on()) { load({ again: true }); return; }
  const show = t_.closest('[data-work-show]');
  if (show && on()) { setWaiting(show.dataset.workShow === 'waiting'); return; }
  const act = t_.closest('[data-work-action]');
  if (!act) return;
  const node = state.nodes.find((n) => n.id === act.dataset.id);
  if (!node) return;
  if (act.dataset.workAction === 'open-in-work') openWorkAt(node.item);
  else if (act.dataset.workAction === 'show-on-map') showOnMap(node.id);
}

/** A node of code, on the map: the view goes back to it, the node selected and in view */
function showOnMap(id) {
  closeWork();
  const node = state.nodes.find((n) => n.id === id);
  if (node) selectNode(inst(), node, { frame: true, source: 'link' });
}

// ---------------------------------------------------------------------------
//  Addresses (spec 0012 D8)
// ---------------------------------------------------------------------------

/** Follows `?view=work`, `?pr=`, `?issue=`, `?run=`, `?thread=` and `?spec=`, once; the ones that ask for a node are taken out of the address when followed */
export async function followWorkAddress(search = location.search) {
  const ask = workAddress(search);
  if (!ask) return false;
  if (!offered) { announce(inst(), 'The map of work needs a forge in the config.'); return false; }
  spend();
  return openWork({ ask: ask.kind ? ask : null });
}

/** What an address that asks for work is, for the page to decide whether it is the Work view's (the old Work panel's links are `?run=` and `?issue=` too: step 3 of spec 0012 moves them) */
export const asksForWork = (search) => workAddress(search) !== null;

function spend() {
  if (typeof history === 'undefined') return;
  try {
    const params = new URLSearchParams(location.search);
    for (const k of ['pr', 'issue', 'run', 'thread', 'spec']) params.delete(k);
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  } catch { /* the address is a convenience */ }
}

/** For tests: forget the page this was wired to */
export function resetWorkViewForTests() {
  clearTimeout(timer);
  if (offPaint) offPaint();
  offPaint = null;
  laneEls = [];
  laneKey = null;
  wired = false;
  offered = false;
  els = null;
  card = null;
  seq++;
  pullDetail = new Map();
  wasOn = false;
}

export { WORK_THEMES };

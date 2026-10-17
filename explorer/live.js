/**
 * @module explorer/live
 *
 * The live layer in the page (spec 0029 section 4, PHY-09): runs a live source (a plugin's adapter,
 * handed over by main.js) with live-model.js's runner, lays each answer over the map through `setMap`
 * (view.js), and shows the live chip in the toolbar with its Refresh and the failure note.
 *
 *   initLive({ source, onSelectionGone })   once, after the topology loaded
 *   syncLive()                              after anything that turns a live layer on or off; the Layers
 *                                           menu and the tab's visibility call it already. The House view
 *                                           (PHY-11) calls it after `setView('house')`: `wantsLive()` is true there.
 *   refreshLive()                           ask the source now (the chip's Refresh)
 *   liveSection(node) / hydrateLivePhotos   the node panel's live part (panels.js)
 *
 * Renderers never read any of this: the live nodes reach the picture as nodes and edges on the map, which
 * buildScene (scene.js) describes like any other, flagged `live`.
 *
 * Nothing live is written anywhere: no storage, no file, no URL. The answer is `state.live.answer` in memory,
 * dropped 10 minutes after the last good one; photos are blob URLs, revoked when the answer goes.
 *
 * The token: while the source fails for want of one (`no-token`, `forbidden`) and has a `token` setting, the menu
 * shows a password field with Save (and Forget token while one is set). The source keeps it where it likes; the
 * page never fills the field from it, never shows it, never logs it, never puts it in a URL (no <form>, so no
 * submit can carry it either).
 */

import { state, nodeById, escHtml, touchScene } from './state.js';
import { render, ensureFlowLoop } from './render.js';
import { setMap } from './view.js';
import { onLayersChange, renderLayerToggles } from './layers.js';
import { chipModel, createLiveRunner, groupsOf, liveDetailsHtml, liveWanted } from './live-model.js';

const $ = (id) => document.getElementById(id);

let runner = null;
let source = null;
let hooks = { onSelectionGone: () => {} };
let shownSig = null; // what the map holds of the answer (without its time), so an unchanged answer moves nothing
let menuOpen = false;
let wired = false;
let staleTick = null;
const photos = new Map(); // url -> blob URL, for the answer on the map

/** Whether the live layer should be loaded: a live layer is on, or the House view is open (PHY-11) */
export const wantsLive = () => liveWanted(state.activeLayers) || state.view === 'house';
const tabVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/**
 * Starts the live layer's machinery. Nothing is fetched until a live layer goes on.
 * @param {{ source: { load: Function, image?: Function }, onSelectionGone?: () => void }} opts
 */
export function initLive(opts) {
  source = opts.source;
  hooks = { ...hooks, ...opts };
  if (runner) runner.stop();
  runner = createLiveRunner({
    source,
    groups: () => groupsOf(state.mapNodes.length ? state.mapNodes : state.nodes),
    wanted: wantsLive,
    visible: tabVisible,
    onChange: applySnapshot,
  });
  if (!wired) {
    wired = true;
    onLayersChange(syncLive);
    document.addEventListener('visibilitychange', syncLive);
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onDocumentKeydown);
  }
  syncLive();
}

export function syncLive() {
  if (runner) runner.sync();
}

/** Stops the refresh and forgets the answer (the tests; nothing in the page needs it) */
export function stopLive() {
  if (runner) runner.stop();
  runner = null;
  state.live = null;
  shownSig = null;
  menuOpen = false;
  clearPhotos();
}

export function refreshLive() {
  return runner ? runner.refresh() : Promise.resolve();
}

/** The runner moved: keep the snapshot, lay a changed answer over the map, repaint the chip */
function applySnapshot(snap) {
  const prev = state.live;
  state.live = { ...snap, counts: prev ? prev.counts : {}, other: prev ? prev.other : 0, linked: prev ? prev.linked : new Map(), canSetToken: !!tokenSetting() };
  // With no answer the House view's tray says why (house-model.js trayNotes): a changed failure lays the map out again there
  const failed = !snap.answer && snap.error && state.view === 'house' ? `failed:${snap.error.reason}:${snap.error.hint || ''}` : null;
  const sig = snap.answer ? JSON.stringify({ ...snap.answer, at: null }) : failed;
  if (sig !== shownSig) {
    shownSig = sig;
    if (!snap.answer) clearPhotos();
    remap();
  }
  paintChip();
}

/** Lays the live answer (or none) over the map again; the selection stays on the same node */
function remap() {
  if (!state.mapNodes.length) return;
  const selected = state.selectedNode ? state.selectedNode.id : null;
  setMap(state.mapNodes, state.mapEdges);
  if (selected) {
    const again = nodeById(selected);
    if (again) {
      state.selectedNode = again;
      const panel = $('drawer-live');
      if (panel) { panel.innerHTML = liveSection(again); hydrateLivePhotos(panel); }
    } else {
      hooks.onSelectionGone();
    }
  }
  touchScene();
  renderLayerToggles();
  render();
  ensureFlowLoop();
}

// ---------------------------------------------------------------------------
//  The chip
// ---------------------------------------------------------------------------
/** Paints the chip again: the House view (house.js) calls it when it opens or closes, since its words differ there */
export const repaintLiveChip = () => paintChip();

function paintChip() {
  const wrap = $('live-wrap');
  if (!wrap) return;
  const chip = chipModel(state.live, { other: state.live ? state.live.other : 0, house: state.view === 'house' });
  wrap.hidden = chip.hidden;
  wrap.dataset.tone = chip.tone;
  const text = $('live-chip-text');
  if (text) text.textContent = chip.text;
  const btn = $('live-chip');
  if (btn) {
    btn.title = chip.text;
    btn.setAttribute('aria-label', chip.text || 'Live layer');
    btn.setAttribute('aria-expanded', String(menuOpen));
  }
  const menu = $('live-menu');
  if (menu) {
    menu.hidden = !menuOpen || chip.hidden;
    const loading = state.live && state.live.status === 'loading';
    const tok = tokenSetting();
    const asking = !!tok && asksForToken(state.live && state.live.error);
    const has = !!tok && safeHas(tok);
    const info = menuPart(menu, 'info');
    const field = menuPart(menu, 'token');
    const row = menuPart(menu, 'row');
    info.innerHTML = `
      <p class="hx-live-line hx-live-line--main">${escHtml(chip.text)}</p>
      ${chip.lines.map((l) => `<p class="hx-live-line">${escHtml(l)}</p>`).join('')}
      ${chip.note ? `<p class="hx-live-line hx-faint">${escHtml(chip.note)}</p>` : ''}
      ${chip.href && !asking ? `<p class="hx-live-line"><a class="hx-link" href="${escHtml(chip.href)}">Where to set a token ↗</a></p>` : ''}`;
    // The field is painted only when it changes, so a repaint (a refresh, the stale tick) never drops what is being typed
    const fieldHtml = asking ? tokenFieldHtml(tok, chip.href) : '';
    if (field.dataset.painted !== String(asking)) {
      field.dataset.painted = String(asking);
      field.innerHTML = fieldHtml;
    }
    field.hidden = !asking;
    row.innerHTML = `
      <span class="hx-live-buttons">
        <button type="button" class="hx-btn" data-live="refresh"${loading ? ' disabled' : ''}>Refresh</button>
        ${has ? '<button type="button" class="hx-btn" data-live="token-forget">Forget token</button>' : ''}
      </span>
      <span class="hx-faint">${escHtml(source && source.name ? source.name : '')}</span>`;
  }
  // "as of 3 min ago" counts on while it is shown
  if (chip.tone === 'stale' && !staleTick) staleTick = setInterval(paintChip, 30_000);
  if (chip.tone !== 'stale' && staleTick) { clearInterval(staleTick); staleTick = null; }
}

// ---------------------------------------------------------------------------
//  The token field (the source's `token` setting, shown while it fails for want of one)
// ---------------------------------------------------------------------------

/** The source's token setting, when it has one the menu can use */
function tokenSetting() {
  const t = source && source.token;
  return t && typeof t.save === 'function' && typeof t.forget === 'function' ? t : null;
}

const asksForToken = (error) => !!error && (error.reason === 'no-token' || error.reason === 'forbidden');

function safeHas(tok) {
  try { return typeof tok.has === 'function' ? !!tok.has() : false; } catch { return false; }
}

/** One of the menu's three parts (its lines, the token field, the buttons), made the first time */
function menuPart(menu, name) {
  let el = menu.querySelector(`[data-live-part="${name}"]`);
  if (!el) {
    el = document.createElement('div');
    el.dataset.livePart = name;
    if (name === 'row') el.className = 'hx-live-row';
    if (name === 'token') el.className = 'hx-live-token';
    menu.appendChild(el);
  }
  return el;
}

/** `text with code in backticks` as HTML: the text escaped, the backticked parts in <code> */
function withCode(text) {
  return String(text || '').split('`').map((part, i) => (i % 2 ? `<code>${escHtml(part)}</code>` : escHtml(part))).join('');
}

/** The field: a password input (never filled from storage), Save, the source's help line, the board as a second way */
function tokenFieldHtml(tok, href) {
  const label = tok.label || 'Token';
  return `
    <label class="hx-live-token-label" for="live-token-input">${escHtml(label)}</label>
    <div class="hx-live-token-row">
      <input id="live-token-input" class="hx-field hx-live-token-input" type="password" data-live="token-input" autocomplete="off" autocapitalize="off" spellcheck="false" />
      <button type="button" class="hx-btn" data-live="token-save">Save</button>
    </div>
    ${tok.help ? `<p class="hx-live-line hx-faint hx-live-help">${withCode(tok.help)}</p>` : ''}
    ${href ? `<p class="hx-live-line hx-live-second"><a class="hx-link" href="${escHtml(href)}">or set it there ↗</a></p>` : ''}`;
}

/** Saves what is in the field (then empties it) and asks the source again at once; an empty field saves nothing */
function saveToken() {
  const tok = tokenSetting();
  const input = $('live-token-input');
  if (!tok || !input) return;
  const value = input.value;
  input.value = '';
  if (!value.trim()) { input.focus(); return; }
  if (!tok.save(value)) return;
  refreshLive();
}

function forgetToken() {
  const tok = tokenSetting();
  if (!tok) return;
  tok.forget();
  refreshLive();
}

/** Enter in the field saves, as Save does */
function onDocumentKeydown(e) {
  if (e.key !== 'Enter' || !e.target || !e.target.closest || !e.target.closest('[data-live="token-input"]')) return;
  e.preventDefault();
  saveToken();
}

/** The chip opens its menu, Refresh asks again, Save and Forget set the token, a click anywhere else closes the menu */
function onDocumentClick(e) {
  const wrap = $('live-wrap');
  if (!wrap || !e.target || !e.target.closest) return;
  if (e.target.closest('[data-live="refresh"]')) { refreshLive(); return; }
  if (e.target.closest('[data-live="token-save"]')) { saveToken(); return; }
  if (e.target.closest('[data-live="token-forget"]')) { forgetToken(); return; }
  if (e.target.closest('#live-chip')) { menuOpen = !menuOpen; paintChip(); return; }
  if (menuOpen && !wrap.contains(e.target)) { menuOpen = false; paintChip(); }
}

// ---------------------------------------------------------------------------
//  The node panel
// ---------------------------------------------------------------------------

/** The live part of the node panel (in a `#drawer-live` box, so a new answer can repaint it in place) */
export function liveSection(node) {
  return liveDetailsHtml(node, state.live, escHtml);
}

/** Shows the photos in `root` from blob URLs fetched with the source's token; nothing is stored */
export async function hydrateLivePhotos(root) {
  if (!root || !source || typeof source.image !== 'function') return;
  for (const img of root.querySelectorAll('img[data-live-photo]')) {
    const url = img.getAttribute('data-live-photo');
    try {
      let blobUrl = photos.get(url);
      if (!blobUrl) {
        const blob = await source.image(url);
        if (!blob) continue;
        blobUrl = URL.createObjectURL(blob);
        photos.set(url, blobUrl);
      }
      img.src = blobUrl;
      img.hidden = false;
    } catch { /* no photo: the rest of the panel stands */ }
  }
}

function clearPhotos() {
  for (const blobUrl of photos.values()) URL.revokeObjectURL(blobUrl);
  photos.clear();
}

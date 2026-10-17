/**
 * @module explorer/house
 *
 * The House view in the page (spec 0029 section 7, PHY-11); its pure half is house-model.js.
 *
 *   initHouse({ floor })   once, after the topology and the live layer: `floor` is a plugin's floor hook
 *                          `{ element, render(plan, floorId), defaultPlan(), editUrl? }` (plugins/house `createFloorRenderer`), or
 *                          nothing, and the tool draws plain room boxes. Opens the view for `/?view=house`.
 *   openHouse() / closeHouse() / setHouseFloor(id)
 *
 * What it puts on the page, all inside the map's stage:
 *  - the toolbar's House preset (`#preset-house-btn`, beside Data flow) with `aria-pressed`;
 *  - the plan UNDER the map canvas: one `pop-floor-map` (the hook's element) holding every floor's SVG, showing
 *    one with its `floor` attribute, moved with the camera by one CSS `matrix()` per frame; inert, so rooms are hit
 *    by the map's own hit test (room nodes at the centre of their boxes);
 *  - the floor chips at the stage's top left (Main Floor · Basement), with "Edit layout" after them when the hook
 *    names an editor (`editUrl`: the one place the plan is edited, opened in a new tab), and on a phone the persona chips
 *    ("Adult · 2", a tap opens the node sheet), the Software toggle and the Cloud toggle (spec 0031 section 7) in a row
 *    under them; an outage scenario turns the Cloud toggle on, and its blast radius is laid out again while it plays;
 *  - a "+3" chip on each room that holds more than its grid (a tap opens the room: all its things, past its box).
 *
 * A scenario step whose `at` (or node) is on another floor switches the floor. The plan's room the step happens in
 * (or the selected room) is marked on the plan as well as ringed on the map. Nothing here is stored.
 */

import { state, touchScene, onSceneTouch, nodeById } from './state.js';
import { render, ensureFlowLoop, fitGraphToViewport, fitPadding, addFrameClient } from './render.js';
import { setView } from './view.js';
import { syncLive, repaintLiveChip } from './live.js';
import { onLayersChange } from './layers.js';
import { isPhone, PHONE_QUERY } from './sheets.js';
import { closeDrawer, selectNode } from './panels.js';
import { applyHouseLayout, floorOfStep, houseEditHref, newHouseState, personaChips, plainFloorSvg, HOUSE_SCALE } from './house-model.js';

const $ = (id) => document.getElementById(id);
const stageOf = () => (state.canvas ? state.canvas.parentElement : null);

let hook = null; // the plugin's floor hook, or null
let els = null; // { under, map, bar, floors, people, over }
let drawnPlan = null; // the plan object the underlay was drawn from
let drawnFloorKey = '';
let lastTransform = '';
let busy = false;
let wasOn = false;
let fittedSource = ''; // the plan the camera last fitted: a live plan replacing the default one fits again, a refresh does not
let wired = false;

const cfg = () => state.house || (state.house = newHouseState());

/**
 * Starts the House view's machinery. Nothing is drawn until the view opens.
 * @param {{ floor?: { element?: string, render: (plan: object, floorId: string) => string, defaultPlan?: () => object, editUrl?: string | ((floorId: string) => string) } | null }} [opts]
 */
export function initHouse(opts = {}) {
  hook = opts.floor || null;
  const c = cfg();
  c.defaultPlan = hook && typeof hook.defaultPlan === 'function' ? hook.defaultPlan() : null;
  c.phone = isPhone();
  mount();
  if (!wired) {
    wired = true;
    document.addEventListener('click', onClick);
    onSceneTouch(syncHouse);
    onLayersChange(() => { if (state.view === 'house') relayout(); });
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia(PHONE_QUERY);
      if (mq && mq.addEventListener) mq.addEventListener('change', () => { cfg().phone = isPhone(); if (state.view === 'house') { relayout(); fitHouse(); } });
    }
    addFrameClient({ wants: () => false, tick: followCamera });
  }
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('view') === 'house') openHouse();
  syncHouse();
}

/** Opens the House view: the preset, the live layer (it loads while the view is open), the fit */
export function openHouse() {
  const c = cfg();
  c.phone = isPhone();
  c.open = new Set();
  closeDrawer();
  setView('house');
  syncLive();
  fitHouse();
  syncHouse();
  repaintLiveChip();
}

export function closeHouse() {
  if (state.view !== 'house') return;
  setView('orbit');
  syncLive();
  repaintLiveChip();
}

/** Shows another floor (a chip, or a scenario step there) */
export function setHouseFloor(floorId, { fit = true } = {}) {
  const c = cfg();
  if (!floorId || c.floor === floorId) return;
  c.floor = floorId;
  c.open = new Set();
  relayout();
  if (fit) fitHouse();
}

function fitHouse() {
  if (state.view !== 'house') return;
  fitGraphToViewport(fitPadding());
  followCamera();
}

/** Lays the House view out again (a floor, a toggle, a new answer) and redraws */
function relayout() {
  if (state.view !== 'house' || !state.nodes.length) return;
  applyHouseLayout(state);
  touchScene();
  render();
  ensureFlowLoop();
}

// ---------------------------------------------------------------------------
//  The page's parts
// ---------------------------------------------------------------------------
function mount() {
  const stage = stageOf();
  if (!stage || (els && els.stage === stage && stage.contains(els.under))) return;
  const under = document.createElement('div');
  under.className = 'hx-house-under';
  under.setAttribute('aria-hidden', 'true');
  under.inert = true;
  under.hidden = true;
  const map = document.createElement(hook && hook.element ? hook.element : 'div');
  map.className = 'hx-house-plan';
  under.appendChild(map);
  stage.insertBefore(under, stage.firstChild);

  const over = document.createElement('div');
  over.className = 'hx-house-over';
  over.hidden = true;

  const bar = document.createElement('div');
  bar.className = 'hx-house-bar';
  bar.hidden = true;
  bar.innerHTML = '<div class="hx-house-floors glass" role="group" aria-label="Floor"></div><div class="hx-house-people" role="group" aria-label="People"></div>';
  stage.appendChild(over);
  stage.appendChild(bar);
  els = { stage, under, map, over, bar, floors: bar.firstElementChild, people: bar.lastElementChild };
  drawnPlan = null;
  drawnFloorKey = '';
  lastTransform = '';
}

/** Everything the page shows of the House view, brought up to date (after every scene change: cheap when nothing moved) */
function syncHouse() {
  if (busy) return;
  busy = true;
  try {
    const on = state.view === 'house';
    if (on !== wasOn) {
      // Opened or left (by its button, the Data flow preset, Freeform …): the live layer and its chip follow
      wasOn = on;
      syncLive();
      repaintLiveChip();
    }
    const btn = $('preset-house-btn');
    if (btn) { btn.classList.toggle('hx-btn--active', on); btn.setAttribute('aria-pressed', String(on)); }
    const stage = stageOf();
    if (stage) stage.classList.toggle('is-house', on);
    if (!els) return;
    els.under.hidden = !on;
    els.over.hidden = !on;
    els.bar.hidden = !on;
    if (!on) return;
    followOutage();
    followStepFloor();
    if (cfg().planSource !== fittedSource) { fittedSource = cfg().planSource; if (!state.scenario) fitGraphToViewport(fitPadding()); }
    drawPlan();
    paintBar();
    paintMore();
    markRoom();
    followCamera();
  } finally {
    busy = false;
  }
}

/**
 * An outage scenario starting (or ending) lays the House view out again: its down nodes and the cloud nodes it
 * reaches join the Cloud band. On a phone it turns the Cloud toggle on.
 */
function followOutage() {
  const c = cfg();
  const scn = state.scenario;
  const down = scn && Array.isArray(scn.down) ? scn.down.join(',') : '';
  if (down === (c.outageKey || '')) return;
  c.outageKey = down;
  if (down && c.phone) c.cloud = true;
  relayout();
}

/** A playing step on another floor switches the floor */
function followStepFloor() {
  const scn = state.scenario;
  if (!scn || scn.done || !scn.current) return;
  const floor = floorOfStep(state, scn.current);
  if (floor && floor !== cfg().floor) setHouseFloor(floor, { fit: false });
}

/** The underlay: every floor's SVG once per plan (the hook's, or plain boxes), the shown one by `floor` */
function drawPlan() {
  const c = cfg();
  const plan = c.planUsed;
  const key = `${(c.floors || []).map((f) => f.id).join(',')}`;
  if (plan !== drawnPlan || key !== drawnFloorKey) {
    drawnPlan = plan;
    drawnFloorKey = key;
    const floors = plan ? c.floors || [] : [];
    els.map.innerHTML = floors.map((f) => {
      let svg = '';
      try { svg = hook && typeof hook.render === 'function' ? hook.render(plan, f.id) : plainFloorSvg(plan, f.id); } catch (err) { console.error('The floor renderer failed', err); svg = plainFloorSvg(plan, f.id); }
      return `<div class="floor-map__floor" data-floor="${escAttr(f.id)}">${svg}</div>`;
    }).join('');
  }
  const vb = (plan && plan.viewBox) || { width: 800, height: 600 };
  els.map.style.width = `${vb.width * HOUSE_SCALE}px`;
  els.map.style.height = `${vb.height * HOUSE_SCALE}px`;
  if (c.floor) els.map.setAttribute('floor', c.floor);
  // pop-floor-map shows the floor its attribute names; a plain div needs the same done by hand
  for (const el of els.map.querySelectorAll('.floor-map__floor')) el.hidden = el.getAttribute('data-floor') !== c.floor;
}

const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** The floor chips, and on a phone the persona chips and the Software and Cloud toggles */
function paintBar() {
  const c = cfg();
  const floors = c.floors || [];
  const edit = houseEditHref(hook, c.floor);
  const fKey = floors.map((f) => `${f.id}:${f.name}`).join('|') + `#${c.floor}#${c.planSource}#${edit || ''}`;
  if (els.floors.dataset.key !== fKey) {
    els.floors.dataset.key = fKey;
    els.floors.innerHTML = floors.map((f) => `<button type="button" class="hx-house-chip" data-house="floor" data-floor="${escAttr(f.id)}" aria-pressed="${f.id === c.floor}">${escAttr(f.name)}</button>`).join('')
      + (c.planSource === 'default' ? '<span class="hx-house-tag" title="The live layer is unavailable: this is the default plan">Default plan</span>' : '')
      + (c.planSource === 'none' ? '<span class="hx-house-tag">No plan</span>' : '')
      + (edit ? `<a class="hx-house-chip hx-house-edit" href="${escAttr(edit)}" target="_blank" rel="noopener" title="Move and resize the rooms where the plan is kept (opens in a new tab)">Edit layout</a>` : '');
  }
  const chips = c.phone ? personaChips(state.nodes) : [];
  const pKey = c.phone ? chips.map((p) => `${p.id}:${p.text}`).join('|') + `#${c.software}#${c.cloud}` : '';
  if (els.people.dataset.key !== pKey) {
    els.people.dataset.key = pKey;
    els.people.hidden = !c.phone;
    els.people.innerHTML = c.phone
      ? chips.map((p) => `<button type="button" class="hx-house-chip hx-house-chip--person" data-house="person" data-id="${escAttr(p.id)}">${escAttr(p.text)}</button>`).join('')
        + `<button type="button" class="hx-house-chip hx-house-chip--software" data-house="software" aria-pressed="${!!c.software}">Software</button>`
        + `<button type="button" class="hx-house-chip hx-house-chip--cloud" data-house="cloud" aria-pressed="${!!c.cloud}">Cloud</button>`
      : '';
  }
}

/** The "+3" chips: one per room that holds more than its grid, where its last slot is */
function paintMore() {
  const more = cfg().more || [];
  const key = more.map((m) => `${m.room}:${m.count}`).join('|');
  if (els.over.dataset.key !== key) {
    els.over.dataset.key = key;
    els.over.innerHTML = more.map((m) => {
      const room = nodeById(m.room);
      const name = room ? room.label : m.room;
      return `<button type="button" class="hx-house-more" data-house="more" data-room="${escAttr(m.room)}" aria-label="${escAttr(`${m.count} more in the ${name}: open the room`)}">+${m.count}</button>`;
    }).join('');
  }
}

/** The room a playing step happens in, or the selected room, marked on the plan too */
function markRoom() {
  const scn = state.scenario;
  const at = scn && !scn.done && scn.current ? scn.current.at || scn.current.node : null;
  const sel = state.selectedNode ? state.selectedNode.id : null;
  const id = [at, sel].find((v) => typeof v === 'string' && v.startsWith('live-room-')) || '';
  const room = id ? id.slice('live-room-'.length) : '';
  if (els.map.getAttribute('selected') !== room) els.map.setAttribute('selected', room); // pop-floor-map marks its selected room itself
  for (const a of els.map.querySelectorAll('[data-room]')) {
    if (a.getAttribute('data-room') === room) a.setAttribute('aria-current', 'true');
    else a.removeAttribute('aria-current');
  }
}

/** The underlay and the "+N" chips follow the camera: one CSS matrix() for the plan, screen px for the chips */
function followCamera() {
  if (!els || state.view !== 'house') return;
  const { x, y, zoom } = state.camera;
  const plan = cfg().plan || { x: 0, y: 0 };
  const t = `matrix(${zoom}, 0, 0, ${zoom}, ${x + plan.x * zoom}, ${y + plan.y * zoom})`;
  if (t !== lastTransform) {
    lastTransform = t;
    els.map.style.transform = t;
  }
  const more = cfg().more || [];
  els.over.querySelectorAll('.hx-house-more').forEach((b, i) => {
    const m = more[i];
    if (!m) return;
    b.style.transform = `translate(${Math.round(x + m.x * zoom)}px, ${Math.round(y + m.y * zoom)}px) translate(-50%, -50%)`;
  });
}

// ---------------------------------------------------------------------------
//  Taps
// ---------------------------------------------------------------------------
function onClick(e) {
  const t = e.target && e.target.closest ? e.target : null;
  if (!t) return;
  if (t.closest('[data-action="preset-house"]')) {
    if (state.view === 'house') closeHouse(); else openHouse();
    return;
  }
  const el = t.closest('[data-house]');
  if (!el || state.view !== 'house') return;
  const what = el.dataset.house;
  if (what === 'floor') setHouseFloor(el.dataset.floor);
  else if (what === 'person') { const node = nodeById(el.dataset.id); if (node) selectNode(node); }
  else if (what === 'software') { const c = cfg(); c.software = !c.software; relayout(); }
  else if (what === 'cloud') { const c = cfg(); c.cloud = !c.cloud; relayout(); fitHouse(); } // the band is above the plan: the fit reaches up to it
  else if (what === 'more') {
    const c = cfg();
    c.open = new Set([...c.open, el.dataset.room]);
    relayout();
    const room = nodeById(el.dataset.room);
    if (room) selectNode(room);
  }
}

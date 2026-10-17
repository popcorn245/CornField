/**
 * @module explorer/live-model
 *
 * The live layer's pure half (spec 0029 sections 4 and 9, PHY-09): the tool's side, no DOM, no
 * fetch, no storage. live.js runs it in the page; the tests run it in node.
 *
 * A **live source** (a plugin's adapter, e.g. plugins/house/browser.js) has
 *
 *     load({ groups, signal }) → Promise<LiveAnswer>          (throws an error with `reason` on failure)
 *     image?(url, { signal }) → Promise<Blob|null>             (a photo the panel shows from an in-memory blob URL)
 *     token?: { label, help, has(), save(value) → boolean, forget() }
 *                                                              (a token the Live menu sets: a password field shown while
 *                                                              the source fails `no-token` or `forbidden`; `help` is a line
 *                                                              under it, `code` in backticks; where it is kept is the source's)
 *
 *     A failure's error: `reason` no-token | forbidden | unavailable, and the source's own words: `hint` (why, after
 *     "Live layer off: "), `detail` (a line under it), `href` (a second place to fix it), `status`, `message`.
 *
 *     LiveAnswer { at, nodes, edges, accounts, hardware, notes, plan? }
 *       at        ISO time of the answer (the source's clock)
 *       nodes     live nodes: ids in the live-id grammar (`live-floor-…`, `live-room-…`, `live-device-<kind>-…`,
 *                 core/schema.js), `type` floor | room | device, `label`, `desc`; a room may carry `box`,
 *                 a device `kind`; a node with `account: { role, groups }` (a phone) is hung under its persona here
 *       edges     between live nodes, or from a live node to a code-derived one (`delivers` to a container);
 *                 an edge whose end is not on the map is left out
 *       accounts  `[{ role, groups, count }]`: counted onto the persona nodes (`countAccounts`), counts only
 *       hardware  `[{ kind: 'machine'|'camera', link, item: { id, name, room_id, image }, contents, contents_total, sets, roomName? }]`:
 *                 linked to the code-derived machine (by `hostname`) or camera (by `camera`) with that key
 *       notes     plain lines for the chip ("Home Assistant off: …")
 *       plan      the house plan as the source has it (for the House view, PHY-11), or absent
 *       resolve?  `(nodes, edges) → { edges?, nodes? }`: the source's own matching of its live nodes against the map
 *                 the answer is laid on (spec 0031 section 3.1): `edges` more live edges (a dashed placement from a
 *                 container or a cloud node), `nodes` fields by live id (`desc`, `unplaced`: the tray reason)
 *
 * What lives here:
 *  - `mergeLive(nodes, edges, answer)`: the map's nodes and edges with the live ones added. Never changes a
 *    code-derived node in place: persona nodes are copied with their count in the label, everything else is as given.
 *  - `placeLiveNodes(nodes, edges)`: positions for the live nodes beside a code layout that is already placed.
 *  - `chipModel(...)`: the words and tone of the live chip, for every state in the spec's table.
 *  - `createLiveRunner(...)`: loading, the 60 s refresh while a live layer is on and the tab is visible, and
 *    dropping the answer 10 minutes after the last good one (D10). Timers and clock are injected.
 *  - `liveDetailsHtml(...)`: the node panel's live section (a linked machine's photo, room, contents and sets).
 *
 * Nothing live is written anywhere: the answer lives in memory (`state.live`) and nowhere else.
 */

import { LIVE_ID_PREFIX, NODE_THEMES, parseLiveId } from '../core/schema.js';
import { countAccounts, decidingGroups } from '../core/personas.js';

/** Refresh every minute while a live layer is on and the tab is visible */
export const LIVE_POLL_MS = 60_000;
/** Drop the live nodes 10 minutes after the last good answer, so old counts never pass as current (D10) */
export const LIVE_DROP_MS = 10 * 60_000;
/** The Layers keys whose nodes come from (or are placed by) the live layer: one of them on is "a live layer is on" */
export const LIVE_LAYERS = ['machine', 'device', 'house', 'persona'];

/** The Layers key a node type belongs to: floors and rooms are the House layer, the rest by type */
export const layerOf = (type) => (type === 'floor' || type === 'room' ? 'house' : type);

/** Whether any live layer is on */
export const liveWanted = (activeLayers) => LIVE_LAYERS.some((k) => activeLayers[k] === true);

/** The personas the map holds, as the counting reads them (the persona nodes `sync` derives) */
export function personasOf(nodes) {
  return nodes.filter((n) => n.type === 'persona').map((n) => ({ id: n.id, role: n.role, groups: n.groups, account: n.account }));
}

/** The deciding groups a source counts by: every group a persona on the map names */
export const groupsOf = (nodes) => decidingGroups(personasOf(nodes));

/** "Adult · 2 people", "Admin · 1 person"; a persona with no account keeps its label */
export function countLabel(node, count) {
  if (node.account === false) return node.label;
  return `${node.label} · ${count} ${count === 1 ? 'person' : 'people'}`;
}

const isOwnership = (e) => !e.kind && !e.dashed;

/** The code-derived node a piece of linked hardware belongs to: a machine by hostname, a camera by its camera name */
export function linkedNodeId(nodes, hw) {
  const key = String(hw.link || '').toLowerCase();
  const found = hw.kind === 'camera'
    ? nodes.find((n) => n.type === 'device' && n.kind === 'camera' && (String(n.camera || '').toLowerCase() === key || n.id === `device-camera-${hw.link}`))
    : nodes.find((n) => n.type === 'machine' && (String(n.hostname || '').toLowerCase() === key || n.id === `machine-${hw.link}`));
  return found ? found.id : null;
}

/**
 * The map's nodes and edges with a live answer laid in. With no answer, the inputs come back as they are.
 * @param {object[]} nodes the code-derived map (or a proposal applied over it)
 * @param {object[]} edges
 * @param {object|null} answer a source's LiveAnswer
 * @returns {{ nodes: object[], edges: object[], counts: Record<string, number>, other: number, linked: Map<string, object>, rejected: string[] }}
 */
export function mergeLive(nodes, edges, answer) {
  const empty = { nodes, edges, counts: {}, other: 0, linked: new Map(), rejected: [] };
  if (!answer) return empty;
  const rejected = [];
  const taken = new Set(nodes.map((n) => n.id));

  // Counts on the persona nodes (copies: the code node is never changed)
  const personas = personasOf(nodes);
  const { counts, other } = countAccounts(personas, answer.accounts || []);
  const out = nodes.map((n) => (n.type === 'persona' ? { ...n, label: countLabel(n, counts[n.id] || 0), liveCount: counts[n.id] || 0, codeLabel: n.label } : n));

  // The live nodes: live ids only, no collisions, themed by type
  const live = [];
  for (const n of answer.nodes || []) {
    const parsed = parseLiveId(n && n.id);
    if (!parsed || !n.id.startsWith(LIVE_ID_PREFIX)) { rejected.push(`${n && n.id}: not a live id`); continue; }
    if (taken.has(n.id)) { rejected.push(`${n.id}: already on the map`); continue; }
    taken.add(n.id);
    const type = parsed.type;
    const theme = NODE_THEMES[type] || NODE_THEMES.device;
    live.push({ ...n, type, kind: n.kind || parsed.kind, label: String(n.label || n.id), r: theme.r, color: theme.color, live: true });
  }
  const all = [...out, ...live];
  const has = new Set(all.map((n) => n.id));

  const liveEdges = [];
  const seen = new Set();
  const addEdge = (e) => {
    const key = `${e.from}->${e.to}|${e.kind || (e.dashed ? 'dashed' : '')}`;
    if (!has.has(e.from) || !has.has(e.to) || seen.has(key)) return;
    seen.add(key);
    liveEdges.push({ ...e, live: true });
  };
  // The source's own matching of its live nodes against this map (`answer.resolve`, spec 0031 section 3.1: a
  // service device placed on the container or cloud node that serves its host): more edges, and fields on live nodes
  let resolved = { edges: [], nodes: {} };
  if (typeof answer.resolve === 'function') {
    try { resolved = answer.resolve(all, edges) || resolved; } catch (err) { rejected.push(`resolve: ${err && err.message}`); }
  }
  const liveById = new Map(live.map((n) => [n.id, n]));
  for (const [id, patch] of Object.entries(resolved.nodes || {})) {
    const n = liveById.get(id);
    if (!n || !patch || typeof patch !== 'object') continue;
    for (const [k, v] of Object.entries(patch)) if (!['id', 'type', 'live'].includes(k)) n[k] = v;
  }
  for (const e of [...(answer.edges || []), ...(resolved.edges || [])]) {
    // A live edge touches a live node: it never joins two code-derived nodes
    if (!(String(e.from).startsWith(LIVE_ID_PREFIX) || String(e.to).startsWith(LIVE_ID_PREFIX))) { rejected.push(`${e.from} -> ${e.to}: joins no live node`); continue; }
    addEdge(e);
  }

  // A node with an account (a phone) hangs under the persona that account counts toward
  const parented = new Set(liveEdges.filter(isOwnership).map((e) => e.to));
  for (const n of live) {
    if (!n.account || parented.has(n.id)) continue;
    const match = countAccounts(personas, [{ ...n.account, count: 1 }]);
    const persona = Object.keys(match.counts).find((id) => match.counts[id] === 1);
    if (persona) addEdge({ from: persona, to: n.id });
  }

  // Linked hardware: the details by node, and a dashed placement in its item's room
  const linked = new Map();
  for (const hw of answer.hardware || []) {
    const id = linkedNodeId(all, hw);
    if (!id) continue;
    linked.set(id, hw);
    if (hw.item && hw.item.room_id) addEdge({ from: `live-room-${hw.item.room_id}`, to: id, dashed: true, label: 'placed here (inventory)' });
  }

  return { nodes: all, edges: [...edges, ...liveEdges], counts, other, linked, rejected };
}

/**
 * Positions for the live nodes (`live: true`) next to a code layout that is already placed. Exact, no physics:
 *  - floors in a row below the map, by level; each floor's rooms on a ring around it, by name;
 *  - a node with a parent (a device in a room, a phone under its persona) fanned out beside it, away from the map's centre;
 *  - a node with no parent in a row under the house.
 * Mutates x and y of the live nodes only.
 */
export function placeLiveNodes(nodes, edges) {
  const live = nodes.filter((n) => n.live);
  if (!live.length) return;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parentOf = new Map();
  edges.forEach((e) => { if (isOwnership(e) && !parentOf.has(e.to) && byId.has(e.from)) parentOf.set(e.to, e.from); });
  // A live node with no owner but a dashed placement (a service device on its container) sits beside what places it
  edges.forEach((e) => { if (e.dashed && !e.kind && e.live && !parentOf.has(e.to) && byId.has(e.from) && byId.get(e.to) && byId.get(e.to).live) parentOf.set(e.to, e.from); });
  const childrenOf = (id) => live.filter((n) => parentOf.get(n.id) === id).sort((a, b) => String(a.label).localeCompare(String(b.label)) || a.id.localeCompare(b.id));

  const fixed = nodes.filter((n) => !n.live && Number.isFinite(n.x) && Number.isFinite(n.y));
  const extent = fixed.reduce((m, n) => Math.max(m, Math.hypot(n.x, n.y) + (n.r || 20)), 200);

  const done = new Set();
  const fan = (anchor, kids, start) => {
    if (!kids.length) return;
    const out = anchor.x === 0 && anchor.y === 0 ? Math.PI / 2 : Math.atan2(anchor.y, anchor.x);
    const perRing = 7;
    kids.forEach((k, i) => {
      const ring = Math.floor(i / perRing);
      const inRing = Math.min(perRing, kids.length - ring * perRing);
      const j = i % perRing;
      const step = 0.42;
      const a = out + (j - (inRing - 1) / 2) * step;
      const r = start + ring * 36;
      k.x = anchor.x + Math.cos(a) * r;
      k.y = anchor.y + Math.sin(a) * r;
      done.add(k.id);
    });
  };

  // Floors and their rooms: the house, below the map
  const floors = live.filter((n) => n.type === 'floor').sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.id.localeCompare(b.id));
  const plans = floors.map((f) => {
    const rooms = childrenOf(f.id).filter((n) => n.type === 'room');
    const ringR = Math.max(150, (rooms.length * 104) / (2 * Math.PI));
    return { f, rooms, ringR, half: ringR + 120 };
  });
  const width = plans.reduce((s, p) => s + 2 * p.half, 0) + Math.max(0, plans.length - 1) * 60;
  const top = extent + 120 + Math.max(0, ...plans.map((p) => p.half));
  let x = -width / 2;
  for (const p of plans) {
    p.f.x = x + p.half;
    p.f.y = top;
    done.add(p.f.id);
    p.rooms.forEach((room, i) => {
      const a = -Math.PI / 2 + (i / p.rooms.length) * Math.PI * 2;
      room.x = p.f.x + Math.cos(a) * p.ringR;
      room.y = p.f.y + Math.sin(a) * p.ringR;
      done.add(room.id);
    });
    x += 2 * p.half + 60;
  }
  const houseBottom = plans.length ? top + Math.max(...plans.map((p) => p.half)) : extent + 120;

  // Rooms whose floor is not there sit on their own ring under the floors
  const strayRooms = live.filter((n) => n.type === 'room' && !done.has(n.id));
  strayRooms.forEach((room, i) => { room.x = (i - (strayRooms.length - 1) / 2) * 110; room.y = houseBottom + 60; done.add(room.id); });

  // Everything with a parent, fanned beside it (rooms first, so a device follows its room)
  for (let pass = 0; pass < 4; pass++) {
    const anchors = new Set(live.filter((n) => !done.has(n.id) && parentOf.has(n.id)).map((n) => parentOf.get(n.id)));
    for (const id of anchors) {
      const anchor = byId.get(id);
      if (!anchor || (anchor.live && !done.has(anchor.id)) || !Number.isFinite(anchor.x)) continue;
      const kids = childrenOf(id).filter((k) => !done.has(k.id));
      fan(anchor, kids, (anchor.r || 16) + 40);
    }
  }

  // No parent: a row under the house
  const loose = live.filter((n) => !done.has(n.id)).sort((a, b) => a.id.localeCompare(b.id));
  const perRow = 12;
  loose.forEach((n, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, loose.length - row * perRow);
    n.x = ((i % perRow) - (inRow - 1) / 2) * 80;
    n.y = houseBottom + 140 + row * 70;
  });
}

// ---------------------------------------------------------------------------
//  The chip
// ---------------------------------------------------------------------------

/** "18:00": the answer's time on the viewer's clock */
export function clockOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * What a failure is, in the chip's words. The source says why in its error's `hint` ("no API token in this
 * browser"); without one the tool's own words stand.
 * @param {any} error
 * @param {{ settable?: boolean }} [opts] `settable`: the source has a token setting the Live menu shows
 * @returns {{ text: string, short: string, tone: 'off'|'error', href: string|null, house: string, fix: string }}
 *   `text` the full line, `short` the reason in brackets after a stale answer, `house` the House view's line (why
 *   nothing is placed), `fix` where to put it right ('' when the tool has nothing to point at)
 */
export function failureWords(error, { settable = false } = {}) {
  const reason = error && error.reason;
  const hint = error && typeof error.hint === 'string' && error.hint ? error.hint : '';
  let w;
  if (reason === 'no-token') {
    const short = hint || 'no token';
    w = { text: `Live layer off: ${short}`, short, tone: 'off', href: error.href || null, fix: settable ? 'Set one in the Live menu.' : '' };
  } else if (reason === 'forbidden') {
    const short = hint || "the token is not an admin's";
    w = { text: `Live layer off: ${short}`, short, tone: 'off', href: error.href || null, fix: settable ? 'Set another in the Live menu.' : '' };
  } else {
    const short = hint || 'the live source is not answering';
    w = { text: `Live layer unavailable: ${short}`, short, tone: 'error', href: null, fix: 'Refresh in the Live menu to try again.' };
  }
  return { ...w, house: `${w.text}, so machines can't be placed.` };
}

/**
 * The chip for a runner snapshot.
 * @param {{ status: string, answer: object|null, error: any, lastOkAt: number|null }} snap
 * @param {{ other?: number, now?: number, house?: boolean }} [opts] `other`: accounts no persona counts; `house`: the House view is open, which
 *   draws the default plan while there is no answer (PHY-11), so the chip says so
 * @returns {{ hidden: boolean, tone: 'ok'|'stale'|'off'|'error'|'idle', text: string, lines: string[], href: string|null, note: string|null }}
 */
export function chipModel(snap, { other = 0, now = Date.now(), house = false } = {}) {
  const base = { hidden: false, lines: [], href: null, note: null };
  if (!snap || snap.status === 'idle') return { ...base, hidden: true, tone: 'idle', text: '' };
  const extra = (answer) => [...(answer.notes || []), ...(other > 0 ? [`Other accounts · ${other}`] : [])];
  if (snap.answer && !snap.error) return { ...base, tone: 'ok', text: `Live · ${clockOf(snap.answer.at)}`, lines: extra(snap.answer) };
  if (snap.answer && snap.error) {
    const mins = Math.max(1, Math.round((now - snap.lastOkAt) / 60_000));
    const w = failureWords(snap.error);
    return { ...base, tone: 'stale', text: `Live · as of ${mins} min ago (${w.short})`, lines: extra(snap.answer), href: w.href, note: errorNote(snap.error) };
  }
  if (snap.error) {
    const w = failureWords(snap.error);
    if (house) return { ...base, tone: w.tone, text: `Default plan, live layer ${w.tone === 'off' ? 'off' : 'unavailable'}`, lines: [w.house], href: w.href, note: errorNote(snap.error) };
    return { ...base, tone: w.tone, text: w.text, href: w.href, note: errorNote(snap.error) };
  }
  return { ...base, tone: 'idle', text: 'Live layer: loading…' };
}

/** The detail of a failure for the chip's menu: the source's `detail`, else the status or the message, never a token */
function errorNote(error) {
  if (!error) return null;
  if (typeof error.detail === 'string' && error.detail) return error.detail;
  if (error.hint) return null; // the source said why already, status and all
  if (error.status) return `The source answered ${error.status}.`;
  if (error.reason === 'no-token' || error.reason === 'forbidden') return null;
  return error.message && error.message !== error.reason ? `(${error.message})` : null;
}

// ---------------------------------------------------------------------------
//  The runner: load, refresh, drop
// ---------------------------------------------------------------------------

/**
 * Loads a live source while a live layer is on, refreshes it every `pollMs` while the tab is visible,
 * and drops the answer `dropMs` after the last good one.
 * @param {object} opts
 * @param {{ load: Function }} opts.source
 * @param {() => string[]} opts.groups the deciding groups to ask for
 * @param {() => boolean} opts.wanted whether a live layer is on (or the House view is open)
 * @param {() => boolean} [opts.visible] whether the tab is visible
 * @param {(snap: object) => void} [opts.onChange] after every change of the snapshot
 * @param {() => number} [opts.now]
 * @param {{ set: Function, clear: Function }} [opts.timers]
 */
export function createLiveRunner({ source, groups, wanted, visible = () => true, onChange = () => {}, now = () => Date.now(), timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) }, pollMs = LIVE_POLL_MS, dropMs = LIVE_DROP_MS }) {
  /** @type {{ status: 'idle'|'loading'|'ok'|'failed', answer: object|null, error: any, lastOkAt: number|null, lastTryAt: number|null }} */
  const snap = { status: 'idle', answer: null, error: null, lastOkAt: null, lastTryAt: null };
  let timer = null;
  let dropTimer = null;
  let inflight = null;
  let seq = 0;

  const changed = () => onChange(snapshot());
  const snapshot = () => ({ ...snap });

  /** Drops the answer once it is too old; true when it did */
  function expire() {
    if (snap.answer && snap.lastOkAt != null && now() - snap.lastOkAt >= dropMs) {
      snap.answer = null;
      if (!snap.error) snap.error = { reason: 'unavailable', message: 'no answer for 10 minutes' };
      snap.status = 'failed';
      return true;
    }
    return false;
  }

  function armDrop() {
    if (dropTimer) timers.clear(dropTimer);
    dropTimer = null;
    if (snap.answer && snap.lastOkAt != null) {
      dropTimer = timers.set(() => { dropTimer = null; if (expire()) changed(); }, Math.max(0, snap.lastOkAt + dropMs - now()));
    }
  }

  function schedule() {
    if (timer) timers.clear(timer);
    timer = null;
    if (!wanted() || !visible()) return;
    const last = snap.lastTryAt == null ? -Infinity : snap.lastTryAt;
    timer = timers.set(() => { timer = null; refresh(); }, Math.max(0, last + pollMs - now()));
  }

  /** Asks the source now (the chip's Refresh, and every tick) */
  async function refresh() {
    if (inflight) inflight.abort();
    const ctl = new AbortController();
    inflight = ctl;
    const mine = ++seq;
    snap.lastTryAt = now();
    if (!snap.answer && !snap.error) snap.status = 'loading';
    changed();
    try {
      const answer = await source.load({ groups: groups(), signal: ctl.signal });
      if (mine !== seq) return;
      snap.answer = answer;
      snap.error = null;
      snap.lastOkAt = now();
      snap.status = 'ok';
    } catch (err) {
      if (mine !== seq || ctl.signal.aborted) return;
      snap.error = err && err.reason ? err : { reason: 'unavailable', message: String((err && err.message) || err) };
      snap.status = 'failed';
      expire();
    } finally {
      if (mine === seq) inflight = null;
    }
    armDrop();
    schedule();
    changed();
  }

  /** Call when the layers, the view or the tab's visibility change: starts, keeps or stops the refresh */
  function sync() {
    if (expire()) { armDrop(); changed(); }
    if (!wanted()) {
      if (timer) timers.clear(timer);
      timer = null;
      return;
    }
    if (!visible()) { if (timer) timers.clear(timer); timer = null; return; }
    const due = snap.lastTryAt == null || now() - snap.lastTryAt >= pollMs;
    if (due && !inflight) refresh();
    else schedule();
  }

  function stop() {
    if (timer) timers.clear(timer);
    if (dropTimer) timers.clear(dropTimer);
    if (inflight) inflight.abort();
    timer = dropTimer = inflight = null;
  }

  return { refresh, sync, stop, snapshot };
}

// ---------------------------------------------------------------------------
//  The node panel
// ---------------------------------------------------------------------------

/**
 * The live section of the node panel, or ''. `esc` escapes text; `live` is `state.live`.
 * A linked machine or camera: its inventory name, a photo slot (`data-live-photo`, filled by live.js), its
 * room, what is inside it (an indented list, at most what the source sent, D12) and its sets. An unlinked one
 * says which key found no item. A persona: its count. Anything else live: its source and the answer's time.
 */
export function liveDetailsHtml(node, live, esc) {
  if (!node) return '';
  const answer = live && live.answer;
  const sec = (title, body) => `<div class="hx-sec hx-live-sec"><strong class="hx-strong">${title}</strong>${body}</div>`;
  const when = answer ? `<div class="hx-faint">Live · ${esc(clockOf(answer.at))}</div>` : '';

  if (node.type === 'persona') {
    if (!answer) return sec('Accounts:', '<div class="hx-faint">Turn on a live layer to count them.</div>');
    if (node.account === false) return sec('Accounts:', `<div>No account: nobody to count.</div>${when}`);
    const n = node.liveCount || 0;
    return sec('Accounts:', `<div><span class="hx-accent hx-bold">${n}</span> ${n === 1 ? 'account' : 'accounts'} (counts only, never who)</div>${when}`);
  }

  const linkable = node.type === 'machine' || (node.type === 'device' && node.kind === 'camera');
  if (linkable) {
    if (!answer) return sec('Inventory:', '<div class="hx-faint">Turn on a live layer to see its inventory item.</div>');
    const hw = live.linked && live.linked.get(node.id);
    if (!hw) {
      if (node.virtual) return sec('Inventory:', '<div class="hx-faint">A virtual machine has no inventory item: it goes where its host goes.</div>');
      const key = node.type === 'machine' ? `hostname ${esc(node.hostname || node.label)}` : `the camera name ${esc(node.camera || node.label)}`;
      return sec('Inventory:', `<div>No inventory item has ${key}</div>${when}`);
    }
    const item = hw.item || {};
    const photo = item.image ? `<img class="hx-live-photo" data-live-photo="${esc(item.image)}" alt="Photo of ${esc(item.name || node.label)}" hidden />` : '';
    const room = item.room_id ? `<div>Room: <button type="button" class="hx-linkbtn" data-action="select-node" data-id="live-room-${esc(item.room_id)}">${esc(hw.roomName || item.room_id)}</button></div>` : '<div class="hx-faint">Its item has no room</div>';
    const contents = hw.contents || [];
    const total = hw.contents_total ?? contents.length;
    const rows = contents.map((c) => `<li style="padding-left:${Math.max(0, (c.depth || 1) - 1) * 14}px">${esc(c.name)}${c.quantity && c.quantity !== 1 ? ` <span class="hx-faint">× ${esc(String(c.quantity))}</span>` : ''}</li>`).join('');
    const more = total > contents.length ? `<div class="hx-faint">and ${total - contents.length} more</div>` : '';
    const sets = (hw.sets || []).map((s) => `<li>${esc(s.name)}${s.kind ? ` <span class="hx-faint">${esc(s.kind)}</span>` : ''}</li>`).join('');
    return sec('Inventory item:', `<div class="hx-name">${esc(item.name || '')}</div>${photo}${room}${when}`)
      + sec(`Inside it (${total}):`, contents.length ? `<ul class="hx-live-list">${rows}</ul>${more}` : '<div class="hx-faint">Nothing recorded inside it</div>')
      + sec('Sets:', sets ? `<ul class="hx-live-list">${sets}</ul>` : '<div class="hx-faint">In no set</div>');
  }

  if (node.live) {
    const box = node.box ? `<div class="hx-faint">Box ${esc(`${node.box.x}, ${node.box.y}, ${node.box.w} × ${node.box.h}`)} on the floor plan</div>` : '';
    return sec('Live:', `<div>From the live layer; never committed.</div>${box}${when}`);
  }
  return '';
}

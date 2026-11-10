/**
 * @module explorer/house-model
 *
 * The House view's pure half (spec 0029 section 7, PHY-11): the tool's side, no DOM, no fetch, no
 * storage. house.js puts it on the page; view.js calls `applyHouseLayout` while the House view is open;
 * scene.js asks `houseShowsNode`, `houseEdgeStyle` and `decorateHouseScene`. The tests run it in node.
 *
 * The picture, in world units (one floor at a time, the plan at HOUSE_SCALE times the 800 × 600 floor viewBox):
 *
 *     [ Cloud: outside the house, what we do not control (spec 0031 section 7, CLOUD-08) ]
 *       Runtime · Software sources · Accounts, one row each          [ Public web, not cloud ]
 *     ─────────────────────────────────── the street ───────────────────────────────────
 *     [ People ]   [ the plan of one floor ]   [ On other floors ]   [ Software ]
 *      persona       rooms (small node at        machines whose        stack ── containers ── apps
 *      + phones      the box centre), and        room is on another    (apps with the Apps layer)
 *                    in each room its devices    floor, so `runs-on`   packages that run on a machine
 *                    and linked hardware on a    still has an end
 *                    grid ("+3" when full)
 *                  [ Unplaced: by kind, and the line naming what has no room or no inventory item ]
 *
 * On a phone (under 768 px) the people become chips above the plan (house.js) and are not drawn; the
 * software is drawn only when its toggle is on, below the plan as one column; the cloud only when its toggle is
 * on (or an outage plays), above the plan as a wrapped grid by role; the fit is the plan (and the cloud above it).
 *
 * The Cloud band's lines are rolled up when drawn, never stored (spec D8): `houseCloudLinks` walks each `calls`
 * edge into a cloud node from a service or an endpoint up to the container that runs it, and the layout keeps one
 * line per (container, cloud node, when) as `cloudLines`, which scene.js draws with the map's edges (`houseViewEdges`).
 *
 * The plan is the tool's shape: `{ viewBox, floors: [{ id, name, level }], rooms: [{ id, floor_id, name, x, y, w, h }] }`
 * (a live answer's `plan`, or the plugin's default plan). A room on the plan is the live node `live-room-<id>`
 * (core/schema.js's live-id grammar); a floor is `live-floor-<id>`. Where a thing is comes from
 * the map's edges: a device is in the room that owns it, linked hardware in the room a dashed live placement
 * puts it in, a virtual machine wherever the machine it runs on is.
 */

import { failureWords } from './live-model.js';
import { WHEN_STYLES, whenOf } from './cloud-model.js';
import { outageFor } from './outage-model.js';

/** World units per floor viewBox unit */
export const HOUSE_SCALE = 2;
/** The radius each kind of thing is drawn at in the House view: a machine a size larger than a device, a room small */
export const HOUSE_SIZES = { room: 8, floor: 14, device: 13, machine: 20, persona: 18, phone: 11, stack: 16, container: 9, app: 11, pkg: 14, external: 12 };
/** One slot of a room's grid (world units): room for a device and its label */
export const ROOM_CELL = { w: 210, h: 56 };
/** The grid's inset from a room's box: below the room's name, clear of its edges */
export const ROOM_INSET = { x: 20, top: 44, bottom: 8 };
/** The gap between the plan and the bands */
export const BAND_GAP = 170;
/** The kinds of the Unplaced tray, in order, with their titles */
export const TRAY_KINDS = [
  ['machine', 'Machines'], ['camera', 'Cameras'], ['home-assistant', 'Home Assistant devices'], ['service-device', 'Service devices'],
  ['nfc-tag', 'NFC tags'], ['phone', 'Phones'], ['room', 'Rooms with no box'], ['other', 'Other'],
];

const LANE_LOOK = { radius: 22, fill: 'rgba(66, 153, 225, 0.05)', stroke: 'rgba(66, 153, 225, 0.2)', strokeWidth: 1.5 };
const SUB_LANE_LOOK = { radius: 16, fill: 'rgba(148, 163, 184, 0.05)', stroke: 'rgba(148, 163, 184, 0.16)', strokeWidth: 1 };
const TITLE = { size: 34, color: '#e2e8f0' };
const NOTE = { size: 20, color: '#94a3b8' };

const isOwnership = (e) => !e.kind && !e.dashed;
const byLabel = (a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)) || a.id.localeCompare(b.id);
export const roomNodeId = (roomId) => `live-room-${roomId}`;
export const floorNodeId = (floorId) => `live-floor-${floorId}`;

/** The floors of a plan in the order the chips show them: the highest level first (Main Floor · Basement) */
export function floorsOf(plan) {
  return [...((plan && plan.floors) || [])].sort((a, b) => (b.level ?? 0) - (a.level ?? 0) || String(a.id).localeCompare(String(b.id)));
}

/** The floor shown when none was asked for (or the one asked for is not on the plan): level 0, else the first */
export function defaultFloor(plan, wanted = null) {
  const floors = floorsOf(plan);
  if (wanted && floors.some((f) => f.id === wanted)) return wanted;
  const ground = floors.find((f) => (f.level ?? 0) === 0);
  return ground ? ground.id : floors.length ? floors[0].id : null;
}

/**
 * The plan the House view draws: the live answer's, else the fallback (the plugin's default plan), else none.
 * @returns {{ plan: object|null, source: 'live'|'default'|'none' }}
 */
export function pickPlan(answer, fallback) {
  if (answer && answer.plan && Array.isArray(answer.plan.floors) && answer.plan.floors.length) return { plan: answer.plan, source: 'live' };
  if (fallback && Array.isArray(fallback.floors) && fallback.floors.length) return { plan: fallback, source: 'default' };
  return { plan: null, source: 'none' };
}

const hasBox = (r) => r && [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && Number.isFinite(v)) && r.w > 0 && r.h > 0;

/** The tray kind of a thing that has no place on the plan */
export function trayKind(node) {
  if (node.type === 'machine') return 'machine';
  if (node.type === 'room') return 'room';
  if (node.type === 'device' && node.service) return 'service-device'; // software (spec 0031 section 3.1)
  if (node.type === 'device') return ['camera', 'home-assistant', 'nfc-tag', 'phone'].includes(node.kind) ? node.kind : 'other';
  return 'other';
}

/** The order things fill a room's grid: machines (each followed by its virtual machines), cameras, then the rest by kind and name */
const ROOM_ORDER = ['machine', 'camera', 'home-assistant', 'nfc-tag', 'phone', 'other'];

/**
 * A room's grid: cell centres inset from its box (world units), left to right, top to bottom, leaving out the
 * cell the room's own node sits in (the box centre) once there are four or more, or more than `need` (the things to place). `extra` adds that many
 * cells in rows below the box (an opened room). Always at least one cell.
 */
export function roomCells(box, extra = 0, need = Infinity) {
  const innerW = Math.max(1, box.w - 2 * ROOM_INSET.x);
  const cols = Math.max(1, Math.floor(innerW / ROOM_CELL.w));
  const cw = innerW / cols;
  const innerH = box.h - ROOM_INSET.top - ROOM_INSET.bottom;
  const rows = Math.max(1, Math.floor(innerH / ROOM_CELL.h));
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const at = (c, r) => ({ x: box.x + ROOM_INSET.x + cw * (c + 0.5), y: box.y + ROOM_INSET.top + ROOM_CELL.h * (r + 0.5) });
  let cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push(at(c, r));
  if (cells.length >= 4 || (cells.length > 1 && cells.length > need)) {
    const centre = cells.findIndex((p) => Math.abs(p.x - cx) < cw / 2 && Math.abs(p.y - cy) < ROOM_CELL.h / 2);
    if (centre >= 0) cells = cells.filter((_, i) => i !== centre);
  }
  for (let r = rows; cells.length < rows * cols + extra; r++) for (let c = 0; c < cols; c++) cells.push(at(c, r));
  return cells;
}

/**
 * Lays out the House view. Pure: reads its input, returns positions and what is shown.
 * @param {object} input
 * @param {object[]} input.nodes the map (code-derived and live nodes, as `state.nodes`)
 * @param {object[]} input.edges
 * @param {object|null} input.plan the plan (`pickPlan`)
 * @param {string|null} [input.floor] the floor asked for
 * @param {boolean} [input.phone] the phone layout (under 768 px)
 * @param {boolean} [input.software] on a phone: the Software toggle
 * @param {boolean} [input.cloud] on a phone: the Cloud toggle
 * @param {{ down: string[], hits: Map<string, object> } | null} [input.outage] a playing outage's blast radius (outage-model.js):
 *   its down nodes and the cloud nodes it reaches are in the Cloud band whatever the Layers or the phone's toggle say
 * @param {Set<string>} [input.open] rooms opened past their "+N"
 * @param {Record<string, boolean>} [input.layers] the Layers toggles (Apps and Packages apply to the software, Cloud and Public web to the Cloud band)
 * @param {string[]} [input.notes] the line under the tray: what has no room or no inventory item
 * @returns {{
 *   floor: string|null, floors: object[], plan: {x:number, y:number, w:number, h:number},
 *   pos: Map<string, {x:number, y:number, r:number}>, shown: Set<string>, floorOf: Map<string, string>, roomOf: Map<string, string>,
 *   lanes: object[], more: {room: string, count: number, x: number, y: number}[], fit: {minX:number, maxX:number, minY:number, maxY:number},
 *   tray: Map<string, string[]>, elsewhere: Map<string, string[]>, cloudIds: Set<string>, cloudLines: object[],
 * }}
 */
export function layoutHouse({ nodes, edges, plan, floor = null, phone = false, software = false, cloud = false, outage = null, open = new Set(), layers = {}, notes = [] }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const floors = floorsOf(plan);
  const current = defaultFloor(plan, floor);
  const vb = (plan && plan.viewBox) || { width: 800, height: 600 };
  const planRect = { x: 0, y: 0, w: vb.width * HOUSE_SCALE, h: vb.height * HOUSE_SCALE };
  const S = HOUSE_SCALE;
  const pos = new Map();
  const shown = new Set();
  const floorOf = new Map();
  const roomOf = new Map();
  const lanes = [];
  const more = [];
  const place = (id, x, y, r) => { pos.set(id, { x, y, r }); shown.add(id); };
  const sizeOf = (n) => (n.type === 'device' && n.kind === 'phone' ? HOUSE_SIZES.phone : HOUSE_SIZES[n.type] || HOUSE_SIZES.device);

  // The rooms: on the plan (with a box) by plan id; the room nodes for them
  const planRooms = new Map(((plan && plan.rooms) || []).map((r) => [r.id, r]));
  const roomBox = new Map(); // room node id -> its world box
  for (const n of nodes) {
    if (n.type !== 'room') continue;
    const pr = n.id.startsWith('live-room-') ? planRooms.get(n.id.slice('live-room-'.length)) : null;
    const src = pr && hasBox(pr) ? pr : n.box && hasBox(n.box) ? n.box : null;
    const fl = (pr && pr.floor_id) || n.floor || null;
    if (fl) floorOf.set(n.id, fl);
    if (src && fl) roomBox.set(n.id, { x: planRect.x + src.x * S, y: planRect.y + src.y * S, w: src.w * S, h: src.h * S });
  }
  for (const n of nodes) if (n.type === 'floor' && n.id.startsWith('live-floor-')) floorOf.set(n.id, n.id.slice('live-floor-'.length));

  // Where each thing is: an owning room, or a dashed live placement from a room; a virtual machine follows its host
  const parentOf = new Map();
  const placedIn = new Map();
  const hostOf = new Map();
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    if (isOwnership(e) && !parentOf.has(e.to)) parentOf.set(e.to, e.from);
    if (e.dashed && !e.kind && from.type === 'room' && !placedIn.has(e.to)) placedIn.set(e.to, e.from);
    if (e.kind === 'runs-on' && from.type === 'machine' && to.type === 'machine' && from.virtual) hostOf.set(e.from, e.to);
  }
  const roomIdOf = (n) => {
    const p = parentOf.get(n.id);
    if (p && byId.get(p) && byId.get(p).type === 'room') return p;
    return placedIn.get(n.id) || null;
  };

  // The things that live in the house: devices and machines (phones under a persona go to the people)
  const personaOf = (n) => { const p = parentOf.get(n.id); return p && byId.get(p) && byId.get(p).type === 'persona' ? p : null; };
  const things = nodes.filter((n) => (n.type === 'device' || n.type === 'machine') && !(n.type === 'machine' && n.virtual && hostOf.has(n.id)) && !(n.type === 'device' && n.kind === 'phone' && personaOf(n)));
  const virtualsOf = (hostId) => nodes.filter((n) => n.type === 'machine' && n.virtual && hostOf.get(n.id) === hostId).sort(byLabel);

  const inRoom = new Map(); // room node id -> things
  const tray = new Map(); // kind -> ids
  const elsewhere = new Map(); // floor id -> machine ids (machines on another floor)
  const toTray = (n) => { const k = trayKind(n); if (!tray.has(k)) tray.set(k, []); tray.get(k).push(n.id); };
  const besideCloud = cloudBesideOf(nodes, edges); // placed beside their cloud node in the Cloud band, never in a room or the tray
  // Service devices (spec 0031 section 3.1): software, never in a room. One placed (dashed) on a container sits
  // beside it in the Software band; one on a cloud node is the Cloud band's (above); the rest go to the tray with their reason
  const besideContainer = new Map(); // container id -> service devices
  const serviceReasons = [];
  const containerOf = (n) => {
    for (const e of edges) if (e.to === n.id && e.dashed && !e.kind && byId.get(e.from) && byId.get(e.from).type === 'container') return byId.get(e.from);
    return null;
  };
  for (const n of things) {
    if (n.type !== 'device' || !n.service || besideCloud.placed.has(n.id)) continue;
    const by = containerOf(n);
    if (by) {
      if (!besideContainer.has(by.id)) besideContainer.set(by.id, []);
      besideContainer.get(by.id).push(n);
      continue;
    }
    serviceReasons.push(n.unplaced || (n.host ? `Service device, host not on the map: ${n.host}` : 'Service device with no host'));
    toTray(n);
  }
  for (const n of things) {
    if (besideCloud.placed.has(n.id)) continue;
    if (n.type === 'device' && n.service) continue;
    const room = roomIdOf(n);
    if (room && roomBox.has(room)) {
      roomOf.set(n.id, room);
      floorOf.set(n.id, floorOf.get(room));
      if (!inRoom.has(room)) inRoom.set(room, []);
      inRoom.get(room).push(n);
    } else {
      toTray(n);
    }
  }
  // Rooms with no box wait in the tray, and so does what is in them (above)
  for (const n of nodes) if (n.type === 'room' && !roomBox.has(n.id) && (!floorOf.get(n.id) || floorOf.get(n.id) === current || !floors.some((f) => f.id === floorOf.get(n.id)))) toTray(n);
  // A virtual machine is where its host is
  for (const n of nodes) {
    if (!(n.type === 'machine' && n.virtual && hostOf.has(n.id))) continue;
    const host = hostOf.get(n.id);
    if (roomOf.has(host)) { roomOf.set(n.id, roomOf.get(host)); floorOf.set(n.id, floorOf.get(host)); }
  }

  // ---- The plan: the current floor's rooms and what is in them ----
  if (current) {
    const fNode = byId.get(floorNodeId(current));
    if (fNode) place(fNode.id, planRect.x + 30, planRect.y - 46, HOUSE_SIZES.floor);
  }
  for (const [roomId, box] of roomBox) {
    if (floorOf.get(roomId) !== current) continue;
    place(roomId, box.x + box.w / 2, box.y + box.h / 2, HOUSE_SIZES.room);
    const items = (inRoom.get(roomId) || []).slice().sort((a, b) => ROOM_ORDER.indexOf(trayKind(a)) - ROOM_ORDER.indexOf(trayKind(b)) || byLabel(a, b));
    const seq = items.flatMap((n) => (n.type === 'machine' ? [n, ...virtualsOf(n.id)] : [n]));
    const opened = open.has(roomId);
    const cells = roomCells(box, opened ? seq.length : 0, seq.length);
    const fits = seq.length <= cells.length;
    const room = fits ? seq.length : Math.max(0, cells.length - 1);
    seq.slice(0, room).forEach((n, i) => place(n.id, cells[i].x, cells[i].y, sizeOf(n)));
    if (!fits) more.push({ room: roomId, count: seq.length - room, x: cells[room].x, y: cells[room].y });
  }
  // What is on another floor is not drawn, except the machines: they wait beside the plan so `runs-on` still has an end
  for (const n of things) {
    if (n.type !== 'machine' || !roomOf.has(n.id)) continue;
    const f = floorOf.get(n.id);
    if (f === current) continue;
    if (!elsewhere.has(f)) elsewhere.set(f, []);
    elsewhere.get(f).push(n.id, ...virtualsOf(n.id).map((v) => v.id));
  }

  const floorName = (id) => (floors.find((f) => f.id === id) || { name: id }).name;
  const lane = (x, y, w, h, title, note, look = LANE_LOOK, size = 1) => ({
    x, y, w, h, ...look,
    title: { text: title, x: x + w / 2, y: y - (note ? 20 + NOTE.size * size : 14), size: Math.round(TITLE.size * size), bold: true, color: TITLE.color },
    note: note ? { text: note, x: x + w / 2, y: y - 12, size: Math.round(NOTE.size * size), bold: false, color: NOTE.color } : null,
    arrow: null,
  });

  // ---- Below or beside the plan: the machines on other floors ----
  const below = { y: planRect.y + planRect.h + 150 }; // the phone stacks everything below the plan
  let rightX = planRect.x + planRect.w + BAND_GAP; // the desktop puts the bands right of it
  if (elsewhere.size) {
    const groups = [...elsewhere].sort((a, b) => floors.findIndex((f) => f.id === a[0]) - floors.findIndex((f) => f.id === b[0]));
    if (phone) {
      for (const [f, ids] of groups) {
        const cols = Math.max(1, Math.floor((planRect.w - 40) / ROOM_CELL.w));
        const rows = Math.ceil(ids.length / cols);
        ids.forEach((id, i) => place(id, planRect.x + 20 + ROOM_CELL.w * ((i % cols) + 0.5), below.y + 40 + ROOM_CELL.h * Math.floor(i / cols), sizeOf(byId.get(id))));
        lanes.push(lane(planRect.x, below.y, planRect.w, rows * ROOM_CELL.h + 40, `On the ${floorName(f)}`, 'Switch floors to see its rooms', SUB_LANE_LOOK));
        below.y += rows * ROOM_CELL.h + 40 + 150;
      }
    } else {
      let y = planRect.y + 60;
      const w = 240;
      for (const [f, ids] of groups) {
        const top = y;
        ids.forEach((id, i) => place(id, rightX + w / 2, top + 50 + i * 110, sizeOf(byId.get(id))));
        const h = ids.length * 110 + 20;
        lanes.push(lane(rightX, top, w, h, `On the ${floorName(f)}`, 'Switch floors for its rooms', SUB_LANE_LOOK, 0.8));
        y += h + 140;
      }
      rightX += w + BAND_GAP;
    }
  }

  // ---- The Unplaced tray, by kind ----
  const trayGroups = TRAY_KINDS.filter(([k]) => tray.has(k)).map(([k, title]) => [k, title, tray.get(k).flatMap((id) => {
    const n = byId.get(id);
    return n.type === 'machine' ? [id, ...virtualsOf(id).map((v) => v.id)] : [id];
  })]);
  const noteLine = (notes || []).filter(Boolean).join(' · ');
  if (trayGroups.length || noteLine) {
    const top = below.y;
    let y = top + 20;
    const TW = 260;
    const cols = Math.max(1, Math.floor((planRect.w - 60) / TW));
    for (const [kind, title, ids] of trayGroups) {
      const rows = Math.ceil(ids.length / cols);
      const subTop = y + 64;
      ids.forEach((id, i) => place(id, planRect.x + 30 + TW * ((i % cols) + 0.5), subTop + 34 + ROOM_CELL.h * Math.floor(i / cols), sizeOf(byId.get(id))));
      const why = kind === 'service-device' ? [...new Set(serviceReasons)].join(' · ') : ''; // each service device's reason
      lanes.push(lane(planRect.x + 16, subTop, planRect.w - 32, rows * ROOM_CELL.h + 30, title, why, SUB_LANE_LOOK, 0.7));
      y = subTop + rows * ROOM_CELL.h + 30;
    }
    const h = Math.max(70, y - top + 24);
    lanes.unshift(lane(planRect.x, top, planRect.w, h, 'Unplaced', noteLine || 'Everything has a room', LANE_LOOK));
    below.y = top + h + 150;
  }

  // ---- People, left of the plan (the desktop; a phone shows chips instead) ----
  const personas = nodes.filter((n) => n.type === 'persona');
  if (!phone && personas.length) {
    const px = planRect.x - BAND_GAP - 90;
    const rowH = 150;
    let widest = 0;
    personas.forEach((p, i) => {
      const y = planRect.y + 90 + i * rowH;
      place(p.id, px, y, HOUSE_SIZES.persona);
      const phones = nodes.filter((n) => n.type === 'device' && parentOf.get(n.id) === p.id).sort(byLabel);
      phones.forEach((ph, j) => place(ph.id, px - 150 - j * 150, y, HOUSE_SIZES.phone));
      widest = Math.max(widest, phones.length);
    });
    const left = px - 110 - widest * 150;
    lanes.push(lane(left, planRect.y, px + 110 - left, personas.length * rowH + 40, 'People', 'Counts only, never who'));
  }

  // ---- Software: each stack, its containers, the apps it serves; packages that run on a machine ----
  if (!phone || software) {
    const stacks = nodes.filter((n) => n.type === 'stack').sort(byLabel);
    // Each container, followed by the service devices it serves (spec 0031 section 3.1): they sit beside it in its grid
    const containersOf = (id) => nodes.filter((n) => n.type === 'container' && parentOf.get(n.id) === id).sort(byLabel).flatMap((c) => [c, ...(besideContainer.get(c.id) || []).sort(byLabel)]);
    const cellR = (c) => (c.type === 'container' ? HOUSE_SIZES.container : sizeOf(c));
    const servedBy = new Map();
    for (const e of edges) {
      const from = byId.get(e.from);
      if (e.kind === 'runs-on' && from && from.type === 'app' && byId.get(e.to) && byId.get(e.to).type === 'stack') {
        if (!servedBy.has(e.to)) servedBy.set(e.to, []);
        servedBy.get(e.to).push(from);
      }
    }
    const appsOf = (id) => (layers.app === false ? [] : (servedBy.get(id) || []).slice().sort(byLabel));
    const pkgs = layers.pkg === false ? [] : nodes.filter((n) => n.type === 'pkg' && edges.some((e) => e.kind === 'runs-on' && e.from === n.id && byId.get(e.to) && byId.get(e.to).type === 'machine')).sort(byLabel);
    const CC = { w: 150, h: 40 };
    if (!phone) {
      // One row per stack (its containers in a grid of three, its apps in a column after them); rows that run much
      // longer than the plan are split into balanced columns, so the picture stays about as tall as the house
      const perRow = 3;
      const APP_H = 36;
      const rowsOf = stacks.map((s) => {
        const cs = containersOf(s.id);
        const apps = appsOf(s.id);
        const gridW = CC.w * Math.min(perRow, Math.max(1, cs.length));
        return { s, cs, apps, gridW, h: Math.max(76, Math.ceil(cs.length / perRow) * CC.h + 30, apps.length * APP_H + 30) };
      });
      pkgs.forEach((p) => rowsOf.push({ s: p, cs: [], apps: [], gridW: 0, h: 76 }));
      const total = rowsOf.reduce((t, r) => t + r.h, 0);
      const columns = Math.max(1, Math.min(3, Math.ceil(total / (planRect.h * 1.25))));
      const perColumn = total / columns;
      const cols = [[]];
      let acc = 0;
      for (const r of rowsOf) {
        if (acc > 0 && acc + r.h / 2 > perColumn * cols.length && cols.length < columns) cols.push([]);
        cols[cols.length - 1].push(r);
        acc += r.h;
      }
      const colW = 210 + CC.w * perRow + 60 + 280;
      let bottom = planRect.y + 60;
      cols.forEach((col, ci) => {
        const x0 = rightX + ci * (colW + 40);
        let y = planRect.y + 60;
        for (const r of col) {
          place(r.s.id, x0 + 70, y + 24, r.s.type === 'pkg' ? HOUSE_SIZES.pkg : HOUSE_SIZES.stack);
          r.cs.forEach((c, i) => place(c.id, x0 + 210 + CC.w * (i % perRow), y + 24 + CC.h * Math.floor(i / perRow), cellR(c)));
          r.apps.forEach((a, i) => place(a.id, x0 + 210 + r.gridW + 70, y + 24 + i * APP_H, HOUSE_SIZES.app));
          y += r.h;
        }
        bottom = Math.max(bottom, y);
      });
      if (rowsOf.length) lanes.push(lane(rightX - 30, planRect.y, cols.length * (colW + 40) + 20, bottom - planRect.y + 10, 'Software', 'What runs on the machines'));
    } else {
      const cols = Math.max(1, Math.floor((planRect.w - 230) / CC.w));
      const top = below.y;
      let y = top + 40;
      for (const s of stacks) {
        // The containers in a grid beside the stack, then its apps on rows of their own (their names are longer)
        const cs = containersOf(s.id);
        const apps = appsOf(s.id);
        const appCols = Math.max(1, Math.floor(cols / 2));
        place(s.id, planRect.x + 70, y + 24, HOUSE_SIZES.stack);
        cs.forEach((c, i) => place(c.id, planRect.x + 220 + CC.w * (i % cols), y + 24 + CC.h * Math.floor(i / cols), cellR(c)));
        const appTop = y + 24 + CC.h * Math.ceil(cs.length / cols);
        apps.forEach((a, i) => place(a.id, planRect.x + 220 + CC.w * 2 * (i % appCols) + CC.w / 2, appTop + CC.h * Math.floor(i / appCols), HOUSE_SIZES.app));
        y += Math.max(84, (Math.ceil(cs.length / cols) + Math.ceil(apps.length / appCols)) * CC.h + 36);
      }
      for (const p of pkgs) { place(p.id, planRect.x + 70, y + 24, HOUSE_SIZES.pkg); y += 84; }
      if (stacks.length || pkgs.length) lanes.push(lane(planRect.x, top, planRect.w, y - top + 10, 'Software', 'What runs on the machines'));
      below.y = y + 160;
    }
  }

  // ---- The Cloud band, above the plan and the street, and its lines (spec 0031 section 7) ----
  const band = layoutCloudBand({ nodes, edges, lanes, planRect, phone, show: !phone || cloud || !!outage, outage, layers, beside: besideCloud.of, place, sizeOf });
  const cloudLines = band ? houseCloudLines(houseCloudLinks(nodes, edges), shown, byId) : [];

  // ---- What the camera fits: the desktop everything, a phone the plan ----
  let fit;
  if (phone) {
    // The plan fills the width; above it, room for the floor and persona chips (and the Cloud band under them); below
    // it, as much of the other floors' machines and the tray as fits without making the plan narrower
    let below = planRect.y + planRect.h + 10;
    for (const l of lanes) if (l.title.text !== 'Software' && l.y > planRect.y) below = Math.max(below, l.y + l.h + 20);
    fit = { minX: planRect.x - 10, maxX: planRect.x + planRect.w + 10, minY: Math.min(planRect.y - 520, band ? band.top - 600 : Infinity), maxY: Math.min(below, planRect.y + planRect.h + 900) };
  } else {
    fit = { minX: planRect.x, maxX: planRect.x + planRect.w, minY: planRect.y - 80, maxY: planRect.y + planRect.h };
    for (const l of lanes) {
      fit.minX = Math.min(fit.minX, l.x); fit.maxX = Math.max(fit.maxX, l.x + l.w);
      fit.minY = Math.min(fit.minY, l.title.y - l.title.size); fit.maxY = Math.max(fit.maxY, l.y + l.h);
    }
    for (const p of pos.values()) {
      fit.minX = Math.min(fit.minX, p.x - p.r - 30); fit.maxX = Math.max(fit.maxX, p.x + p.r + 30);
      fit.minY = Math.min(fit.minY, p.y - p.r - 30); fit.maxY = Math.max(fit.maxY, p.y + p.r + 40);
    }
  }

  // Everything placed on another floor knows its floor (a step's `at` switches to it)
  return { floor: current, floors, plan: planRect, pos, shown, floorOf, roomOf, lanes, more, fit, tray, elsewhere, cloudIds: band ? band.ids : new Set(), cloudLines };
}

// ---------------------------------------------------------------------------
//  The Cloud band (spec 0031 section 7, CLOUD-08)
// ---------------------------------------------------------------------------

/** The band's rows, top to bottom, by role: [role, title, note]; a cloud node goes in the row of its first role */
export const CLOUD_ROWS = [
  ['runtime', 'Runtime', 'What the code and the stacks call while running'],
  ['software', 'Software sources', 'Where images and packages come from'],
  ['account', 'Accounts', 'What the house pays for or depends on, by role'],
];
/** One slot of the band's grid (world units): room for a cloud node and its label */
export const CLOUD_CELL = { w: 300, h: 80 };
const WEB_W = 320; // the Public web's sub-lane, at the band's right end (desktop)
const SUB_TITLE = 56; // the room a sub-lane's title takes above it
const PAD = 30;
/** A rolled-up line's bow, by when: two lines between one container and one cloud node never lie on each other */
const LINE_BEND = { run: 0.12, deploy: 0.2, renew: 0.28 };

/** The row of the Cloud band a cloud node goes in: its first role, else runtime */
export function cloudRow(node) {
  const roles = Array.isArray(node && node.roles) ? node.roles : [];
  return roles.find((r) => CLOUD_ROWS.some(([k]) => k === r)) || 'runtime';
}

/**
 * What a dashed placement puts on a cloud node (`external → device`, the live layer's: spec 0031 section 3.1, an
 * HA service device whose host a cloud entry claims): those things sit beside their cloud node in the band.
 * @returns {{ of: (id: string) => object[], placed: Set<string> }}
 */
export function cloudBesideOf(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const of = new Map();
  const placed = new Set();
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!e.dashed || e.kind || !from || !to || from.type !== 'external' || to.type !== 'device' || placed.has(to.id)) continue;
    placed.add(to.id);
    if (!of.has(from.id)) of.set(from.id, []);
    of.get(from.id).push(to);
  }
  for (const list of of.values()) list.sort(byLabel);
  return { of: (id) => of.get(id) || [], placed };
}

/** What a call from a node of this type is drawn from in the House view: itself (the rest roll up, or are drawn as they are) */
const DRAWN_FROM = new Set(['container', 'stack', 'machine']);

/**
 * Rolls every `calls` edge into a cloud node up to what the House view draws (spec 0031 section 7): a container,
 * a stack or a machine keeps its own; a service or an endpoint goes up its ownership to its app, then to the
 * container that app's `runs-on` mapping names (else the stack). An app's own calls (the visitor's browser) and a
 * cloud node's own are drawn as they are, so they are not here. One link per (container, cloud node, when), with the
 * number of calls it stands for and the machine the container runs on (its stack's `runs-on`). Pure; never stored.
 * @returns {{ from: string, to: string, when: string, count: number, machine: string|null }[]}
 */
export function houseCloudLinks(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parentOf = new Map();
  const containerAt = new Map(); // `stack-<name>|<service>` -> container id
  for (const n of nodes) if (n.type === 'container' && n.stack && n.service) containerAt.set(`stack-${n.stack}|${n.service}`, n.id);
  const runsOn = new Map(); // app id -> the containers (else stacks) that serve it
  const machineOfStack = new Map();
  for (const e of edges) {
    if (isOwnership(e) && !parentOf.has(e.to)) parentOf.set(e.to, e.from);
    if (e.kind !== 'runs-on') continue;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    if (from.type === 'stack' && to.type === 'machine' && !machineOfStack.has(from.id)) machineOfStack.set(from.id, to.id);
    if (from.type === 'app' && to.type === 'stack') {
      const named = (Array.isArray(e.mappings) ? e.mappings : []).map((m) => m && containerAt.get(`${to.id}|${m.service}`)).filter(Boolean);
      const list = runsOn.get(from.id) || [];
      for (const id of named.length ? named : [to.id]) if (!list.includes(id)) list.push(id);
      runsOn.set(from.id, list);
    }
  }
  const stackOf = (n) => {
    if (n.type === 'stack') return n.id;
    const p = parentOf.get(n.id);
    if (p && byId.get(p) && byId.get(p).type === 'stack') return p;
    return n.stack ? `stack-${n.stack}` : null;
  };
  const machineOf = (id) => {
    const n = byId.get(id);
    if (n.type === 'machine') return id;
    const s = stackOf(n);
    return (s && machineOfStack.get(s)) || null;
  };
  const appOf = (id) => {
    let cur = id;
    for (let i = 0; i < 8 && cur; i++) {
      const n = byId.get(cur);
      if (n && n.type === 'app') return cur;
      cur = parentOf.get(cur);
    }
    return null;
  };
  const usersOf = (from) => {
    if (DRAWN_FROM.has(from.type)) return [from.id];
    if (from.type !== 'service' && from.type !== 'page') return [];
    const app = appOf(from.id);
    return (app && runsOn.get(app)) || [];
  };
  const links = new Map();
  for (const e of edges) {
    if (e.kind !== 'calls') continue;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to || to.type !== 'external') continue;
    const when = whenOf(e);
    for (const u of usersOf(from)) {
      const k = `${u}|${to.id}|${when}`;
      if (!links.has(k)) links.set(k, { from: u, to: to.id, when, count: 0, machine: machineOf(u) });
      links.get(k).count++;
    }
  }
  return [...links.values()];
}

/**
 * The lines the House view draws for `houseCloudLinks`, on what it shows: from the container (or stack, or machine)
 * when it is shown, else from the machine it runs on (a phone with the software hidden), merged per drawn end, cloud
 * node and when. Each is an edge scene.js draws as a call (`rolled: true`), labelled with its count; `users` keeps the
 * containers it stands for, for an outage's colours.
 */
export function houseCloudLines(links, shown, byId) {
  const lines = new Map();
  for (const l of links) {
    if (!shown.has(l.to)) continue;
    const end = shown.has(l.from) ? l.from : l.machine && shown.has(l.machine) ? l.machine : null;
    if (!end) continue;
    const k = `${end}|${l.to}|${l.when}`;
    if (!lines.has(k)) lines.set(k, { from: end, to: l.to, kind: 'calls', when: l.when, status: 'live', rolled: true, count: 0, users: [], bend: LINE_BEND[l.when] });
    const line = lines.get(k);
    line.count += l.count;
    if (!line.users.includes(l.from)) line.users.push(l.from);
  }
  return [...lines.values()].map((line) => {
    const name = String((byId.get(line.from) || { label: line.from }).label || line.from);
    return { ...line, label: `${name} · ${line.count} ${line.count === 1 ? 'call' : 'calls'}` };
  });
}

/**
 * Lays the Cloud band out above the plan: one lane "Cloud" from the left edge of the bands to their right edge
 * (a phone: the plan's width), three sub-lanes by role, each a grid sorted by how many use the node, then label;
 * the Public web alone at the right end (a phone: below the rows). Places the nodes, pushes the lanes; null when
 * there is nothing to draw. During an outage its down nodes and the cloud nodes it reaches are always in it.
 */
function layoutCloudBand({ nodes, edges, lanes, planRect, phone, show, outage, layers, beside, place, sizeOf }) {
  if (!show) return null;
  const reach = outage ? new Set([...outage.down, ...outage.hits.keys()]) : null;
  const inBand = (n) => n.type === 'external' && ((n.kind === 'web' ? layers.web !== false : layers.cloud !== false) || !!(reach && reach.has(n.id)));
  const externals = nodes.filter(inBand);
  if (!externals.length) return null;
  const users = new Map(); // cloud node id -> the ids that call it
  for (const e of edges) {
    if (e.kind !== 'calls') continue;
    if (!users.has(e.to)) users.set(e.to, new Set());
    users.get(e.to).add(e.from);
  }
  const used = (n) => (users.get(n.id) || { size: 0 }).size;
  const web = externals.find((n) => n.kind === 'web') || null;
  const clouds = externals.filter((n) => n !== web);

  let left = planRect.x;
  let right = planRect.x + planRect.w;
  if (!phone) for (const l of lanes) { left = Math.min(left, l.x); right = Math.max(right, l.x + l.w); }
  const webW = web && !phone ? WEB_W : 0;
  const innerL = left + PAD;
  const innerR = right - PAD - (webW ? webW + PAD : 0);
  const cols = Math.max(1, Math.floor((innerR - innerL) / CLOUD_CELL.w));
  const cw = (innerR - innerL) / cols;
  const blocks = CLOUD_ROWS.map(([role, title, note]) => {
    const items = clouds.filter((n) => cloudRow(n) === role).sort((a, b) => used(b) - used(a) || byLabel(a, b));
    const seq = items.flatMap((n) => [n, ...beside(n.id)]);
    return { title, note, seq, h: Math.ceil(seq.length / cols) * CLOUD_CELL.h + 20 };
  }).filter((b) => b.seq.length);
  if (web && phone) blocks.push({ title: 'Public web, not cloud', note: '', seq: [web, ...beside(web.id)], h: CLOUD_CELL.h + 20, web: true });
  const height = blocks.reduce((t, b) => t + SUB_TITLE + b.h, 0) + PAD;
  const bottom = phone ? planRect.y - 110 : planRect.y - 80 - BAND_GAP;
  const top = bottom - Math.max(height, SUB_TITLE + CLOUD_CELL.h + 20 + PAD);
  const ids = new Set();
  const subLanes = [];
  const sub = (x, y, w, h, title) => ({
    x, y, w, h, ...SUB_LANE_LOOK,
    title: { text: title, x: x + w / 2, y: y - 14, size: Math.round(TITLE.size * 0.7), bold: true, color: TITLE.color },
    note: null, arrow: null,
  });
  let y = top;
  for (const b of blocks) {
    y += SUB_TITLE;
    b.seq.forEach((n, i) => { place(n.id, innerL + cw * ((i % cols) + 0.5), y + 30 + CLOUD_CELL.h * Math.floor(i / cols), sizeOf(n)); ids.add(n.id); });
    subLanes.push(sub(innerL - 10, y, innerR - innerL + 20, b.h, b.title));
    y += b.h;
  }
  if (web && !phone) {
    const x = right - PAD - webW;
    const wy = top + SUB_TITLE;
    const seq = [web, ...beside(web.id)];
    seq.forEach((n, i) => { place(n.id, x + webW / 2, wy + 30 + CLOUD_CELL.h * i, sizeOf(n)); ids.add(n.id); });
    subLanes.push(sub(x, wy, webW, seq.length * CLOUD_CELL.h + 20, 'Public web, not cloud'));
  }
  const outer = {
    x: left, y: top, w: right - left, h: bottom - top, ...LANE_LOOK,
    title: { text: 'Cloud', x: left + (right - left) / 2, y: top - 20 - NOTE.size, size: TITLE.size, bold: true, color: TITLE.color },
    note: { text: 'Outside the house: what we do not control', x: left + (right - left) / 2, y: top - 12, size: NOTE.size, bold: false, color: NOTE.color },
    arrow: null,
  };
  lanes.push(outer, ...subLanes);
  return { ids, top: outer.title.y - outer.title.size };
}

// ---------------------------------------------------------------------------
//  The state's side: what view.js and scene.js call
// ---------------------------------------------------------------------------

/** The House view's own settings, before its first layout (house.js fills them in) */
export function newHouseState() {
  return { floor: null, phone: false, software: false, cloud: false, outageKey: '', open: new Set(), defaultPlan: null, planSource: 'none', planUsed: null, notes: [], shown: new Set(), floorOf: new Map(), lanes: [], more: [], fit: null, floors: [], cloudIds: new Set(), cloudLines: [] };
}

/**
 * The line under the tray: what the live answer says has no room or no inventory item; without an answer, why
 * nothing is placed (the live layer's failure, in its source's words) and where to fix it.
 * @param {object|null} answer
 * @param {any} [error] the live snapshot's error
 * @param {{ settable?: boolean }} [opts] the source has a token the Live menu sets
 */
export function trayNotes(answer, error = null, { settable = false } = {}) {
  if (!answer) {
    if (!error) return ['Live layer unavailable: nothing is placed from the inventory'];
    const w = failureWords(error, { settable });
    return [w.fix ? `${w.house} ${w.fix}` : w.house];
  }
  return Array.isArray(answer.unplaced) ? answer.unplaced : [];
}

/**
 * Lays the House view out on the map in `state` (view.js calls this for `state.view === 'house'`): positions and
 * sizes on the nodes it shows, what it shows, its bands and tray, and no orbit rings. Keeps the settings in `state.house`.
 */
export function applyHouseLayout(state) {
  const cfg = state.house || (state.house = newHouseState());
  const answer = state.live && state.live.answer;
  const { plan, source } = pickPlan(answer, cfg.defaultPlan);
  const out = layoutHouse({
    nodes: state.nodes, edges: state.edges, plan, floor: cfg.floor, phone: cfg.phone, software: cfg.software, cloud: cfg.cloud,
    outage: outageFor(state.scenario, state.nodes, state.edges),
    open: cfg.open, layers: state.activeLayers || {}, notes: trayNotes(answer, state.live && state.live.error, { settable: !!(state.live && state.live.canSetToken) }),
  });
  for (const n of state.nodes) {
    const p = out.pos.get(n.id);
    if (p) { n.x = p.x; n.y = p.y; n.r = p.r; }
  }
  state.rings = { rings: [], clusters: [] };
  Object.assign(cfg, { floor: out.floor, floors: out.floors, plan: out.plan, shown: out.shown, floorOf: out.floorOf, roomOf: out.roomOf, lanes: out.lanes, more: out.more, fit: out.fit, tray: out.tray, planSource: source, planUsed: plan, cloudIds: out.cloudIds, cloudLines: out.cloudLines });
  return out;
}

/** Whether the House view draws a node (scene.js isNodeVisible, while `state.view === 'house'`) */
export function houseShowsNode(state, node) {
  return !!(state.house && state.house.shown && state.house.shown.has(node.id));
}

let viewMemo = null;
/**
 * The edges the House view draws and the selection walks (scene.js, while `state.view === 'house'`): the map's,
 * and the Cloud band's rolled-up lines (computed by the layout, never stored). The same list while neither changes.
 */
export function houseViewEdges(state) {
  const lines = state.house && state.house.cloudLines;
  if (!lines || !lines.length) return state.edges;
  if (viewMemo && viewMemo.edges === state.edges && viewMemo.lines === lines) return viewMemo.all;
  viewMemo = { edges: state.edges, lines, all: [...state.edges, ...lines] };
  return viewMemo.all;
}

/**
 * How the House view draws an edge whose ends it shows: 'flow' (`runs-on` and `delivers`, and a call into a cloud
 * node: a curve with an arrow, dashed or dotted by its `when`), 'link' (a phone under its persona, a thing beside its
 * cloud node), or null (left out: the plan already says what is in which room, and the rest is the other views').
 * A container's, a stack's or a machine's own call into a cloud node is left out too: the band's rolled-up line
 * (`rolled`, houseCloudLines) draws it, one per container, cloud node and when.
 */
export function houseEdgeStyle(edge, source, target) {
  if (edge.kind === 'runs-on' || edge.kind === 'delivers') return 'flow';
  if (edge.kind === 'calls' && target && target.type === 'external') return edge.rolled || !(source && DRAWN_FROM.has(source.type)) ? 'flow' : null;
  if (!edge.kind && !edge.dashed && source && source.type === 'persona' && target && target.type === 'device') return 'link';
  // A service device on the container (or cloud node) that serves its host (spec 0031 section 3.1)
  if (!edge.kind && edge.dashed && source && (source.type === 'container' || source.type === 'external') && target && target.type === 'device') return 'link';
  return null;
}

/** Labels that stay when zoomed out in the House view: what anchors the picture, and the cloud services */
const HOUSE_LANDMARKS = ['persona', 'machine', 'stack', 'floor', 'external']; // the Cloud band's nodes name themselves: the band is a list to read

/**
 * The House view's touches on a built scene (scene.js buildScene, before a scenario's emphasis): its bands and tray
 * as lanes, no orbit rings, rooms without a label (the plan names them), and the anchors keep their labels.
 */
export function decorateHouseScene(scene, state) {
  const cfg = state.house;
  scene.decor.rings = [];
  scene.decor.lanes = cfg && cfg.lanes ? cfg.lanes : [];
  for (const n of scene.nodes) {
    if (n.type === 'room') { n.label = ''; n.labelKeep = false; }
    else if (HOUSE_LANDMARKS.includes(n.type)) n.labelKeep = true;
  }
  if (cfg && cfg.cloudIds && cfg.cloudIds.size) quietCloudLines(scene, state);
  return scene;
}

/** How a line into a cloud node looks with nothing selected (spec 0031 section 7): Docker Hub alone has 42 users */
export const CLOUD_LINE_ALPHA = { run: 0.9, deploy: 0.25, renew: 0.9 };
/** A line an outage travels, as outage-model.js `paintOutage` draws a walked edge */
const OUTAGE_LINE = { alpha: 0.9, width: 2.2 };
const WHENS = Object.keys(WHEN_STYLES);
/** The `when` a drawn call is for, read off its dash (scene.js draws it with `whenDash`) */
const whenOfDrawn = (e) => WHENS.find((w) => String(WHEN_STYLES[w].dash) === String(e.dash)) || 'run';

/**
 * The Cloud band's lines, after the scene is built: with nothing selected, `deploy` lines quiet and the rest at full;
 * a selection draws only its own (scene.js lit them through `houseViewEdges`). On a phone a line draws only for a
 * selected node. During an outage, a rolled-up line into a cloud node that is down or hit takes the colour of the
 * hit its calls make (as `paintOutage` colours a walked edge; it runs after this and colours only the map's own
 * edges), and on a phone only the lines the outage travels draw.
 */
function quietCloudLines(scene, state) {
  const cfg = state.house;
  const radius = state.scenario ? outageFor(state.scenario, state.nodes, state.edges) : null;
  const selected = !state.scenario && !!state.selectedNode;
  const lines = new Map((cfg.cloudLines || []).map((l) => [`${l.from}->${l.to}|${l.when}`, l]));
  const down = radius ? new Set(radius.down) : null;
  scene.edges = scene.edges.filter((e) => {
    if (e.kind !== 'calls' || !cfg.cloudIds.has(e.to)) return true;
    const when = whenOfDrawn(e);
    if (radius) {
      // The calls a rolled-up line stands for are walked by the outage when its cloud node is down or hit, each
      // biting no sooner than its own `when` or the cloud node's: the colour the walk gives them (as paintOutage's)
      const line = lines.get(`${e.from}->${e.to}|${when}`);
      const base = down.has(e.to) ? 'run' : radius.hits.has(e.to) ? radius.hits.get(e.to).when : null;
      if (line && base) {
        const hit = WHENS[Math.max(WHENS.indexOf(base), WHENS.indexOf(when))];
        Object.assign(e, { color: WHEN_STYLES[hit].color, alpha: Math.max(e.alpha, OUTAGE_LINE.alpha), width: Math.max(e.width, OUTAGE_LINE.width) });
        if (e.glow) e.glowColor = e.color;
        return true;
      }
      return !cfg.phone || radius.edges.has(`${e.from}->${e.to}`);
    }
    if (selected) return !cfg.phone || e.alpha >= 0.5; // scene.js drew the selection's own lines at full and the rest dimmed
    if (cfg.phone) return false;
    e.alpha = CLOUD_LINE_ALPHA[when];
    return true;
  });
}

/** The floor a step's place (or node) is on in the House view, or null when it is on none */
export function floorOfStep(state, step) {
  if (!state.house || !state.house.floorOf || !step) return null;
  const ids = [step.at, step.node, step.edge && step.edge.to, step.edge && step.edge.from].filter((v) => typeof v === 'string');
  for (const id of ids) { const f = state.house.floorOf.get(id); if (f) return f; }
  return null;
}

/** The persona chips of the phone layout: "Adult · 2" (counts only), "Guest" with no account */
export function personaChips(nodes) {
  return nodes.filter((n) => n.type === 'persona').map((n) => {
    const name = n.codeLabel || n.label;
    const text = n.account === false || n.liveCount === undefined ? name : `${name} · ${n.liveCount}`;
    return { id: n.id, text };
  });
}

/**
 * Where the floor bar's "Edit layout" link goes: the plugin's `editUrl` (a string, or `(floorId) => string`
 * for the floor in view), when it is an http(s) URL; otherwise null and there is no link. The tool edits no
 * plan itself: the plugin names the one place the plan is edited.
 */
export function houseEditHref(hook, floorId) {
  const value = hook ? hook.editUrl : null;
  let href;
  try { href = typeof value === 'function' ? value(floorId) : value; } catch { return null; }
  return typeof href === 'string' && /^https?:\/\//i.test(href) ? href : null;
}

// ---------------------------------------------------------------------------
//  The plain floor drawing (the tool's, when no plugin gives a floor renderer)
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** One floor as plain room boxes with their names, in the plan's viewBox (no links, nothing to tap) */
export function plainFloorSvg(plan, floorId) {
  const vb = (plan && plan.viewBox) || { width: 800, height: 600 };
  const rooms = ((plan && plan.rooms) || []).filter((r) => r.floor_id === floorId && hasBox(r)).sort((a, b) => b.w * b.h - a.w * a.h);
  const body = rooms.map((r) => `<g class="hx-plain-room" data-room="${esc(r.id)}"><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="4"/>`
    + (r.w > 48 && r.h > 22 ? `<text x="${r.x + 7}" y="${r.y + 17}">${esc(r.name)}</text>` : '') + '</g>').join('');
  return `<svg class="hx-plain-floor" viewBox="0 0 ${vb.width} ${vb.height}" data-floor="${esc(floorId)}">${body}</svg>`;
}

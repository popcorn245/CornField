/**
 * @module plugins/house/home-assistant
 *
 * Home Assistant as a house source (the server half; the browser reads the answer through
 * plugins/house/browser.js like any house file). It reads the floor, area, device and entity registries
 * over Home Assistant's WebSocket API, read-only (`config/*_registry/list`, nothing else), with a
 * long-lived access token from the environment, and turns them into the house answer (docs/house.md):
 *
 *  - **Floors** from the floor registry; **rooms** from the areas, each on its floor (an area on no floor
 *    goes on a "Home" floor). With a house file beside it (`options.file`), the file's plan is the house
 *    and each area maps to the room whose name is the area's name or one of its aliases (any case, any
 *    spacing); an area no room matches is listed in `unmatched_areas`.
 *  - **Devices** with their area's room, the number of their enabled entities, maker and model. A service
 *    (an integration, not a thing in a room) carries `service: true` and the host of its configuration
 *    URL when that is a name; at an address it carries only `address: true`, never the address.
 *  - A **`mobile_app` device** (a person's phone) is left out entirely: not named, not counted, not placed;
 *    its entities are not counted either.
 *
 * The token is only ever sent to Home Assistant in the auth message; it is never logged, put in an answer,
 * a URL or an error. Neither is the Home Assistant URL.
 */

/** The env vars the server reads: where Home Assistant is, and its long-lived access token */
export const HA_ENV = Object.freeze({ url: 'CORNFIELD_HA_URL', token: 'CORNFIELD_HA_TOKEN' });
/** Slower than this is "Home Assistant did not answer" */
export const HA_TIMEOUT_MS = 10_000;
/** The registries read, in order */
export const HA_COMMANDS = ['config/floor_registry/list', 'config/area_registry/list', 'config/device_registry/list', 'config/entity_registry/list'];
const NO_FLOOR = { id: 'home', name: 'Home', level: 0 };

/** An error whose message is safe to show: it never holds the URL or the token */
export class HomeAssistantError extends Error {}

/** `http(s)://host:8123[/…]` → `ws(s)://host:8123/api/websocket`; throws on anything else */
export function haWebSocketUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new HomeAssistantError('the Home Assistant URL is not a URL'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) throw new HomeAssistantError('the Home Assistant URL is not http(s)');
  const proto = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  return `${proto}//${u.host}${u.pathname.replace(/\/+$/, '').replace(/\/api\/websocket$/, '')}/api/websocket`;
}

/**
 * The four registries, read over one WebSocket.
 * @param {{ url: string, token: string, timeoutMs?: number, WebSocket?: typeof WebSocket }} opts
 * @returns {Promise<{ floors: any[], areas: any[], devices: any[], entities: any[] }>}
 */
export function fetchRegistries({ url, token, timeoutMs = HA_TIMEOUT_MS, WebSocket: WS = globalThis.WebSocket }) {
  if (typeof WS !== 'function') return Promise.reject(new HomeAssistantError('this Node has no WebSocket client (Node 22 or later)'));
  const target = haWebSocketUrl(url);
  return new Promise((resolve, reject) => {
    let ws;
    let done = false;
    const results = new Map();
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(new HomeAssistantError(`Home Assistant did not answer in ${Math.ceil(timeoutMs / 1000)} s`)), timeoutMs);
    try { ws = new WS(target); } catch { return finish(new HomeAssistantError('Home Assistant could not be reached')); }
    ws.addEventListener('error', () => finish(new HomeAssistantError('Home Assistant could not be reached')));
    ws.addEventListener('close', () => finish(new HomeAssistantError('Home Assistant closed the connection')));
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')); } catch { return finish(new HomeAssistantError('Home Assistant answered with something that is not JSON')); }
      if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (msg.type === 'auth_invalid') finish(new HomeAssistantError('Home Assistant refused the token'));
      else if (msg.type === 'auth_ok') HA_COMMANDS.forEach((type, k) => ws.send(JSON.stringify({ id: k + 1, type })));
      else if (msg.type === 'result' && Number.isInteger(msg.id) && msg.id >= 1 && msg.id <= HA_COMMANDS.length) {
        const command = HA_COMMANDS[msg.id - 1];
        // A Home Assistant older than floors (2024.4) has no floor registry: no floors
        if (!msg.success && command !== HA_COMMANDS[0]) return finish(new HomeAssistantError(`Home Assistant refused ${command}${msg.error && msg.error.code ? ` (${msg.error.code})` : ''}`));
        results.set(msg.id, msg.success && Array.isArray(msg.result) ? msg.result : []);
        if (results.size === HA_COMMANDS.length) {
          finish(null, { floors: results.get(1), areas: results.get(2), devices: results.get(3), entities: results.get(4) });
        }
      }
    });
  });
}

/** A name compared as people mean it: lower case, any run of spaces, dashes or underscores as one space */
export const sameName = (a, b) => norm(a) !== '' && norm(a) === norm(b);
const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
const isAddress = (h) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.includes(':');

/** Whether a device is a person's phone (the mobile_app integration) */
export const isMobileApp = (d) => (Array.isArray(d.identifiers) ? d.identifiers : []).some((i) => Array.isArray(i) && i[0] === 'mobile_app');

/** The host a service device is configured at: a name, `{ address: true }` for an IP address, or null */
function hostOf(configurationUrl) {
  if (typeof configurationUrl !== 'string' || !/^https?:\/\//i.test(configurationUrl)) return null;
  try {
    const h = new URL(configurationUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!h) return null;
    return isAddress(h) ? { address: true } : { host: h };
  } catch {
    return null;
  }
}

/**
 * The registries as the house answer's parts. Pure: the tests run it on recorded registries.
 * @param {{ floors?: any[], areas?: any[], devices?: any[], entities?: any[] }} registries
 * @param {{ plan?: { viewBox?: object, floors?: any[], rooms?: any[] } | null }} [opts] a house file's plan: areas map to its rooms
 * @returns {{ house: object, home_assistant: object }}
 */
export function registriesToHouse({ floors = [], areas = [], devices = [], entities = [] }, { plan = null } = {}) {
  const planRooms = plan && Array.isArray(plan.rooms) && plan.rooms.length ? plan.rooms : null;
  const roomOf = new Map(); // area_id -> room id
  const unmatched = [];
  let house;
  if (planRooms) {
    for (const a of areas) {
      const names = [a.name, ...(Array.isArray(a.aliases) ? a.aliases : [])];
      const room = planRooms.find((r) => names.some((n) => sameName(n, r.name) || (Array.isArray(r.aliases) && r.aliases.some((x) => sameName(n, x)))));
      if (room) roomOf.set(a.area_id, room.id);
      else unmatched.push(a.name);
    }
    house = { viewBox: plan.viewBox || { width: 800, height: 600 }, floors: plan.floors || [], rooms: planRooms };
  } else {
    const fl = floors.map((f) => ({ id: f.floor_id, name: f.name || f.floor_id, level: Number.isInteger(f.level) ? f.level : 0 }));
    const known = new Set(fl.map((f) => f.id));
    const rooms = areas.map((a) => {
      roomOf.set(a.area_id, a.area_id);
      return { id: a.area_id, floor_id: known.has(a.floor_id) ? a.floor_id : NO_FLOOR.id, name: a.name || a.area_id, x: null, y: null, w: null, h: null };
    });
    if (rooms.some((r) => r.floor_id === NO_FLOOR.id)) fl.push({ ...NO_FLOOR });
    house = { viewBox: { width: 800, height: 600 }, floors: fl, rooms };
  }

  const areaName = new Map(areas.map((a) => [a.area_id, a.name]));
  const entityCount = new Map();
  for (const e of entities) if (e && e.device_id && !e.disabled_by) entityCount.set(e.device_id, (entityCount.get(e.device_id) || 0) + 1);
  const out = [];
  for (const d of devices) {
    // A person's phone is never on the map
    if (!d || !d.id || d.disabled_by || isMobileApp(d)) continue;
    const area = d.area_id ? areaName.get(d.area_id) ?? null : null;
    const device = {
      id: d.id,
      name: d.name_by_user || d.name || 'Device',
      room_id: d.area_id ? roomOf.get(d.area_id) ?? null : null,
      area,
      entities: entityCount.get(d.id) || 0,
      manufacturer: d.manufacturer || null,
      model: d.model || null,
    };
    if (d.entry_type === 'service') Object.assign(device, { service: true }, hostOf(d.configuration_url) || {});
    out.push(device);
  }
  return { house, home_assistant: { status: 'ok', note: null, unmatched_areas: unmatched, devices: out } };
}

/**
 * The house answer from Home Assistant, over a house file's other parts (accounts, hardware …) when there
 * is one. Never throws: a Home Assistant that is not set up, does not answer or refuses the token is
 * `home_assistant.status` 'off' or 'error' with a note, beside the file's plan.
 * @param {{ url?: string | null, token?: string | null, file?: object | null, now?: () => Date, fetch?: typeof fetchRegistries, timeoutMs?: number, WebSocket?: any }} opts
 */
export async function homeAssistantHouse({ url, token, file = null, now = () => new Date(), fetch: read = fetchRegistries, timeoutMs, WebSocket } = {}) {
  const base = file && typeof file === 'object' ? { ...file } : {};
  const plan = base.house || null;
  const at = now().toISOString();
  if (!url || !token) {
    return { ...base, at, home_assistant: { status: 'off', note: `set ${HA_ENV.url} and ${HA_ENV.token} where cornfield runs`, unmatched_areas: [], devices: [] } };
  }
  try {
    const registries = await read({ url, token, timeoutMs, WebSocket });
    return { ...base, at, ...registriesToHouse(registries, { plan }) };
  } catch (err) {
    const note = err instanceof HomeAssistantError ? err.message : 'Home Assistant could not be read';
    return { ...base, at, house: plan || { floors: [], rooms: [] }, home_assistant: { status: 'error', note, unmatched_areas: [], devices: [] } };
  }
}

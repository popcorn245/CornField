/**
 * @module plugins/house/browser
 *
 * The house plugin's browser half: a **live source** over a house answer, and a plain **floor renderer**
 * for the House view. The explorer is the tool (explorer/live.js, live-model.js, house.js, house-model.js):
 * it knows live sources, personas, the chip, merging and drawing. This module turns a house answer into the
 * tool's live answer `{ at, nodes, edges, accounts, hardware, notes, unplaced, plan, resolve }` and fetches it.
 *
 * Read-only from a source: cornfield displays the house; the plan and the devices come from wherever the
 * answer is made. The ways in (docs/house.md):
 *   - a JSON file in the repo (`sources: { house: { use: 'house', options: { file: 'cornfield.house.json' } } }`):
 *     the server serves it at /cornfield/house.json, and `create(options)` reads it, no token;
 *   - your own API, through a same-origin `proxy` path, with an admin token kept in this browser
 *     (`createLiveSource({ url: '/api/…', needsToken: true })` from your own source module);
 *   - Home Assistant directly (a roadmap item: docs/roadmap.md).
 *
 * The house answer (version 1), every part optional:
 *   { at, house: { viewBox, floors: [{ id, name, level }], rooms: [{ id, floor_id, name, group?, x, y, w, h }] },
 *     accounts: [{ role, groups, count }],                  counts only: never a name, an id or a username
 *     phones: [{ id, platform: 'apple'|'google'|'mozilla'|'other', role, groups }],
 *     nfc_tags: [{ id, room_id, needs_rewrite }],
 *     home_assistant: { status: 'ok'|'off'|'error', note, devices: [{ id, name, room_id, area, entities, manufacturer,
 *                       model, service?, host?, address? }], unmatched_areas },
 *     hardware: [{ kind: 'machine'|'camera', link, item: { id, name, room_id, image }, contents, contents_total, sets }],
 *     unlinked: { hosts, cameras, note } }
 *
 * What the adapter makes (ids in the live-id grammar of core/schema.js):
 *   live-floor-<id>                    a floor, under the root
 *   live-room-<id>                     a room under its floor, with its `box` in the floor viewBox
 *   live-device-phone-<id>             a phone, with the `account` (role and deciding groups) it belongs to:
 *                                      the tool hangs it under its persona
 *   live-device-nfc-tag-<id>           an NFC tag, under the room it is stuck in
 *   live-device-home-assistant-<id>    a Home Assistant device under its room, `delivers` to the HA container
 *
 * Home Assistant **service devices** are software, not things in a room: never under a room, they carry
 * `service` and the bare `host` the source gave. The answer's `resolve(nodes, edges)` (the tool calls it in
 * `mergeLive`) matches each host against the map: the app whose label is the host, its `runs-on` mapping for
 * that host, the container under that stack whose `service` is the mapping's (the self-hosted one when several),
 * and the stack's `runs-on` machine; else the cloud node whose topology.cloud.json entry claims the host. A match
 * is a dashed placement from the container or the cloud node; anything else gets its tray reason (`unplaced`).
 *
 * Nothing live is written anywhere (not to git, not to browser storage), except the token itself when the
 * map's Live menu sets or forgets it.
 */

import { claims, cloudNodeId } from '../../core/cloud.js';

/** Where this browser keeps the token for a source that needs one (localStorage, per origin) */
export const TOKEN_KEY = 'cornfield.token';
/** Where the server serves a repo's house file (cornfield.config.js `sources.house`) */
export const HOUSE_PATH = '/cornfield/house.json';
/** An answer slower than this is "the source is not answering" */
export const WORLD_TIMEOUT_MS = 10_000;
/** The floor viewBox a plan is drawn in when it names none */
export const FLOOR_VIEWBOX = Object.freeze({ width: 800, height: 600 });
/** The container a Home Assistant device delivers to, unless the source's options name another (`haContainer`) */
export const HA_CONTAINER_ID = 'container-homeassistant';
/** The cloud registry, which the server serves beside topology.json: the adapter reads only its hosts */
export const CLOUD_PATH = '/topology.cloud.json';

const PLATFORM_WORDS = { apple: 'Apple', google: 'Google', mozilla: 'Firefox', other: 'other' };

/** A live-layer failure the tool turns into the chip's words (explorer/live-model.js `chipModel`) */
export function liveError(reason, extra = {}) {
  const err = new Error(extra.message || reason);
  err.reason = reason;
  if (extra.hint) err.hint = extra.hint;
  if (extra.detail) err.detail = extra.detail;
  if (extra.href) err.href = extra.href;
  if (extra.status) err.status = extra.status;
  return err;
}

/** The line under the map's token field (the Live menu): where an admin's token comes from; the command in backticks */
export const TOKEN_HELP = 'An admin token for the source: it is kept in this browser only, and sent only to this origin.';

/** Why the live layer is off or unavailable, in this source's words: the tool shows `hint` after "Live layer off: " */
const NO_TOKEN_HINT = 'no token in this browser';
const FORBIDDEN_HINT = "that token is not an admin's (or was revoked)";

/** The board's token, or '' (storage blocked reads as no token) */
export function readToken(storage = globalThis.localStorage, key = TOKEN_KEY) {
  try { return (storage && storage.getItem(key)) || ''; } catch { return ''; }
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The hosts each topology.cloud.json entry claims, as `[{ id: 'ext-<entry>', hosts }]`, and nothing else of the
 * file (no env names, no labels). Anything that is not a registry reads as none.
 */
export function cloudHostsOf(file) {
  const services = file && Array.isArray(file.services) ? file.services : [];
  return services.flatMap((s) => {
    const hosts = s && s.match && Array.isArray(s.match.hosts) ? s.match.hosts.filter((h) => typeof h === 'string' && h) : [];
    return s && typeof s.id === 'string' && hosts.length ? [{ id: cloudNodeId(s.id), hosts: [...hosts] }] : [];
  });
}

/**
 * What serves a service device's host on the map (spec 0031 section 3.1). Ours first: the app whose label is the
 * host (a Caddyfile site), its `runs-on` mapping for that host, the container under that stack whose `service` is
 * the mapping's (the self-hosted one when the site maps to several), and the stack's machine. Else the cloud node
 * whose registry entry claims the host (the registry's matcher, `*.example.com` included), when it is on the map.
 * @param {string} host a bare lower-cased DNS name
 * @param {object[]} nodes
 * @param {object[]} edges
 * @param {{ id: string, hosts: string[] }[]} [cloudHosts] `cloudHostsOf(topology.cloud.json)`
 * @returns {{ kind: 'container', id: string, machine: string|null } | { kind: 'cloud', id: string } | null}
 */
export function resolveServiceHost(host, nodes, edges, cloudHosts = []) {
  const h = String(host || '').toLowerCase();
  if (!h) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const app of nodes) {
    if (app.type !== 'app' || String(app.label || '').toLowerCase() !== h) continue;
    for (const e of edges) {
      const stack = e.from === app.id && e.kind === 'runs-on' ? byId.get(e.to) : null;
      if (!stack || stack.type !== 'stack') continue;
      const services = (e.mappings || []).filter((m) => String(m.host || '').toLowerCase() === h).map((m) => m.service);
      const containers = edges.filter((x) => x.from === stack.id && !x.kind && !x.dashed).map((x) => byId.get(x.to)).filter((c) => c && c.type === 'container');
      const serving = services.map((s) => containers.find((c) => c.service === s)).filter(Boolean);
      const container = serving.find((c) => c.selfHosted) || serving[0];
      if (!container) continue;
      const on = edges.find((x) => x.from === stack.id && x.kind === 'runs-on' && byId.get(x.to) && byId.get(x.to).type === 'machine');
      return { kind: 'container', id: container.id, machine: on ? on.to : null };
    }
  }
  for (const c of cloudHosts) {
    if (byId.has(c.id) && c.hosts.some((p) => claims('hosts', p, h))) return { kind: 'cloud', id: c.id };
  }
  return null;
}

/** The tray reasons of spec 0031 section 3.1 */
const NO_HOST = 'Service device with no host';
const AT_ADDRESS = 'Service device at an address, not a name';
const notOnMap = (host) => `Service device, host not on the map: ${host}`;

/**
 * The service devices laid against the map: a dashed placement from what serves each host, the panel's line
 * ("Nextcloud integration in Home Assistant · on container-nextcloud, engine-1"), or the tray reason.
 * @param {{ id: string, host: string, what: string }[]} services
 * @returns {{ edges: object[], nodes: Record<string, object> }}
 */
function resolveServiceDevices(services, nodes, edges, cloudHosts) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = { edges: [], nodes: {} };
  for (const s of services) {
    const r = resolveServiceHost(s.host, nodes, edges, cloudHosts);
    if (!r) { out.nodes[s.id] = { unplaced: notOnMap(s.host) }; continue; }
    const where = r.kind === 'container'
      ? [r.id, r.machine && byId.get(r.machine) ? byId.get(r.machine).label : null].filter(Boolean).join(', ')
      : `${byId.get(r.id).label || r.id} (cloud)`;
    out.edges.push({ from: r.id, to: s.id, dashed: true, label: `serves ${s.host}` });
    out.nodes[s.id] = { desc: `${s.what} integration in Home Assistant · on ${where}`, servedBy: r.id, unplaced: undefined };
  }
  return out;
}

/**
 * The world answer as the tool's live answer. Pure: the tests run it on recorded answers.
 * @param {any} world a house answer (the module header has its shape)
 * @param {{ cloudHosts?: { id: string, hosts: string[] }[], haContainer?: string, from?: string }} [opts] the registry's hosts
 *   (`cloudHostsOf`), for service devices; the container HA devices deliver to; the words for where the answer came from
 * @returns {{ at: string, nodes: object[], edges: object[], accounts: object[], hardware: object[], notes: string[], plan: object|null, resolve: Function }}
 */
export function worldToLive(world, { cloudHosts = [], haContainer = HA_CONTAINER_ID, from = 'the house source' } = {}) {
  const house = world.house || { floors: [], rooms: [] };
  const floors = [...(house.floors || [])].sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || String(a.id).localeCompare(String(b.id)));
  const rooms = house.rooms || [];
  const roomIds = new Set(rooms.map((r) => r.id));
  const floorIds = new Set(floors.map((f) => f.id));
  const roomName = new Map(rooms.map((r) => [r.id, r.name]));
  const nodes = [];
  const edges = [];
  const own = (from, to) => edges.push({ from, to });

  floors.forEach((f) => {
    const id = `live-floor-${f.id}`;
    const count = rooms.filter((r) => r.floor_id === f.id).length;
    nodes.push({ id, type: 'floor', label: f.name, level: f.level ?? 0, desc: `${f.name}: a level of the house, ${plural(count, 'room')}. Live from ${from}.` });
    own('root', id);
  });

  rooms.forEach((r) => {
    const id = `live-room-${r.id}`;
    const box = [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number') ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
    nodes.push({ id, type: 'room', label: r.name, floor: r.floor_id, box, desc: `${r.name}: a room${r.group ? ` (${r.group})` : ''}. Live from ${from}.` });
    if (floorIds.has(r.floor_id)) own(`live-floor-${r.floor_id}`, id);
  });

  (world.phones || []).forEach((p) => {
    const platform = PLATFORM_WORDS[p.platform] || PLATFORM_WORDS.other;
    nodes.push({
      id: `live-device-phone-${p.id}`, type: 'device', kind: 'phone', label: `Phone · ${platform}`,
      account: { role: p.role, groups: p.groups || [] },
      desc: `A browser that turned on reminders (a push subscription), through ${platform === 'other' ? 'another' : platform}'s push service. Live from ${from}; never whose it is.`,
    });
  });

  (world.nfc_tags || []).forEach((t) => {
    const id = `live-device-nfc-tag-${t.id}`;
    const where = t.room_id && roomIds.has(t.room_id) ? roomName.get(t.room_id) : null;
    nodes.push({
      id, type: 'device', kind: 'nfc-tag', label: t.needs_rewrite ? 'NFC tag · needs writing again' : 'NFC tag',
      desc: `An NFC tag${where ? ` stuck in the ${where}` : ', not stuck anywhere yet'}${t.needs_rewrite ? '; it needs writing again' : ''}. Its label stays with its owner.`,
    });
    if (where) own(`live-room-${t.room_id}`, id);
  });

  const ha = world.home_assistant || { status: 'off', devices: [], unmatched_areas: [] };
  const services = []; // the service devices with a host, matched against the map by `resolve`
  (ha.devices || []).forEach((d) => {
    const id = `live-device-home-assistant-${d.id}`;
    const made = [d.manufacturer, d.model].filter(Boolean).join(' ');
    const label = `${d.name} · ${plural(d.entities ?? 0, 'entity', 'entities')}`;
    if (d.service) {
      // Software, never in a room (spec 0031 section 3.1): placed by what serves its host, else in the tray
      const host = typeof d.host === 'string' && d.host ? d.host : null;
      const node = {
        id, type: 'device', kind: 'home-assistant', label, service: true, host,
        desc: `A Home Assistant service device: software, not a thing in a room${made ? ` (${made})` : ''}${host ? `, for ${host}` : ''}.`,
      };
      if (host) services.push({ id, host, what: d.manufacturer || d.name });
      else node.unplaced = d.address ? AT_ADDRESS : NO_HOST;
      nodes.push(node);
    } else {
      const placed = d.room_id && roomIds.has(d.room_id);
      nodes.push({
        id, type: 'device', kind: 'home-assistant', label,
        desc: `A Home Assistant device${made ? ` (${made})` : ''}${d.area ? `, in the HA area ${d.area}` : ', with no HA area'}${placed ? '' : ': no room matches it yet'}.`,
      });
      if (placed) own(`live-room-${d.room_id}`, id);
    }
    edges.push({ from: id, to: haContainer, kind: 'delivers', status: 'live', label: 'its entities, into Home Assistant' });
  });

  const notes = [];
  if (ha.status === 'off') notes.push(`Home Assistant off${ha.note ? `: ${ha.note}` : ''}`);
  else if (ha.status === 'error') notes.push(`Home Assistant: ${ha.note || 'it did not answer'}`);
  if ((ha.unmatched_areas || []).length) notes.push(`HA areas with no room: ${ha.unmatched_areas.join(', ')}`);
  const unlinked = world.unlinked || { hosts: [], cameras: [] };
  if ((unlinked.hosts || []).length) notes.push(`${plural(unlinked.hosts.length, 'machine')} ${unlinked.hosts.length === 1 ? 'has' : 'have'} no inventory item: ${unlinked.hosts.join(', ')}`);
  if ((unlinked.cameras || []).length) notes.push(`${plural(unlinked.cameras.length, 'camera')} ${unlinked.cameras.length === 1 ? 'has' : 'have'} no inventory item: ${unlinked.cameras.join(', ')}`);
  if (unlinked.note) notes.push(unlinked.note);
  // The House view's tray line (PHY-11): the HA areas no room matched, and what has no inventory item
  const missing = [...(unlinked.hosts || []), ...(unlinked.cameras || [])];
  const unplaced = [
    ...((ha.unmatched_areas || []).length ? [`HA areas with no room: ${ha.unmatched_areas.join(', ')}`] : []),
    ...(missing.length ? [`No inventory item: ${missing.join(', ')}`] : []),
  ];

  return {
    at: world.at,
    nodes,
    edges,
    accounts: world.accounts || [],
    hardware: (world.hardware || []).map((h) => ({ ...h, roomName: h.item && h.item.room_id ? roomName.get(h.item.room_id) || null : null })),
    notes,
    unplaced,
    plan: { viewBox: house.viewBox || { width: 800, height: 600 }, floors: house.floors || [], rooms },
    // The tool's mergeLive calls this with the map (spec 0031 section 3.1): the service devices against it
    resolve: (mapNodes, mapEdges) => resolveServiceDevices(services, mapNodes, mapEdges, cloudHosts),
  };
}

/** One signal that aborts when either does (AbortSignal.any where the browser has it) */
function eitherSignal(a, b) {
  if (!a) return b;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  if (a.aborted || b.aborted) stop();
  a.addEventListener('abort', stop);
  b.addEventListener('abort', stop);
  return ctl.signal;
}

/**
 * Makes a live source over an HTTP answer. `fetch`, the storage, the timer and the page's address are injectable for the tests.
 * @param {{ fetch?: typeof fetch, storage?: Storage, timeoutMs?: number, host?: string, url?: string, needsToken?: boolean,
 *   tokenKey?: string, tokenHref?: string, haContainer?: string, name?: string, cloudPath?: string | null }} [deps]
 *   `url` the same-origin address of the answer (`{ ok, data }` or the answer itself); `needsToken` sends the token
 *   kept under `tokenKey` as a Bearer and refuses to ask without one; `host` the address the token is saved for
 *   (localStorage is per origin), the page's own by default
 */
export function createLiveSource({ fetch: fetcher = (...args) => globalThis.fetch(...args), storage, timeoutMs = WORLD_TIMEOUT_MS, host, url = HOUSE_PATH, needsToken = true, tokenKey = TOKEN_KEY, tokenHref = '', haContainer = HA_CONTAINER_ID, name, cloudPath = CLOUD_PATH, tokenHelp = TOKEN_HELP } = {}) {
  const store = () => (storage !== undefined ? storage : globalThis.localStorage);
  const where = () => (host !== undefined ? host : (globalThis.location && globalThis.location.host) || '');
  const authed = (signal) => {
    if (!needsToken) return { headers: { Accept: 'application/json' }, cache: 'no-store', signal };
    const token = readToken(store(), tokenKey);
    if (!token) {
      const at = where();
      throw liveError('no-token', { hint: NO_TOKEN_HINT, detail: at ? `Tokens are saved per address: this is ${at}.` : '', ...(tokenHref ? { href: tokenHref } : {}) });
    }
    return { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, cache: 'no-store', signal };
  };
  // The registry's hosts, read once from the server (no token: it is the checkout's file, not the API's); none on failure
  let cloudHosts = null;
  const registryHosts = async (signal) => {
    if (cloudHosts) return cloudHosts;
    if (!cloudPath) return [];
    try {
      const res = await fetcher(cloudPath, { headers: { Accept: 'application/json' }, cache: 'no-store', signal });
      if (!res.ok) return [];
      cloudHosts = cloudHostsOf(await res.json());
      return cloudHosts;
    } catch {
      return [];
    }
  };

  return {
    name: name || url,

    /**
     * The tool's token setting (the Live menu's field): kept where the board keeps it, so either sets it for both.
     * It is only ever read into the Authorization header; never shown, logged or put in a URL.
     */
    token: {
      label: 'Token',
      help: tokenHelp,
      has: () => !!readToken(store(), tokenKey),
      /** Saves a non-empty token; false when there was nothing to save or storage refused it */
      save(value) {
        const v = String(value == null ? '' : value).trim();
        if (!v) return false;
        try { store().setItem(tokenKey, v); return true; } catch { return false; }
      },
      forget() {
        try { store().removeItem(tokenKey); } catch { /* storage blocked: nothing was kept */ }
      },
    },

    /** The tool's live-source interface: `load({ groups, signal })` → the live answer, or throws `liveError` */
    async load({ groups = [], signal } = {}) {
      const timer = new AbortController();
      const t = setTimeout(() => timer.abort(), timeoutMs);
      try {
        const query = groups.length ? `?groups=${encodeURIComponent(groups.join(','))}` : '';
        let res;
        try {
          res = await fetcher(url + query, authed(eitherSignal(signal, timer.signal)));
        } catch (err) {
          if (err && err.reason) throw err;
          if (signal && signal.aborted) throw err; // the tool cancelled it: not a failure to show
          if (err && err.name === 'AbortError') throw liveError('unavailable', { message: 'timeout', hint: 'the source did not answer in time (timeout)' });
          const said = String(err && err.message);
          throw liveError('unavailable', { message: said, hint: `the source could not be reached (${said})` });
        }
        if (res.status === 401 || res.status === 403) throw liveError('forbidden', { status: res.status, hint: FORBIDDEN_HINT, detail: `The source answered ${res.status}.` });
        if (!res.ok) throw liveError('unavailable', { status: res.status, message: `HTTP ${res.status}`, hint: `the source answered HTTP ${res.status}` });
        let body;
        try { body = await res.json(); } catch { throw liveError('unavailable', { message: 'the answer was not JSON', hint: 'the source answered, but not with JSON' }); }
        const data = body && body.ok === true && body.data ? body.data : body && body.ok === undefined && (body.house || body.version) ? body : null;
        if (!data) throw liveError('unavailable', { message: 'the answer had no data', hint: 'the answer had no data' });
        return worldToLive(data, { cloudHosts: await registryHosts(eitherSignal(signal, timer.signal)), haContainer });
      } finally {
        clearTimeout(t);
      }
    },

    /** A hardware photo (a same-origin path), fetched with the token: a Blob the tool shows from a blob URL, kept in memory only */
    async image(src, { signal } = {}) {
      if (typeof src !== 'string' || !src.startsWith('/') || src.startsWith('//')) return null;
      const res = await fetcher(src, authed(signal));
      return res.ok ? res.blob() : null;
    },
  };
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A small two-floor plan for the House view when a source gives none: generic rooms, nobody's house */
export const SAMPLE_PLAN = Object.freeze({
  viewBox: FLOOR_VIEWBOX,
  floors: [{ id: 'ground', name: 'Ground floor', level: 0 }, { id: 'upstairs', name: 'Upstairs', level: 1 }],
  rooms: [
    { id: 'living-room', floor_id: 'ground', name: 'Living room', x: 40, y: 40, w: 420, h: 300 },
    { id: 'kitchen', floor_id: 'ground', name: 'Kitchen', x: 480, y: 40, w: 280, h: 300 },
    { id: 'hall', floor_id: 'ground', name: 'Hall', x: 40, y: 360, w: 720, h: 200 },
    { id: 'office', floor_id: 'upstairs', name: 'Office', x: 40, y: 40, w: 340, h: 260 },
    { id: 'bedroom', floor_id: 'upstairs', name: 'Bedroom', x: 400, y: 40, w: 360, h: 260 },
    { id: 'landing', floor_id: 'upstairs', name: 'Landing', x: 40, y: 320, w: 720, h: 240 },
  ],
});

/**
 * Makes the House view's floor hook: one floor of a plan as a plain SVG of its room boxes and names.
 * `defaultPlan()` is the plan shown while the live layer is unavailable (the `plan` given, else SAMPLE_PLAN).
 * @param {{ plan?: object, editUrl?: string | ((floorId: string) => string) }} [opts]
 */
export function createFloorRenderer({ plan = SAMPLE_PLAN, editUrl } = {}) {
  return {
    element: 'div',
    render(p, floorId) {
      const vb = (p && p.viewBox) || FLOOR_VIEWBOX;
      const rooms = ((p && p.rooms) || []).filter((r) => r.floor_id === floorId && [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number'));
      const drawn = rooms.map((r) => `<g class="hx-plain-room" data-room="${esc(r.id)}"><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="6"></rect><text x="${r.x + 10}" y="${r.y + 22}">${esc(r.name)}</text></g>`).join('');
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vb.width} ${vb.height}" class="hx-plain-floor" data-floor="${esc(floorId)}">${drawn}</svg>`;
    },
    defaultPlan() {
      const src = plan || SAMPLE_PLAN;
      return {
        viewBox: { ...(src.viewBox || FLOOR_VIEWBOX) },
        floors: (src.floors || []).map((f) => ({ ...f })),
        rooms: (src.rooms || []).map(({ id, floor_id, name, x, y, w, h }) => ({ id, floor_id, name, x, y, w, h })),
      };
    },
    ...(editUrl ? { editUrl } : {}),
  };
}

/** The floor hook with the sample plan */
export const floorRenderer = createFloorRenderer();

/**
 * The built-in house source (cornfield.config.js `sources.house: { use: 'house', options }`): the repo's house
 * file, served by cornfield at /cornfield/house.json and read with no token. Options (plain JSON, sent to the
 * browser): `{ file, haContainer?, editUrl? }`; `file` is read by the server, not here.
 * @param {{ haContainer?: string, editUrl?: string }} [options]
 */
export function create(options = {}) {
  return {
    liveSource: createLiveSource({ url: HOUSE_PATH, needsToken: false, name: 'the house file', haContainer: options.haContainer || HA_CONTAINER_ID }),
    floorRenderer: createFloorRenderer({ editUrl: typeof options.editUrl === 'string' ? options.editUrl : undefined }),
  };
}

// ---------------------------------------------------------------------------
//  A permission checker over HTTP
// ---------------------------------------------------------------------------

/** The most checks one request carries unless the checker is told otherwise */
export const CHECK_MAX = 100;

/**
 * Makes a checker (the tool's checker interface, explorer/check-model.js) over a `POST` route that answers
 * `{ ok, data: { results } }` for `{ checks }`. `fetch`, the storage and the timer are injectable for the tests.
 * @param {{ url: string, apps?: string[], max?: number, fetch?: typeof fetch, storage?: Storage, timeoutMs?: number, base?: string, token?: string, tokenKey?: string }} deps
 *   `url` the route (same origin); `apps` the app nodes whose endpoint pages it can check; `base` an origin to put
 *   before the path (the page uses its own); `token` in place of the one kept in this browser
 */
export function createChecker({ url, apps = [], max = CHECK_MAX, fetch: fetcher = (...args) => globalThis.fetch(...args), storage, timeoutMs = WORLD_TIMEOUT_MS, base = '', token, tokenKey = TOKEN_KEY } = {}) {
  if (typeof url !== 'string' || !url.startsWith('/')) throw new Error('createChecker: url is a same-origin path');
  const store = () => (storage !== undefined ? storage : globalThis.localStorage);
  return {
    name: url,
    apps: [...apps],
    max,

    /** `check(items, { signal })` → `[{ id, allowed, status, reason, rule?, checked }]`, or throws `liveError` (`bad-check` names the check) */
    async check(items, { signal } = {}) {
      const bearer = token || readToken(store(), tokenKey);
      if (!bearer) throw liveError('no-token', { hint: 'set a token in the Live menu' });
      const timer = new AbortController();
      const t = setTimeout(() => timer.abort(), timeoutMs);
      try {
        let res;
        try {
          res = await fetcher(base + url, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
            body: JSON.stringify({ checks: items }),
            cache: 'no-store',
            signal: eitherSignal(signal, timer.signal),
          });
        } catch (err) {
          if (signal && signal.aborted) throw err; // the tool cancelled it: not a failure to show
          throw liveError('unavailable', { message: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message) });
        }
        if (res.status === 401 || res.status === 403) throw liveError('forbidden', { status: res.status });
        let body = null;
        try { body = await res.json(); } catch { /* not JSON: said below */ }
        if (res.status === 400) {
          const said = String((body && body.error) || '');
          const named = /^check "([^"]+)": ([\s\S]*)$/.exec(said);
          const err = liveError(named ? 'bad-check' : 'unavailable', { status: 400, message: named ? named[2] : said || 'HTTP 400' });
          if (named) err.checkId = named[1];
          throw err;
        }
        if (!res.ok) throw liveError('unavailable', { status: res.status, message: `HTTP ${res.status}` });
        if (!body || !body.ok || !body.data || !Array.isArray(body.data.results)) throw liveError('unavailable', { message: 'the answer had no results' });
        return body.data.results;
      } finally {
        clearTimeout(t);
      }
    },
  };
}

/**
 * @vitest-environment node
 *
 * Home Assistant as a house source (plugins/house/home-assistant.js, SRC-01): the floor, area, device and
 * entity registries over the WebSocket API, read-only, with a token from the environment, as the house
 * answer. Against a fake Home Assistant: a WebSocket server on loopback that speaks its auth and the
 * four `config/*_registry/list` commands. No real Home Assistant, no network, no real token.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  HA_COMMANDS, fetchRegistries, haWebSocketUrl, homeAssistantHouse, registriesToHouse, sameName,
} from '../../plugins/house/home-assistant.js';
import { createCornfieldServer } from '../../server/server.js';
import { loadConfig, browserSources, configProblems } from '../../core/config.js';
import { worldToLive } from '../../plugins/house/browser.js';

const TOKEN = 'fake-token-for-tests';

/** Recorded registries, in the shapes Home Assistant answers with (names are generic, nobody's house) */
const REGISTRIES = {
  'config/floor_registry/list': [
    { floor_id: 'ground', name: 'Ground floor', level: 0, aliases: [] },
    { floor_id: 'upstairs', name: 'Upstairs', level: 1, aliases: [] },
  ],
  'config/area_registry/list': [
    { area_id: 'kitchen', name: 'Kitchen', floor_id: 'ground', aliases: [] },
    { area_id: 'lounge', name: 'Lounge', floor_id: 'ground', aliases: ['Living room'] },
    { area_id: 'office', name: 'Office', floor_id: 'upstairs', aliases: [] },
    { area_id: 'garage', name: 'Garage', floor_id: null, aliases: [] },
  ],
  'config/device_registry/list': [
    { id: 'd-light', name: 'Hue bulb', name_by_user: 'Kitchen light', area_id: 'kitchen', manufacturer: 'Signify', model: 'LCA001', identifiers: [['hue', 'x']], entry_type: null, disabled_by: null },
    { id: 'd-tv', name: 'TV', name_by_user: null, area_id: 'lounge', manufacturer: 'Acme', model: 'T1', identifiers: [['cast', 'y']], entry_type: null, disabled_by: null },
    { id: 'd-phone', name: "Someone's phone", name_by_user: null, area_id: null, manufacturer: 'Apple', model: 'iPhone', identifiers: [['mobile_app', 'abc123']], entry_type: null, disabled_by: null },
    { id: 'd-nextcloud', name: 'Nextcloud', area_id: null, manufacturer: 'Nextcloud', model: null, identifiers: [['nextcloud', 'z']], entry_type: 'service', configuration_url: 'https://cloud.example.test/settings', disabled_by: null },
    { id: 'd-router', name: 'Router', area_id: null, manufacturer: 'Acme', model: 'R', identifiers: [['upnp', 'r']], entry_type: 'service', configuration_url: 'http://192.168.1.1:80/', disabled_by: null },
    { id: 'd-off', name: 'Old sensor', area_id: 'office', identifiers: [['zha', 'o']], disabled_by: 'user' },
  ],
  'config/entity_registry/list': [
    { entity_id: 'light.kitchen', device_id: 'd-light', disabled_by: null },
    { entity_id: 'sensor.kitchen_power', device_id: 'd-light', disabled_by: null },
    { entity_id: 'sensor.kitchen_old', device_id: 'd-light', disabled_by: 'integration' },
    { entity_id: 'media_player.tv', device_id: 'd-tv', disabled_by: null },
    { entity_id: 'device_tracker.phone', device_id: 'd-phone', disabled_by: null },
    { entity_id: 'sun.sun', device_id: null, disabled_by: null },
  ],
};

// ---------------------------------------------------------------------------
//  A fake Home Assistant: just enough of RFC 6455 for text frames
// ---------------------------------------------------------------------------

/** One text frame from the server (unmasked) */
function frame(text) {
  const body = Buffer.from(text, 'utf8');
  const head = body.length < 126 ? Buffer.from([0x81, body.length])
    : body.length < 65536 ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255])
      : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(body.length)); return b; })()]);
  return Buffer.concat([head, body]);
}

/** The client's frames (masked) in a buffer: `{ messages, rest }` */
function readFrames(buf) {
  const messages = [];
  let at = 0;
  for (;;) {
    if (buf.length - at < 2) break;
    const op = buf[at] & 0x0f;
    let len = buf[at + 1] & 0x7f;
    let p = at + 2;
    if (len === 126) { if (buf.length < p + 2) break; len = buf.readUInt16BE(p); p += 2; } else if (len === 127) { if (buf.length < p + 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    if (buf.length < p + 4 + len) break;
    const mask = buf.subarray(p, p + 4);
    const data = Buffer.from(buf.subarray(p + 4, p + 4 + len)).map((b, k) => b ^ mask[k % 4]);
    messages.push({ op, text: data.toString('utf8') });
    at = p + 4 + len;
  }
  return { messages, rest: buf.subarray(at) };
}

/**
 * Starts a fake Home Assistant. `behaviour`: 'ok', 'bad-token', 'silent', 'no-floors' (an older Home Assistant).
 * Every message it receives is kept in `seen`.
 */
function fakeHomeAssistant(behaviour = 'ok') {
  const seen = [];
  const paths = [];
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => {
    paths.push(req.url);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    const send = (msg) => socket.write(frame(JSON.stringify(msg)));
    if (behaviour !== 'silent') send({ type: 'auth_required', ha_version: '2026.10.0' });
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const { messages, rest } = readFrames(Buffer.concat([buf, chunk]));
      buf = rest;
      for (const { op, text } of messages) {
        if (op === 8) { socket.end(); return; }
        if (op !== 1) continue;
        const msg = JSON.parse(text);
        seen.push(msg);
        if (msg.type === 'auth') {
          if (behaviour === 'bad-token' || msg.access_token !== TOKEN) send({ type: 'auth_invalid', message: 'Invalid access token or password' });
          else send({ type: 'auth_ok', ha_version: '2026.10.0' });
        } else if (behaviour === 'no-floors' && msg.type === HA_COMMANDS[0]) {
          send({ id: msg.id, type: 'result', success: false, error: { code: 'unknown_command', message: 'Unknown command.' } });
        } else if (REGISTRIES[msg.type]) {
          send({ id: msg.id, type: 'result', success: true, result: REGISTRIES[msg.type] });
        } else {
          send({ id: msg.id, type: 'result', success: false, error: { code: 'unknown_command' } });
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, paths, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}

const made = [];
afterAll(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });
function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-ha-'));
  made.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof text === 'string' ? text : JSON.stringify(text));
  }
  return root;
}

// ---------------------------------------------------------------------------

describe('registriesToHouse', () => {
  const registries = { floors: REGISTRIES['config/floor_registry/list'], areas: REGISTRIES['config/area_registry/list'], devices: REGISTRIES['config/device_registry/list'], entities: REGISTRIES['config/entity_registry/list'] };

  it('makes floors from the floor registry and a room per area, an area on no floor on a Home floor', () => {
    const { house } = registriesToHouse(registries);
    expect(house.floors).toEqual([{ id: 'ground', name: 'Ground floor', level: 0 }, { id: 'upstairs', name: 'Upstairs', level: 1 }, { id: 'home', name: 'Home', level: 0 }]);
    expect(house.rooms.map((r) => `${r.id}@${r.floor_id} ${r.name}`)).toEqual(['kitchen@ground Kitchen', 'lounge@ground Lounge', 'office@upstairs Office', 'garage@home Garage']);
  });

  it('places devices in their area, counts enabled entities, and leaves a mobile_app device out entirely', () => {
    const { home_assistant: ha } = registriesToHouse(registries);
    expect(ha.status).toBe('ok');
    expect(ha.devices).toEqual([
      { id: 'd-light', name: 'Kitchen light', room_id: 'kitchen', area: 'Kitchen', entities: 2, manufacturer: 'Signify', model: 'LCA001' },
      { id: 'd-tv', name: 'TV', room_id: 'lounge', area: 'Lounge', entities: 1, manufacturer: 'Acme', model: 'T1' },
      { id: 'd-nextcloud', name: 'Nextcloud', room_id: null, area: null, entities: 0, manufacturer: 'Nextcloud', model: null, service: true, host: 'cloud.example.test' },
      { id: 'd-router', name: 'Router', room_id: null, area: null, entities: 0, manufacturer: 'Acme', model: 'R', service: true, address: true },
    ]);
    const text = JSON.stringify(ha);
    // A mobile_app device (a person's phone) is not there at all
    expect(ha.devices.map((d) => d.id)).not.toContain('d-phone');
    expect(text).not.toContain('d-phone');
    expect(text).not.toContain("Someone's phone");
    expect(text).not.toContain('Apple');
    expect(text).not.toContain('iPhone');
    expect(text).not.toContain('192.168');
  });

  it("maps areas to a house file's rooms by name and alias, and lists the areas no room matches", () => {
    const plan = { viewBox: { width: 800, height: 600 }, floors: [{ id: 'main', name: 'Main', level: 0 }], rooms: [
      { id: 'k', floor_id: 'main', name: 'kitchen', x: 0, y: 0, w: 10, h: 10 },
      { id: 'lr', floor_id: 'main', name: 'Living  Room', x: 10, y: 0, w: 10, h: 10 },
      { id: 'study', floor_id: 'main', name: 'Study', aliases: ['Office'], x: 20, y: 0, w: 10, h: 10 },
    ] };
    const { house, home_assistant: ha } = registriesToHouse(registries, { plan });
    expect(house.rooms).toBe(plan.rooms);
    expect(ha.devices.filter((d) => d.room_id).map((d) => `${d.id}→${d.room_id}`)).toEqual(['d-light→k', 'd-tv→lr']);
    expect(ha.unmatched_areas).toEqual(['Garage']);
    expect(sameName('Living_room', 'living  ROOM')).toBe(true);
    expect(sameName('', '')).toBe(false);
  });

  it('is an answer the house plugin draws: rooms, devices under them, no phone', () => {
    const live = worldToLive({ at: '2026-10-19T00:00:00.000Z', ...registriesToHouse(registries) });
    expect(live.nodes.filter((n) => n.type === 'room').map((n) => n.label)).toEqual(['Kitchen', 'Lounge', 'Office', 'Garage']);
    expect(live.edges).toContainEqual({ from: 'live-room-kitchen', to: 'live-device-home-assistant-d-light' });
    expect(live.nodes.some((n) => n.id.includes('d-phone'))).toBe(false);
  });
});

describe('haWebSocketUrl', () => {
  it('turns the Home Assistant address into its WebSocket API', () => {
    expect(haWebSocketUrl('http://homeassistant.local:8123')).toBe('ws://homeassistant.local:8123/api/websocket');
    expect(haWebSocketUrl('https://ha.example.test/')).toBe('wss://ha.example.test/api/websocket');
    expect(haWebSocketUrl('https://ha.example.test/api/websocket')).toBe('wss://ha.example.test/api/websocket');
    expect(() => haWebSocketUrl('ftp://x')).toThrow(/not http/);
    expect(() => haWebSocketUrl('nope')).toThrow(/not a URL/);
  });
});

describe('against a fake Home Assistant', () => {
  it('authenticates with the token, reads the four registries and nothing else', async () => {
    const ha = await fakeHomeAssistant();
    try {
      const out = await fetchRegistries({ url: ha.url, token: TOKEN });
      expect(out.areas.map((a) => a.area_id)).toEqual(['kitchen', 'lounge', 'office', 'garage']);
      expect(ha.paths).toEqual(['/api/websocket']);
      expect(ha.seen.map((m) => m.type)).toEqual(['auth', ...HA_COMMANDS]);
    } finally { await ha.close(); }
  });

  it('says the token was refused, without the token or the address', async () => {
    const ha = await fakeHomeAssistant('bad-token');
    try {
      const answer = await homeAssistantHouse({ url: ha.url, token: TOKEN });
      expect(answer.home_assistant).toEqual({ status: 'error', note: 'Home Assistant refused the token', unmatched_areas: [], devices: [] });
      expect(JSON.stringify(answer)).not.toContain(TOKEN);
      expect(JSON.stringify(answer)).not.toContain('127.0.0.1');
    } finally { await ha.close(); }
  });

  it('gives up on a Home Assistant that does not answer, and on one that is not there', async () => {
    const ha = await fakeHomeAssistant('silent');
    try {
      const answer = await homeAssistantHouse({ url: ha.url, token: TOKEN, timeoutMs: 200 });
      expect(answer.home_assistant.note).toBe('Home Assistant did not answer in 1 s');
    } finally { await ha.close(); }
    const gone = await homeAssistantHouse({ url: ha.url, token: TOKEN, timeoutMs: 2000 });
    expect(gone.home_assistant).toMatchObject({ status: 'error', note: 'Home Assistant could not be reached' });
  });

  it('reads a Home Assistant older than floors (no floor registry) with no floors', async () => {
    const ha = await fakeHomeAssistant('no-floors');
    try {
      const answer = await homeAssistantHouse({ url: ha.url, token: TOKEN });
      expect(answer.house.floors).toEqual([{ id: 'home', name: 'Home', level: 0 }]);
      expect(answer.home_assistant.status).toBe('ok');
    } finally { await ha.close(); }
  });

  it('is off, with what to set, when there is no URL or token', async () => {
    expect((await homeAssistantHouse({ url: null, token: null })).home_assistant).toMatchObject({ status: 'off', note: 'set CORNFIELD_HA_URL and CORNFIELD_HA_TOKEN where cornfield runs' });
  });
});

describe('a repo with only a Home Assistant URL and token', () => {
  let ha;
  beforeAll(async () => { ha = await fakeHomeAssistant(); });
  afterAll(async () => { await ha.close(); });

  const get = async (server, p) => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
      return { status: res.status, body: await res.json() };
    } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
  };

  it('gets a House view: the config names the source on its own, and the server answers from Home Assistant', async () => {
    const root = repo({ 'package.json': { name: 'flat' } });
    const env = { CORNFIELD_HA_URL: ha.url, CORNFIELD_HA_TOKEN: TOKEN };
    const config = await loadConfig(root, { env });
    expect(config.sources.house).toEqual({ use: 'home-assistant', options: {} });
    expect(browserSources(config).house).toEqual({ module: '/plugins/house/browser.js', options: {} });
    const { status, body } = await get(createCornfieldServer(config, { env }), '/cornfield/house.json');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.house.rooms.map((r) => r.id)).toEqual(['kitchen', 'lounge', 'office', 'garage']);
    expect(body.data.home_assistant.devices).toHaveLength(4);
    expect(JSON.stringify(body)).not.toContain('d-phone');
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    // Without the env vars there is no house source at all
    expect((await loadConfig(root, { env: {} })).sources.house).toBeNull();
  });

  it("keeps a house file's plan and other parts, and never sends the URL or the file to the browser", async () => {
    const root = repo({
      'cornfield.config.js': `export default { sources: { house: { use: 'home-assistant', options: { url: '${ha.url}', file: 'house.json', haContainer: 'container-ha' } } } };\n`,
      'package.json': { name: 'flat', type: 'module' },
      'house.json': { house: { floors: [{ id: 'main', name: 'Main', level: 0 }], rooms: [{ id: 'k', floor_id: 'main', name: 'Kitchen', x: 0, y: 0, w: 5, h: 5 }] }, accounts: [{ role: 'adult', groups: [], count: 2 }] },
    });
    const env = { CORNFIELD_HA_TOKEN: TOKEN };
    const config = await loadConfig(root, { env });
    expect(browserSources(config).house).toEqual({ module: '/plugins/house/browser.js', options: { haContainer: 'container-ha' } });
    const { body } = await get(createCornfieldServer(config, { env }), '/cornfield/house.json');
    expect(body.data.accounts).toEqual([{ role: 'adult', groups: [], count: 2 }]);
    expect(body.data.house.rooms.map((r) => r.id)).toEqual(['k']);
    expect(body.data.home_assistant.unmatched_areas).toEqual(['Lounge', 'Office', 'Garage']);
    expect(body.data.home_assistant.devices.find((d) => d.id === 'd-light').room_id).toBe('k');
  });

  it('answers only a loopback Host: a foreign one gets 421 and Home Assistant is never asked', async () => {
    const root = repo({ 'package.json': { name: 'flat' } });
    const env = { CORNFIELD_HA_URL: ha.url, CORNFIELD_HA_TOKEN: TOKEN };
    const server = createCornfieldServer(await loadConfig(root, { env }), { env });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const before = ha.seen.length;
    try {
      const status = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/cornfield/house.json', headers: { Host: 'attacker.example.test' } }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(421);
      expect(ha.seen.length).toBe(before);
    } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
  });

  it('refuses a token in the config, and a URL that is not one', () => {
    expect(configProblems({ sources: { house: { use: 'home-assistant', options: { token: 'x' } } } }).join()).toMatch(/token never goes in the config/);
    expect(configProblems({ sources: { house: { use: 'home-assistant', options: { url: 'homeassistant.local' } } } }).join()).toMatch(/url is Home Assistant's address/);
    expect(configProblems({ sources: { house: 'home-assistant' } })).toEqual([]);
  });
});

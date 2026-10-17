/**
 * @vitest-environment node
 *
 * Home Assistant service devices in the house (spec 0031 section 3.1, CLOUD-11): software HA keeps in its
 * device registry (its Nextcloud integration, `cloud.example.test`). This repo's adapter
 * (plugins/house/browser.js) resolves a service device's `host` against the map: the app whose label is the
 * host, its `runs-on` mapping, the container under that stack with the mapping's service, and the stack's machine;
 * or the cloud node whose topology.cloud.json entry claims the host. The tool lays the answer in (mergeLive) and
 * the House view (house-model.js) puts a resolved one beside its container in the Software band, never in a room,
 * and an unresolved one in the tray under "Service devices" with its reason. Run on a real map and registry (the sample repo).
 */
import { describe, it, expect, vi } from 'vitest';
import { recordedHouse, loadSample, sampleRegistry } from '../helpers.js';

/** The live source as an API-backed repo sets it up: its world route through a proxy path, a token, and where to make one */
const apiSource = (opts = {}) => createLiveSource({ url: '/api/v1/world', tokenHref: '/pipeline', tokenHelp: 'Make one on the server: `api-admin token create <you>` (admins only)', ...opts });
import fs from 'node:fs';
import path from 'node:path';
import {
  worldToLive, createLiveSource, resolveServiceHost, cloudHostsOf, HA_CONTAINER_ID, CLOUD_PATH, TOKEN_KEY,
  // @ts-expect-error plain JS modules, no declarations
} from '../../plugins/house/browser.js';
// @ts-expect-error plain JS modules, no declarations
import { mergeLive, placeLiveNodes } from '../../explorer/live-model.js';
// @ts-expect-error plain JS modules, no declarations
import { layoutHouse, trayKind, houseEdgeStyle, TRAY_KINDS } from '../../explorer/house-model.js';

const topology = loadSample();
const registry = sampleRegistry();
const recorded = recordedHouse().data;

const device = (id        , extra        ) => ({ id, name: id, room_id: null, area: null, entities: 1, manufacturer: null, model: null, service: false, host: null, address: false, ...extra });
const DEVICES = [
  device('nc', { name: 'cloud.example.test', manufacturer: 'Nextcloud', model: 'Nextcloud', service: true, host: 'cloud.example.test' }),
  device('haself', { name: 'Home Assistant', service: true, host: 'ha.example.test' }),
  device('ts', { name: 'Tailscale', manufacturer: 'Tailscale', service: true, host: 'api.tailscale.com' }),
  device('wx', { name: 'Forecast', manufacturer: 'Met.no', service: true, host: 'api.met.no' }),
  device('nohost', { name: 'Backup', service: true }),
  device('addr', { name: 'Router link', service: true, address: true }),
  // A service device HA put in an area: still never placed in a room
  device('inroom', { name: 'Recorder', service: true, room_id: 'kitchen', area: 'Kitchen' }),
  // Hardware, for contrast
  device('lamp', { name: 'Kitchen lamp', room_id: 'kitchen', area: 'Kitchen' }),
];
const world = { ...recorded, home_assistant: { status: 'ok', note: null, devices: DEVICES, unmatched_areas: [] } };
const cloudHosts = cloudHostsOf(registry);
const id = (d        ) => `live-device-home-assistant-${d}`;

const merge = (answer = worldToLive(world, { cloudHosts })) => mergeLive(topology.nodes.map((n     ) => ({ ...n })), topology.edges, answer);
const placementOf = (m     , devId        ) => m.edges.find((e     ) => e.to === id(devId) && e.dashed && !e.kind);
const nodeOf = (m     , devId        ) => m.nodes.find((n     ) => n.id === id(devId));

describe('the adapter: service devices on the live answer', () => {
  const live = worldToLive(world, { cloudHosts });
  const liveNode = (d        ) => live.nodes.find((n     ) => n.id === id(d));

  it('marks a service device with its host, and keeps its delivers edge into Home Assistant', () => {
    expect(liveNode('nc')).toMatchObject({ type: 'device', kind: 'home-assistant', service: true, host: 'cloud.example.test' });
    expect(liveNode('lamp').service).toBeFalsy();
    expect(live.edges).toContainEqual(expect.objectContaining({ from: id('nc'), to: HA_CONTAINER_ID, kind: 'delivers' }));
  });

  it('never hangs a service device in a room, even one HA put in an area; hardware stays in its room', () => {
    const owners = (d        ) => live.edges.filter((e     ) => e.to === id(d) && !e.kind && !e.dashed).map((e     ) => e.from);
    expect(owners('inroom')).toEqual([]);
    expect(owners('nc')).toEqual([]);
    expect(owners('lamp')).toEqual(['live-room-kitchen']);
  });

  it('gives the tray reasons that need no map: no host, an address instead of a name', () => {
    expect(liveNode('nohost').unplaced).toBe('Service device with no host');
    expect(liveNode('addr').unplaced).toBe('Service device at an address, not a name');
    expect(liveNode('nc').unplaced).toBeUndefined();
  });

  it('keeps only the hosts of the registry, never its env names or anything else', () => {
    expect(cloudHosts.find((c     ) => c.id === 'ext-tailscale')).toEqual({ id: 'ext-tailscale', hosts: ['api.tailscale.com'] });
    const envNames = registry.services.flatMap((s     ) => (s.match && s.match.env) || []);
    expect(envNames.length).toBeGreaterThan(0);
    const text = JSON.stringify(cloudHosts);
    for (const name of envNames) expect(text).not.toContain(name);
    expect(cloudHostsOf(null)).toEqual([]);
    expect(cloudHostsOf({ services: 'nope' })).toEqual([]);
  });
});

describe('resolving a host against the map', () => {
  const resolve = (host        , hosts = cloudHosts) => resolveServiceHost(host, topology.nodes, topology.edges, hosts);

  it('cloud.example.test is container-nextcloud on engine-1 (app → runs-on mapping → container → machine)', () => {
    expect(resolve('cloud.example.test')).toEqual({ kind: 'container', id: 'container-nextcloud', machine: 'machine-engine-1' });
  });

  it('the other self-hosted host reaches its container', () => {
    expect(resolve('ha.example.test')).toMatchObject({ kind: 'container', id: 'container-homeassistant', machine: 'machine-engine-1' });
  });

  it('a host a topology.cloud.json entry claims is its ext-* cloud node, wildcards by the registry matcher', () => {
    expect(resolve('api.tailscale.com')).toEqual({ kind: 'cloud', id: 'ext-tailscale' });
    const nodes = [...topology.nodes, { id: 'ext-weather', type: 'external', kind: 'cloud', label: 'Weather' }];
    expect(resolveServiceHost('api.met.no', nodes, topology.edges, [{ id: 'ext-weather', hosts: ['*.met.no'] }])).toEqual({ kind: 'cloud', id: 'ext-weather' });
    expect(resolveServiceHost('met.no', nodes, topology.edges, [{ id: 'ext-weather', hosts: ['*.met.no'] }])).toBeNull();
  });

  it('an unknown host, an empty one, and a claim on a node not on the map resolve to nothing', () => {
    expect(resolve('nowhere.example.com')).toBeNull();
    expect(resolve('')).toBeNull();
    expect(resolve('api.tailscale.com', [{ id: 'ext-not-there', hosts: ['api.tailscale.com'] }])).toBeNull();
  });
});

describe('merged into the map', () => {
  it('cloud.example.test gets a dashed placement from container-nextcloud, and says where it runs', () => {
    const m = merge();
    expect(placementOf(m, 'nc')).toMatchObject({ from: 'container-nextcloud', live: true, dashed: true });
    expect(nodeOf(m, 'nc').desc).toBe('Nextcloud integration in Home Assistant · on container-nextcloud, engine-1');
    expect(nodeOf(m, 'nc').unplaced).toBeUndefined();
    expect(m.edges).toContainEqual(expect.objectContaining({ from: id('nc'), to: HA_CONTAINER_ID, kind: 'delivers' }));
  });

  it('a registry host gets its placement from the cloud node', () => {
    const m = merge();
    expect(placementOf(m, 'ts')).toMatchObject({ from: 'ext-tailscale', dashed: true });
    expect(nodeOf(m, 'ts').desc).toMatch(/^Tailscale integration in Home Assistant · on Tailscale/);
  });

  it('an unknown host and a missing host get no placement, and their reasons', () => {
    const m = merge();
    for (const d of ['wx', 'nohost', 'addr', 'inroom']) expect(placementOf(m, d)).toBeUndefined();
    expect(nodeOf(m, 'wx').unplaced).toBe('Service device, host not on the map: api.met.no');
    expect(nodeOf(m, 'nohost').unplaced).toBe('Service device with no host');
    expect(nodeOf(m, 'addr').unplaced).toBe('Service device at an address, not a name');
  });

  it('never changes a code node, and an answer with no registry hosts still places the self-hosted ones', () => {
    const before = JSON.stringify(topology.nodes.find((n     ) => n.id === 'container-nextcloud'));
    const m = merge(worldToLive(world));
    expect(JSON.stringify(m.nodes.find((n     ) => n.id === 'container-nextcloud'))).toBe(before);
    expect(placementOf(m, 'nc')).toMatchObject({ from: 'container-nextcloud' });
    expect(nodeOf(m, 'ts').unplaced).toBe('Service device, host not on the map: api.tailscale.com');
  });

  it('places a resolved device beside its container in the orbit view', () => {
    const m = merge();
    m.nodes.forEach((n     , i        ) => { if (!n.live) { n.x = (i % 40) * 30; n.y = Math.floor(i / 40) * 30; } });
    placeLiveNodes(m.nodes, m.edges);
    const nc = nodeOf(m, 'nc');
    const host = m.nodes.find((n     ) => n.id === 'container-nextcloud');
    expect(Math.hypot(nc.x - host.x, nc.y - host.y)).toBeLessThan(120);
  });
});

describe('the House view', () => {
  const layout = (opts         = {}) => {
    const m = merge();
    return { m, out: layoutHouse({ nodes: m.nodes, edges: m.edges, plan: world.house, layers: { app: true, pkg: true }, ...opts }) };
  };

  it('draws cloud.example.test in the Software band beside container-nextcloud, not in the tray and not in a room', () => {
    const { out } = layout();
    const at = out.pos.get(id('nc'));
    const host = out.pos.get('container-nextcloud');
    expect(at && host).toBeTruthy();
    expect(Math.abs(at.y - host.y)).toBeLessThanOrEqual(40 * 2);
    expect(Math.abs(at.x - host.x)).toBeLessThanOrEqual(150 * 2);
    expect(out.roomOf.has(id('nc'))).toBe(false);
    for (const ids of out.tray.values()) expect(ids).not.toContain(id('nc'));
    const software = out.lanes.find((l     ) => l.title.text === 'Software');
    expect(at.x).toBeGreaterThan(software.x);
    expect(at.x).toBeLessThan(software.x + software.w);
  });

  it('never puts a service device in a room, even one HA put in an area; the hardware beside it stays', () => {
    const { out } = layout();
    expect(out.roomOf.has(id('inroom'))).toBe(false);
    expect(out.roomOf.get(id('lamp'))).toBe('live-room-kitchen');
  });

  it('lists the unresolved ones under "Service devices" in the tray, with their reasons on its line', () => {
    const { out } = layout();
    expect(TRAY_KINDS.map(([k]          ) => k)).toContain('service-device');
    expect(out.tray.get('service-device')).toEqual(expect.arrayContaining([id('wx'), id('nohost'), id('addr'), id('inroom')]));
    expect(out.tray.get('service-device')).not.toContain(id('nc'));
    expect(out.tray.get('home-assistant') || []).not.toContain(id('wx'));
    const group = out.lanes.find((l     ) => l.title.text === 'Service devices');
    expect(group.note.text).toContain('Service device, host not on the map: api.met.no');
    expect(group.note.text).toContain('Service device with no host');
    expect(group.note.text).toContain('Service device at an address, not a name');
    expect(trayKind({ type: 'device', kind: 'home-assistant', service: true })).toBe('service-device');
  });

  it('puts one on a cloud node beside it in the Cloud band (CLOUD-08), never in a room or the tray', () => {
    const { out } = layout({ layers: { app: true, pkg: true, cloud: true } });
    const at = out.pos.get(id('ts'));
    const cloud = out.pos.get('ext-tailscale');
    expect(at && cloud).toBeTruthy();
    expect(Math.abs(at.y - cloud.y)).toBeLessThan(200);
    expect(out.roomOf.has(id('ts'))).toBe(false);
    for (const ids of out.tray.values()) expect(ids).not.toContain(id('ts'));
  });

  it('on a phone, the device follows its container into the Software column once the toggle is on', () => {
    expect(layout({ phone: true }).out.pos.has(id('nc'))).toBe(false);
    const { out } = layout({ phone: true, software: true });
    const at = out.pos.get(id('nc'));
    const host = out.pos.get('container-nextcloud');
    expect(Math.abs(at.y - host.y)).toBeLessThanOrEqual(40 * 2);
  });

  it('draws the placement from the container as a link, and keeps placements from rooms out', () => {
    const t = (type        ) => ({ type });
    expect(houseEdgeStyle({ from: 'a', to: 'b', dashed: true }, t('container'), t('device'))).toBe('link');
    expect(houseEdgeStyle({ from: 'a', to: 'b', dashed: true }, t('external'), t('device'))).toBe('link');
    expect(houseEdgeStyle({ from: 'a', to: 'b', dashed: true }, t('room'), t('device'))).toBe(null);
  });
});

describe('the adapter\'s load reads the registry\'s hosts from the hub', () => {
  const storage = { getItem: (k        ) => (k === TOKEN_KEY ? 'tok' : null) };
  it('asks the world first with the token, then the registry without it, once, and resolves with it', async () => {
    const fetch = vi.fn(async (url        ) => ({ ok: true, status: 200, json: async () => (url === CLOUD_PATH ? registry : { ok: true, data: world }) }));
    const src = apiSource({ fetch, storage });
    const answer = await src.load({ groups: [] });
    await src.load({ groups: [] });
    const calls = fetch.mock.calls         ;
    expect(calls[0][0]).toBe('/api/v1/world');
    expect(calls[1][0]).toBe(CLOUD_PATH);
    expect(calls[1][1] && calls[1][1].headers && calls[1][1].headers.Authorization).toBeUndefined();
    expect(calls.filter((c) => c[0] === CLOUD_PATH)).toHaveLength(1);
    expect(placementOf(merge(answer), 'ts')).toMatchObject({ from: 'ext-tailscale' });
  });

  it('a registry it cannot read only leaves the cloud hosts out', async () => {
    const fetch = vi.fn(async (url        ) => (url === CLOUD_PATH ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ ok: true, data: world }) }));
    const answer = await apiSource({ fetch, storage }).load({ groups: [] });
    const m = merge(answer);
    expect(placementOf(m, 'nc')).toMatchObject({ from: 'container-nextcloud' });
    expect(placementOf(m, 'ts')).toBeUndefined();
  });
});

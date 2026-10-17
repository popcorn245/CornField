/**
 * @vitest-environment node
 *
 * The House view's Cloud band (spec 0031 section 7, CLOUD-08), the pure half (explorer/house-model.js):
 * the band above the plan from the People band's left edge to the Software band's right edge, rows by role, the
 * Public web apart, `houseCloudLinks` rolling a service's or an endpoint's calls up to the container that runs it,
 * the line styles and opacity by `when`, the phone's Cloud toggle, and an outage that lights its containers and
 * machines. On a small map, and on a real one (the sample repo).
 */
import { describe, it, expect } from 'vitest';
import { recordedHouse, testFloorHook, loadSample } from '../helpers.js';

const floorRenderer = await testFloorHook();
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS modules, no declarations
import { worldToLive } from '../../plugins/house/browser.js';
// @ts-expect-error plain JS modules, no declarations
import { mergeLive } from '../../explorer/live-model.js';
import {
  layoutHouse, applyHouseLayout, houseCloudLinks, houseEdgeStyle, houseViewEdges, newHouseState, cloudRow, BAND_GAP, CLOUD_ROWS,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/house-model.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { WHEN_STYLES } from '../../explorer/cloud-model.js';
// @ts-expect-error plain JS modules, no declarations
import { blastRadius } from '../../explorer/outage-model.js';
// @ts-expect-error plain JS modules, no declarations
import { createPlayer } from '../../explorer/scenario.js';

const recorded = recordedHouse();
const live = worldToLive(recorded.data);
const topology = loadSample();

const n = (id        , type        , extra         = {}) => ({ id, type, label: id, x: 0, y: 0, r: 20, ...extra });
const cloud = (id        , roles          , extra         = {}) => n(id, 'external', { kind: 'cloud', roles, label: id.replace(/^ext-/, ''), ...extra });

/** A map shaped like main's: personas, machines, two stacks, the API and its services, Caddy, cloud nodes and the public web */
function codeMap() {
  const nodes        = [
    n('root', 'root'),
    n('persona-adult', 'persona', { label: 'Adult', role: 'adult', groups: ['family'] }),
    n('machine-server-1', 'machine', { label: 'server-1', hostname: 'server-1' }),
    n('machine-engine-1', 'machine', { label: 'engine-1', hostname: 'engine-1', virtual: true }),
    n('stack-app-stack', 'stack', { label: 'app-stack' }),
    n('stack-devops-stack', 'stack', { label: 'devops-stack' }),
    n('stack-cloud-stack', 'stack', { label: 'cloud-stack' }),
    n('container-backend', 'container', { label: 'backend', stack: 'app-stack', service: 'api' }),
    n('container-caddy', 'container', { label: 'caddy', stack: 'devops-stack', service: 'caddy' }),
    n('container-nextcloud', 'container', { label: 'nextcloud', stack: 'cloud-stack', service: 'nextcloud', selfHosted: true }),
    n('app-api', 'app', { label: 'api.example.test' }),
    n('app-tasks', 'app', { label: 'tasks.example.test' }),
    n('app-legacy', 'app', { label: 'legacy.example.test' }),
    n('service-push', 'service', { label: 'lib/web-push.ts' }),
    n('service-geo', 'service', { label: 'lib/geo.ts' }),
    n('page-geo', 'page', { label: 'GET /api/v1/geo/search' }),
    n('page-join', 'page', { label: 'POST /api/v1/join' }),
    n('page-join-openid', 'page', { label: 'GET /api/v1/join/openid' }),
    n('page-legacy', 'page', { label: 'GET /legacy' }),
    cloud('ext-cloudflare', ['runtime', 'account'], { label: 'Cloudflare' }),
    cloud('ext-push-service', ['runtime'], { label: 'Web Push' }),
    cloud('ext-nominatim', ['runtime'], { label: 'Nominatim' }),
    cloud('ext-google-fonts', ['runtime'], { label: 'Google Fonts' }),
    cloud('ext-openid', ['runtime', 'account'], { label: 'OpenID provider' }),
    cloud('ext-docker-hub', ['software'], { label: 'Docker Hub' }),
    cloud('ext-ghcr', ['software'], { label: 'GitHub Container Registry' }),
    cloud('ext-isp', ['account'], { label: 'Internet provider' }),
    cloud('ext-registrar', ['account'], { label: 'Domain registrar' }),
    n('ext-public-web', 'external', { kind: 'web', label: 'Public web' }),
  ];
  const edges        = [
    { from: 'stack-app-stack', to: 'container-backend' },
    { from: 'stack-devops-stack', to: 'container-caddy' },
    { from: 'stack-cloud-stack', to: 'container-nextcloud' },
    { from: 'stack-app-stack', to: 'machine-engine-1', kind: 'runs-on' },
    { from: 'stack-devops-stack', to: 'machine-engine-1', kind: 'runs-on' },
    { from: 'stack-cloud-stack', to: 'machine-engine-1', kind: 'runs-on' },
    { from: 'machine-engine-1', to: 'machine-server-1', kind: 'runs-on' },
    { from: 'app-api', to: 'stack-app-stack', kind: 'runs-on', mappings: [{ host: 'api.example.test', service: 'api' }] },
    { from: 'app-tasks', to: 'stack-app-stack', kind: 'runs-on', mappings: [{ host: 'tasks.example.test', service: 'tasks' }] },
    { from: 'app-legacy', to: 'stack-devops-stack', kind: 'runs-on', mappings: [{ host: 'legacy.example.test', service: 'nowhere' }] },
    { from: 'app-api', to: 'service-push' }, { from: 'app-api', to: 'service-geo' }, { from: 'app-api', to: 'page-geo' },
    { from: 'app-api', to: 'page-join' }, { from: 'page-join', to: 'page-join-openid' }, { from: 'app-legacy', to: 'page-legacy' },
    // the API's calls, through its services and endpoints (two endpoints reach Nominatim through the one service)
    { from: 'service-push', to: 'ext-push-service', kind: 'calls', label: 'sends reminders' },
    { from: 'service-geo', to: 'ext-nominatim', kind: 'calls', label: 'address search' },
    { from: 'page-geo', to: 'ext-nominatim', kind: 'calls', label: 'address search' },
    { from: 'page-join-openid', to: 'ext-openid', kind: 'calls', label: 'OpenID sign-in' },
    { from: 'page-legacy', to: 'ext-openid', kind: 'calls', label: 'old sign-in' },
    { from: 'container-backend', to: 'ext-docker-hub', kind: 'calls', label: 'node:22-alpine', when: 'deploy' },
    { from: 'container-caddy', to: 'ext-ghcr', kind: 'calls', label: 'the Caddy image', when: 'deploy' },
    { from: 'container-caddy', to: 'ext-cloudflare', kind: 'calls', label: 'DNS-01', when: 'renew' },
    { from: 'container-nextcloud', to: 'ext-docker-hub', kind: 'calls', label: 'nextcloud image', when: 'deploy' },
    { from: 'machine-server-1', to: 'ext-cloudflare', kind: 'calls', label: 'resolves *.example.test' },
    { from: 'machine-server-1', to: 'ext-isp', kind: 'calls', label: 'the line' },
    { from: 'app-tasks', to: 'ext-google-fonts', kind: 'calls', label: 'fonts', side: 'browser' },
    { from: 'ext-cloudflare', to: 'ext-registrar', kind: 'calls', label: 'the zone is delegated to it' },
    { from: 'page-geo', to: 'ext-public-web', kind: 'calls', label: 'never: a fixture edge' },
  ];
  return { nodes, edges };
}

const merged = () => { const { nodes, edges } = codeMap(); return mergeLive(nodes, edges, live); };
const lay = (opts         = {}) => {
  const m = merged();
  return { m, out: layoutHouse({ nodes: m.nodes, edges: m.edges, plan: live.plan, floor: 'basement', layers: { app: true, pkg: true }, notes: live.unplaced, ...opts }) };
};
const laneOf = (out     , title        ) => out.lanes.find((l     ) => l.title.text === title);
const inLane = (p     , l     ) => p.x > l.x && p.x < l.x + l.w && p.y > l.y && p.y < l.y + l.h;
const key = (l     ) => `${l.from}|${l.to}|${l.when}`;

describe('houseCloudLinks: one line per container, cloud node and when', () => {
  it('rolls a service\'s and an endpoint\'s calls up to the container its app\'s runs-on mapping names, with the count', () => {
    const { nodes, edges } = codeMap();
    const links = houseCloudLinks(nodes, edges);
    const byKey = new Map(links.map((l     ) => [key(l), l]));
    expect(byKey.get('container-backend|ext-push-service|run')).toMatchObject({ count: 1, machine: 'machine-engine-1' });
    expect(byKey.get('container-backend|ext-nominatim|run') .count).toBe(2); // the service and the endpoint
    // an endpoint under an endpoint still finds its app
    expect(byKey.get('container-backend|ext-openid|run') .count).toBe(1);
    // nothing is left on a service or an endpoint: they are not drawn in the House view
    expect(links.every((l     ) => !l.from.startsWith('service-') && !l.from.startsWith('page-'))).toBe(true);
  });

  it('keeps a container\'s own calls, one per when; else the stack when no container serves the app; a machine\'s own', () => {
    const { nodes, edges } = codeMap();
    const keys = houseCloudLinks(nodes, edges).map(key);
    expect(keys).toEqual(expect.arrayContaining([
      'container-backend|ext-docker-hub|deploy', 'container-caddy|ext-ghcr|deploy', 'container-caddy|ext-cloudflare|renew',
      'container-nextcloud|ext-docker-hub|deploy', 'stack-devops-stack|ext-openid|run', 'machine-server-1|ext-cloudflare|run',
    ]));
    // what the House view draws as it is: an app's (the visitor's browser) and a cloud node's own
    expect(keys.some((k        ) => k.startsWith('app-') || k.startsWith('ext-'))).toBe(false);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('on a real map: the API calls end on its container, Caddy renews through Cloudflare, nothing on a service or an endpoint', () => {
    const links = houseCloudLinks(topology.nodes, topology.edges);
    const keys = new Set(links.map(key));
    expect(keys.has('container-api|ext-push-service|run')).toBe(true);
    expect(keys.has('container-api|ext-nominatim|run')).toBe(true);
    expect(keys.has('container-caddy|ext-cloudflare|renew')).toBe(true);
    expect(keys.has('container-web|ext-docker-hub|deploy')).toBe(true);
    const byId = new Map(topology.nodes.map((x     ) => [x.id, x]));
    expect(links.every((l     ) => ['container', 'stack', 'machine'].includes((byId.get(l.from)       ).type))).toBe(true);
    expect(links.every((l     ) => (byId.get(l.to)       ).type === 'external')).toBe(true);
    const api = links.filter((l     ) => l.from === 'container-api' && l.when === 'run');
    expect(api.reduce((t        , l     ) => t + l.count, 0)).toBeGreaterThanOrEqual(2);
    expect(keys.size).toBe(links.length);
  });
});

describe('the band, above the plan and the street', () => {
  it('runs from the People band\'s left edge to the Software band\'s right edge, BAND_GAP above the plan', () => {
    const { out } = lay();
    const band = laneOf(out, 'Cloud');
    expect(band.note.text).toBe('Outside the house: what we do not control');
    const people = laneOf(out, 'People');
    const software = laneOf(out, 'Software');
    expect(band.x).toBeLessThanOrEqual(people.x);
    expect(band.x + band.w).toBeGreaterThanOrEqual(software.x + software.w);
    expect(band.y + band.h).toBeLessThanOrEqual(out.plan.y - BAND_GAP);
    for (const id of ['ext-cloudflare', 'ext-docker-hub', 'ext-isp', 'ext-public-web']) {
      expect(out.shown.has(id), id).toBe(true);
      expect(inLane(out.pos.get(id), band), id).toBe(true);
    }
    // the camera fits it
    expect(out.fit.minY).toBeLessThan(band.y);
  });

  it('three rows by role, top to bottom; a node with several roles in its first; each by how many use it, then label', () => {
    const { out } = lay();
    expect(CLOUD_ROWS.map((r     ) => r[0])).toEqual(['runtime', 'software', 'account']);
    expect(cloudRow({ roles: ['runtime', 'account'] })).toBe('runtime');
    expect(cloudRow({ roles: ['account'] })).toBe('account');
    const [runtime, software, account] = CLOUD_ROWS.map((r     ) => laneOf(out, r[1]));
    expect(runtime.y).toBeLessThan(software.y);
    expect(software.y).toBeLessThan(account.y);
    for (const id of ['ext-cloudflare', 'ext-push-service', 'ext-openid', 'ext-google-fonts']) expect(inLane(out.pos.get(id), runtime), id).toBe(true);
    for (const id of ['ext-docker-hub', 'ext-ghcr']) expect(inLane(out.pos.get(id), software), id).toBe(true);
    for (const id of ['ext-isp', 'ext-registrar']) expect(inLane(out.pos.get(id), account), id).toBe(true);
    // Cloudflare and Nominatim (2 users each, by label) before Google Fonts (1); the OpenID provider (2) before Web Push (1)
    const x = (id        ) => out.pos.get(id).x;
    expect(x('ext-cloudflare')).toBeLessThan(x('ext-nominatim'));
    expect(x('ext-nominatim')).toBeLessThan(x('ext-google-fonts'));
    expect(x('ext-openid')).toBeLessThan(x('ext-push-service'));
    expect(x('ext-docker-hub')).toBeLessThan(x('ext-ghcr'));
  });

  it('puts the Public web alone at the band\'s right end, in its own sub-lane', () => {
    const { out } = lay();
    const web = laneOf(out, 'Public web, not cloud');
    expect(inLane(out.pos.get('ext-public-web'), web)).toBe(true);
    const clouds = [...out.pos].filter(([id]     ) => id.startsWith('ext-') && id !== 'ext-public-web').map(([, p]     ) => p.x);
    expect(out.pos.get('ext-public-web').x).toBeGreaterThan(Math.max(...clouds));
    expect(web.x).toBeGreaterThan(Math.max(...CLOUD_ROWS.map((r     ) => { const l = laneOf(out, r[1]); return l.x + l.w; })));
  });

  it('leaves the self-hosted four where they run: their containers in the Software band', () => {
    const { out } = lay();
    const p = out.pos.get('container-nextcloud');
    expect(inLane(p, laneOf(out, 'Software'))).toBe(true);
    expect(p.y).toBeGreaterThanOrEqual(out.plan.y);
  });

  it('follows the Layers: Cloud off leaves the band out, Public web off leaves its sub-lane out', () => {
    const noCloud = lay({ layers: { app: true, cloud: false } }).out;
    expect(noCloud.shown.has('ext-cloudflare')).toBe(false);
    expect(laneOf(noCloud, 'Runtime')).toBeUndefined();
    expect(noCloud.shown.has('ext-public-web')).toBe(true);
    const noWeb = lay({ layers: { app: true, web: false } }).out;
    expect(noWeb.shown.has('ext-public-web')).toBe(false);
    expect(laneOf(noWeb, 'Public web, not cloud')).toBeUndefined();
    expect(noWeb.shown.has('ext-cloudflare')).toBe(true);
  });

  it('still draws with the live layer off: cloud nodes and their lines are all code-derived', () => {
    const { nodes, edges } = codeMap();
    const out = layoutHouse({ nodes, edges, plan: floorRenderer.defaultPlan(), layers: {} });
    expect(laneOf(out, 'Cloud')).toBeDefined();
    expect(out.cloudLines.length).toBeGreaterThan(0);
  });

  it('places a thing a dashed placement puts on a cloud node beside it in the band, never in a room or the tray', () => {
    const m = merged();
    const dev = n('live-device-home-assistant-weather', 'device', { kind: 'home-assistant', live: true, label: 'Weather' });
    const nodes = [...m.nodes, dev];
    const edges = [...m.edges, { from: 'ext-nominatim', to: dev.id, dashed: true, live: true }];
    const out = layoutHouse({ nodes, edges, plan: live.plan, layers: {} });
    const p = out.pos.get(dev.id);
    const at = out.pos.get('ext-nominatim');
    expect(inLane(p, laneOf(out, 'Runtime'))).toBe(true);
    expect(Math.abs(p.y - at.y)).toBeLessThan(80);
    expect([...out.tray.values()].flat()).not.toContain(dev.id);
    expect(out.roomOf.has(dev.id)).toBe(false);
    expect(houseEdgeStyle(edges[edges.length - 1], { type: 'external' }, { type: 'device' })).toBe('link');
  });
});

describe('the lines', () => {
  it('one drawn line per (container, cloud node, when), labelled with the count, the self-hosted container\'s too', () => {
    const { out } = lay();
    const lines = new Map(out.cloudLines.map((l     ) => [key(l), l]));
    expect(lines.get('container-backend|ext-nominatim|run')).toMatchObject({ kind: 'calls', when: 'run', rolled: true, status: 'live', label: 'backend · 2 calls' });
    expect(lines.get('container-backend|ext-push-service|run') .label).toBe('backend · 1 call');
    expect(lines.has('container-nextcloud|ext-docker-hub|deploy')).toBe(true);
    expect(lines.get('container-caddy|ext-cloudflare|renew') .when).toBe('renew');
  });

  it('houseEdgeStyle: a call into a cloud node is a flow when the House view draws it as it is; the rolled-up ones replace the rest', () => {
    const t = (type        ) => ({ type });
    const ext = t('external');
    expect(houseEdgeStyle({ from: 'a', to: 'b', kind: 'calls', side: 'browser' }, t('app'), ext)).toBe('flow');
    expect(houseEdgeStyle({ from: 'a', to: 'b', kind: 'calls' }, ext, ext)).toBe('flow');
    expect(houseEdgeStyle({ from: 'a', to: 'b', kind: 'calls', rolled: true }, t('container'), ext)).toBe('flow');
    expect(houseEdgeStyle({ from: 'a', to: 'b', kind: 'calls', when: 'deploy' }, t('container'), ext)).toBe(null);
    expect(houseEdgeStyle({ from: 'a', to: 'b', kind: 'calls' }, t('machine'), ext)).toBe(null);
    expect(houseEdgeStyle({ from: 'a', to: 'b', kind: 'calls' }, t('container'), t('container'))).toBe(null);
  });

  it('the view\'s edges are the map\'s plus the rolled-up lines, the same list while nothing changes', () => {
    const state = houseState();
    const all = houseViewEdges(state);
    expect(all.length).toBe(state.edges.length + state.house.cloudLines.length);
    expect(houseViewEdges(state)).toBe(all);
    expect(houseViewEdges({ ...state, house: { ...state.house, cloudLines: [] } })).toBe(state.edges);
  });
});

function houseState(extra         = {}, phone = false) {
  const { nodes, edges } = merged();
  const state      = {
    view: 'house', nodes, edges, activeLayers: { app: true, pkg: true, cloud: true, web: true }, live: { answer: live }, rings: { rings: [], clusters: [] },
    house: { ...newHouseState(), defaultPlan: floorRenderer.defaultPlan(), floor: 'basement', phone }, selectedNode: null, searchQuery: '',
    scenario: null, proposal: null, isFreeform: false, sceneVersion: 1, ...extra,
  };
  applyHouseLayout(state);
  return state;
}
const sceneLine = (scene     , from        , to        ) => scene.edges.find((e     ) => e.from === from && e.to === to);

describe('the scene: line styles and how busy', () => {
  it('solid for run, dashed for deploy, dotted for renew; with nothing selected deploy at 25 %, run at full', () => {
    const scene = buildScene(houseState());
    const run = sceneLine(scene, 'container-backend', 'ext-nominatim');
    const deploy = sceneLine(scene, 'container-backend', 'ext-docker-hub');
    const renew = sceneLine(scene, 'container-caddy', 'ext-cloudflare');
    expect(run.dash).toBe(null);
    expect(deploy.dash).toEqual(WHEN_STYLES.deploy.dash);
    expect(renew.dash).toEqual(WHEN_STYLES.renew.dash);
    expect(deploy.alpha).toBe(0.25);
    expect(run.alpha).toBeGreaterThanOrEqual(0.9);
    expect(run.arrow).toBe(true);
    // a machine on the plan, an app (the visitor's browser) and cloud → cloud inside the band
    expect(sceneLine(scene, 'machine-server-1', 'ext-isp')).toBeDefined();
    expect(sceneLine(scene, 'app-tasks', 'ext-google-fonts')).toBeDefined();
    expect(sceneLine(scene, 'ext-cloudflare', 'ext-registrar')).toBeDefined();
    // never a line from what the House view does not draw
    expect(scene.edges.some((e     ) => e.from.startsWith('service-') || e.from.startsWith('page-'))).toBe(false);
    // one line per container, cloud node and when: the container's own call is not drawn twice
    expect(scene.edges.filter((e     ) => e.from === 'container-backend' && e.to === 'ext-docker-hub')).toHaveLength(1);
  });

  it('selecting a cloud node draws only its lines at full, with the count, and lights the containers at their ends', () => {
    const state = houseState();
    state.selectedNode = state.nodes.find((x     ) => x.id === 'ext-nominatim');
    const scene = buildScene(state);
    const mine = sceneLine(scene, 'container-backend', 'ext-nominatim');
    expect(mine.alpha).toBe(1);
    expect(mine.label.text).toBe('backend · 2 calls');
    expect(sceneLine(scene, 'container-backend', 'ext-docker-hub').alpha).toBeLessThan(0.1);
    expect(scene.nodes.find((x     ) => x.id === 'container-backend').connected).toBe(true);
  });

  it('selecting a container draws its lines at full and lights the cloud nodes it uses', () => {
    const state = houseState();
    state.selectedNode = state.nodes.find((x     ) => x.id === 'container-backend');
    const scene = buildScene(state);
    expect(sceneLine(scene, 'container-backend', 'ext-docker-hub').alpha).toBe(1);
    expect(sceneLine(scene, 'container-caddy', 'ext-ghcr').alpha).toBeLessThan(0.1);
    for (const id of ['ext-nominatim', 'ext-push-service', 'ext-docker-hub']) expect(scene.nodes.find((x     ) => x.id === id).connected, id).toBe(true);
  });
});

describe('the phone (under 768 px)', () => {
  it('leaves the band out until its Cloud toggle is on; then lays it out above the plan as a wrapped grid by role', () => {
    const off = lay({ phone: true }).out;
    expect(off.shown.has('ext-cloudflare')).toBe(false);
    expect(laneOf(off, 'Cloud')).toBeUndefined();
    const on = lay({ phone: true, cloud: true }).out;
    const band = laneOf(on, 'Cloud');
    expect(band.x).toBeGreaterThanOrEqual(on.plan.x);
    expect(band.x + band.w).toBeLessThanOrEqual(on.plan.x + on.plan.w);
    expect(band.y + band.h).toBeLessThan(on.plan.y);
    for (const id of ['ext-cloudflare', 'ext-docker-hub', 'ext-isp', 'ext-public-web']) expect(inLane(on.pos.get(id), band), id).toBe(true);
    // the plan keeps the phone's width; the fit reaches up over the band
    expect(on.fit.maxX - on.fit.minX).toBeLessThanOrEqual(on.plan.w + 20);
    expect(on.fit.minY).toBeLessThan(band.y);
  });

  it('draws lines only for a selected node, and ends them on the machine when the software is not shown', () => {
    const none = buildScene(houseState({ house: { ...newHouseState(), floor: 'basement', phone: true, cloud: true } }));
    expect(none.edges.some((e     ) => e.kind === 'calls')).toBe(false);
    const state = houseState({ house: { ...newHouseState(), floor: 'basement', phone: true, cloud: true } });
    state.selectedNode = state.nodes.find((x     ) => x.id === 'ext-docker-hub');
    const scene = buildScene(state);
    const calls = scene.edges.filter((e     ) => e.kind === 'calls');
    expect(calls.map((e     ) => `${e.from}->${e.to}`)).toEqual(['machine-engine-1->ext-docker-hub']);
    expect(state.house.cloudLines.find((l     ) => l.from === 'machine-engine-1' && l.to === 'ext-docker-hub').label).toBe('engine-1 · 2 calls');
  });
});

describe('an outage in the House view', () => {
  function playing(down          , extra         = {}, phone = false) {
    const steps = [{ node: down[0], text: 'It is down.' }];
    const scenario = createPlayer({ id: 'o', title: 'O', steps, down }, { stepMs: 'manual' }).snapshot();
    return houseState({ scenario, ...extra }, phone);
  }

  it('shows the down nodes and what they reach, whatever the Layers say', () => {
    const state = playing(['ext-registrar'], { activeLayers: { app: true, cloud: false, web: false } });
    for (const id of ['ext-registrar', 'ext-cloudflare']) expect(state.house.shown.has(id), id).toBe(true);
    expect(state.house.shown.has('ext-docker-hub')).toBe(false);
  });

  it('lights the containers on the right and the machines on the plan, and colours the rolled-up lines by the hit', () => {
    const state = playing(['ext-cloudflare']);
    const scene = buildScene(state);
    const radius = blastRadius(['ext-cloudflare'], state.nodes, state.edges);
    const node = (id        ) => scene.nodes.find((x     ) => x.id === id);
    // Caddy renews through it; the server resolves through it, and it sits in the basement on the plan
    expect(node('container-caddy').color).toBe(WHEN_STYLES[radius.hits.get('container-caddy').when].color);
    expect(node('machine-server-1').color).toBe(WHEN_STYLES.run.color);
    expect(state.house.roomOf.get('machine-server-1')).toBe('live-room-basement');
    expect(node('ext-cloudflare').labelStrike).toBe(true);
    const caddy = sceneLine(scene, 'container-caddy', 'ext-cloudflare');
    expect(caddy.color).toBe(WHEN_STYLES.renew.color);
    expect(caddy.alpha).toBeGreaterThanOrEqual(0.9);
    expect(caddy.width).toBeGreaterThanOrEqual(2.2);
    // what the outage does not reach stays quiet
    expect(sceneLine(scene, 'container-backend', 'ext-nominatim').alpha).toBeLessThan(0.5);
  });

  it('colours a rolled-up line into a down cloud node as the walk colours the calls it stands for', () => {
    const state = playing(['ext-nominatim']);
    const scene = buildScene(state);
    const line = sceneLine(scene, 'container-backend', 'ext-nominatim');
    expect(line.color).toBe(WHEN_STYLES.run.color);
    expect(line.alpha).toBeGreaterThanOrEqual(0.9);
    expect(line.width).toBeGreaterThanOrEqual(2.2);
    // Docker Hub down: the containers it serves break at the next deploy, amber
    const hub = buildScene(playing(['ext-docker-hub']));
    for (const from of ['container-backend', 'container-nextcloud']) {
      expect(sceneLine(hub, from, 'ext-docker-hub').color, from).toBe(WHEN_STYLES.deploy.color);
      expect(hub.nodes.find((x     ) => x.id === from).color, from).toBe(WHEN_STYLES.deploy.color);
    }
  });

  it('on a phone the band shows during an outage with its toggle off, and only the outage\'s lines draw', () => {
    const state = playing(['ext-cloudflare'], {}, true);
    expect(state.house.shown.has('ext-cloudflare')).toBe(true);
    const scene = buildScene(state);
    const calls = scene.edges.filter((e     ) => e.kind === 'calls');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((e     ) => e.alpha >= 0.9)).toBe(true);
  });
});

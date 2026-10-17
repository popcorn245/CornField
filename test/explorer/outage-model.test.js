/**
 * The blast radius of an outage (spec 0031 section 8, CLOUD-07): from the down cloud nodes, back along the
 * `calls` edges to their users, each hit taking the `when` of its path (a chain breaks no sooner than its latest
 * link; of several paths the strongest wins: run over deploy over renew); a cloud node that uses a down one is hit
 * and passes it on; a hit container hits the apps it serves, a hit service the endpoints that start it; a call the
 * visitor's browser makes says so; nothing reaches personas or rooms. Then the generated "X is down" scenario and
 * the colours an outage puts on a built scene. Pure: the node environment, no DOM.
 */
import { describe, it, expect } from 'vitest';
import { SAMPLE, loadSample } from '../helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  blastRadius, outageFor, outageScenario, outageLayers, paintOutage, OUTAGE_DOWN,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/outage-model.js';
// @ts-expect-error plain JS modules, no declarations
import { WHEN_STYLES, cloudPanelHtml } from '../../explorer/cloud-model.js';
// @ts-expect-error plain JS modules, no declarations
import { buildScene } from '../../explorer/scene.js';
// @ts-expect-error plain JS modules, no declarations
import { createPlayer } from '../../explorer/scenario.js';
// @ts-expect-error plain JS modules, no declarations
import { validateProposal, applyProposal } from '../../core/proposal.js';

const read = (rel        ) => JSON.parse(fs.readFileSync(path.join(SAMPLE, rel), 'utf8'));

const node = (id        , type        , extra         = {}) => ({ id, type, label: id, ...extra });
const cloud = (id        , extra         = {}) => node(id, 'external', { kind: 'cloud', roles: ['runtime'], plan: { tier: 'free' }, breaks: `${id} breaks.`, ...extra });

const nodes = [
  cloud('ext-cloudflare', { label: 'Cloudflare', breaks: 'Now: the tunnel. At the next renewal: no certificate.' }),
  cloud('ext-registrar', { label: 'Domain registrar' }),
  cloud('ext-ghcr', { label: 'ghcr.io', roles: ['software'] }),
  cloud('ext-linuxserver', { label: 'lscr.io', roles: ['software'] }),
  cloud('ext-fonts', { label: 'Google Fonts' }),
  node('ext-public-web', 'external', { kind: 'web', label: 'Public web' }),
  node('container-caddy', 'container', { label: 'caddy', stack: 'devops-stack', service: 'caddy' }),
  node('container-cloudflared', 'container', { label: 'cloudflared', stack: 'tunnel-stack', service: 'cloudflared' }),
  node('container-photos', 'container', { label: 'photos', stack: 'media-stack', service: 'photos' }),
  node('container-api', 'container', { label: 'backend', stack: 'app-stack', service: 'api' }),
  node('stack-devops-stack', 'stack'),
  node('stack-media-stack', 'stack'),
  node('stack-app-stack', 'stack'),
  node('machine-host', 'machine', { label: 'server-1' }),
  node('app-docs', 'app', { label: 'docs.example.test' }),
  node('app-photos', 'app', { label: 'photos.example.test' }),
  node('app-api', 'app', { label: 'api.example.test' }),
  node('app-tasks', 'app', { label: 'tasks.example.test' }),
  node('svc-lib-dns', 'service', { label: 'dns' }),
  node('svc-lib-notify', 'service', { label: 'notify' }),
  node('page-api-dns', 'page', { label: '/api/v1/dns' }),
  node('page-api-unrelated', 'page', { label: '/api/v1/other' }),
  node('persona-adult', 'persona', { label: 'Adult' }),
  node('room-office', 'room', { label: 'Office' }),
];
const calls = (from        , to        , extra         = {}) => ({ from, to, kind: 'calls', ...extra });
const edges = [
  calls('ext-cloudflare', 'ext-registrar', { label: 'delegated from it' }),
  calls('container-caddy', 'ext-cloudflare', { when: 'renew', label: 'DNS-01' }),
  calls('container-cloudflared', 'ext-cloudflare', { label: 'the tunnel' }),
  calls('machine-host', 'ext-cloudflare', { label: 'resolves *.example.test' }),
  calls('container-caddy', 'ext-ghcr', { when: 'deploy', label: 'image' }),
  calls('ext-linuxserver', 'ext-ghcr', { when: 'deploy', label: 'lscr.io is served from ghcr.io' }),
  calls('container-photos', 'ext-linuxserver', { when: 'deploy', label: 'image' }),
  calls('app-tasks', 'ext-fonts', { side: 'browser', label: 'fonts' }),
  calls('container-api', 'ext-fonts', { label: 'a server-side fetch' }),
  calls('svc-lib-dns', 'ext-cloudflare', { label: 'the DNS API' }),
  calls('svc-lib-notify', 'svc-lib-dns', { label: 'imports' }),
  { from: 'page-api-dns', to: 'svc-lib-dns', kind: 'triggers', label: 'POST' },
  { from: 'page-api-unrelated', to: 'svc-lib-notify', kind: 'reads' }, // not a dependency
  { from: 'app-docs', to: 'stack-devops-stack', kind: 'runs-on', mappings: [{ host: 'docs.example.test', upstream: 'file_server', service: 'caddy' }] },
  { from: 'app-photos', to: 'stack-media-stack', kind: 'runs-on', mappings: [{ host: 'photos.example.test', upstream: 'photos:8989', service: 'photos' }] },
  { from: 'app-api', to: 'stack-app-stack', kind: 'runs-on', mappings: [{ host: 'api.example.test', upstream: 'api:3245', service: 'api' }] },
  { from: 'app-tasks', to: 'stack-app-stack', kind: 'runs-on', mappings: [{ host: 'tasks.example.test', upstream: 'tasks:3337', service: 'tasks' }] },
  { from: 'persona-adult', to: 'app-tasks', kind: 'calls' }, // never followed into a persona
  calls('room-office', 'ext-cloudflare'), // nor into a room
  { from: 'store-cloud', to: 'ext-cloudflare' }, // ownership: not a user
];

const whens = (radius     ) => Object.fromEntries([...radius.hits].map(([id, h]     ) => [id, h.when]));

describe('the blast radius', () => {
  it('follows calls back to their users, each taking the edge\'s when (run when absent)', () => {
    const r = blastRadius(['ext-cloudflare'], nodes, edges);
    expect(r.down).toEqual(['ext-cloudflare']);
    expect(whens(r)).toMatchObject({
      'container-cloudflared': 'run', 'machine-host': 'run', 'svc-lib-dns': 'run', 'container-caddy': 'renew',
    });
    expect(r.hits.has('ext-cloudflare')).toBe(false); // a down node is down, not a hit
    expect(r.hits.has('ext-registrar')).toBe(false); // Cloudflare uses the registrar: the registrar is fine
  });

  it('hits the apps a hit container serves (its runs-on mappings), with the same when', () => {
    const r = blastRadius(['ext-cloudflare'], nodes, edges);
    expect(r.hits.get('app-docs')).toMatchObject({ when: 'renew' }); // file_server on caddy
    expect(r.hits.has('app-photos')).toBe(false);
    expect(r.hits.has('app-api')).toBe(false);
  });

  it('hits the services that call a hit service and the endpoints that start it', () => {
    const r = blastRadius(['ext-cloudflare'], nodes, edges);
    expect(r.hits.get('svc-lib-notify')).toMatchObject({ when: 'run' });
    expect(r.hits.get('page-api-dns')).toMatchObject({ when: 'run' });
    expect(r.hits.has('page-api-unrelated')).toBe(false);
  });

  it('never reaches a persona or a room', () => {
    const r = blastRadius(['ext-cloudflare'], nodes, edges);
    expect(r.hits.has('persona-adult')).toBe(false);
    expect(r.hits.has('room-office')).toBe(false);
  });

  it('takes a cloud node that uses a down one down too, transitively, and a chain bites no sooner than its latest link', () => {
    const r = blastRadius(['ext-ghcr'], nodes, edges);
    expect(whens(r)).toEqual({
      'ext-linuxserver': 'deploy', 'container-photos': 'deploy', 'app-photos': 'deploy', 'container-caddy': 'deploy', 'app-docs': 'deploy',
    });
    const reg = blastRadius(['ext-registrar'], nodes, edges);
    expect(reg.hits.get('ext-cloudflare')).toMatchObject({ when: 'run' });
    expect(reg.hits.get('container-cloudflared')).toMatchObject({ when: 'run' });
    expect(reg.hits.get('container-caddy')).toMatchObject({ when: 'renew' }); // renew, not run: the chain's latest link
  });

  it('gives a node hit along several paths the strongest when', () => {
    const r = blastRadius(['ext-cloudflare', 'ext-ghcr'], nodes, edges);
    expect(r.hits.get('container-caddy')).toMatchObject({ when: 'deploy' }); // deploy (ghcr) over renew (cloudflare)
    expect(r.hits.get('app-docs')).toMatchObject({ when: 'deploy' });
    const both = blastRadius(['ext-cloudflare'], nodes, [...edges, calls('container-caddy', 'ext-cloudflare', { label: 'resolvers' })]);
    expect(both.hits.get('container-caddy')).toMatchObject({ when: 'run' });
  });

  it('says when a hit is the visitor\'s browser, and not when the server is hit as well', () => {
    const r = blastRadius(['ext-fonts'], nodes, edges);
    expect(r.hits.get('app-tasks')).toMatchObject({ when: 'run', browser: true });
    expect(r.hits.get('container-api')).toMatchObject({ when: 'run', browser: false });
    expect(r.hits.get('app-api')).toMatchObject({ when: 'run', browser: false }); // through its container: our server
    const mixed = blastRadius(['ext-fonts'], nodes, [...edges, calls('app-tasks', 'ext-fonts', { label: 'server' })]);
    expect(mixed.hits.get('app-tasks')).toMatchObject({ browser: false });
  });

  it('keeps the edges it walked, each with the when of the hit it made, and groups the hits by when', () => {
    const r = blastRadius(['ext-cloudflare'], nodes, edges);
    expect(r.edges.get('container-caddy->ext-cloudflare')).toBe('renew');
    expect(r.edges.get('container-cloudflared->ext-cloudflare')).toBe('run');
    expect(r.edges.get('page-api-dns->svc-lib-dns')).toBe('run');
    expect(r.edges.has('ext-cloudflare->ext-registrar')).toBe(false);
    expect(r.groups.map((g     ) => g.when)).toEqual(['run', 'renew']);
    expect(r.groups[0]).toMatchObject({ title: WHEN_STYLES.run.title, color: WHEN_STYLES.run.color });
    expect(r.groups[1].ids).toEqual(['container-caddy', 'app-docs']); // by type (containers first), then name
  });

  it('ignores a down id the map does not have, and is empty for no down at all', () => {
    expect(blastRadius(['ext-nowhere'], nodes, edges)).toMatchObject({ down: [], groups: [] });
    expect(blastRadius([], nodes, edges).hits.size).toBe(0);
  });

  it('is worked out once per down list and map (outageFor), and null for a scenario that is no outage', () => {
    const scn = { down: ['ext-cloudflare'] };
    const a = outageFor(scn, nodes, edges);
    expect(outageFor({ down: ['ext-cloudflare'] }, nodes, edges)).toBe(a);
    expect(outageFor({ down: ['ext-ghcr'] }, nodes, edges)).not.toBe(a);
    expect(outageFor({ down: [] }, nodes, edges)).toBeNull();
    expect(outageFor(null, nodes, edges)).toBeNull();
  });
});

describe('the generated "X is down" scenario', () => {
  const cf = nodes[0];

  it('takes the node down, opens on it with its breaks line, then one step per hit group', () => {
    const sc = outageScenario(cf, nodes, edges);
    expect(sc).toMatchObject({ id: 'outage-ext-cloudflare', title: 'Cloudflare is down', down: ['ext-cloudflare'] });
    expect(sc.steps[0]).toEqual({ node: 'ext-cloudflare', text: 'Cloudflare is down. Now: the tunnel. At the next renewal: no certificate.' });
    expect(sc.steps).toHaveLength(3);
    const [, now, renew] = sc.steps;
    expect(now.edge).toEqual({ from: 'container-cloudflared', to: 'ext-cloudflare', kind: 'calls' });
    expect(now.text).toMatch(/^Breaks now: /);
    expect(now.text).toContain('cloudflared');
    expect(now.text).toContain('server-1');
    expect(renew.edge).toEqual({ from: 'container-caddy', to: 'ext-cloudflare', kind: 'calls' });
    expect(renew.text).toMatch(/^Breaks at the next certificate renewal: /);
    expect(renew.text).toContain('docs.example.test');
  });

  it('counts what is hit through the direct users, and folds a long list into counts', () => {
    const many = Array.from({ length: 12 }, (_, i) => node(`container-c${i}`, 'container', { label: `c${i}`, stack: 's', service: `c${i}` }));
    const sc = outageScenario(nodes[2], [...nodes, ...many], [...edges, ...many.map((m) => calls(m.id, 'ext-ghcr', { when: 'deploy' }))]);
    const deploy = sc.steps.find((s     ) => /^Breaks at the next deploy/.test(s.text));
    expect(deploy.text).toContain('13 containers');
    expect(deploy.text).not.toContain('c11');
    expect(deploy.text).toContain('the cloud service lscr.io');
    expect(deploy.text).toMatch(/Through them: .*the container photos/);
    expect(deploy.edge).toMatchObject({ to: 'ext-ghcr', kind: 'calls' });
    expect(sc.steps.some((s     ) => /^Breaks now/.test(s.text))).toBe(false);
  });

  it('says so when it is the visitor\'s browser that breaks', () => {
    const sc = outageScenario(nodes[4], nodes, edges);
    expect(sc.steps[1].text).toContain('tasks.example.test (in the visitor\'s browser)');
  });

  it('says nothing breaks for a cloud node nothing uses', () => {
    const lonely = cloud('ext-lonely', { label: 'Lonely', breaks: 'Nothing.' });
    const sc = outageScenario(lonely, [...nodes, lonely], edges);
    expect(sc.steps).toEqual([{ node: 'ext-lonely', text: 'Lonely is down. Nothing. Nothing on the map uses it.' }]);
  });

  it('validates as a proposal scenario against a real map, for every cloud node', () => {
    const topology = read('topology.json');
    const clouds = topology.nodes.filter((n     ) => n.type === 'external' && n.kind === 'cloud');
    expect(clouds.length).toBeGreaterThan(10);
    const scenarios = clouds.map((n     ) => outageScenario(n, topology.nodes, topology.edges));
    const errors = validateProposal(topology, { version: 1, title: 'Outages', summary: 'Every cloud node, down.', scenarios });
    expect(errors).toEqual([]);
  });
});

describe('an outage on a built scene', () => {
  const sceneNode = (id        , extra         = {}) => ({ id, color: '#336699', alpha: 0.07, glow: 0, halo: 'none', connected: false, labelAlpha: 0.07, labelColor: 'rgba(255, 255, 255, 0.3)', labelKeep: false, labelStrike: false, ...extra });
  const sceneEdge = (from        , to        , extra         = {}) => ({ from, to, key: `${from}->${to}|calls`, kind: 'calls', color: '#fbbf24', alpha: 0.04, width: 1.6, glow: 0, glowColor: null, packet: null, ...extra });

  it('draws run red, deploy amber, renew violet, the down node black with a strike, and leaves the rest as it was', () => {
    const r = blastRadius(['ext-cloudflare', 'ext-ghcr'], nodes, edges);
    const scene      = {
      nodes: ['ext-cloudflare', 'container-cloudflared', 'container-caddy', 'app-docs', 'page-api-unrelated'].map((id) => sceneNode(id)),
      edges: [sceneEdge('container-cloudflared', 'ext-cloudflare'), sceneEdge('container-caddy', 'ext-cloudflare'), sceneEdge('container-caddy', 'ext-ghcr'), sceneEdge('page-api-unrelated', 'svc-lib-notify')],
    };
    paintOutage(scene, r);
    const n = (id        ) => scene.nodes.find((x     ) => x.id === id);
    expect(n('container-cloudflared')).toMatchObject({ color: WHEN_STYLES.run.color, connected: true, labelKeep: true });
    expect(n('container-cloudflared').alpha).toBeGreaterThan(0.9); // lit out of the scenario's dimming
    expect(n('container-cloudflared').labelAlpha).toBe(n('container-cloudflared').alpha);
    expect(n('container-caddy')).toMatchObject({ color: WHEN_STYLES.deploy.color });
    expect(n('ext-cloudflare')).toMatchObject({ color: OUTAGE_DOWN.color, labelStrike: true, alpha: 1, labelKeep: true });
    expect(n('page-api-unrelated')).toMatchObject({ color: '#336699', alpha: 0.07 });
    const e = (from        , to        ) => scene.edges.find((x     ) => x.from === from && x.to === to);
    expect(e('container-cloudflared', 'ext-cloudflare')).toMatchObject({ color: WHEN_STYLES.run.color });
    expect(e('container-caddy', 'ext-cloudflare').color).toBe(WHEN_STYLES.renew.color); // the edge's own hit: renew, though caddy is amber
    expect(e('container-caddy', 'ext-cloudflare').alpha).toBeGreaterThanOrEqual(0.9);
    expect(e('container-caddy', 'ext-ghcr').color).toBe(WHEN_STYLES.deploy.color);
    expect(e('page-api-unrelated', 'svc-lib-notify')).toMatchObject({ color: '#fbbf24', alpha: 0.04 });
  });

  it('keeps the current step\'s halo on a down node, and is no change with no radius', () => {
    const scene      = { nodes: [sceneNode('ext-cloudflare', { halo: 'selected' })], edges: [] };
    paintOutage(scene, blastRadius(['ext-cloudflare'], nodes, edges));
    expect(scene.nodes[0].halo).toBe('selected');
    const plain      = { nodes: [sceneNode('x')], edges: [] };
    const copy = JSON.parse(JSON.stringify(plain));
    paintOutage(plain, null);
    expect(plain).toEqual(copy);
  });
});

describe('the outage scenarios of a real map (the sample repo)', () => {
  const topology = loadSample();
  const proposal = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'docs/specs/proposals/0002-checkout.json'), 'utf8'));
  const applied = applyProposal(topology, proposal);
  const byId = (id        ) => proposal.scenarios.find((s     ) => s.id === id);

  it('"Cloudflare is down" lights the tunnel and the server red and Caddy violet', () => {
    const r = blastRadius(byId('cloudflare-down').down, applied.nodes, applied.edges);
    expect(r.hits.get('container-cloudflared')).toMatchObject({ when: 'run' });
    expect(r.hits.get('machine-server-1')).toMatchObject({ when: 'run' });
    expect(r.hits.get('container-caddy')).toMatchObject({ when: 'renew' });
    expect(r.hits.has('ext-registrar')).toBe(false);
    expect(r.hits.has('container-nextcloud')).toBe(false);
  });

  it('"ghcr is down" is amber: nothing running stops, and what calls the image breaks at the next rebuild', () => {
    const r = blastRadius(['ext-ghcr'], applied.nodes, applied.edges);
    expect(r.hits.get('container-homeassistant')).toMatchObject({ when: 'deploy' });
    expect(r.groups.map((g     ) => g.when)).toEqual(['deploy']); // nothing running stops: no red, no violet
    expect(r.hits.get('svc-job-digest')).toMatchObject({ when: 'deploy' });
    expect(r.edges.get('svc-job-digest->container-homeassistant')).toBe('deploy');
    expect(r.hits.has('container-caddy')).toBe(false);
  });

  it('no step text names the down field itself: the scenario\'s down says it', () => {
    for (const s of proposal.scenarios) for (const step of s.steps) expect(step.text).not.toMatch(/ext-[a-z]+ is down|\(down\)|"down"/);
  });
});

describe('an outage scenario through buildScene', () => {
  const placed = nodes.map((n, i) => ({ ...n, x: i * 40, y: (i % 5) * 30, r: 12, color: '#336699' }));
  const state = (scenario     )      => ({
    nodes: placed, edges,
    view: 'orbit', flow: null, rings: { rings: [], clusters: [] },
    camera: { x: 0, y: 0, zoom: 1 }, width: 800, height: 600,
    selectedNode: null, searchQuery: '', isFreeform: false,
    activeLayers: { app: true, page: true, service: true, cloud: true, web: true, container: true, machine: true, stack: true, persona: true, room: true },
    scenario, sceneVersion: 1,
  });
  const snapOf = (sc     ) => { const p = createPlayer(sc, { stepMs: 'manual' }); return p.snapshot(); };
  const sc = (extra         = {}) => ({ id: 'cf', title: 'Cloudflare is down', steps: [{ node: 'ext-cloudflare', text: 'It goes down.' }], ...extra });

  it('lights the blast radius in its colours from the first step, and dims the rest', () => {
    const scene = buildScene(state(snapOf(sc({ down: ['ext-cloudflare'] }))));
    const n = (id        ) => scene.nodes.find((x     ) => x.id === id);
    expect(n('ext-cloudflare')).toMatchObject({ color: OUTAGE_DOWN.color, labelStrike: true, halo: 'selected' });
    expect(n('container-cloudflared')).toMatchObject({ color: WHEN_STYLES.run.color, connected: true });
    expect(n('container-caddy')).toMatchObject({ color: WHEN_STYLES.renew.color, connected: true });
    expect(n('app-docs')).toMatchObject({ color: WHEN_STYLES.renew.color });
    expect(n('page-api-dns')).toMatchObject({ color: WHEN_STYLES.run.color });
    expect(n('app-photos')).toMatchObject({ color: '#336699', connected: false });
    expect(n('persona-adult').connected).toBe(false);
    const e = (from        , to        ) => scene.edges.find((x     ) => x.from === from && x.to === to);
    expect(e('container-caddy', 'ext-cloudflare')).toMatchObject({ color: WHEN_STYLES.renew.color });
    expect(e('container-caddy', 'ext-cloudflare').dash).not.toBeNull(); // still dotted: renew
    expect(e('container-caddy', 'ext-ghcr').alpha).toBeLessThan(0.1); // not on the outage's path
  });

  it('is the plain scenario picture when the scenario takes nothing down', () => {
    const scene = buildScene(state(snapOf(sc())));
    expect(scene.nodes.find((x     ) => x.id === 'container-cloudflared')).toMatchObject({ color: '#336699', connected: false });
    expect(scene.nodes.find((x     ) => x.id === 'ext-cloudflare').labelStrike).toBe(false);
  });

  it('turns on the layers the outage is drawn on', () => {
    const r = blastRadius(['ext-cloudflare'], nodes, edges);
    expect(outageLayers(r, nodes).sort()).toEqual(['app', 'cloud', 'container', 'machine', 'page', 'service']);
    expect(outageLayers(null, nodes)).toEqual([]);
  });
});

describe('the Play button', () => {
  it('is in a cloud node\'s panel, after Used by, and not in the public web\'s', () => {
    const html = cloudPanelHtml(nodes[0], nodes, edges);
    expect(html).toContain('data-action="play-outage"');
    expect(html).toContain('data-id="ext-cloudflare"');
    expect(html).toContain('Play: Cloudflare is down');
    expect(html.indexOf('play-outage')).toBeGreaterThan(html.indexOf('Used by:'));
    expect(cloudPanelHtml(nodes[5], nodes, edges)).not.toContain('play-outage');
  });
});

/**
 * @vitest-environment node
 *
 * The compose deriver (plugins/compose): stacks and containers from the compose files, and the apps the
 * Caddyfiles and Traefik labels route to them, as `runs-on` edges with their mappings.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import compose, { portOf, volumeOf } from '../../plugins/compose/index.js';
import { caddyRoutes, parseCaddyfile, traefikRoutes, labelsOf, ruleHosts, upstreamOf } from '../../plugins/compose/routes.js';
import { deriveTopology } from '../../core/derive.js';
import { planSync } from '../../core/sync.js';
import { loadConfig, loadDerivers } from '../../core/config.js';
import { SAMPLE, loadSample } from '../helpers.js';

const made = [];
/** A repo on disk from { 'path': text } */
function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-compose-'));
  made.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
afterAll(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });

const derive = (root, options = {}, map = null) => deriveTopology({ root, config: { title: 'Home lab' }, derivers: [{ deriver: compose, options }], map });
const rows = (routes) => routes.map((r) => `${r.scheme}://${r.host} -> ${r.upstream} (${r.service})`);

describe('parseCaddyfile', () => {
  it('nests blocks, keeps a placeholder as one word and drops comments', () => {
    const tree = parseCaddyfile('a.example.com {\n  # a comment\n  tls {\n    dns cloudflare {env.CF_API_TOKEN}\n  }\n  reverse_proxy app:80\n}\n');
    expect(tree).toEqual([{ args: ['a.example.com'], block: [
      { args: ['tls'], block: [{ args: ['dns', 'cloudflare', '{env.CF_API_TOKEN}'], block: null }] },
      { args: ['reverse_proxy', 'app:80'], block: null },
    ] }]);
  });
});

describe('caddyRoutes', () => {
  it('routes every host of a site to its proxy, and keeps the scheme of an http:// address', () => {
    expect(rows(caddyRoutes('a.example.com, b.example.com {\n  reverse_proxy app:80\n}\nhttp://c.example.com {\n  reverse_proxy http://other:8080\n}\n'))).toEqual([
      'https://a.example.com -> app:80 (app)', 'https://b.example.com -> app:80 (app)', 'http://c.example.com -> other:8080 (other)',
    ]);
  });

  it('narrows by a host matcher (inline or in a block), and sends the rest to the handle with none', () => {
    const text = [
      'web.example.test, api.example.test, files.example.test {',
      '  @api host api.example.test',
      '  handle @api {',
      '    reverse_proxy api:3245',
      '  }',
      '  @files {',
      '    host files.example.test',
      '  }',
      '  reverse_proxy @files nextcloud:80',
      '  handle {',
      '    reverse_proxy web:3000',
      '  }',
      '}',
    ].join('\n');
    expect(rows(caddyRoutes(text))).toEqual([
      'https://api.example.test -> api:3245 (api)', 'https://files.example.test -> nextcloud:80 (nextcloud)', 'https://web.example.test -> web:3000 (web)',
    ]);
  });

  it('serves a path route on every host of the site, follows snippets, and reads `to` in a proxy block', () => {
    const text = [
      '(proxied) {',
      '  reverse_proxy /api/* api:1',
      '}',
      'a.example.com, b.example.com {',
      '  import proxied',
      '  handle_path /static/* {',
      '    reverse_proxy {',
      '      to files:2 files-b:2',
      '    }',
      '  }',
      '}',
    ].join('\n');
    expect(rows(caddyRoutes(text))).toEqual([
      'https://a.example.com -> api:1 (api)', 'https://b.example.com -> api:1 (api)',
      'https://a.example.com -> files:2 (files)', 'https://a.example.com -> files-b:2 (files-b)',
      'https://b.example.com -> files:2 (files)', 'https://b.example.com -> files-b:2 (files-b)',
    ]);
  });

  it('leaves out a bare port, a wildcard, an address, localhost and a placeholder upstream', () => {
    expect(caddyRoutes(':8080 {\n reverse_proxy a:1\n}\n*.example.com {\n reverse_proxy b:1\n}\n192.168.1.2 {\n reverse_proxy c:1\n}\nlocalhost {\n reverse_proxy d:1\n}\ne.example.com {\n reverse_proxy {env.UPSTREAM}\n}\n')).toEqual([]);
    expect(upstreamOf('{env.X}')).toBeNull();
    expect(upstreamOf('h2c://grpc:50051')).toEqual({ upstream: 'grpc:50051', service: 'grpc' });
  });
});

describe('Traefik labels', () => {
  it('reads the list and the map form of labels, and the hosts of a rule', () => {
    expect(labelsOf(['traefik.enable=true', 'a.b=c=d'])).toEqual({ 'traefik.enable': 'true', 'a.b': 'c=d' });
    expect(labelsOf({ 'traefik.enable': true })).toEqual({ 'traefik.enable': 'true' });
    expect(ruleHosts('Host(`a.example.com`) || Host(`b.example.com`, `c.example.com`) && PathPrefix(`/x`)')).toEqual(['a.example.com', 'b.example.com', 'c.example.com']);
    expect(ruleHosts('HostRegexp(`{sub:[a-z]+}.example.com`)')).toEqual([]);
  });

  it('routes each router host to the service port, the only port, or the container port; https with tls', () => {
    const labels = labelsOf([
      'traefik.http.routers.photos.rule=Host(`photos.example.com`)',
      'traefik.http.routers.photos.tls.certresolver=le',
      'traefik.http.routers.photos.service=photos-svc',
      'traefik.http.services.photos-svc.loadbalancer.server.port=2283',
      'traefik.http.routers.lan.rule=Host(`photos.lan.example.com`)',
    ]);
    expect(rows(traefikRoutes('immich', labels))).toEqual(['https://photos.example.com -> immich:2283 (immich)', 'http://photos.lan.example.com -> immich:2283 (immich)']);
    expect(rows(traefikRoutes('app', { 'traefik.http.routers.r.rule': 'Host(`app.example.com`)', 'traefik.http.routers.r.entrypoints': 'websecure' }, '8080'))).toEqual(['https://app.example.com -> app:8080 (app)']);
    expect(traefikRoutes('off', { 'traefik.enable': 'false', 'traefik.http.routers.r.rule': 'Host(`x.example.com`)' })).toEqual([]);
  });
});

describe('ports and volumes', () => {
  it('keeps published:target and the container path, never a host address or a host folder', () => {
    expect(['8080:80', '127.0.0.1:5432:5432', '[::1]:53:53/udp', 3000, { target: 80, published: 8081, protocol: 'tcp' }, { target: 53, protocol: 'udp' }].map(portOf)).toEqual(['8080:80', '5432:5432', '53:53/udp', '3000', '8081:80', '53/udp']);
    expect(['/home/someone/photos:/photos:ro', 'db-data:/var/lib/postgresql/data', '/scratch', { type: 'bind', source: '/srv/x', target: '/x' }].map(volumeOf)).toEqual(['/photos', '/var/lib/postgresql/data', '/scratch', '/x']);
  });
});

describe('the compose deriver on a repo', () => {
  const root = repo({
    'stacks/media/compose.yml': [
      'services:',
      '  jellyfin:',
      '    image: jellyfin/jellyfin:10',
      '    ports: ["8096:8096"]',
      '    volumes: ["/home/someone/media:/media:ro"]',
      '    environment:',
      '      API_KEY: do-not-read-me',
      '  db:',
      '    image: postgres:16',
      '  photos:',
      '    build: ./photos',
      '    labels:',
      '      - traefik.http.routers.photos.rule=Host(`photos.example.com`)',
      '      - traefik.http.routers.photos.tls=true',
      '      - traefik.http.services.photos.loadbalancer.server.port=2283',
    ].join('\n'),
    // Two files in one folder: docker compose takes compose.yaml first
    'stacks/media/docker-compose.yml': 'services:\n  ignored:\n    image: busybox\n',
    'stacks/edge/compose.yaml': 'name: front-door\nservices:\n  caddy:\n    image: caddy:2\n  db:\n    image: valkey/valkey:8\n',
    'stacks/edge/Caddyfile': 'tv.example.com {\n  reverse_proxy jellyfin:8096\n}\nnas.example.com {\n  reverse_proxy 192.168.1.20:5000\n}\n',
    'stacks/empty/compose.yml': 'volumes:\n  data: {}\n',
  });

  it('makes a stack per file and a container per service, with a stack prefix where a service name repeats', async () => {
    const out = await derive(root);
    expect(out.nodes.filter((n) => n.type !== 'app').map((n) => [n.id, n.type, n.label])).toEqual([
      ['stack-front-door', 'stack', 'front-door'], ['container-caddy', 'container', 'caddy'], ['container-front-door-db', 'container', 'db'],
      ['stack-media', 'stack', 'media'], ['container-jellyfin', 'container', 'jellyfin'], ['container-media-db', 'container', 'db'], ['container-photos', 'container', 'photos'],
    ]);
    expect(out.ownedTypes).toEqual(['stack', 'container']);
    const media = out.nodes.find((n) => n.id === 'stack-media');
    expect(media).toMatchObject({ file: 'stacks/media/compose.yml' });
    expect(media.services).toEqual([
      { name: 'jellyfin', image: 'jellyfin/jellyfin:10', ports: ['8096:8096'], volumes: ['/media'] },
      { name: 'db', image: 'postgres:16', ports: [], volumes: [] },
      { name: 'photos', image: null, ports: [], volumes: [] },
    ]);
    expect(out.nodes.find((n) => n.id === 'container-photos')).toEqual({ id: 'container-photos', label: 'photos', type: 'container', file: 'stacks/media/compose.yml', stack: 'media', service: 'photos', ports: [] });
    expect(JSON.stringify(out)).not.toContain('do-not-read-me');
    expect(JSON.stringify(out)).not.toContain('/home/someone');
    expect(out.warnings).toContain('compose: stacks/empty/compose.yml has no services; it is left out.');
    expect(out.info.compose.stacks.map((s) => [s.id, s.dir])).toEqual([['stack-front-door', 'stacks/edge'], ['stack-media', 'stacks/media']]);
  });

  it('makes an app per routed host with its runs-on edge, and leaves out a route to an address', async () => {
    const out = await derive(root);
    expect(out.nodes.filter((n) => n.type === 'app')).toEqual([
      { id: 'app-photos-example-com', label: 'photos.example.com', type: 'app', url: 'https://photos.example.com', upstreams: ['photos:2283'], stack: 'media', deployed: true },
      { id: 'app-tv-example-com', label: 'tv.example.com', type: 'app', url: 'https://tv.example.com', upstreams: ['jellyfin:8096'], stack: 'media', deployed: true },
    ]);
    expect(out.edges.filter((e) => e.kind === 'runs-on')).toEqual([
      { from: 'app-photos-example-com', to: 'stack-media', kind: 'runs-on', label: 'serves photos.example.com', mappings: [{ host: 'photos.example.com', upstream: 'photos:2283', service: 'photos' }] },
      { from: 'app-tv-example-com', to: 'stack-media', kind: 'runs-on', label: 'serves tv.example.com', mappings: [{ host: 'tv.example.com', upstream: 'jellyfin:8096', service: 'jellyfin' }] },
    ]);
    expect(out.ownedIds).toEqual(['app-photos-example-com', 'app-tv-example-com']);
    expect(out.warnings.join('\n')).toContain('1 routed host(s) go to something that is not a compose service, and are left out: nas.example.com.');
    expect(JSON.stringify(out)).not.toContain('192.168');
  });

  it("takes the committed map's app for a host, and its parent", async () => {
    const map = { nodes: [{ id: 'app-tv', type: 'app', label: 'tv.example.com', url: 'https://tv.example.com' }, { id: 'tool-box', type: 'tool', label: 'box' }], edges: [{ from: 'tool-box', to: 'app-tv' }] };
    const out = await derive(root, {}, map);
    expect(out.nodes.map((n) => n.id)).toContain('app-tv');
    expect(out.edges).toContainEqual({ from: 'tool-box', to: 'app-tv' });
    expect(out.edges.find((e) => e.kind === 'runs-on' && e.from === 'app-tv')).toMatchObject({ to: 'stack-media' });
  });

  it('reads only the files and Caddyfiles the options name', async () => {
    const out = await derive(root, { files: ['stacks/edge/compose.yaml'], caddyfiles: [] });
    expect(out.nodes.map((n) => n.id)).toEqual(['stack-front-door', 'container-caddy', 'container-db']);
    await expect(derive(root, { files: ['nope/compose.yml'] })).rejects.toThrow(/compose file nope\/compose.yml does not exist/);
  });

  it('says which files are one stack, and which YAML is broken', async () => {
    const twin = repo({ 'a/compose.yml': 'name: same\nservices:\n  x:\n    image: a\n', 'b/compose.yml': 'name: same\nservices:\n  y:\n    image: b\n' });
    await expect(derive(twin)).rejects.toThrow(/b\/compose.yml and a\/compose.yml are both stack "same"/);
    const broken = repo({ 'compose.yml': 'services: [\n' });
    await expect(derive(broken)).rejects.toThrow(/compose.yml is not valid YAML/);
  });

  it('names a stack at the root after the config title (as a project name), and finds nothing in a repo with no compose file', async () => {
    const one = repo({ 'compose.yml': 'services:\n  app:\n    image: nginx\n' });
    expect((await derive(one)).nodes[0]).toMatchObject({ id: 'stack-home-lab', label: 'home-lab', file: 'compose.yml' });
    expect(await derive(repo({ 'README.md': 'nothing' }))).toMatchObject({ nodes: [], edges: [] });
  });
});

describe('the sample repo', () => {
  it('gets its stack, its containers and its apps from stacks/app-stack, and its map matches', async () => {
    const config = await loadConfig(SAMPLE, { env: {} });
    const committed = loadSample();
    const derived = await deriveTopology({ root: SAMPLE, config, derivers: await loadDerivers(config), map: committed });
    const fromCompose = derived.nodes.filter((n) => ['stack', 'container', 'app'].includes(n.type)).map((n) => n.id).sort();
    expect(fromCompose).toEqual([
      'app-api', 'app-cloud-example-test', 'app-ha-example-test', 'app-web',
      'container-api', 'container-caddy', 'container-cloudflared', 'container-homeassistant', 'container-nextcloud', 'container-web',
      'stack-app-stack',
    ]);
    // Hand-written edges into the derived nodes stay: the stack's machine, a call into a container, a camera's stream
    const { changes, next } = planSync(committed, derived);
    expect(changes).toEqual([]);
    for (const k of ['stack-app-stack|machine-engine-1|runs-on', 'svc-job-digest|container-homeassistant|calls', 'device-camera-porch_cam|container-homeassistant|delivers']) {
      expect(next.edges.map((e) => `${e.from}|${e.to}|${e.kind}`)).toContain(k);
    }
  });
});

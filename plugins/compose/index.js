/**
 * @module plugins/compose
 *
 * The compose deriver: the Software band of a self-hosted repo with zero plugin code. It reads the
 * repo's Docker compose files and the routes in front of them.
 *
 *  - **Stacks.** Every `compose.yaml`, `compose.yml`, `docker-compose.yaml` or `docker-compose.yml` (the
 *    first of them in a folder, as `docker compose` picks it), or the files `options.files` names. A stack
 *    is named by the file's top-level `name`, else its folder (as `docker compose` names a project; a file at
 *    the root, after the config's title).
 *  - **Containers.** One per service: its image (as written; none for a service that only builds), its
 *    ports (without a host address) and the container paths of its volumes. Environment values are
 *    never read.
 *  - **Routes.** The hosts each Caddyfile (every `Caddyfile` or `*.caddyfile` in the repo, or
 *    `options.caddyfiles`) and each service's Traefik labels send to a service of a stack: an app node per
 *    host (the committed map's app for that host when there is one, else `app-<host>`), and a `runs-on`
 *    edge app → stack whose `mappings` are the host → upstream → service rows. A route to anything that is
 *    not a compose service is left out, with a warning, so no address reaches the map.
 *
 * What it makes:
 *
 *   stack-<name>              a stack: label its name, file the compose file, services [{ name, image, ports, volumes }]
 *   container-<service>       a container (container-<stack>-<service> when two stacks share a service name)
 *   app-<host>                an app per routed host: url, upstreams, stack, deployed (only `ownedIds`: an app
 *                             nobody routes to stays as written)
 *
 * It runs before `cloud`, which reads the containers' images. `info.compose.stacks` lists each stack's id,
 * name, folder and file, for a deriver that places stacks on machines.
 *
 * Needs the optional dependency js-yaml: without it, a repo with compose files fails `sync` with a clear
 * message rather than losing its stacks.
 *
 * Options: `{ files?: string[], caddyfiles?: string[], parent?: string }` (`parent`: the node stacks and new
 * apps hang from, default `root`).
 */

import { caddyRoutes, labelsOf, traefikRoutes } from './routes.js';

export const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const CADDYFILE = /(?:^|\/)(?:Caddyfile|[\w.-]+\.caddyfile)$/i;

/** js-yaml when it is installed (an optional dependency), else null */
async function loadYaml() {
  try {
    const mod = await import('js-yaml');
    return mod.default || mod;
  } catch {
    return null;
  }
}

/** A name as an id part: lower-case words joined by dashes */
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
const dirOf = (file) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');

/** A compose port → "published:target[/protocol]" or "target", never the host address it binds to */
export function portOf(p) {
  if (typeof p === 'number') return String(p);
  if (typeof p === 'string') {
    // [::1]:8080:80, 127.0.0.1:8080:80 → 8080:80
    const s = p.trim().replace(/^\[[^\]]*\]:/, '');
    const parts = s.split(':');
    return parts.length === 3 ? parts.slice(1).join(':') : s;
  }
  if (p && typeof p === 'object' && p.target !== undefined) {
    const proto = p.protocol && p.protocol !== 'tcp' ? `/${p.protocol}` : '';
    return p.published !== undefined && p.published !== '' ? `${p.published}:${p.target}${proto}` : `${p.target}${proto}`;
  }
  return null;
}

/** A compose volume → the path inside the container (the host side can name a person's home folder) */
export function volumeOf(v) {
  if (typeof v === 'string') {
    const parts = v.split(':');
    return parts.length === 1 ? parts[0] : parts[1];
  }
  if (v && typeof v === 'object' && typeof v.target === 'string') return v.target;
  return null;
}

/** The container port a port entry exposes (its target), for a Traefik router that names none */
const targetPort = (p) => {
  const s = portOf(p);
  return s ? s.split(':').pop().replace(/\/.*$/, '') : null;
};

/** The compose files: the config's, else the first compose name in each folder */
function composeFiles(ctx, options) {
  if (Array.isArray(options.files)) {
    for (const f of options.files) if (!ctx.exists(f)) throw new Error(`compose file ${f} does not exist.`);
    return [...options.files];
  }
  const found = ctx.walk('', (f) => COMPOSE_NAMES.includes(f.slice(f.lastIndexOf('/') + 1)));
  const byDir = new Map();
  for (const f of found) {
    const d = dirOf(f);
    const rank = COMPOSE_NAMES.indexOf(f.slice(f.lastIndexOf('/') + 1));
    if (!byDir.has(d) || rank < COMPOSE_NAMES.indexOf(byDir.get(d).slice(byDir.get(d).lastIndexOf('/') + 1))) byDir.set(d, f);
  }
  return [...byDir.values()].sort();
}

const compose = {
  name: 'compose',
  contract: 1,
  owns: ['stack', 'container'],

  async derive(ctx) {
    const options = ctx.options || {};
    const parent = options.parent || 'root';
    const files = composeFiles(ctx, options);
    const warnings = [];
    if (!files.length) return { nodes: [], edges: [], warnings, info: { stacks: [] } };
    const yaml = await loadYaml();
    if (!yaml) throw new Error(`${files.length} compose file(s) and no YAML reader: install the optional dependency js-yaml (npm install js-yaml).`);

    // 1. The stacks and their services
    const stacks = [];
    for (const file of files) {
      let doc;
      try { doc = yaml.load(ctx.read(file)); } catch (err) { throw new Error(`${file} is not valid YAML: ${err.message}`); }
      if (!doc || typeof doc !== 'object' || !doc.services || typeof doc.services !== 'object' || Array.isArray(doc.services)) {
        warnings.push(`compose: ${file} has no services; it is left out.`);
        continue;
      }
      const dir = dirOf(file);
      const name = typeof doc.name === 'string' && doc.name ? doc.name : dir ? dir.slice(dir.lastIndexOf('/') + 1) : slug(ctx.config?.title || 'stack');
      const id = `stack-${slug(name)}`;
      if (stacks.some((s) => s.id === id)) throw new Error(`${file} and ${stacks.find((s) => s.id === id).file} are both stack "${name}": give one a top-level name.`);
      const services = Object.entries(doc.services).map(([svc, def]) => {
        const d = def && typeof def === 'object' ? def : {};
        const labels = { ...labelsOf(d.labels), ...labelsOf(d.deploy && d.deploy.labels) };
        return {
          name: svc,
          image: typeof d.image === 'string' && d.image ? d.image : null,
          ports: (Array.isArray(d.ports) ? d.ports : []).map(portOf).filter(Boolean),
          volumes: (Array.isArray(d.volumes) ? d.volumes : []).map(volumeOf).filter(Boolean),
          containerName: typeof d.container_name === 'string' ? d.container_name : null,
          firstPort: [...(Array.isArray(d.expose) ? d.expose : []), ...(Array.isArray(d.ports) ? d.ports : [])].map(targetPort).find(Boolean) || null,
          labels,
        };
      });
      stacks.push({ id, name, dir, file, services });
    }

    // Container ids: the service name, with the stack's where two stacks share one
    const count = new Map();
    for (const s of stacks) for (const svc of s.services) count.set(svc.name, (count.get(svc.name) || 0) + 1);
    const containerId = (s, svc) => `container-${count.get(svc.name) > 1 ? `${slug(s.name)}-` : ''}${slug(svc.name)}`;

    const nodes = [];
    const edges = [];
    for (const s of stacks) {
      nodes.push({ id: s.id, label: s.name, type: 'stack', file: s.file, services: s.services.map((x) => ({ name: x.name, image: x.image, ports: x.ports, volumes: x.volumes })) });
      edges.push({ from: parent, to: s.id });
      for (const svc of s.services) {
        nodes.push({ id: containerId(s, svc), label: svc.name, type: 'container', file: s.file, stack: s.name, service: svc.name, ...(svc.image ? { image: svc.image } : {}), ports: svc.ports });
        edges.push({ from: s.id, to: containerId(s, svc) });
      }
    }

    // 2. The routes: Traefik labels (in their own stack), then the Caddyfiles (a service of the stack in the Caddyfile's folder first)
    const routes = [];
    for (const s of stacks) {
      for (const svc of s.services) {
        for (const r of traefikRoutes(svc.name, svc.labels, svc.firstPort)) routes.push({ ...r, stack: s, from: s.file });
      }
    }
    const caddyfiles = Array.isArray(options.caddyfiles) ? options.caddyfiles : ctx.walk('', (f) => CADDYFILE.test(f));
    const outside = new Set();
    for (const file of caddyfiles) {
      if (!ctx.exists(file)) { warnings.push(`compose: caddyfile ${file} does not exist.`); continue; }
      const here = dirOf(file);
      for (const r of caddyRoutes(ctx.read(file))) {
        const serving = stacks.filter((s) => s.services.some((x) => x.name === r.service || x.containerName === r.service));
        const stack = serving.find((s) => s.dir === here) || (serving.length === 1 ? serving[0] : null);
        if (!stack) {
          if (serving.length > 1) warnings.push(`compose: ${file} sends ${r.host} to "${r.service}", a service of ${serving.map((s) => s.name).join(' and ')}; it is left out.`);
          else outside.add(r.host);
          continue;
        }
        const svc = stack.services.find((x) => x.name === r.service) || stack.services.find((x) => x.containerName === r.service);
        routes.push({ ...r, service: svc.name, stack, from: file });
      }
    }
    if (outside.size) warnings.push(`compose: ${outside.size} routed host(s) go to something that is not a compose service, and are left out: ${[...outside].sort().join(', ')}.`);

    // 3. An app per host, and its runs-on edge to each stack that serves it
    const committed = (ctx.map && ctx.map.nodes) || [];
    const hostOf = (n) => {
      try { return n.url ? new URL(n.url).hostname.toLowerCase() : null; } catch { return null; }
    };
    const appFor = (host, list) => list.find((n) => n.type === 'app' && (hostOf(n) === host || String(n.label || '').toLowerCase() === host));
    const parentOf = (id) => ((ctx.map && ctx.map.edges) || []).find((e) => e.to === id && !e.kind && !e.dashed)?.from;
    const byHost = new Map();
    for (const r of routes) {
      if (!byHost.has(r.host)) byHost.set(r.host, []);
      byHost.get(r.host).push(r);
    }
    const ownedIds = [];
    const taken = new Set(nodes.map((n) => n.id));
    for (const [host, rs] of byHost) {
      const made = appFor(host, ctx.nodes || []);
      const id = made ? made.id : appFor(host, committed)?.id || `app-${slug(host)}`;
      if (!made) {
        if (taken.has(id)) throw new Error(`two routed hosts make app "${id}": ${host} is one of them.`);
        taken.add(id);
        nodes.push({ id, label: host, type: 'app', url: `${rs[0].scheme}://${host}`, upstreams: [...new Set(rs.map((r) => r.upstream))], stack: rs[0].stack.name, deployed: true });
        edges.push({ from: parentOf(id) || parent, to: id });
        ownedIds.push(id);
      }
      for (const s of [...new Set(rs.map((r) => r.stack))]) {
        const mine = rs.filter((r) => r.stack === s);
        edges.push({ from: id, to: s.id, kind: 'runs-on', label: `serves ${host}`, mappings: mine.map((r) => ({ host, upstream: r.upstream, service: r.service })) });
      }
    }

    return {
      nodes, edges, warnings, ownedIds,
      info: { stacks: stacks.map((s) => ({ id: s.id, name: s.name, dir: s.dir, file: s.file, containers: s.services.map((x) => containerId(s, x)) })) },
    };
  },
};

export default compose;

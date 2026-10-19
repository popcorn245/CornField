/**
 * @module plugins/compose/routes
 *
 * The routes in front of the containers (the compose deriver's `runs-on` detector): which host a
 * Caddyfile or a container's Traefik labels send to which upstream (`web.example.test → web:3000`).
 *
 *  - **Caddy.** Each site block's addresses, and every `reverse_proxy` in it: at the top of the site, in a
 *    `handle`, `handle_path` or `route`, behind a named `@matcher` with a `host` matcher (inline or in a
 *    block) or a path matcher, and inside snippets the site `import`s. A host matcher narrows the hosts a
 *    proxy serves; a proxy with no matcher (or in a `handle` with none) serves the site's other hosts.
 *  - **Traefik.** `traefik.http.routers.<r>.rule` labels with `Host(...)`, and the port of the router's
 *    service (`traefik.http.services.<s>.loadbalancer.server.port`), else the container's first port.
 *
 * What never comes out: an upstream that is a placeholder (`{env.X}`), a wildcard or a bare port as a host.
 * Pure: text in, routes out.
 */

/** Words of a Caddyfile, line by line: quotes kept together, `#` comments dropped, `{` and `}` as their own words */
function caddyLines(text) {
  const lines = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const words = [];
    let word = '';
    let quote = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (quote) {
        if (c === '"') quote = false; else word += c;
        continue;
      }
      if (c === '"') { quote = true; continue; }
      if (c === '#' && !word) break;
      if (/\s/.test(c)) { if (word) words.push(word); word = ''; continue; }
      word += c;
    }
    if (word) words.push(word);
    if (words.length) lines.push(words);
  }
  return lines;
}

/**
 * A Caddyfile as a tree: `[{ args, block }]`, `block` the directives inside `{ … }` or null. A `{` or `}` is
 * structural only as a word of its own (a placeholder like `{env.X}` is one word).
 */
export function parseCaddyfile(text) {
  const root = [];
  const stack = [root];
  for (const words of caddyLines(text)) {
    let args = [];
    const flush = (block) => {
      if (args.length || block) stack[stack.length - 1].push({ args, block });
      args = [];
    };
    for (const w of words) {
      if (w === '{') {
        const block = [];
        flush(block);
        stack.push(block);
      } else if (w === '}') {
        flush(null);
        if (stack.length > 1) stack.pop();
      } else args.push(w);
    }
    flush(null);
  }
  return root;
}

const HOSTNAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/** A site address → `{ host, scheme }`, or null for a bare port, a wildcard, an IP address or localhost */
function siteAddress(address) {
  const a = address.replace(/,$/, '');
  const scheme = a.startsWith('http://') ? 'http' : 'https';
  const host = a.replace(/^[a-z0-9+]+:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '').toLowerCase();
  if (!HOSTNAME.test(host) || /^\d+(?:\.\d+){3}$/.test(host)) return null;
  return { host, scheme };
}

/** An upstream (`web:3000`, `http://web:3000`, `h2c://web`) → `{ upstream, service }`, or null for a placeholder */
export function upstreamOf(word) {
  if (!word || word.includes('{') || word.startsWith('@') || word.startsWith('/')) return null;
  const bare = word.replace(/^[a-z0-9+]+:\/\//i, '').replace(/\/.*$/, '');
  const service = bare.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!service || !/^[\w.-]+$/.test(service)) return null;
  return { upstream: bare, service };
}

/**
 * Every host → upstream a Caddyfile routes, in order, once each.
 * @param {string} text
 * @returns {{ host: string, scheme: 'http' | 'https', upstream: string, service: string }[]}
 */
export function caddyRoutes(text) {
  const tree = parseCaddyfile(text);
  const snippets = new Map();
  for (const d of tree) {
    const m = d.block && d.args.length === 1 && /^\((.+)\)$/.exec(d.args[0]);
    if (m) snippets.set(m[1], d.block);
  }
  /** The directives of a block with its `import <snippet>` lines put in (one level, no arguments) */
  const expand = (block, depth = 0) => block.flatMap((d) => (d.args[0] === 'import' && snippets.has(d.args[1]) && depth < 5 ? expand(snippets.get(d.args[1]), depth + 1) : [d]));

  const out = [];
  const seen = new Set();
  const push = (host, scheme, up) => {
    const k = `${host}|${up.upstream}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ host, scheme, ...up });
  };

  for (const site of tree) {
    if (!site.block || !site.args.length || /^&?\(/.test(site.args[0])) continue;
    const addresses = site.args.flatMap((a) => a.split(',')).filter(Boolean).map(siteAddress).filter(Boolean);
    if (!addresses.length) continue;
    const schemeOf = new Map(addresses.map((a) => [a.host, a.scheme]));
    const siteHosts = addresses.map((a) => a.host);
    const body = expand(site.block);
    // Named matchers: @name host a b, or @name { host a b }; null when it matches by something else
    const matchers = new Map();
    for (const d of body) {
      if (!d.args[0] || !d.args[0].startsWith('@')) continue;
      const inline = d.args[1] === 'host' ? d.args.slice(2) : null;
      const nested = d.block ? d.block.filter((x) => x.args[0] === 'host').flatMap((x) => x.args.slice(1)) : [];
      const hosts = [...(inline || []), ...nested].map((h) => h.toLowerCase()).filter((h) => HOSTNAME.test(h));
      matchers.set(d.args[0], hosts.length ? hosts : null);
    }
    /** The hosts a matcher word narrows to: a list for a host matcher, null for any other (or none) */
    const narrow = (word) => (word && word.startsWith('@') ? matchers.get(word) ?? null : null);
    const isMatcher = (word) => !!word && (word.startsWith('@') || word.startsWith('/') || word === '*');

    /**
     * [{ hosts | null, catchAll, ups }]. `path` is true inside a block a path matcher guards: a proxy there
     * serves every host of the site; a proxy with no matcher anywhere above it serves the hosts nothing else names.
     */
    const routes = [];
    const visit = (block, hosts, path) => {
      for (const d of expand(block)) {
        const [name, first] = d.args;
        const matched = isMatcher(first);
        const own = matched ? narrow(first) : null;
        if (name === 'reverse_proxy') {
          const words = [...d.args.slice(matched ? 2 : 1), ...(d.block || []).filter((x) => x.args[0] === 'to').flatMap((x) => x.args.slice(1))];
          const ups = words.map(upstreamOf).filter(Boolean);
          if (ups.length) routes.push({ hosts: own || hosts, catchAll: !own && !hosts && !path && !matched, ups });
        } else if (['handle', 'handle_path', 'route'].includes(name) && d.block) {
          visit(d.block, own || hosts, path || (matched && !own));
        }
      }
    };
    visit(body, null, false);

    const explicit = new Set(routes.filter((r) => r.hosts).flatMap((r) => r.hosts));
    for (const r of routes) {
      const hosts = r.hosts ? r.hosts : r.catchAll ? siteHosts.filter((h) => !explicit.has(h)) : siteHosts;
      for (const host of hosts) for (const up of r.ups) push(host, schemeOf.get(host) || 'https', up);
    }
  }
  return out;
}

/** A service's labels as `{ key: value }`, from the map form or the `key=value` list form */
export function labelsOf(labels) {
  if (Array.isArray(labels)) {
    return Object.fromEntries(labels.filter((l) => typeof l === 'string').map((l) => {
      const at = l.indexOf('=');
      return at < 0 ? [l, ''] : [l.slice(0, at), l.slice(at + 1)];
    }));
  }
  if (labels && typeof labels === 'object') return Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, v == null ? '' : String(v)]));
  return {};
}

/** The hosts a Traefik rule names: every `Host(...)` (one or more quoted names each), never a `HostRegexp` */
export function ruleHosts(rule) {
  const out = [];
  for (const m of String(rule || '').matchAll(/(?<![\w])Host\(([^)]*)\)/g)) {
    for (const [, h] of m[1].matchAll(/[`"']([^`"']+)[`"']/g)) {
      const host = h.toLowerCase();
      if (HOSTNAME.test(host) && !out.includes(host)) out.push(host);
    }
  }
  return out;
}

/**
 * The routes a compose service's Traefik labels make.
 * @param {string} service the compose service name
 * @param {Record<string, string>} labels `labelsOf(service.labels)`
 * @param {string | null} [fallbackPort] the container's first port, for a router whose service names none
 * @returns {{ host: string, scheme: 'http' | 'https', upstream: string, service: string }[]}
 */
export function traefikRoutes(service, labels, fallbackPort = null) {
  if (String(labels['traefik.enable'] ?? '').toLowerCase() === 'false') return [];
  const servicePorts = new Map();
  for (const [k, v] of Object.entries(labels)) {
    const m = /^traefik\.http\.services\.([^.]+)\.loadbalancer\.server\.port$/.exec(k);
    if (m && /^\d+$/.test(v.trim())) servicePorts.set(m[1], v.trim());
  }
  const out = [];
  for (const [k, rule] of Object.entries(labels)) {
    const m = /^traefik\.http\.routers\.([^.]+)\.rule$/.exec(k);
    if (!m) continue;
    const r = m[1];
    const named = labels[`traefik.http.routers.${r}.service`];
    const port = (named && servicePorts.get(named)) || (servicePorts.size === 1 ? [...servicePorts.values()][0] : null) || fallbackPort;
    const tls = ['tls', 'tls.certresolver'].some((s) => labels[`traefik.http.routers.${r}.${s}`] !== undefined && labels[`traefik.http.routers.${r}.${s}`] !== 'false')
      || /secure|https|443/i.test(labels[`traefik.http.routers.${r}.entrypoints`] || '');
    for (const host of ruleHosts(rule)) out.push({ host, scheme: tls ? 'https' : 'http', upstream: port ? `${service}:${port}` : service, service });
  }
  return out;
}

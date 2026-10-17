/**
 * @module plugins/cloud/sources
 *
 * Where software comes from, read from the files that pull it (the software detectors of the cloud
 * deriver): image references (`{ registry }`), Dockerfiles (`FROM` and the package installs of each
 * `RUN`), a Caddyfile (DNS-01 providers, resolvers, the ACME CA), a self-hosted runner's label map,
 * and CI workflows (job images, `uses:` actions, downloads, installs, `docker run` images).
 *
 * What never comes out: an env var value, an image tag or digest, an action's ref, a URL path.
 * Pure: text in, evidence out. The YAML parser is handed in (js-yaml, an optional dependency).
 */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;


/** `${NAME:-default}` → default; any other interpolation → null */
function interpolated(text) {
  if (!text.includes('$')) return text;
  const out = text.replace(/\$\{\w+(?::?-([^}]*))?\}/g, (_, d) => (d === undefined || d === '' ? '\u0000' : d));
  return out.includes('\u0000') || out.includes('$') ? null : out;
}

/**
 * An image reference → `{ registry, name }`: the registry as a prefix ending in `/` (`docker.io/` when the
 * reference names none), the name without its tag or digest (and without `docker.io/` or `library/`).
 * Null when the registry is a variable with no default.
 * @param {string} ref
 */
export function imageRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  let text = ref.trim().replace(/@sha256:[0-9a-f]+$/i, '');
  const slash = text.indexOf('/');
  const first = slash < 0 ? '' : text.slice(0, slash);
  if (first.includes('$')) {
    const resolved = interpolated(first);
    if (resolved === null) return null;
    text = `${resolved}${text.slice(slash)}`;
  }
  // The tag is what follows the last colon after the last slash
  const lastSlash = text.lastIndexOf('/');
  const colon = text.indexOf(':', lastSlash + 1);
  if (colon >= 0) text = text.slice(0, colon);
  const head = text.includes('/') ? text.slice(0, text.indexOf('/')) : '';
  const isRegistry = head && (head.includes('.') || head.includes(':') || head === 'localhost');
  if (!isRegistry || head === 'docker.io' || head === 'index.docker.io') {
    const name = (isRegistry ? text.slice(head.length + 1) : text).replace(/^library\//, '');
    return { registry: 'docker.io/', name };
  }
  return { registry: `${head}/`, name: text };
}

/** Shell text with comment lines dropped and backslash continuations joined */
const shellText = (text) => text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').replace(/\\\n/g, ' ');

/** @type {[RegExp, string, (m: RegExpMatchArray) => string][]} each install command: its pattern, its package manager, the words a label says */
const INSTALLS = [
  [/\bnpm\s+(ci|install|i)\b/g, 'npm', (m) => `npm ${m[1] === 'i' ? 'install' : m[1]}`],
  [/\b(yarn|pnpm)\s+(install|add)\b/g, 'npm', (m) => `${m[1]} ${m[2]}`],
  [/\b(?:pip3?|python3?\s+-m\s+pip)\s+install\b/g, 'pypi', () => 'pip install'],
  [/\bapk\s+add\b/g, 'apk', () => 'apk add'],
  [/\bapt(?:-get)?\s+install\b/g, 'apt', (m) => m[0].replace(/\s+/g, ' ')]
];

/** The package installs in a script, in order, each with where it starts */
function installsAt(text) {
  const out = [];
  for (const [re, packages, words] of INSTALLS) for (const m of text.matchAll(re)) out.push({ packages, words: words(m), index: m.index });
  return out.sort((a, b) => a.index - b.index);
}

/**
 * The package managers a script installs from: `{ packages, words }` in order (`apt` has no registry
 * entry today, so a Dockerfile that starts using it fails `validate` until one is added).
 * @param {string} text
 */
export function installsIn(text) {
  return installsAt(text).map(({ packages, words }) => ({ packages, words }));
}

/**
 * What a Dockerfile pulls: each `FROM` image (not a stage named earlier, not `scratch`), and the installs of its RUNs.
 * @param {string} text
 * @returns {{ froms: string[], installs: { packages: string, words: string }[] }}
 */
export function dockerfileSources(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\\\n/g, ' ').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const stages = new Set();
  const froms = [];
  const runs = [];
  for (const line of lines) {
    const from = line.match(/^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) {
      const image = from[1];
      if (image !== 'scratch' && !stages.has(image.toLowerCase()) && !froms.includes(image)) froms.push(image);
      if (from[2]) stages.add(from[2].toLowerCase());
      continue;
    }
    const run = line.match(/^RUN\s+(.*)$/i);
    if (run) runs.push(run[1]);
  }
  return { froms, installs: installsIn(runs.join('\n')) };
}

/** The bare hosts of the https URLs in a text, in order, without a variable or a port */
export function httpsHosts(text) {
  const out = [];
  for (const [, host] of text.matchAll(/https:\/\/([^\s"'`/?#)]+)/g)) {
    const bare = host.replace(/:\d+$/, '').toLowerCase();
    if (/[${}]/.test(bare) || !bare.includes('.') || out.includes(bare)) continue;
    out.push(bare);
  }
  return out;
}

/**
 * The Caddyfile's evidence: each DNS-01 provider (`dns <provider>` in a tls block, or the global
 * `acme_dns`) with how many sites use it, the resolvers those blocks name, and the ACME CA every site with
 * automatic HTTPS gets its certificate from (`acme` for Caddy's default, or the `acme_ca` host). A site
 * with `tls internal`, its own certificate files, `http://` or only a port gets no certificate from anyone.
 * @param {string} text
 * @returns {{ match: { kind: string, value: string }, label: string }[]}
 */
export function caddyEvidence(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/(^|\s)#.*$/, '').replace(/\s+$/, ''));
  const global = { acmeCa: null, acmeDns: null, local: false };
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = line === '{' ? '' : line.match(/^([^\s{}][^{]*?)\s*\{$/)?.[1];
    if (head === undefined) continue;
    let depth = 1;
    const body = [];
    let j = i + 1;
    for (; j < lines.length && depth; j++) {
      depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
      if (depth) body.push(lines[j].trim());
    }
    i = j - 1;
    if (head === '') {
      for (const l of body) {
        const ca = l.match(/^acme_ca\s+(\S+)/);
        if (ca) global.acmeCa = httpsHosts(ca[1])[0] || null;
        const dns = l.match(/^acme_dns\s+(\S+)/);
        if (dns) global.acmeDns = dns[1];
        if (/^local_certs\b/.test(l)) global.local = true;
      }
      continue;
    }
    if (head.startsWith('(')) continue; // a snippet
    const tls = body.map((l) => l.match(/^tls(?:\s+([^{]*?))?\s*\{?$/)).find(Boolean);
    const args = tls?.[1] ? tls[1].split(/\s+/).filter(Boolean) : [];
    const own = args[0] === 'internal' || args.length >= 2 || body.some((l) => /^issuer\s+internal\b/.test(l));
    const addresses = head.split(/[\s,]+/).filter((a) => a && !a.startsWith('http://')).map((a) => a.replace(/^https:\/\//, '').replace(/:\d+$/, '').replace(/\/.*$/, ''));
    const names = addresses.filter((a) => /[a-z]/i.test(a) && a.includes('.') && a !== 'localhost');
    const dns = body.map((l) => l.match(/^dns\s+(\S+)/)?.[1]).find(Boolean) || null;
    const resolvers = body.flatMap((l) => l.match(/^resolvers\s+(.+)$/)?.[1].split(/\s+/) || []);
    const ca = body.map((l) => l.match(/^ca\s+(\S+)/)?.[1]).find(Boolean);
    sites.push({ names, own, dns, resolvers, ca: ca ? httpsHosts(ca)[0] || null : null });
  }
  const auto = global.local ? [] : sites.filter((s) => !s.own && s.names.length);
  const out = [];
  const providers = new Map();
  const resolvers = [];
  for (const s of auto) {
    const p = s.dns || global.acmeDns;
    if (!p) continue;
    providers.set(p, (providers.get(p) || 0) + s.names.length);
    for (const r of s.resolvers) if (!resolvers.includes(r)) resolvers.push(r);
  }
  for (const [p, n] of providers) out.push({ match: { kind: 'caddy', value: `dns ${p}` }, label: `DNS-01 challenges for ${plural(n, 'site')}` });
  for (const r of resolvers) out.push({ match: { kind: 'host', value: r }, label: 'public resolvers for the DNS-01 check' });
  const byCa = new Map();
  for (const s of auto) {
    const key = s.ca || global.acmeCa || '';
    byCa.set(key, (byCa.get(key) || 0) + s.names.length);
  }
  for (const [ca, n] of byCa) out.push({ match: ca ? { kind: 'host', value: ca } : { kind: 'caddy', value: 'acme' }, label: `ACME certificates for ${plural(n, 'https site')}` });
  return out;
}

/**
 * The label map the runner registers with (`--labels "name:docker://image,name:host"`): label → image, or null for `host`.
 * @param {string} text the runner's entrypoint or command
 * @returns {Map<string, string | null>}
 */
export function runnerLabels(text) {
  const m = text.match(/--labels[\s=]+\\*["']?([^"'\s\\]+)/);
  const out = new Map();
  for (const entry of m ? m[1].split(',') : []) {
    const [name, ...rest] = entry.split(':');
    const target = rest.join(':');
    out.set(name, target.startsWith('docker://') ? target.slice('docker://'.length) : null);
  }
  return out;
}

/** Split a shell command into words, keeping quoted runs together and dropping the quotes */
function words(text) {
  const out = [];
  for (const m of text.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)) out.push(m[0].replace(/^["']|["']$/g, ''));
  return out;
}
/** docker run flags that take no value */
const RUN_SWITCHES = new Set(['--rm', '-d', '--detach', '-i', '-t', '-it', '-ti', '--interactive', '--tty', '--init', '--privileged']);

/** The image each `docker run` in a script starts, with where it starts */
function dockerRunImages(text, env) {
  const out = [];
  for (const m of text.matchAll(/\bdocker\s+run\s+([^\n;&|]*)/g)) {
    const w = words(m[1]);
    let image = null;
    for (let k = 0; k < w.length; k++) {
      const t = w[k];
      if (RUN_SWITCHES.has(t) || (t.startsWith('--') && t.includes('='))) continue;
      if (t.startsWith('-')) { k++; continue; }
      image = t;
      break;
    }
    if (!image) continue;
    const v = image.match(/^\$\{?(\w+)\}?$/);
    if (v) image = typeof env[v[1]] === 'string' ? env[v[1]] : null;
    if (image) out.push({ image, index: m.index });
  }
  return out;
}

/**
 * One workflow's evidence, in order: each job's image (its `runs-on` label through the runner's map, its
 * `container:` and `services:`), each step's `uses:` (an action's owner/repo, an action from a URL's host, a
 * `docker://` image), and in each `run:` the https hosts it downloads from, its installs and its `docker run` images.
 * @param {string} text
 * @param {{ labels?: Map<string, string | null> | null, file: string, ownHost?: (host: string) => boolean, yaml: { load: (text: string) => any } }} opts
 *   `labels`: a self-hosted runner's label map (null: a hosted runner, whose labels name no image); `yaml` the parser (js-yaml)
 * @returns {{ match: { kind: string, value: string }, label: string }[]}
 */
export function workflowSources(text, { labels = null, file, ownHost: own = () => false, yaml }) {
  let doc;
  try {
    doc = yaml.load(text);
  } catch (err) {
    throw new Error(`${file} is not valid YAML: ${err.message}`);
  }
  const base = String(file).split("/").pop();
  const out = [];
  const seen = new Set();
  const push = (kind, value, label) => {
    const k = `${kind}|${value}|${label}`;
    if (!seen.has(k)) { seen.add(k); out.push({ match: { kind, value }, label }); }
  };
  const image = (ref, label) => {
    const r = imageRef(ref);
    if (r) push('registry', r.registry, label(r.name));
  };
  const envOf = (o) => (isObject(o?.env) ? Object.fromEntries(Object.entries(o.env).filter(([, v]) => typeof v === 'string')) : {});
  for (const [name, job] of Object.entries(isObject(doc?.jobs) ? doc.jobs : {})) {
    if (!isObject(job)) continue;
    for (const label of [job['runs-on']].flat().filter((l) => typeof l === 'string' && !l.includes('${{'))) {
      if (!labels) continue; // a hosted runner: its labels name no image we pull
      if (!labels.has(label)) throw new Error(`${file}: job "${name}" runs on "${label}", which the runner does not register (its --labels: ${[...labels.keys()].join(', ') || 'none'})`);
      if (labels.get(label)) image(labels.get(label), (n) => `CI jobs run in ${n}`);
    }
    const container = typeof job.container === 'string' ? job.container : job.container?.image;
    if (typeof container === 'string') image(container, (n) => `CI jobs run in ${n}`);
    for (const svc of Object.values(isObject(job.services) ? job.services : {})) if (typeof svc?.image === 'string') image(svc.image, (n) => `CI job service ${n}`);
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (!isObject(step)) continue;
      if (typeof step.uses === 'string') {
        const uses = step.uses.trim();
        if (uses.startsWith('docker://')) image(uses.slice('docker://'.length), (n) => `${base}: step image ${n}`);
        else if (/^https?:\/\//.test(uses)) for (const h of httpsHosts(uses)) { if (!own(h)) push('host', h, `${base}: uses an action from ${h}`); }
        else if (!uses.startsWith('./')) {
          const repo = uses.replace(/@.*$/, '').split('/').slice(0, 2).join('/');
          push('actions', repo, `uses ${repo}`);
        }
      }
      if (typeof step.run === 'string') {
        const script = shellText(step.run);
        const env = { ...envOf(doc), ...envOf(job), ...envOf(step) };
        const items = [
          ...[...script.matchAll(/https:\/\/[^\s"'`]+/g)].flatMap((m) => httpsHosts(m[0]).filter((h) => !own(h)).map((h) => ({ index: m.index, kind: 'host', value: h, label: `${base}: downloads from ${h}` }))),
          ...installsAt(script).map((i) => ({ index: i.index, kind: 'packages', value: i.packages, label: `${base}: ${i.words}` })),
          ...dockerRunImages(script, env).flatMap((d) => {
            const r = imageRef(d.image);
            return r ? [{ index: d.index, kind: 'registry', value: r.registry, label: `${base}: docker run ${r.name}` }] : [];
          })
        ].sort((a, b) => a.index - b.index);
        for (const it of items) push(it.kind, it.value, it.label);
      }
    }
  }
  return out;
}

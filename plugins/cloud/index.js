/**
 * @module plugins/cloud
 *
 * The cloud deriver: the services outside your house (or your company) that the code depends on and
 * you do not control, drawn from a committed registry, `topology.cloud.json` (core/cloud.js has the
 * format and the validator), and kept true by detectors that read the code:
 *
 *  - **Hosts in code.** Every outside `https://<host>` in the source files (by default every file the
 *    starter deriver's packages hold; option `code: ['src', …]` names folders). A call from the server,
 *    a fetch by the visitor's browser (`side: 'browser'`), or a link a person follows (described, never
 *    drawn). The edge comes from the module or package node that holds the file.
 *  - **Dockerfiles.** Every `Dockerfile` (and `*.Dockerfile`): its `FROM` images (`{ registry }`) and the
 *    package installs of its `RUN`s (`{ packages }`), `when: deploy`.
 *  - **Images.** Every container node on the map with an `image` (from your own deriver): its registry.
 *  - **CI.** GitHub Actions and Forgejo Actions workflows (`.github/workflows`, `.forgejo/workflows`):
 *    `uses:` owners (`{ actions }`), job images, downloads, installs, `docker run` images, `when: deploy`.
 *    Needs the optional dependency js-yaml; without it the CI detector is skipped with a warning.
 *  - **Caddy** (option `caddyfiles: [{ file, from }]`): DNS-01 providers, resolvers and the ACME CA, `when: renew`.
 *
 * Without a `topology.cloud.json` nothing is drawn: the deriver says how many outside hosts it found and
 * stops (a newcomer's first `sync` never fails on it). With one, every piece of evidence must be claimed
 * by an entry, a `web`, or a `links` host, and every entry must be used (or carry `uses`), so the file
 * cannot drift from the code.
 *
 * Options: `{ ownDomains?: string[], code?: string[], ci?: { from?: string }, dockerfiles?: boolean,
 * caddyfiles?: { file: string, from: string }[] }`. `ci.from` is the node CI evidence comes from (default:
 * a `tool-ci` node this deriver adds for the workflows folder).
 */

import { CLOUD_FILE, deriveCloud, EVIDENCE_KINDS } from '../../core/cloud.js';
import { hostsIn } from './hosts.js';
import { caddyEvidence, dockerfileSources, imageRef, workflowSources } from './sources.js';

const WORKFLOW_DIRS = ['.github/workflows', '.forgejo/workflows'];
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const PAGE_FILE = /\.(?:html|css)$/;
const NOT_SHIPPED = /\.(?:test|spec|stories)\.[a-z]+$/;
const DOCKERFILE = /(?:^|\/)(?:Dockerfile|[\w.-]+\.Dockerfile|Dockerfile\.[\w.-]+)$/;
export const CI_NODE = 'tool-ci';

/** js-yaml when it is installed (an optional dependency), else null */
async function loadYaml() {
  try {
    const mod = await import('js-yaml');
    return mod.default || mod;
  } catch {
    return null;
  }
}

/** The node a file belongs to: the node whose `file` is the file or its deepest folder, else the root */
export function ownerOf(file, nodes) {
  let best = null;
  for (const n of nodes) {
    if (typeof n.file !== 'string' || !n.file || n.type === 'store') continue;
    const f = n.file;
    if (f === file || file.startsWith(`${f.replace(/\/+$/, '')}/`)) {
      if (!best || f.length > best.file.length) best = n;
    }
  }
  return best ? best.id : 'root';
}

export default {
  name: 'cloud',
  contract: 1,
  owns: ['external'],

  async derive(ctx) {
    const options = ctx.options || {};
    const ownDomains = options.ownDomains || [];
    // What a piece of evidence may come from: the nodes derived so far, and the hand-written ones of the committed map
    const known = [...ctx.nodes, ...((ctx.map && ctx.map.nodes) || []).filter((n) => !ctx.nodes.some((d) => d.id === n.id))];
    const evidence = [];
    const warnings = [];
    const nodes = [];
    const edges = [];
    const add = (piece) => evidence.push(piece);
    // Image names the registry names (match.images): an image is evidence of its name only when an entry claims it
    let named = [];
    try { named = ctx.exists(CLOUD_FILE) ? (JSON.parse(ctx.read(CLOUD_FILE)).services || []).flatMap((s) => (s && s.match && Array.isArray(s.match.images) ? s.match.images : [])) : []; } catch { named = []; }
    const image = (ref, from, label, file) => {
      const r = imageRef(ref);
      if (!r) return;
      add({ match: { kind: 'registry', value: r.registry }, from, label, when: 'deploy', file });
      if (named.includes(r.name)) add({ match: { kind: 'image', value: r.name }, from, label: `runs ${r.name}`, file });
    };

    // Hosts in code and pages
    const roots = Array.isArray(options.code) ? options.code
      : (ctx.info.starter?.packages || []).map((p) => p.dir);
    const files = [...new Set(roots.flatMap((dir) => ctx.walk(dir === '.' ? '' : dir, (f) => (CODE_FILE.test(f) || PAGE_FILE.test(f)) && !NOT_SHIPPED.test(f))))].sort();
    for (const file of files) {
      const type = file.endsWith('.html') ? 'html' : file.endsWith('.css') ? 'css' : 'code';
      const from = ownerOf(file, known);
      for (const { host, context, how } of hostsIn(ctx.read(file), type, { ownDomains })) {
        const match = { kind: 'host', value: host };
        if (context === 'link') add({ match, from, label: 'links to', file, drawn: false });
        else add({ match, from, label: context === 'browser' ? `browser: ${how}` : 'calls', file });
      }
    }

    // Dockerfiles
    if (options.dockerfiles !== false) {
      for (const file of ctx.walk('', (f) => DOCKERFILE.test(f))) {
        const from = ownerOf(file, known);
        const { froms, installs } = dockerfileSources(ctx.read(file));
        for (const ref of froms) image(ref, from, `builds FROM ${imageRef(ref)?.name || ref}`, file);
        for (const i of installs) add({ match: { kind: 'packages', value: i.packages }, from, label: i.words, when: 'deploy', file });
      }
    }

    // Images of container nodes another deriver made
    for (const n of known.filter((x) => x.type === 'container' && typeof x.image === 'string')) {
      image(n.image, n.id, `pulls ${imageRef(n.image)?.name || n.image}`, n.file || 'topology.json');
    }

    // CI workflows
    const workflowFiles = WORKFLOW_DIRS.flatMap((dir) => ctx.list(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => `${dir}/${f}`));
    if (workflowFiles.length) {
      const yaml = await loadYaml();
      if (!yaml) warnings.push(`cloud: ${workflowFiles.length} CI workflow file(s) not read: install the optional dependency js-yaml to draw what CI pulls.`);
      else {
        let ciFrom = options.ci?.from;
        if (!ciFrom) {
          ciFrom = CI_NODE;
          const dirs = [...new Set(workflowFiles.map((f) => f.slice(0, f.lastIndexOf('/'))))];
          nodes.push({ id: CI_NODE, label: 'CI workflows', type: 'tool', file: dirs.join(', ') });
          edges.push({ from: 'root', to: CI_NODE });
        }
        for (const file of workflowFiles) {
          for (const e of workflowSources(ctx.read(file), { file, yaml, ownHost: (h) => ownDomains.some((d) => h === d || h.endsWith(`.${d}`)) })) {
            add({ ...e, from: ciFrom, when: 'deploy', file });
          }
        }
      }
    }

    // Caddyfiles the config names
    for (const { file, from } of options.caddyfiles || []) {
      if (!ctx.exists(file)) { warnings.push(`cloud: caddyfile ${file} does not exist.`); continue; }
      for (const e of caddyEvidence(ctx.read(file))) add({ ...e, from, when: 'renew', file });
    }

    if (!ctx.exists(CLOUD_FILE)) {
      const hosts = new Set(evidence.filter((e) => e.match.kind === 'host').map((e) => e.match.value));
      if (evidence.length) warnings.push(`cloud: the code reaches ${hosts.size} outside host(s) and ${evidence.length - [...evidence].filter((e) => e.match.kind === 'host').length} other outside source(s); add ${CLOUD_FILE} to draw them (docs/cloud.md).`);
      return { nodes: [], edges: [], warnings, evidence: [] };
    }
    // What the derivers before this one found (a repo's own deriver may add `lib`, `route`, `env` … evidence)
    const all = [...(ctx.evidence || []), ...evidence];
    const kinds = new Set(['host', 'registry', 'packages', 'image']);
    if (workflowFiles.length) kinds.add('actions');
    if ((options.caddyfiles || []).length) kinds.add('caddy');
    for (const e of all) kinds.add(e.match.kind);
    const cloud = deriveCloud({
      read: ctx.read, exists: ctx.exists, evidence: all,
      nodeIds: [...known.map((n) => n.id), ...nodes.map((n) => n.id)],
      kinds: [...kinds].filter((k) => k in EVIDENCE_KINDS), parent: ctx.config?.cloud?.parent || 'root',
    });
    return {
      nodes: [...nodes, ...cloud.nodes],
      edges: [...edges, ...cloud.edges],
      warnings: [...warnings, ...cloud.warnings],
      ownedIds: [...nodes.map((n) => n.id), ...cloud.ownedIds],
      evidence,
      info: { unknownPlans: cloud.unknown },
    };
  },
};

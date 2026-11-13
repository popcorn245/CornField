/**
 * @module core/cloud
 *
 * The cloud on the map (spec 0031 section 5, CLOUD-02): the services outside the house that we do
 * not control, described in a committed registry (`topology.cloud.json`) and validated like the
 * personas file. The code shows who uses a service (evidence, below); the file says what the code cannot:
 * what it is for, what breaks when it is down, and its plan. Pure, no I/O except through the readers a
 * caller passes, so the topology tool and the explorer (on a what-if) use the same code. This part is the
 * tool's; what to read in a repo (the detectors) is the plugin's.
 *
 *   {
 *     "version": 1,
 *     "services": [
 *       { "id": "cloudflare", "label": "Cloudflare", "roles": ["runtime", "account"], "desc": "…", "breaks": "…",
 *         "plan": { "tier": "free" }, "match": { "caddy": ["dns cloudflare"], "env": ["CF_API_TOKEN"] },
 *         "uses": [{ "from": "machine-server-1", "label": "resolves *.example.test", "why": "…" }] }
 *     ],
 *     "web": { "label": "Public web", "desc": "…", "breaks": "…", "match": { "libs": ["…/safe-fetch.ts"] } },
 *     "links": [{ "host": "www.openstreetmap.org", "why": "A link a person follows; never fetched" }]
 *   }
 *
 * **Evidence** is what a detector found: `{ match: { kind, value }, from, label, when?, side?, file, entry?, drawn? }`
 * (kind one of EVIDENCE_KINDS; `to` instead of `from` for a webhook, which the service delivers to; `entry`
 * when the code itself names the service, so the registry must agree; `drawn: false` for a piece that must
 * be described but draws nothing and is no use of the service: a link a person follows). The matcher claims each piece for
 * the entry whose `match` lists it, and draws one `calls` edge per (from, entry) with the labels joined.
 *
 * What this module does:
 *  - `validateCloud(file, { evidence, nodeIds, kinds })`: errors and warnings (section 5's six rules).
 *  - `matchEvidence(file, evidence)`: which entry claims each piece; `cloudEdges` the edges that makes.
 *  - `deriveCloud`: the nodes and edges `sync` writes (`store-cloud`, one `ext-<id>` per entry and
 *    `ext-public-web`), in the shape a deriver returns (plugins/cloud is the deriver).
 *  - `cloudNodeProblems(nodes, file)`: a cloud node on the map with no entry, and an entry with no node.
 */
import { CALL_WHEN, CLOUD_ROLES, PLAN_TIERS } from './schema.js';

export const CLOUD_FILE = 'topology.cloud.json';
export const CLOUD_STORE_ID = 'store-cloud';
/** The node the cloud file hangs under unless the config names another (`cloud.parent`) */
export const DEFAULT_PARENT = 'root';
/** The one node of kind `web` (spec 0031 D3): not cloud, so it is not a `services` entry */
export const PUBLIC_WEB = 'public-web';
export const cloudNodeId = (id) => `ext-${id}`;

/** What a piece of evidence can be, and the `match` list of an entry that claims it */
export const EVIDENCE_KINDS = {
  host: 'hosts',
  image: 'images',
  registry: 'registries',
  caddy: 'caddy',
  env: 'env',
  lib: 'libs',
  route: 'routes',
  webhook: 'webhooks',
  actions: 'actions',
  packages: 'packages',
  tailnet: 'tailnet'
};
const MATCH_KEYS = Object.values(EVIDENCE_KINDS);
const KIND_OF_KEY = Object.fromEntries(Object.entries(EVIDENCE_KINDS).map(([kind, key]) => [key, kind]));

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FILE_KEYS = ['version', 'services', 'web', 'links'];
const ENTRY_KEYS = ['id', 'label', 'roles', 'desc', 'breaks', 'plan', 'match', 'uses'];
const WEB_KEYS = ['label', 'desc', 'breaks', 'match'];
const USE_KEYS = ['from', 'label', 'when', 'why'];
const LINK_KEYS = ['host', 'why'];
const PLAN_KEYS = ['tier', 'note'];
/** A bare host name (or `*.example.com`), or an IPv4 address */
const HOST = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
/** Keys that would hold an account detail: never in the file (rule 6) */
const PRIVATE_KEY = /^(?:e-?mail|user(?:name|_?id)?|account_?id|token|password|secret)$/i;
/** A URL with a path beyond its host, with or without the scheme (a repo path like apps/api.x.com/lib is not one) */
const URL_PATH = /https?:\/\/[^\s/]+\/[^\s)]|(?<![\w./-])(?:[a-z0-9-]+\.)+[a-z]{2,}\/[\w%~.-]/i;
/** The strongest `when` wins: an outage that bites now beats one at the next deploy, and that one the next renewal */
const WHEN_RANK = { run: 0, deploy: 1, renew: 2 };

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every (entry id, match key, value) the file claims: the services', the public web's (`public-web`), the links' hosts (`null`) */
function claimsOf(file) {
  const out = [];
  for (const s of Array.isArray(file?.services) ? file.services : []) {
    if (!isObject(s) || !isObject(s.match)) continue;
    for (const [key, values] of Object.entries(s.match)) for (const value of key === 'tailnet' ? (values === true ? [true] : []) : Array.isArray(values) ? values : []) out.push({ id: s.id, key, value });
  }
  if (isObject(file?.web) && isObject(file.web.match)) {
    for (const [key, values] of Object.entries(file.web.match)) for (const value of Array.isArray(values) ? values : []) out.push({ id: PUBLIC_WEB, key, value });
  }
  for (const l of Array.isArray(file?.links) ? file.links : []) if (isObject(l) && isText(l.host)) out.push({ id: null, key: 'hosts', value: l.host });
  return out;
}

/**
 * Whether a match value claims an evidence value of its key: hosts exact or `*.example.com` (any name under
 * it), env a name or a prefix ending in `*`, images and actions a name or a prefix ending in `/`, the rest exact.
 */
export function claims(key, pattern, value) {
  if (key === 'tailnet') return pattern === true;
  if (typeof pattern !== 'string' || typeof value !== 'string') return false;
  if (key === 'hosts' && pattern.startsWith('*.')) return value.endsWith(pattern.slice(1)) && value.length > pattern.length - 1;
  if (key === 'env' && pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  if ((key === 'images' || key === 'actions') && pattern.endsWith('/')) return value.startsWith(pattern);
  return pattern === value;
}

/** "lib apps/x/lib/geo.ts", for a message */
const said = (piece) => `${piece?.match?.kind} "${piece?.match?.value}"`;
const whereOf = (piece) => piece.file || piece.from || piece.to || '(no file)';

/**
 * Which entry claims each piece of evidence.
 * @param {any} file a parsed topology.cloud.json (its shape already valid)
 * @param {any[]} evidence
 * @returns {{ claimed: { piece: any, id: string | null }[], unclaimed: any[], doubly: { piece: any, ids: (string | null)[] }[] }}
 *   `id` is an entry id, `public-web`, or null for a link (claimed, drawn as nothing)
 */
export function matchEvidence(file, evidence) {
  const all = claimsOf(file);
  const claimed = [];
  const unclaimed = [];
  const doubly = [];
  for (const piece of evidence) {
    const key = EVIDENCE_KINDS[piece?.match?.kind];
    const ids = [...new Set(all.filter((c) => c.key === key && claims(key, c.value, piece.match.value)).map((c) => c.id))];
    if (!ids.length) unclaimed.push(piece);
    else if (ids.length > 1) doubly.push({ piece, ids });
    else claimed.push({ piece, id: ids[0] });
  }
  return { claimed, unclaimed, doubly };
}

/**
 * The edges the claimed evidence and each entry's `uses` make: one `calls` edge per (from, entry), its labels
 * joined, the strongest `when` (left out when it is `run`), `side: 'browser'` only when every piece says so;
 * a webhook is the entry's `delivers` edge into the endpoint. A link draws nothing.
 * @param {any} file
 * @param {{ piece: any, id: string | null }[]} claimed
 */
export function cloudEdges(file, claimed) {
  const byPair = new Map();
  const add = (from, to, kind, label, when, side) => {
    const k = `${from}|${to}|${kind}`;
    if (!byPair.has(k)) byPair.set(k, { from, to, kind, labels: [], whens: [], sides: [] });
    const e = byPair.get(k);
    if (isText(label) && !e.labels.includes(label)) e.labels.push(label);
    e.whens.push(when || 'run');
    e.sides.push(side || null);
  };
  for (const { piece, id } of claimed) {
    if (id === null || piece.drawn === false) continue;
    if (piece.match.kind === 'webhook') add(cloudNodeId(id), piece.to, 'delivers', piece.label);
    else add(piece.from, cloudNodeId(id), 'calls', piece.label, id === PUBLIC_WEB ? undefined : piece.when, piece.side);
  }
  for (const s of file.services) for (const u of s.uses || []) add(u.from, cloudNodeId(s.id), 'calls', u.label, u.when);
  return [...byPair.values()].map((e) => {
    const when = e.whens.reduce((a, b) => (WHEN_RANK[b] < WHEN_RANK[a] ? b : a), 'renew');
    const side = e.sides.every((s) => s === 'browser') ? 'browser' : undefined;
    return {
      from: e.from, to: e.to, kind: e.kind, status: 'live', label: e.labels.join(' · ') || e.kind,
      ...(e.kind === 'calls' && when !== 'run' ? { when } : {}),
      ...(e.kind === 'calls' && side ? { side } : {})
    };
  });
}

/** Rule 6 over every string and key of the file: no `@`, no run of six digits, no URL path, no key that holds an account detail */
function privacyProblems(value, where, out) {
  if (typeof value === 'string') {
    if (value.includes('@')) out.push(`${where}: holds an "@" (an email address or a handle): the file names services and roles, never a person or an account.`);
    if (/\d{6,}/.test(value)) out.push(`${where}: holds a run of six or more digits (an account or a phone number?): leave account details out.`);
    if (URL_PATH.test(value)) out.push(`${where}: holds a URL with a path: name the host only (a path can carry an account or a key).`);
  } else if (Array.isArray(value)) value.forEach((v, i) => privacyProblems(v, `${where}[${i}]`, out));
  else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (PRIVATE_KEY.test(k)) out.push(`${where}: has a key "${k}": the file never holds an account detail.`);
      privacyProblems(v, `${where}.${k}`, out);
    }
  }
}

/** The shape of a `match` object (an entry's or the public web's) */
function matchProblems(match, bad) {
  if (!isObject(match)) return bad('"match" must be an object of lists, like { "hosts": ["api.example.com"] }.');
  for (const [key, values] of Object.entries(match)) {
    if (!MATCH_KEYS.includes(key)) { bad(`"match" has an unknown key "${key}". A match has: ${MATCH_KEYS.join(', ')}.`); continue; }
    if (key === 'tailnet') { if (values !== true) bad('"match.tailnet" can only be true (the entry claims the tailnet\'s machines).'); continue; }
    if (!Array.isArray(values) || !values.length || values.some((v) => !isText(v))) { bad(`"match.${key}" must be a list of one or more words.`); continue; }
    if (new Set(values).size !== values.length) bad(`"match.${key}" names the same value twice.`);
    if (key === 'hosts') for (const h of values) if (!HOST.test(h)) bad(`"match.hosts" has "${h}", which is not a bare host name (no scheme, port or path).`);
  }
}

/**
 * What is wrong with a cloud file, and against the evidence the code shows.
 * @param {any} file the parsed `topology.cloud.json`
 * @param {object} [opts]
 * @param {any[]} [opts.evidence] what the detectors found; left out, only the file itself is checked
 * @param {Set<string> | string[]} [opts.nodeIds] the map's node ids (a `uses.from` must be one); left out, not checked
 * @param {string[]} [opts.kinds] the evidence kinds the detectors read (default: all). An entry matched only by
 *   kinds no detector reads yet is a warning, not "nothing uses it".
 * @returns {{ errors: string[], warnings: string[], unknown: string[] }} `unknown`: the entries whose plan is unknown
 */
export function validateCloud(file, { evidence, nodeIds, kinds = Object.keys(EVIDENCE_KINDS) } = {}) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const err = (where, message) => errors.push(`${where}: ${message}`);
  if (!isObject(file)) return { errors: ['must be an object like { "version": 1, "services": [...] }.'], warnings, unknown: [] };
  if (file.version !== 1) err('version', `must be 1 (got ${JSON.stringify(file.version)}).`);
  for (const key of Object.keys(file)) if (!FILE_KEYS.includes(key) && !PRIVATE_KEY.test(key)) err(key, `unknown key "${key}": the file has ${FILE_KEYS.join(', ')}.`);
  privacyProblems(file, 'file', errors);
  if (!Array.isArray(file.services) || file.services.length === 0) {
    err('services', 'must be a list of at least one service.');
    return { errors, warnings, unknown: [] };
  }
  const ids = new Set(nodeIds || []);
  const known = (id) => !nodeIds || ids.has(id) || file.services.some((s) => isObject(s) && cloudNodeId(s.id) === id) || id === cloudNodeId(PUBLIC_WEB);

  const seen = new Set();
  file.services.forEach((s, i) => {
    const at = `services[${i}]`;
    if (!isObject(s)) return err(at, 'a service is an object with id, label, roles, desc, breaks and plan.');
    const name = isText(s.id) ? `${at} "${s.id}"` : at;
    const bad = (message) => err(name, message);
    for (const key of Object.keys(s)) if (!ENTRY_KEYS.includes(key) && !PRIVATE_KEY.test(key)) bad(`unknown key "${key}". A service has: ${ENTRY_KEYS.join(', ')}.`);
    if (!isText(s.id) || !KEBAB.test(s.id)) bad(`"id" must be lower-case words joined by dashes, like "docker-hub" (got ${JSON.stringify(s.id)}).`);
    else if (s.id === PUBLIC_WEB) bad(`"${PUBLIC_WEB}" is the public web's node: describe it under "web", not as a service.`);
    else if (seen.has(s.id)) bad(`duplicate id "${s.id}".`);
    else seen.add(s.id);
    if (!isText(s.label)) bad('needs a "label": the name the node shows (a role, like "Internet provider", for an account).');
    if (!isText(s.desc)) bad('needs a "desc": what the service is to the house. Never a person.');
    if (!isText(s.breaks)) bad('needs a "breaks" line: what fails when it is down.');
    if (!Array.isArray(s.roles) || !s.roles.length) bad(`needs "roles": one or more of ${CLOUD_ROLES.join(', ')}.`);
    else {
      for (const r of s.roles) if (!CLOUD_ROLES.includes(r)) bad(`has role "${r}". Valid roles: ${CLOUD_ROLES.join(', ')}.`);
      if (new Set(s.roles).size !== s.roles.length) bad('names a role twice.');
    }
    if (!isObject(s.plan)) bad(`needs a "plan": { "tier" } with tier one of ${PLAN_TIERS.join(', ')} ("unknown" until it is known).`);
    else {
      if (!PLAN_TIERS.includes(s.plan.tier)) bad(`has plan tier ${JSON.stringify(s.plan.tier)}. Valid tiers: ${PLAN_TIERS.join(', ')}.`);
      if (s.plan.note !== undefined && !isText(s.plan.note)) bad('has a plan "note" that is not words.');
      for (const key of Object.keys(s.plan)) if (!PLAN_KEYS.includes(key) && !PRIVATE_KEY.test(key)) bad(`has "${key}" in its plan: a plan has only a tier and a note (never a price).`);
    }
    if (s.match !== undefined) matchProblems(s.match, bad);
    if (s.uses !== undefined) {
      if (!Array.isArray(s.uses) || !s.uses.length) bad('"uses" must be a list of one or more { from, label, why }.');
      else s.uses.forEach((u, j) => {
        const where = `uses[${j}]`;
        if (!isObject(u)) return bad(`${where} must be an object with from, label and why.`);
        for (const key of Object.keys(u)) if (!USE_KEYS.includes(key) && !PRIVATE_KEY.test(key)) bad(`${where} has an unknown key "${key}". A use has: ${USE_KEYS.join(', ')}.`);
        if (!isText(u.from)) bad(`${where} needs "from": the node id that uses it.`);
        else if (!known(u.from)) bad(`${where} comes from "${u.from}", which is not a node of the map.`);
        if (!isText(u.label)) bad(`${where} needs a "label": what it uses the service for.`);
        if (!isText(u.why)) bad(`${where} needs a "why": why no file shows this use.`);
        if (u.when !== undefined && !CALL_WHEN.includes(u.when)) bad(`${where} has when ${JSON.stringify(u.when)}. Valid values: ${CALL_WHEN.join(', ')}.`);
      });
    }
  });

  if (file.web !== undefined) {
    const bad = (message) => err('web', message);
    if (!isObject(file.web)) bad('must be an object with label, desc, breaks and match.');
    else {
      for (const key of Object.keys(file.web)) if (!WEB_KEYS.includes(key) && !PRIVATE_KEY.test(key)) bad(`unknown key "${key}". The public web has: ${WEB_KEYS.join(', ')} (no roles or plan: it is not cloud).`);
      if (!isText(file.web.label)) bad('needs a "label".');
      if (!isText(file.web.desc)) bad('needs a "desc".');
      if (file.web.breaks !== undefined && !isText(file.web.breaks)) bad('has an empty "breaks": say what fails, or leave it out.');
      if (file.web.match !== undefined) matchProblems(file.web.match, bad);
    }
  }
  if (file.links !== undefined) {
    if (!Array.isArray(file.links)) err('links', 'must be a list of { host, why }.');
    else file.links.forEach((l, i) => {
      const at = `links[${i}]`;
      if (!isObject(l)) return err(at, 'a link is an object with host and why.');
      for (const key of Object.keys(l)) if (!LINK_KEYS.includes(key) && !PRIVATE_KEY.test(key)) err(at, `unknown key "${key}". A link has: ${LINK_KEYS.join(', ')}.`);
      if (!isText(l.host) || !HOST.test(l.host)) err(at, `"host" must be a bare host name (got ${JSON.stringify(l.host)}).`);
      if (!isText(l.why)) err(at, 'needs a "why": why it is only a link a person follows.');
    });
  }

  // Rule 4: one value, one claimant
  const byValue = new Map();
  for (const c of claimsOf(file)) {
    const k = `${c.key}|${c.value}`;
    if (!byValue.has(k)) byValue.set(k, new Set());
    byValue.get(k).add(c.id === null ? 'links' : c.id);
  }
  for (const [k, owners] of byValue) if (owners.size > 1) {
    const [key, value] = k.split('|');
    err(`match.${key} "${value}"`, `is claimed by ${[...owners].join(' and ')}: give it to one of them (a service that reaches another says so with "uses").`);
  }
  const unknown = file.services.filter((s) => isObject(s) && s.plan?.tier === 'unknown').map((s) => s.id);
  if (errors.length || !evidence) return { errors, warnings, unknown };

  // Rule 2: the code uses something the file does not describe
  const { claimed, unclaimed, doubly } = matchEvidence(file, evidence);
  for (const piece of unclaimed) {
    const key = EVIDENCE_KINDS[piece?.match?.kind];
    if (!key) err(whereOf(piece), `has evidence of kind ${JSON.stringify(piece?.match?.kind)}. Valid kinds: ${Object.keys(EVIDENCE_KINDS).join(', ')}.`);
    else err(whereOf(piece), `reaches ${said(piece)}; no entry in ${CLOUD_FILE} matches it. Add it to an entry's match.${key}${key === 'hosts' ? ', or to links if it is only a link a person follows' : ''}.`);
  }
  for (const { piece, ids: owners } of doubly) err(whereOf(piece), `reaches ${said(piece)}, which ${owners.map((o) => o ?? 'links').join(' and ')} all match: make the patterns not overlap.`);
  for (const { piece, id } of claimed) {
    if (piece.entry !== undefined && piece.entry !== id) err(whereOf(piece), `names ${said(piece)} as "${piece.entry}", but ${CLOUD_FILE} puts it under ${id === null ? 'links' : `"${id}"`}: make the two agree.`);
    for (const end of [piece.from, piece.to]) if (end !== undefined && !known(end)) err(whereOf(piece), `is evidence about "${end}", which is not a node of the map.`);
  }

  // Rule 3: the file describes something nothing uses (rule 5: an `off` one may stay, and warns while the code still reaches it)
  const detected = new Set(kinds.map((k) => EVIDENCE_KINDS[k]).filter(Boolean));
  const waiting = [];
  for (const s of file.services) {
    const mine = claimed.filter((c) => c.id === s.id && c.piece.drawn !== false);
    const off = s.plan.tier === 'off';
    if (off && mine.length) warnings.push(`${CLOUD_FILE}: ${cloudNodeId(s.id)} is off, but the code still reaches it: ${[...new Set(mine.map((c) => `${whereOf(c.piece)} (${said(c.piece)})`))].join(', ')}.`);
    if (mine.length || s.uses || off) continue;
    const keys = Object.keys(s.match || {});
    if (keys.length && keys.every((k) => !detected.has(k))) waiting.push(s.id);
    else err(`services "${s.id}"`, `nothing uses ${cloudNodeId(s.id)} any more: remove it, or give it "uses" (or plan "off" for an account kept so the gap shows).`);
  }
  if (waiting.length) warnings.push(`${CLOUD_FILE}: ${waiting.length} service(s) are matched only by evidence no detector reads yet (${MATCH_KEYS.filter((k) => !detected.has(k)).join(', ')}), so nothing draws who uses them: ${waiting.map(cloudNodeId).join(', ')}.`);
  return { errors, warnings, unknown };
}

/**
 * The cloud nodes, the public web, the file's store node and their edges, for `sync`.
 * @param {object} io
 * @param {(rel: string) => string} io.read
 * @param {(rel: string) => boolean} io.exists
 * @param {any[]} [io.evidence] what the detectors found
 * @param {Iterable<string>} [io.nodeIds] the other derived nodes' ids
 * @param {string[]} [io.kinds] the evidence kinds the detectors read
 * @param {string} [io.parent] the node the cloud file hangs under (default `root`)
 * @returns {{ nodes: any[], edges: any[], warnings: string[], ownedIds: string[], unknown: string[] }}
 */
export function deriveCloud({ read, exists, evidence = [], nodeIds = [], kinds, parent = DEFAULT_PARENT }) {
  const none = { nodes: [], edges: [], warnings: [], ownedIds: [], unknown: [] };
  if (!exists(CLOUD_FILE)) {
    if (evidence.length) throw new Error(`cloud: the code reaches ${evidence.length} outside service(s) (first ${said(evidence[0])} in ${whereOf(evidence[0])}), but there is no ${CLOUD_FILE} to describe them`);
    return none;
  }
  let file;
  try {
    file = JSON.parse(read(CLOUD_FILE));
  } catch (err) {
    throw new Error(`cloud: ${CLOUD_FILE} is not valid JSON: ${err.message}`);
  }
  const { errors, warnings, unknown } = validateCloud(file, { evidence, nodeIds: new Set(nodeIds), kinds });
  if (errors.length) throw new Error(`cloud: ${CLOUD_FILE} is invalid:\n  ${errors.join('\n  ')}`);

  const nodes = [{ id: CLOUD_STORE_ID, label: 'Cloud file', type: 'store', file: CLOUD_FILE }];
  const edges = [{ from: parent, to: CLOUD_STORE_ID }];
  for (const s of file.services) {
    nodes.push({
      id: cloudNodeId(s.id), label: s.label, type: 'external', kind: 'cloud', file: CLOUD_FILE,
      desc: s.desc.trim(), roles: s.roles, breaks: s.breaks.trim(),
      plan: { tier: s.plan.tier, ...(s.plan.note ? { note: s.plan.note.trim() } : {}) }
    });
    edges.push({ from: CLOUD_STORE_ID, to: cloudNodeId(s.id) });
  }
  if (file.web) {
    nodes.push({ id: cloudNodeId(PUBLIC_WEB), label: file.web.label, type: 'external', kind: 'web', file: CLOUD_FILE, desc: file.web.desc.trim(), ...(file.web.breaks ? { breaks: file.web.breaks.trim() } : {}) });
    edges.push({ from: CLOUD_STORE_ID, to: cloudNodeId(PUBLIC_WEB) });
  }
  edges.push(...cloudEdges(file, matchEvidence(file, evidence).claimed));
  return { nodes, edges, warnings, ownedIds: [CLOUD_STORE_ID], unknown };
}

/**
 * The map against the file: every `cloud` node is an entry's `ext-<id>` (the `web` one is `ext-public-web`
 * and the file has a `web`), and every entry has its node.
 * @param {{ id: string, type?: string, kind?: string }[]} nodes the map's nodes
 * @param {any} file the parsed topology.cloud.json, or null when there is none
 * @returns {string[]}
 */
export function cloudNodeProblems(nodes, file) {
  const problems = [];
  const entries = new Set((Array.isArray(file?.services) ? file.services : []).map((s) => cloudNodeId(s?.id)));
  const onMap = new Set();
  for (const n of nodes) {
    if (n.type !== 'external') continue;
    if (n.kind === 'cloud') {
      onMap.add(n.id);
      if (!entries.has(n.id)) problems.push(`Cloud node "${n.id}" has no entry in ${CLOUD_FILE}: describe it there (its id without "ext-"), then run: cornfield sync`);
    } else if (n.kind === 'web') {
      if (n.id !== cloudNodeId(PUBLIC_WEB)) problems.push(`External node "${n.id}" is of kind web: the public web is one node, "${cloudNodeId(PUBLIC_WEB)}".`);
      else if (!file?.web) problems.push(`"${n.id}" is on the map but ${CLOUD_FILE} has no "web": describe the public web there.`);
    }
  }
  for (const id of entries) if (!onMap.has(id)) problems.push(`${CLOUD_FILE} describes ${id}, which is not a cloud node on the map. Run: cornfield sync`);
  return problems;
}

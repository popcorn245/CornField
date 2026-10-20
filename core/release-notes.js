/**
 * @module core/release-notes
 *
 * Release notes from the map (PIPE-04), the pure half: no I/O, no clock, no DOM. The same pull requests and the same
 * map always give the same notes, so a draft previewed, copied and posted is one draft.
 *
 *   latestTag, compareTags, suggestTag   which tag the notes start from, and a name for the next one (semver tags only)
 *   draftNotes                           the merged pull requests grouped by what they changed on the map
 *   renderMarkdown                       those groups as Markdown, one line per pull request, each linking it
 *
 * The groups follow the map's hierarchy. A pull request's files each land on the deepest node whose `file` holds
 * them (as the issues and PRs panel does); that node's area is the ancestor just below the root (an app or a package,
 * following the ownership edges, the ones with no `kind`). A pull request is listed under each area it touched, with
 * the nodes it changed there. One that touches nothing on the map is listed under "Other". A pull request carrying the
 * breaking label is listed under "Breaking" first, and only there. Areas come in the map's own order, "Other" last.
 */

/** The label that puts a pull request under "Breaking" unless the config names another */
export const DEFAULT_BREAKING_LABEL = 'breaking';
/** The most nodes named on one line */
export const NODES_PER_LINE = 4;

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A tag name as numbers, or null when it is not a semver tag ("v1.2.3", "1.2.3-rc.1") */
export function parseTag(name) {
  const m = SEMVER.exec(String(name));
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null } : null;
}

/** Orders semver tag names, lowest first; a pre-release comes before its release */
export function compareTags(a, b) {
  const x = parseTag(a);
  const y = parseTag(b);
  if (!x || !y) return String(a).localeCompare(String(b));
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const px = x.pre.split('.');
  const py = y.pre.split('.');
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    if (px[i] === undefined) return -1;
    if (py[i] === undefined) return 1;
    const nx = /^\d+$/.test(px[i]);
    const ny = /^\d+$/.test(py[i]);
    if (nx && ny && Number(px[i]) !== Number(py[i])) return Number(px[i]) - Number(py[i]);
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && px[i] !== py[i]) return px[i] < py[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The highest semver tag, or null when there is none (a tag that is not a version is not a release).
 * @template {{ name: string }} T
 * @param {T[]} tags
 * @returns {T | null}
 */
export function latestTag(tags) {
  const versions = tags.filter((t) => parseTag(t.name));
  return versions.length ? versions.reduce((best, t) => (compareTags(t.name, best.name) > 0 ? t : best)) : null;
}

/**
 * A name for the release the notes are for: `v<version>` when the package's version has no tag yet, else the latest
 * tag with its patch number raised. '' when neither says (the person types it).
 * @param {{ name: string }[]} tags
 * @param {string | null} [version] the package.json version
 */
export function suggestTag(tags, version = null) {
  const names = new Set(tags.map((t) => t.name));
  const fromVersion = version && parseTag(version) ? `v${String(version).replace(/^v/, '')}` : '';
  if (fromVersion && !names.has(fromVersion) && !names.has(fromVersion.slice(1))) {
    const latest = latestTag(tags);
    if (!latest || compareTags(fromVersion, latest.name) > 0) return fromVersion;
  }
  const latest = latestTag(tags);
  const p = latest && parseTag(latest.name);
  return p && !p.pre ? `${latest.name.startsWith('v') ? 'v' : ''}${p.major}.${p.minor}.${p.patch + 1}` : '';
}

// ---------------------------------------------------------------------------
//  The map
// ---------------------------------------------------------------------------

const clean = (p) => String(p).replace(/^\.\//, '').replace(/\/+$/, '');

/** The nodes whose `file` is the path or a folder above it: the deepest wins, and a tie lights them all */
function nodesForFile(path, nodes) {
  const p = clean(path);
  let best = -1;
  let out = [];
  for (const node of nodes) {
    if (typeof node.file !== 'string' || node.file === '') continue;
    const file = clean(node.file);
    if (p !== file && !p.startsWith(`${file}/`)) continue;
    if (file.length > best) { best = file.length; out = [node]; } else if (file.length === best) out.push(node);
  }
  return out;
}

/**
 * What the grouping reads of a map: the nodes in order and each one's owner (the first ownership edge into it).
 * @param {{ nodes: any[], edges?: any[] }} topology
 */
export function mapIndex(topology) {
  const nodes = Array.isArray(topology?.nodes) ? topology.nodes : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const owner = new Map();
  for (const e of Array.isArray(topology?.edges) ? topology.edges : []) {
    if (e.kind === undefined && byId.has(e.from) && byId.has(e.to) && !owner.has(e.to)) owner.set(e.to, e.from);
  }
  return { nodes, byId, order, owner };
}

/** The node's area: the ancestor just below the root (the node itself when it has no owner, or the root owns it) */
function areaOf(node, index) {
  let at = node;
  const seen = new Set();
  while (!seen.has(at.id)) {
    seen.add(at.id);
    const up = index.byId.get(index.owner.get(at.id));
    if (!up || up.type === 'root') return at;
    at = up;
  }
  return at;
}

// ---------------------------------------------------------------------------
//  The notes
// ---------------------------------------------------------------------------

/**
 * @typedef {{ path: string, previousPath?: string | null }} NoteFile
 * @typedef {{ number: number, title: string, url?: string | null, author?: { login: string } | null, labels?: string[], mergedAt?: string | null, files: NoteFile[] }} NotePull
 * @typedef {{ number: number, title: string, url: string | null, author: string | null, nodes: string[] }} NoteItem
 * @typedef {{ kind: 'breaking' | 'area' | 'other', id: string, title: string, items: NoteItem[] }} NoteGroup
 */

/**
 * The merged pull requests grouped by what they changed on the map.
 * @param {{ pulls: NotePull[], topology: { nodes: any[], edges?: any[] } | null, breakingLabel?: string }} input
 * @returns {{ groups: NoteGroup[], count: number }} `count` the pull requests listed (each once, however many groups)
 */
export function draftNotes({ pulls, topology, breakingLabel = DEFAULT_BREAKING_LABEL }) {
  const index = mapIndex(topology || { nodes: [] });
  const wanted = String(breakingLabel).toLowerCase();
  const sorted = [...pulls].sort((a, b) => String(a.mergedAt ?? '').localeCompare(String(b.mergedAt ?? '')) || a.number - b.number);
  const breaking = [];
  const other = [];
  /** @type {Map<string, NoteItem[]>} */
  const areas = new Map();
  for (const p of sorted) {
    const base = { number: p.number, title: p.title, url: httpUrl(p.url), author: p.author && safeLogin(p.author.login) ? p.author.login : null };
    const touched = new Map(); // area id -> the nodes the pull request changed under it
    for (const f of p.files || []) {
      const found = [...nodesForFile(f.path, index.nodes), ...(f.previousPath ? nodesForFile(f.previousPath, index.nodes) : [])];
      for (const node of found) {
        const area = areaOf(node, index);
        if (!touched.has(area.id)) touched.set(area.id, new Map());
        if (node.id !== area.id) touched.get(area.id).set(node.id, node);
      }
    }
    const nodesIn = (id) => [...touched.get(id).values()].sort((a, b) => index.order.get(a.id) - index.order.get(b.id)).map((n) => String(n.label ?? n.id));
    if ((p.labels || []).some((l) => String(l).toLowerCase() === wanted)) {
      breaking.push({ ...base, nodes: [...touched.keys()].sort((a, b) => index.order.get(a) - index.order.get(b)).map((id) => String(index.byId.get(id).label ?? id)) });
    } else if (!touched.size) {
      other.push({ ...base, nodes: [] });
    } else {
      for (const id of touched.keys()) {
        if (!areas.has(id)) areas.set(id, []);
        areas.get(id).push({ ...base, nodes: nodesIn(id) });
      }
    }
  }
  /** @type {NoteGroup[]} */
  const groups = [];
  if (breaking.length) groups.push({ kind: 'breaking', id: 'breaking', title: 'Breaking', items: breaking });
  for (const id of [...areas.keys()].sort((a, b) => index.order.get(a) - index.order.get(b))) {
    groups.push({ kind: 'area', id, title: String(index.byId.get(id).label ?? id), items: areas.get(id) });
  }
  if (other.length) groups.push({ kind: 'other', id: 'other', title: 'Other', items: other });
  return { groups, count: pulls.length };
}

/** An http(s) address, or null (a forge's JSON is data, not trusted markup) */
function httpUrl(u) {
  return typeof u === 'string' && /^https?:\/\/[^\s<>()]+$/i.test(u) ? u : null;
}
const safeLogin = (login) => typeof login === 'string' && /^[\w.[\]-]+$/.test(login);

/** Text that cannot become Markdown or HTML: one line, with the characters that mean something escaped */
export function escapeMarkdown(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().replace(/[\\`*_[\]<>|~#]/g, '\\$&');
}

/**
 * The groups as Markdown: a heading per group, a line per pull request linking it.
 * @param {{ groups: NoteGroup[], count: number }} notes
 * @param {{ since?: string | null }} [opts] the tag the notes start from, for the empty case
 * @returns {string}
 */
export function renderMarkdown(notes, { since = null } = {}) {
  if (!notes.count) return `No pull requests were merged${since ? ` since ${since}` : ''}.\n`;
  const out = [];
  for (const g of notes.groups) {
    out.push(`### ${escapeMarkdown(g.title)}`, '');
    for (const i of g.items) {
      const ref = i.url ? `[#${i.number}](${i.url})` : `#${i.number}`;
      const shown = i.nodes.slice(0, NODES_PER_LINE).map((n) => `\`${String(n).replace(/[`\r\n]/g, ' ').trim()}\``);
      if (i.nodes.length > NODES_PER_LINE) shown.push(`and ${i.nodes.length - NODES_PER_LINE} more`);
      out.push(`- ${escapeMarkdown(i.title)} (${ref}${i.author ? ` by @${i.author}` : ''})${shown.length ? ` · ${shown.join(', ')}` : ''}`);
    }
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

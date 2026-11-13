/**
 * @module explorer/search-model
 *
 * What a search finds, in what order, and how it reads (spec 0008 D3 and D4). Pure: no DOM, no state. Nodes in, matches out.
 *
 *   - It reads a node's label, its id, its file path, its type (as a word: "service", and as its layer's name: "Services")
 *     and its finer kind ("webhook"). Case does not matter. Not descriptions: on a big map a common word in one would match
 *     hundreds of nodes and bury the one that was named.
 *   - It ranks: a label that starts with the term (0), then a word of the label that does (1), then the label containing it
 *     (2), then the id or the file (3), then the type or the kind (4). Within a rank, by label, then id: the order does not
 *     depend on the camera or on how the nodes happen to be listed.
 *   - It groups by type, under the layer's name with a count, groups in the order of their best match, and puts the matches
 *     in layers that are off last, under their own heading.
 *
 * Substring matching only: no fuzzy matching, so a reviewer can always see why a node matched. The matching itself is search-match.js.
 */

// Whether a node matches, and how well: search-match.js (what the map needs to halo the matches); kept as this module's too
import { RANK, TYPE_NAMES, groupName, rankOf, matchIds } from './search-match.js';

export { RANK, TYPE_NAMES, groupName, rankOf, matchIds };

/** The heading of the matches in layers that are off */
export const OFF_GROUP = 'In layers that are off';

/** Rows the list shows before "and N more" */
export const MAX_ROWS = 50;

/**
 * Every node the query finds, in the order the list shows them.
 * @param {object[]} nodes the topology nodes
 * @param {string} query as typed (it is trimmed, and case does not matter)
 * @param {{visible?: (node: object) => boolean, parentLabel?: (node: object) => string}} [opts]
 *   `visible`: whether the node is drawn (its layer is on); the others come last. `parentLabel`: who the row names after its label.
 * @returns {{
 *   query: string,
 *   matches: {node: object, rank: number, on: boolean, group: string, parent: string}[],
 *   groups: {name: string, off: boolean, count: number, rows: object[]}[],
 *   total: number, onMap: number, off: number,
 *   rows: number, more: number
 * }}
 *   `matches` is every match in list order (the order Enter and N walk), `groups` the same in groups with at most MAX_ROWS rows
 *   in all, `more` how many are past that.
 */
export function searchNodes(nodes, query, opts = {}) {
  const term = String(query || '').trim().toLowerCase();
  const visible = opts.visible || (() => true);
  const parentLabel = opts.parentLabel || (() => '');
  const out = { query: String(query || '').trim(), matches: [], groups: [], total: 0, onMap: 0, off: 0, rows: 0, more: 0 };
  if (!term) return out;

  const found = [];
  for (const node of nodes) {
    const rank = rankOf(node, term);
    if (rank < 0) continue;
    found.push({ node, rank, on: !!visible(node), group: groupName(node), parent: parentLabel(node) });
  }
  const byRank = (a, b) => a.rank - b.rank || String(a.node.label).localeCompare(String(b.node.label)) || String(a.node.id).localeCompare(String(b.node.id));
  found.sort(byRank);

  // The groups: by type, in the order of each one's best match (then its name); what is on the map before what is off it
  const lists = new Map();
  for (const m of found) {
    const key = m.on ? `on|${m.group}` : 'off'; // what a layer that is off hides is one group, whatever its types
    if (!lists.has(key)) lists.set(key, { name: m.on ? m.group : OFF_GROUP, off: !m.on, rows: [] });
    lists.get(key).rows.push(m);
  }
  const groups = [...lists.values()].sort((a, b) => Number(a.off) - Number(b.off) || a.rows[0].rank - b.rows[0].rank || a.name.localeCompare(b.name));
  out.matches = groups.flatMap((g) => g.rows);
  out.total = out.matches.length;
  out.onMap = found.filter((m) => m.on).length;
  out.off = out.total - out.onMap;

  // The list: the first MAX_ROWS rows in that order, in their groups; the groups keep their full counts
  let room = MAX_ROWS;
  for (const g of groups) {
    if (room <= 0) break;
    out.groups.push({ name: g.name, off: g.off, count: g.rows.length, rows: g.rows.slice(0, room) });
    room -= g.rows.length;
  }
  out.rows = Math.min(MAX_ROWS, out.total);
  out.more = Math.max(0, out.total - MAX_ROWS);
  return out;
}

/**
 * The match `by` steps (+1 or -1) from the one with id `currentId`, wrapping round; the first (or, going back, the last) when
 * there is no current one or it is not among them.
 * @param {{node: {id: string}}[]} matches in list order
 * @param {string|null|undefined} currentId
 * @param {number} by
 * @returns {number} an index into `matches`, -1 for none
 */
export function stepIndex(matches, currentId, by) {
  if (!matches.length) return -1;
  const at = matches.findIndex((m) => m.node.id === currentId);
  if (at < 0) return by < 0 ? matches.length - 1 : 0;
  return (at + (by < 0 ? -1 : 1) + matches.length) % matches.length;
}

/** What the field's count says: "No match", "33 matches", or "3 of 33" once one is chosen; '' for no query */
export function countText(result, currentId) {
  if (!result.query) return '';
  if (!result.total) return 'No match';
  const at = result.matches.findIndex((m) => m.node.id === currentId);
  if (at >= 0) return `${at + 1} of ${result.total}`;
  return result.total === 1 ? '1 match' : `${result.total} matches`;
}

/** The list's words for a query that found nothing (the query goes in as text, never as HTML) */
export const noMatchLine = (query) => `No node matches “${query}”. Search reads names, files, types and kinds.`;

/** "and 12 more: type more to narrow" */
export const moreLine = (n) => `and ${n} more: type more to narrow`;

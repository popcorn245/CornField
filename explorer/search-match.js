/**
 * @module explorer/search-match
 *
 * Whether a node matches a search, and how well (spec 0008 D3): the half of search-model.js the map itself needs, to halo what a query finds
 * (scene.js `matchIds`). Pure. search-model.js builds the list, its groups and its words on it, and re-exports these.
 */

/** The ranks, best first */
export const RANK = Object.freeze({ labelStart: 0, wordStart: 1, label: 2, idOrFile: 3, typeOrKind: 4 });

/**
 * The layer's name for each node type, as the Layers menu says it (layers.js `LAYER_DEFS`; a test keeps the two together).
 * A type not here is its own name with a capital.
 */
export const TYPE_NAMES = Object.freeze({
  root: 'Root', app: 'Apps', pkg: 'Packages', page: 'Pages & Routes', atom: 'Atoms', molecule: 'Molecules', token: 'Design Tokens',
  tool: 'Dev Tools', core: 'Core', store: 'Stores', table: 'Tables', rom: 'ROM', service: 'Services', external: 'Cloud', stack: 'Infra',
  machine: 'Machines', container: 'Containers', device: 'Devices', floor: 'House', room: 'House', persona: 'People',
});

const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The name of the group a node is listed under: its layer's name */
export const groupName = (node) => TYPE_NAMES[node.type] || capital(String(node.type || ''));

const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
const WORD_BREAK = /[^\p{L}\p{N}]+/u;

/**
 * How well `query` (trimmed) matches a node, as a RANK, or -1 for no match
 * @param {{label?: string, id?: string, file?: string, type?: string, kind?: string}} node
 * @param {string} query
 */
export function rankOf(node, query) {
  const term = String(query || '').toLowerCase();
  if (!term) return -1;
  const label = lower(node.label);
  if (label.startsWith(term)) return RANK.labelStart;
  if (label.split(WORD_BREAK).some((w) => w && w.startsWith(term))) return RANK.wordStart;
  if (label.includes(term)) return RANK.label;
  if (lower(node.id).includes(term) || lower(node.file).includes(term)) return RANK.idOrFile;
  if (lower(node.type).includes(term) || lower(groupName(node)).includes(term) || lower(node.kind).includes(term)) return RANK.typeOrKind;
  return -1;
}

/** The ids a query matches (what the map halos): a Set, empty for no query */
export function matchIds(nodes, query) {
  const term = String(query || '').trim().toLowerCase();
  const ids = new Set();
  if (!term) return ids;
  for (const node of nodes) if (rankOf(node, term) >= 0) ids.add(node.id);
  return ids;
}

/**
 * @module core/layers
 *
 * The Layers menu's rows as data (spec 0009): the starting layers cornfield ships, the project layers a repo adds in
 * `cornfield.config.js` (`layers: { add, off, order }`), the matcher that says which layer a node is in, the checks `cornfield validate`
 * and the config load make, and the letters a finer `kind` shows on the map.
 *
 * `match` is DATA, never code: the fixed keys `type`, `kind`, `parent` and `field`, whose values are text, numbers, true or false (or a
 * short list of them), compared exactly. No pattern, no function, no template. A layer's key is checked against a strict pattern before it
 * can reach a CSS custom property name or a `data-corn` value; its label and description are text, escaped wherever they reach the page.
 *
 * Pure, no imports but the schema's node table: the CLI, the server and the browser (core/ is served to it) all read this one file.
 */

import { NODE_THEMES } from './schema.js';

/** A layer key: lower-case words joined by "-" (letters and digits), at most 32 characters. The only way in to a token name or a `data-corn` value */
export const LAYER_KEY_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const MAX_KEY = 32;
export const MAX_LAYERS = 24;
export const MAX_LABEL = 40;
export const MAX_DESC = 120;
/** The most values in a list of a match, the most field names a match tests, the longest text value */
export const MAX_LIST = 20;
export const MAX_FIELDS = 4;
export const MAX_VALUE = 80;
/** The keys of a project layer, and of its `match` */
export const LAYER_KEYS = Object.freeze(['key', 'label', 'desc', 'match']);
export const MATCH_KEYS = Object.freeze(['type', 'kind', 'parent', 'field']);
/** The keys of `layers` */
export const LAYERS_KEYS = Object.freeze(['add', 'off', 'order']);
/** A field name: letters, digits and `_`, starting with a letter */
export const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
/** Node types a layer key may not be, though no starting layer has them as a key */
const RESERVED = Object.freeze(['root', 'external', 'floor', 'room']);

/**
 * The starting layers, in the menu's usual order, each as an entry of the shape a project layer has. `match` is what puts a node in it
 * (null: the layer holds no nodes of its own). `live` rows draw or place from the live layer; `overlay` rows are marks over the map, not layers.
 * A node no entry takes is in a row of its own type (layers.js adds the row), and the root is in none.
 */
export const STARTING_LAYERS = Object.freeze([
  { key: 'app', label: 'Apps', desc: 'Subdomains', match: { type: 'app' } },
  { key: 'pkg', label: 'Packages', desc: 'Libraries', match: { type: 'pkg' } },
  { key: 'page', label: 'Pages & Routes', desc: 'Routes', match: { type: 'page' } },
  { key: 'atom', label: 'Atoms', desc: 'Base Components', match: { type: 'atom' } },
  { key: 'molecule', label: 'Molecules', desc: 'Composites', match: { type: 'molecule' } },
  { key: 'token', label: 'Design Tokens', desc: 'Pollen CSS', match: { type: 'token' } },
  { key: 'tool', label: 'Dev Tools', desc: 'Utilities', match: { type: 'tool' } },
  { key: 'flow', label: 'Data Flow', desc: 'Tiers & sync', match: null },
  { key: 'core', label: 'Core', desc: 'The shared core: what the apps and packages are built on. Shows with Packages or Atoms', match: { type: 'core' } },
  { key: 'store', label: 'Stores', desc: 'Storage tiers and the ends of the data flows. Shows with Data Flow', match: { type: 'store' } },
  { key: 'table', label: 'Tables', desc: 'SQLite tables, reads & writes', match: { type: 'table' } },
  { key: 'rom', label: 'ROM', desc: 'Render on Mutation', match: { type: 'rom' } },
  { key: 'service', label: 'Services', desc: 'API jobs, webhooks and hooks', match: { type: 'service' } },
  // Cloud is every outside node that is not the public web (an external with another kind, or none, is Cloud: scene.js has always drawn it so)
  { key: 'cloud', label: 'Cloud', desc: 'Services outside the house that we do not control: what runs, where software comes from, accounts (topology.cloud.json)', match: { type: 'external', kind: 'cloud' } },
  { key: 'web', label: 'Public web', desc: 'Any public page or picture a person points us at: not cloud', match: { type: 'external', kind: 'web' } },
  { key: 'stack', label: 'Infra', desc: 'Compose stacks and the domains they serve', match: { type: 'stack' } },
  { key: 'machine', label: 'Machines', desc: 'The computers the code runs on, placed in their room from the inventory (live)', match: { type: 'machine' }, live: true },
  { key: 'container', label: 'Containers', desc: 'One service of a stack, from its compose file', match: { type: 'container' } },
  { key: 'device', label: 'Devices', desc: 'Cameras, and live: phones, NFC tags, Home Assistant devices', match: { type: 'device' }, live: true },
  { key: 'house', label: 'House', desc: 'Floors and rooms (live)', match: { type: ['floor', 'room'] }, live: true },
  { key: 'runs', label: 'Runs in flight', desc: 'A pulsing ring on the nodes an open agent run is changing; a dashed ring and a warning where two runs change the same node', match: null, overlay: true },
  { key: 'persona', label: 'People', desc: 'Personas, with a live count of their accounts (never a name)', match: { type: 'persona' }, live: true },
]);

export const STARTING_KEYS = Object.freeze(STARTING_LAYERS.map((l) => l.key));
const STARTING_SET = new Set(STARTING_KEYS);
const NODE_TYPES = Object.keys(NODE_THEMES);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A line break or any other control character */
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');
const show = (v) => (typeof v === 'string' ? `"${v.length > 40 ? `${v.slice(0, 40)}…` : v}"` : typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) ? 'a list' : v === null ? 'null' : typeof v);
const scalar = (v) => (typeof v === 'string' && v.length > 0 && v.length <= MAX_VALUE && !CONTROL.test(v)) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';

// ---------------------------------------------------------------------------
//  Names a theme can reach: the tokens and icon keys of a kind and of a project layer (D6)
// ---------------------------------------------------------------------------

/** A kind as it is written in a token name or an icon key: lower-case words and digits joined by "-", at most 32 characters. A kind that is anything else has no token of its own (it is still a kind) */
export const KIND_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_KIND_NAME = 32;
const TYPE_SET = new Set(NODE_TYPES);

/** `--corn-map-kind-<type>-<kind>`, or null when the type is not a node type or the kind cannot be a part of a name (types never hold a "-", so the name reads one way) */
export const mapKindToken = (type, kind) => (TYPE_SET.has(type) && typeof kind === 'string' && kind.length <= MAX_KIND_NAME && KIND_NAME_RE.test(kind) ? `--corn-map-kind-${type}-${kind}` : null);
/** `--corn-map-group-<key>` for a layer key that passes LAYER_KEY_RE, else null */
export const mapGroupToken = (key) => (typeof key === 'string' && key.length <= MAX_KEY && LAYER_KEY_RE.test(key) ? `--corn-map-group-${key}` : null);
/** Reads a kind token's name back: `{ type, kind }`, or null (the type is the part before the first "-") */
export function parseKindToken(name) {
  const m = /^--corn-map-kind-([a-z]+)-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(String(name));
  return m && TYPE_SET.has(m[1]) && m[2].length <= MAX_KIND_NAME ? { type: m[1], kind: m[2] } : null;
}

/**
 * What a `theme.icons` key names: a node type (`"service"`), a finer kind of one (`"service:timer"`) or a project layer (`"layer:timers"`).
 * Null when it is none of them. Whether the kind is on the map or the layer in the config is a warning, not a shape.
 * @param {unknown} key
 * @returns {{ type: string } | { type: string, kind: string } | { layer: string } | null}
 */
export function iconKeyShape(key) {
  if (typeof key !== 'string') return null;
  if (TYPE_SET.has(key)) return { type: key };
  const i = key.indexOf(':');
  if (i < 0) return null;
  const head = key.slice(0, i);
  const tail = key.slice(i + 1);
  if (head === 'layer') return LAYER_KEY_RE.test(tail) && tail.length <= MAX_KEY ? { layer: tail } : null;
  return TYPE_SET.has(head) && KIND_NAME_RE.test(tail) && tail.length <= MAX_KIND_NAME ? { type: head, kind: tail } : null;
}

/** The icon keys to try for a node, most specific first: its kind, its project layer, its type (D6) */
export function iconKeysFor(type, kind, layer) {
  const out = [];
  if (typeof kind === 'string' && KIND_NAME_RE.test(kind) && kind.length <= MAX_KIND_NAME) out.push(`${type}:${kind}`);
  if (layer) out.push(`layer:${layer}`);
  out.push(type);
  return out;
}

// ---------------------------------------------------------------------------
//  Which layer a node is in
// ---------------------------------------------------------------------------

/** The edges' ownership line as a map: child id to parent id (an edge with no kind that is not dashed; the first one wins, as layout.js reads it) */
const parentMemo = new WeakMap();
export function parentIndex(edges) {
  const hit = parentMemo.get(edges);
  if (hit && hit.length === edges.length) return hit.map;
  const map = new Map();
  for (const e of edges) if (e && !e.dashed && !e.kind && e.from && e.to && e.from !== e.to && !map.has(e.to)) map.set(e.to, e.from);
  parentMemo.set(edges, { length: edges.length, map });
  return map;
}

const oneOf = (want, got) => (Array.isArray(want) ? want.includes(got) : want === got);

/**
 * Whether `node` meets `match`: within a key any value, across keys all. A node without the field does not meet it; a field that holds a
 * list meets it when it holds one of the values. Pure: `parentOf(node)` says the id of its owner (only asked when the match has `parent`).
 * @param {object | null | undefined} match
 * @param {object} node
 * @param {(node: object) => string | undefined} [parentOf]
 */
export function meets(match, node, parentOf) {
  if (!isObject(match)) return false;
  let any = false;
  if (match.type !== undefined) { any = true; if (!oneOf(match.type, node.type)) return false; }
  if (match.kind !== undefined) { any = true; if (!oneOf(match.kind, node.kind)) return false; }
  if (match.parent !== undefined) { any = true; if (!parentOf || !oneOf(match.parent, parentOf(node))) return false; }
  if (match.field !== undefined) {
    any = true;
    for (const name of Object.keys(match.field)) {
      if (!Object.hasOwn(node, name)) return false;
      const have = node[name];
      const want = match.field[name];
      const ok = Array.isArray(have) ? have.some((h) => oneOf(want, h)) : oneOf(want, have);
      if (!ok) return false;
    }
  }
  return any;
}

/** The starting layers that hold nodes, the more specific (with a `kind`) first, so the public web is taken before Cloud */
const BY_SPECIFICITY = [...STARTING_LAYERS.filter((l) => l.match)].sort((a, b) => Number('kind' in b.match) - Number('kind' in a.match));

/** The key of the starting layer `node` is in: Cloud for any outside node that is not the public web, House for floors and rooms, else its type's row. The root has none (null) */
export function startingLayerOf(node) {
  if (node.type === 'root') return null;
  if (node.type === 'external') return node.kind === 'web' ? 'web' : 'cloud';
  for (const l of BY_SPECIFICITY) if (meets(l.match, node)) return l.key;
  return node.type;
}

/**
 * The key of the first project layer in `add` whose match the node meets, or null (D3: a node is in exactly one layer; the first project
 * layer that takes it, else its starting layer).
 * @param {object[]} add the project layers
 * @param {object} node
 * @param {(node: object) => string | undefined} [parentOf]
 */
export function projectLayerOf(add, node, parentOf) {
  if (!add || !add.length || node.type === 'root') return null;
  for (const l of add) if (meets(l.match, node, parentOf)) return l.key;
  return null;
}

/** The row a node is under: its project layer, else its starting layer (null for the root) */
export const layerKeyOf = (add, node, parentOf) => projectLayerOf(add, node, parentOf) || startingLayerOf(node);

// ---------------------------------------------------------------------------
//  The checks (D4)
// ---------------------------------------------------------------------------

const typeHint = `${NODE_TYPES.slice(0, 5).join(', ')}, …`;
const IN_LAYER_LIST = (add) => {
  const keys = (Array.isArray(add) ? add : []).map((l) => (isObject(l) && typeof l.key === 'string' ? l.key : null)).filter((k) => k && LAYER_KEY_RE.test(k));
  return `${STARTING_KEYS.slice(0, 3).join(', ')}, …${keys.length ? `, ${keys[keys.length - 1]}` : ''}`;
};

function valueProblems(where, name, v, out) {
  if (Array.isArray(v)) {
    if (!v.length) out.push(`${where}.${name} is an empty list: give at least one value, or leave the key out.`);
    else if (v.length > MAX_LIST) out.push(`${where}.${name} has ${v.length} values: at most ${MAX_LIST}.`);
    return v.length <= MAX_LIST ? v : [];
  }
  return [v];
}

function matchProblems(w, match, out) {
  if (!isObject(match)) { out.push(`${w}.match is { type, kind, parent, field }: say at least one of them.`); return; }
  for (const k of Object.keys(match)) {
    if (!MATCH_KEYS.includes(k)) out.push(`${w}.match has unknown key "${k}": known: ${MATCH_KEYS.join(', ')}. A match is data: no pattern, no function.`);
  }
  if (!Object.keys(match).some((k) => MATCH_KEYS.includes(k))) {
    if (!Object.keys(match).length) out.push(`${w}.match is empty: say at least one of ${MATCH_KEYS.join(', ')}.`);
    return;
  }
  if ('type' in match) {
    for (const t of valueProblems(`${w}.match`, 'type', match.type, out)) {
      if (typeof t !== 'string' || !NODE_TYPES.includes(t)) out.push(`${w}.match.type ${show(t)} is not a node type (${typeHint}).`);
    }
  }
  if ('kind' in match) {
    for (const k of valueProblems(`${w}.match`, 'kind', match.kind, out)) {
      if (typeof k !== 'string' || !k || k.length > MAX_VALUE || CONTROL.test(k)) out.push(`${w}.match.kind ${show(k)}: a kind is text, one line, at most ${MAX_VALUE} characters.`);
    }
  }
  if ('parent' in match) {
    for (const p of valueProblems(`${w}.match`, 'parent', match.parent, out)) {
      if (typeof p !== 'string' || !p || p.length > 200 || CONTROL.test(p)) out.push(`${w}.match.parent ${show(p)}: a parent is a node id (text), like "pkg-core".`);
    }
  }
  if ('field' in match) {
    const f = match.field;
    if (!isObject(f)) { out.push(`${w}.match.field is { name: value }: a node field and the value (or list of values) it must have.`); return; }
    const names = Object.keys(f);
    if (!names.length) out.push(`${w}.match.field is empty: name a field, like { audience: 'household' }.`);
    if (names.length > MAX_FIELDS) out.push(`${w}.match.field names ${names.length} fields: at most ${MAX_FIELDS}.`);
    for (const name of names.slice(0, 20)) {
      if (!FIELD_NAME_RE.test(name) || name.length > 40) { out.push(`${w}.match.field "${name.slice(0, 40)}": a field name is letters, digits and "_", starting with a letter.`); continue; }
      if (['type', 'kind', 'parent'].includes(name)) { out.push(`${w}.match.field.${name}: use the match key "${name}" itself, not a field.`); continue; }
      const values = Array.isArray(f[name]) ? f[name] : [f[name]];
      if (Array.isArray(f[name]) && (!values.length || values.length > MAX_LIST)) out.push(`${w}.match.field.${name} is a list of ${values.length}: one to ${MAX_LIST} values.`);
      else if (!values.every(scalar)) out.push(`${w}.match.field.${name}: a value is text, a number, true or false, or a list of them.`);
    }
  }
}

/**
 * What is wrong with `layers` (as the config file wrote it), one line each, naming the key and what would be right. Pure: nothing about the map.
 * @param {unknown} layers
 * @returns {string[]}
 */
export function layersProblems(layers) {
  if (layers === undefined) return [];
  if (!isObject(layers)) return ['"layers" is an object: { add: [{ key, label, match }], off: [keys], order: [keys] }.'];
  const out = [];
  for (const k of Object.keys(layers)) if (!LAYERS_KEYS.includes(k)) out.push(`layers has unknown key "${k}": known: ${LAYERS_KEYS.join(', ')}.`);
  const add = layers.add;
  if (add !== undefined && !Array.isArray(add)) out.push('layers.add is a list of project layers: [{ key, label, desc?, match }].');
  const list = Array.isArray(add) ? add : [];
  if (list.length > MAX_LAYERS) out.push(`layers.add has ${list.length} layers: at most ${MAX_LAYERS}.`);
  const seen = new Map();
  list.slice(0, 100).forEach((l, i) => {
    const w = `layers.add[${i}]`;
    if (!isObject(l)) { out.push(`${w} is { key, label, desc?, match }.`); return; }
    for (const k of Object.keys(l)) {
      if (LAYER_KEYS.includes(k)) continue;
      const why = /^colou?r$|^icon$|^fill$/i.test(k) ? ' Colours and icons are the theme\'s.' : k === 'on' || k === 'hide' ? ' Whether a layer starts off is layers.off.' : '';
      out.push(`${w} has unknown key "${k}": known: ${LAYER_KEYS.join(', ')}.${why}`);
    }
    const key = l.key;
    if (typeof key !== 'string') out.push(`${w}.key is required: lower-case words joined by "-", like "edge-stack".`);
    else if (STARTING_SET.has(key)) out.push(`${w}.key ${show(key)} is a starting layer: pick another key.`);
    else if (RESERVED.includes(key)) out.push(`${w}.key ${show(key)} is reserved (a node type): pick another key.`);
    else if (!LAYER_KEY_RE.test(key) || key.length > MAX_KEY) out.push(`${w}.key ${show(key)}: lower-case words joined by "-", like "edge-stack"${key.length > MAX_KEY ? `, at most ${MAX_KEY} characters` : ''}.`);
    else if (seen.has(key)) out.push(`${w}.key ${show(key)} is also layers.add[${seen.get(key)}].key: a key is used once.`);
    else seen.set(key, i);
    const textProblem = (name, max, needed) => {
      const v = l[name];
      if (v === undefined) { if (needed) out.push(`${w}.${name} is required: plain text, one line, at most ${max} characters.`); return; }
      if (typeof v !== 'string' || !v.trim()) out.push(`${w}.${name} ${show(v)}: plain text, one line, at most ${max} characters.`);
      else if (CONTROL.test(v)) out.push(`${w}.${name}: one line of plain text (no line break or control character).`);
      else if ([...v].length > max) out.push(`${w}.${name} is ${[...v].length} characters: at most ${max}.`);
    };
    textProblem('label', MAX_LABEL, true);
    textProblem('desc', MAX_DESC, false);
    if (l.match === undefined) out.push(`${w}.match is required: say at least one of ${MATCH_KEYS.join(', ')}.`);
    else matchProblems(w, l.match, out);
  });
  const known = new Set([...STARTING_KEYS, ...list.map((l) => (isObject(l) && typeof l.key === 'string' ? l.key : null)).filter(Boolean)]);
  for (const name of ['off', 'order']) {
    const v = layers[name];
    if (v === undefined) continue;
    if (!Array.isArray(v)) { out.push(`layers.${name} is a list of layer keys: ['${name === 'off' ? 'timers' : 'app'}', …].`); continue; }
    const dup = new Set();
    v.forEach((k) => {
      if (typeof k !== 'string' || !known.has(k)) out.push(`layers.${name} ${show(k)} is not a layer (${IN_LAYER_LIST(add)}).`);
      else if (dup.has(k)) out.push(`layers.${name} ${show(k)} is listed twice.`);
      dup.add(k);
    });
  }
  return out;
}

/**
 * The layers the browser is sent: only what passed (`layersProblems` empty, else nothing), copied to plain data of the known keys, so a hostile
 * value never travels.
 * @param {unknown} layers
 * @returns {{ add: { key: string, label: string, desc?: string, match: object }[], off: string[], order: string[] }}
 */
export function clientLayers(layers) {
  const none = { add: [], off: [], order: [] };
  if (!isObject(layers) || layersProblems(layers).length) return none;
  const copy = (v) => (Array.isArray(v) ? v.slice(0, MAX_LIST) : v);
  const add = (layers.add || []).map((l) => {
    const m = l.match;
    const match = {};
    if (m.type !== undefined) match.type = copy(m.type);
    if (m.kind !== undefined) match.kind = copy(m.kind);
    if (m.parent !== undefined) match.parent = copy(m.parent);
    if (m.field !== undefined) match.field = Object.fromEntries(Object.keys(m.field).map((k) => [k, copy(m.field[k])]));
    const out = { key: l.key, label: l.label.trim(), match };
    if (typeof l.desc === 'string' && l.desc.trim()) out.desc = l.desc.trim();
    return out;
  });
  return { add, off: [...(layers.off || [])], order: [...(layers.order || [])] };
}

/**
 * What `validate` says about the layers against the map (a warning, never a failure): a project layer that matches no node, and one whose
 * every node an earlier layer took.
 * @param {{ add?: object[] }} layers the client form (`clientLayers`)
 * @param {{ nodes: object[], edges?: object[] }} map
 * @returns {string[]}
 */
export function layersMapWarnings(layers, map) {
  const add = (layers && layers.add) || [];
  if (!add.length) return [];
  const parentOf = (n) => parentIndex(map.edges || []).get(n.id);
  const out = [];
  const taken = new Map(add.map((l) => [l.key, 0]));
  const met = new Map(add.map((l) => [l.key, 0]));
  for (const n of map.nodes) {
    if (n.type === 'root') continue;
    for (const l of add) if (meets(l.match, n, parentOf)) met.set(l.key, met.get(l.key) + 1);
    const k = projectLayerOf(add, n, parentOf);
    if (k) taken.set(k, taken.get(k) + 1);
  }
  add.forEach((l, i) => {
    if (!met.get(l.key)) out.push(`layers.add[${i}] "${l.key}" matches no node on the map: its row will not show.`);
    else if (!taken.get(l.key)) out.push(`layers.add[${i}] "${l.key}" takes no node: every node it matches is taken by an earlier layer.`);
  });
  return out;
}

// ---------------------------------------------------------------------------
//  The order of the rows (D8)
// ---------------------------------------------------------------------------

/**
 * The rows in menu order: `order` first, then the project layers in `add` order, then the starting layers in their usual order, then any
 * `extra` rows (a node type none covers). The overlays are not in this list: the menu draws them under their own heading.
 * @template {{ key: string }} R
 * @param {R[]} project the project layers' rows
 * @param {R[]} starting the starting layers' rows (no overlays)
 * @param {string[]} [order]
 * @returns {R[]}
 */
export function orderRows(project, starting, order = []) {
  const all = [...project, ...starting];
  const byKey = new Map(all.map((r) => [r.key, r]));
  const first = [];
  for (const k of order) { const r = byKey.get(k); if (r && !first.includes(r)) first.push(r); }
  return [...first, ...all.filter((r) => !first.includes(r))];
}

// ---------------------------------------------------------------------------
//  Finer kinds (D5)
// ---------------------------------------------------------------------------

/**
 * The letters each finer kind shows in its node's core: the shortest start of the kind's name (one or two letters) that no other kind of
 * the same node type on the map shares; when two letters are still shared, the first two. A kind is any text: nothing here is an error.
 * @param {{ type: string, kind?: unknown }[]} nodes
 * @returns {Map<string, Map<string, string>>} node type to kind to letters
 */
export function kindLetters(nodes) {
  const byType = new Map();
  for (const n of nodes) {
    if (typeof n.kind !== 'string' || !n.kind) continue;
    if (!byType.has(n.type)) byType.set(n.type, new Set());
    byType.get(n.type).add(n.kind);
  }
  const out = new Map();
  for (const [type, kinds] of byType) {
    const names = [...kinds].sort();
    const m = new Map();
    for (const k of names) {
      const chars = [...k.toLowerCase()];
      const take = (len) => chars.slice(0, len).join('');
      const others = names.filter((o) => o !== k).map((o) => [...o.toLowerCase()]);
      const free = (len) => !others.some((o) => o.slice(0, len).join('') === take(len));
      m.set(k, free(1) ? take(1) : take(2));
    }
    out.set(type, m);
  }
  return out;
}

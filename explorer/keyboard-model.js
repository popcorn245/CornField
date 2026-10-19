/**
 * @module explorer/keyboard-model
 *
 * The map by keyboard (MAP-02), the pure half: what a key on the focused map means, the order the nodes are
 * stepped through, and the words a screen reader is told. No DOM; keyboard.js is the half that touches the page.
 *
 *   mapKeyAction(key, opts)   a key on the map canvas → an action, or null (the key is left to the page)
 *   readingOrder(nodes)       the visible nodes as they read: top to bottom in rows, each row left to right
 *   stepFrom(order, id, by)   the node `by` steps from `id` in that order, wrapping round (Home / End: first / last)
 *   describeNode(node, n, i)  "orders, table, 5 connections, 3 of 40"
 *   MAP_KEYS                  the key list the page shows and the help text reads
 *
 * The keys (on the focused map; a playing scenario keeps Left, Right and Space for itself):
 *   Arrow keys   pan (Shift: further)               + / -    zoom in / out        0   fit the map
 *   N / ]        the next node, selected and centred P / [    the previous one     Home / End  the first / the last
 *   Enter        into the selected node's panel     Escape   close the panel
 *   Alt+Arrow    in Freeform, move the selected node (Shift: further)
 */

/** How far one arrow press pans, in screen px (Shift: `PAN_FAR`) */
export const PAN_STEP = 60;
export const PAN_FAR = 240;
/** How far Alt+arrow moves a node in Freeform, in world units (Shift: `MOVE_FAR`) */
export const MOVE_STEP = 20;
export const MOVE_FAR = 80;
/** One + or - press */
export const ZOOM_STEP = 1.25;
/** Nodes whose centres are this close in y (world units) read as one row */
export const ROW_BAND = 40;

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** For the help text and the docs: [keys, what they do] */
export const MAP_KEYS = [
  ['Arrow keys', 'pan the map (with Shift, further)'],
  ['+ and -', 'zoom in and out'],
  ['0', 'fit the map to the screen'],
  ['N or ]', 'select the next node'],
  ['P or [', 'select the previous node'],
  ['Home and End', 'select the first and the last node'],
  ['Enter', 'go to the selected node\'s panel'],
  ['Escape', 'close the panel'],
  ['Alt and an arrow', 'in Freeform, move the selected node'],
];

/**
 * @param {string} key KeyboardEvent.key
 * @param {{shift?: boolean, alt?: boolean, ctrl?: boolean, meta?: boolean, scenario?: boolean, freeform?: boolean, selected?: boolean}} [opts]
 *   `scenario`: a scenario is playing (its player owns Left, Right and Space); `freeform`: nodes can be moved; `selected`: a node is selected
 * @returns {null | {type: 'pan', dx: number, dy: number} | {type: 'zoom', factor: number} | {type: 'fit'} | {type: 'step', by: number}
 *   | {type: 'first'} | {type: 'last'} | {type: 'open'} | {type: 'close'} | {type: 'move', dx: number, dy: number}}
 */
export function mapKeyAction(key, opts = {}) {
  const { shift = false, alt = false, ctrl = false, meta = false, scenario = false, freeform = false, selected = false } = opts;
  if (ctrl || meta) return null; // the browser's and the what-if editor's shortcuts
  const arrow = ARROWS[key];
  if (arrow) {
    if (alt) return freeform && selected ? { type: 'move', dx: arrow[0] * (shift ? MOVE_FAR : MOVE_STEP), dy: arrow[1] * (shift ? MOVE_FAR : MOVE_STEP) } : null;
    if (scenario && arrow[1] === 0) return null; // the player steps with Left and Right
    const d = shift ? PAN_FAR : PAN_STEP;
    // the content moves with the arrow's opposite: Right shows what is to the right
    return { type: 'pan', dx: -arrow[0] * d, dy: -arrow[1] * d };
  }
  if (alt) return null;
  switch (key) {
    case '+': case '=': return { type: 'zoom', factor: ZOOM_STEP };
    case '-': case '_': return { type: 'zoom', factor: 1 / ZOOM_STEP };
    case '0': return { type: 'fit' };
    case 'n': case 'N': case ']': return { type: 'step', by: 1 };
    case 'p': case 'P': case '[': return { type: 'step', by: -1 };
    case 'Home': return { type: 'first' };
    case 'End': return { type: 'last' };
    case 'Enter': return selected ? { type: 'open' } : null;
    case 'Escape': return selected ? { type: 'close' } : null;
    default: return null;
  }
}

/**
 * The order the nodes are stepped through: as the map reads, in rows of ROW_BAND, top to bottom, each left to right.
 * @template {{id: string, x: number, y: number}} T
 * @param {T[]} nodes
 * @returns {T[]}
 */
export function readingOrder(nodes) {
  return [...nodes].sort((a, b) => Math.floor(a.y / ROW_BAND) - Math.floor(b.y / ROW_BAND) || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The node `by` places from `id` in `order`, wrapping round. No `id` (or one not in the order): the first for a step
 * forward, the last for a step back.
 * @template {{id: string}} T
 * @param {T[]} order
 * @param {string|null|undefined} id
 * @param {number} by
 * @returns {T|null}
 */
export function stepFrom(order, id, by) {
  if (!order.length) return null;
  const at = id == null ? -1 : order.findIndex((n) => n.id === id);
  if (at < 0) return by >= 0 ? order[0] : order[order.length - 1];
  const n = order.length;
  return order[(((at + by) % n) + n) % n];
}

/**
 * What a screen reader is told when the keyboard lands on a node
 * @param {{label: string, type: string, degree?: number}} node
 * @param {number} [count] how many nodes the steps go through
 * @param {number} [index] this one's place among them, from 0
 */
export function describeNode(node, count, index) {
  const kind = node.type === 'external' ? 'outside service' : node.type;
  const degree = Number.isFinite(node.degree) ? `, ${node.degree} ${node.degree === 1 ? 'connection' : 'connections'}` : '';
  const place = Number.isFinite(count) && Number.isFinite(index) ? `, ${index + 1} of ${count}` : '';
  return `${node.label}, ${kind}${degree}${place}`;
}

/** The zoom in words, for the announcer */
export const zoomWords = (zoom) => `Zoom ${Math.round(zoom * 100)} percent`;

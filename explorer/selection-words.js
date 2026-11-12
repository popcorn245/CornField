/**
 * @module explorer/selection-words
 *
 * What the node panel says of a selection (spec 0008 D6): the kinds of its lit lines in the panel's order (`LINE_KINDS`, `linesByKind`), a kind's
 * panel word (`kindPanelWord`, from selection-model.js's `KIND_WORDS`), the node at the far end of each line (`farEnds`) and how much of it is in
 * view (`connectedLine`). The selection itself and where the camera goes for it are selection-model.js's: a map alone does not carry the panel's
 * words (the components' size budget, spec 0011 D11). Pure: no DOM, no state.
 */

import { KIND_WORDS, edgeKindOf } from './selection-model.js';

/** The kinds a line is drawn as, in the order the panel lists them */
export const LINE_KINDS = ['ownership', 'usage', 'flow', 'reads', 'writes', 'calls', 'triggers', 'delivers', 'runs-on', 'uses', 'extends'];

/** A kind's panel word; a kind this table does not know (a project's own) is shown as the text it is */
export const kindPanelWord = (kind) => (Object.hasOwn(KIND_WORDS, kind) ? KIND_WORDS[kind].panel : String(kind));

/**
 * The lit lines counted by kind, in LINE_KINDS order (a kind of the project's own after them, by name).
 * @param {NonNullable<ReturnType<typeof activeSubgraph>>} sub
 * @returns {{kind: string, count: number, word: string}[]}
 */
export function linesByKind(sub) {
  const rank = (k) => { const i = LINE_KINDS.indexOf(k); return i < 0 ? LINE_KINDS.length : i; };
  return [...sub.kinds.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([kind, count]) => ({ kind, count, word: kindPanelWord(kind) }));
}

/**
 * The lit lines of one kind, as the node at their far end: { node id, whether the line leaves the selection }, in map order.
 * @param {NonNullable<ReturnType<typeof activeSubgraph>>} sub
 * @param {string} kind
 */
export function farEnds(sub, kind) {
  const rows = [];
  const seen = new Set();
  for (const e of sub.edges) {
    if (edgeKindOf(e) !== kind) continue;
    const out = e.from === sub.selectedId;
    const other = out ? e.to : e.from;
    if (seen.has(other)) continue;
    seen.add(other);
    rows.push({ id: other, out });
  }
  return rows;
}

/** The words that say how much of a selection is in view: "27 connected · 9 off screen" */
export function connectedLine(connected, off) {
  return off > 0 ? `${connected} connected · ${off} off screen` : `${connected} connected · all on screen`;
}

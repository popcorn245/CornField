/**
 * @module explorer/work-badge-model
 *
 * The pure half of the Work layer on the Map view (spec 0012 D4): a small badge (`PR #27`, `Issue #14`) on each node that open work touches. No DOM, no state, no fetch;
 * work-badges.js draws them and work-view.js holds the answer they are made of (`state.work`, the one read of `GET /api/forge/work-graph` the Work view shares).
 *
 *   badgeIndex(nodes, edges)               node id -> the open work touching it, the most pressing first (waiting on you, then the newest)
 *   badgeText(items)                       "PR #27", or "PR #27 +2" when more touch the node
 *   badgeWords(items)                      what a screen reader hears of it: "2 open: PR #27, Issue #14"
 *   placeBadges(scene, zoom, index, opts)  which badges fit at this zoom, and where: the same placing as the names under the nodes (labels.js `placeLabels`)
 *   openWorkHtml(items, opts)              the node panel's "Open work" section: each item a link that opens the Work view on it (every word escaped, only http(s) links)
 *   badgeRowOf(w, wanted)                  the Layers menu's row: its count in words
 */

import { escapeHtml as esc } from '../core/text.js';
import { labelMinOf, placeLabels } from './labels.js';
import { KIND_WORDS, byLane, stateWordsOf, tagOf } from './work-model.js';
import { safeUrl } from './pieces/work-common.js';

/** The layer's key in the Layers menu and `state.activeLayers` (the Work view's own are `work-<kind>`: work-model.js) */
export const WORK_BADGE_LAYER = 'work-badges';
/** The most badges drawn at once (the node panel still lists every item) */
export const MAX_BADGES = 60;
/** A badge's text size on screen (px), and the room its pill takes beside the text, in ems of that size */
export const BADGE_PX = 11;
const PAD_EM = 1.2;
/** The height of a label's box in `placeLabels`, in sizes (labels.js: an ascent of 1 and a descent of 0.3) */
const BOX_EM = 1.3;
/** What starts the label of a badge in the placing, so its width is the pill's (a character no name begins with) */
const MARK = '\u0001';
const MARK_CODE = 1;
/** The most items a node's spoken words name before "and N more" */
const SPOKEN = 3;

/**
 * Which node is touched by which open work. The edges are the work view's (`state.work.edges`): from a piece of work to a node of code, by `changes`, `adds`, `mentions` or
 * `restarts`. Only open work counts, and a proposal that is only a file in the checkout (nobody has been asked to decide it: the Work view's Drafts) does not; a planned node
 * (a proposal's `adds`: the map does not hold it) has no badge, so it is left out here.
 * @param {object[]} nodes the Work view's nodes (work and the code it touches)
 * @param {{ from: string, to: string, tone: string }[]} edges
 * @returns {Map<string, object[]>} node id -> its items (`{ id, kind, tag, title, waiting, state, url }`), most pressing first
 */
export function badgeIndex(nodes, edges) {
  const work = new Map();
  const code = new Set();
  for (const n of nodes || []) {
    if (n.work) { if (n.item && n.item.open === true && !n.draft) work.set(n.id, n); } else if (!n.planned) code.add(n.id);
  }
  const index = new Map();
  for (const e of edges || []) {
    if (e.tone !== 'code' || !code.has(e.to)) continue;
    const from = work.get(e.from);
    if (!from) continue;
    const list = index.get(e.to) || index.set(e.to, []).get(e.to);
    if (!list.some((x) => x.id === from.id)) list.push(from);
  }
  for (const [id, list] of index) {
    list.sort(byLane); // waiting on you first, then the newest, then by id: the order of a lane
    index.set(id, list.map((n) => ({ id: n.id, kind: n.work, tag: tagOf(n.item), title: n.title, waiting: n.waiting === true, state: stateWordsOf(n.item), url: safeUrl(n.item.url) })));
  }
  return index;
}

/** The badge's text: the most pressing item's tag, then how many more touch the node */
export const badgeText = (items) => `${items[0].tag}${items.length > 1 ? ` +${items.length - 1}` : ''}`;

/** What a screen reader is told of a node: "2 open: PR #27, Issue #14", the first said to wait when it does; empty for a node no open work touches */
export function badgeWords(items) {
  if (!items || !items.length) return '';
  const named = items.slice(0, SPOKEN).map((i) => `${i.tag}${i.waiting ? ' (waiting on you)' : ''}`);
  return `${items.length} open: ${named.join(', ')}${items.length > SPOKEN ? ` and ${items.length - SPOKEN} more` : ''}`;
}

/**
 * Which badges fit at `zoom`, and where, by the rules the names under the nodes follow (labels.js `placeLabels`): the whole map's placing, kept for as long as the scene and the zoom stay,
 * the same wherever the camera is. The names are placed first and are never moved by a badge (they are the first thing `placeLabels` places here, as the selection's would be); a badge
 * is then placed in priority order, the selected node's first, then those that wait on you, then the rest (the larger the node, the more lines it has, the nearer the front), and
 * is skipped when its box (plus `LABEL_PAD`) touches a name or a badge already placed. A badge sits above its node's disc, centred on it, at its own size on screen whatever the zoom.
 * @param {import('./scene.js').Scene} scene
 * @param {number} zoom
 * @param {Map<string, object[]>} index `badgeIndex`
 * @param {{ measure?: (text: string, size: number, bold: boolean) => number, measurePill?: (text: string, size: number, bold: boolean) => number, height?: number, max?: number }} [opts]
 *   `measure`: the width of a name, in the label layer's font (as `placeLabels` takes it); `measurePill`: the width of a badge's text, in the page's font (default: `measure`);
 *   `height`: the pill's height on screen, its line and its border (px; default, and at least, the height of a name's box at the badge's size)
 * @returns {{ id: string, items: object[], text: string, l: number, t: number, r: number, b: number }[]} in priority order, boxes in zoom-scaled world coordinates (no camera)
 */
export function placeBadges(scene, zoom, index, { measure = null, measurePill = measure, height = 0, max = MAX_BADGES } = {}) {
  const min = labelMinOf(scene);
  const px = Math.max(BADGE_PX, min);
  // placeLabels gives a label a box 1.3 sizes high; a pill is as high as its line and its border, so it is placed as a label of the size whose box is that high, and its width is scaled back
  const box = Math.max(BOX_EM * px, height || 0);
  const boxPx = box / BOX_EM;
  const gap = Math.max(3, 3 * zoom);
  const mine = [];
  for (const n of scene.nodes) {
    const items = index.get(n.id);
    if (!items || !items.length || !(n.alpha > 0.2)) continue;
    const text = badgeText(items);
    // placeLabels puts a label under a disc: a box whose top is `gap` below `y + r`. The badge goes above the disc instead, so the node it is placed for sits higher by the box, the gap before and the gap after
    mine.push({
      id: n.id, type: 'work-badge', label: `${MARK}${text}`, labelAlpha: 1, labelSize: boxPx / zoom, labelBold: true, x: n.x, y: n.y - n.r - (2 * gap + box) / zoom, r: 0, degree: n.degree || 0,
      selected: false, current: n.selected === true || n.current === true, match: items[0].waiting, connected: true, mark: 'none', items, text,
    });
  }
  if (!mine.length) return [];
  // The names, placed as the label layer places them, stand in the way as if they were selected: first of all, so a badge never takes one's room
  const names = placeLabels(scene, zoom, { measure }).map((p) => ({ ...p.node, selected: true }));
  // one measure for the placing: a badge's label starts with MARK, and is the pill's text in the page's font and its room; every other label is a name, in the label layer's font
  const both = measure && measurePill ? (text, size, bold) => (text.charCodeAt(0) === MARK_CODE ? ((measurePill(text.slice(1), size, bold) + size * PAD_EM) * px) / boxPx : measure(text, size, bold)) : null;
  const placed = placeLabels({ nodes: [...names, ...mine], labelMin: scene.labelMin }, zoom, { measure: both });
  const out = [];
  for (const p of placed) {
    if (p.node.type !== 'work-badge') continue;
    out.push({ id: p.id, items: p.node.items, text: p.node.text, l: p.l, t: p.t, r: p.r, b: p.b });
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
//  The node panel's "Open work"
// ---------------------------------------------------------------------------

const dotOf = (kind, color) => { const c = typeof color === 'function' ? color(kind) : ''; return `<span class="hx-work-dot" data-corn="swatch" data-work-kind="${esc(kind)}" aria-hidden="true"${c ? ` data-style="background-color: ${esc(c)}"` : ''}></span>`; };

/**
 * The node panel's section for a node the layer badges: each piece of open work as a link that opens the Work view with it selected (`?view=work&pr=27`: the address is the link's
 * `href`, so a new tab goes there too, and a click opens the view in place), and, for the forge's own page, a second link that is there only when the address is an http(s) one.
 * Every word is the forge's: escaped, and the `url` goes through `safeUrl`.
 * @param {object[]} items `badgeIndex`'s items for the node
 * @param {{ color?: (kind: string) => string, address?: (id: string) => string | null }} [opts] `color`: a kind's colour as the map draws it; `address`: the item's `?pr=27`-style address (work-model.js `addressOf`)
 */
export function openWorkHtml(items, { color = () => '', address = () => null } = {}) {
  const rows = items.map((i) => {
    const addr = address(i.id);
    const href = `?view=work${addr ? `&${addr.slice(1)}` : ''}`;
    const out = i.url ? ` <a class="hx-faint" data-corn="open-link" href="${esc(i.url)}" target="_blank" rel="noreferrer" aria-label="Open ${esc(i.tag)} on the forge">↗</a>` : '';
    return `<li data-corn="work-link"><span class="hx-work-rel">${esc(KIND_WORDS[i.kind] || i.kind)}</span>${dotOf(i.kind, color)}<a class="hx-linkbtn" data-corn="node-link" data-work-action="open-item" data-id="${esc(i.id)}" href="${esc(href)}">${esc(i.tag)} · ${esc(i.title)}</a>${i.waiting ? ' <span class="hx-faint">waiting on you</span>' : ` <span class="hx-faint">${esc(i.state)}</span>`}${out}</li>`;
  });
  return `<div class="hx-fact" data-corn="section"><div class="hx-fact-k">Open work</div><div class="hx-fact-v"><ul class="hx-work-links" data-corn="work-links">${rows.join('')}</ul></div></div>`;
}

// ---------------------------------------------------------------------------
//  The Layers menu's row
// ---------------------------------------------------------------------------

/**
 * The row the Layers menu shows under Overlays: its count says how many nodes open work touches, or where the answer is: "reading…" while the first read is on its way, "not read yet"
 * until the layer is first on (or the Work view opened), and the refusal when the forge could not be read.
 * @param {{ status: string, badges?: Map<string, object[]> }} w the Work view's state (`state.work`)
 * @param {string} color the row's dot
 */
export function badgeRowOf(w, color) {
  const n = w.badges ? w.badges.size : 0;
  const countText = w.status === 'ok' ? `${n} ${n === 1 ? 'node' : 'nodes'}`
    : w.status === 'loading' ? 'reading…'
      : w.status === 'sign-in' ? 'sign in again'
        : w.status === 'offline' ? 'offline'
          : w.status === 'server' ? 'not read' : 'not read yet';
  return { key: WORK_BADGE_LAYER, label: 'Work', color, overlay: true, countText, desc: 'A small badge on each node that open work touches: PR #27, Issue #14, Run 000003, Spec 0100. The one that waits on you comes first, then +N. The same read as the Work view.' };
}

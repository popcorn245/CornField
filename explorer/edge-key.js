/**
 * @module explorer/edge-key
 *
 * The Key in the Layers menu (spec 0008 D7): each kind of line drawn as the map draws it, with its real style and end mark, not a coloured dot.
 * A pure function of the constants the renderers draw from (scene.js ARROW, END_SHAPES, USAGE_DASH, PROPOSED_DASH), so the Key and the map
 * cannot drift apart. Every word here is fixed text: nothing from the map reaches it.
 */

import { ARROW, END_SHAPES, PROPOSED_DASH, USAGE_DASH } from './scene.js';

const W = 44; // the swatch's width and height (px)
const H = 16;
const MID = H / 2;
const X0 = 2;
const TIP = W - 3;

/** The end mark of each family, as SVG path data with its tip at (tx, MID), in the same units the map draws it in (ARROW, END_SHAPES) */
const mark = (kind, tx) => {
  const back = ARROW.length * Math.cos(ARROW.spread);
  const side = ARROW.length * Math.sin(ARROW.spread);
  if (kind === 'triangle') return `<path d="M${tx} ${MID} L${tx - back} ${MID - side} L${tx - back} ${MID + side} Z" fill="currentColor"/>`;
  if (kind === 'chevron') return `<path d="M${tx - back} ${MID - side} L${tx} ${MID} L${tx - back} ${MID + side}" fill="none" stroke="currentColor" stroke-width="${END_SHAPES.strokeWidth}"/>`;
  if (kind === 'bar') return `<path d="M${tx - 1} ${MID - END_SHAPES.barHalf} V${MID + END_SHAPES.barHalf}" fill="none" stroke="currentColor" stroke-width="${END_SHAPES.strokeWidth}"/>`;
  if (kind === 'diamond') {
    const h = END_SHAPES.diamondHalf;
    const a = END_SHAPES.diamondAcross;
    return `<path d="M${tx} ${MID} L${tx - h} ${MID - a} L${tx - 2 * h} ${MID} L${tx - h} ${MID + a} Z" fill="none" stroke="currentColor" stroke-width="${END_SHAPES.strokeWidth}"/>`;
  }
  return '';
};

/** A swatch: a line of `width`, with `dash` (or solid), an end mark, and `ticks` across its middle */
export function keySwatch({ end = null, dash = null, width = 1.6, ticks = 0 } = {}) {
  const stop = end ? TIP - (end === 'triangle' || end === 'chevron' ? 1 : end === 'diamond' ? 2 * END_SHAPES.diamondHalf : 1) : TIP;
  const line = `<path d="M${X0} ${MID} H${stop}" fill="none" stroke="currentColor" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash.join(' ')}"` : ''}/>`;
  let tickPaths = '';
  for (let i = 0; i < ticks; i++) {
    const x = (X0 + stop) / 2 + (i - (ticks - 1) / 2) * END_SHAPES.tickGap;
    tickPaths += `<path d="M${x} ${MID - END_SHAPES.tickHalf} V${MID + END_SHAPES.tickHalf}" fill="none" stroke="currentColor" stroke-width="${END_SHAPES.tickWidth}"/>`;
  }
  return `<svg class="hx-key-line" data-corn="swatch" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" focusable="false">${line}${tickPaths}${end ? mark(end, TIP) : ''}</svg>`;
}

/** The rows of the Key: [swatch options, the words] */
export const KEY_ROWS = Object.freeze([
  [{ width: 1.4 }, 'Owns: a parent and what it holds'],
  [{ dash: USAGE_DASH, width: 1.6 }, 'Uses loosely: dotted'],
  [{ dash: PROPOSED_DASH, end: 'chevron' }, 'Proposed, not built: dashed, with its kind’s mark'],
  [{ end: 'chevron' }, 'Data: flow, reads, writes (towards the page is a read)'],
  [{ end: 'triangle' }, 'Services: calls, triggers, delivers'],
  [{ end: 'bar' }, 'Places: runs on'],
  [{ end: 'diamond' }, 'Tokens: uses, extends'],
]);

/** The Key's markup (the section's own title and its rows) */
export function edgeKeyHtml() {
  const rows = KEY_ROWS.map(([opts, words]) => `<div class="hx-legend-row"><span class="hx-legend-swatch hx-legend-swatch--wide">${keySwatch(opts)}</span><span>${words}</span></div>`).join('');
  return `<div class="hx-menu-title" data-corn="menu-title"><span>Key</span></div>${rows}<p class="hx-faint hx-key-note">A line says its kind in words when it is lit.</p>`;
}

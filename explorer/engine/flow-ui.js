/**
 * @module explorer/engine/flow-ui
 *
 * Data flow in the node panel, on an instance: the "Sends to / Gets from" block of a node's panel (the Layers menu's legend of the flow lines is
 * flow-legend.js). How a flow edge is styled is flow-style.js; the data-flow preset is flows.js `buildDataFlow` (a pure function of nodes and edges).
 */

import { escapeHtml as escHtml } from '../../core/text.js';
import { capped } from '../capped.js';

/** The "Sends to" and "Gets from" block of a node's panel */
export function flowSummary(inst, node) {
  const { state } = inst;
  const nameOf = (id) => (state.nodes.find((n) => n.id === id) || { label: id }).label;
  const flows = state.edges.filter((e) => e.kind === 'flow' && (e.from === node.id || e.to === node.id));
  const fact = (key, list, out) => (list.length
    ? `<div class="hx-fact" data-corn="section"><div class="hx-fact-k">${key}</div><div class="hx-fact-v">${capped(list.map((e) => `<div class="hx-line"><span><span class="hx-name">${escHtml(nameOf(out ? e.to : e.from))}</span> · ${escHtml(e.label)}${e.status === 'live' ? '' : ' <span class="hx-warn">(proposed)</span>'}</span></div>`))}</div></div>`
    : '');
  return fact('Sends to', flows.filter((e) => e.from === node.id), true) + fact('Gets from', flows.filter((e) => e.to === node.id && e.from !== node.id), false);
}

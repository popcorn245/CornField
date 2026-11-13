/**
 * @module explorer/engine/flow-ui
 *
 * Data flow in the Layers menu and the node panel, on an instance: the legend of the flow lines and the "Sends to / Gets from" block of a node's
 * panel. How a flow edge is styled is flow-style.js; the data-flow preset is flows.js `buildDataFlow` (a pure function of nodes and edges).
 */

import { escapeHtml as escHtml } from '../../core/text.js';
import { themed } from '../theme-model.js';
import { capped } from '../capped.js';
import { layersOf } from '../layer-model.js';
import { FLOW_STYLES } from '../flow-style.js';

/** Draws the data-flow legend into `el`, the Layers menu's own place for it (the piece that owns it says which) */
export function renderFlowLegend(inst, el) {
  if (!el) return;
  const { state } = inst;
  const activeLayers = layersOf(state);
  if (activeLayers.flow === false && activeLayers.table === false) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const row = (swatch, text) => `<div class="hx-legend-row"><span class="hx-legend-swatch">${swatch}</span><span>${text}</span></div>`;
  el.innerHTML = `
    <div class="hx-menu-section" data-corn="menu-section" part="menu-section">
      <div class="hx-menu-title" data-corn="menu-title" part="menu-title">
        <span>Data Flow</span>
      </div>
      ${Object.values(FLOW_STYLES).map((s) => row(`<span data-corn="swatch" part="swatch" class="hx-swatch-line" data-style="background:${escHtml(themed(s.color, state.theme))}"></span>`, s.label)).join('')}
    </div>`;
}

export function flowSummary(inst, node) {
  const { state } = inst;
  const nameOf = (id) => (state.nodes.find((n) => n.id === id) || { label: id }).label;
  const flows = state.edges.filter((e) => e.kind === 'flow' && (e.from === node.id || e.to === node.id));
  const fact = (key, list, out) => (list.length
    ? `<div class="hx-fact" data-corn="section"><div class="hx-fact-k">${key}</div><div class="hx-fact-v">${capped(list.map((e) => `<div class="hx-line"><span><span class="hx-name">${escHtml(nameOf(out ? e.to : e.from))}</span> · ${escHtml(e.label)}${e.status === 'live' ? '' : ' <span class="hx-warn">(proposed)</span>'}</span></div>`))}</div></div>`
    : '');
  return fact('Sends to', flows.filter((e) => e.from === node.id), true) + fact('Gets from', flows.filter((e) => e.to === node.id && e.from !== node.id), false);
}

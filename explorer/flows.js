/**
 * @module explorer/flows
 *
 * Data flow on the map:
 *  - how a flow edge is styled (its colour and label per kind; scene.js turns that into the curve,
 *    arrowhead and packet a renderer draws),
 *  - the legend and the "Data flows" block of a node's panel, and
 *  - the data-flow preset: the same topology folded into six tiers, left to right,
 *    browser -> app servers -> API -> tables -> services -> outside systems.
 *
 * Flow edges carry kind:'flow', flow:<style>, status:'live'|'proposed', label. Solid = exists
 * today, dashed = proposed. Other edge kinds (reads, writes, calls, ...) are styled by kind.
 */

import { state, nameOf, escHtml } from './state.js';
import { themed } from './theme-model.js';
import { capped } from './capped.js';
import { layersOf } from './layer-model.js';
import { FLOW_STYLES } from './flow-style.js';

export { FLOW_STYLES, flowStyleOf } from './flow-style.js';

export const flowReduceMotion = typeof window !== 'undefined' && !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// ---------------------------------------------------------------------------
//  The data-flow preset
// ---------------------------------------------------------------------------

export { buildDataFlow } from './flow-build.js';

// ---------------------------------------------------------------------------
//  Legend and the panel's "Data flows" block
// ---------------------------------------------------------------------------
export function renderFlowLegend() {
  const el = document.getElementById('flow-legend');
  if (!el) return;
  const activeLayers = layersOf(state);
  if (activeLayers.flow === false && activeLayers.table === false) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const row = (swatch, text) => `<div class="hx-legend-row"><span class="hx-legend-swatch">${swatch}</span><span>${text}</span></div>`;
  el.innerHTML = `
    <div class="hx-menu-section" data-corn="menu-section">
      <div class="hx-menu-title" data-corn="menu-title">
        <span>Data Flow</span>
      </div>
      ${Object.values(FLOW_STYLES).map((s) => row(`<span data-corn="swatch" class="hx-swatch-line" style="background:${themed(s.color, state.theme)}"></span>`, s.label)).join('')}
    </div>`;
}

export function flowSummary(node) {
  const flows = state.edges.filter((e) => e.kind === 'flow' && (e.from === node.id || e.to === node.id));
  const fact = (key, list, out) => (list.length
    ? `<div class="hx-fact" data-corn="section"><div class="hx-fact-k">${key}</div><div class="hx-fact-v">${capped(list.map((e) => `<div class="hx-line"><span><span class="hx-name">${escHtml(nameOf(out ? e.to : e.from))}</span> · ${escHtml(e.label)}${e.status === 'live' ? '' : ' <span class="hx-warn">(proposed)</span>'}</span></div>`))}</div></div>`
    : '');
  return fact('Sends to', flows.filter((e) => e.from === node.id), true) + fact('Gets from', flows.filter((e) => e.to === node.id && e.from !== node.id), false);
}

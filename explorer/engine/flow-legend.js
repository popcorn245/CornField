/**
 * @module explorer/engine/flow-legend
 *
 * The legend of the data-flow lines in the Layers menu, on an instance. Its own module, apart from the node panel's flow block (flow-ui.js), so a
 * component that has the panel and not the menu does not carry it.
 */

import { escapeHtml as escHtml } from '../../core/text.js';
import { themed } from '../theme-model.js';
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

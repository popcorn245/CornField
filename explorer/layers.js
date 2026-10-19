/**
 * @module explorer/layers
 *
 * The Layers menu: one toggle per kind of node (apps, pages, tables, services, ...) with its
 * count, plus the legend of what the lines mean. The data-flow preset ignores the toggles. Outside nodes are
 * two layers by their kind (spec 0031): Cloud, and the Public web; the Cloud legend says what a call's `when` looks like.
 */

import { state, touchScene } from './state.js';
import { render, ensureFlowLoop } from './render.js';
import { renderFlowLegend } from './flows.js';
import { layerOf } from './live-model.js';
import { WHEN_STYLES, externalLayer } from './cloud-model.js';

export const LAYER_DEFS = [
  { key: 'app', label: 'Apps', color: '#6366f1', desc: 'Subdomains' },
  { key: 'pkg', label: 'Packages', color: '#06b6d4', desc: 'Libraries' },
  { key: 'page', label: 'Pages & Routes', color: '#38bdf8', desc: 'Routes' },
  { key: 'atom', label: 'Atoms', color: '#10b981', desc: 'Base Components' },
  { key: 'molecule', label: 'Molecules', color: '#a855f7', desc: 'Composites' },
  { key: 'token', label: 'Design Tokens', color: '#ec4899', desc: 'Pollen CSS' },
  { key: 'tool', label: 'Dev Tools', color: '#f43f5e', desc: 'Utilities' },
  { key: 'flow', label: 'Data Flow', color: '#fb923c', desc: 'Tiers & sync' },
  { key: 'table', label: 'Tables', color: '#fde047', desc: 'SQLite tables, reads & writes' },
  { key: 'rom', label: 'ROM', color: '#f0abfc', desc: 'Render on Mutation' },
  { key: 'service', label: 'Services', color: '#84cc16', desc: 'API jobs, webhooks and hooks' },
  { key: 'cloud', label: 'Cloud', color: '#94a3b8', desc: 'Services outside the house that we do not control: what runs, where software comes from, accounts (topology.cloud.json)' },
  { key: 'web', label: 'Public web', color: '#94a3b8', desc: 'Any public page or picture a person points us at: not cloud' },
  { key: 'stack', label: 'Infra', color: '#a8a29e', desc: 'Compose stacks and the domains they serve' },
  // The physical world (spec 0029). `live`: drawn or placed from the live layer, which loads when one of them goes on
  { key: 'machine', label: 'Machines', color: '#78716c', desc: 'The computers the code runs on, placed in their room from the inventory (live)', live: true },
  { key: 'container', label: 'Containers', color: '#d6d3d1', desc: 'One service of a stack, from its compose file' },
  { key: 'device', label: 'Devices', color: '#2dd4bf', desc: 'Cameras, and live: phones, NFC tags, Home Assistant devices', live: true },
  { key: 'house', label: 'House', color: '#a3e635', desc: 'Floors and rooms (live)', live: true },
  { key: 'persona', label: 'People', color: '#fb7185', desc: 'Personas, with a live count of their accounts (never a name)', live: true },
];

const layerListeners = new Set();
/** Calls `fn` after a layer goes on or off (live.js starts or stops the live layer). Returns how to stop. */
export function onLayersChange(fn) {
  layerListeners.add(fn);
  return () => layerListeners.delete(fn);
}

/** The menu open or shut, and its button saying which (aria-expanded) */
function setLegendMenu(open) {
  const menu = document.getElementById('legend-dropdown');
  if (menu) menu.hidden = !open;
  const btn = document.getElementById('legend-toggle-btn');
  if (btn) btn.setAttribute('aria-expanded', String(open));
}

export function toggleLegendMenu() {
  const menu = document.getElementById('legend-dropdown');
  if (menu) setLegendMenu(menu.hidden);
}

export function closeLegendMenu() {
  setLegendMenu(false);
}

export function renderLayerToggles() {
  const container = document.getElementById('layer-toggles-container');
  if (!container) return;

  const counts = {};
  state.nodes.forEach((n) => { const key = n.type === 'external' ? externalLayer(n) : layerOf(n.type); counts[key] = (counts[key] || 0) + 1; });
  counts.flow = state.edges.filter((e) => e.kind === 'flow').length;

  container.innerHTML = LAYER_DEFS.map((layer) => {
    const on = state.activeLayers[layer.key] !== false;
    return `
      <button type="button" class="hx-toggle-row${on ? '' : ' is-off'}" data-action="toggle-layer" data-layer="${layer.key}" aria-pressed="${on}" title="${layer.desc}">
        <span class="hx-toggle-label">
          <span class="hx-dot" style="background-color: ${layer.color}; box-shadow: ${on ? `0 0 8px ${layer.color}90` : 'none'}"></span>
          <span class="hx-toggle-name">${layer.label}</span>${layer.live ? '<span class="hx-live-tag">live</span>' : ''}
        </span>
        <span class="hx-toggle-meta">
          <span class="hx-count">${counts[layer.key] || 0}</span>
          <span class="hx-tick">${on ? '✓' : '—'}</span>
        </span>
      </button>`;
  }).join('');
  renderFlowLegend();
  renderCloudLegend();
}

/** What a call into a cloud node looks like for its `when` (spec 0031 section 6), while the Cloud layer is on */
export function renderCloudLegend() {
  const el = document.getElementById('cloud-legend');
  if (!el) return;
  if (state.activeLayers.cloud === false) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `
    <div class="hx-menu-title"><span>Cloud: when an outage bites</span></div>
    ${Object.entries(WHEN_STYLES).map(([when, s]) => `<div class="hx-legend-row"><span class="hx-legend-swatch"><span class="hx-swatch-line hx-swatch-when hx-swatch-when--${when} hx-swatch-when--plain"></span></span><span>${s.legend}</span></div>`).join('')}
    <div class="hx-legend-row"><span class="hx-legend-swatch"></span><span class="hx-faint"><span class="hx-cloud-browser">(browser)</span> the visitor's browser makes the call, not our server</span></div>`;
}

function changed() {
  touchScene();
  layerListeners.forEach((fn) => fn());
  renderLayerToggles();
  render();
  ensureFlowLoop();
}

export function toggleLayer(key) {
  state.activeLayers[key] = state.activeLayers[key] === false; // a layer with no entry yet is on, as the toggles show it
  changed();
}

export function toggleAllLayers(on) {
  LAYER_DEFS.forEach((l) => { state.activeLayers[l.key] = on; });
  changed();
}

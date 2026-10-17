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

export const FLOW_STYLES = {
  outbox: { color: '#f59e0b', label: 'Outbox → API (writes)' },
  changes: { color: '#22d3ee', label: 'Change stream (reads back)' },
  trigger: { color: '#a3e635', label: 'Trigger → audit_log (seq)' },
  sync: { color: '#fb7185', label: 'Background sync (external)' },
  model: { color: '#c084fc', label: 'Model classes feed a tier' },
  rom: { color: '#f0abfc', label: 'ROM: change → re-bake → serve' },
  read: { color: '#93c5fd', label: 'Server reads rows over HTTP' },
  api: { color: '#38bdf8', label: 'App calls the API (derived from its code)' },
  build: { color: '#d6d3d1', label: 'Build script writes files' },
  reads: { color: '#fde047', label: 'Table → page (render reads)' },
  writes: { color: '#f87171', label: 'Page → table (form / action)' },
  uses: { color: '#f472b6', label: 'Stylesheet uses design tokens' },
  extends: { color: '#5eead4', label: 'Component extends a base class' },
  calls: { color: '#fb7185', label: 'Calls (service → service, outside system)' },
  triggers: { color: '#a3e635', label: 'Triggers (cron, webhook, store change)' },
  delivers: { color: '#94a3b8', label: 'Outside system → webhook endpoint' },
  'runs-on': { color: '#a8a29e', label: 'App → the stack that serves its domain' },
};

export const flowStyleOf = (edge) => FLOW_STYLES[edge.kind === 'flow' ? edge.flow : edge.kind] || FLOW_STYLES.sync;

export const flowReduceMotion = typeof window !== 'undefined' && !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// ---------------------------------------------------------------------------
//  The data-flow preset
// ---------------------------------------------------------------------------

/**
 * Folds the topology into the six tiers of the preset. A page is lifted to the app that owns
 * it (the API's endpoints become the API), edges are lifted with them and de-duplicated, and
 * only what stays inside the tiers is kept:
 *   browser   the stores that live in the visitor's browser (`tier: 'browser'` on a store, or the id `store-idb`)
 *   servers   the apps whose pages read or write rows
 *   API       the apps that own endpoints (pages with `methods`)
 *   tables    SQLite, the audit_log changefeed and every table
 *   services  the API's jobs, hooks and webhook handlers
 *   outside   the systems the API reaches: cloud nodes and the self-hosted containers
 * @returns {{ tiers: {key:string,title:string,note:string,nodes:object[]}[], ids: Set<string>, edges: object[] }}
 */
export function buildDataFlow(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const owner = new Map();
  edges.forEach((e) => {
    if (!e.kind && !e.dashed && byId.get(e.from)?.type === 'app' && byId.get(e.to)?.type === 'page') owner.set(e.to, e.from);
  });
  // A self-hosted service is the container that runs it (spec 0031 section 3, CLOUD-03): it stands in the
  // Outside tier, and the worker of its stack that sends its webhook (nextcloud-webhooks) is drawn as it
  const hosted = nodes.filter((n) => n.type === 'container' && n.selfHosted);
  const sender = new Map();
  edges.forEach((e) => {
    const from = byId.get(e.from);
    if (e.kind !== 'delivers' || from?.type !== 'container' || from.selfHosted || byId.get(e.to)?.type !== 'page') return;
    const same = hosted.filter((h) => h.stack === from.stack);
    if (same.length === 1) sender.set(from.id, same[0].id);
  });
  const lift = (id) => (byId.get(id)?.type === 'page' ? owner.get(id) || id : sender.get(id) || id);

  // The API tier: every app that owns an endpoint (a page with methods)
  const apis = new Set([...owner].filter(([page]) => Array.isArray(byId.get(page)?.methods) && byId.get(page).methods.length).map(([, app]) => app));
  const isBrowserStore = (n) => n.type === 'store' && (n.tier === 'browser' || n.id === 'store-idb');
  const withRows = new Set();
  edges.forEach((e) => {
    if (e.kind === 'reads' || e.kind === 'writes') {
      const page = e.kind === 'reads' ? e.to : e.from;
      if (byId.get(page)?.type === 'page') withRows.add(lift(page));
    }
  });
  // An app whose own code calls the API (or publishes through an outside system) has a derived `api` flow, rows or not
  edges.forEach((e) => {
    if (e.kind === 'flow' && e.flow === 'api' && byId.get(e.from)?.type === 'app') withRows.add(e.from);
  });
  const apiFlowPairs = new Set(edges.filter((e) => e.kind === 'flow' && e.flow === 'api').map((e) => `${lift(e.from)}|${lift(e.to)}`));

  const pick = (pred) => nodes.filter(pred).sort((a, b) => String(a.label).localeCompare(String(b.label)));
  const tiers = [
    { key: 'browser', title: 'Browser', note: 'saved on the device first', nodes: pick(isBrowserStore) },
    { key: 'servers', title: 'App servers', note: 'pages, no-JS forms', nodes: pick((n) => n.type === 'app' && !apis.has(n.id) && withRows.has(n.id)) },
    { key: 'api', title: 'API', note: 'where the endpoints are', nodes: pick((n) => apis.has(n.id)) },
    { key: 'tables', title: 'Tables', note: 'stores and tables', nodes: [...pick((n) => n.type === 'store' && !isBrowserStore(n)), ...pick((n) => n.type === 'table')] },
    { key: 'services', title: 'Services', note: 'jobs, hooks, webhooks', nodes: pick((n) => n.type === 'service') },
    { key: 'outside', title: 'Outside', note: 'systems the API reaches', nodes: [...pick((n) => n.type === 'external'), ...pick((n) => n.type === 'container' && n.selfHosted)] },
  ];
  const ids = new Set(tiers.flatMap((t) => t.nodes.map((n) => n.id)));

  const out = [];
  const seen = new Set();
  const add = (e, from, to) => {
    if (from === to || !ids.has(from) || !ids.has(to)) return;
    const key = `${from}|${to}|${e.kind}|${e.flow || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...e, from, to, status: e.status || 'live', phase: undefined });
  };
  edges.forEach((e) => {
    // A publisher page's `calls` edge to an outside system is the app's `api` flow already
    if (e.kind === 'calls' && apiFlowPairs.has(`${lift(e.from)}|${lift(e.to)}`)) return;
    // What a container pulls or calls itself (its image registry, its own cloud services) is not the API's data flow
    if (e.kind === 'calls' && byId.get(e.from)?.type === 'container') return;
    if (e.kind === 'flow' || ['calls', 'triggers', 'delivers'].includes(e.kind)) return add(e, lift(e.from), lift(e.to));
    if (e.kind === 'reads' || e.kind === 'writes') {
      const page = e.kind === 'reads' ? e.to : e.from;
      // A page of an app server reaches its rows through the API: only the API's own endpoints and the services touch a table here
      if (byId.get(page)?.type === 'page' && !apis.has(lift(page))) return;
      return add(e, lift(e.from), lift(e.to));
    }
  });
  return { tiers, ids, edges: out };
}

// ---------------------------------------------------------------------------
//  Legend and the panel's "Data flows" block
// ---------------------------------------------------------------------------
export function renderFlowLegend() {
  const el = document.getElementById('flow-legend');
  if (!el) return;
  const { activeLayers } = state;
  if (activeLayers.flow === false && activeLayers.table === false) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const row = (swatch, text) => `<div class="hx-legend-row"><span class="hx-legend-swatch">${swatch}</span><span>${text}</span></div>`;
  el.innerHTML = `
    <div class="hx-menu-section">
      <div class="hx-menu-title">
        <span>Data Flow</span>
      </div>
      ${Object.values(FLOW_STYLES).map((s) => row(`<span class="hx-swatch-line" style="background:${s.color}"></span>`, s.label)).join('')}
      ${row('<span class="hx-swatch-line hx-swatch-solid"></span>', '<span class="hx-faint">Solid: live today</span>')}
      ${row('<span class="hx-swatch-line hx-swatch-dashed"></span>', '<span class="hx-faint">Dashed: proposed</span>')}
    </div>`;
}

export function flowSummary(node) {
  const flows = state.edges.filter((e) => e.kind === 'flow' && (e.from === node.id || e.to === node.id));
  if (flows.length === 0) return '';
  return `<div class="hx-sec"><strong class="hx-strong">Data flows:</strong>
    ${flows.map((e) => {
      const out = e.from === node.id;
      const s = FLOW_STYLES[e.flow] || FLOW_STYLES.sync;
      return `<div class="hx-line"><span style="color:${s.color}">${out ? '→' : '←'}</span><span><span class="hx-name">${escHtml(nameOf(out ? e.to : e.from))}</span> · ${escHtml(e.label)}${e.status === 'live' ? '' : ' <span class="hx-warn">(proposed)</span>'}</span></div>`;
    }).join('')}</div>`;
}

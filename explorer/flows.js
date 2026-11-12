/**
 * @module explorer/flows
 *
 * Data flow on the map (a bridge for the legend and the panel's block, which live on the instance in engine/flow-ui.js; they go from here
 * when the last module that is not on an instance stops calling them):
 *  - how a flow edge is styled (its colour and label per kind; scene.js turns that into the curve,
 *    arrowhead and packet a renderer draws),
 *  - the legend and the "Data flows" block of a node's panel (engine/flow-ui.js), and
 *  - the data-flow preset: the same topology folded into six tiers, left to right,
 *    browser -> app servers -> API -> tables -> services -> outside systems.
 *
 * Flow edges carry kind:'flow', flow:<style>, status:'live'|'proposed', label. Solid = exists
 * today, dashed = proposed. Other edge kinds (reads, writes, calls, ...) are styled by kind.
 */

import { pageInstance } from './state.js';
import { FLOW_STYLES } from './flow-style.js';
import * as F from './engine/flow-ui.js';

export { FLOW_STYLES, flowStyleOf } from './flow-style.js';

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
//  Legend and the panel's "Data flows" block (engine/flow-ui.js, on an instance)
// ---------------------------------------------------------------------------
export const renderFlowLegend = () => F.renderFlowLegend(pageInstance());
export const flowSummary = (node) => F.flowSummary(pageInstance(), node);

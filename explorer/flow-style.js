/**
 * @module explorer/flow-style
 *
 * How a flow edge is styled: its colour and label per kind (scene.js turns that into the curve, arrowhead and packet a renderer draws).
 * Pure, so the scene can use it on any instance; flows.js (the legend, the data-flow preset) re-exports it under the old names.
 */

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

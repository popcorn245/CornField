/**
 * @module explorer/cloud-model
 *
 * Cloud on the map, the explorer's pure half (spec 0031 sections 1 and 6, CLOUD-06): no DOM, no state.
 *
 *  - `WHEN_STYLES`, `whenOf`, `whenTicks`: when an outage of a cloud service bites, read from a `calls` edge's
 *    `when` (absent = `run`), and how each looks: on the map (`ticks`: none, one, two), in the legend
 *    (`legend`), in the panel (`title`, `color`). The one place these live: scene.js, the legend, the panel and
 *    the House view's Cloud band (CLOUD-08) all read them here; the outage colours (CLOUD-07) are `color`.
 *  - `externalLayer(node)`: the Layers key of an `external` node, `cloud` or `web` (the public web, spec D3).
 *  - What the node panel shows of a cloud node (`planLabel`, `cloudUsedBy`, `nounOf`, and its facts as HTML, `cloudPanelHtml`) is cloud-panel.js's:
 *    only a node panel and an outage scenario say them, so a map alone does not load them.
 *
 * Nothing here reads an env var name, a token or a registry `match` list: a cloud node does not carry them, and
 * the panel shows only the node's own fields and the labels of the edges into it (the registry's words).
 */

/**
 * When an outage bites, in order of how soon. `dash` is the scene edge's dash (world units, like a proposal
 * mark's), null for solid; `color` is the panel's and an outage scenario's for that group.
 */
export const WHEN_STYLES = {
  run: { title: 'Breaks now', legend: 'No tick: breaks as soon as it is down', ticks: 0, color: '#f87171' },
  deploy: { title: 'Breaks at the next deploy', legend: 'One tick: breaks at the next deploy, rebuild or first run', ticks: 1, color: '#fbbf24' },
  renew: { title: 'Breaks at the next certificate renewal', legend: 'Two ticks: breaks at the next certificate renewal', ticks: 2, color: '#a78bfa' },
};

/** A `calls` edge's `when`: `run` when absent (or not one of the three) */
export const whenOf = (edge) => (edge && Object.hasOwn(WHEN_STYLES, edge.when) ? edge.when : 'run');

/**
 * The tick marks a `calls` edge carries at its middle for its `when` (spec 0008 D7): none, one for the next deploy, two for the next renewal. A dash
 * means only "proposed" on the map, so `when` is told by ticks; any other kind of edge has none
 */
export const whenTicks = (edge) => (edge && edge.kind === 'calls' ? WHEN_STYLES[whenOf(edge)].ticks : 0);

/** The Layers key of an outside node: the public web (kind `web`) is its own; every other external is Cloud */
export const externalLayer = (node) => (node && node.kind === 'web' ? 'web' : 'cloud');

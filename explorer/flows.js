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

export { buildDataFlow } from './flow-build.js';

// ---------------------------------------------------------------------------
//  Legend and the panel's "Data flows" block (engine/flow-ui.js, on an instance)
// ---------------------------------------------------------------------------
export const renderFlowLegend = () => F.renderFlowLegend(pageInstance(), pageInstance().el('flow-legend'));
export const flowSummary = (node) => F.flowSummary(pageInstance(), node);

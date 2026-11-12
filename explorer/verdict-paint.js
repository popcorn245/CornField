/**
 * @module explorer/verdict-paint
 *
 * A checked step's verdict on the map (spec 0005): the colours (`VERDICT_COLOR`) and `paintVerdict(scene, scn)`, which scene.js calls on a built
 * scene. The checks themselves (what a step asks, the batches, the words) are check-model.js's, which re-exports these: a map alone imports this
 * module and does not carry them (the components' size budget, spec 0011 D11). Pure: no DOM, no state.
 */

/**
 * The colours a checked step is drawn in, on its node or its edge. The red is brighter than a `writes`
 * edge's own (#f87171), so a refused write reads as refused, not as a write.
 */
export const VERDICT_COLOR = { allowed: '#4ade80', refused: '#ff2d55', mismatch: '#fbbf24' };
const VERDICT_GLOW = 18;
const VERDICT_EDGE_WIDTH = 4.5;

/** Whether a drawn edge is the one a step names: same ends and kind (and flow); no kind = an ownership or usage link (scene.js's rule) */
function isStepEdge(drawn, step) {
  if (drawn.from !== step.from || drawn.to !== step.to) return false;
  if (!step.kind) return drawn.kind === 'ownership' || drawn.kind === 'usage';
  return drawn.kind === step.kind && (!step.flow || drawn.key.split('|')[2] === step.flow);
}

/**
 * Colours the current step of a playing scenario by its verdict, in a built scene (after
 * `emphasiseScenario`): red refused, green allowed, amber when `expect` disagrees; a step that was not
 * checked keeps its colours. A refused edge's packet stops halfway: the write does not go through.
 * Changes only `color`, `glow`, `glowColor`, `width` and the packet: never `mark`.
 * @param {object} scene
 * @param {{ done?: boolean, current: { node?: string, edge?: object }, verdict?: Verdict }} scn the player's snapshot, with the verdict check.js put on it
 */
export function paintVerdict(scene, scn) {
  const v = scn && scn.verdict;
  if (!v || scn.done) return;
  const color = v.mismatch ? VERDICT_COLOR.mismatch : VERDICT_COLOR[v.state];
  if (!color) return;
  const { node, edge } = scn.current;
  if (node !== undefined) {
    const n = scene.nodes.find((x) => x.id === node);
    if (n) { n.color = color; n.glow = Math.max(n.glow || 0, VERDICT_GLOW); }
  } else if (edge) {
    scene.edges.forEach((e) => {
      if (!isStepEdge(e, edge)) return;
      e.color = color;
      e.glowColor = color;
      e.glow = Math.max(e.glow || 0, VERDICT_GLOW);
      e.width = Math.max(e.width || 0, VERDICT_EDGE_WIDTH);
      if (e.packet) e.packet = v.state === 'refused' && !v.mismatch ? { ...e.packet, color, glowColor: color, speed: 0, phase: 0.5 } : { ...e.packet, glowColor: color };
    });
  }
}

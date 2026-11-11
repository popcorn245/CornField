/**
 * @module explorer/diff-marks
 *
 * What the map draws for a proposal's diff marks, as plain data with no imports, so the scene (scene.js), the renderers and the
 * contrast check (core/contrast.js, for `cornfield validate`) read one list. The colours are the defaults behind `--corn-map-added|
 * changed|removed|edit: auto`, and the same hexes are `--corn-added|changed|removed|edit` in tokens.css (the dots in the bar).
 *
 * Every mark is at least 3:1 (WCAG 1.4.11) against the darkest and lightest ground the map draws, at the opacity it is drawn at:
 * an edge never fainter than EDGE_MIN_ALPHA, and a removed mark at REMOVED_ALPHA over that. A label a diff dims is drawn at
 * DIFF_LABEL_ALPHA: de-emphasised, never hidden (3:1 as well).
 */

/** The default mark colours, for the dark and the light ground */
export const DIFF_MARK_COLORS = Object.freeze({
  dark: Object.freeze({ added: '#2dd4bf', changed: '#fbbf24', removed: '#fa9292', edit: '#b49cfb' }),
  light: Object.freeze({ added: '#197c6f', changed: '#8f6703', removed: '#e20b0b', edit: '#6839f6' }),
});

/** How much of a removed node and its edge is left: faded, but still 3:1 */
export const REMOVED_ALPHA = 0.85;
/** The least opacity a mark's edge is drawn at (scene.js lifts an edge to this before the mark's own fade) */
export const EDGE_MIN_ALPHA = 0.9;
/** The opacity each mark is drawn at at its faintest (an edge; a what-if edit that removes something is faded like a removal): the contrast check measures this */
export const markOpacity = (mark) => EDGE_MIN_ALPHA * (mark === 'removed' || mark === 'edit' ? REMOVED_ALPHA : 1);

/** The opacity of the label of a node a diff dims (the node itself is at PROPOSAL_DIM_ALPHA) */
export const DIFF_LABEL_ALPHA = 0.6;

/** How a mark differs without colour: the ring's dash (`null` is solid) and whether it is struck through. Four marks, four styles. */
export const MARK_SHAPES = Object.freeze({
  added: Object.freeze({ ringDash: Object.freeze([5, 4]), edgeDash: Object.freeze([7, 5]), strike: false }), // a dashed ring
  changed: Object.freeze({ ringDash: null, edgeDash: null, strike: false }), // a plain solid ring
  removed: Object.freeze({ ringDash: null, edgeDash: Object.freeze([3, 4]), strike: true }), // a faded ring, struck through
  // a dotted ring: short marks, wide gaps (a 1.5/3.5 dot blurred into a solid ring at 1x); its line is long-dashed: dashed, as everything not built is
  // (spec 0008 D7), and not dotted, which is a usage link's (a lit one is lilac too)
  edit: Object.freeze({ ringDash: Object.freeze([2, 5]), edgeDash: Object.freeze([12, 4]), strike: false }),
});

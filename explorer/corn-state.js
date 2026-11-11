/**
 * The public `data-corn-state` values (docs/theming.md, "States"): a small fixed set a theme can rely on, whatever word the
 * forge, the runner or the model uses. A pill, a run card, a notice or a message carries one of these; a word with no
 * public meaning (a verdict not checked yet, say) carries none.
 */

/** Every value `data-corn-state` can take */
export const CORN_STATES = Object.freeze(['open', 'merged', 'closed', 'draft', 'queued', 'running', 'requested', 'claimed', 'working', 'waiting', 'done', 'failed', 'stopped', 'success', 'failure']);

/** The seven states of an agent run, in the order of its life: each has its own `data-corn-state`, colour token (`--corn-run-<state>`) and icon */
export const RUN_STATES = Object.freeze(['requested', 'claimed', 'working', 'waiting', 'done', 'failed', 'stopped']);

/** The internal words that map onto a public one: a run's status, a check's or deploy's conclusion, a mockup's review, a verdict, a notice */
const WORDS = Object.freeze({
  // A run's status: it is waiting to start, it is running, it waits on someone, or it ended
  // (a run that went quiet waits on someone; one asked to stop has not stopped yet, but is no longer under way)
  quiet: 'waiting', 'stop-requested': 'stopped',
  // A check's or deploy's conclusion
  neutral: 'done', skipped: 'done', cancelled: 'stopped',
  // A mockup's review state
  approved: 'success', unreviewed: 'waiting', changed: 'waiting', missing: 'failure',
  // The scenario player's verdict
  allowed: 'success', refused: 'failure', mismatch: 'failure', pending: 'running',
  // A notice that went well, a message about a problem
  ok: 'success', bad: 'failure',
});

/** The public state for an internal word, or '' when it has none */
export function cornState(word) {
  const w = String(word || '');
  return CORN_STATES.includes(w) ? w : WORDS[w] || '';
}

/** The `data-corn-state` attribute for markup (with its leading space), or nothing when the word has no public state */
export function cornStateAttr(word) {
  const s = cornState(word);
  return s ? ` data-corn-state="${s}"` : '';
}

/**
 * The icon of a state: a shape as well as a colour, so the states differ in greyscale and for a person who cannot tell the colours apart.
 * Each shape is its own silhouette (a dashed ring, a ring with a dot, an arc that turns, a warning triangle, a tick, a cross, a square),
 * drawn with `currentColor` so the pill's colour carries it. Only `working` and `running` move, and not under `prefers-reduced-motion`.
 */
const ICONS = Object.freeze({
  requested: '<circle cx="6" cy="6" r="4.2" stroke-dasharray="2 1.8"/>',
  queued: '<circle cx="6" cy="6" r="4.2" stroke-dasharray="2 1.8"/>',
  claimed: '<circle cx="6" cy="6" r="4.2"/><circle cx="6" cy="6" r="1.4" fill="currentColor" stroke="none"/>',
  working: '<path class="hx-state-spin" d="M6 1.8a4.2 4.2 0 1 1-4.2 4.2"/>',
  running: '<path class="hx-state-spin" d="M6 1.8a4.2 4.2 0 1 1-4.2 4.2"/>',
  waiting: '<path d="M6 1.2L11 10.4H1Z" stroke-linejoin="round"/><path d="M6 4.6v2.7M6 8.6v.1"/>',
  done: '<path d="M2 6.4l2.6 2.6L10 3.4"/>',
  success: '<path d="M2 6.4l2.6 2.6L10 3.4"/>',
  failed: '<path d="M2.6 2.6l6.8 6.8M9.4 2.6L2.6 9.4"/>',
  failure: '<path d="M2.6 2.6l6.8 6.8M9.4 2.6L2.6 9.4"/>',
  stopped: '<rect x="2.4" y="2.4" width="7.2" height="7.2" rx="1" fill="currentColor"/>',
  neutral: '<path d="M2.4 6h7.2"/>',
  skipped: '<path d="M2.4 6h7.2"/>',
  cancelled: '<circle cx="6" cy="6" r="4.2"/><path d="M3 9L9 3"/>',
});

/** The icon for a state word (a public `data-corn-state` value, or an internal word such as a check's `neutral`), as an inline SVG; '' when it has none */
export function stateIconHtml(word) {
  const shape = ICONS[String(word || '')] || ICONS[cornState(word)];
  return shape ? `<svg class="hx-state-icon" data-corn="state-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false">${shape}</svg>` : '';
}

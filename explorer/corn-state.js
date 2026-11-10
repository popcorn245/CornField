/**
 * The public `data-corn-state` values (docs/theming.md, "States"): a small fixed set a theme can rely on, whatever word the
 * forge, the runner or the model uses. A pill, a run card, a notice or a message carries one of these; a word with no
 * public meaning (a verdict not checked yet, say) carries none.
 */

/** Every value `data-corn-state` can take */
export const CORN_STATES = Object.freeze(['open', 'merged', 'closed', 'draft', 'queued', 'running', 'waiting', 'done', 'failed', 'stopped', 'success', 'failure']);

/** The internal words that map onto a public one: a run's status, a check's or deploy's conclusion, a mockup's review, a verdict, a notice */
const WORDS = Object.freeze({
  // A run's status: it is waiting to start, it is running, it waits on someone, or it ended
  requested: 'queued', claimed: 'queued', working: 'running', quiet: 'waiting', 'stop-requested': 'stopped',
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

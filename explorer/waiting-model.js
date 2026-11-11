/**
 * @module explorer/waiting-model
 *
 * What is waiting on the maintainer (spec 0010), the pure half: no DOM, no `window`, no clock of its own (`nowMs` is handed in).
 * One number says what asks for a decision: the specs to decide plus the runs waiting on an answer (D1). Everything else the
 * panel shows of it is a function of the two lists it is handed:
 *
 *   specStateOf      a listing entry's review state: its group, its pill and since when it has been that way (D3, D4)
 *   specGroups       the Specs tab's groups: To decide, With the agent, Approved, Drafts (D3), with the search applied (D5)
 *   waitingSpecs     the specs to decide, as counted (a spec whose review could not be read is not counted: nobody knows it waits)
 *   runGroups        the Runs tab's groups: Needs you, In motion, Finished, each in its order (D6)
 *   waitingRuns      the open runs that wait on an answer (`canAnswer`)
 *   waiting          the one number, and the tab with the oldest thing waiting (D2)
 *
 * The review state is the server's (`review: { verdict, by, at, current }` on a listing entry, server/proposal-pulls.js); the words that
 * come from the forge (a login, a date) are data and are escaped by the view, never here.
 */

import { canAnswer, groupRuns } from './runs-model.js';
import { relativeTime } from './review-model.js';
import { t } from './strings.js';

/** The groups of the Specs tab, in order, with the key each carries as `data-group` and the `strings` key of its title */
export const SPEC_GROUPS = Object.freeze([
  { key: 'decide', title: 'toDecide' },
  { key: 'agent', title: 'withAgent' },
  { key: 'approved', title: 'approvedGroup' },
  { key: 'drafts', title: 'drafts' },
]);

/** The groups of the Runs tab, in order */
export const RUN_GROUPS = Object.freeze([
  { key: 'needs', title: 'needsYou' },
  { key: 'motion', title: 'inMotion' },
  { key: 'finished', title: 'finished' },
]);

/** The words of a Specs group's header (a repo may say them in its own voice: `strings`) */
export function specGroupTitle(key) {
  switch (key) {
    case 'decide': return t('toDecide');
    case 'agent': return t('withAgent');
    case 'approved': return t('approvedGroup');
    default: return t('drafts');
  }
}

/** The words of a Runs group's header */
export function runGroupTitle(key) {
  switch (key) {
    case 'needs': return t('needsYou');
    case 'motion': return t('inMotion');
    default: return t('finished');
  }
}

/** The words of the proposal bar's button that goes to the run waiting on the proposal */
export const answerWord = () => t('answer');

/** Drafts past this many rows are collapsed behind their header (D3) */
export const DRAFTS_OPEN_MAX = 10;

/** The states of a spec row's pill, in the order the contract lists them; each is a fixed word (`SPEC_STATE_WORDS`), never the forge's */
export const SPEC_STATES = Object.freeze(['to-decide', 'changed', 'sent-back', 'approved', 'draft-pr', 'local', 'unknown']);

/** The pill's words for each state */
export const SPEC_STATE_WORDS = Object.freeze({
  'to-decide': 'To decide',
  changed: 'Changed since approved',
  'sent-back': 'Sent back',
  approved: 'Approved',
  'draft-pr': 'Draft PR',
  local: 'Local',
  unknown: 'Review state unknown',
});

/**
 * The public `data-corn-state` of each pill (docs/theming.md): a spec to decide and a changed one are `waiting`, approved is `success`,
 * and `sent-back` is this spec's own. A draft PR and a local copy are the `draft` they already were; an unread review is a `failure` line.
 */
export const SPEC_STATE_CORN = Object.freeze({
  'to-decide': 'waiting', changed: 'waiting', 'sent-back': 'sent-back', approved: 'success', 'draft-pr': 'draft', local: 'draft', unknown: 'failure',
});

const time = (iso) => {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * What a listing entry's review says, in one of the states above, which group it is in, and since when (ms, or null when the forge gave no date):
 *
 *  - no pull request: a draft in a checkout or a worktree (`local`, Drafts);
 *  - a draft pull request: with the agent (`draft-pr`), whatever was said on it before;
 *  - a review that could not be read (`review.error`): `unknown`. It is shown under To decide, so it is not missed, and not counted;
 *  - never reviewed, or pushed to since a send-back: to decide;
 *  - approved at the file's current hash: Approved; approved and the file changed since (`current` false): to decide, `changed`;
 *  - sent back and not pushed since: with the agent.
 * `since` is the push that is being waited on for a spec to decide (else the pull request's own dates), the review's time for the others.
 * @param {{ pull?: { draft?: boolean, createdAt?: string, updatedAt?: string, pushedAt?: string | null }, review?: { verdict?: string, at?: string, current?: boolean, error?: string } | null }} entry
 * @returns {{ group: 'decide' | 'agent' | 'approved' | 'drafts', state: string, since: number | null, counted: boolean }}
 */
export function specStateOf(entry) {
  const pull = entry && entry.pull;
  if (!pull) return { group: 'drafts', state: 'local', since: null, counted: false };
  const pushed = time(pull.pushedAt) ?? time(pull.updatedAt) ?? time(pull.createdAt);
  if (pull.draft) return { group: 'agent', state: 'draft-pr', since: time(pull.updatedAt) ?? time(pull.createdAt), counted: false };
  const review = entry.review;
  if (review && review.error) return { group: 'decide', state: 'unknown', since: pushed, counted: false };
  const at = review ? time(review.at) : null;
  if (!review || !['approved', 'notes'].includes(review.verdict)) return { group: 'decide', state: 'to-decide', since: pushed, counted: true };
  if (review.verdict === 'approved') {
    return review.current === true
      ? { group: 'approved', state: 'approved', since: at, counted: false }
      : { group: 'decide', state: 'changed', since: pushed, counted: true };
  }
  return review.current === true
    ? { group: 'agent', state: 'sent-back', since: at, counted: false }
    : { group: 'decide', state: 'to-decide', since: pushed, counted: true };
}

/** The specs that ask for a decision, as the number counts them (Drafts, draft PRs, sent-back, approved and unread ones are not) */
export const waitingSpecs = (entries) => (Array.isArray(entries) ? entries.filter((e) => specStateOf(e).counted) : []);

/** Whether a row matches the search: its title, slug or summary contains every word typed, in any case (D5) */
export function specMatches(entry, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${entry.title || ''}\n${entry.slug || ''}\n${entry.summary || ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Oldest first; a row with no date is last */
const oldest = (a, b) => (a.since ?? Infinity) - (b.since ?? Infinity);
/** Newest first; a row with no date is last */
const newest = (a, b) => (b.since ?? -Infinity) - (a.since ?? -Infinity);

/**
 * The Specs tab's groups. Empty groups are left out (D3), unless the search emptied them: then the header still says "0 of 6" so the
 * list does not seem to lose them. Each row is `{ entry, state, since }`. Within a group: To decide waiting longest first, With the agent
 * and Approved newest first, Drafts by slug (spec number first, as the files are named).
 * @param {object[]} entries one row for each proposal (`mergeSpecs`)
 * @param {{ query?: string }} [opts]
 * @returns {{ key: string, title: string, total: number, shown: number, rows: { entry: object, state: string, since: number | null, counted: boolean }[], collapsed: boolean }[]}
 */
export function specGroups(entries, { query = '' } = {}) {
  const rows = (Array.isArray(entries) ? entries : []).map((entry) => ({ entry, ...specStateOf(entry) }));
  const filtering = String(query || '').trim() !== '';
  const out = [];
  for (const g of SPEC_GROUPS) {
    const all = rows.filter((r) => r.group === g.key);
    if (!all.length) continue;
    const kept = all.filter((r) => specMatches(r.entry, query));
    if (filtering && !kept.length) continue; // a search with no match in a group drops its header: "2 of 6" is for a group with something to show
    const sorted = [...kept].sort(g.key === 'decide' ? oldest : g.key === 'drafts' ? (a, b) => String(a.entry.slug).localeCompare(String(b.entry.slug)) : newest);
    out.push({ key: g.key, title: g.title, total: all.length, shown: kept.length, rows: sorted, collapsed: g.key === 'drafts' && !filtering && all.length > DRAFTS_OPEN_MAX });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Runs
// ---------------------------------------------------------------------------

/** Statuses that are under way: asked for, claimed, working, or asked to stop and not stopped yet (D6) */
const IN_MOTION = new Set(['requested', 'claimed', 'working', 'stop-requested']);

/**
 * Which group a run is in: `needs` (`waiting`, nobody asked it to stop: `canAnswer`), `motion`, or `finished` (done, failed, stopped, and quiet,
 * which no longer counts as open). A status this does not know is finished: it is not asking anything.
 * @returns {'needs' | 'motion' | 'finished'}
 */
export function runGroupOf(run) {
  if (canAnswer(run)) return 'needs';
  if (run.open === true && IN_MOTION.has(run.status)) return 'motion';
  return 'finished';
}

/** The runs waiting on an answer */
export const waitingRuns = (runs) => (Array.isArray(runs) ? runs.filter(canAnswer) : []);

/** When a run began to wait: its latest report (the question), else when it was asked (ms, or null) */
export function waitingSinceOf(run) {
  const reports = (run.timeline || []).filter((e) => e && e.kind === 'report' && time(e.at) !== null);
  if (reports.length) return Math.max(...reports.map((e) => time(e.at)));
  return time(run.requestedAt);
}

/**
 * The Runs list in groups (D6): Needs you, oldest question first; In motion, newest first; Finished, newest first. Runs of one request under
 * several profiles stay together (`groupRuns`), in the group of the most urgent of them. Empty groups are left out.
 * @param {object[]} runs
 * @returns {{ key: string, title: string, items: ReturnType<typeof groupRuns>, count: number }[]}
 */
export function runGroups(runs) {
  const rank = { needs: 0, motion: 1, finished: 2 };
  const placed = groupRuns(Array.isArray(runs) ? runs : []).map((item) => {
    const members = item.kind === 'run' ? [item.run] : item.runs;
    const key = members.map(runGroupOf).sort((a, b) => rank[a] - rank[b])[0];
    const here = members.filter((r) => runGroupOf(r) === key);
    const when = key === 'needs' ? Math.min(...here.map((r) => waitingSinceOf(r) ?? Infinity)) : Math.max(...members.map((r) => time(r.requestedAt) ?? -Infinity));
    return { item, key, when, count: members.length };
  });
  return RUN_GROUPS.map((g) => {
    const mine = placed.filter((p) => p.key === g.key).sort((a, b) => (g.key === 'needs' ? a.when - b.when : b.when - a.when));
    return { key: g.key, title: g.title, items: mine.map((p) => p.item), count: mine.reduce((n, p) => n + p.count, 0) };
  }).filter((g) => g.items.length);
}

// ---------------------------------------------------------------------------
//  The number
// ---------------------------------------------------------------------------

/**
 * What waits on the maintainer: `specs` (to decide) plus `runs` (waiting on an answer), `total`, and the tab that holds the oldest thing
 * waiting: Specs or Runs ('work' is the Runs tab's kind), null when nothing waits. A list that has not been read counts nothing.
 * @param {{ specs?: object[] | null, runs?: object[] | null }} lists
 * @returns {{ specs: number, runs: number, total: number, oldest: 'specs' | 'work' | null }}
 */
export function waiting({ specs, runs } = {}) {
  const s = waitingSpecs(specs);
  const r = waitingRuns(runs);
  const sSince = s.length ? Math.min(...s.map((e) => specStateOf(e).since ?? Infinity)) : null;
  const rSince = r.length ? Math.min(...r.map((x) => waitingSinceOf(x) ?? Infinity)) : null;
  let oldest = null;
  if (s.length && r.length) oldest = (rSince ?? Infinity) < (sSince ?? Infinity) ? 'work' : 'specs';
  else if (s.length) oldest = 'specs';
  else if (r.length) oldest = 'work';
  return { specs: s.length, runs: r.length, total: s.length + r.length, oldest };
}

/** "3 waiting on you" (the Work button's name, spoken: "Work, 3 waiting on you"), or '' when nothing waits */
export const waitingWords = (n) => (n > 0 ? `${n} ${t('waitingOnYou')}` : '');

/** The Work button's accessible name: its label, then what waits ("Work, 3 waiting on you") */
export const workButtonName = (label, n) => (n > 0 ? `${label}, ${waitingWords(n)}` : label);

/** What a group's header says: "To decide · 2", or "To decide · 2 of 6" while a search narrows it */
export const groupCountWords = (g) => (g.shown === g.total ? String(g.total) : `${g.shown} of ${g.total}`);

/**
 * The words under a spec row's pill: who and when ("Approved by maintainer-one · 2 h ago", "Sent back by maintainer-one · yesterday",
 * "Waiting 2 days"), or '' when there is nothing to add. `by` and the dates come from the forge: the caller escapes the result.
 * @param {{ pull?: object, review?: { verdict?: string, by?: string, at?: string, error?: string } | null }} entry
 * @param {number} nowMs
 */
export function specStateWords(entry, nowMs) {
  const s = specStateOf(entry);
  const review = entry.review;
  const ago = (ms) => (ms === null ? '' : relativeTime(new Date(ms).toISOString(), nowMs) || '');
  const by = (verb) => [`${verb}${review && review.by ? ` by ${review.by}` : ''}`, ago(time(review && review.at))].filter(Boolean).join(' · ');
  switch (s.state) {
    case 'approved': return by('Approved');
    case 'sent-back': return by('Sent back');
    case 'changed': return `${by('Approved')}; changed since`;
    case 'to-decide': {
      const w = s.since === null ? '' : ago(s.since);
      return !w ? '' : w === 'just now' ? 'Just arrived' : `Waiting ${w.replace(/ ago$/, '')}`;
    }
    default: return '';
  }
}

// ---------------------------------------------------------------------------
//  The proposal bar's line
// ---------------------------------------------------------------------------

/** The open run waiting on an answer that is about proposal `slug`, the one that has waited longest; null when none is */
export function runWaitingOn(runs, slug) {
  if (!slug) return null;
  const mine = waitingRuns(runs).filter((r) => r.refs && r.refs.proposal === slug);
  return mine.sort((a, b) => (waitingSinceOf(a) ?? Infinity) - (waitingSinceOf(b) ?? Infinity))[0] || null;
}

/** The longest the runner's question is shown in the bar's line, in characters */
export const LINE_NOTE_MAX = 90;

/**
 * The bar's line: "A run is waiting on you: Plan ready: approve to build, or say what to change". The runner's own words are cut to
 * `LINE_NOTE_MAX` characters (the whole of it is in the run's card) and are data: the caller sets them as text.
 * @param {{ report?: { note?: string } | null }} run
 */
export function waitingLineWords(run) {
  const note = run && run.report && typeof run.report.note === 'string' ? run.report.note.replace(/\s+/g, ' ').trim() : '';
  const cut = note.length > LINE_NOTE_MAX ? `${note.slice(0, LINE_NOTE_MAX - 1).trimEnd()}\u2026` : note;
  return `A run is waiting on you${cut ? `: ${cut}` : ''}`;
}

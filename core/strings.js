/**
 * @module core/strings
 *
 * The words a repo may say in its own voice (`strings` in cornfield.config.js, docs/theming.md "Words"). ONE table, `STRINGS`,
 * holds every overridable label and its default. The config check (core/config.js, so `cornfield validate`), the browser
 * (explorer/strings.js; this file is served to it, server/server.js BROWSER_CORE) and the docs table (`stringsTable`, kept in step by
 * a test) all read it, so the three cannot drift.
 *
 * A value is plain text: it reaches the page through textContent and attributes only, never as HTML, so `<b>` is shown as the
 * characters it is. One line, at most MAX_STRING_LENGTH characters. A missing key means the default; an unknown key is refused.
 */

/** Overridable label by key: the default words. Keys are camelCase; add one here and the docs test says what else to update. */
export const STRINGS = Object.freeze({
  // The header
  layers: 'Layers',
  dataFlow: 'Data flow',
  house: 'House',
  proposals: 'Proposals',
  issuesAndPrs: 'Issues & PRs',
  searchPlaceholder: 'Search...',
  signOut: 'Sign out',
  poweredBy: 'powered by cornfield',
  // The proposal bar and the review
  before: 'Before',
  diff: 'Diff',
  after: 'After',
  closeProposal: 'Close',
  approve: 'Approve',
  sendBack: 'Send back',
  reviewNoteLabel: 'Note for the drafting agent',
  reviewNotePlaceholder: 'What should change? Needed to send it back, optional to approve.',
  // The Work panel: its tabs run in the order of the loop
  tabSpecs: 'Specs',
  tabPulls: 'PRs',
  tabIssues: 'Issues',
  tabThreads: 'Threads',
  tabRuns: 'Runs',
  tabDeploys: 'Deploys',
  newIdea: 'New idea',
  landIt: 'Land it',
  // Agent runs
  startAgent: 'Start an agent',
  askRunner: 'Ask the runner',
  startAgain: 'Start again',
  stop: 'Stop',
  continueRun: 'Continue',
  reply: 'Reply',
  // The node panel
  propsTitle: 'Properties & Attributes',
  detailsTitle: 'Details',
  openRoute: 'Open Live Route',
  copySpec: 'Copy Spec',
  // The hint, loading and errors
  hintInspect: 'Tap node to inspect live spec',
  hintDrag: 'Drag nodes to move • Double-tap to inspect',
  hintDataFlow: 'Data flow: browser → servers → API → tables → services → outside',
  loading: 'Loading topology.json …',
  errorTitle: 'The map could not be loaded',
  retry: 'Retry',
});

/** The longest a value may be, in characters */
export const MAX_STRING_LENGTH = 80;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Whether `key` is one of the table's (an own key: `__proto__` and `toString` are not) */
export const isStringKey = (key) => typeof key === 'string' && Object.hasOwn(STRINGS, key);
/** A line break or any other control character */
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');
/**
 * What is wrong with one value, or null.
 * @param {unknown} v
 * @returns {string|null}
 */
export function stringProblem(v) {
  if (typeof v !== 'string') return 'is text';
  if (!v.trim()) return 'is empty (leave the key out to keep the default)';
  if (CONTROL.test(v)) return 'is one line of plain text (no line break or control character)';
  if ([...v].length > MAX_STRING_LENGTH) return `is at most ${MAX_STRING_LENGTH} characters`;
  return null;
}

/**
 * What is wrong with a `strings` value (as the config file wrote it). HTML is not a problem: it is shown as text.
 * @param {unknown} s
 * @returns {string[]}
 */
export function stringsProblems(s) {
  if (s === undefined) return [];
  if (!isObject(s)) return ['"strings" is an object of labels: { approve: \'Ship it\' }.'];
  const out = [];
  for (const [key, value] of Object.entries(s)) {
    if (!isStringKey(key)) { out.push(`strings: unknown key "${key}". Known: ${Object.keys(STRINGS).join(', ')}.`); continue; }
    const problem = stringProblem(value);
    if (problem) out.push(`strings.${key} ${problem}.`);
  }
  return out;
}

/**
 * The overrides the browser is sent: known keys with a good value, nothing else (the defaults live in the browser already).
 * @param {unknown} s
 * @returns {Record<string, string>}
 */
export function clientStrings(s) {
  const out = {};
  if (!isObject(s)) return out;
  for (const [key, value] of Object.entries(s)) if (isStringKey(key) && !stringProblem(value)) out[key] = value;
  return out;
}

/** The docs' key table (docs/theming.md "Words"), generated from STRINGS; a test fails when the docs hold anything else */
export function stringsTable() {
  const cell = (v) => v.replace(/\|/g, '\\|');
  return ['| Key | Default |', '|---|---|', ...Object.entries(STRINGS).map(([k, v]) => `| \`${k}\` | ${cell(v)} |`)].join('\n');
}

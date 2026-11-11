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
  dataFlow: 'Flow',
  house: 'House',
  proposals: 'Proposals',
  issuesAndPrs: 'Work',
  searchPlaceholder: 'Search...',
  searchNoMatch: 'No match for',
  signOut: 'Sign out',
  poweredBy: 'powered by cornfield',
  // The proposal bar and the review
  before: 'Before',
  diff: 'Diff',
  after: 'After',
  closeProposal: 'Close',
  approve: 'Approve',
  sendBack: 'Send back',
  sendBackWithNote: 'Send back with this note',
  reviewNoteLabel: 'Note for the drafting agent',
  reviewNotePlaceholder: 'What should change?',
  openSpecsList: 'Open the Specs list',
  // The review column and the scenario player
  changes: 'Changes',
  personasAndScenarios: 'Personas and scenarios',
  scenarios: 'Scenarios',
  anyone: 'Anyone',
  notInAnyScenario: 'Not in any scenario',
  steps: 'Steps',
  previousStep: 'Previous',
  nextStep: 'Next',
  pause: 'Pause',
  play: 'Play',
  playAgain: 'Play again',
  nextScenario: 'Next scenario',
  notChecked: 'Not checked',
  // The Work panel: its tabs run in the order of the loop
  tabSpecs: 'Specs',
  tabPulls: 'PRs',
  tabIssues: 'Issues',
  tabThreads: 'Threads',
  tabRuns: 'Runs',
  tabDeploys: 'Deploys',
  // What is waiting on you (spec 0010): the badge, the Specs groups, the Runs groups, the answer
  waitingOnYou: 'waiting on you',
  toDecide: 'To decide',
  withAgent: 'With the agent',
  approvedGroup: 'Approved',
  drafts: 'Drafts',
  needsYou: 'Needs you',
  inMotion: 'In motion',
  finished: 'Finished',
  answer: 'Answer',
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
  openFile: 'Open file',
  openRoute: 'Open route',
  startRun: 'Start a run',
  copySpec: 'Copy Spec',
  // The hint, loading and errors
  hintInspect: 'Click a node to see what it is',
  hintInspectTouch: 'Tap a node to see what it is',
  hintDrag: 'Drag nodes to move • Double-click to inspect',
  hintDragTouch: 'Drag nodes to move • Double-tap to inspect',
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

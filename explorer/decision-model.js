/**
 * @module explorer/decision-model
 *
 * The pure half of the decision (spec 0007): what the line above Approve says in this exact state (D1), whether a press is allowed, asks first
 * or is refused (D2), the words of the hold (D3) and of what is sent with a review (D4). No DOM, no `window`, no clock (the time is passed in).
 * review.js is the half that touches the page; the words and the choices are here so each row of the spec's two tables is a test.
 *
 * The facts come from `GET /proposals/<slug>/decision` (server/decision.js): `{ pull: { number, draft, head }, checks: { total, passed, running,
 * failed: [names] } | null, lands, landing, run: null | { kind, transport, runner, lastSeen, open, fired } }`. Everything in them from the forge (names) is text,
 * and it only ever becomes text: this module builds strings, never markup. The server decides; these words are a courtesy before the click.
 *
 *   decide(input)            { line, approve: 'allowed' | 'asks' | 'done' | 'refused' | 'reading', reasons, ask, askButton }
 *   sendBackLine(...)        the line under the note: "Posts your note and 2 edits on PR #23 for the drafting agent. No run is asked for."
 *   sendBackDecision(...)    whether Send back asks (an open form), and the words
 *   newReasons(...)          the reasons to ask that the maintainer has not already answered (the end of the hold reads the facts again)
 *   refusalWords(...)        the server's 401 and 403 at the press, in words
 *   holdWords / HOLD_MS      "Approving in 5 s", and the hold itself (one constant)
 *   editsSentWords(n)        "Sent with 2 edits"
 */

import { agoShort } from './runs-model.js';
import { pullNumberOf } from './proposal-model.js';

/** The hold between a press and anything leaving the page (D3), in milliseconds: one constant */
export const HOLD_MS = 5000;
/** How long a landing waits for the PR to be ready and green, in minutes (server/lander.js TIMEOUT_MS; test/server/decision.test.js holds them equal) */
export const LAND_MINUTES = 60;
/** The most check names a line spells out; the rest is "and N more" */
const NAMES_SHOWN = 3;
/** The longest a check's name is in a line (the forge's text, cut) */
const NAME_CHARS = 40;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const cut = (s) => { const t = oneLine(s); return t.length > NAME_CHARS ? `${t.slice(0, NAME_CHARS - 1)}…` : t; };

/** "lint", "lint and test", "lint, test and e2e", "lint, test, e2e and 2 more": names from the forge, as text */
export function nameList(names) {
  const shown = names.slice(0, NAMES_SHOWN).map(cut);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  return shown.length < 2 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

const failedOf = (facts) => (facts && facts.checks && Array.isArray(facts.checks.failed) ? facts.checks.failed : []);
const runningOf = (facts) => (facts && facts.checks ? facts.checks.running || 0 : 0);

/** "lint failed", "lint and test failed", "3 checks failed"-less: always the names */
const failedWords = (names) => `${nameList(names)} failed`;

// ---------------------------------------------------------------------------
//  The line (D1)
// ---------------------------------------------------------------------------

/** What an approval asks for besides posting, and whether the runner is there: the parts after the PR's (D1's last four rows) */
export function runWords(run, nowMs) {
  if (!run) return '';
  const kind = ['code', 'summary', 'brief', 'proposal'].includes(run.kind) ? run.kind : 'code';
  const what = kind === 'code' ? 'a code run' : `a ${kind} run`;
  // The trigger skips a run while one is open on the PR or the proposal, and asks once per head: the line must not promise one
  if (run.open) return `No new run is asked for: ${typeof run.open === 'string' ? `run ${oneLine(run.open).slice(0, 40)} is` : 'one is'} still open on it.`;
  if (run.fired) return `No new run is asked for: ${what} was asked for at this head already.`;
  const asked = `Then ${what} is asked for.`;
  if (run.transport !== 'pull') return `${asked} The request is posted for your runner.`;
  if (run.runner === 'online') return `${asked} A runner is online.`;
  const seen = typeof run.lastSeen === 'string' ? Date.parse(run.lastSeen) : NaN;
  if (run.runner === 'quiet' && Number.isFinite(seen)) return `${asked} No runner has polled for ${agoShort(nowMs - seen)}: the run will wait.`;
  return `${asked} No runner has polled yet: the run will wait.`;
}

/** Whether a run would wait for a runner that is not there: the Work button's dot and the notices say so (#183) */
export const runWaits = (run) => !!run && run.transport === 'pull' && (run.runner === 'quiet' || run.runner === 'never');

/** "Your 2 edits go in the comment, for the agent to fold in." */
export const editsWords = (edits) => (edits > 0 ? `Your ${plural(edits, 'edit')} ${edits === 1 ? 'goes' : 'go'} in the comment, for the agent to fold in.` : '');

/** The PR and its checks, and what landing does about them: the first parts of the line (D1's first nine rows) */
function pullWords(facts) {
  const n = facts.pull.number;
  const lands = !!facts.lands;
  if (facts.pull.draft) {
    return lands
      ? `PR #${n} is a draft. Approve posts an approval; it lands only if the PR is marked ready within ${LAND_MINUTES} minutes.`
      : `PR #${n} is a draft. Approve posts an approval on it.`;
  }
  const head = `Approve posts an approval on PR #${n}.`;
  const checks = facts.checks;
  const failed = failedOf(facts);
  const running = runningOf(facts);
  if (failed.length) return lands ? `${head} It will not land: ${failedWords(failed)}.` : `${head} ${failedWords(failed)}.`;
  if (checks && checks.total === 0) return lands ? `${head} It will not land: the PR has no checks.` : `${head} It does not land it.`;
  if (running) {
    if (!lands) return `${head} ${running === 1 ? '1 check is' : `${running} checks are`} still running.`;
    return `${head} It lands once ${running === 1 ? '1 running check passes' : `${running} running checks pass`}.`;
  }
  if (checks && !checks.passed) return lands ? `${head} It will not land: no check has passed.` : `${head} It does not land it.`; // all skipped or neutral
  return lands ? `Approve posts an approval on PR #${n} and lands it.` : `${head} It does not land it.`;
}

/** The line while Approve reads Approved: what stands, and what makes it live again */
function doneWords(n, facts) {
  const landing = facts && facts.landing ? ' Its landing waits for the checks.' : '';
  return `An approval of this version of PR #${n} stands.${landing} A push makes Approve live again.`;
}

/**
 * Why a press asks first, in the order of D2's table (checks failed, a draft, an open form, edits with landing). Each is `{ key, text }` where
 * `text` is the reason as a sentence; the question follows it.
 * @param {{ facts: object|null, edits: number, form: { name: string } | null }} input
 */
export function askReasons({ facts, edits = 0, form = null }) {
  const out = [];
  if (facts && facts.pull) {
    const failed = failedOf(facts);
    if (failed.length) out.push({ key: 'failed', text: `${failedWords(failed)} on PR #${facts.pull.number}.` });
    if (facts.pull.draft) out.push({ key: 'draft', text: `PR #${facts.pull.number} is a draft: its author has not marked it ready.` });
  }
  if (form) out.push({ key: 'form', text: `Your ${oneLine(form.name)} form is not added.` });
  if (facts && facts.pull && facts.lands && edits > 0) out.push({ key: 'edits', text: `PR #${facts.pull.number} lands as written; your ${plural(edits, 'edit')} only go${edits === 1 ? 'es' : ''} in the comment.` });
  return out;
}

/** The question for the reasons that ask: one reason ends as D2's table does, several are said together and end "Approve anyway?" */
export function askWords(reasons, verb = 'Approve') {
  if (!reasons.length) return '';
  const only = reasons.length === 1 ? reasons[0] : null;
  const last = only && only.key === 'form' ? `${verb} without it?` : `${verb} anyway?`;
  return `${reasons.map((r) => r.text).join(' ')} ${last}`;
}

/** The reasons that ask now and the maintainer has not answered yet (`answered`: the keys confirmed with "Approve anyway"): at the end of the hold, only a new one asks again */
export const newReasons = (reasons, answered) => reasons.filter((r) => !answered.includes(r.key));

/**
 * The line above Approve and what a press of it does, from the facts and the page's own state.
 * @param {object} input
 * @param {string|null} input.source the proposal's source: `pull/<n>`, `checkout` or a worktree
 * @param {object|null} input.facts the route's answer, or null
 * @param {'loading'|'ready'|'unread'} input.factsState `loading` before the first answer, `unread` when it could not be read
 * @param {{ verdict: string, current?: boolean }|null} [input.review] the last review of the proposal
 * @param {number} [input.edits] the applied what-if edits
 * @param {{ name: string }|null} [input.form] a what-if form that is open with something in it
 * @param {string} [input.played] "2 of 3 scenarios played", when there is a record
 * @param {number} [input.now]
 * @returns {{ line: string, approve: 'allowed'|'asks'|'done'|'refused'|'reading', reasons: {key:string,text:string}[], ask: string }}
 */
export function decide({ source, facts, factsState, review = null, edits = 0, form = null, played = '', now = Date.now() }) {
  const n = pullNumberOf(source);
  const tail = (...parts) => parts.filter(Boolean).join(' ');
  if (!n) {
    const where = !source || source === 'checkout' ? 'the checkout' : `worktree ${oneLine(source)}`;
    return { line: `Draft in ${where}: push it as a spec PR to review it here.`, approve: 'refused', reasons: [], ask: '' };
  }
  const done = !!review && review.verdict === 'approved' && review.current === true;
  if (factsState === 'loading' || (!facts && factsState !== 'unread')) {
    return { line: tail(`Reading PR #${n} …`, played), approve: done ? 'done' : 'reading', reasons: [], ask: '' };
  }
  if (!facts || factsState === 'unread') {
    return { line: tail(`Could not read PR #${n}'s checks. Approve posts an approval on it.`, editsWords(edits), played), approve: done ? 'done' : 'allowed', reasons: askReasons({ facts: null, edits, form }), ask: '' };
  }
  const reasons = askReasons({ facts, edits, form });
  const run = facts.run ? runWords(facts.run, now) : '';
  const line = tail(pullWords(facts), run, editsWords(edits), played);
  // Approve does nothing now (an approval of this version stands): the line says that, not what a press would post
  if (done) return { line: tail(doneWords(n, facts), played), approve: 'done', reasons, ask: '' };
  return { line, approve: reasons.length ? 'asks' : 'allowed', reasons, ask: askWords(reasons) };
}

// ---------------------------------------------------------------------------
//  Send back (D4)
// ---------------------------------------------------------------------------

/** The line under the note: what Send back posts, and that it asks for no run */
export function sendBackLine({ source, edits = 0 }) {
  const n = pullNumberOf(source);
  if (!n) return '';
  const what = edits > 0 ? `your note and ${plural(edits, 'edit')}` : 'your note';
  return `Posts ${what} on PR #${n} for the drafting agent. No run is asked for.`;
}

/** Whether Send back asks first: only an open form that holds input does (D4). `{ asks, ask }` */
export function sendBackDecision({ form = null }) {
  const reasons = askReasons({ facts: null, edits: 0, form });
  return { asks: reasons.length > 0, reasons, ask: askWords(reasons, 'Send back') };
}

// ---------------------------------------------------------------------------
//  The server's refusals at the press (D2), in words
// ---------------------------------------------------------------------------

/**
 * What a refused review says. 401: the sign-in has ended; 403: the server's own words (a maintainer who is one no longer, a page that is not
 * cornfield's own); 409: what stands already. Anything else is the server's words with the plain statement that nothing was posted.
 * @param {number} status
 * @param {string} [error] the server's words
 */
export function refusalWords(status, error = '') {
  if (status === 401) return 'Your sign-in has ended. Sign in again: your edits are kept here.';
  const said = oneLine(error);
  if (status === 403 || status === 409) return said || 'The review was not posted.';
  return `The review was not posted. ${said || `The server answered ${status}.`}`;
}

// ---------------------------------------------------------------------------
//  The hold (D3)
// ---------------------------------------------------------------------------

/** The button's words while the hold runs: "Approving in 5 s", "Sending back in 4 s" */
export const holdWords = (verdict, seconds) => `${verdict === 'approved' ? 'Approving' : 'Sending back'} in ${Math.max(0, Math.ceil(seconds))} s`;

/** What is said once when the hold starts (a live region): not every second */
export const holdStartWords = (verdict, seconds) => `${verdict === 'approved' ? 'Approving' : 'Sending back'} in ${plural(Math.ceil(seconds), 'second')}. Undo to stop it; nothing has been sent.`;

/** What is said when a hold is cancelled, and why: it always ends "Nothing was sent." */
export function holdCancelledWords(verdict, why) {
  const what = verdict === 'approved' ? 'The approval' : 'The send back';
  const because = {
    undo: `${what} was undone.`,
    escape: `${what} was undone.`,
    closed: `${what} was stopped: the proposal was closed.`,
    other: `${what} was stopped: another proposal was opened.`,
    hidden: `${what} was stopped: this tab was hidden.`,
    offline: `${what} was stopped: you are offline.`,
    edits: `${what} was stopped: your edits changed.`,
    pushed: `${what} was stopped: the PR was pushed to while it was held, so it is not what you looked at. Look again before you decide.`,
  }[why] || `${what} was stopped.`;
  return `${because} Nothing was sent.`;
}

/** What a send back leaves readable: "Sent with 2 edits" (D4) */
export const editsSentWords = (count) => `Sent with ${plural(count, 'edit')}`;

/**
 * @module server/run-thread
 *
 * The text of a run's **status comment** (issue #104, docs/agents.md#a-thread-for-every-run): the one comment cornfield keeps in the
 * thread a run is about and edits in place as the run moves. Pure; server/agent-runs.js decides when to post and when to edit.
 *
 * What the comment never is, so that mirroring can start no run and move none:
 *
 *   - **No `cornfield-run` block.** Not a request, not a report, not a stop request, not an answer: no fence at all. A follow reads
 *     reports from a maintainer and the comment is written as one, so a copy of a report would be read back as a second report; a
 *     request block would be a hand-written request (`discover`). The runner's note is quoted line by line (`> `), as the contract's own
 *     comments do, after every line end the forge knows (`\r` too) is made `\n`, and its backticks and runs of tildes are broken: no fence
 *     opens in it, and a `/agent` line (server/triggers.js) or a heading in it is text inside a quote.
 *   - **Defused.** Every mention, reference and link in what a runner or a person wrote is broken (core/defuse.js), and a `[[node]]`
 *     mention is broken too, so the comment pings nobody, links nothing and lights nothing on the map; `<` and `[` are escaped, so no HTML,
 *     Markdown link or image (`[x](//elsewhere)`) is made of it either. The only live link is the run's pull request, whose number and
 *     address are the forge's own; the runner's `url` is never written (the dashboard shows it).
 *   - **Only what moves.** No time a runner sends changes the text: a runner reporting the same state every few seconds writes the same
 *     comment, so its hash is unchanged and nothing is edited.
 *   - **No secret.** It is made of the run's public form (`publicRun`), which holds none, and a report's text was checked for credentials
 *     when it was accepted (core/agent-contract.js); the text is cut short besides.
 *
 * The marker on its first line names the run, so a person reading the source of the comment knows whose it is. cornfield finds its comment
 * by the id it kept (`run_mirrors`), never by the marker: the marker is not trusted as an address.
 */

import { defuse, inert, quoteInert, ZW } from '../core/defuse.js';

/** The marker on the first line (an HTML comment, which the forge does not show). It does not contain the contract's tag, `cornfield-run` */
export const MIRROR_TAG = 'cornfield:run-status';

/** The most of a runner's note the comment holds */
export const NOTE_SHOWN = 1000;

const STATUS_WORDS = {
  requested: 'Requested', claimed: 'Claimed', working: 'Working', waiting: 'Waiting', done: 'Done', failed: 'Failed', stopped: 'Stopped',
  'stop-requested': 'Stop requested', quiet: 'Quiet', merged: 'Merged', closed: 'Closed',
};

/** The state of a run as a word, the one the dashboard shows */
export const statusWord = (status) => STATUS_WORDS[status] ?? String(status);

/** Text for someone else's eyes: mentions, references and links broken, no link, image or HTML made of it, and made one line */
const plain = (s) => inert(defuse(String(s ?? '').replace(/\s+/g, ' ').trim()));

/** A run's note, quoted line by line and cut short */
function quote(note) {
  const text = String(note ?? '').trim();
  if (!text) return '';
  const cut = text.length > NOTE_SHOWN ? `${text.slice(0, NOTE_SHOWN)} …` : text;
  // Cut before it is made inert, so the cut never lands inside an escape (core/defuse.js)
  return quoteInert(cut);
}

/** An address the forge gave, safe to put in a link; null for anything else */
const forgeUrl = (u) => (typeof u === 'string' && /^https?:\/\/[^\s<>()[\]`"']{1,500}$/.test(u) ? u : null);

/** Who made a report, in words: `runner:<label>` for a runner token, else the login */
function whoWords(by) {
  if (by && typeof by === 'object') return `runner ${plain(by.label)}`;
  return by ? plain(by) : '';
}

/**
 * The status comment for a run.
 * @param {{ runId: string, kind: string, profile: string | null, status: string, requestedBy: string, via?: string, transport?: string,
 *   report: { state: string, at: string, by: any, note: string | null, url: string | null } | null,
 *   stopRequested: { at: string, by: string } | null, answer: { action: string, by?: string } | null,
 *   pull: { number: number, state: string, url: string | null, trusted: boolean } | null,
 *   branch: string | null, checks: string | null }} run a run as `publicRun` gives it
 * @returns {string}
 */
export function formatRunStatus(run) {
  const lines = [`<!-- ${MIRROR_TAG} ${run.runId} -->`];
  const profile = run.profile ? `, profile ${plain(run.profile)}` : '';
  lines.push(`**Run \`${run.runId}\`: ${statusWord(run.status)}**`);
  lines.push('', `A ${plain(run.kind)} run${profile}, asked by ${plain(run.requestedBy)}${run.via === 'hand' ? ' (written by hand)' : ''}.`);

  const facts = [];
  const r = run.report;
  // Not the report's time: a runner that says the same thing again must not edit the comment (the dashboard has the time)
  if (r) facts.push(`Reported ${plain(r.state)}${whoWords(r.by) ? ` by ${whoWords(r.by)}` : ''}.`);
  else facts.push('No report from a runner yet.');
  if (run.stopRequested) facts.push(`${plain(run.stopRequested.by)} asked it to stop (${plain(run.stopRequested.at)}); the runner decides what that means.`);
  if (run.answer) facts.push(`${plain(run.answer.by ?? 'A maintainer')} answered: ${plain(run.answer.action)}.`);
  const p = run.pull;
  if (p && Number.isInteger(p.number)) {
    const url = forgeUrl(p.url);
    const where = url ? `[#${p.number}](${url})` : `#${ZW}${p.number}`;
    const checks = run.checks && run.checks !== 'none' ? `, checks ${run.checks === 'success' ? 'passing' : run.checks === 'failure' ? 'failing' : 'running'}` : '';
    facts.push(`Pull request ${where} (${p.state}${p.trusted ? '' : ', not verified as the run\'s'}${checks}).`);
  } else if (run.branch) facts.push(`Branch \`${plain(run.branch)}\`.`);
  lines.push('', ...facts.map((f) => `- ${f}`));

  const note = r ? quote(r.note) : '';
  if (note) lines.push('', note);

  lines.push('', '_cornfield keeps this one comment up to date as the run moves, and starts nothing from it._');
  return lines.join('\n');
}

/** Whether a text is a status comment of cornfield's (by its marker): for a test or a person; cornfield itself trusts only the id it kept */
export const isRunStatus = (text) => typeof text === 'string' && text.startsWith(`<!-- ${MIRROR_TAG} `);

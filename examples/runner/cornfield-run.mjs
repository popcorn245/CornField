#!/usr/bin/env node
// A tiny runner helper for the cornfield agent contract (docs/agent-contract.md). Copy it with the three files beside it
// (agent-contract.js and defuse.js, copied unchanged from cornfield's core/, and package.json): every check is the contract's
// own, so the runner refuses exactly what cornfield refuses. Nothing else is needed, and nothing is installed.
//
//   node cornfield-run.mjs parse <comment-file>                     the request JSON of the comment's latest request block, or exit 1 and why
//   node cornfield-run.mjs stop <comment-file>                      the run id if the comment holds a stop request, else exit 1
//   node cornfield-run.mjs get <json-file> <field>                  one top-level field (a string as is, anything else as JSON)
//   node cornfield-run.mjs report <runId> <state> [note]            a report comment (CORNFIELD_RUN_URL adds a log link)
//   node cornfield-run.mjs trailer <runId>                          the Cornfield-Run trailer line
//   node cornfield-run.mjs closes <comment-file>                    "Closes #n" for the request's issue, or nothing
//   node cornfield-run.mjs claimed-url <comments-json> <login> <runId>   the url of that login's latest report for the run
//   node cornfield-run.mjs body <file>                              { "body": <the file> } as JSON, for a forge's comment API
//   node cornfield-run.mjs pr <title> <head> <base> <body-file>     { title, head, base, body } as JSON, for a forge's pull request API
// The comment file holds the comment's text. Checking that its author is a maintainer is the workflow's job, and comes first.
import { readFileSync } from 'node:fs';
import { readRunBlocks, latestBlock, formatRunComment, formatTrailer, validateReport, isRunId, REPORT_STATES, MAX_NOTE_CHARS } from './agent-contract.js';

const fail = (msg) => { console.error(msg); process.exit(1); };
// cornfield's own API tokens (cf_rt_ review, cf_at_ agent, cf_nt_ and any later cf_xx_ kind), refused here as well as by the
// contract, so a copy of the contract older than the token kind still keeps them out of a request and a report
const CF_TOKEN = /(?<![A-Za-z0-9])cf_[a-z]{2}_[A-Za-z0-9_-]{20,}/;
const cfToken = (v) => typeof v === 'string' ? CF_TOKEN.test(v) : v !== null && typeof v === 'object' && Object.values(v).some(cfToken);
const CF_REFUSED = 'something shaped like a credential (a cornfield token). Nothing like that goes in a request or a report.';
const read = (file) => { try { return readFileSync(file, 'utf8'); } catch (e) { return fail(`cannot read ${file}: ${e.code}`); } };
const json = (file) => { try { return JSON.parse(read(file)); } catch { return fail('not JSON'); } };
/** The latest request block of a comment, or the reason there is none */
const request = (text) => {
  const { blocks, refused } = readRunBlocks(text);
  const found = blocks.filter((b) => b.type === 'request').pop();
  if (found) return cfToken(found.value) ? fail(`refused: the request holds ${CF_REFUSED}`) : found.value;
  return fail(refused.length ? `refused: ${refused[refused.length - 1].error}` : 'no cornfield-run request block in the comment');
};

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'parse') {
  console.log(JSON.stringify(request(read(args[0] ?? ''))));
} else if (cmd === 'stop') {
  const b = readRunBlocks(read(args[0] ?? '')).blocks.filter((x) => x.type === 'stop-request').pop();
  if (!b) fail('no stop request in the comment');
  console.log(b.runId);
} else if (cmd === 'get') {
  const v = json(args[0] ?? '')[args[1]];
  console.log(typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
} else if (cmd === 'report') {
  const [runId, state, note = ''] = args;
  if (!isRunId(runId)) fail('not a run id');
  if (!REPORT_STATES.includes(state)) fail(`state must be one of ${REPORT_STATES.join(', ')}`);
  const body = { state };
  if (cfToken(note)) fail(`not posting it: the note holds ${CF_REFUSED}`);
  if (note.trim()) body.note = note.trim().slice(0, MAX_NOTE_CHARS);
  const url = process.env.CORNFIELD_RUN_URL;
  if (url && validateReport({ state, url }).ok) body.url = url; // a link the contract would refuse is left out, not posted
  try { console.log(formatRunComment(runId, body)); } catch (e) { fail(`not posting it: ${e.message}`); }
} else if (cmd === 'trailer') {
  if (!isRunId(args[0])) fail('not a run id');
  console.log(formatTrailer(args[0]));
} else if (cmd === 'closes') {
  const issue = request(read(args[0] ?? '')).refs.issue;
  console.log(issue ? `Closes #${issue}` : '');
} else if (cmd === 'claimed-url') {
  const [file, login, runId] = args;
  if (!isRunId(runId)) fail('not a run id');
  const comments = [json(file)].flat(2).filter((c) => c?.user?.login === login && typeof c.body === 'string');
  const blocks = comments.flatMap((c) => readRunBlocks(c.body).blocks);
  console.log(latestBlock(blocks.filter((b) => b.value.url), runId, 'report')?.value.url ?? '');
} else if (cmd === 'body') {
  console.log(JSON.stringify({ body: read(args[0] ?? '') }));
} else if (cmd === 'pr') {
  const [title, head, base, file] = args;
  console.log(JSON.stringify({ title, head, base, body: read(file ?? '') }));
} else fail('usage: cornfield-run.mjs parse|stop|get|report|trailer|closes|claimed-url|body|pr ...');

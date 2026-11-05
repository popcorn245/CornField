/**
 * @module core/agent-contract
 *
 * The contract between cornfield and a developer's runner (spec 0005, D1 to D5, D8, D10; docs/agent-contract.md). cornfield
 * only asks: it writes a request, and whatever runner the developer has picks it up. This module is every byte of that
 * contract, with no I/O of its own beyond the random bytes of a new run id:
 *
 * - **A run id,** `run-` and a 26 character ULID (Crockford base32): `newRunId`, `isRunId`.
 * - **The request,** JSON v1, checked strictly (`validateRequest`, `createRequest`). It carries no credential, ever: a field
 *   named like a token, a secret or a password is refused, and so is a value shaped like one.
 * - **The report** a runner may send (`validateReport`: claimed, working, done, failed, stopped) and **the stop request**
 *   cornfield sends (`validateStopRequest`: `stop-requested`).
 * - **The fenced block,** one form for all three, modelled on the review block of ADR 0005 (server/reviews.js):
 *
 *       Asked for a code run `run-01JC…` on #12 (maintainer-one, in cornfield).
 *
 *       ```cornfield-run run-01JC…
 *       { "version": 1, … }
 *       ```
 *
 *   `formatRunComment` writes it (the human line is defused, so it pings and links nobody), `readRunBlocks` and
 *   `parseRunBlocks` read it back: tolerant of the text around a block, strict about what is inside. A block that is not
 *   strictly a request, a report or a stop request is skipped, and `readRunBlocks` says which and why.
 * - **The trailer,** `Cornfield-Run: run-…` on its own line of a pull request body or a commit message, with the run id in a
 *   branch name as the fallback (`parseTrailer`, `runIdFromBranch`, `findRunId`).
 *
 * What this module does not do, because it cannot: decide whether the author of a block is a maintainer. That is the
 * caller's, and the runner's (D5). A comment is untrusted text: it is parsed, never rendered as HTML, never joined into a path.
 *
 * It lives in `core/` and imports only `core/defuse.js`, which imports nothing; its randomness is `crypto.getRandomValues`, so
 * Node and the browser can both load it.
 *
 * **For the server (#80 on).** `createRequest` makes a request, `formatRunComment` the comment that carries it, and
 * `runBlocksOf(comments, { trust })` reads a forge conversation back: every block with the comment and author it came from,
 * the blocks whose author is not trusted (to write the audit row the spec asks for), and the refused ones. `runAuthors` names the
 * logins worth asking the forge about first. `findRunId` ties a pull request to its run.
 *
 * @typedef {'code' | 'summary' | 'brief' | 'proposal'} RunKind
 * @typedef {{ issue?: number, proposal?: string, pull?: number, thread?: number }} RunRefs
 * @typedef {{ minutes?: number, turns?: number, cost?: number }} RunLimits
 * @typedef {{ version: 1, runId: string, kind: RunKind, profile?: string, refs: RunRefs, branch?: string, brief: string,
 *   limits?: RunLimits, nodes?: string[], requestedBy: string, requestedAt: string, trigger?: { event: 'spec.approved' | 'build.opened' | 'thread.message', by: string, ref: string } }} RunRequest
 * @typedef {'claimed' | 'working' | 'done' | 'failed' | 'stopped'} ReportState
 * @typedef {{ state: ReportState, note?: string, url?: string, tokens?: number, cost?: number }} RunReport
 * @typedef {{ state: 'stop-requested', note?: string }} StopRequest
 * @typedef {{ ok: true, value: any } | { ok: false, error: string }} Checked
 * @typedef {{ runId: string, type: 'request', value: RunRequest } | { runId: string, type: 'report', value: RunReport } | { runId: string, type: 'stop-request', value: StopRequest }} RunBlock
 */

import { defuse } from './defuse.js';

/** Ten (or `n`) random bytes, from the Web Crypto API that Node and the browser both have */
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// ---------------------------------------------------------------------------
//  The limits, in one place (the JSON Schema repeats them; a test keeps the two together)
// ---------------------------------------------------------------------------

export const CONTRACT_VERSION = 1;
export const RUN_KINDS = ['code', 'summary', 'brief', 'proposal'];
export const REPORT_STATES = ['claimed', 'working', 'done', 'failed', 'stopped'];
export const STOP_STATE = 'stop-requested';
/** The brief, in characters */
export const MAX_BRIEF_CHARS = 20000;
/** A report's or a stop request's note, in characters */
export const MAX_NOTE_CHARS = 4000;
export const MAX_URL_CHARS = 2000;
export const MAX_NODES = 100;
export const MAX_NODE_CHARS = 200;
export const MAX_BRANCH_CHARS = 200;
export const MAX_PROFILE_CHARS = 64;
export const MAX_SLUG_CHARS = 120;
/** The most an issue or a thread number may be (a 32 bit signed integer, as the forges keep them) */
export const MAX_NUMBER = 2147483647;
/** What the JSON in one block may hold, and what a whole comment may hold (GitHub refuses 65536; the human line comes with it) */
export const MAX_BLOCK_CHARS = 60000;
export const MAX_COMMENT_CHARS = 60000;
/** How much text is read for blocks, and how many blocks are read from it */
export const MAX_TEXT_CHARS = 1_000_000;
export const MAX_BLOCKS = 20;
/** The tag of the fenced block */
export const RUN_TAG = 'cornfield-run';
/** The key of the trailer */
export const TRAILER_KEY = 'Cornfield-Run';

const REQUEST_KEYS = ['version', 'runId', 'kind', 'profile', 'refs', 'branch', 'brief', 'limits', 'nodes', 'requestedBy', 'requestedAt', 'trigger'];
const TRIGGER_KEYS = ['event', 'by', 'ref'];
/** The events an opt-in trigger may fire on (`agents.on`, spec 0005 D10): each is something a maintainer did */
export const TRIGGER_EVENTS = Object.freeze(['spec.approved', 'build.opened', 'thread.message']);
const REF_KEYS = ['issue', 'proposal', 'pull', 'thread'];
const LIMIT_KEYS = ['minutes', 'turns', 'cost'];
const REPORT_KEYS = ['state', 'note', 'url', 'tokens', 'cost'];
const STOP_KEYS = ['state', 'note'];

// ---------------------------------------------------------------------------
//  Patterns. Each is plain ECMAScript with no flags, so the JSON Schema can carry the same source.
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The 26 characters of a ULID: a 48 bit time, then 80 random bits. The first is 0 to 7, so the time fits */
export const ULID_SOURCE = '[0-7][0-9A-HJKMNP-TV-Z]{25}';
export const RUN_ID_SOURCE = `^run-${ULID_SOURCE}$`;
export const LOGIN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$';
export const SLUG_SOURCE = `^[A-Za-z0-9][A-Za-z0-9._-]{0,${MAX_SLUG_CHARS - 1}}$`;
export const PROFILE_SOURCE = `^[A-Za-z0-9][A-Za-z0-9._-]{0,${MAX_PROFILE_CHARS - 1}}$`;
export const NODE_ID_SOURCE = `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,${MAX_NODE_CHARS - 1}}$`;
/** What an automatic request says caused it: a pull request, an issue or a comment, by its number or id */
export const TRIGGER_REF_SOURCE = '^(pull|issue|comment):[0-9]{1,20}$';
export const ISO_SOURCE = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$';
/** An http(s) link with no user and password in it */
export const URL_SOURCE = '^https?://[^\\s/@?#]+([/?#]\\S*)?$';

/** `word` as a pattern that ignores case without a flag: `tok` is `[tT][oO][kK]` */
const anyCase = (word) => word.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

/** A field name that says it holds a credential (matched anywhere in the name, any case) */
export const CREDENTIAL_KEY_SOURCE = `(?:${['token', 'secret', 'passw', 'credential', 'api[_-]?key', 'access[_-]?key', 'private[_-]?key', 'ssh[_-]?key', 'authorization', 'bearer', 'cookie'].map(anyCase).join('|')})`;

/**
 * Where a token may start: not inside a longer word, so prose like "desk-booking-service-for-teams" never reads as an `sk-` key.
 * Every alternative below starts with it (or with a fixed text), which also keeps each one linear in the length of the text.
 */
const EDGE = '(?<![A-Za-z0-9])';

/**
 * A value shaped like a credential: a forge or cloud token, cornfield's own API tokens (`cf_rt_…` review, `cf_at_…` agent), a JWT, a
 * private key, a bearer header, a user and password in a link.
 * Prose that only talks about tokens and passwords passes; `sk-` keys and bearer values need a digit in their first 41
 * characters, as real ones have, so a long hyphenated word after "Bearer" or "sk-" is not taken for one. Each alternative tries a
 * bounded stretch from each place it may start, so a 20000 character brief is read in linear time whatever it holds.
 */
export const CREDENTIAL_VALUE_SOURCE = [
  `${EDGE}gh[pousr]_[A-Za-z0-9]{30,}`,
  `${EDGE}github_pat_[A-Za-z0-9_]{20,}`,
  `${EDGE}glpat-[A-Za-z0-9_-]{15,}`,
  `${EDGE}gto-[A-Za-z0-9]{20,}`,
  `${EDGE}cf_(?:rt|at)_[A-Za-z0-9_-]{20,}`,
  `${EDGE}sk-(?=[A-Za-z0-9_-]{20})[A-Za-z_-]{0,40}[0-9]`,
  `${EDGE}AKIA[0-9A-Z]{16}`,
  `${EDGE}AIza[0-9A-Za-z_-]{35}`,
  `${EDGE}xox[abprs]-[A-Za-z0-9-]{10,}`,
  `${EDGE}eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{5,}`,
  '-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----',
  `${EDGE}${anyCase('bearer')}[ \\t]+(?=[A-Za-z0-9._~+/=-]{20})[A-Za-z._~+/=-]{0,40}[0-9]`,
  // a user and a password in a link: the scheme is a whole word, the user holds no colon, so no part of the text is tried twice
  '(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}://[^\\s/@:]+:[^\\s/@]+@',
].join('|');

/** A link whose query or fragment carries a credential (`?token=…`) */
export const CREDENTIAL_QUERY_SOURCE = `[?&#;](?:[^\\s=&#;]*(?:${['token', 'secret', 'passw', 'key', 'signature'].map(anyCase).join('|')})[^\\s=&#;]*|${anyCase('sig')})=`;

const RUN_ID = new RegExp(RUN_ID_SOURCE);
const LOGIN = new RegExp(LOGIN_SOURCE);
const SLUG = new RegExp(SLUG_SOURCE);
const PROFILE = new RegExp(PROFILE_SOURCE);
const NODE_ID = new RegExp(NODE_ID_SOURCE);
const ISO = new RegExp(ISO_SOURCE);
const TRIGGER_REF = new RegExp(TRIGGER_REF_SOURCE);
const URL_RE = new RegExp(URL_SOURCE);
const CREDENTIAL_KEY = new RegExp(CREDENTIAL_KEY_SOURCE);
const CREDENTIAL_VALUE = new RegExp(CREDENTIAL_VALUE_SOURCE);
const CREDENTIAL_QUERY = new RegExp(CREDENTIAL_QUERY_SOURCE);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
/** A name as it is shown in a message: short, on one line, quoted */
const shown = (v) => JSON.stringify(String(v).replace(/\s+/g, ' ').slice(0, 60));

// ---------------------------------------------------------------------------
//  Run ids
// ---------------------------------------------------------------------------

/**
 * A new run id: `run-` and a ULID, which is 10 characters of the time in milliseconds and 16 of randomness, in Crockford base32,
 * so ids sort by when they were minted. Nothing is kept between calls: two ids of the same millisecond differ only by their
 * random part.
 * @param {{ now?: () => number, random?: (n: number) => Uint8Array }} [opts] a clock and a source of bytes, for tests
 * @returns {string}
 */
export function newRunId({ now = Date.now, random = randomBytes } = {}) {
  let time = now();
  if (!Number.isSafeInteger(time) || time < 0 || time > 2 ** 48 - 1) throw new RangeError('A run id needs a clock that reads a time in milliseconds between 1970 and the year 10889.');
  let head = '';
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD[time % 32] + head;
    time = Math.floor(time / 32);
  }
  const bytes = random(10);
  if (!bytes || bytes.length < 10) throw new RangeError('A run id needs ten random bytes.');
  // 80 bits, five at a time, as a BigInt (exact, and the one place one is worth having)
  let bits = 0n;
  for (let i = 0; i < 10; i++) bits = (bits << 8n) | BigInt(bytes[i]);
  let tail = '';
  for (let i = 0; i < 16; i++) {
    tail = CROCKFORD[Number(bits & 31n)] + tail;
    bits >>= 5n;
  }
  return `run-${head}${tail}`;
}

/** Whether `value` is a run id exactly as `newRunId` writes one */
export function isRunId(value) {
  return typeof value === 'string' && RUN_ID.test(value);
}

/** The time a run id was minted at, or null when it is not a run id */
export function runIdTime(runId) {
  if (!isRunId(runId)) return null;
  let ms = 0;
  for (const c of runId.slice(4, 14)) ms = ms * 32 + CROCKFORD.indexOf(c);
  return new Date(ms);
}

// ---------------------------------------------------------------------------
//  Shared checks
// ---------------------------------------------------------------------------

/** The first problem with a set of keys: a credential by name, or a key the object may not have. Own keys only */
function keyProblem(body, allowed, at) {
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    if (CREDENTIAL_KEY.test(key)) return `${at} has "${key}", which looks like a credential. A request never carries one: the runner uses its own identity.`;
    return `${at} has "${key}", which the contract does not have.`;
  }
  return null;
}

/** The first string anywhere in `value` shaped like a credential, as a message, or null */
function valueProblem(value, at) {
  if (typeof value === 'string') {
    return CREDENTIAL_VALUE.test(value) ? `${at} holds something shaped like a credential (a token, a key or a password in a link). Nothing like that goes in a request or a report.` : null;
  }
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const p = valueProblem(v, `${at}[${i}]`);
      if (p) return p;
    }
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const p = valueProblem(v, `${at}.${k}`);
      if (p) return p;
    }
  }
  return null;
}

const text = (v, field, max) => {
  if (typeof v !== 'string') return `"${field}" is text.`;
  if (v.length > max) return `"${field}" is at most ${max} characters.`;
  return null;
};

/**
 * A safe git ref name for a branch hint: letters, digits and `. _ - /` only; no empty, hidden or `.lock` part, no `..`, no
 * leading dash (it would read as an option), no leading or trailing slash. Returns the problem, or null.
 * @param {unknown} name
 */
export function branchProblem(name) {
  if (typeof name !== 'string' || name === '') return 'is the name of a branch.';
  if (name.length > MAX_BRANCH_CHARS) return `is at most ${MAX_BRANCH_CHARS} characters.`;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return 'has only letters, digits and . _ - / in it.';
  if (name.startsWith('-')) return 'does not start with a dash.';
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'has no empty part between slashes.';
  if (name.includes('..')) return 'does not hold "..".';
  if (name.endsWith('.')) return 'does not end with a dot.';
  if (name.split('/').some((p) => p.startsWith('.') || p.endsWith('.lock'))) return 'has no part that starts with a dot or ends with ".lock".';
  return null;
}

/** Whether `s` is an ISO 8601 UTC time (`2026-11-05T09:30:00Z`) that is a real date */
function isoProblem(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return 'is a UTC time like 2026-11-05T09:30:00Z.';
  const t = Date.parse(s);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 19) !== s.slice(0, 19)) return 'is a real date and time.';
  return null;
}

// ---------------------------------------------------------------------------
//  The request
// ---------------------------------------------------------------------------

/**
 * Checks a request: JSON v1, strictly. Unknown keys are refused, and so is any key named like a credential or a value shaped like
 * one. Pure: the value it returns is a copy with its keys in the contract's order.
 * @param {unknown} body the parsed JSON
 * @param {{ profiles?: string[] }} [opts] `profiles`: the names the developer configured (`agents.profiles`); a profile outside the list is refused. With no list, any well formed name passes.
 * @returns {Checked}
 */
export function validateRequest(body, { profiles } = {}) {
  const no = (error) => ({ ok: false, error });
  if (!isObject(body)) return no('A request is a JSON object.');
  const keys = keyProblem(body, REQUEST_KEYS, 'A request');
  if (keys) return no(keys);
  const secret = valueProblem(body, 'The request');
  if (secret) return no(secret);

  if (body.version !== CONTRACT_VERSION) return no(`"version" is ${CONTRACT_VERSION}; this is the only contract there is.`);
  if (!isRunId(body.runId)) return no('"runId" is "run-" and a 26 character ULID, like run-01JC8Z3Q5M7VXK2RT9N4B6HDEF.');
  if (!RUN_KINDS.includes(body.kind)) return no(`"kind" is one of ${RUN_KINDS.join(', ')}.`);

  if (body.profile !== undefined) {
    if (typeof body.profile !== 'string' || !PROFILE.test(body.profile)) return no(`"profile" is a name of letters, digits and . _ -, at most ${MAX_PROFILE_CHARS} characters.`);
    if (profiles !== undefined && !profiles.includes(body.profile)) return no(`"profile" ${shown(body.profile)} is not one of the configured profiles (${profiles.join(', ') || 'none'}).`);
  }

  if (!isObject(body.refs)) return no('"refs" says what the run is about: { issue, proposal, thread }, at least one.');
  const refKeys = keyProblem(body.refs, REF_KEYS, '"refs"');
  if (refKeys) return no(refKeys);
  if (!['issue', 'proposal', 'thread'].some((k) => k in body.refs)) return no('"refs" needs at least one of issue, proposal or thread.');
  for (const field of ['issue', 'pull', 'thread']) {
    const n = body.refs[field];
    if (n !== undefined && (!isInt(n) || n < 1 || n > MAX_NUMBER)) return no(`"refs.${field}" is a number from 1, like 12.`);
  }
  if (body.refs.proposal !== undefined && (typeof body.refs.proposal !== 'string' || !SLUG.test(body.refs.proposal))) return no('"refs.proposal" is the proposal\'s name, like 0014-planner.');
  if (body.refs.pull !== undefined && body.refs.proposal === undefined) return no('"refs.pull" is the spec pull request that holds "refs.proposal", so it comes with one.');

  if (body.branch !== undefined) {
    const problem = branchProblem(body.branch);
    if (problem) return no(`"branch" ${problem}`);
  }

  {
    // Required, as the spec's table has it (it may be empty: a summary of a thread needs no more than the thread)
    const problem = body.brief === undefined ? '"brief" is the text the runner hands to its agent (it may be empty).' : text(body.brief, 'brief', MAX_BRIEF_CHARS);
    if (problem) return no(problem);
  }

  if (body.limits !== undefined) {
    if (!isObject(body.limits)) return no('"limits" is { minutes, turns, cost }.');
    const limitKeys = keyProblem(body.limits, LIMIT_KEYS, '"limits"');
    if (limitKeys) return no(limitKeys);
    for (const field of LIMIT_KEYS) {
      const n = body.limits[field];
      if (n === undefined) continue;
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return no(`"limits.${field}" is a number above zero.`);
      if (field === 'turns' && !Number.isInteger(n)) return no('"limits.turns" is a whole number.');
    }
  }

  if (body.nodes !== undefined) {
    if (!Array.isArray(body.nodes)) return no('"nodes" is a list of node ids.');
    if (body.nodes.length > MAX_NODES) return no(`"nodes" has at most ${MAX_NODES} ids.`);
    const bad = body.nodes.findIndex((n) => typeof n !== 'string' || !NODE_ID.test(n));
    if (bad >= 0) return no(`Node ${bad + 1} of "nodes" is not a node id (letters, digits and . _ : / -, at most ${MAX_NODE_CHARS} characters).`);
  }

  if (typeof body.requestedBy !== 'string' || !LOGIN.test(body.requestedBy)) return no('"requestedBy" is a forge login, like maintainer-one.');
  const when = isoProblem(body.requestedAt);
  if (when) return no(`"requestedAt" ${when}`);

  const value = { version: CONTRACT_VERSION, runId: body.runId, kind: body.kind };
  if (body.profile !== undefined) value.profile = body.profile;
  value.refs = {};
  for (const k of REF_KEYS) if (body.refs[k] !== undefined) value.refs[k] = body.refs[k];
  if (body.branch !== undefined) value.branch = body.branch;
  value.brief = body.brief;
  if (body.limits !== undefined) {
    value.limits = {};
    for (const k of LIMIT_KEYS) if (body.limits[k] !== undefined) value.limits[k] = body.limits[k];
  }
  if (body.nodes !== undefined) value.nodes = [...body.nodes];
  value.requestedBy = body.requestedBy;
  value.requestedAt = body.requestedAt;
  if (body.trigger !== undefined) {
    if (!isObject(body.trigger)) return no('"trigger" is { event, by, ref }: what caused an automatic request.');
    const triggerKeys = keyProblem(body.trigger, TRIGGER_KEYS, '"trigger"');
    if (triggerKeys) return no(triggerKeys);
    if (!TRIGGER_EVENTS.includes(body.trigger.event)) return no(`"trigger.event" is one of ${TRIGGER_EVENTS.join(', ')}.`);
    if (typeof body.trigger.by !== 'string' || !LOGIN.test(body.trigger.by)) return no('"trigger.by" is the forge login of the maintainer whose act caused the request.');
    if (typeof body.trigger.ref !== 'string' || !TRIGGER_REF.test(body.trigger.ref)) return no('"trigger.ref" is what the act was on: pull:<number>, issue:<number> or comment:<id>.');
    // The request is posted as the maintainer whose act caused it, so the two name one person
    if (body.trigger.by !== body.requestedBy) return no('"trigger.by" is the maintainer the request is made as, the same login as "requestedBy".');
    value.trigger = { event: body.trigger.event, by: body.trigger.by, ref: body.trigger.ref };
  }
  return { ok: true, value };
}

/**
 * Makes a request from what a maintainer asked for: mints the run id and the time, then checks the result like any other.
 * @param {Omit<RunRequest, 'version' | 'runId' | 'requestedAt'>} fields
 * @param {{ profiles?: string[], now?: () => number, random?: (n: number) => Uint8Array }} [opts]
 * @returns {Checked}
 */
export function createRequest(fields, { profiles, now = Date.now, random } = {}) {
  if (!isObject(fields)) return { ok: false, error: 'A request is a JSON object.' };
  const at = now();
  if (!Number.isFinite(at)) return { ok: false, error: 'The clock did not give a time.' };
  const { version, runId, requestedAt, ...rest } = fields; // these three are cornfield's to write
  if (version !== undefined || runId !== undefined || requestedAt !== undefined) return { ok: false, error: 'A new request does not set "version", "runId" or "requestedAt": they are written for it.' };
  return validateRequest({ version: CONTRACT_VERSION, runId: newRunId({ now: () => at, ...(random ? { random } : {}) }), ...rest, requestedAt: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z') }, { profiles });
}

// ---------------------------------------------------------------------------
//  The report, and the stop request
// ---------------------------------------------------------------------------

function noteAndUrl(body, no) {
  if (body.note !== undefined) {
    const problem = text(body.note, 'note', MAX_NOTE_CHARS);
    if (problem) return no(problem);
  }
  return null;
}

/**
 * Checks a report from a runner: `{ state, note?, url?, tokens?, cost? }` and nothing else. `tokens` is a whole number and `cost` a
 * number, neither below zero; cornfield shows them as sent and never estimates them. `url` is where the runner keeps its logs
 * (http or https, with no user and password in it).
 * @param {unknown} body
 * @returns {Checked}
 */
export function validateReport(body) {
  const no = (error) => ({ ok: false, error });
  if (!isObject(body)) return no('A report is a JSON object with a state.');
  const keys = keyProblem(body, REPORT_KEYS, 'A report');
  if (keys) return no(keys);
  const secret = valueProblem(body, 'The report');
  if (secret) return no(secret);
  if (!REPORT_STATES.includes(body.state)) return no(`"state" is one of ${REPORT_STATES.join(', ')}.`);
  const bad = noteAndUrl(body, no);
  if (bad) return bad;
  if (body.url !== undefined) {
    if (typeof body.url !== 'string' || body.url.length > MAX_URL_CHARS || !URL_RE.test(body.url)) return no(`"url" is an http or https link of at most ${MAX_URL_CHARS} characters, with no user and password in it.`);
    if (CREDENTIAL_QUERY.test(body.url)) return no('"url" carries what looks like a credential in its query. Link to the logs without one.');
  }
  if (body.tokens !== undefined && (!isInt(body.tokens) || body.tokens < 0 || !Number.isSafeInteger(body.tokens))) return no('"tokens" is a whole number, zero or more.');
  if (body.cost !== undefined && (typeof body.cost !== 'number' || !Number.isFinite(body.cost) || body.cost < 0)) return no('"cost" is a number, zero or more.');
  const value = { state: body.state };
  for (const k of ['note', 'url', 'tokens', 'cost']) if (body[k] !== undefined) value[k] = body[k];
  return { ok: true, value };
}

/**
 * Checks a stop request: `{ state: 'stop-requested', note? }`. cornfield sends it; the runner decides what stopping means.
 * @param {unknown} body
 * @returns {Checked}
 */
export function validateStopRequest(body) {
  const no = (error) => ({ ok: false, error });
  if (!isObject(body)) return no('A stop request is a JSON object with a state.');
  const keys = keyProblem(body, STOP_KEYS, 'A stop request');
  if (keys) return no(keys);
  const secret = valueProblem(body, 'The stop request');
  if (secret) return no(secret);
  if (body.state !== STOP_STATE) return no(`"state" is "${STOP_STATE}".`);
  const bad = noteAndUrl(body, no);
  if (bad) return bad;
  return { ok: true, value: { state: STOP_STATE, ...(body.note !== undefined ? { note: body.note } : {}) } };
}

/**
 * Checks whatever a `cornfield-run` block holds, by its shape: a `version` makes it a request, the state `stop-requested` a
 * stop request, any other state a report.
 * @param {unknown} body
 * @param {{ profiles?: string[] }} [opts]
 * @returns {{ ok: true, type: 'request' | 'report' | 'stop-request', value: any } | { ok: false, error: string }}
 */
export function validateRunBody(body, opts) {
  if (Array.isArray(body)) return { ok: false, error: 'A cornfield-run block holds one JSON object, not a list.' };
  if (!isObject(body)) return { ok: false, error: 'A cornfield-run block holds one JSON object.' };
  const [type, checked] = 'version' in body || 'runId' in body ? ['request', validateRequest(body, opts)]
    : body.state === STOP_STATE ? ['stop-request', validateStopRequest(body)]
    : 'state' in body ? ['report', validateReport(body)]
    : ['request', validateRequest(body, opts)]; // neither shape: the request check names the first key or field that is wrong
  return checked.ok ? { ok: true, type, value: checked.value } : checked;
}

// ---------------------------------------------------------------------------
//  The fenced block: written, and read back
// ---------------------------------------------------------------------------

const FENCE = '```';

/** The block for a checked request, report or stop request, as text: the fence named for the run, the JSON, the closing fence. Throws on anything that is not strictly one. */
export function formatRunBlock(runId, body, opts) {
  if (!isRunId(runId)) throw new TypeError(`${shown(runId)} is not a run id.`);
  const checked = validateRunBody(body, opts);
  if (!checked.ok) throw new TypeError(checked.error);
  if (checked.type === 'request' && checked.value.runId !== runId) throw new TypeError(`The block is for ${runId} but the request is for ${checked.value.runId}.`);
  const json = JSON.stringify(checked.value, null, 2);
  if (json.length > MAX_BLOCK_CHARS) throw new RangeError(`That is too long for a block (${json.length} characters, at most ${MAX_BLOCK_CHARS}); shorten the brief.`);
  // JSON text never holds a raw newline inside a string, so nothing in it can close the fence
  return `${FENCE}${RUN_TAG} ${runId}\n${json}\n${FENCE}`;
}

/** One line, with nothing in it that could open a fence, and every mention and reference defused */
const oneLine = (s) => defuse(String(s).replace(/\s+/g, ' ').replace(/`{3,}/g, "'''").trim());

function defaultLine(runId, type, value) {
  if (type === 'request') {
    const about = [value.refs.issue && `issue #${value.refs.issue}`, value.refs.proposal && `proposal ${value.refs.proposal}${value.refs.pull ? ` (pull request #${value.refs.pull})` : ''}`, value.refs.thread && `thread #${value.refs.thread}`].filter(Boolean).join(', ');
    return `Asked for a ${value.kind} run \`${runId}\` on ${about}${value.profile ? ` with the profile ${value.profile}` : ''} (${value.requestedBy}, in cornfield).`;
  }
  if (type === 'stop-request') return `Asked run \`${runId}\` to stop.`;
  return `Run \`${runId}\`: ${value.state}.`;
}

/**
 * The text of a comment for a request, a report or a stop request: a human line (defused: it pings and links nobody), the note of a
 * report or stop request quoted and defused, then the block. The block keeps every value as sent, for the runner.
 * @param {string} runId
 * @param {RunRequest | RunReport | StopRequest} body
 * @param {{ line?: string, profiles?: string[] }} [opts] `line`: your own human line, in place of the default
 * @returns {string}
 */
export function formatRunComment(runId, body, { line, profiles } = {}) {
  const block = formatRunBlock(runId, body, { profiles });
  const checked = validateRunBody(body, { profiles });
  const head = oneLine(line ?? defaultLine(runId, checked.type, checked.value));
  const note = checked.type === 'request' ? '' : (checked.value.note ?? '').trim();
  const quoted = note ? `\n\n${defuse(note).split(/\r?\n/).map((l) => (l ? `> ${l}` : '>')).join('\n')}` : '';
  const out = `${head}${quoted}\n\n${block}`;
  if (out.length > MAX_COMMENT_CHARS) throw new RangeError(`That is too long for a comment (${out.length} characters, at most ${MAX_COMMENT_CHARS}); shorten the brief or the note.`);
  return out;
}

/** A line that opens or closes a fence: three or more backticks or tildes at the start of the line, and the rest */
const FENCE_LINE = /^(`{3,}|~{3,})(.*)$/;

/**
 * The fenced code blocks of a text, outermost only, in one pass over its lines: `{ fence, info, body, end }` for each, where
 * `end` is false for a block nobody closed (it runs to the end of the text). A fence closes on a line of the same character, at
 * least as long, with nothing after it but spaces, as Markdown reads it; so a block inside a longer fence (a ```` example, a
 * ~~~ one) or inside a ```js block is part of that block, never a block of its own. Fences start a line: a quoted or indented
 * one is text. Linear in the length of the text, whatever it holds.
 * @param {string} text with `\n` line ends
 */
export function* fencedBlocks(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_LINE.exec(lines[i]);
    if (!open) continue;
    const [, fence, info] = open;
    // An info string after backticks may not hold a backtick (Markdown); such a line is text
    if (fence[0] === '`' && info.includes('`')) continue;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = FENCE_LINE.exec(lines[j]);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && close[2].trim() === '') break;
    }
    yield { fence, info, body: lines.slice(i + 1, j).join('\n'), end: j < lines.length };
    i = j;
  }
}

/**
 * Every block a comment's text holds, in order, and every block that was refused with the reason. A block that is not strictly a
 * request, a report or a stop request is refused: not JSON, a list, two objects, a key it does not have, a credential, a fence
 * that names no run id, a request for another run than its fence names. Text around a block, a quoted block (`> ```…`), an
 * indented one, one nobody closed, and one inside another fence (a ```` example) are ignored (`fencedBlocks`). Nothing is thrown,
 * and the time it takes is linear in the text.
 * @param {unknown} body a comment's text
 * @param {{ profiles?: string[] }} [opts]
 * @returns {{ blocks: RunBlock[], refused: { runId: string | null, error: string }[] }}
 */
export function readRunBlocks(body, opts) {
  const out = { blocks: [], refused: [] };
  if (typeof body !== 'string' || !body.includes(RUN_TAG)) return out;
  let seen = 0;
  for (const b of fencedBlocks(body.slice(0, MAX_TEXT_CHARS).replace(/\r\n?/g, '\n'))) {
    // A run block is a fence of exactly three backticks, as cornfield writes it, that was closed
    if (b.fence !== FENCE || !b.end || !b.info.startsWith(RUN_TAG)) continue;
    const m = [null, b.info.slice(RUN_TAG.length), b.body];
    if (++seen > MAX_BLOCKS) {
      out.refused.push({ runId: null, error: `A comment is read for at most ${MAX_BLOCKS} cornfield-run blocks.` });
      break;
    }
    const name = m[1].trim();
    const runId = isRunId(name) ? name : null;
    const refuse = (error) => out.refused.push({ runId, error });
    if (!runId) {
      refuse(`The fence names ${shown(name)}, which is not a run id; it is \`${RUN_TAG} run-\` and a 26 character ULID.`);
      continue;
    }
    if (m[2].length > MAX_BLOCK_CHARS) {
      refuse(`The block is longer than ${MAX_BLOCK_CHARS} characters.`);
      continue;
    }
    let json;
    try {
      json = JSON.parse(m[2]);
    } catch {
      refuse('The block is not JSON (it holds exactly one object).');
      continue;
    }
    const checked = validateRunBody(json, opts);
    if (!checked.ok) {
      refuse(checked.error);
      continue;
    }
    if (checked.type === 'request' && checked.value.runId !== runId) {
      refuse(`The fence is for ${runId} but the request is for ${checked.value.runId}.`);
      continue;
    }
    out.blocks.push({ runId, type: checked.type, value: checked.value });
  }
  return out;
}

/** How long after it was posted a comment may change and still count as not edited (the forge's own touch-ups), as for reviews */
export const EDIT_GRACE_MS = 5000;

/**
 * @typedef {{ id: string, author: { login: string } | null, body: string, url?: string, createdAt: string, updatedAt?: string }} RunComment
 *   a forge comment, as server/forge.js gives it
 * @typedef {RunBlock & { by: string, at: string, comment: { id: string, url: string | null } }} FoundBlock
 */

/**
 * The logins whose comments hold something that may be a run block, once each, newest comment first: the ones worth asking the
 * forge about (their permission, or whether they are in `agents.runners`) before `runBlocksOf`.
 * @param {RunComment[]} comments
 * @returns {string[]}
 */
export function runAuthors(comments) {
  const out = new Set();
  for (let i = (Array.isArray(comments) ? comments.length : 0) - 1; i >= 0; i--) {
    const c = comments[i];
    if (c?.author?.login && typeof c.body === 'string' && c.body.includes(RUN_TAG)) out.add(c.author.login);
  }
  return [...out];
}

/**
 * Every run block of a forge conversation (comments oldest first), with the comment it came from, sorted three ways:
 * - `blocks`: from an author `trust(login)` accepts, in a comment not edited after it was posted;
 * - `ignored`: well formed, but from someone else (or a deleted account), or in an edited comment: the spec wants one audit row
 *   for each, so they are kept with the reason;
 * - `refused`: not strictly a request, report or stop request (`readRunBlocks`), with the author.
 * Whom to trust is the caller's to decide, because it takes the forge: a maintainer now for a request or a stop, a login in
 * `agents.runners` or a maintainer for a report (spec 0005). `trust` is asked once per block, with the block, so it can tell them
 * apart.
 * @param {RunComment[]} comments
 * @param {{ trust: (login: string, block: RunBlock) => boolean, profiles?: string[] }} opts
 * @returns {{ blocks: FoundBlock[], ignored: (FoundBlock & { why: 'author' | 'edited' })[], refused: { runId: string | null, error: string, by: string | null, comment: { id: string, url: string | null } }[] }}
 */
export function runBlocksOf(comments, { trust, profiles } = /** @type {any} */ ({})) {
  if (typeof trust !== 'function') throw new TypeError('runBlocksOf needs a trust(login, block) function: whose blocks count is the caller\'s to say.');
  const out = { blocks: [], ignored: [], refused: [] };
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!c || typeof c.body !== 'string') continue;
    const read = readRunBlocks(c.body, { profiles });
    const by = c.author?.login ?? null;
    const comment = { id: String(c.id), url: c.url ?? null };
    for (const r of read.refused) out.refused.push({ ...r, by, comment });
    // A time that does not parse is not taken for "never edited": only a comment the forge says it left alone counts
    const edited = c.updatedAt !== undefined && !(Date.parse(c.updatedAt) - Date.parse(c.createdAt) <= EDIT_GRACE_MS);
    for (const b of read.blocks) {
      const found = { ...b, by, at: c.createdAt, comment };
      if (by === null || !trust(by, b)) out.ignored.push({ ...found, why: 'author' });
      else if (edited) out.ignored.push({ ...found, why: 'edited' });
      else out.blocks.push(found);
    }
  }
  return out;
}

/** The blocks a comment's text holds, in order (see `readRunBlocks`; the refused ones are dropped) */
export function parseRunBlocks(body, opts) {
  return readRunBlocks(body, opts).blocks;
}

/**
 * The latest block of `type` for `runId` in a list of blocks in the order they were written (the caller orders its comments and
 * drops the ones whose author is not a maintainer, or whose comment was edited), or null. Later wins.
 * @param {RunBlock[]} blocks
 * @param {string} runId
 * @param {'request' | 'report' | 'stop-request'} type
 * @returns {RunBlock | null}
 */
export function latestBlock(blocks, runId, type) {
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].runId === runId && blocks[i].type === type) return blocks[i];
  return null;
}

// ---------------------------------------------------------------------------
//  The trailer, and the branch
// ---------------------------------------------------------------------------

const TRAILER = new RegExp(`^ {0,3}${anyCase(TRAILER_KEY)}[ \\t]*:[ \\t]*(run-${ULID_SOURCE})[ \\t]*$`);

/** The trailer line for a run: `Cornfield-Run: run-…` */
export function formatTrailer(runId) {
  if (!isRunId(runId)) throw new TypeError(`${shown(runId)} is not a run id.`);
  return `${TRAILER_KEY}: ${runId}`;
}

/**
 * The run id a pull request body or a commit message names in a `Cornfield-Run:` trailer: the key in any case, the id on a line of
 * its own, the last such line when there are several. A line that is quoted (`> `), indented as code (four spaces or a tab),
 * inside a fenced code block (an example in a pull request body), or holds more than the trailer does not count.
 * @param {unknown} message
 * @returns {string | null}
 */
export function parseTrailer(message) {
  if (typeof message !== 'string' || message.length > MAX_TEXT_CHARS) return null;
  let found = null;
  let fence = null;
  for (const line of message.replace(/\r\n?/g, '\n').split('\n')) {
    const f = FENCE_LINE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === '') fence = null;
      continue;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1];
      continue;
    }
    const m = TRAILER.exec(line);
    if (m) found = m[1];
  }
  return found;
}

const BRANCH_ID = new RegExp(`(?<![A-Za-z0-9])run-(${ULID_SOURCE})(?![A-Za-z0-9])`, 'gi');

/**
 * The run id in a branch name, as a whole segment (`agent/run-01JC…/fix`, `fix-run-01JC…`, never part of a longer word). Branch
 * names are often lower-cased on the way, so the case is forgiven and the id is returned as it was minted. The last one wins.
 * @param {unknown} name
 * @returns {string | null}
 */
export function runIdFromBranch(name) {
  if (typeof name !== 'string' || name.length > 1000) return null;
  let found = null;
  for (const m of name.matchAll(BRANCH_ID)) {
    const id = `run-${m[1].toUpperCase()}`;
    if (isRunId(id)) found = id;
  }
  return found;
}

/**
 * The run a pull request belongs to: the trailer in its body, else the trailer in the latest of its commit messages that has one,
 * else the run id in its branch name (D3: no branch naming scheme is imposed, so the branch is the last resort).
 * @param {{ body?: string, commits?: string[], branch?: string }} pull
 * @returns {{ runId: string, via: 'body' | 'commit' | 'branch' } | null}
 */
export function findRunId({ body, commits, branch } = {}) {
  const fromBody = parseTrailer(body);
  if (fromBody) return { runId: fromBody, via: 'body' };
  for (let i = (commits?.length ?? 0) - 1; i >= 0; i--) {
    const fromCommit = parseTrailer(commits[i]);
    if (fromCommit) return { runId: fromCommit, via: 'commit' };
  }
  const fromBranch = runIdFromBranch(branch);
  return fromBranch ? { runId: fromBranch, via: 'branch' } : null;
}

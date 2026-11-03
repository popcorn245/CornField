/**
 * @module server/throttle
 *
 * The flood and repeat limits of everything cornfield does on a forge as a person (server/forge-actions.js: land,
 * re-run, the pipeline's steps; server/submit-review.js: Approve and Send back, from the button and from the API).
 * They live in one place so the same person is counted once whichever door they come in by. State is kept in memory,
 * per `auth` object (one per server), keyed by the forge's user id:
 *
 *   countAttempt   a ceiling on attempts of any kind per person per minute (`ATTEMPTS_PER_MINUTE`), counted before
 *                  anything is written down, so refused attempts cannot grow the audit table without end
 *   throttle       not twice: one at a time for the same key, `COOLDOWN_MS` before it is asked again, and a ceiling of
 *                  `PER_MINUTE` actions per person per minute
 *
 * A refusal is a `Refused`: a status (429, or the action's own), words, a code and the headers to answer with.
 */

/** The same action on the same target is not asked again for this long (a double click, a retry before the forge has caught up) */
export const COOLDOWN_MS = 5000;
/** The most actions one person takes in a minute */
export const PER_MINUTE = 20;
/** The most attempts of any kind (refused ones too) one person makes in a minute, before any is written down */
export const ATTEMPTS_PER_MINUTE = 60;

/** @type {WeakMap<object, { busy: Set<string>, last: Map<string, number>, perUser: Map<string, number[]>, attempts: Map<string, number[]> }>} */
const throttles = new WeakMap();

function throttlesOf(auth) {
  let t = throttles.get(auth);
  if (!t) throttles.set(auth, (t = { busy: new Set(), last: new Map(), perUser: new Map(), attempts: new Map() }));
  return t;
}

/** An action's own refusal: the status to answer and the words */
export class Refused extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {string} code
   * @param {Record<string, string>} [headers]
   */
  constructor(status, message, code, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/**
 * Counts an attempt of any kind; refuses one past the ceiling, without writing anything down (the release draft shares it).
 * @param {{ auth: object }} ctx
 * @param {string} userId whom to count (the forge's id for them)
 * @param {number} at now, in ms
 * @param {number} [max] the ceiling per minute (`ATTEMPTS_PER_MINUTE`)
 * @returns {Refused | null}
 */
export function countAttempt(ctx, userId, at, max = ATTEMPTS_PER_MINUTE) {
  const t = throttlesOf(ctx.auth);
  for (const [k, list] of t.attempts) if (!list.length || at - list[list.length - 1] >= 60_000) t.attempts.delete(k);
  const mine = (t.attempts.get(userId) || []).filter((when) => at - when < 60_000);
  if (mine.length >= max) {
    t.attempts.set(userId, mine);
    return new Refused(429, `That is ${max} attempts in a minute; wait a little.`, 'rate-limited', { 'Retry-After': String(Math.max(1, Math.ceil((60_000 - (at - mine[0])) / 1000))) });
  }
  mine.push(at);
  t.attempts.set(userId, mine);
  return null;
}

/**
 * Refuses a repeat and a flood; answers the function that releases `key` when the attempt is over.
 * @param {{ auth: object }} ctx
 * @param {string} userId
 * @param {string} key the action and its target, like `merge|12|` or `review|23|0013-meals`
 * @param {number} at
 * @returns {() => void}
 * @throws {Refused}
 */
export function throttle(ctx, userId, key, at) {
  const t = throttlesOf(ctx.auth);
  for (const [k, when] of t.last) if (at - when >= COOLDOWN_MS) t.last.delete(k);
  const mine = (t.perUser.get(userId) || []).filter((when) => at - when < 60_000);
  t.perUser.set(userId, mine);
  const wait = (ms, words) => new Refused(429, words, 'rate-limited', { 'Retry-After': String(Math.max(1, Math.ceil(ms / 1000))) });
  if (t.busy.has(key)) throw wait(COOLDOWN_MS, 'That is already being done; wait for it to finish.');
  const before = t.last.get(key);
  if (before !== undefined && at - before < COOLDOWN_MS) throw wait(COOLDOWN_MS - (at - before), 'That was just asked; wait a few seconds before asking again.');
  if (mine.length >= PER_MINUTE) throw wait(60_000 - (at - mine[0]), `That is ${PER_MINUTE} actions in a minute; wait a little.`);
  t.busy.add(key);
  t.last.set(key, at);
  mine.push(at);
  return () => { t.busy.delete(key); };
}

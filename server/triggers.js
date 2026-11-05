/**
 * @module server/triggers
 *
 * Opt-in triggers (issue #83, spec 0005 D10, docs/agents.md#triggers): a run asked for by something a maintainer did, with no click.
 * Off by default, and set like landing on approval is:
 *
 *   agents: { profiles: ['claude'], on: { 'spec.approved': { kind: 'code', profile: 'claude' } } }
 *
 * **One internal path.** A trigger subscribes in-process to the moments the hooks fire at (`hooks.subscribe`, server/hooks.js; not over
 * HTTP) and calls the very function the button calls, `runs.request` (server/agent-runs.js), as the maintainer whose act caused it, with
 * THEIR sign-in (`auth.forgeForUser`), so the request comment is theirs and the forge keeps the record. The cap, the rate limit and
 * the one-run-per-subject rule are the request's own, so they apply unchanged. A trigger needs no hook to be configured: the server
 * makes the hooks object anyway, with no destination, so there is a moment to subscribe to.
 *
 * **Only three events, each a maintainer's act.**
 *
 *   spec.approved   a maintainer approved a proposal (the button or the review API)     request: kind, about the proposal, posted on its spec PR
 *   build.opened    a maintainer opened the build issue of an approved proposal         request: about that issue
 *   thread.message a comment with a line that starts `/agent`, optionally with a brief   request: about that thread (the issue or spec PR)
 *
 * `/agent` is honoured only from a maintainer the forge confirms NOW, only in a comment that was not edited, and only once per comment
 * (a `thread_seen` row keyed `trigger:…`, so a restart never repeats it; the table's other readers skip keys with a colon). The rest of
 * the line is the brief. A line inside a code span or a fenced block is never a command, nor one in a quote or an indented block.
 * Every automatic request records its cause in the request itself (`trigger: { event, by, ref }`, core/agent-contract.js).
 *
 * **No chaining: a run's OUTPUT never causes a run.** In three layers:
 *   1. Structural: the only events handled are the three above. Nothing a run produces (a push, a pull request, a check, a report, a run's
 *      state change: `run.*`, `agent.requested`) is wired to a trigger; `server/agent-runs.js` does not know this module exists.
 *   2. Who: no trigger fires when the actor is a login in `agents.runners` or a bot account ("[bot]", or the forge's Bot type), or the
 *      comment holds a `cornfield-run` block.
 *   3. What: no trigger fires on a run's output: a pull request cornfield holds as a run's linked one (in any state, the run finished or
 *      not), or a pull request or issue whose text or branch carries a run id (`Cornfield-Run:`) or whose author is a runner or a bot.
 *   Each posts nothing and sends no hook, but writes a `trigger-ignored` audit row with the reason (`machine`, `run-block`, `edited`,
 *   `run-output`), so a maintainer can see why nothing happened. A comment that holds no `/agent` command is not a cause at all and writes
 *   nothing.
 *
 * **A run's TARGET is not its output.** The thread, issue or spec pull request a run was requested on may fire again once every run on it is
 * over (finished, or quiet: what the cap counts). While one is open, the trigger is skipped with `run-open` (`trigger-skipped` and the
 * hook), whatever its profile; the one-run-per-subject rule of the request path only clashes within a profile.
 *
 * **approveLands.** With `proposals.approveLands`, an approval may land the spec pull request before the trigger's request reads it; the
 * request then finds no open proposal and the trigger is skipped with `not-found` (audited, and the hook). The proposal is on the default
 * branch by then: ask for the run with the button, or use the `build.opened` trigger, which fires after the build issue is opened.
 *
 * **No live sign-in.** If the maintainer has no live session, the trigger does nothing else (cornfield holds no forge token of its own, and
 * another maintainer's would put words in their name): an audit row (`trigger-skipped`), the hook event `trigger.skipped`
 * (`reason: 'no-session'`), and the dashboard's notice on the Agents tab, which reads the last 24 hours of those rows
 * (`runs.list().triggerSkipped`). A request the cap or a limit refuses ends the same way with that refusal's code: nothing is posted.
 */

import { ForgeError, isMaintainer } from './forge.js';
import { triggersOf } from '../core/config.js';
import { EDIT_GRACE_MS, MAX_BRIEF_CHARS, RUN_TAG, TRIGGER_EVENTS, findRunId } from '../core/agent-contract.js';
import { Refused } from './throttle.js';
import { findMaintainerForge } from './spec-poll.js';

const iso = (ms) => new Date(ms).toISOString();
const lower = (s) => String(s).toLowerCase();
const words = (err) => (err instanceof Error ? err.message : String(err));

/** A bot account by its name: GitHub's apps are "name[bot]"; the forge's own Bot type rides in `Author.bot` */
export const isBotLogin = (login) => /\[bot\]$/i.test(String(login));

/** A run's own block in a comment: a fence whose info string starts `cornfield-run` (a trigger never fires on one, whoever wrote it) */
const RUN_FENCE = new RegExp(`^[ \\t]{0,3}(?:\`{3,}|~{3,})[ \\t]*${RUN_TAG}\\b`, 'mi');

/**
 * The `/agent` command of a comment: the first line that starts with `/agent` (up to three spaces in, as Markdown allows) and has
 * nothing glued to it, outside fenced code and not in a quote. The rest of that line, trimmed, is the brief. A command inside a code span is no
 * command (the span is not at the start of the line, so the line does not start with the command); one inside a fence, a quote or an
 * indented block is not read at all.
 * @param {string} text
 * @returns {{ brief: string } | null}
 */
export function agentCommand(text) {
  if (typeof text !== 'string') return null;
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    if (fence) {
      // A fence closes with a line of the same mark, at least as long, and nothing else
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    // A backtick fence's info string holds no backtick: ```x``` on one line is a code span, not a fence
    if (open && !(open[1][0] === '`' && line.slice(line.indexOf(open[1]) + open[1].length).includes('`'))) { fence = open[1]; continue; }
    const m = /^ {0,3}\/agent(?=[ \t]|$)(.*)$/.exec(line);
    if (m) return { brief: m[1].trim().slice(0, MAX_BRIEF_CHARS) };
  }
  return null;
}

/** The reason a refused request gives in `trigger.skipped` and the audit row: the refusal's own code */
function reasonOf(err) {
  if (err instanceof ForgeError) return err.code === 'unauthorized' ? 'no-session' : err.code || 'forge';
  if (err instanceof Refused) return err.code || 'refused';
  return 'error';
}

/**
 * @param {{
 *   config: any,
 *   auth: { store: () => Promise<import('node:sqlite').DatabaseSync>, record: Function, forgeForUser: (userId: string) => Promise<import('./forge.js').Forge> },
 *   runs: { request: Function },
 *   hooks: import('./hooks.js').Hooks,
 *   now?: () => number,
 * }} opts
 */
export function createTriggers({ config, auth, runs, hooks, now = Date.now }) {
  const repo = config.forge.repo;
  const agents = config.agents || {};
  const rules = new Map(triggersOf(config));
  const runnerSet = new Set((Array.isArray(agents.runners) ? agents.runners : []).map(lower));
  const log = (what) => console.error(`[cornfield] triggers: ${what}`);
  /** One event at a time, in the order they came: the cap is checked inside the request, and a test can wait for the queue */
  let queue = Promise.resolve();

  /** Whether an account is a runner or a bot: what it does is a run's output, never a cause */
  const machine = (login, bot = false) => bot === true || isBotLogin(login) || runnerSet.has(lower(login));

  /** Whether cornfield holds this number as a run's linked pull request: a run's output, in any state, the run finished or not */
  async function runOutput(numbers) {
    const db = await auth.store();
    const ask = db.prepare('SELECT 1 FROM runs WHERE repo = ? AND pull = ? LIMIT 1');
    return numbers.some((n) => Number.isInteger(n) && ask.get(repo, n) !== undefined);
  }

  /**
   * Whether a pull request or issue is a run's output by what it says: a run id in its text or branch, or an author that is a runner or a bot.
   * Read with the person's own forge. Fails closed: what cannot be read is treated as a run's.
   */
  async function outputOfRun(forge, n) {
    try {
      let item;
      try {
        item = await forge.pull(n);
      } catch (err) {
        if (!(err instanceof ForgeError) || err.code !== 'not-found') throw err;
        item = await forge.issue(n);
      }
      if (item.author && machine(item.author.login, item.author.bot === true)) return true;
      return findRunId({ body: item.body, branch: item.head?.ref }) !== null;
    } catch (err) {
      log(`#${n} could not be read, so no trigger fires on it: ${words(err)}`);
      return true;
    }
  }

  /** A live sign-in's user id for a login, or null */
  async function sessionOf(login) {
    const db = await auth.store();
    const row = /** @type {{ user_id: string } | undefined} */ (db.prepare("SELECT user_id FROM sessions WHERE lower(login) = ? AND token <> '' AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(lower(login), iso(now())));
    return row ? row.user_id : null;
  }

  /** Remembers that this cause was acted on; false if it was already (a repeat, or a restart) */
  async function first(number, key) {
    const db = await auth.store();
    return db.prepare('INSERT OR IGNORE INTO thread_seen (repo, issue, comment, stamp, at) VALUES (?, ?, ?, ?, ?)').run(repo, number, key, '', iso(now())).changes === 1;
  }

  /**
   * A no-chaining exit: an audit row (`trigger-ignored`, with the reason) and nothing else, no hook and nothing posted, so a maintainer can
   * see why an act of theirs started nothing. Never the comment's text: only the event, who and the reference.
   */
  async function ignore(cause, reason) {
    try {
      await auth.record({ login: cause.by, action: 'trigger-ignored', target: `${repo}#${cause.subject}`, request: { event: cause.event, by: cause.by, ref: cause.ref }, status: null, answer: { reason } });
    } catch (err) {
      log(`an ignored trigger could not be written to the audit table: ${words(err)}`);
    }
  }

  /** The trigger did nothing, and says why: an audit row and the `trigger.skipped` hook event. It posts nothing. */
  async function skip(cause, reason) {
    try {
      await auth.record({ login: cause.by, action: 'trigger-skipped', target: `${repo}#${cause.subject}`, request: { event: cause.event, by: cause.by, ref: cause.ref }, status: null, answer: { reason } });
    } catch (err) {
      log(`a skipped trigger could not be written to the audit table: ${words(err)}`);
    }
    hooks.emit('trigger.skipped', { trigger: { event: cause.event, by: cause.by, ref: cause.ref }, by: cause.by, reason });
  }

  /** What caused a trigger, from a hook event's payload; null when it is not one a trigger may fire on */
  function causeOf(event, p) {
    if (event === 'spec.approved') {
      if (typeof p.actor !== 'string' || !Number.isInteger(p.pull) || typeof p.slug !== 'string') return null;
      return { event, by: p.actor, ref: `pull:${p.pull}`, subject: p.pull, owned: [p.pull], checked: [p.pull], refs: { proposal: p.slug }, key: `trigger:spec.approved:${p.headSha ?? ''}`, brief: '' };
    }
    if (event === 'build.opened') {
      if (typeof p.actor !== 'string' || !Number.isInteger(p.issue)) return null;
      return { event, by: p.actor, ref: `issue:${p.issue}`, subject: p.issue, owned: [p.issue, p.pull], checked: [p.pull, p.issue], refs: { issue: p.issue }, key: `trigger:build.opened:${p.issue}`, brief: '' };
    }
    if (event === 'thread.message') {
      const m = p.message;
      if (!m || typeof m.body !== 'string' || typeof p.actor !== 'string' || !Number.isInteger(p.thread) || p.comment === undefined) return null;
      return { event, by: p.actor, ref: `comment:${p.comment}`, subject: p.thread, owned: [p.thread], checked: [p.thread], refs: { thread: p.thread }, key: `trigger:comment:${p.comment}`, message: m, brief: '' };
    }
    return null;
  }

  async function handle(event, p) {
    const rule = rules.get(event);
    if (!rule) return;
    const cause = causeOf(event, p);
    if (!cause) return;

    // --- a comment with no /agent command is no cause at all: nothing, not even a row (most thread messages are this)
    const command = cause.message ? agentCommand(cause.message.body) : null;
    if (cause.message && !command) return;
    // --- who: a runner or a bot never causes anything; a run's own block is no command; an edited comment is not trusted
    if (machine(cause.by) || cause.message?.bot === true) return ignore(cause, 'machine');
    if (cause.message) {
      const m = cause.message;
      if (RUN_FENCE.test(m.body)) return ignore(cause, 'run-block');
      // Both forges give the comment's own created and updated times; one missing or unreadable counts as edited (fails closed)
      if (!(Date.parse(m.updatedAt) - Date.parse(m.createdAt) <= EDIT_GRACE_MS)) return ignore(cause, 'edited');
      cause.brief = command.brief;
    }
    // --- what: a run's output (its linked pull request) never fires, in any state
    if (await runOutput(cause.owned)) return ignore(cause, 'run-output');
    // --- once: a cause is acted on one time, across restarts
    if (!(await first(cause.subject, cause.key))) return;

    // --- a command is honoured only from a maintainer the forge confirms now (the others get nothing, not even a row)
    if (cause.message) {
      const found = await findMaintainerForge({ auth, repo, now });
      if (!found) { log('no signed-in maintainer to confirm who wrote an /agent comment, so it was not honoured'); return; }
      let permission;
      try {
        permission = await found.forge.permission(repo, cause.by);
      } catch (err) {
        log(`the permission of ${cause.by} could not be read, so their /agent comment was not honoured: ${words(err)}`);
        return;
      }
      if (!isMaintainer(permission)) return;
    }

    // --- a run's target may fire again once its runs are over; while one is open, the trigger is skipped and says so
    if (typeof runs.openOn === 'function' && await runs.openOn({ number: cause.subject, refs: cause.refs })) return skip(cause, 'run-open');

    // --- the maintainer's own sign-in, or nothing else
    const userId = await sessionOf(cause.by);
    if (userId === null) return skip(cause, 'no-session');
    let forge;
    try {
      forge = await auth.forgeForUser(userId);
    } catch (err) {
      return skip(cause, reasonOf(err));
    }
    // The pull request or issue itself may be a run's (a run id in its text or branch, a runner as its author) before cornfield has linked it
    for (const n of cause.checked) if (Number.isInteger(n) && await outputOfRun(forge, n)) return ignore(cause, 'run-output');

    const body = { kind: rule.kind, ...(rule.profile ? { profile: rule.profile } : {}), refs: cause.refs, brief: cause.brief || rule.brief || '' };
    try {
      await runs.request({
        forge: () => forge, who: { login: cause.by, userId: String(userId) }, limits: { auth, now },
        trigger: { event: cause.event, ref: cause.ref },
      }, { body });
    } catch (err) {
      if (!(err instanceof Refused) && !(err instanceof ForgeError)) log(`a ${event} trigger failed: ${err instanceof Error ? err.stack || err.message : err}`);
      return skip(cause, reasonOf(err));
    }
  }

  /** The hooks' moments: the only ones a trigger looks at are the three a maintainer causes */
  function onEvent(event, payload) {
    if (!TRIGGER_EVENTS.includes(event) || !rules.has(event)) return queue;
    queue = queue.then(() => handle(event, payload)).catch((err) => log(`a ${event} trigger failed: ${words(err)}`));
    return queue;
  }

  hooks.subscribe(onEvent, [...rules.keys()]);

  return {
    /** Which events have a trigger */
    events: [...rules.keys()],
    /** Resolves when every event handed so far has been dealt with (for tests and for a clean shutdown) */
    idle: () => queue,
  };
}

/** @typedef {ReturnType<typeof createTriggers>} Triggers */

/**
 * @module server/threads
 *
 * Threads (spec 0005, D6 and D7; docs/threads.md): a conversation that lives on the forge, which cornfield only shows.
 *
 *   - **An idea** is an issue with the label `config.threads.label` (`idea`); its thread is that issue's comments.
 *   - **A proposal's thread** is the conversation of its spec pull request (an open PR that adds or changes a proposal).
 *   - A spec PR **names its idea** with `Thread: #n` or `Closes #n` in its text (`threadOfPull`), so the idea lists its proposals.
 *   - What a thread points at on the map is written in its text: `[[node-id]]`, `[[repo/path]]`, or a `cornfield-thread` block
 *     (core/mentions.js). The server hands the page the references as written (`refs`); the page resolves them against the map
 *     it is showing, so a proposal's what-if map and the live layer light the same way. A hook's payload resolves them here,
 *     against the checkout's map (`topology.json`).
 *
 * **Nothing here is stored.** The forge is read with the signed-in maintainer's own token, through the interface
 * (server/forge.js); SQLite only caches answers (`forge_cache`, server/forge-routes.js) and remembers which events a hook sent
 * (`thread_seen`, server/hooks.js). The one write is `createIdea`: an issue with the idea label, as the maintainer, which adds
 * and changes nothing that exists (the label itself is made first when the repo lacks it: by the forge on GitHub, by the
 * adapter on Forgejo, which says so in `labelsMade`). No read ever writes.
 *
 * **One look, two doors.** `gatherThreads` reads the ideas and the spec PRs' conversations. The dashboard's list calls it for
 * everything (so a node's "Mentioned in" is complete); the poll (server/spec-poll.js) calls it with the cursors the database
 * keeps, so a tick with nothing new costs the issue listing and one call per open spec PR. Both hand what they read to
 * `hooks.threadsSeen`, which sends each event once.
 */

import { ForgeError } from './forge.js';
import { listPullProposals, pullProposals, forgeWords } from './proposal-pulls.js';
import { ideaLabel } from '../core/config.js';
import { linksOf, parseMentions, resolveMentions, threadOfPull } from '../core/mentions.js';

/** The most threads a list reads, and the most comments of one thread that are kept */
export const THREAD_LIMIT = 100;
export const POLL_LIMIT = 200;
export const MESSAGE_LIMIT = 200;
/** The longest text of one message that is sent to the page (a longer one is cut, and says so) */
export const BODY_LIMIT = 20_000;
/** How many threads have their comments asked at once */
const PARALLEL = 6;

const invalid = (message) => new ForgeError(message, { code: 'invalid' });

/** Whether threads are off in this config */
export const threadsOff = (config) => config.threads === false;

/** An issue is an idea when it carries the label (case does not matter, as on the forges) */
const isIdea = (issue, label) => issue.labels.some((l) => l.toLowerCase() === label.toLowerCase());

/** A comment, for the page: the author, the time, the text as written (cut when very long) */
const messageOf = (c) => ({
  id: c.id, author: c.author, url: c.url, createdAt: c.createdAt, updatedAt: c.updatedAt,
  body: c.body.length > BODY_LIMIT ? c.body.slice(0, BODY_LIMIT) : c.body, ...(c.body.length > BODY_LIMIT ? { cut: true } : {}), ...(c.opening ? { opening: true } : {}),
});

/** Runs `fn` over `items`, `PARALLEL` at a time, keeping the order */
async function each(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) {
      const at = next++;
      out[at] = await fn(items[at]);
    }
  }));
  return out;
}

/**
 * Reads the threads off the forge: the ideas (issues with the label) and the spec PRs' conversations.
 * @param {import('./forge.js').Forge} forge
 * @param {any} config
 * @param {{ proposals: string }} where
 * @param {{
 *   state?: 'open' | 'closed' | 'all', limit?: number, hooks?: any,
 *   cursors?: Map<number, { stamp: string, since: string }> | null,
 * }} [opts] `cursors` (the poll): a thread whose `updatedAt` is the one last looked at is not read again, and the others only
 *   from the time of the newest comment seen
 * @returns {Promise<{ threads: any[], pulls: any[], problem: string | null }>} each thread
 *   `{ kind, number, item, comments, failed }` (`item` the issue or pull request); `pulls` the spec PRs that name an idea:
 *   `{ pull, thread, slug }`
 */
export async function gatherThreads(forge, config, where, { state = 'open', limit = THREAD_LIMIT, hooks = null, cursors = null } = {}) {
  const label = ideaLabel(config);
  if (label === null) return { threads: [], pulls: [], problem: null };
  let problem = null;
  const [issues, specs] = await Promise.all([
    forge.issues({ state, labels: [label], limit }),
    listPullProposals(forge, where, { hooks }),
  ]);
  problem = specs.problem;
  const slugs = new Map();
  for (const e of specs.entries) slugs.set(e.pull.number, [...(slugs.get(e.pull.number) || []), e.slug]);
  const proposals = specs.pulls.filter((p) => slugs.has(p.number));
  const all = [
    ...issues.filter((i) => isIdea(i, label)).map((item) => ({ kind: 'idea', number: item.number, item, slugs: [] })),
    ...proposals.map((item) => ({ kind: 'proposal', number: item.number, item, slugs: slugs.get(item.number) })),
  ];
  const read = await each(all, async (t) => {
    const cursor = cursors && cursors.get(t.number);
    if (cursor && cursor.stamp === t.item.updatedAt) return { ...t, comments: [], unchanged: true, failed: false };
    // Nothing to ask for an idea that has no comment (its text is the issue's)
    if (t.kind === 'idea' && !cursor && t.item.comments === 0) return { ...t, comments: [], failed: false };
    try {
      const comments = await forge.comments(t.number, cursor && cursor.since ? { since: cursor.since } : undefined);
      return { ...t, comments, failed: false };
    } catch (err) {
      problem ??= forgeWords(err);
      return { ...t, comments: [], failed: true };
    }
  });
  const ideas = new Set(read.filter((t) => t.kind === 'idea').map((t) => t.number));
  const pulls = [];
  for (const p of proposals) {
    const thread = threadOfPull(p.body);
    if (thread !== null && ideas.has(thread)) pulls.push({ pull: p.number, thread, slug: slugs.get(p.number)[0] });
  }
  return { threads: read, pulls, problem };
}

/** One thread as the list shows it: no message text, but the references its text holds, as written */
function summaryOf(t, pulls) {
  const { item } = t;
  const texts = [...(t.kind === 'idea' ? [item.body] : []), ...t.comments.map((c) => c.body)];
  const links = linksOf(texts);
  const named = pulls.filter((p) => p.thread === t.number).map((p) => ({ pull: p.pull, slug: p.slug }));
  const own = pulls.find((p) => p.pull === t.number);
  return {
    kind: t.kind,
    number: t.number,
    title: item.title,
    state: item.state,
    author: item.author,
    labels: item.labels,
    url: item.url,
    createdAt: item.createdAt,
    updatedAt: lastActivity(item, t.comments),
    comments: t.kind === 'idea' ? Math.max(item.comments ?? 0, t.comments.length) : t.comments.length,
    refs: links.refs,
    ...(links.proposal ? { proposal: links.proposal } : {}),
    ...(t.kind === 'idea' && named.length ? { proposals: named } : {}),
    ...(t.kind === 'proposal' ? { slugs: t.slugs, ...(own ? { idea: own.thread } : {}) } : {}),
  };
}

/** The newest time among a thread and its comments: what "newest activity first" sorts by */
const lastActivity = (item, comments) => comments.reduce((newest, c) => (c.updatedAt > newest ? c.updatedAt : newest), item.updatedAt);

/**
 * The threads list for the page: ideas and proposals' conversations, newest activity first.
 * @returns {Promise<{ items: object[], problem: string | null, label: string }>}
 */
export async function listThreads(forge, config, where, opts = {}) {
  const got = await gatherThreads(forge, config, where, opts);
  const items = got.threads.filter((t) => !t.failed).map((t) => summaryOf(t, got.pulls));
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b.number - a.number));
  return { items, problem: got.problem, label: ideaLabel(config), gathered: got };
}

/**
 * One thread's messages for the page, read-only: an idea's text and its comments, or a proposal's conversation. A number that
 * is no idea (no label) and no spec PR is not a thread.
 * @param {import('./forge.js').Forge} forge
 * @param {any} config
 * @param {{ proposals: string }} where
 * @param {number} n
 */
export async function readThread(forge, config, where, n) {
  const label = ideaLabel(config);
  if (label === null) throw new ForgeError('Threads are off in this config (threads: false).', { code: 'not-found' });
  const notAThread = () => new ForgeError(`#${n} is not a thread: an idea is an issue labelled "${label}", and a proposal's thread is its spec pull request.`, { code: 'not-found' });
  let issue = null;
  try {
    issue = await forge.issue(n);
  } catch (err) {
    if (!(err instanceof ForgeError) || err.code !== 'not-found') throw err;
  }
  if (issue) {
    if (!isIdea(issue, label)) throw notAThread();
    const comments = await forge.comments(n);
    const shown = comments.slice(-MESSAGE_LIMIT);
    const opening = { id: 'opening', author: issue.author, url: issue.url, createdAt: issue.createdAt, updatedAt: issue.updatedAt, body: issue.body, opening: true };
    return {
      kind: 'idea', number: n, title: issue.title, state: issue.state, author: issue.author, url: issue.url, labels: issue.labels,
      createdAt: issue.createdAt, updatedAt: lastActivity(issue, comments),
      messages: [messageOf(opening), ...shown.map(messageOf)], hidden: comments.length - shown.length,
      ...(await namedBy(forge, where, n)),
    };
  }
  let pull;
  try {
    pull = await forge.pull(n);
  } catch (err) {
    if (err instanceof ForgeError && err.code === 'not-found') throw notAThread();
    throw err;
  }
  const entries = await pullProposals(forge, where, pull);
  if (!entries.length) throw notAThread();
  const comments = await forge.comments(n);
  const shown = comments.slice(-MESSAGE_LIMIT);
  const idea = threadOfPull(pull.body);
  return {
    kind: 'proposal', number: n, title: pull.title, state: pull.state, author: pull.author, url: pull.url, labels: pull.labels, slugs: entries.map((e) => e.slug),
    createdAt: pull.createdAt, updatedAt: lastActivity(pull, comments), messages: shown.map(messageOf), hidden: comments.length - shown.length,
    ...(idea !== null ? { idea } : {}),
  };
}

/** The spec PRs that name idea `n`: `proposals: [{ pull, slug }]` */
async function namedBy(forge, where, n) {
  try {
    const specs = await listPullProposals(forge, where);
    const slugs = new Map();
    for (const e of specs.entries) slugs.set(e.pull.number, e.slug);
    const proposals = specs.pulls.filter((p) => slugs.has(p.number) && threadOfPull(p.body) === n).map((p) => ({ pull: p.number, slug: slugs.get(p.number) }));
    return proposals.length ? { proposals } : {};
  } catch {
    return {};
  }
}

/** The title and text of a new idea, checked: a title, and a text that may be left empty */
export function ideaInput(asked) {
  const plain = asked !== null && typeof asked === 'object' && !Array.isArray(asked);
  const extra = plain ? Object.keys(asked).find((k) => !['title', 'body'].includes(k)) : null;
  if (!plain || extra) throw invalid(extra ? `An idea has a title and a text, not "${extra}".` : 'An idea is { title, body }.');
  if (typeof asked.title !== 'string' || asked.title.trim() === '' || asked.title.includes('\0')) throw invalid('Give the idea a title.');
  if (asked.title.length > 256) throw invalid('The title is at most 256 characters.');
  if (asked.body !== undefined && (typeof asked.body !== 'string' || asked.body.includes('\0'))) throw invalid('The text of an idea is text.');
  const body = typeof asked.body === 'string' ? asked.body : '';
  if (body.length > BODY_LIMIT) throw invalid(`The text is at most ${BODY_LIMIT} characters.`);
  return { title: asked.title.trim(), body: body.trim() === '' ? '_No description yet._' : body };
}

/**
 * Opens an idea: an issue with the label, as whoever's token the forge is bound to. It only adds.
 * @param {import('./forge.js').Forge} forge
 * @param {any} config
 * @param {{ title: string, body: string }} idea as `ideaInput` gives it
 */
export function createIdea(forge, config, idea) {
  const label = ideaLabel(config);
  if (label === null) throw new ForgeError('Threads are off in this config (threads: false).', { code: 'not-found' });
  return forge.createIssue({ title: idea.title, body: idea.body, labels: [label] });
}

// ---------------------------------------------------------------------------
//  What a hook is told
// ---------------------------------------------------------------------------

const linkOf = (text, nodes) => {
  const got = parseMentions(text);
  const refs = [...got.refs, ...(got.block ? got.block.nodes : [])];
  const ids = resolveMentions(refs, nodes).ids;
  const proposal = got.block ? got.block.proposal : null;
  return ids.length || proposal ? { nodes: ids, proposal } : null;
};

/**
 * What `hooks.threadsSeen` is handed: for each thread, who opened it, its comments (their id, author, own time and what they
 * link to, resolved against `nodes`), and the spec PRs that name it. Never a text: a hook says that something was said, not what.
 * @param {{ threads: any[], pulls: any[] }} got `gatherThreads`' answer
 * @param {{ id: string, file?: string }[]} nodes the checkout's map
 */
export function snapshotOf(got, nodes) {
  return {
    threads: got.threads.filter((t) => !t.failed).map((t) => ({
      number: t.number,
      kind: t.kind,
      stamp: t.item.updatedAt,
      unchanged: Boolean(t.unchanged),
      opened: t.kind === 'idea' ? { actor: t.item.author ? t.item.author.login : null, linked: linkOf(t.item.body, nodes) } : null,
      messages: t.comments.map((c) => ({ id: c.id, actor: c.author ? c.author.login : null, stamp: c.updatedAt, linked: linkOf(c.body, nodes) })),
    })),
    pulls: got.pulls,
  };
}

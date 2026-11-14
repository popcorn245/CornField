/**
 * @module explorer/forge-panel-model
 *
 * The issues and PRs panel, the pure half: no DOM, no `window`, no clock (the time is passed in). forge-panel.js
 * is the half that touches the page and the network; what is asked, what the words are and which nodes light up
 * are decided here so they can be tested without one.
 *
 *   listUrl, serverState      what to ask the server (`/api/forge/…`, server/forge-routes.js) for a kind and a state
 *   filterItems, facetsOf     the filters on a list already loaded: state (merged is a closed pull request that landed), label, author, text
 *   stateWords, metaWords     "Open", "Draft", "Merged"; "#12 · agent-four · 3 days ago"
 *   checkWords, checksWords   a check's state, and the whole set in one line: "1 failed, 1 still running"
 *   nodesForFile              the node(s) whose `file` holds a path: the deepest `file` that is the path or a folder of it
 *   testFilesOf               the test files a check's name names
 *   litFor                    for one pull request: which nodes its files are, and which a failing check's tests are
 *   nodesForRestarts, litForDeploy   for one deploy (PIPE-03): the nodes the config says it restarted (a stack brings its containers),
 *                             and the refs that are on no node; the deploys list's filters and words (matchesDeploy, deployWords, deployMeta)
 *   errorWords                a failed request, in words
 *   mergeBlock, rerunWhy      the actions (CF-08): why a pull request cannot be landed now, why a failed check cannot be re-run
 *   confirmMerge, mergeBody   what the confirm step shows of what will land, and what is sent when it is confirmed
 *   actionUrl, actionWords    where an action is posted, and how the answer is said
 *   specBlock, buildOffers    the pipeline's steps (PIPE-05): why a spec cannot be started on an issue; which proposals of a spec pull request can have a build issue
 *   planUrl, confirmSpec, confirmBuild, specBody, buildBody, existingWords
 *                             where a step's plan is read, what the confirm step shows of it, what is sent to confirm it, and what is said of one that is made already
 *   landingUrl, cancelLandingUrl, landingWords
 *                             a spec pull request waiting to land on its approval (`proposals.approveLands`, server/lander.js): where it is read, where it is cancelled, and the words
 *   threadsUrl, threadUrl, IDEAS_URL, threadKindWords, threadMeta, litForThread, mentionsIndex, mentionsOf, messageNodes, ideaRequest, ideaWords
 *                             the Threads tab (docs/threads.md): what to ask, a thread's words, which nodes its text lights and which threads mention a node
 *   notesUrl, sinceChoices, notesSummary, validTag, confirmWords, postedWords, draftRequest
 *                             the Release notes view: what to ask, the tags to start from, and the words around a draft
 */

import { relativeTime } from './review-model.js';
import { nodesForFile, linksOf, parseMentions, resolveMentions } from '../core/mentions.js';

export const KINDS = Object.freeze(['pulls', 'issues', 'threads', 'deploys', 'notes']);
/** The states a list offers: [value, label]; a pull request that landed is "merged", one closed without landing "closed" */
export const STATES = Object.freeze({
  pulls: [['open', 'Open'], ['merged', 'Merged'], ['closed', 'Closed'], ['all', 'All']],
  issues: [['open', 'Open'], ['closed', 'Closed'], ['all', 'All']],
  threads: [['open', 'Open'], ['closed', 'Closed'], ['all', 'All']],
  deploys: [['all', 'All'], ['success', 'Succeeded'], ['failure', 'Failed'], ['running', 'Running or waiting'], ['other', 'Cancelled or skipped']],
});
/** How many a list asks for (the server's own default; its most is 300) */
export const LIST_LIMIT = 100;
export const defaultFilters = (kind = 'pulls') => ({ state: kind === 'deploys' ? 'all' : 'open', label: '', author: '', text: '' });

/** What the server is asked for: a merged pull request is a closed one, filtered after */
export const serverState = (state) => (state === 'merged' ? 'closed' : state);

/** The address of a list */
export const listUrl = (kind, state) => (kind === 'deploys' ? `/api/forge/deploys?limit=${LIST_LIMIT}` : kind === 'threads' ? threadsUrl(state) : `/api/forge/${kind}?state=${serverState(state)}&limit=${LIST_LIMIT}`);
/** What a list is kept under: a deploys list is filtered by state here, so every state is one list */
export const listKeyOf = (kind, state) => (kind === 'deploys' ? 'deploys' : `${kind}|${serverState(state)}`);
/** The address of the threads list for a state, of one thread, and where a new idea is posted */
export const threadsUrl = (state) => `/api/forge/threads?state=${state}&limit=${LIST_LIMIT}`;
export const threadUrl = (n) => `/api/forge/threads/${n}`;
export const IDEAS_URL = '/api/forge/threads';
/** The address of one issue, whatever its state */
export const issueUrl = (n) => `/api/forge/issues/${n}`;
/** The address of one pull request with its files and checks */
export const pullUrl = (n) => `/api/forge/pulls/${n}`;

/** Where a pull request's landing on approval is read (GET) and cancelled (POST) */
export const landingUrl = (n) => `/api/forge/pulls/${n}/landing`;
export const cancelLandingUrl = (n) => `/api/forge/pulls/${n}/landing/cancel`;

/**
 * The line for a pull request waiting to land on its approval: "Will land when checks pass".
 * @param {{ slug: string, by: string, since: string } | null} landing what the server says is waiting
 * @param {number} nowMs
 * @returns {string} empty when nothing is waiting
 */
export function landingWords(landing, nowMs) {
  if (!landing) return '';
  return `Will land when checks pass. ${landing.slug} was approved by ${landing.by} ${relativeTime(landing.since, nowMs)}; it lands at that head only, and a push cancels it.`;
}

/** Whether a list's item passes the filters (the state of a pull request is decided here: open, merged, closed without landing) */
export function matches(item, kind, filters) {
  const f = { ...defaultFilters(), ...filters };
  if (kind === 'pulls') {
    if (f.state === 'open' && item.state !== 'open') return false;
    if (f.state === 'merged' && item.state !== 'merged') return false;
    if (f.state === 'closed' && item.state !== 'closed') return false;
  } else if (f.state !== 'all' && item.state !== f.state) return false;
  if (f.label && !item.labels.includes(f.label)) return false;
  if (f.author && (!item.author || item.author.login !== f.author)) return false;
  const text = f.text.trim().toLowerCase();
  if (text) {
    const hay = `#${item.number} ${item.title} ${item.author ? item.author.login : ''} ${item.labels.join(' ')}`.toLowerCase();
    if (!text.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

/** Whether a deploy passes the filters: its state (cancelled and skipped are "other") and the search over its words */
export function matchesDeploy(deploy, filters) {
  const f = { ...defaultFilters('deploys'), ...filters };
  const group = { success: 'success', failure: 'failure', running: 'running', queued: 'running' }[deploy.state] || 'other';
  if (f.state !== 'all' && f.state !== group) return false;
  const text = f.text.trim().toLowerCase();
  if (!text) return true;
  const hay = `${deploy.name} ${deploy.workflow} ${deploy.title} ${deploy.branch} ${deploy.event} ${deploy.actor ? deploy.actor.login : ''} ${deploy.sha.slice(0, 7)}`.toLowerCase();
  return text.split(/\s+/).every((word) => hay.includes(word));
}

/** The items that pass the filters, in the order the forge gave them (newest first) */
export const filterItems = (items, kind, filters) => (kind === 'deploys' ? items.filter((d) => matchesDeploy(d, filters)) : items.filter((item) => matches(item, kind, filters)));

/** The labels and authors in a list, for the filters' choices: each once, sorted */
export function facetsOf(items) {
  const labels = new Set();
  const authors = new Set();
  for (const item of items) {
    item.labels.forEach((l) => labels.add(l));
    if (item.author) authors.add(item.author.login);
  }
  const sorted = (set) => [...set].sort((a, b) => a.localeCompare(b));
  return { labels: sorted(labels), authors: sorted(authors) };
}

/** "Open", "Draft", "Merged", "Closed" */
export function stateWords(item) {
  if (item.state === 'open') return item.draft ? 'Draft' : 'Open';
  return item.state === 'merged' ? 'Merged' : 'Closed';
}

/** "#12 · agent-four · 3 days ago" (the time of the last change) */
export function metaWords(item, nowMs) {
  const when = relativeTime(item.updatedAt, nowMs);
  return [`#${item.number}`, item.author ? item.author.login : 'someone', when].filter(Boolean).join(' · ');
}

const CHECK_WORDS = { success: 'passed', failure: 'failed', running: 'running', queued: 'waiting', neutral: 'neutral', skipped: 'skipped', cancelled: 'cancelled' };
/** A check's state, in a word */
export const checkWords = (check) => CHECK_WORDS[check.state] || check.state;

/** All of a commit's checks in one line: "No checks", "All 2 passed", "1 failed, 1 still running" */
export function checksWords(checks) {
  if (!checks.length) return 'No checks';
  const n = (states) => checks.filter((c) => states.includes(c.state)).length;
  const failed = n(['failure']);
  const cancelled = n(['cancelled']);
  const waiting = n(['running', 'queued']);
  const parts = [];
  if (failed) parts.push(`${failed} failed`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  if (waiting) parts.push(`${waiting} still running`);
  if (!parts.length) return checks.length === 1 ? '1 check passed' : `All ${checks.length} passed`;
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
//  Files to nodes
// ---------------------------------------------------------------------------

const clean = (p) => String(p).replace(/^\.\//, '').replace(/\/+$/, '');

// The map's rule for a file's node(s) is core/mentions.js's too (a thread's [[server/auth.js]] resolves the same way)
export { nodesForFile };

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|\.(?:test|spec)\.[a-z]+$|_test\.[a-z]+$|(?:^|\/)test_[^/]+\.py$/i;
/** Whether a path looks like a test file */
export const isTestPath = (path) => TEST_PATH.test(path);

/**
 * The test files a check's name names: any word in it that is a test file's path, or the end of one (the repo's
 * files, or the pull request's). "vitest test/server/auth.test.js" names that file; "test" names none.
 * @param {{ name: string }} check
 * @param {string[]} known the paths to match a short name against (the pull request's files and the nodes' files)
 * @returns {string[]} full paths, each once
 */
export function testFilesOf(check, known) {
  const out = new Set();
  for (const word of String(check.name).split(/[\s,;:()[\]'"`]+/)) {
    const w = clean(word);
    if (!w || !isTestPath(w)) continue;
    if (known.includes(w)) { out.add(w); continue; }
    const ends = known.filter((k) => k.endsWith(`/${w}`));
    out.add(ends.length === 1 ? ends[0] : w);
  }
  return [...out];
}

/**
 * What one pull request lights. `files` are its files (the forge's), `checks` the checks on its head.
 * @param {{ files: { path: string, previousPath?: string | null, status: string }[], checks: { name: string, state: string }[] }} detail
 * @param {{ id: string, file?: string }[]} nodes the map's nodes
 * @returns {{
 *   files: { path: string, status: string, additions: number, deletions: number, nodes: object[] }[],
 *   checks: { check: object, tests: { path: string, nodes: object[] }[] }[],
 *   changed: Set<string>, failing: Set<string>,
 * }} `files` in the forge's order with the nodes each is; `checks` the failed ones with the tests they name;
 *   `changed` the ids of the nodes the files are, `failing` the ids of the nodes of the failing checks' tests
 */
export function litFor(detail, nodes) {
  const changed = new Set();
  const files = detail.files.map((f) => {
    // A rename lights the node of the old path too: the map was drawn before the move
    const found = [...nodesForFile(f.path, nodes), ...(f.previousPath ? nodesForFile(f.previousPath, nodes) : [])];
    const unique = [...new Map(found.map((n) => [n.id, n])).values()];
    unique.forEach((n) => changed.add(n.id));
    return { ...f, additions: f.additions ?? 0, deletions: f.deletions ?? 0, nodes: unique };
  });
  const known = [...new Set([...detail.files.map((f) => f.path), ...nodes.map((n) => n.file).filter((f) => typeof f === 'string')])];
  const failing = new Set();
  const checks = detail.checks.filter((c) => c.state === 'failure').map((check) => ({
    check,
    tests: testFilesOf(check, known).map((path) => {
      const found = nodesForFile(path, nodes);
      found.forEach((n) => failing.add(n.id));
      return { path, nodes: found };
    }),
  }));
  return { files, checks, changed, failing };
}

// ---------------------------------------------------------------------------
//  Deploys to nodes
// ---------------------------------------------------------------------------

const DEPLOY_WORDS = { success: 'Succeeded', failure: 'Failed', running: 'Running', queued: 'Waiting', cancelled: 'Cancelled', skipped: 'Skipped', neutral: 'Finished' };
/** A deploy's state, in a word */
export const deployWords = (deploy) => DEPLOY_WORDS[deploy.state] || deploy.state;

/** "main · abc1234 · maintainer-one · 3 days ago" (the branch or tag, the commit, who started it, when it last changed) */
export function deployMeta(deploy, nowMs) {
  return [deploy.branch, deploy.sha ? deploy.sha.slice(0, 7) : '', deploy.actor ? deploy.actor.login : '', relativeTime(deploy.updatedAt || deploy.createdAt, nowMs)].filter(Boolean).join(' · ');
}

/**
 * The nodes a deploy restarted, from the refs the config gave it. A ref is a node's id, or else its label (every node
 * with that label); a stack restarts its containers too (the node of type `stack` and the `container` nodes whose
 * `stack` is its label). A ref no node answers to is reported, not dropped.
 * @param {string[]} refs
 * @param {{ id: string, label?: string, type?: string, stack?: string }[]} nodes
 * @returns {{ nodes: object[], missing: string[] }} each node once, in the order of the refs
 */
export function nodesForRestarts(refs, nodes) {
  const found = new Map();
  const missing = [];
  for (const ref of refs) {
    const byId = nodes.filter((n) => n.id === ref);
    const hit = byId.length ? byId : nodes.filter((n) => typeof n.label === 'string' && n.label.toLowerCase() === String(ref).toLowerCase());
    if (!hit.length) { missing.push(ref); continue; }
    for (const n of hit) {
      found.set(n.id, n);
      if (n.type === 'stack') for (const c of nodes) if (c.type === 'container' && c.stack === n.label) found.set(c.id, c);
    }
  }
  return { nodes: [...found.values()], missing };
}

/**
 * What one deploy lights: the nodes it restarted. A deploy that failed lights them as a failing check lights its tests
 * (red); any other lights them as a pull request's files are (amber). A deploy the config maps to nothing lights nothing.
 * @param {{ state: string, restarts: string[] }} deploy
 * @param {object[]} nodes the map's nodes
 * @returns {{ nodes: object[], missing: string[], changed: Set<string>, failing: Set<string> }}
 */
export function litForDeploy(deploy, nodes) {
  const { nodes: hit, missing } = nodesForRestarts(deploy.restarts || [], nodes);
  const ids = new Set(hit.map((n) => n.id));
  return deploy.state === 'failure'
    ? { nodes: hit, missing, changed: new Set(), failing: ids }
    : { nodes: hit, missing, changed: ids, failing: new Set() };
}

// ---------------------------------------------------------------------------
//  Threads: a conversation on the forge that points at the map (core/mentions.js)
// ---------------------------------------------------------------------------

/** "Idea", or "Proposal 0040-meals" for a spec PR's conversation */
export const threadKindWords = (t) => (t.kind === 'proposal' ? `Proposal${t.slugs && t.slugs.length ? ` ${t.slugs.join(', ')}` : ''}` : 'Idea');

/** "#41 · maintainer-one · 3 comments · 2 days ago" (the time of the last message) */
export function threadMeta(t, nowMs) {
  const count = t.kind === 'proposal' && !t.comments ? 'no comments' : `${t.comments} ${t.comments === 1 ? 'comment' : 'comments'}`;
  return [`#${t.number}`, t.author ? t.author.login : 'someone', count, relativeTime(t.updatedAt, nowMs)].filter(Boolean).join(' · ');
}

/**
 * The nodes the references in some texts stand for, against the map now on screen. `refs` are as the server gives them (or
 * as `linksOf` finds them); what is on no node stays text.
 * @param {string[]} refs
 * @param {{ id: string, file?: string }[]} nodes
 * @returns {{ ids: string[], nodes: object[], unresolved: string[], resolved: { ref: string, ids: string[] }[] }}
 */
export function mentionsOf(refs, nodes) {
  const got = resolveMentions(refs, nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return { ...got, nodes: got.ids.map((id) => byId.get(id)).filter(Boolean) };
}

/**
 * What an open thread lights: the nodes its messages mention, as a pull request's files light theirs (amber, the rest
 * faded). `messages` carry `body`; each message also says which nodes are its own (for the chips under it).
 * @param {{ messages: { id: string, body: string }[] }} thread
 * @param {{ id: string, file?: string }[]} nodes
 * @returns {{ nodes: object[], unresolved: string[], changed: Set<string>, failing: Set<string>, perMessage: Map<string, { nodes: object[], unresolved: string[] }> }}
 */
export function litForThread(thread, nodes) {
  // A thread that is not there (not loaded, or an answer without one) lights nothing, and never throws
  const messages = thread && Array.isArray(thread.messages) ? thread.messages.filter((m) => m && typeof m.body === 'string') : [];
  const all = linksOf(messages.map((m) => m.body));
  const got = mentionsOf(all.refs, nodes);
  const perMessage = new Map();
  for (const m of messages) perMessage.set(m.id, messageNodes(m.body, nodes));
  return { nodes: got.nodes, unresolved: got.unresolved, changed: new Set(got.ids), failing: new Set(), perMessage };
}

/** The nodes one message mentions (its `[[…]]` and its `cornfield-thread` block), and the references that are on none */
export function messageNodes(body, nodes) {
  const got = parseMentions(body);
  const found = mentionsOf([...got.refs, ...(got.block ? got.block.nodes : [])], nodes);
  return { nodes: found.nodes, unresolved: found.unresolved };
}

/**
 * Which threads mention which nodes, from the list the server gave (each thread's references as written), against the map
 * on screen.
 * @param {{ number: number, refs: string[] }[]} items
 * @param {{ id: string, file?: string }[]} nodes
 * @returns {Map<string, object[]>} node id -> the threads, in the order of `items`
 */
export function mentionsIndex(items, nodes) {
  const index = new Map();
  for (const t of items) {
    for (const id of resolveMentions(t.refs || [], nodes).ids) index.set(id, [...(index.get(id) || []), t]);
  }
  return index;
}

/** A new idea's request body: the title and the text, trimmed, or null when there is no title */
export function ideaRequest(title, body) {
  const t = String(title ?? '').trim();
  return t ? { title: t, body: String(body ?? '').trim() } : null;
}

/** What a new idea came to, in words */
export function ideaWords(forgeName, res) {
  if (res.ok) return `Opened idea #${res.body.number} on ${forgeName}. It shows in the list within a minute.`;
  if (res.status === 401) return 'Your sign-in has ended. Sign in again to open an idea.';
  return errorWords(res.status, res.body);
}

// ---------------------------------------------------------------------------
//  The picture
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  Actions: land a green pull request, re-run a failed check (the server decides again, see server/forge-actions.js)
// ---------------------------------------------------------------------------

/** The states of a check that let a pull request land (the same rule as server/forge.js: finished, and not failed) */
const GREEN = ['success', 'neutral', 'skipped'];

/** The address an action is posted to (a spec is started on an issue; everything else is done to a pull request) */
export const actionUrl = (n, action) => (action === 'spec' ? `/api/forge/issues/${n}/spec` : `/api/forge/pulls/${n}/${action}`);

/**
 * Why a pull request cannot be landed from here now, in words; null when it can (the button is shown). The server
 * checks all of it again when asked.
 * @param {{ pull: { number: number, state: string, draft: boolean }, checks: { name: string, state: string }[], stale?: string }} detail
 * @returns {string | null}
 */
export function mergeBlock(detail) {
  const { pull, checks } = detail;
  if (pull.state === 'merged') return 'It has landed already.';
  if (pull.state !== 'open') return 'It is closed, so it cannot be landed.';
  if (pull.draft) return 'It is a draft. Next: mark it ready for review on the forge, then press Refresh here.';
  if (!checks.length) return 'It has no checks, so nothing says it works. Next: wait for the forge to start them, then press Refresh.';
  const words = { queued: 'is waiting to run', running: 'is still running', failure: 'failed', cancelled: 'was cancelled' };
  const not = checks.filter((c) => !GREEN.includes(c.state));
  if (not.length) {
    // What to do about each, in words: a failure is re-run (here when the forge lets cornfield, else there); a check that is not done is waited for
    const next = not.map((c) => (c.state === 'failure' || c.state === 'cancelled' ? `re-run ${c.name}${c.canRerun ? ' below' : ' on the forge'}` : `wait for ${c.name} to ${c.state === 'queued' ? 'start and finish' : 'finish'}`));
    return `Can't land yet: ${not.map((c) => `${c.name} ${words[c.state] || c.state}`).join(', ')}. Next: ${next.join(', then ')}, then press Refresh.`;
  }
  if (detail.stale) return 'This is an older answer from the forge: refresh before landing it.';
  return null;
}

/**
 * A line of warning for a spec pull request whose proposal is not approved yet ('' when it is, or the pull request is not a spec's). Only words:
 * what Land does is not changed by it.
 * @param {{ pull: { state: string }, specs?: { slug: string, approved: boolean }[] }} detail
 */
export function approvalWarning(detail) {
  if (!detail || detail.pull.state !== 'open') return '';
  const open = (detail.specs || []).filter((s) => !s.approved).map((s) => s.slug);
  return open.length ? `Its proposal${open.length > 1 ? 's' : ''} ${open.join(', ')} ${open.length > 1 ? 'are' : 'is'} not approved yet. Next: approve ${open.length > 1 ? 'them' : 'it'} first (Specs, open the proposal, Approve), then land this.` : '';
}

/**
 * Why a failed check has no Re-run button; null when it has one or is not a failed check (nothing to say).
 * @param {{ state: string, canRerun?: boolean }} check
 * @param {string} forgeName
 */
export function rerunWhy(check, forgeName) {
  if (!['failure', 'cancelled'].includes(check.state) || check.canRerun) return null;
  return `${forgeName} does not let cornfield re-run this one: re-run it there.`;
}

/** How a merge method lands a pull request, in words */
const HOW = { merge: 'A merge commit', squash: 'Squashed into one commit', rebase: 'Its commits rebased onto the base' };

/**
 * What the confirm step shows of what will land: the pull request, the commit, where it goes, how (the config's
 * `forge.mergeMethod`) and each check.
 * @returns {{ title: string, lines: [string, string][], checks: { name: string, words: string }[], note: string }}
 */
export function confirmMerge(detail, forgeName, method = 'merge') {
  const { pull, checks } = detail;
  return {
    title: `Land pull request #${pull.number}?`,
    lines: [
      ['Pull request', `#${pull.number} ${pull.title}`],
      ['Commit', pull.head.sha],
      ['From', pull.head.ref],
      ['Into', pull.base.ref],
      ['How', `${HOW[method] || HOW.merge}, made by ${forgeName}`],
      ['Checks', checksWords(checks)],
    ],
    checks: checks.map((c) => ({ name: c.name, words: checkWords(c) })),
    note: `Only this commit lands, and only while its checks are green on ${forgeName}. Nothing is deployed.`,
  };
}

/** What is posted to land a pull request: the head that was shown, so a push since is refused */
export const mergeBody = (detail) => ({ sha: detail.pull.head.sha });

/**
 * An action's answer in words for the panel and the live region.
 * @param {'merge' | 'rerun'} action
 * @param {number | null} status the HTTP status, null when the server did not answer
 * @param {{ ok?: boolean, error?: string, sha?: string, name?: string } | null} body
 */
export function actionWords(action, status, body, number) {
  if (status !== null && body && body.ok) {
    if (action === 'spec') return body.created ? `Spec started for issue #${number}: draft pull request #${body.pull && body.pull.number}.` : `Issue #${number} has its spec already: pull request #${body.pull && body.pull.number}. Nothing new was made.`;
    if (action === 'build') return body.created ? `Build issue #${body.issue && body.issue.number} opened for ${body.slug}.` : `${body.slug} has its build issue already: #${body.issue && body.issue.number}. Nothing new was made.`;
    return action === 'merge'
      ? `Pull request #${number} landed${body.sha ? ` as ${String(body.sha).slice(0, 7)}` : ''}.`
      : `${body.name || 'The check'} is running again.`;
  }
  const what = {
    merge: `Pull request #${number} was not landed`,
    spec: `No spec was started for issue #${number}`,
    build: `No build issue was opened for pull request #${number}`,
  }[action] || 'The check was not re-run';
  if (status === null) return `${what}: cornfield could not be reached. Look at the forge before trying again.`;
  if (status === 401) return `${what}: your sign-in has ended. Sign in again.`;
  return `${what}: ${body && typeof body.error === 'string' && body.error ? body.error : `cornfield answered ${status}.`}`;
}

// ---------------------------------------------------------------------------
//  Failures
// ---------------------------------------------------------------------------

/**
 * A failed request in words for the panel.
 * @param {number | null} status the HTTP status, null when the server did not answer
 * @param {{ error?: string } | null} body the JSON the server gave, if it did
 * @returns {string}
 */
export function errorWords(status, body, { offline = false, what = '' } = {}) {
  const head = what ? `Could not load ${what}. ` : '';
  if (status === null) return `${head}${offline ? 'You are offline.' : 'cornfield could not be reached. Check that it is still running, then try again.'}`;
  if (status === 401) return 'Your sign-in has ended. Sign in again to see issues and pull requests.';
  // The server's own sentence says what went wrong in plain words (the forge's name, what it could not find); nothing a parser or a runtime said is passed on
  if (body && typeof body.error === 'string' && body.error) return `${head}${body.error}`;
  if (status >= 200 && status < 300) return `${head}cornfield sent an answer this page could not read. Try again.`;
  if (status === 404) return `${head}It was not found. It may have been removed. Try again.`;
  if (status === 403) return `${head}This sign-in may not see it. Ask a maintainer, or sign in as another account.`;
  if (status === 429) return `${head}The forge asked cornfield to slow down. Try again in a minute.`;
  if (status >= 500) return `${head}The server had a problem (error ${status}). Try again in a minute.`;
  return `${head}The server refused (error ${status}). Try again.`;
}

/** What a list says when it has nothing in it: what would appear here and how to make one (the `kind` is the tab) */
export function emptyWords(kind, forgeName = 'the forge') {
  return {
    specs: 'No proposals yet. A proposal is a change to the map written down before it is built. Start one from an issue (Issues, then Start a spec), or push one as a file to the proposals folder.',
    pulls: `No open pull requests. Agents open one when a run makes code, and you can open one on ${forgeName}.`,
    issues: `No open issues. Open one on ${forgeName}, or write a New idea in Threads.`,
    threads: 'No threads. A thread is an idea or a spec conversation; start one with New idea below.',
    deploys: `No deploys to show. They appear here when a workflow runs on ${forgeName}.`,
    work: 'No work here yet. Start an agent from an issue or a proposal and its pull request shows here.',
  }[kind] || 'Nothing here yet.';
}

// ---------------------------------------------------------------------------
//  The pipeline's steps (PIPE-05): start a spec on an issue, open the build issue of an approved spec
//  The server plans each one (server/pipeline.js) and decides again when it is confirmed; this is only what is shown
// ---------------------------------------------------------------------------

/** Where a step's plan is read: what it would make, from the forge now */
export const planUrl = (action, n, slug) => (action === 'spec' ? `/api/forge/issues/${n}/spec` : `/api/forge/pulls/${n}/build?slug=${encodeURIComponent(slug)}`);

/** Why a spec cannot be started on an issue from here; null when it can (the button is shown). The server checks again. */
export function specBlock(issue) {
  if (issue.state !== 'open') return 'It is closed, so no spec is started for it.';
  return null;
}

/**
 * The proposals of the selected pull request a build issue can be opened for, and the ones that wait for an approval.
 * @param {{ pull: { state: string }, specs?: { slug: string, path: string, approved: boolean, changed?: boolean }[], stale?: string }} detail
 * @returns {{ slug: string, path: string, approved: boolean, offer: boolean, why: string }[]}
 */
export function buildOffers(detail) {
  if (!detail || detail.pull.state !== 'open') return [];
  return (detail.specs || []).map((s) => ({
    ...s,
    offer: s.approved && !detail.stale,
    why: s.changed ? 'Changed since it was approved: a maintainer approves it again as it is now.'
      : !s.approved ? 'No approval yet: a maintainer approves it in the proposal\'s review first.' : detail.stale ? 'This is an older answer from the forge: refresh first.' : '',
  }));
}

const yes = (v) => (v ? 'Yes' : 'No');

/**
 * What the confirm step shows of a spec that would be started: every thing that is made, with the file and the
 * description in full.
 * @returns {{ title: string, go: string, lines: [string, string][], previews: { label: string, text: string }[], note: string }}
 */
export function confirmSpec(plan, forgeName) {
  return {
    title: `Start a spec for issue #${plan.issue.number}?`,
    go: 'Start the spec',
    lines: [
      ['Issue', `#${plan.issue.number} ${plan.issue.title}`],
      ['Branch', plan.branch],
      ['Starts from', plan.base],
      ['File', plan.path],
      ['Pull request', plan.title],
      ['Draft', yes(true)],
    ],
    previews: [{ label: `${plan.path} (the stub proposal)`, text: plan.content }, { label: 'The pull request\'s description', text: plan.body }],
    note: `Makes this branch, adds this one file in one commit, and opens the draft pull request on ${forgeName}, as you. Nothing else changes and no agent is started.`,
  };
}

/**
 * What the confirm step shows of a build issue that would be opened.
 * @returns {{ title: string, go: string, lines: [string, string][], previews: { label: string, text: string }[], note: string }}
 */
export function confirmBuild(plan, forgeName) {
  return {
    title: `Open the build issue for ${plan.slug}?`,
    go: 'Open the issue',
    lines: [
      ['Spec pull request', `#${plan.pull.number} ${plan.pull.title}`],
      ['Proposal', plan.path],
      ['At commit', plan.sha],
      ['Approved by', plan.review.by],
      ['Issue', plan.title],
      ['Checklist', `${plan.items} ${plan.items === 1 ? 'item' : 'items'}`],
    ],
    previews: [{ label: 'The issue\'s description', text: plan.body }],
    note: `Opens this issue on ${forgeName}, as you, linking the pull request and the proposal. It builds nothing and no agent is started.`,
  };
}

/** What is posted to start a spec: the digest of the plan that was shown (the server plans again and must find the same) */
export const specBody = (plan) => ({ digest: plan.digest });
/** What is posted to open a build issue: the proposal, the commit it was read at, and the digest of the plan shown */
export const buildBody = (plan) => ({ slug: plan.slug, sha: plan.sha, digest: plan.digest });

/** What is said when the plan finds what an earlier ask made: nothing is asked of the person, nothing is made */
export function existingWords(action, plan) {
  if (action === 'spec') return `Issue #${plan.issue.number} has its spec already: pull request #${plan.existing.number}${plan.existing.draft ? ' (a draft)' : ''}. Nothing new is made.`;
  return `${plan.slug} has its build issue already: #${plan.existing.number}${plan.existing.state === 'closed' ? ' (closed)' : ''}. Nothing new is made.`;
}

// ---------------------------------------------------------------------------
//  Release notes
// ---------------------------------------------------------------------------

/** Where a draft release is posted (server/forge-routes.js); the one POST of the panel */
export const DRAFTS_URL = '/api/forge/release-drafts';

/** The address of the notes since a tag ('' for the latest version tag) */
export const notesUrl = (since) => `/api/forge/release-notes${since ? `?since=${encodeURIComponent(since)}` : ''}`;

/**
 * The tags the notes can start from: the latest version tag first (what the server picks when told none), then each
 * version tag, newest first.
 * @param {{ tags: string[] }} notes `tags` are the version tags, newest first
 * @returns {[string, string][]} [value, label]
 */
export function sinceChoices(notes) {
  const tags = Array.isArray(notes.tags) ? notes.tags : [];
  const first = ['', tags.length ? `Latest tag (${tags[0]})` : 'No version tag yet: every merged pull request'];
  return [first, ...tags.map((t) => [t, t])];
}

const plural = (n, word, more = `${word}s`) => `${n} ${n === 1 ? word : more}`;

/**
 * One line about a draft: how many pull requests, since which tag and when, in how many groups.
 * @param {{ count: number, since: { name: string, date: string } | null, groups: unknown[], truncated?: boolean }} notes
 */
export function notesSummary(notes) {
  const since = notes.since ? ` since ${notes.since.name} (${String(notes.since.date).slice(0, 10)})` : ' (no version tag yet)';
  if (!notes.count) return `No pull requests merged${since}.`;
  const groups = notes.groups.length === 1 ? 'one group' : `${notes.groups.length} groups`;
  return `${plural(notes.count, 'pull request')} merged${since}, in ${groups}.${notes.truncated ? ' Only the newest are in the draft.' : ''}`;
}

/** Whether a tag name is one the server will take for a draft (the same rule as server/forge.js `isTagName`) */
export const validTag = (tag) => typeof tag === 'string' && /^[\w][\w./+-]{0,99}$/.test(tag) && !tag.includes('..') && !tag.endsWith('/') && !tag.endsWith('.');

/** What the confirm step says before anything is sent */
export function confirmWords({ forge, repo, tag, count }) {
  return `This creates a draft release${tag ? ` for ${tag}` : ''} on ${forge} for ${repo}, with the notes of ${plural(count, 'pull request')}. It stays a draft: nothing is published and no tag is made. Publishing it is done on ${forge}.`;
}

/** What is said once the forge has the draft */
export const postedWords = ({ forge, tag, count }) => `Draft release ${tag} created on ${forge}, with ${plural(count, 'pull request')}. It is not published.`;

/** The body of the POST: the tag the draft is for, and the tag the notes start from (null for the latest) */
export const draftRequest = (tag, since) => ({ tag: tag.trim(), ...(since ? { since } : {}) });

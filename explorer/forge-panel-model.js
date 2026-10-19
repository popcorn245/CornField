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
 *   paintForge                lights those in a built scene (scene.js calls it): the rest fades back
 *   errorWords                a failed request, in words
 *   mergeBlock, rerunWhy      the actions (CF-08): why a pull request cannot be landed now, why a failed check cannot be re-run
 *   confirmMerge, mergeBody   what the confirm step shows of what will land, and what is sent when it is confirmed
 *   actionUrl, actionWords    where an action is posted, and how the answer is said
 */

import { relativeTime } from './review-model.js';

export const KINDS = Object.freeze(['pulls', 'issues']);
/** The states a list offers: [value, label]; a pull request that landed is "merged", one closed without landing "closed" */
export const STATES = Object.freeze({
  pulls: [['open', 'Open'], ['merged', 'Merged'], ['closed', 'Closed'], ['all', 'All']],
  issues: [['open', 'Open'], ['closed', 'Closed'], ['all', 'All']],
});
/** How many a list asks for (the server's own default; its most is 300) */
export const LIST_LIMIT = 100;
/** How bright what the selected pull request does not touch is, once some nodes are lit */
export const FORGE_DIM_ALPHA = 0.2;
/** A node a failing check's test is: red (the light theme deepens it like any node colour) */
export const FORGE_FAIL_COLOR = '#f87171';

export const defaultFilters = () => ({ state: 'open', label: '', author: '', text: '' });

/** What the server is asked for: a merged pull request is a closed one, filtered after */
export const serverState = (state) => (state === 'merged' ? 'closed' : state);

/** The address of a list */
export const listUrl = (kind, state) => `/api/forge/${kind}?state=${serverState(state)}&limit=${LIST_LIMIT}`;
/** The address of one pull request with its files and checks */
export const pullUrl = (n) => `/api/forge/pulls/${n}`;

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

/** The items that pass the filters, in the order the forge gave them (newest first) */
export const filterItems = (items, kind, filters) => items.filter((item) => matches(item, kind, filters));

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

/**
 * The node(s) whose `file` holds a path: the node's `file` is the path itself or a folder above it, and the deepest
 * (longest) `file` wins. A file that holds several nodes (a page and what renders it) lights all of them.
 * @param {string} path a repo-relative path
 * @param {{ id: string, file?: string }[]} nodes
 * @returns {object[]} the nodes, [] when none holds it
 */
export function nodesForFile(path, nodes) {
  const p = clean(path);
  let best = -1;
  let out = [];
  for (const node of nodes) {
    if (typeof node.file !== 'string' || node.file === '') continue;
    const file = clean(node.file);
    if (p !== file && !p.startsWith(`${file}/`)) continue;
    if (file.length > best) { best = file.length; out = [node]; } else if (file.length === best) out.push(node);
  }
  return out;
}

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
//  The picture
// ---------------------------------------------------------------------------

/**
 * Lights a pull request's nodes in a built scene: the nodes its files are get the amber glow of a search match, the
 * tests of a failing check turn red as well, and everything else fades back (nodes and the lines between them), so
 * the lit ones stand out whatever the selection or a proposal did before. Changes alpha, glow, halo, colour and label
 * only. Nothing lit (a pull request whose files are on no node) leaves the scene as it is.
 * @param {import('./scene.js').Scene} scene
 * @param {{ changed: Set<string>, failing: Set<string> } | null} lit
 */
export function paintForge(scene, lit) {
  if (!lit || (!lit.changed.size && !lit.failing.size)) return;
  const on = (id) => lit.changed.has(id) || lit.failing.has(id);
  for (const n of scene.nodes) {
    if (on(n.id)) {
      n.alpha = 1;
      n.labelAlpha = 1;
      n.glow = Math.max(n.glow, 14);
      n.labelKeep = true;
      if (n.halo !== 'selected') n.halo = 'match';
      if (lit.failing.has(n.id)) n.color = FORGE_FAIL_COLOR;
    } else {
      n.alpha = Math.min(n.alpha, FORGE_DIM_ALPHA);
      n.labelAlpha = n.alpha;
      n.glow = 0;
    }
  }
  for (const e of scene.edges) if (!on(e.from) && !on(e.to)) e.alpha = Math.min(e.alpha, FORGE_DIM_ALPHA / 2);
}

// ---------------------------------------------------------------------------
//  Actions: land a green pull request, re-run a failed check (the server decides again, see server/forge-actions.js)
// ---------------------------------------------------------------------------

/** The states of a check that let a pull request land (the same rule as server/forge.js: finished, and not failed) */
const GREEN = ['success', 'neutral', 'skipped'];

/** The address an action is posted to */
export const actionUrl = (n, action) => `/api/forge/pulls/${n}/${action}`;

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
  if (pull.draft) return 'It is a draft: mark it ready on the forge first.';
  if (!checks.length) return 'It has no checks, so nothing says it works.';
  const words = { queued: 'is waiting to run', running: 'is still running', failure: 'failed', cancelled: 'was cancelled' };
  const not = checks.filter((c) => !GREEN.includes(c.state));
  if (not.length) return `Not every check is green: ${not.map((c) => `${c.name} ${words[c.state] || c.state}`).join('; ')}.`;
  if (detail.stale) return 'This is an older answer from the forge: refresh before landing it.';
  return null;
}

/**
 * Why a failed check has no Re-run button; null when it has one or is not a failed check (nothing to say).
 * @param {{ state: string, canRerun?: boolean }} check
 * @param {string} forgeName
 */
export function rerunWhy(check, forgeName) {
  if (check.state !== 'failure' || check.canRerun) return null;
  return `${forgeName} does not let cornfield re-run this one: re-run it there.`;
}

/**
 * What the confirm step shows of what will land: the pull request, the commit, where it goes and each check.
 * @returns {{ title: string, lines: [string, string][], checks: { name: string, words: string }[], note: string }}
 */
export function confirmMerge(detail, forgeName) {
  const { pull, checks } = detail;
  return {
    title: `Land pull request #${pull.number}?`,
    lines: [
      ['Pull request', `#${pull.number} ${pull.title}`],
      ['Commit', pull.head.sha],
      ['From', pull.head.ref],
      ['Into', pull.base.ref],
      ['How', 'A merge commit, made by ' + forgeName],
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
    return action === 'merge'
      ? `Pull request #${number} landed${body.sha ? ` as ${String(body.sha).slice(0, 7)}` : ''}.`
      : `${body.name || 'The check'} is running again.`;
  }
  const what = action === 'merge' ? `Pull request #${number} was not landed` : 'The check was not re-run';
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
export function errorWords(status, body) {
  if (status === null) return 'cornfield could not be reached; check that it is still running, then refresh.';
  if (status === 401) return 'Your sign-in has ended. Sign in again to see issues and pull requests.';
  if (body && typeof body.error === 'string' && body.error) return body.error;
  return `cornfield answered ${status} for the forge.`;
}

/**
 * @module server/forge
 *
 * The forge adapter interface: the one shape the rest of the server talks to, whichever forge holds the repo
 * (spec 0001 section 3). `createForge(config.forge, { token })` gives a forge bound to the configured repo and the
 * signed-in user's own token. Every call answers plain data (the types below), never the forge's own JSON, and
 * throws a `ForgeError` (server/forge-http.js) in words a person can act on.
 *
 *   me()                              the signed-in user
 *   permission(repo, login)           their permission on a repo: admin | maintain | write | triage | read | none
 *   issues({ state, labels, limit })  issues, not pull requests, newest first
 *   pulls({ state, limit })           pull requests, newest first
 *   pull(n)                           one pull request (its head, its state)
 *   pullFiles(n)                      the files a pull request changes
 *   comments(n)                       the comments on an issue or pull request, oldest first
 *   comment(n, body)                  posts one, and answers it
 *   checks(ref)                       the checks on a commit (a branch, a tag or a sha)
 *   rerun(check)                      re-runs one that can be (`check.rerunnable`)
 *   merge(n, { onlyIfGreen: true })   lands an open, ready pull request whose checks are all green, at the head they ran on
 *   runs({ limit })                   the latest workflow (Actions) runs, newest first: what the deploys on the map are read from
 *   branches()                        the branches
 *   file(ref, path)                   a file's text at a ref, or null when it is not there
 *
 * An adapter module (server/forge-github.js, server/forge-forgejo.js) implements these at its forge's level, with
 * `mergeAt(n, { sha, method })` in place of `merge`; `wrap` checks the arguments and builds `merge` once for every
 * forge, so the green-only rule cannot differ between them. There is no force-merge and no call that deploys or
 * touches anything live (ADR 0006). Admins are the repo's maintainers: `isMaintainer(permission)` (ADR 0003).
 *
 * @typedef {'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'} Permission
 * @typedef {{ id: string, login: string, name: string | null, url: string | null, avatarUrl: string | null }} User
 * @typedef {{ login: string, url: string | null }} Author
 * @typedef {{ number: number, title: string, state: 'open' | 'closed', author: Author | null, labels: string[], comments: number, url: string, createdAt: string, updatedAt: string, closedAt: string | null }} Issue
 * @typedef {{ number: number, title: string, state: 'open' | 'closed' | 'merged', draft: boolean, author: Author | null, labels: string[], head: { ref: string, sha: string }, base: { ref: string }, url: string, createdAt: string, updatedAt: string, mergedAt: string | null }} Pull
 * @typedef {{ path: string, status: 'added' | 'modified' | 'removed' | 'renamed', previousPath: string | null, additions: number, deletions: number }} PullFile
 * @typedef {{ id: string, author: Author | null, body: string, url: string, createdAt: string, updatedAt: string }} Comment
 * @typedef {'queued' | 'running' | 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled'} CheckState
 * @typedef {{ id: string, name: string, state: CheckState, url: string | null, rerunnable: boolean }} Check
 * @typedef {{ name: string, sha: string, protected: boolean }} Branch
 * @typedef {{ id: string, workflow: string, name: string, title: string, event: string, branch: string, sha: string, state: CheckState, actor: Author | null, url: string | null, createdAt: string, updatedAt: string }} Run
 *   `workflow` is the workflow file's name ("deploy.yml"), `name` the workflow's own name ("Deploy web"; the file's
 *   name where the forge has none), `title` what the run was for (a commit message, a release)
 * @typedef {{ state?: 'open' | 'closed' | 'all', labels?: string[], limit?: number }} IssueQuery
 * @typedef {{ state?: 'open' | 'closed' | 'all', limit?: number }} PullQuery
 * @typedef {{ limit?: number }} RunQuery
 * @typedef {'merge' | 'squash' | 'rebase'} MergeMethod
 * @typedef {{
 *   forge: 'github' | 'forgejo', repo: string,
 *   me(): Promise<User>,
 *   permission(repo: string, login: string): Promise<Permission>,
 *   issues(query?: IssueQuery): Promise<Issue[]>,
 *   pulls(query?: PullQuery): Promise<Pull[]>,
 *   pull(n: number): Promise<Pull>,
 *   pullFiles(n: number): Promise<PullFile[]>,
 *   comments(n: number): Promise<Comment[]>,
 *   comment(n: number, body: string): Promise<Comment>,
 *   checks(ref: string): Promise<Check[]>,
 *   rerun(check: Check): Promise<void>,
 *   merge(n: number, opts: { onlyIfGreen: true, method?: MergeMethod }): Promise<{ sha: string }>,
 *   runs(query?: RunQuery): Promise<Run[]>,
 *   branches(): Promise<Branch[]>,
 *   file(ref: string, path: string): Promise<string | null>,
 *   rateLimit(): import('./forge-http.js').RateLimit | null,
 * }} Forge
 * @typedef {Omit<Forge, 'forge' | 'repo' | 'merge' | 'issues' | 'pulls' | 'runs'> & {
 *   issues(query: Required<IssueQuery>): Promise<Issue[]>,
 *   pulls(query: Required<PullQuery>): Promise<Pull[]>,
 *   runs(query: Required<RunQuery>): Promise<Run[]>,
 *   mergeAt(n: number, opts: { sha: string, method: MergeMethod }): Promise<{ sha: string }>,
 * }} Adapter
 */

import { createGitHubForge } from './forge-github.js';
import { createForgejoForge } from './forge-forgejo.js';
import { ForgeError } from './forge-http.js';

export { ForgeError, rateLimitWords } from './forge-http.js';

/** The calls of the interface (spec 0001 section 3, with `pull(n)`), and `rateLimit()`: what the last answer said is left */
export const FORGE_METHODS = Object.freeze(['me', 'permission', 'issues', 'pulls', 'pull', 'pullFiles', 'comments', 'comment', 'checks', 'rerun', 'merge', 'runs', 'branches', 'file', 'rateLimit']);
export const PERMISSIONS = Object.freeze(['admin', 'maintain', 'write', 'triage', 'read', 'none']);
/** A check that has finished and does not stand in the way: success, or one the forge says does not count */
export const GREEN_STATES = Object.freeze(['success', 'neutral', 'skipped']);
/** The most a listing returns unless asked for fewer */
export const DEFAULT_LIMIT = 1000;
/** The runs a listing returns unless asked for fewer: one forge page */
export const DEFAULT_RUN_LIMIT = 100;

const MERGE_METHODS = ['merge', 'squash', 'rebase'];
const STATES = ['open', 'closed', 'all'];
const REPO = /^[\w.-]+\/[\w.-]+$/;

/** The adapters, by `forge.type` */
const ADAPTERS = {
  github: createGitHubForge,
  forgejo: createForgejoForge,
};

/** Whether cornfield has an adapter for a forge type (server/forge-routes.js says a missing one in words) */
export const hasAdapter = (type) => Object.hasOwn(ADAPTERS, type);

/** Whether a permission makes its holder an admin of cornfield: they maintain the repo */
export const isMaintainer = (permission) => permission === 'admin' || permission === 'maintain';

/**
 * Whether a commit's checks let it land: at least one check, and every one finished green. A commit with no checks
 * is not green: nothing says it works.
 * @param {Check[]} checks
 */
export const isGreen = (checks) => checks.length > 0 && checks.every((c) => GREEN_STATES.includes(c.state));

/**
 * What keeps a commit from being green, in words: "lint failed; test is still running", or "it has no checks".
 * @param {Check[]} checks
 */
export function notGreenWords(checks) {
  if (!checks.length) return 'it has no checks';
  const words = { queued: 'is waiting to run', running: 'is still running', failure: 'failed', cancelled: 'was cancelled' };
  return checks.filter((c) => !GREEN_STATES.includes(c.state)).map((c) => `${c.name} ${words[c.state] || c.state}`).join('; ');
}

const invalid = (message) => new ForgeError(message, { code: 'invalid' });

/** An issue or pull request number, so a path never carries anything else */
function number(n) {
  if (!Number.isSafeInteger(n) || n < 1) throw invalid(`${JSON.stringify(n) ?? String(n)} is not an issue or pull request number.`);
  return n;
}

/** A non-empty string without a NUL: a ref, a path, a login, a comment */
function text(v, what) {
  if (typeof v !== 'string' || v.trim() === '' || v.includes('\0')) throw invalid(`${what} is missing.`);
  return v;
}

/** A listing's query with the defaults: open, at most `DEFAULT_LIMIT`, any label */
function query(q, withLabels) {
  if (q !== undefined && (q === null || typeof q !== 'object' || Array.isArray(q))) throw invalid('A query is an object.');
  const { state = 'open', limit = DEFAULT_LIMIT, labels = [] } = q || {};
  if (!STATES.includes(state)) throw invalid(`The state is one of ${STATES.join(', ')}.`);
  if (!Number.isSafeInteger(limit) || limit < 1) throw invalid('The limit is a whole number above 0.');
  if (!withLabels) return { state, limit };
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string' || l === '' || l.includes(','))) throw invalid('The labels are a list of names.');
  return { state, limit, labels };
}

/**
 * The forge the config names, for one signed-in user.
 * @param {{ type: string, url?: string, repo: string } | null | undefined} forge the config's `forge`
 * @param {{ token?: string | null, fetch?: typeof fetch, apiUrl?: string, timeoutMs?: number }} [opts] the user's own
 *   token; `apiUrl` and `fetch` replace the forge's own (tests, a proxy)
 * @returns {Forge}
 */
export function createForge(forge, opts = {}) {
  if (!forge || typeof forge !== 'object') throw new Error('No forge is configured: set `forge: { type, url, repo }` in cornfield.config.js.');
  const make = ADAPTERS[forge.type];
  if (!make) throw new Error(`cornfield has no adapter for the forge type ${JSON.stringify(forge.type)} yet (it has: ${Object.keys(ADAPTERS).join(', ')}).`);
  if (!REPO.test(String(forge.repo || ''))) throw new Error('forge.repo is "owner/name".');
  return wrap(make(forge, opts), forge);
}

/**
 * The interface over an adapter: arguments checked, defaults filled, `merge` built from `pull`, `checks` and `mergeAt`.
 * @param {Adapter} a
 * @param {{ type: string, repo: string }} forge
 * @returns {Forge}
 */
export function wrap(a, forge) {
  return Object.freeze({
    forge: /** @type {'github' | 'forgejo'} */ (forge.type),
    repo: forge.repo,
    me: async () => a.me(),
    permission: async (repo, login) => {
      if (!REPO.test(String(repo))) throw invalid('A repo is "owner/name".');
      return a.permission(repo, text(login, 'The user'));
    },
    issues: async (q) => a.issues(/** @type {Required<IssueQuery>} */ (query(q, true))),
    pulls: async (q) => a.pulls(/** @type {Required<PullQuery>} */ (query(q, false))),
    pull: async (n) => a.pull(number(n)),
    pullFiles: async (n) => a.pullFiles(number(n)),
    comments: async (n) => a.comments(number(n)),
    comment: async (n, body) => a.comment(number(n), text(body, 'The comment')),
    checks: async (ref) => a.checks(text(ref, 'The commit')),
    rerun: async (check) => {
      if (!check || typeof check.id !== 'string') throw invalid('Re-run which check?');
      if (!check.rerunnable) throw invalid(`${check.name || 'That check'} cannot be re-run from cornfield; re-run it on the forge.`);
      return a.rerun(check);
    },
    merge: async (n, opts) => {
      number(n);
      const { onlyIfGreen, method = 'merge' } = opts || {};
      if (onlyIfGreen !== true) throw invalid('cornfield only lands a pull request whose checks are green: pass { onlyIfGreen: true }.');
      if (!MERGE_METHODS.includes(method)) throw invalid(`The merge method is one of ${MERGE_METHODS.join(', ')}.`);
      const pr = await a.pull(n);
      if (pr.state !== 'open') throw new ForgeError(`Pull request #${n} is ${pr.state}; only an open one can land.`, { code: 'conflict' });
      if (pr.draft) throw new ForgeError(`Pull request #${n} is a draft; mark it ready first.`, { code: 'conflict' });
      const checks = await a.checks(pr.head.sha);
      if (!isGreen(checks)) throw new ForgeError(`Pull request #${n} is not green: ${notGreenWords(checks)}.`, { code: 'not-green' });
      // At the sha the checks ran on: a push in between makes the forge refuse rather than land untested code
      return a.mergeAt(n, { sha: pr.head.sha, method });
    },
    runs: async (q) => {
      if (q !== undefined && (q === null || typeof q !== 'object' || Array.isArray(q))) throw invalid('A query is an object.');
      const { limit = DEFAULT_RUN_LIMIT } = q || {};
      if (!Number.isSafeInteger(limit) || limit < 1) throw invalid('The limit is a whole number above 0.');
      return a.runs({ limit });
    },
    branches: async () => a.branches(),
    file: async (ref, path) => {
      text(ref, 'The commit');
      text(path, 'The file');
      if (path.startsWith('/') || path.split('/').some((p) => p === '..' || p === '.' || p === '')) throw invalid(`${JSON.stringify(path)} is not a path inside the repo.`);
      return a.file(ref, path);
    },
    rateLimit: () => a.rateLimit(),
  });
}

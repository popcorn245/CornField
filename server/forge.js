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
 *   issue(n)                          one issue (not a pull request: that is `not-found`)
 *   searchIssues(words)               the issues whose text holds the words (one page; the forge's search, which can lag a moment)
 *   pullFiles(n)                      the files a pull request changes
 *   comments(n)                       the comments on an issue or pull request, oldest first
 *   comment(n, body)                  posts one, and answers it
 *   checks(ref)                       the checks on a commit (a branch, a tag or a sha)
 *   rerun(check)                      re-runs one that can be (`check.rerunnable`)
 *   merge(n, { onlyIfGreen: true })   lands an open, ready pull request whose checks are all green, at the head they ran on
 *                                     (`sha`: the head the caller looked at; a pull request that has moved on since is refused)
 *   runs({ limit })                   the latest workflow (Actions) runs, newest first: what the deploys on the map are read from
 *   branches()                        the branches
 *   file(ref, path)                   a file's text at a ref, or null when it is not there
 *   fileBytes(ref, path, { maxBytes })  the same file's bytes (a picture), or null; a longer file (default 5 MB) is a 'too-large' error
 *   defaultBranch()                   the name of the repo's default branch (where releases are cut from)
 *   tags()                            the tags, as the forge lists them
 *   tag(name)                         one tag with the time of the commit it names
 *   createReleaseDraft({ tag, name, body })   a DRAFT release for a tag name: never published, and it makes no tag
 *
 * The pipeline's own steps (ADR 0006, spec 0001 section 3) add four calls that make something new, and nothing else:
 * none of them changes or removes what is there (a branch that exists, a file that exists, are refused), so each is as
 * safe to ask as a comment:
 *
 *   createBranch(name, { from })      a branch at the head of the branch `from` (`conflict` when it exists)
 *   createFile({ branch, path, content, message })   one new file on a branch, as one commit (`invalid` when it exists)
 *   createPull({ title, body, head, base, draft })   a pull request; a draft one is `draft: true` (Forgejo: the "WIP: " title it uses)
 *   createIssue({ title, body })      an issue
 *
 * An adapter module (server/forge-github.js, server/forge-forgejo.js) implements these at its forge's level, with
 * `mergeAt(n, { sha, method })` in place of `merge`; `wrap` checks the arguments and builds `merge` once for every
 * forge, so the green-only rule cannot differ between them. Green is every check finished green and at least one
 * passed; an adapter may add what its forge knows besides (`readiness(n, sha)`: required checks, a workflow that has not
 * reported yet, conflicts). There is no force-merge and no call that deploys or touches anything live (ADR 0006).
 * Admins are the repo's maintainers: `isMaintainer(permission)` (ADR 0003).
 *
 * @typedef {'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'} Permission
 * @typedef {{ id: string, login: string, name: string | null, url: string | null, avatarUrl: string | null }} User
 * @typedef {{ login: string, url: string | null, bot?: true }} Author
 * @typedef {{ number: number, title: string, state: 'open' | 'closed', author: Author | null, labels: string[], body: string, comments: number, url: string, createdAt: string, updatedAt: string, closedAt: string | null }} Issue
 * @typedef {{ number: number, title: string, body: string, state: 'open' | 'closed' | 'merged', draft: boolean, author: Author | null, labels: string[], head: { ref: string, sha: string }, base: { ref: string }, url: string, createdAt: string, updatedAt: string, mergedAt: string | null }} Pull
 * @typedef {{ path: string, status: 'added' | 'modified' | 'removed' | 'renamed', previousPath: string | null, additions: number, deletions: number }} PullFile
 * @typedef {{ id: string, author: Author | null, body: string, url: string, createdAt: string, updatedAt: string }} Comment
 * @typedef {'queued' | 'running' | 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled'} CheckState
 * @typedef {{ id: string, name: string, state: CheckState, url: string | null, rerunnable: boolean }} Check
 * @typedef {{ name: string, sha: string, protected: boolean }} Branch
 * @typedef {{ id: string, workflow: string, name: string, title: string, event: string, branch: string, sha: string, state: CheckState, actor: Author | null, url: string | null, createdAt: string, updatedAt: string }} Run
 *   `workflow` is the workflow file's name ("deploy.yml"), `name` the workflow's own name ("Deploy web"; the file's
 *   name where the forge has none), `title` what the run was for (a commit message, a release)
 * @typedef {{ name: string, sha: string }} Tag
 * @typedef {{ name: string, sha: string, date: string }} TagInfo
 * @typedef {{ tag: string, name: string, body: string }} ReleaseDraftInput
 * @typedef {{ id: string, url: string, draft: true }} ReleaseDraft
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
 *   issue(n: number): Promise<Issue>,
 *   searchIssues(words: string): Promise<Issue[]>,
 *   createBranch(name: string, opts: { from: string }): Promise<{ name: string, sha: string }>,
 *   createFile(file: { branch: string, path: string, content: string, message: string }): Promise<{ sha: string }>,
 *   createPull(pull: { title: string, body: string, head: string, base: string, draft: boolean }): Promise<Pull>,
 *   createIssue(issue: { title: string, body: string }): Promise<Issue>,
 *   pullFiles(n: number): Promise<PullFile[]>,
 *   comments(n: number): Promise<Comment[]>,
 *   comment(n: number, body: string): Promise<Comment>,
 *   checks(ref: string): Promise<Check[]>,
 *   rerun(check: Check): Promise<void>,
 *   merge(n: number, opts: { onlyIfGreen: true, method?: MergeMethod, sha?: string }): Promise<{ sha: string }>,
 *   runs(query?: RunQuery): Promise<Run[]>,
 *   branches(): Promise<Branch[]>,
 *   file(ref: string, path: string): Promise<string | null>,
 *   fileBytes(ref: string, path: string, opts?: { maxBytes?: number }): Promise<Buffer | null>,
 *   defaultBranch(): Promise<string>,
 *   tags(): Promise<Tag[]>,
 *   tag(name: string): Promise<TagInfo>,
 *   createReleaseDraft(input: ReleaseDraftInput): Promise<ReleaseDraft>,
 *   rateLimit(): import('./forge-http.js').RateLimit | null,
 * }} Forge
 * @typedef {Omit<Forge, 'forge' | 'repo' | 'merge' | 'issues' | 'pulls' | 'runs'> & {
 *   issues(query: Required<IssueQuery>): Promise<Issue[]>,
 *   pulls(query: Required<PullQuery>): Promise<Pull[]>,
 *   runs(query: Required<RunQuery>): Promise<Run[]>,
 *   mergeAt(n: number, opts: { sha: string, method: MergeMethod }): Promise<{ sha: string }>,
 *   readiness?(n: number, sha: string): Promise<{ ready: boolean, why?: string }>,
 * }} Adapter
 */

import { createGitHubForge } from './forge-github.js';
import { createForgejoForge } from './forge-forgejo.js';
import { ForgeError, FILE_MAX_BYTES } from './forge-http.js';

export { ForgeError, rateLimitWords } from './forge-http.js';

/** The calls of the interface (spec 0001 section 3, with `pull(n)`), and `rateLimit()`: what the last answer said is left */
export const FORGE_METHODS = Object.freeze(['me', 'permission', 'issues', 'searchIssues', 'pulls', 'pull', 'issue', 'pullFiles', 'comments', 'comment', 'checks', 'rerun', 'merge', 'runs', 'branches', 'file', 'fileBytes', 'defaultBranch', 'tags', 'tag', 'createReleaseDraft', 'createBranch', 'createFile', 'createPull', 'createIssue', 'rateLimit']);
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
/** A tag name a release draft may carry: no spaces, no `..`, no leading dash, at most 100 characters */
const TAG_NAME = /^[\w][\w./+-]{0,99}$/;
/** The most a release's body may hold (GitHub's own limit) */
export const RELEASE_BODY_LIMIT = 125_000;

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
 * Whether a commit's checks let it land: every one finished green, and at least one of them passed. A commit with no
 * checks, or whose checks were all skipped or neutral, is not green: nothing says it works.
 * @param {Check[]} checks
 */
export const isGreen = (checks) => checks.some((c) => c.state === 'success') && checks.every((c) => GREEN_STATES.includes(c.state));

/** The states a check is re-run from: it failed, or it was cancelled (a newer push or a concurrency group stopped it) */
export const RERUN_STATES = Object.freeze(['failure', 'cancelled']);

/**
 * Whether cornfield may re-run a check: one that failed or was cancelled, and that the forge can run again
 * (`check.rerunnable`). A check that is still running, or passed, is not re-run from here.
 * @param {Check} check
 */
export const canRerun = (check) => Boolean(check) && check.rerunnable === true && RERUN_STATES.includes(check.state);

/**
 * What keeps a commit from being green, in words: "lint failed; test is still running", or "it has no checks".
 * @param {Check[]} checks
 */
export function notGreenWords(checks) {
  if (!checks.length) return 'it has no checks';
  if (checks.every((c) => GREEN_STATES.includes(c.state))) return 'no check has passed (they were all skipped or neutral)';
  const words = { queued: 'is waiting to run', running: 'is still running', failure: 'failed', cancelled: 'was cancelled' };
  return checks.filter((c) => !GREEN_STATES.includes(c.state)).map((c) => `${c.name} ${words[c.state] || c.state}`).join('; ');
}

const invalid = (message) => new ForgeError(message, { code: 'invalid' });

/** An issue or pull request number, so a path never carries anything else */
function number(n) {
  if (!Number.isSafeInteger(n) || n < 1) throw invalid(`${JSON.stringify(n) ?? String(n)} is not an issue or pull request number.`);
  return n;
}

/** Whether a value is a tag name a path or a draft may carry */
export const isTagName = (v) => typeof v === 'string' && TAG_NAME.test(v) && !v.includes('..') && !v.endsWith('/') && !v.endsWith('.');

/** A tag name, so a path or a draft never carries anything else */
function tagName(v) {
  const t = text(v, 'The tag');
  if (!isTagName(t)) throw invalid(`${JSON.stringify(t)} is not a tag name cornfield will use.`);
  return t;
}

/** A non-empty string without a NUL: a ref, a path, a login, a comment */
function text(v, what) {
  if (typeof v !== 'string' || v.trim() === '' || v.includes('\0')) throw invalid(`${what} is missing.`);
  return v;
}

/** The most a title, a body, a commit message and a new file may hold: what a stub or a checklist is, with room */
export const MAX_TITLE = 256;
export const MAX_BODY = 60000;
export const MAX_FILE = 256 * 1024;

/** A text with a ceiling on its length */
function bounded(v, what, max) {
  text(v, what);
  if (v.length > max) throw invalid(`${what} is at most ${max} characters.`);
  return v;
}

/** A branch's name: plain segments of letters, digits, `.`, `_` and `-`, no `..`, no `.lock`, no empty part */
function branchName(v, what = 'The branch') {
  text(v, what);
  if (v.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(v) || v.includes('..') || v.endsWith('.') || /\.lock(?:\/|$)/.test(v)) {
    throw invalid(`${JSON.stringify(v)} is not a branch name cornfield will make.`);
  }
  return v;
}

/** A ref and a path inside the repo (no leading slash, no `.`, `..` or empty part) */
function inRepo(ref, path) {
  text(ref, 'The commit');
  text(path, 'The file');
  if (path.startsWith('/') || path.split('/').some((p) => p === '..' || p === '.' || p === '')) throw invalid(`${JSON.stringify(path)} is not a path inside the repo.`);
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
    issue: async (n) => a.issue(number(n)),
    searchIssues: async (words) => {
      if (typeof words !== 'string' || !/^[\w./ -]{3,200}$/.test(words) || !words.trim()) throw invalid('Search for plain words: letters, digits, spaces, ".", "/", "-", "_".');
      return a.searchIssues(words.trim());
    },
    pullFiles: async (n) => a.pullFiles(number(n)),
    comments: async (n) => a.comments(number(n)),
    comment: async (n, body) => a.comment(number(n), text(body, 'The comment')),
    checks: async (ref) => a.checks(text(ref, 'The commit')),
    rerun: async (check) => {
      if (!check || typeof check.id !== 'string') throw invalid('Re-run which check?');
      if (!canRerun(check)) {
        throw invalid(check.rerunnable && !RERUN_STATES.includes(check.state)
          ? `${check.name || 'That check'} has not failed; only a failed or cancelled check is re-run.`
          : `${check.name || 'That check'} cannot be re-run from cornfield; re-run it on the forge.`);
      }
      return a.rerun(check);
    },
    merge: async (n, opts) => {
      number(n);
      const { onlyIfGreen, method = 'merge', sha } = opts || {};
      if (onlyIfGreen !== true) throw invalid('cornfield only lands a pull request whose checks are green: pass { onlyIfGreen: true }.');
      if (!MERGE_METHODS.includes(method)) throw invalid(`The merge method is one of ${MERGE_METHODS.join(', ')}.`);
      if (sha !== undefined && (typeof sha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(sha))) throw invalid('The commit to land is a sha.');
      const pr = await a.pull(n);
      if (pr.state !== 'open') throw new ForgeError(`Pull request #${n} is ${pr.state}; only an open one can land.`, { code: 'conflict' });
      if (pr.draft) throw new ForgeError(`Pull request #${n} is a draft; mark it ready first.`, { code: 'conflict' });
      // The head the caller looked at, and confirmed, is the head that lands: a push since is for them to look at again
      if (sha !== undefined && sha.toLowerCase() !== pr.head.sha.toLowerCase()) {
        throw new ForgeError(`Pull request #${n} has changed since it was looked at (its head is now ${pr.head.sha.slice(0, 7)}); look again before landing it.`, { code: 'conflict' });
      }
      const checks = await a.checks(pr.head.sha);
      if (!isGreen(checks)) throw new ForgeError(`Pull request #${n} is not green: ${notGreenWords(checks)}.`, { code: 'not-green' });
      // What the forge itself says about landing it: its required checks, a workflow that has not reported yet, conflicts
      if (a.readiness) {
        const ready = await a.readiness(n, pr.head.sha);
        if (!ready.ready) throw new ForgeError(`Pull request #${n} is not ready to land: ${ready.why}.`, { code: 'not-green' });
      }
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
      inRepo(ref, path);
      return a.file(ref, path);
    },
    fileBytes: async (ref, path, { maxBytes = FILE_MAX_BYTES } = {}) => {
      inRepo(ref, path);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw invalid('The size limit is a whole number of bytes above 0.');
      return a.fileBytes(ref, path, { maxBytes });
    },
    createBranch: async (name, opts) => {
      if (!opts || typeof opts !== 'object') throw invalid('Make the branch from which branch?');
      return a.createBranch(branchName(name), { from: branchName(opts.from, 'The branch to start from') });
    },
    createFile: async (file) => {
      if (!file || typeof file !== 'object') throw invalid('Create which file?');
      branchName(file.branch);
      inRepo(file.branch, file.path);
      if (typeof file.content !== 'string' || file.content.includes('\0') || Buffer.byteLength(file.content) > MAX_FILE) throw invalid(`The file's text is at most ${MAX_FILE} bytes.`);
      return a.createFile({ branch: file.branch, path: file.path, content: file.content, message: bounded(file.message, 'The commit message', MAX_TITLE) });
    },
    createPull: async (pull) => {
      if (!pull || typeof pull !== 'object') throw invalid('Open which pull request?');
      if (typeof pull.draft !== 'boolean') throw invalid('Say whether the pull request is a draft.');
      return a.createPull({ title: bounded(pull.title, 'The title', MAX_TITLE), body: bounded(pull.body ?? ' ', 'The description', MAX_BODY), head: branchName(pull.head, 'The head branch'), base: branchName(pull.base, 'The base branch'), draft: pull.draft });
    },
    createIssue: async (issue) => {
      if (!issue || typeof issue !== 'object') throw invalid('Open which issue?');
      return a.createIssue({ title: bounded(issue.title, 'The title', MAX_TITLE), body: bounded(issue.body ?? ' ', 'The description', MAX_BODY) });
    },
    defaultBranch: async () => a.defaultBranch(),
    tags: async () => a.tags(),
    tag: async (name) => a.tag(tagName(name)),
    createReleaseDraft: async (input) => {
      if (!input || typeof input !== 'object') throw invalid('A release draft is { tag, name, body }.');
      const tag = tagName(input.tag);
      const name = text(input.name, 'The release name');
      if (name.length > 200) throw invalid('The release name is at most 200 characters.');
      if (typeof input.body !== 'string' || input.body.includes('\0') || input.body.length > RELEASE_BODY_LIMIT) throw invalid(`The release notes are text of at most ${RELEASE_BODY_LIMIT} characters.`);
      const draft = await a.createReleaseDraft({ tag, name, body: input.body });
      // Whatever the adapter was told, a release that came back published is a fault: nothing here ever publishes
      if (!draft || draft.draft !== true) throw new ForgeError(`The forge did not keep ${tag} as a draft; check ${forge.repo}'s releases on the forge.`, { code: 'unavailable', forge: forge.type });
      return draft;
    },
    rateLimit: () => a.rateLimit(),
  });
}

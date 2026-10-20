/**
 * @module server/forge-github
 *
 * The GitHub adapter (REST v3) behind the forge interface (server/forge.js): github.com, or GitHub Enterprise Server
 * at `<url>/api/v3`. It turns GitHub's answers into the interface's plain data and reads GitHub's rate-limit headers.
 *
 *   - **Permission.** The signed-in user's own comes from the repo itself (`permissions`), which anyone who can see
 *     the repo may read; anyone else's from the collaborator endpoint (push access needed). Unknown or unseen: `none`.
 *   - **Issues.** GitHub lists pull requests among the issues; they are left out.
 *   - **Checks.** The check runs on the commit and its commit statuses (CI that reports the old way), as one list.
 *     Only a GitHub Actions job can be re-run with a user's token, so only a finished, not-green one is `rerunnable`.
 *   - **Runs.** `actions/runs`: GitHub Actions workflow runs, newest first. `name` is the workflow's, `workflow` its file.
 *   - **Merge.** `PUT …/pulls/<n>/merge` with the head sha, so a push after the checks makes GitHub refuse (409).
 *     Before it, `readiness`: GitHub's own `mergeable_state` is `clean` (its required checks and reviews are met, no
 *     conflicts), and no workflow run on the head is still queued or running: just after a push, a fast check can be
 *     green before a slow workflow has registered its own.
 *   - **Files.** `contents/<path>?ref=` as raw text; a folder or a missing file is null.
 *   - **Tags and releases.** `tags`, and `commits/<tag>` for the time a tag was made; a release is created with `draft: true`,
 *     which GitHub keeps as a draft, with no tag, until it is published on GitHub.
 */

import { createClient, ForgeError } from './forge-http.js';

const NAME = 'GitHub';
const GITHUB_API = 'https://api.github.com';
const PER_PAGE = 100;
/** The most tags read (newest releases are among them on any repo that tags in order) */
const MAX_TAGS = 300;

/** Where a forge's API is: api.github.com for github.com, `<origin>/api/v3` for GitHub Enterprise Server */
export function githubApiUrl(url = 'https://github.com') {
  const origin = new URL(url).origin;
  return /^https:\/\/(www\.)?github\.com$/i.test(origin) ? GITHUB_API : `${origin}/api/v3`;
}

/** GitHub's `x-ratelimit-*` and `retry-after` headers */
export function githubRateLimit(headers) {
  const num = (name) => {
    const v = headers.get(name);
    const n = v === null || v === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const reset = num('x-ratelimit-reset');
  return { limit: num('x-ratelimit-limit'), remaining: num('x-ratelimit-remaining'), resetAt: reset === null ? null : new Date(reset * 1000).toISOString(), retryAfter: num('retry-after') };
}

const enc = encodeURIComponent;
/** A path or a ref with its slashes kept and every segment escaped */
const segments = (p) => p.split('/').map(enc).join('/');
const repoPath = (repo) => segments(repo);

// `bot` is set only when the forge says the account is a bot (GitHub's user type `Bot`): the agent-made rule reads it
const author = (u) => (u && typeof u.login === 'string' ? { login: u.login, url: u.html_url ?? null, ...(u.type === 'Bot' ? { bot: true } : {}) } : null);
const labelNames = (labels) => (labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter((l) => typeof l === 'string');

/** @returns {import('./forge.js').Issue} */
const toIssue = (i) => ({
  number: i.number, title: i.title, state: i.state === 'closed' ? 'closed' : 'open', author: author(i.user), labels: labelNames(i.labels), body: typeof i.body === 'string' ? i.body : '',
  comments: i.comments ?? 0, url: i.html_url, createdAt: i.created_at, updatedAt: i.updated_at, closedAt: i.closed_at ?? null,
});

/** @returns {import('./forge.js').Pull} */
const toPull = (p) => ({
  number: p.number, title: p.title, body: p.body ?? '', state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open', draft: Boolean(p.draft),
  author: author(p.user), labels: labelNames(p.labels), head: { ref: p.head?.ref ?? '', sha: p.head?.sha ?? '' }, base: { ref: p.base?.ref ?? '' },
  url: p.html_url, createdAt: p.created_at, updatedAt: p.updated_at, mergedAt: p.merged_at ?? null,
});

const FILE_STATUS = { added: 'added', copied: 'added', removed: 'removed', renamed: 'renamed', modified: 'modified', changed: 'modified', unchanged: 'modified' };
/** @returns {import('./forge.js').PullFile} */
const toFile = (f) => ({ path: f.filename, status: FILE_STATUS[f.status] || 'modified', previousPath: f.previous_filename ?? null, additions: f.additions ?? 0, deletions: f.deletions ?? 0 });

/** @returns {import('./forge.js').Comment} */
const toComment = (c) => ({ id: String(c.id), author: author(c.user), body: c.body ?? '', url: c.html_url, createdAt: c.created_at, updatedAt: c.updated_at });

const RUN_CONCLUSION = { success: 'success', neutral: 'neutral', skipped: 'skipped', cancelled: 'cancelled', stale: 'cancelled', failure: 'failure', timed_out: 'failure', action_required: 'failure', startup_failure: 'failure' };
/** @returns {import('./forge.js').CheckState} */
function runState(r) {
  if (r.status === 'in_progress') return 'running';
  if (r.status !== 'completed') return 'queued'; // queued, waiting, requested, pending
  return RUN_CONCLUSION[r.conclusion] || 'failure';
}
/** @returns {import('./forge.js').Check} */
function toRun(r) {
  const state = runState(r);
  const actions = r.app?.slug === 'github-actions';
  return { id: `run:${r.id}`, name: r.name, state, url: r.html_url ?? r.details_url ?? null, rerunnable: actions && ['failure', 'cancelled'].includes(state) };
}
const STATUS_STATE = { success: 'success', failure: 'failure', error: 'failure', pending: 'running' };
/** @returns {import('./forge.js').Check} */
const toStatus = (s) => ({ id: `status:${s.context}`, name: s.context, state: STATUS_STATE[s.state] || 'queued', url: s.target_url ?? null, rerunnable: false });

/** The workflow file's name from a run's `path` (".github/workflows/deploy.yml", or "…/deploy.yml@refs/heads/main") */
export const workflowFile = (p) => String(p || '').replace(/@.*$/, '').split('/').pop() || '';

/** @returns {import('./forge.js').Run} */
const toRunItem = (r) => ({
  id: String(r.id), workflow: workflowFile(r.path), name: r.name || workflowFile(r.path), title: r.display_title ?? r.head_commit?.message?.split('\n')[0] ?? '',
  event: r.event ?? '', branch: r.head_branch ?? '', sha: r.head_sha ?? '', state: runState(r), actor: author(r.actor), url: r.html_url ?? null,
  createdAt: r.run_started_at ?? r.created_at, updatedAt: r.updated_at ?? r.created_at,
});

/** @returns {import('./forge.js').Permission} */
function fromPermissions(p) {
  if (!p) return 'none';
  if (p.admin) return 'admin';
  if (p.maintain) return 'maintain';
  if (p.push) return 'write';
  if (p.triage) return 'triage';
  if (p.pull) return 'read';
  return 'none';
}
/** Whether a contents answer is a folder's listing rather than a file's text */
function isListing(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) && v.every((e) => e && typeof e === 'object' && typeof e.type === 'string' && typeof e.path === 'string');
  } catch {
    return false;
  }
}

const ROLES = ['admin', 'maintain', 'write', 'triage', 'read'];
const LEGACY = { admin: 'admin', write: 'write', read: 'read' };

/**
 * The GitHub adapter for one repo and one user's token.
 * @param {{ url?: string, repo: string }} forge the config's `forge`
 * @param {{ token?: string | null, fetch?: typeof fetch, apiUrl?: string, timeoutMs?: number }} [opts]
 * @returns {import('./forge.js').Adapter}
 */
export function createGitHubForge(forge, { token = null, fetch, apiUrl, timeoutMs } = {}) {
  const client = createClient({
    forge: NAME,
    apiUrl: apiUrl || githubApiUrl(forge.url),
    token,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    readRateLimit: githubRateLimit,
    fetch,
    timeoutMs,
  });
  const repo = repoPath(forge.repo);
  const pullWhat = (n) => `pull request #${n} in ${forge.repo}`;
  /** @type {Promise<import('./forge.js').User> | null} */
  let meOnce = null;

  const me = () => {
    meOnce ??= client.request('GET', 'user', { what: 'the signed-in user' }).then(({ body: u }) => ({
      id: String(u.id), login: u.login, name: u.name ?? null, url: u.html_url ?? null, avatarUrl: u.avatar_url ?? null,
    }));
    meOnce.catch(() => { meOnce = null; });
    return meOnce;
  };

  return {
    me,

    async permission(other, login) {
      const r = repoPath(other);
      const self = token ? await me() : null;
      if (self && self.login.toLowerCase() === login.toLowerCase()) {
        const { status, body } = await client.request('GET', `repos/${r}`, { what: other, allow: [404] });
        return status === 404 ? 'none' : fromPermissions(body.permissions);
      }
      const { status, body } = await client.request('GET', `repos/${r}/collaborators/${enc(login)}/permission`, { what: `${login}'s permission on ${other}`, allow: [404] });
      if (status === 404) return 'none';
      if (ROLES.includes(body.role_name)) return body.role_name;
      return LEGACY[body.permission] || 'none';
    },

    async issues({ state, labels, limit }) {
      const q = new URLSearchParams({ state, sort: 'created', direction: 'desc', per_page: String(PER_PAGE) });
      if (labels.length) q.set('labels', labels.join(','));
      const all = await client.list(`repos/${repo}/issues?${q}`, { what: `the issues of ${forge.repo}`, limit, items: (b) => (Array.isArray(b) ? b.filter((i) => !i.pull_request) : b) });
      return all.map(toIssue);
    },

    async searchIssues(words) {
      // The search API: the issues of this repo whose text holds the words (one page, newest first; the index can lag a moment)
      const q = new URLSearchParams({ q: `"${words}" in:body repo:${forge.repo} is:issue`, sort: 'created', order: 'desc', per_page: String(PER_PAGE) });
      const { body } = await client.request('GET', `search/issues?${q}`, { what: `the issues of ${forge.repo} that say ${words}` });
      return (Array.isArray(body?.items) ? body.items : []).filter((i) => !i.pull_request).map(toIssue);
    },

    async pulls({ state, limit }) {
      const q = new URLSearchParams({ state, sort: 'created', direction: 'desc', per_page: String(PER_PAGE) });
      return (await client.list(`repos/${repo}/pulls?${q}`, { what: `the pull requests of ${forge.repo}`, limit })).map(toPull);
    },

    async pull(n) {
      return toPull((await client.request('GET', `repos/${repo}/pulls/${n}`, { what: pullWhat(n) })).body);
    },

    async issue(n) {
      const { body } = await client.request('GET', `repos/${repo}/issues/${n}`, { what: `issue #${n} in ${forge.repo}` });
      // GitHub answers a pull request at its issue's address too
      if (body.pull_request) throw new ForgeError(`#${n} in ${forge.repo} is a pull request, not an issue.`, { code: 'not-found', forge: NAME });
      return toIssue(body);
    },

    async createBranch(name, { from }) {
      const { body: base } = await client.request('GET', `repos/${repo}/branches/${segments(from)}`, { what: `the branch ${from} in ${forge.repo}` });
      const sha = base.commit?.sha;
      if (typeof sha !== 'string' || !sha) throw new ForgeError(`GitHub did not say where ${from} is.`, { code: 'unavailable', forge: NAME });
      try {
        await client.request('POST', `repos/${repo}/git/refs`, { body: { ref: `refs/heads/${name}`, sha }, what: `the branch ${name}` });
      } catch (err) {
        if (err instanceof ForgeError && err.status === 422) throw new ForgeError(`The branch ${name} is there already.`, { code: 'conflict', status: 422, forge: NAME });
        throw err;
      }
      return { name, sha };
    },

    async createFile({ branch, path, content, message }) {
      // No `sha` in the body: GitHub refuses (422) to replace a file it already has, so this only ever adds
      const { body } = await client.request('PUT', `repos/${repo}/contents/${segments(path)}`, { body: { message, content: Buffer.from(content, 'utf8').toString('base64'), branch }, what: `${path} on ${branch}` });
      return { sha: body?.commit?.sha ?? '' };
    },

    async createPull({ title, body, head, base, draft }) {
      return toPull((await client.request('POST', `repos/${repo}/pulls`, { body: { title, body, head, base, draft }, what: `a pull request in ${forge.repo}` })).body);
    },

    async createIssue({ title, body }) {
      return toIssue((await client.request('POST', `repos/${repo}/issues`, { body: { title, body }, what: `an issue in ${forge.repo}` })).body);
    },

    async pullFiles(n) {
      return (await client.list(`repos/${repo}/pulls/${n}/files?per_page=${PER_PAGE}`, { what: `the files of ${pullWhat(n)}` })).map(toFile);
    },

    async comments(n) {
      return (await client.list(`repos/${repo}/issues/${n}/comments?per_page=${PER_PAGE}`, { what: `the comments on #${n} in ${forge.repo}` })).map(toComment);
    },

    async comment(n, body) {
      return toComment((await client.request('POST', `repos/${repo}/issues/${n}/comments`, { body: { body }, what: `#${n} in ${forge.repo}` })).body);
    },

    async checks(ref) {
      const at = segments(ref);
      const what = `the checks on ${ref} in ${forge.repo}`;
      const runs = await client.list(`repos/${repo}/commits/${at}/check-runs?per_page=${PER_PAGE}`, { what, items: (b) => b?.check_runs });
      const statuses = await client.list(`repos/${repo}/commits/${at}/status?per_page=${PER_PAGE}`, { what, items: (b) => b?.statuses });
      return [...runs.map(toRun), ...statuses.map(toStatus)];
    },

    async rerun(check) {
      const id = /^run:(\d+)$/.exec(check.id)?.[1];
      if (!id) throw new ForgeError(`${check.name || check.id} cannot be re-run from cornfield; re-run it on GitHub.`, { code: 'invalid', forge: NAME });
      await client.request('POST', `repos/${repo}/actions/jobs/${id}/rerun`, { what: `the check ${check.name || id}` });
    },

    async runs({ limit }) {
      const all = await client.list(`repos/${repo}/actions/runs?per_page=${PER_PAGE}`, { what: `the workflow runs of ${forge.repo}`, limit, items: (b) => b?.workflow_runs });
      return all.map(toRunItem);
    },

    async readiness(n, sha) {
      const { body: p } = await client.request('GET', `repos/${repo}/pulls/${n}`, { what: pullWhat(n) });
      const state = p.mergeable_state;
      if (state === 'unknown' || state === undefined || state === null) return { ready: false, why: 'GitHub is still working out whether it can be merged; try again in a moment' };
      if (state === 'dirty') return { ready: false, why: 'it has conflicts with its base' };
      if (state === 'behind') return { ready: false, why: 'its branch is behind its base; update it first' };
      if (state === 'blocked') return { ready: false, why: 'GitHub\'s branch protection is not met yet (a required check or review)' };
      if (state === 'draft') return { ready: false, why: 'it is a draft' };
      if (state !== 'clean' && state !== 'has_hooks') return { ready: false, why: `GitHub says it is ${state}` };
      // A workflow that has not reported a check yet still counts: none may be queued or running on this head
      const { status, body } = await client.request('GET', `repos/${repo}/actions/runs?head_sha=${enc(sha)}&per_page=100`, { what: `the workflow runs of ${pullWhat(n)}`, allow: [404] });
      const runs = status === 404 ? [] : (body?.workflow_runs || []);
      const going = runs.filter((r) => r.head_sha === sha && r.status !== 'completed');
      if (going.length) return { ready: false, why: `${going.map((r) => r.name).join(', ')} ${going.length === 1 ? 'is' : 'are'} still running` };
      return { ready: true };
    },

    async mergeAt(n, { sha, method }) {
      const { body } = await client.request('PUT', `repos/${repo}/pulls/${n}/merge`, { body: { sha, merge_method: method }, what: pullWhat(n) });
      return { sha: body.sha };
    },

    async branches() {
      return (await client.list(`repos/${repo}/branches?per_page=${PER_PAGE}`, { what: `the branches of ${forge.repo}` }))
        .map((b) => ({ name: b.name, sha: b.commit?.sha ?? '', protected: Boolean(b.protected) }));
    },

    async file(ref, path) {
      const { status, body, headers } = await client.request('GET', `repos/${repo}/contents/${segments(path)}?ref=${enc(ref)}`, {
        what: `${path} at ${ref}`, raw: true, accept: 'application/vnd.github.raw+json', allow: [404],
      });
      if (status === 404) return null;
      const text = /** @type {string} */ (body);
      // A folder answers its listing as JSON, whatever was asked for: a list of entries with a type and a path
      if (/^application\/json/i.test(headers.get('content-type') || '') && isListing(text)) return null;
      return text;
    },

    async defaultBranch() {
      const { body } = await client.request('GET', `repos/${repo}`, { what: forge.repo });
      if (typeof body?.default_branch !== 'string' || body.default_branch === '') throw new ForgeError(`GitHub did not say which branch is ${forge.repo}'s default.`, { code: 'unavailable', forge: NAME });
      return body.default_branch;
    },

    async tags() {
      return (await client.list(`repos/${repo}/tags?per_page=${PER_PAGE}`, { what: `the tags of ${forge.repo}`, limit: MAX_TAGS }))
        .map((t) => ({ name: t.name, sha: t.commit?.sha ?? '' }));
    },

    async tag(name) {
      // The commit the tag names: its sha and when it was made
      const { body } = await client.request('GET', `repos/${repo}/commits/${segments(name)}`, { what: `the tag ${name} in ${forge.repo}` });
      const date = body.commit?.committer?.date ?? body.commit?.author?.date;
      if (typeof date !== 'string') throw new ForgeError(`GitHub did not say when ${name} was made.`, { code: 'unavailable', forge: NAME });
      return { name, sha: body.sha ?? '', date };
    },

    async createReleaseDraft({ tag, name, body }) {
      // draft: true always. A draft makes no tag until someone publishes it on GitHub
      const { body: made } = await client.request('POST', `repos/${repo}/releases`, { body: { tag_name: tag, name, body, draft: true, prerelease: false }, what: `a release draft in ${forge.repo}` });
      return { id: String(made.id), url: made.html_url, draft: made.draft === true };
    },

    async fileBytes(ref, path) {
      const { status, body, headers } = await client.request('GET', `repos/${repo}/contents/${segments(path)}?ref=${enc(ref)}`, {
        what: `${path} at ${ref}`, bytes: true, accept: 'application/vnd.github.raw+json', allow: [404],
      });
      if (status === 404 || !Buffer.isBuffer(body)) return null;
      if (/^application\/json/i.test(headers.get('content-type') || '') && isListing(body.toString('utf8'))) return null; // a folder
      return body;
    },

    rateLimit: () => client.rateLimit(),
  };
}

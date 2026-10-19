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
 *   - **Merge.** `PUT …/pulls/<n>/merge` with the head sha, so a push after the checks makes GitHub refuse (409).
 *   - **Files.** `contents/<path>?ref=` as raw text; a folder or a missing file is null.
 */

import { createClient, ForgeError } from './forge-http.js';

const NAME = 'GitHub';
const GITHUB_API = 'https://api.github.com';
const PER_PAGE = 100;

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

const author = (u) => (u && typeof u.login === 'string' ? { login: u.login, url: u.html_url ?? null } : null);
const labelNames = (labels) => (labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter((l) => typeof l === 'string');

/** @returns {import('./forge.js').Issue} */
const toIssue = (i) => ({
  number: i.number, title: i.title, state: i.state === 'closed' ? 'closed' : 'open', author: author(i.user), labels: labelNames(i.labels),
  comments: i.comments ?? 0, url: i.html_url, createdAt: i.created_at, updatedAt: i.updated_at, closedAt: i.closed_at ?? null,
});

/** @returns {import('./forge.js').Pull} */
const toPull = (p) => ({
  number: p.number, title: p.title, state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open', draft: Boolean(p.draft),
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

    async pulls({ state, limit }) {
      const q = new URLSearchParams({ state, sort: 'created', direction: 'desc', per_page: String(PER_PAGE) });
      return (await client.list(`repos/${repo}/pulls?${q}`, { what: `the pull requests of ${forge.repo}`, limit })).map(toPull);
    },

    async pull(n) {
      return toPull((await client.request('GET', `repos/${repo}/pulls/${n}`, { what: pullWhat(n) })).body);
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

    rateLimit: () => client.rateLimit(),
  };
}

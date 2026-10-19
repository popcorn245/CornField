/**
 * @module server/forge-forgejo
 *
 * The Forgejo adapter (its v1 API, which Gitea shares) behind the forge interface (server/forge.js): an instance at
 * `<url>/api/v1`, which `forge.url` has to name (there is no default host). It turns Forgejo's answers into the
 * interface's plain data.
 *
 *   - **Sign-in.** `Authorization: token <t>`, which takes a personal token and an OAuth access token alike.
 *   - **Permission.** Forgejo has three levels, so a repo's people are `admin`, `write` or `read` and never
 *     `maintain` or `triage`; its admins are cornfield's. The signed-in user's own comes from the repo itself
 *     (`permissions`); anyone else's from the collaborator endpoint, which only a repo admin may ask (else 403).
 *   - **Issues.** `type=issues` leaves the pull requests out.
 *   - **Checks.** Forgejo Actions reports each job as a commit status, so the commit's statuses are all the checks
 *     there are. Its API cannot re-run one: none is `rerunnable`.
 *   - **Runs.** `actions/runs` (Forgejo 11 and later, Gitea 1.24 and later), where Actions is on for the repo; an older
 *     instance, or a repo without Actions, answers 404, which is said in words (HTTP 501 from cornfield's routes).
 *     Forgejo gives a run no name of its own, so `name` is the workflow file's.
 *   - **Merge.** `POST …/pulls/<n>/merge` with `head_commit_id`, so a push after the checks makes Forgejo refuse
 *     (409). Before it, `readiness`: Forgejo says the pull request is `mergeable` (no conflicts). Its API does not say
 *     which checks branch protection requires, nor list a workflow that has not reported a status yet, so a commit
 *     whose slow job has not started can look green: branch protection's required checks are the backstop there. It answers nothing, so the merge commit is read back from the pull request.
 *   - **Files.** `raw/<path>?ref=`; a folder or a missing file is null.
 *   - **Limits.** Forgejo sends no rate-limit headers; only a `Retry-After` from the instance or a proxy in front of
 *     it is read. A listing is paged 50 at a time (the most it gives by default) and follows `Link`.
 */

import { createClient, ForgeError } from './forge-http.js';

const NAME = 'Forgejo';
const PER_PAGE = 50;
const NO_URL = 'forge.url is required for Forgejo: the instance\'s address, like "https://forgejo.example.org".';

/** Where a forge's API is: `<url>/api/v1`, under a path too when the instance is served from one */
export function forgejoApiUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error(NO_URL); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(NO_URL);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/api/v1`;
}

const enc = encodeURIComponent;
/** A path or a ref with its slashes kept and every segment escaped */
const segments = (p) => p.split('/').map(enc).join('/');
const repoPath = (repo) => segments(repo);

/** Forgejo's Actions system user: what a workflow does on the forge is done as it (id -2, a Bot in Gitea's model since before the fork) */
export const ACTIONS_USER_ID = -2;

// `bot` is set only when the forge says the account is a bot, as GitHub's adapter does: the user's `type` is "Bot" (Gitea's API
// renders the user type, capitalised as GitHub's; an instance that does not send it simply marks nothing), or the user
// is the Actions system user. The agent rule (explorer/agents-model.js) reads it.
const author = (u) => {
  const login = u && (u.login || u.username);
  if (typeof login !== 'string' || !login) return null;
  return { login, url: u.html_url || null, ...(u.type === 'Bot' || u.id === ACTIONS_USER_ID ? { bot: true } : {}) };
};
const labelNames = (labels) => (labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter((l) => typeof l === 'string');

/** @returns {import('./forge.js').Issue} */
const toIssue = (i) => ({
  number: i.number, title: i.title, state: i.state === 'closed' ? 'closed' : 'open', author: author(i.user), labels: labelNames(i.labels),
  comments: i.comments ?? 0, url: i.html_url, createdAt: i.created_at, updatedAt: i.updated_at, closedAt: i.closed_at ?? null,
});

/** Forgejo marks a draft by a title prefix (WIP: or [WIP] by default); newer versions also say so with `draft` */
const isDraft = (p) => p.draft === true || /^\s*(\[WIP\]|WIP:|Draft:)/i.test(p.title || '');

/** @returns {import('./forge.js').Pull} */
const toPull = (p) => ({
  number: p.number, title: p.title, body: p.body ?? '', state: p.merged || p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open', draft: isDraft(p),
  author: author(p.user), labels: labelNames(p.labels), head: { ref: p.head?.ref ?? '', sha: p.head?.sha ?? '' }, base: { ref: p.base?.ref ?? '' },
  url: p.html_url, createdAt: p.created_at, updatedAt: p.updated_at, mergedAt: p.merged_at ?? null,
});

const FILE_STATUS = { added: 'added', copied: 'added', deleted: 'removed', removed: 'removed', renamed: 'renamed', modified: 'modified', changed: 'modified', unchanged: 'modified' };
/** @returns {import('./forge.js').PullFile} */
const toFile = (f) => ({ path: f.filename, status: FILE_STATUS[f.status] || 'modified', previousPath: f.previous_filename || null, additions: f.additions ?? 0, deletions: f.deletions ?? 0 });

/** @returns {import('./forge.js').Comment} */
const toComment = (c) => ({ id: String(c.id), author: author(c.user), body: c.body ?? '', url: c.html_url, createdAt: c.created_at, updatedAt: c.updated_at });

// A warning does not count as passing, so it stands in the way like a failure
const STATUS_STATE = { success: 'success', skipped: 'skipped', failure: 'failure', error: 'failure', warning: 'failure', pending: 'running' };
/** @returns {import('./forge.js').Check} */
const toStatus = (s) => ({ id: `status:${s.context}`, name: s.context, state: STATUS_STATE[s.status ?? s.state] || 'queued', url: s.target_url || null, rerunnable: false });

/** The workflow file's name from a run's `path` ("deploy.yaml@refs/heads/main") */
export const workflowFile = (p) => String(p || '').replace(/@.*$/, '').split('/').pop() || '';

const RUN_STATE = { success: 'success', failure: 'failure', cancelled: 'cancelled', canceled: 'cancelled', skipped: 'skipped', neutral: 'neutral', running: 'running', in_progress: 'running' };
/** A run's state: a finished run says how in `conclusion`; one still going has only its `status` (waiting, blocked, running) */
const runState = (r) => RUN_STATE[r.conclusion] || (r.status === 'completed' ? 'failure' : RUN_STATE[r.status]) || 'queued';

/** @returns {import('./forge.js').Run} */
const toRunItem = (r) => ({
  id: String(r.id), workflow: workflowFile(r.path), name: workflowFile(r.path), title: r.display_title ?? '', event: r.event ?? '', branch: r.head_branch ?? '',
  sha: r.head_sha ?? '', state: runState(r), actor: author(r.actor || r.trigger_actor), url: r.html_url ?? null,
  createdAt: r.started_at ?? r.created_at ?? '', updatedAt: r.completed_at ?? r.updated_at ?? r.started_at ?? r.created_at ?? '',
});

/** @returns {import('./forge.js').Permission} */
function fromPermissions(p) {
  if (!p) return 'none';
  if (p.admin) return 'admin';
  if (p.push) return 'write';
  if (p.pull) return 'read';
  return 'none';
}
/** What the collaborator endpoint calls a level (`owner` is the repo's owner, an admin of it) */
const LEVELS = { owner: 'admin', admin: 'admin', write: 'write', read: 'read' };

/**
 * The Forgejo adapter for one repo and one user's token.
 * @param {{ url?: string, repo: string }} forge the config's `forge`
 * @param {{ token?: string | null, fetch?: typeof fetch, apiUrl?: string, timeoutMs?: number }} [opts]
 * @returns {import('./forge.js').Adapter}
 */
export function createForgejoForge(forge, { token = null, fetch, apiUrl, timeoutMs } = {}) {
  const client = createClient({
    forge: NAME,
    apiUrl: apiUrl || forgejoApiUrl(forge.url),
    token,
    authScheme: 'token',
    headers: { Accept: 'application/json' },
    fetch,
    timeoutMs,
  });
  const repo = repoPath(forge.repo);
  const pullWhat = (n) => `pull request #${n} in ${forge.repo}`;
  /** @type {Promise<import('./forge.js').User> | null} */
  let meOnce = null;

  const me = () => {
    meOnce ??= client.request('GET', 'user', { what: 'the signed-in user' }).then(({ body: u }) => ({
      id: String(u.id), login: u.login, name: u.full_name || null, url: u.html_url ?? null, avatarUrl: u.avatar_url ?? null,
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
      return LEVELS[body.permission] || 'none';
    },

    async issues({ state, labels, limit }) {
      const q = new URLSearchParams({ state, type: 'issues', limit: String(PER_PAGE) });
      if (labels.length) q.set('labels', labels.join(','));
      const all = await client.list(`repos/${repo}/issues?${q}`, { what: `the issues of ${forge.repo}`, limit, items: (b) => (Array.isArray(b) ? b.filter((i) => !i.pull_request) : b) });
      return all.map(toIssue);
    },

    async pulls({ state, limit }) {
      const q = new URLSearchParams({ state, limit: String(PER_PAGE) });
      return (await client.list(`repos/${repo}/pulls?${q}`, { what: `the pull requests of ${forge.repo}`, limit })).map(toPull);
    },

    async pull(n) {
      return toPull((await client.request('GET', `repos/${repo}/pulls/${n}`, { what: pullWhat(n) })).body);
    },

    async pullFiles(n) {
      return (await client.list(`repos/${repo}/pulls/${n}/files?limit=${PER_PAGE}`, { what: `the files of ${pullWhat(n)}` })).map(toFile);
    },

    async comments(n) {
      return (await client.list(`repos/${repo}/issues/${n}/comments?limit=${PER_PAGE}`, { what: `the comments on #${n} in ${forge.repo}` })).map(toComment);
    },

    async comment(n, body) {
      return toComment((await client.request('POST', `repos/${repo}/issues/${n}/comments`, { body: { body }, what: `#${n} in ${forge.repo}` })).body);
    },

    async checks(ref) {
      const statuses = await client.list(`repos/${repo}/commits/${segments(ref)}/status?limit=${PER_PAGE}`, { what: `the checks on ${ref} in ${forge.repo}`, items: (b) => b?.statuses });
      return statuses.map(toStatus);
    },

    async rerun(check) {
      throw new ForgeError(`${check.name || check.id} cannot be re-run from cornfield; re-run it on Forgejo.`, { code: 'invalid', forge: NAME });
    },

    async runs({ limit }) {
      let all;
      try {
        all = await client.list(`repos/${repo}/actions/runs?limit=${PER_PAGE}`, { what: `the workflow runs of ${forge.repo}`, limit, items: (b) => b?.workflow_runs });
      } catch (err) {
        if (err instanceof ForgeError && err.code === 'not-found') {
          throw new ForgeError(`Forgejo cannot list the Actions runs of ${forge.repo}: Actions is off for the repo, or the instance is older than Forgejo 11 (or Gitea 1.24), which cannot list runs. Deploys are not read from it.`, { code: 'unavailable', status: 501, forge: NAME, rateLimit: err.rateLimit });
        }
        throw err;
      }
      return all.map(toRunItem);
    },

    async readiness(n) {
      const { body: p } = await client.request('GET', `repos/${repo}/pulls/${n}`, { what: pullWhat(n) });
      if (p.mergeable === false) return { ready: false, why: 'Forgejo says it cannot be merged (conflicts with its base, or branch protection)' };
      return { ready: true };
    },

    async mergeAt(n, { sha, method }) {
      await client.request('POST', `repos/${repo}/pulls/${n}/merge`, { body: { Do: method, head_commit_id: sha }, what: pullWhat(n) });
      // Forgejo answers an empty 200, so the commit it made is read from the pull request (the head it landed, if it
      // says none). It has landed by now: a read that fails afterwards must not report the merge as failed.
      try {
        const { body } = await client.request('GET', `repos/${repo}/pulls/${n}`, { what: pullWhat(n) });
        return { sha: body?.merge_commit_sha || sha };
      } catch {
        return { sha };
      }
    },

    async branches() {
      return (await client.list(`repos/${repo}/branches?limit=${PER_PAGE}`, { what: `the branches of ${forge.repo}` }))
        .map((b) => ({ name: b.name, sha: b.commit?.id ?? b.commit?.sha ?? '', protected: Boolean(b.protected) }));
    },

    async file(ref, path) {
      const { status, body } = await client.request('GET', `repos/${repo}/raw/${segments(path)}?ref=${enc(ref)}`, { what: `${path} at ${ref}`, raw: true, allow: [404] });
      return status === 404 ? null : /** @type {string} */ (body);
    },

    async fileBytes(ref, path) {
      const { status, body } = await client.request('GET', `repos/${repo}/raw/${segments(path)}?ref=${enc(ref)}`, { what: `${path} at ${ref}`, bytes: true, allow: [404] });
      return status === 404 || !Buffer.isBuffer(body) ? null : body;
    },

    rateLimit: () => client.rateLimit(),
  };
}

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
 *   - **Merge.** `POST …/pulls/<n>/merge` with `head_commit_id`, so a push after the checks makes Forgejo refuse
 *     (409). It answers nothing, so the merge commit is read back from the pull request.
 *   - **Files.** `raw/<path>?ref=`; a folder or a missing file is null.
 *   - **Tags and releases.** `tags` and `tags/<name>` (the commit carries the time); a release is created with `draft: true`,
 *     which Forgejo keeps as a draft until it is published on the instance.
 *   - **Limits.** Forgejo sends no rate-limit headers; only a `Retry-After` from the instance or a proxy in front of
 *     it is read. A listing is paged 50 at a time (the most it gives by default) and follows `Link`.
 */

import { createClient, ForgeError } from './forge-http.js';

const NAME = 'Forgejo';
const PER_PAGE = 50;
/** The most tags read */
const MAX_TAGS = 300;
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

const author = (u) => {
  const login = u && (u.login || u.username);
  return typeof login === 'string' && login ? { login, url: u.html_url || null } : null;
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
  number: p.number, title: p.title, state: p.merged || p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open', draft: isDraft(p),
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

    async tags() {
      return (await client.list(`repos/${repo}/tags?limit=${PER_PAGE}`, { what: `the tags of ${forge.repo}`, limit: MAX_TAGS }))
        .map((t) => ({ name: t.name, sha: t.commit?.sha ?? t.id ?? '' }));
    },

    async tag(name) {
      const { body } = await client.request('GET', `repos/${repo}/tags/${segments(name)}`, { what: `the tag ${name} in ${forge.repo}` });
      const date = body.commit?.created ?? body.commit?.committer?.date;
      if (typeof date !== 'string') throw new ForgeError(`Forgejo did not say when ${name} was made.`, { code: 'unavailable', forge: NAME });
      return { name, sha: body.commit?.sha ?? body.id ?? '', date };
    },

    async createReleaseDraft({ tag, name, body }) {
      // draft: true always. A draft makes no tag until someone publishes it on Forgejo
      const { body: made } = await client.request('POST', `repos/${repo}/releases`, { body: { tag_name: tag, name, body, draft: true, prerelease: false }, what: `a release draft in ${forge.repo}` });
      return { id: String(made.id), url: made.html_url, draft: made.draft === true };
    },

    rateLimit: () => client.rateLimit(),
  };
}

/**
 * @module server/proposal-pulls
 *
 * The proposals of open spec PRs (spec 0001 section 3): the open pull requests that add or change a file in the
 * proposals folder, each file read at the PR's head commit. Everything goes through the forge interface
 * (server/forge.js) as the signed-in maintainer, so what is listed is what their token can see.
 *
 * A listed proposal's `source` is `pull/<n>`: a slash cannot be in a worktree's folder name, so it never meets
 * one. A request names a pull request by that number and a slug; both are checked against what the forge says
 * (`findPullProposal`), and the path read is built from the proposals folder and the slug, never from the request.
 * A file a PR deletes has nothing at its head and is not listed.
 *
 * **What a menu open costs.** What a commit holds never changes, so a PR's files and a file's text are kept by the
 * head sha they were read at (in memory, per server: keyed by its `where`, at most `CACHE_MAX` answers). Opening the
 * menu again asks the forge for the open PRs only (one call a page); a PR pushed to since is read again at its new
 * head. Every maintainer of the repo sees the same PRs, so what one maintainer's token read is shown to another.
 * Answers are kept only when the forge gave them; a failure is asked again next time.
 *
 * **What the review state costs** (spec 0010 D4). A listed proposal of a ready PR also carries its review state (`reviewStates`): the
 * latest maintainer review, whether it still holds (`current`), and when the head was pushed. It is read once for a PR at a head and kept
 * for `REVIEW_KEEP_MS` (5 minutes): one `comments` call for the PR, a `permission` call for each author of a review block (once per listing, whatever the number of PRs), and a
 * `pullCommits` call for the head (kept by sha for good: a commit never changes). A draft PR is not read at all. A review posted from cornfield
 * is forgotten at once (`forgetReviewState`); one posted on the forge shows within the 5 minutes. A read that fails is never kept, and says so
 * (`review: { error }`), so a PR whose review could not be read never looks unreviewed.
 *
 * @typedef {{ slug: string, source: string, path: string, sha: string, pull: { number: number, title: string, url: string, draft: boolean, author: string | null, createdAt: string, updatedAt: string } }} PullEntry
 * @typedef {{ verdict: 'approved' | 'notes', by: string, at: string, current: boolean }} ReviewState `current`: an approval is of the file as the head holds it now; a send-back has had no push since
 * @typedef {{ pushedAt: string | null, review: ReviewState | { error: string } | null }} PullReviewState
 */

import path from 'node:path';
import { ForgeError } from './forge.js';
import { PROPOSAL_FILE } from './files.js';
import { latestReview, proposalHash } from './reviews.js';

/** How many pull requests have their files asked at once */
const PARALLEL = 6;
/** The most answers kept per server (a PR's files, or a file's text, at one head sha); the oldest goes first */
export const CACHE_MAX = 500;

/** @type {WeakMap<object, Map<string, unknown>>} */
const caches = new WeakMap();

/**
 * What was read at `key` (a head sha is in every key), or `read()`'s answer, kept for next time. The promise is what is kept, so
 * listings asked side by side (the Specs list and the work graph as a page opens) ask the forge once; a read that fails is forgotten.
 */
async function atSha(where, key, read) {
  let cache = caches.get(where);
  if (!cache) caches.set(where, (cache = new Map()));
  if (cache.has(key)) return cache.get(key);
  const value = Promise.resolve().then(read);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  try {
    return await value;
  } catch (err) {
    if (cache.get(key) === value) cache.delete(key);
    throw err;
  }
}

/** The files of a pull request at its head, from the cache when that head was read before */
export const filesAt = (forge, where, pull) => atSha(where, `files ${pull.number}@${pull.head.sha}`, () => forge.pullFiles(pull.number));

/** `pull/<n>` for a pull request's proposals */
export const pullSource = (n) => `pull/${n}`;

/** The number in a `pull/<n>` source, or null when it is not one */
export function pullNumber(source) {
  const m = typeof source === 'string' ? /^pull\/([1-9]\d{0,8})$/.exec(source) : null;
  return m ? Number(m[1]) : null;
}

/** What went wrong in words for the menu: the forge's own, or a plain line for anything else */
export const forgeWords = (err) => (err instanceof ForgeError ? err.message : 'The forge could not be asked; the log says why.');

/** The proposals folder as the forge spells paths: no leading `./`, no trailing slash */
export const folderOf = (where) => path.posix.normalize(String(where.proposals)).replace(/^\.\//, '').replace(/\/+$/, '');

/** Whether a changed file is a proposal that has a version at the head: a plain `<slug>.json` in the folder, not a review, not deleted */
function isProposal(file, folder) {
  return file.status !== 'removed' && path.posix.dirname(file.path) === folder && PROPOSAL_FILE.test(path.posix.basename(file.path)) && !file.path.endsWith('.review.json');
}

/** @returns {PullEntry} */
function entryOf(pull, file) {
  return {
    slug: /** @type {RegExpExecArray} */ (PROPOSAL_FILE.exec(path.posix.basename(file.path)))[1],
    source: pullSource(pull.number),
    path: file.path,
    sha: pull.head.sha,
    pull: { number: pull.number, title: pull.title, url: pull.url, draft: pull.draft, author: pull.author ? pull.author.login : null, createdAt: pull.createdAt, updatedAt: pull.updatedAt },
  };
}

/**
 * The proposals of every open PR that touches the proposals folder, newest PR first. A forge that cannot answer
 * gives `problem` in words, with what was found before it; the caller shows both.
 * With `hooks` (server/hooks.js), the spec PRs found are handed over to announce the new ones (`spec.ready`); that runs
 * in the background and changes nothing about the answer.
 * @param {import('./forge.js').Forge} forge
 * @param {{ proposals: string }} where
 * @param {{ hooks?: { specsSeen: Function } | null }} [opts]
 * @returns {Promise<{ entries: PullEntry[], problem: string | null, pulls: import('./forge.js').Pull[] }>} `pulls`: the open pull requests listed (a thread look reads their text, server/threads.js)
 */
export async function listPullProposals(forge, where, { hooks = null } = {}) {
  const folder = folderOf(where);
  let pulls;
  try {
    pulls = await forge.pulls({ state: 'open' });
  } catch (err) {
    return { entries: [], problem: forgeWords(err), pulls: [] };
  }
  let problem = null;
  const found = pulls.map(() => []);
  let next = 0;
  const worker = async () => {
    while (next < pulls.length) {
      const at = next++;
      try {
        found[at] = (await filesAt(forge, where, pulls[at])).filter((f) => isProposal(f, folder)).map((f) => entryOf(pulls[at], f));
      } catch (err) {
        problem ??= forgeWords(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, pulls.length) }, worker));
  const entries = found.flat();
  if (hooks) {
    try { hooks.specsSeen(forge.repo, entries, (entry) => readPullProposal(forge, where, entry)); } catch { /* a hook never gets in the way */ }
  }
  return { entries, problem, pulls };
}

/**
 * The proposals a pull request holds (open or not), read at its head.
 * @param {import('./forge.js').Forge} forge
 * @param {{ proposals: string }} where
 * @param {{ number: number, title: string, url: string, draft: boolean, author: { login: string } | null, head: { sha: string } }} pull
 * @returns {Promise<PullEntry[]>}
 */
export async function pullProposals(forge, where, pull) {
  const folder = folderOf(where);
  return (await filesAt(forge, where, pull)).filter((f) => isProposal(f, folder)).map((f) => entryOf(pull, f));
}

/**
 * The proposal `slug` of open PR `n`, or null when that PR is not open or does not hold it. Throws what the forge throws.
 * @param {import('./forge.js').Forge} forge
 * @param {{ proposals: string }} where
 * @param {string} slug
 * @param {number} n
 * @returns {Promise<PullEntry | null>}
 */
export async function findPullProposal(forge, where, slug, n) {
  let pull;
  try {
    pull = await forge.pull(n);
  } catch (err) {
    if (err instanceof ForgeError && err.code === 'not-found') return null;
    throw err;
  }
  if (pull.state !== 'open') return null;
  const folder = folderOf(where);
  const file = (await filesAt(forge, where, pull)).find((f) => isProposal(f, folder) && PROPOSAL_FILE.exec(path.posix.basename(f.path))?.[1] === slug);
  return file ? entryOf(pull, file) : null;
}

/**
 * The text of a listed proposal at its PR's head commit. Throws a ForgeError, `not-found` when the file is not there.
 * @param {import('./forge.js').Forge} forge
 * @param {{ proposals: string }} where the server's, whose cache it is
 * @param {PullEntry} entry
 * @returns {Promise<string>}
 */
export async function readPullProposal(forge, where, entry) {
  const text = await atSha(where, `file ${entry.sha}:${entry.path}`, () => forge.file(entry.sha, entry.path));
  if (text === null) throw new ForgeError(`${entry.path} is not at the head of pull request #${entry.pull.number}.`, { code: 'not-found' });
  return text;
}

// ---------------------------------------------------------------------------
//  The review state of each listed proposal (spec 0010 D4)
// ---------------------------------------------------------------------------

/** How long a PR's review state is kept at one head: a review posted on the forge itself shows within this */
export const REVIEW_KEEP_MS = 5 * 60_000;

/** @type {WeakMap<object, Map<string, { at: number, value: { byIndex: Record<string, PullReviewState> } }>>} */
const reviewCaches = new WeakMap();

/** Forgets what was kept of PR `n`'s reviews (a review was just posted on it), so the next listing reads it again */
export function forgetReviewState(where, n) {
  const kept = reviewCaches.get(where);
  if (!kept) return;
  for (const key of [...kept.keys()]) if (key.startsWith(`${n}@`)) kept.delete(key);
}

/**
 * The review state of every listed proposal, in the order of `entries`: `{ pushedAt, review }`. A draft PR is not read (it waits on the agent,
 * whatever was said on it before): `{ pushedAt: null, review: null }`. For a ready PR, `review` is null (none yet), the latest maintainer review
 * with `current`, or `{ error }` when the forge could not say. Never throws.
 * @param {import('./forge.js').Forge} forge
 * @param {{ proposals: string }} where
 * @param {PullEntry[]} entries
 * @param {{ now?: () => number }} [opts]
 * @returns {Promise<PullReviewState[]>}
 */
export async function reviewStates(forge, where, entries, { now = Date.now } = {}) {
  let kept = reviewCaches.get(where);
  if (!kept) reviewCaches.set(where, (kept = new Map()));
  const out = entries.map(() => ({ pushedAt: null, review: null }));
  /** @type {Map<number, number[]>} the indexes of the ready PRs' entries, by PR number */
  const byPull = new Map();
  entries.forEach((e, i) => { if (!e.pull.draft) byPull.set(e.pull.number, [...(byPull.get(e.pull.number) || []), i]); });
  const numbers = [...byPull.keys()];
  /** Who is a maintainer, asked once for this listing whatever the number of PRs they reviewed (not kept past it: a role can change) */
  const admins = new Map();
  let next = 0;
  const worker = async () => {
    while (next < numbers.length) {
      const n = numbers[next++];
      const at = byPull.get(n);
      const head = entries[at[0]].sha;
      const key = `${n}@${head}`;
      const hit = kept.get(key);
      if (hit && now() - hit.at < REVIEW_KEEP_MS && at.every((i) => hit.value.byIndex[entries[i].slug])) {
        at.forEach((i) => { out[i] = hit.value.byIndex[entries[i].slug]; });
        continue;
      }
      let pushedAt = null;
      try {
        const commits = await atSha(where, `commits ${n}@${head}`, () => forge.pullCommits(n));
        pushedAt = commits.length ? commits[commits.length - 1].date : null;
        const comments = await forge.comments(n);
        /** @type {Record<string, PullReviewState>} */
        const byIndex = {};
        for (const i of at) {
          const entry = entries[i];
          const found = await latestReview(forge, n, entry.slug, comments, admins);
          let review = null;
          if (found) {
            let current;
            if (found.verdict === 'approved') current = found.proposal === proposalHash(await readPullProposal(forge, where, entry));
            else current = !(pushedAt && Date.parse(pushedAt) > Date.parse(found.at)); // a send-back stands until something is pushed after it
            review = { verdict: found.verdict, by: found.by, at: found.at, current };
          }
          byIndex[entry.slug] = { pushedAt, review };
          out[i] = byIndex[entry.slug];
        }
        kept.set(key, { at: now(), value: { byIndex } });
        if (kept.size > CACHE_MAX) kept.delete(kept.keys().next().value);
      } catch (err) {
        const failed = { pushedAt, review: { error: forgeWords(err) } }; // not kept: asked again next time
        at.forEach((i) => { out[i] = failed; });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, numbers.length) }, worker));
  return out;
}

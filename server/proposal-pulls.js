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
 * @typedef {{ slug: string, source: string, path: string, sha: string, pull: { number: number, title: string, url: string, draft: boolean, author: string | null } }} PullEntry
 */

import path from 'node:path';
import { ForgeError } from './forge.js';
import { PROPOSAL_FILE } from './files.js';

/** How many pull requests have their files asked at once */
const PARALLEL = 6;
/** The most answers kept per server (a PR's files, or a file's text, at one head sha); the oldest goes first */
export const CACHE_MAX = 500;

/** @type {WeakMap<object, Map<string, unknown>>} */
const caches = new WeakMap();

/** What was read at `key` (a head sha is in every key), or `read()`'s answer, kept for next time */
async function atSha(where, key, read) {
  let cache = caches.get(where);
  if (!cache) caches.set(where, (cache = new Map()));
  if (cache.has(key)) return cache.get(key);
  const value = await read();
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}

/** The files of a pull request at its head, from the cache when that head was read before */
const filesAt = (forge, where, pull) => atSha(where, `files ${pull.number}@${pull.head.sha}`, () => forge.pullFiles(pull.number));

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
    pull: { number: pull.number, title: pull.title, url: pull.url, draft: pull.draft, author: pull.author ? pull.author.login : null },
  };
}

/**
 * The proposals of every open PR that touches the proposals folder, newest PR first. A forge that cannot answer
 * gives `problem` in words, with what was found before it; the caller shows both.
 * @param {import('./forge.js').Forge} forge
 * @param {{ proposals: string }} where
 * @returns {Promise<{ entries: PullEntry[], problem: string | null }>}
 */
export async function listPullProposals(forge, where) {
  const folder = folderOf(where);
  let pulls;
  try {
    pulls = await forge.pulls({ state: 'open' });
  } catch (err) {
    return { entries: [], problem: forgeWords(err) };
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
  return { entries: found.flat(), problem };
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

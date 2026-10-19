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
 * @typedef {{ slug: string, source: string, path: string, sha: string, pull: { number: number, title: string, url: string, draft: boolean, author: string | null } }} PullEntry
 */

import path from 'node:path';
import { ForgeError } from './forge.js';
import { PROPOSAL_FILE } from './files.js';

/** How many pull requests have their files asked at once */
const PARALLEL = 6;

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
const folderOf = (where) => path.posix.normalize(String(where.proposals)).replace(/^\.\//, '').replace(/\/+$/, '');

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
        found[at] = (await forge.pullFiles(pulls[at].number)).filter((f) => isProposal(f, folder)).map((f) => entryOf(pulls[at], f));
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
  const file = (await forge.pullFiles(n)).find((f) => isProposal(f, folder) && PROPOSAL_FILE.exec(path.posix.basename(f.path))?.[1] === slug);
  return file ? entryOf(pull, file) : null;
}

/**
 * The text of a listed proposal at its PR's head commit. Throws a ForgeError, `not-found` when the file is not there.
 * @param {import('./forge.js').Forge} forge
 * @param {PullEntry} entry
 * @returns {Promise<string>}
 */
export async function readPullProposal(forge, entry) {
  const text = await forge.file(entry.sha, entry.path);
  if (text === null) throw new ForgeError(`${entry.path} is not at the head of pull request #${entry.pull.number}.`, { code: 'not-found' });
  return text;
}

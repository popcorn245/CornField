#!/usr/bin/env node
/**
 * Whether a pull request's title is a conventional commit header, `type(scope): summary` (CONTRIBUTING.md). A pull
 * request is squash-merged under its title, and semantic-release reads those titles to decide the next version
 * (release.config.js), so a title it cannot read would release nothing, or the wrong thing.
 *
 *   node .github/scripts/pr-title.js "feat(forge): land a green pull request"
 *
 * Exits 1 with the reason, in words, when the title is not one. The title comes in as an argument (the workflow passes
 * it through an environment variable, never pasted into the script).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The types a title may start with; feat, fix, perf and revert release, the rest do not */
export const TYPES = ['feat', 'fix', 'perf', 'revert', 'refactor', 'docs', 'style', 'test', 'build', 'ci', 'chore'];

const HEADER = new RegExp(`^(${TYPES.join('|')})(\\(([a-z0-9][a-z0-9._/-]*)\\))?(!)?: (\\S.*)$`);

/**
 * What is wrong with a pull request title, or null when it is a conventional commit header.
 * @param {unknown} title
 * @returns {string | null}
 */
export function titleProblem(title) {
  if (typeof title !== 'string' || !title.trim()) return 'The title is empty.';
  if (title !== title.trim()) return 'The title starts or ends with a space.';
  if (title.length > 100) return `The title is ${title.length} characters; keep it to 100.`;
  const m = HEADER.exec(title);
  if (!m) {
    const type = /^([A-Za-z]+)[(!:]/.exec(title)?.[1];
    if (type && !TYPES.includes(type)) return `"${type}" is not a type: use one of ${TYPES.join(', ')}.`;
    return `Write it as "type(scope): summary", like "feat(forge): land a green pull request" (types: ${TYPES.join(', ')}; the scope is optional, lower case).`;
  }
  return null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const problem = titleProblem(process.argv[2]);
  if (problem) {
    console.error(`The pull request title is not a conventional commit: ${problem}\nSee CONTRIBUTING.md.`);
    process.exit(1);
  }
  console.log('The pull request title is a conventional commit.');
}

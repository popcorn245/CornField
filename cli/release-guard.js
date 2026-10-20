#!/usr/bin/env node
/**
 * @module cli/release-guard
 *
 * `prepublishOnly`: stops an `npm publish` that is not the release workflow's. A publish goes ahead only
 * when all of these hold, so a stray `npm publish` (from the wrong folder, a fork, a laptop) does nothing:
 *
 *   - it runs in cornfield's own repo root (this package.json is the one being published);
 *   - CORNFIELD_RELEASE=1 is set (only .github/workflows/release.yml sets it);
 *   - the release tag is v<version> of this package.json: CORNFIELD_RELEASE_TAG, which the release workflow sets to the
 *     tag semantic-release just made (a run on main has GITHUB_REF_NAME `main`, and Actions does not let a step change
 *     a GITHUB_ variable), else GITHUB_REF_NAME for a run on the tag itself.
 *
 * RELEASING.md says how a release is made.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAMES = ['cornfield', '@popcorn245/cornfield'];

export function releaseProblems({ cwd = process.cwd(), env = process.env, root = ROOT } = {}) {
  const problems = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (path.resolve(cwd) !== path.resolve(root)) problems.push(`npm publish runs from ${cwd}, not from cornfield's root (${root}).`);
  if (!NAMES.includes(pkg.name)) problems.push(`the package is "${pkg.name}", not one of ${NAMES.join(', ')}.`);
  if (env.CORNFIELD_RELEASE !== '1') problems.push('CORNFIELD_RELEASE is not 1: only the release workflow publishes (RELEASING.md).');
  const tag = env.CORNFIELD_RELEASE_TAG || env.GITHUB_REF_NAME;
  if (tag !== `v${pkg.version}`) problems.push(`the release tag is ${JSON.stringify(tag || null)}, not v${pkg.version}.`);
  return problems;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const problems = releaseProblems();
  if (problems.length) {
    console.error(`\nThis publish is refused:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
}

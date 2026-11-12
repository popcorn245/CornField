// `prepublishOnly`: stops an `npm publish` of the components that is not the release workflow's, or that would publish a build made for another
// version. Like the root package's cli/release-guard.js (RELEASING.md), and in addition:
//   - dist/ was built, and says (version.json, manifest.json) the version this package.json carries, which is the one cornfield's root package.json has,
//     which the release sets from the tag before it builds. So `0.48.0` in the package is `0.48.0` in `version.json` and in the code.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE, REPO } from './shared.mjs';

const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

export function releaseProblems({ cwd = process.cwd(), env = process.env, root = PACKAGE, repo = REPO } = {}) {
  const problems = [];
  const pkg = json(join(root, 'package.json'));
  if (resolve(cwd) !== resolve(root)) problems.push(`npm publish runs from ${cwd}, not from the components' folder (${root}).`);
  if (pkg.name !== '@popcorn245/cornfield-components') problems.push(`the package is "${pkg.name}", not @popcorn245/cornfield-components.`);
  if (env.CORNFIELD_RELEASE !== '1') problems.push('CORNFIELD_RELEASE is not 1: only the release workflow publishes (RELEASING.md).');
  const tag = env.CORNFIELD_RELEASE_TAG || env.GITHUB_REF_NAME;
  if (tag !== `v${pkg.version}`) problems.push(`the release tag is ${JSON.stringify(tag || null)}, not v${pkg.version}.`);
  const rootVersion = existsSync(join(repo, 'package.json')) ? json(join(repo, 'package.json')).version : null;
  if (rootVersion !== pkg.version) problems.push(`cornfield's package.json says ${rootVersion}, this package ${pkg.version}: the release sets both from the tag.`);
  for (const file of ['version.json', 'manifest.json']) {
    const built = existsSync(join(root, 'dist', file)) ? json(join(root, 'dist', file)).cornfield : null;
    if (built !== pkg.version) problems.push(`dist/${file} says ${JSON.stringify(built)}, not ${pkg.version}: build with \`npm run build\` after the version is set.`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = releaseProblems();
  if (problems.length) {
    console.error(`\nThis publish is refused:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
}

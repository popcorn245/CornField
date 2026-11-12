# Releasing cornfield

A release publishes the Docker image to GHCR (`ghcr.io/popcorn245/cornfield`) and the package to npm as both `cornfield` and `@popcorn245/cornfield`, and builds the web components under the same version (the image serves them; npm gets them as `@popcorn245/cornfield-components` once the token below is set). Nobody tags by hand: every merge to `main` is released by [semantic-release](https://semantic-release.gitbook.io/) in the release workflow ([.github/workflows/release.yml](.github/workflows/release.yml)), when the commits since the last tag call for one. The workflow is **off** until it is switched on.

## Switching it on (once)

1. **npm:** the release workflow's npm job publishes with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no token) once each package names this repo's `release.yml` as its trusted publisher, and with the repository secret `NPM_TOKEN` until then. A name never published has no settings page to name a trusted publisher in, so the token makes the first publish of each; then trusted publishing takes over and the secret goes. The steps: [npm: from a token to trusted publishing](#npm-from-a-token-to-trusted-publishing).
2. **GHCR:** nothing to add: the workflow pushes with the repo's own `GITHUB_TOKEN` (`packages: write`). After the first push, set the package's visibility to public in the account's Packages settings if wanted.
3. **Squash merges under the PR title:** in Settings, General, Pull Requests, allow squash merging with the default message "Pull request title and description", so the merge commit is the conventional title (and a `BREAKING CHANGE:` line in the description comes with it).
4. **Nothing to unlock on main:** a release commits nothing back. `main` stays locked; the release pushes only a tag (`v<version>`, on the merge commit itself) with the workflow's `GITHUB_TOKEN`. Only a rule that stops the token creating `v*` tags would block it.
5. **The switch:** add the repository variable `CORNFIELD_RELEASE` with the value `on`. Without it, a merge releases nothing. Setting it to anything else switches releases off again.

The first run makes the baseline tag itself: when the repo has no `v*` tag, it tags `v0.1.0` on the 0.1.0 release commit (`64eec0b`, "[CF-11] Release 0.1.0") before semantic-release looks at the history.

## How the version is decided

semantic-release reads the commit titles on `main` since the last tag. Pull requests are squash-merged under their titles, which are conventional commits ([CONTRIBUTING.md](CONTRIBUTING.md); CI checks each title):

| The commits since the last tag hold | Release |
|---|---|
| a breaking change (`feat!:`, `fix(auth)!:`, or a `BREAKING CHANGE:` line) | minor: 0.1.0 → 0.2.0 |
| a `feat` | minor: 0.1.0 → 0.2.0 |
| a `fix`, `perf` or `revert` | patch: 0.1.0 → 0.1.1 |
| only `docs`, `test`, `refactor`, `style`, `build`, `ci` or `chore` | none |

**cornfield stays on 0.x:** a breaking change is a minor release, never 1.0 ([release.config.js](release.config.js)). 1.0 will be a decision, made by changing that rule.

## What a release does

The workflow, on a merge to `main` with `CORNFIELD_RELEASE` on:

1. **check:** `npm ci`, the tests and `cornfield validate`. Nothing is tagged when they fail.
2. **version:** semantic-release works out the version, tags the merge commit itself `v0.2.0` (a tag-only push: nothing is committed to `main`) and makes the GitHub release, whose notes are the record of the release (`## [0.2.0] - 2026-10-20`, then Added / Fixed / Changed, a line per pull request). It publishes nothing itself. The tag is the only record of a version: `package.json` on `main` keeps the version last set by hand (0.1.0).
3. **image** and **npm**, in the same run (a tag pushed with `GITHUB_TOKEN` starts no other workflow), from the new tag, with the version set in `package.json` from it first (`npm version --no-git-tag-version`): the image is pushed as `0.2.0`, `0.2` and `latest`, and both npm names are published with a provenance attestation, by trusted publishing (or the `NPM_TOKEN` secret until it is set up: see below). Both start only when step 2 made a release. The image's [Dockerfile](Dockerfile) has a builder stage that builds the web components (`components/`) with that version, and keeps only their `dist/`; the image serves them at `/cornfield/components/`.
4. **components**, in the same run, from the same tag: sets the version in `package.json` and in `components/package.json` (`npm version --no-git-tag-version`), runs `npm ci` and `npm run build` in `components/` (so `dist/version.json`, `dist/manifest.json` and the `version` export say `0.2.0`), fails unless the tag, the package, `version.json`, `manifest.json` and `index.js` all say the same, prints what `npm pack --dry-run` would send, and then publishes `@popcorn245/cornfield-components` to npm **once it is armed**: when the `NPM_TOKEN` secret is set, or, with no token, when the package is already on npm (it then publishes by trusted publishing, as the npm job does once its token is gone). With no token and a name never published, the job prints one line saying the package was built and checked but not published, and succeeds; if npm's registry cannot say whether the name exists, the job fails rather than guess. The release, the image and the npm job are not touched by it either way. Starts only when step 2 made a release.

semantic-release and its plugins run with `npx` at exact versions pinned in the workflow; none of them is one of cornfield's dependencies.

To try what the next release would be, from a clone with the tags (the GitHub plugin checks a token even in a dry run: set `GITHUB_TOKEN` to one that can read the repo):

```sh
npx -p semantic-release@24.2.3 \
  -p conventional-changelog-conventionalcommits@8.0.0 semantic-release --dry-run --no-ci
```

## npm: from a token to trusted publishing

How the npm job authenticates, per npm's docs and the CLI: it tries trusted publishing first ("The npm CLI automatically detects OIDC environments and uses them for authentication before falling back to traditional tokens"). When the package names no trusted publisher, or does not exist yet, the token exchange fails quietly and npm publishes with `NODE_AUTH_TOKEN`, which the job sets from the `NPM_TOKEN` secret. An empty or missing secret changes nothing for trusted publishing. Either way the package gets a provenance attestation (`--provenance`, and the job's `id-token: write`). Trusted publishing needs npm 11.5.1 or later and Node 22.14.0 or later: the job installs a pinned npm 11 and uses Node 22.

1. **The first publish, by the token.** With the secret `NPM_TOKEN` set (an npm automation or granular token that can publish both `cornfield` and `@popcorn245/cornfield`), the next release publishes both names. Nothing to do on npmjs.com yet.
2. **Then, for each of the two packages,** on npmjs.com: Packages → the package → **Settings** → **Trusted Publisher** → "Select your publisher": **GitHub Actions**, and fill in:

   | Field | Value |
   |---|---|
   | Organization or user | `popcorn245` |
   | Repository | `CornField` |
   | Workflow filename | `release.yml` (the file name only, with `.yml`) |
   | Environment name | leave empty (the workflow uses none) |
   | Allowed actions | `npm publish` (the workflow publishes directly, not staged) |

   Every field is case-sensitive, and npm does not check them when you save: a mistake shows at the next publish, which then falls back to the token while it is there, or fails with `ENEEDAUTH` once it is not. npm's docs also say a new trusted publisher has to make its first successful publish **within 2 days**, or it expires and has to be deleted and made again: set it up shortly before a release you expect (a `fix` or `feat` merged to `main`), and look in that run's npm job for the trusted publisher being used.
3. **Then close the token path,** as npm recommends, per package: Settings → **Publishing access** → "Require two-factor authentication and disallow tokens" (trusted publishing keeps working). Revoke the npm token, and delete the repository secret `NPM_TOKEN` (Settings → Secrets and variables → Actions), once `@popcorn245/cornfield-components` has its trusted publisher too ([below](#the-web-components-on-npm)). The jobs carry on with trusted publishing alone.

**If the token cannot be used** (no token, or the release ran before it was set), each name can get its first publish by hand instead, of a version the workflow already tagged, from a clean checkout, logged in to npm as the owner of both names (`npm login`, with 2FA):

```sh
git checkout v0.1.1
npm ci
npm version --no-git-tag-version 0.1.1
# The release guard only lets a publish through on purpose: these two say it is this release's
export CORNFIELD_RELEASE=1 CORNFIELD_RELEASE_TAG=v0.1.1
# --provenance=false: package.json asks for provenance, which only a CI run can make; this one is by hand
npm publish --access public --provenance=false
npm pkg set name=@popcorn245/cornfield
npm publish --access public --provenance=false
git checkout -- package.json package-lock.json
```

## The web components on npm

`@popcorn245/cornfield-components` **is on npm**, first published by the 0.48.0 release. The repository secret `NPM_TOKEN`, which the root packages' first publish used, was already there, so the release's `components` job published it at once, with a provenance attestation. Each release publishes it again under the new number.

How the job decides, so that nothing is published by accident and nothing stops quietly:

- **`NPM_TOKEN` is set:** it publishes (npm tries trusted publishing first and falls back to the token).
- **No token, and the name is on npm:** it publishes by trusted publishing, as the npm job does.
- **No token, and the name has never been published:** it says so and succeeds. This was the state before 0.48.0, and is the state of a fork.
- **The registry cannot say which:** it fails, and publishes nothing.

The workflow never prints the token, and the job's only permissions are `contents: read` and `id-token: write`. A token for a fork needs **Read and write** on packages and scopes for its own scope, added under **Settings → Secrets and variables → Actions → Repository secrets** as `NPM_TOKEN` (not a variable: a variable is printed in logs).

Now that it is published you can do what the root packages do: name `release.yml` as the package's trusted publisher on npmjs.com (Packages → `@popcorn245/cornfield-components` → Settings → Trusted Publisher; fields as [above](#npm-from-a-token-to-trusted-publishing), allowed action `npm publish`) and then remove the token. Set up all **three** trusted publishers (`cornfield`, `@popcorn245/cornfield`, `@popcorn245/cornfield-components`) before you delete `NPM_TOKEN`: once the name is on npm the job publishes without the token, by trusted publishing, and fails with `ENEEDAUTH` if the package names no trusted publisher (as the npm job does), rather than stopping quietly. The job installs the npm that trusted publishing needs.

A package published by hand is refused by `prepublishOnly` ([components/scripts/release-guard.mjs](components/scripts/release-guard.mjs)) unless it runs in `components/` with `CORNFIELD_RELEASE=1` and `CORNFIELD_RELEASE_TAG=v<version>` set, with `package.json`, `dist/version.json` and `dist/manifest.json` all saying that version: a build made for another version cannot be published under this one's number.

## Release notes for a person

The explorer's Release notes tab and `cornfield notes` still draft notes grouped by what each pull request changed on the map ([docs/issues-and-prs.md](docs/issues-and-prs.md#release-notes)). That draft can be copied into the GitHub release semantic-release made, or kept as a draft release beside it: it publishes nothing and makes no tag.

## Why a stray publish cannot happen

`npm publish` runs `prepublishOnly`, which is [cli/release-guard.js](cli/release-guard.js). It refuses unless the publish runs from cornfield's own root, with `CORNFIELD_RELEASE=1` (only the release workflow sets it, and the first publish by hand above, if it is ever needed), and for the tag of this version: `CORNFIELD_RELEASE_TAG`, which the workflow sets to the tag semantic-release just made (else `GITHUB_REF_NAME`). The package's `files` list ships only `cli/`, `core/`, `explorer/`, `plugins/`, `server/` and the README, licence and changelog; CI checks it with `npm pack --dry-run`.

# Releasing cornfield

A release publishes the Docker image to GHCR (`ghcr.io/popcorn245/cornfield`) and the package to npm as both `cornfield` and `@popcorn245/cornfield`. Nobody tags by hand: every merge to `main` is released by [semantic-release](https://semantic-release.gitbook.io/) in the release workflow ([.github/workflows/release.yml](.github/workflows/release.yml)), when the commits since the last tag call for one. The workflow is **off** until it is switched on.

## Switching it on (once)

1. **npm:** create an automation token on the npm account that owns both names (`cornfield`, and the `@popcorn245` scope). Add it to the GitHub repo as the secret `NPM_TOKEN` (Settings, Secrets and variables, Actions).
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
3. **image** and **npm**, in the same run (a tag pushed with `GITHUB_TOKEN` starts no other workflow), from the new tag, with the version set in `package.json` from it first (`npm version --no-git-tag-version`): the image is pushed as `0.2.0`, `0.2` and `latest`, and both npm names are published with provenance. Both start only when step 2 made a release.

semantic-release and its plugins run with `npx` at exact versions pinned in the workflow; none of them is one of cornfield's dependencies.

To try what the next release would be, from a clone with the tags (the GitHub plugin checks a token even in a dry run: set `GITHUB_TOKEN` to one that can read the repo):

```sh
npx -p semantic-release@24.2.3 \
  -p conventional-changelog-conventionalcommits@8.0.0 semantic-release --dry-run --no-ci
```

## Release notes for a person

The explorer's Release notes tab and `cornfield notes` still draft notes grouped by what each pull request changed on the map ([docs/issues-and-prs.md](docs/issues-and-prs.md#release-notes)). That draft can be copied into the GitHub release semantic-release made, or kept as a draft release beside it: it publishes nothing and makes no tag.

## Why a stray publish cannot happen

`npm publish` runs `prepublishOnly`, which is [cli/release-guard.js](cli/release-guard.js). It refuses unless the publish runs from cornfield's own root, with `CORNFIELD_RELEASE=1` (only the release workflow sets it), and for the tag of this version: `CORNFIELD_RELEASE_TAG`, which the workflow sets to the tag semantic-release just made (else `GITHUB_REF_NAME`). The package's `files` list ships only `cli/`, `core/`, `explorer/`, `plugins/`, `server/` and the README, licence and changelog; CI checks it with `npm pack --dry-run`.

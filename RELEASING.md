# Releasing cornfield

A release publishes the Docker image to GHCR (`ghcr.io/popcorn245/cornfield`) and the package to npm as both `cornfield` and `@popcorn245/cornfield`. It happens only on the maintainer's go: the release workflow ([.github/workflows/release.yml](.github/workflows/release.yml)) is **inert** until it is switched on, and every publish needs a version tag pushed by hand.

## Switching it on (once)

1. **npm:** create an automation token on the npm account that owns both names (`cornfield`, and the `@popcorn245` scope). Add it to the GitHub repo as the secret `NPM_TOKEN` (Settings, Secrets and variables, Actions).
2. **GHCR:** nothing to add: the workflow pushes with the repo's own `GITHUB_TOKEN` (`packages: write`). After the first push, set the package's visibility to public in the account's Packages settings if wanted.
3. **The switch:** add the repository variable `CORNFIELD_RELEASE` with the value `on`. Without it, a tag runs nothing.

## Making a release

1. Update `CHANGELOG.md` (move Unreleased under the new version) and bump `version` in `package.json`, in a PR. Merge it. The pull requests since the last tag, grouped by what they changed on the map, are drafted for you: `cornfield notes` prints them as Markdown, and the explorer's Release notes tab can copy them or keep them as a draft release on the forge ([docs/issues-and-prs.md](docs/issues-and-prs.md#release-notes)). That only drafts: it does not publish, and it makes no tag.
2. Tag the merge commit and push the tag:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. The workflow runs the tests and `cornfield validate`, checks that the tag is `v` + the package version, then pushes the image (`0.1.0`, `0.1` and `latest`) and publishes both npm names with provenance.

## Why a stray publish cannot happen

`npm publish` runs `prepublishOnly`, which is [cli/release-guard.js](cli/release-guard.js). It refuses unless the publish runs from cornfield's own root, with `CORNFIELD_RELEASE=1` (only the release workflow sets it) and on the tag of this version. The package's `files` list ships only `cli/`, `core/`, `explorer/`, `plugins/`, `server/` and the README, licence and changelog; CI checks it with `npm pack --dry-run`.

# Contributing to cornfield

Thanks for helping. cornfield is built in the open, by people and by coding agents (Claude Code cloud sessions among them), and both follow the same path.

## The path of a change

1. **Pick or open an issue.** The v1 issues are listed in [docs/specs/0001-v1.md](docs/specs/0001-v1.md); later ones in [docs/roadmap.md](docs/roadmap.md). Say in the issue that you are on it.
2. **Anything that adds, changes or removes a module, a route, a store or a flow is proposed on the map first.** cornfield maps itself (`topology.json` at the root), so it uses its own topology gate:
   - write a proposal, `docs/specs/proposals/NNNN-slug.json` (the next free number; the format is in [core/proposal.js](core/proposal.js), and [0001-v1.json](https://github.com/popcorn245/CornField/blob/ede6b6e/docs/specs/proposals/0001-v1.json), the v1 proposal, is a worked example), with at least one scenario;
   - `node cli/cornfield.js proposal docs/specs/proposals/NNNN-slug.json` must pass;
   - open the spec PR with the proposal and a short spec beside it in `docs/specs/`. A maintainer reviews it on the map (Before / Diff / After, the scenarios, what-if edits) and approves it or sends it back. The verdict is a comment on the spec PR (cornfield posts it when you press Approve or Send back, with the edits).
3. **Build it** on a branch: plain ES modules, no build step, no new runtime dependency (ask first if you think one is needed). Small commits, tests first where you can.
4. **Keep the map true:** `node cli/cornfield.js sync`, then commit `topology.json` with the code. The docs are on the map too (the `docs` deriver): a new doc, or a link added or removed, needs a sync as well, and a broken link fails `validate`.
5. **Before the PR:** `npm test` and `node cli/cornfield.js validate` (CI runs both, and gitleaks). A proposal that has landed is deleted in the PR that lands it.
6. **Title the PR as a conventional commit:** `type(scope): summary`, like `feat(forge): land a green pull request` or `fix(auth): keep the session on a rename`. A PR is squash-merged under its title, and every merge to main is released from those titles ([RELEASING.md](RELEASING.md)), so the title decides the version:
   - `feat` is a minor release (0.**x**.0), `fix`, `perf` and `revert` a patch (0.1.**x**); `docs`, `test`, `refactor`, `style`, `build`, `ci` and `chore` release nothing on their own;
   - a breaking change is `type!:` (`feat(core)!: drop contract 1`), or a `BREAKING CHANGE:` line in the description. While cornfield is 0.x that is a minor release too, never 1.0;
   - the scope is optional and lower case (an area: `forge`, `auth`, `explorer`, `release`…); the issue key (`[CF-11]`, `Closes #5`) goes in the description.

   CI checks the title (`.github/workflows/pr-title.yml`). Do not edit `CHANGELOG.md` by hand: the release writes it from the titles.

Bug fixes and docs that change no architecture skip step 2.

## The rules that matter

- **No secrets, ever,** in code, tests, fixtures or config. gitleaks runs on every PR.
- **Never a real person** on a map, in a persona, a fixture or a doc: personas are archetypes, counts are counts.
- **The server is an allowlist.** A new file the browser loads must be added to it on purpose (`server/server.js`).
- **Pure where it can be:** models, layouts and checks have no DOM and no I/O, and are tested in Node. A test that needs a DOM starts with `// @vitest-environment happy-dom`. No test needs a GPU: test the data handed to WebGL.
- Plain words in the UI, sentence case.

## Running it

```sh
npm ci
npm test                                   # vitest
node cli/cornfield.js serve                # cornfield's own map on http://127.0.0.1:3350
node cli/cornfield.js serve --repo test/fixtures/sample --port 3351   # the sample repo: house, cloud, a proposal
```

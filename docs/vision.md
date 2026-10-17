# cornfield: the vision

*cornfield*: a movie snack, and where the corn gets harvested.

## What it is

cornfield is a self-hostable dev dashboard with the topology map at its centre. In the maintainer's words, it is **"the new hub for the developer to run the fleet and keep their sanity"**.

It serves the whole pipeline of a change:

> ideation → issues (GitHub and Forgejo, issues and PRs, from day one) → alignment threads → mockups → approving topology and scope on the map → shipping a PR → review → deploy → release notes.

**The topology map is the main view, with useful panels and minimal controls.** Panels point into the map: a PR lights the nodes it changes, a failing check lights its tests, and a deploy lights what it restarted.

## Where it comes from

cornfield started as the topology tool of one person's self-hosted monorepo: a map derived from the code that CI keeps true, and proposals on that map that a coding agent writes and the maintainer approves before anything is built. It worked well enough to deserve its own home, so it was extracted (with every trace of that house scrubbed) and now grows in the open. The monorepo becomes one of its users, through its own private plugin.

## The decisions (made by the maintainer, 2026-10-15 to 2026-10-17)

1. **Home.** `github.com/popcorn245/cornfield` is the canonical repo: where Claude Code cloud sessions build it, where outside contributors work, where issues and releases live. On npm it is `cornfield` (the CLI name) and `@popcorn245/cornfield`. MIT. ([ADR 0001](adr/0001-home-and-licence.md))
2. **Packaging.** One Node codebase with no build step (ES modules served as written, zero runtime dependencies), shipped two ways: a Docker image for the always-on dashboard, published to GHCR, and an npm CLI, `npx cornfield`, run against a repo on a laptop. Configured by `cornfield.config.js` in the target repo plus env vars. ([ADR 0002](adr/0002-buildless-one-codebase-two-ways.md))
3. **Backend.** cornfield runs its own small server: sign-in with GitHub or Forgejo (OAuth), where admins are the repo's maintainers; a SQLite file for threads, reviews and pipeline state; forge adapters for GitHub and Forgejo (issues, PRs, comments, checks, branches). It does not depend on any one monorepo's API: such an API is one optional source, through a plugin. ([ADR 0003](adr/0003-own-server-sqlite-forge-adapters.md))
4. **Access.** **Nothing is visible without signing in. Admins only.** A non-admin who signs in sees "this is the dev dashboard; ask a maintainer". Enforced on the server, not just in the UI. Until sign-in exists, the server listens on loopback only. ([ADR 0004](adr/0004-admins-only-loopback-until-sign-in.md))
5. **Proposals and reviews.** Proposals are read from pushed spec branches (the Proposals menu lists open spec PRs) and from a configured local worktrees folder for unpushed drafts. Approve / Send back posts a comment on the spec PR: a human line plus fenced JSON (`{ verdict, note, edits }`); the latest comment wins. The agent reads the review from the PR. No review files are written into a checkout. ([ADR 0005](adr/0005-reviews-are-pr-comments.md))
6. **Actions.** Show everything, plus a few safe actions: approve or send back, land a green PR, re-run a failed check, the pipeline's own steps. Never force-merge, never deploy by hand, never touch anything live. ([ADR 0006](adr/0006-safe-actions-only.md))
7. **Agents.** v1 *tracks* agents through what they leave: branches, spec PRs, PRs and checks. *Launching* agents from cornfield comes later. ([ADR 0007](adr/0007-track-agents-do-not-launch.md))
8. **v1 scope: the core, then grow in the open.** v1 is the map and proposals (Before / Diff / After, scenarios, outage Play, what-if edits), forge sign-in, PR-comment reviews, and an issues + PRs panel for both forges. Threads, mockups, deploys, release notes and agent launching are filed as issues for later ([roadmap](roadmap.md)).
9. **The house parts are open too,** as a generic optional plugin: the House view, floors and rooms, machines and containers, devices, personas (as counts, never names), and the Cloud band. Read-only from a source: a JSON file in the repo, Home Assistant directly, or a private API through a private plugin. No floor-plan editor. ([ADR 0008](adr/0008-house-is-an-optional-read-only-plugin.md))
10. **What stays private.** Only a user's own plugin and config: their repo-specific deriver, their house source, the contents of their cloud and personas files, their proxy and stack facts. The generic parts (the cloud registry format and its validator, the detectors, the personas format, the proposal format and its validator, the schema, the CLI, the server and the explorer) are cornfield. Where a generic part was tangled with facts, the logic moved here and the facts stayed as config. ([ADR 0009](adr/0009-generic-here-facts-in-config.md))
11. **Extraction.** cornfield started with one clean first commit, gitleaks-scanned and scrubbed of every house reference. From then on, all work happens here.
12. **Spec home.** The plan lives in this repo: this file, [the v1 spec](specs/0001-v1.md), [the ADRs](adr/) and [the roadmap](roadmap.md).
13. **cornfield dogfoods itself.** Its own later features go through its own topology gate: a proposal on cornfield's own map, reviewed on the map. ([ADR 0010](adr/0010-cornfield-uses-its-own-gate.md))
14. **The maintainer makes the first push and every release.** Nothing is published without an explicit go.

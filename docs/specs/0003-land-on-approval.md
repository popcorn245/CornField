# Spec 0003: approving a spec can land it (opt-in)

Status: built ([#68](https://github.com/popcorn245/CornField/issues/68)). Its proposal, `proposals/0003-land-on-approval.json`, was deleted in the PR that landed it; `git log` keeps it.

For teams where approving a spec means the docs are good, Approve followed by Land it is one decision made twice, and spec PRs pile up waiting for the second click. This adds an opt-in: with `proposals: { approveLands: true }`, an approval (the button, or the [review API](0002-review-api.md)) also lands the spec PR once it is mergeable and every check is green. Off by default; with it off nothing changes ([ADR 0006](../adr/0006-safe-actions-only.md) says the maintainer opted into this action).

## What it adds

- **The key.** `proposals` stays the folder as a string and may also be `{ dir?, approveLands? }`. `loadConfig` reads either into `config.proposals` (always the folder, so nothing that reads it changes) and `config.approveLands` (a boolean). Validated strictly: unknown keys, a non-boolean flag and a `dir` that leaves the repo are refused by name. The object form was chosen over a separate top-level key because the issue names it (`proposals: { approveLands: true }`), the option belongs to the proposals flow, and a string still means exactly what it did.
- **One hook point.** `submitReview` (`server/submit-review.js`), after an approval is posted and the `spec.approved` event is emitted: `lander.start(...)` in the background. Never for a send-back, never awaited, never able to fail the review.
- **One lander** (`server/lander.js`) for both forges, built on polling: a look at once, then every 20 seconds for the first 5 minutes and every minute after, for up to 60 minutes, on an injectable timer. Forgejo's own "merge when checks succeed" is not used, so the pinned head and the green rule stay cornfield's and the code path is the same, and testable, on both forges. Each look ends at the first terminal state: closed or merged elsewhere (done), head is not the approved sha (cancelled, "a push after approval"), a check is red (left open), another proposal of the PR not approved at its current hash (waits, silently), green and mergeable (lands), time up (left open). Anything else waits.
- **The same merge as Land it.** `landPull` (`server/forge-actions.js`) is `forge.merge(n, { onlyIfGreen: true, sha, method })` then the `pr.landed` hook; Land it and the lander both call it.
- **As the approver.** The landing uses the approver's own forge token (`auth.forgeForUser`, as the review API posts a review), and asks the forge who they are and whether they still maintain the repo just before it merges. A session that ended is "left open: sign in to land", and nothing else is done.
- **Pending landings survive a restart.** A `landings` table (migration 4: repo, pull, slug, approved sha, user id, login, started, state). On start cornfield drops rows that are finished or past their time and waits for the rest again.
- **Says so.** A landing that is cancelled or left open posts one PR comment as the approver through `forge.comment`, with mentions defused (`server/defuse.js`); every state change is a row in `actions` (`landing`), and a landed PR is the `merge` row with `via: 'approval'` and fires `pr.landed`. A landing posts no comment.
- **A small view.** The issues and PRs panel says "Will land when checks pass" on a pull request that is waiting, with a Cancel (a same-origin POST by a maintainer; one comment).

## Not covered

- A PR that holds several proposals lands only once every one of them is approved by a maintainer at its current SHA-256 (`latestReview` per slug); approving one starts nothing until the last is.
- A check that fails and is re-run later does not resume a landing that was left open; approve again, or use Land it.
- Required reviews other than cornfield's own approval are the forge's: a merge it refuses leaves the PR open in its words.

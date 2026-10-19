# ADR 0005: A review is a comment on the spec PR; the latest wins

Status: accepted (maintainer, 2026-10-17); built in v1 (CF-06)

## Decision

Approve and Send back post a comment on the spec PR: one human line, then a fenced JSON block tagged `cornfield-review` holding `{ verdict, note, edits }`. For example, a comment that reads "Sent back: make the checkout one page, not two." followed by the block:

```json
{ "verdict": "notes", "note": "Make the checkout one page, not two.", "edits": [{ "op": "remove-node", "id": "page-web-confirm" }] }
```

The **latest** such comment from an admin is the review. The drafting agent reads it from the PR. Proposals are read from pushed spec branches (the Proposals menu lists open spec PRs) and from the configured local worktrees folder for unpushed drafts.

No review file is ever written into a checkout. Stage 1 kept a review in the server's data folder (`<dataDir>/reviews/<source>/<slug>.review.json`); v1 posts each such file once as a comment on the matching spec PR and reads no review from the data folder any more. A draft with no PR has no review. `cornfield review <slug>` reads the review from the PR.

Built as: the fence's info string names the proposal (` ```cornfield-review <slug> `), since one PR can hold several; the JSON is exactly `{ verdict, note, edits }`; a comment counts only when its author maintains the repo (admin or maintain).

## Why

The PR is where the agent and the people already are, and a comment is history: who said what, when, about which commit. A file beside the proposal had to be git-ignored, could be lost, and needed shell access to read.

## Costs

The JSON in the comment has to survive people editing it: the parser takes only the block tagged `cornfield-review`, and a malformed one is ignored with a note on the bar.

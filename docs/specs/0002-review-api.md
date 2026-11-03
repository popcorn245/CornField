# Spec 0002: a review API for outside callers

Status: built ([#67](https://github.com/popcorn245/CornField/issues/67)). Its proposal, `proposals/0002-review-api.json`, was deleted in the PR that landed it; `git log` keeps it.

Approve and Send back are buttons today ([ADR 0005](../adr/0005-reviews-are-pr-comments.md), [ADR 0006](../adr/0006-safe-actions-only.md)). A maintainer who reviews from somewhere else, a chat reaction or a script, has no way in. This adds one: `POST /api/reviews`, called with a **review token** the maintainer mints in the dashboard. It adds no new kind of action: it is the same Approve or Send back, through the same checks.

## What it adds

- **One review path.** The button's `PUT /proposals/<slug>/review` and the new call both go through `submitReview` (`server/submit-review.js`): a maintainer now, a PR that is open and holds the proposal, a SHA-256 that is still the head's, a note to send back, the flood and repeat limits, the comment, the audit row. Nothing else posts a review.
- **Review tokens.** `cf_rt_` and 32 random bytes, shown once, kept as a SHA-256 hash in `cornfield.db` (`review_tokens`) with its owner, a label, when it was made, when it expires (30 days unless asked, 90 at most), when it was revoked and last used. Minted, listed and revoked from the dashboard by a signed-in maintainer only; a review token cannot mint a token.
- **The call.** `POST /api/reviews` with `Authorization: Bearer cf_rt_…` and `{ pull, slug, sha256, verdict, note?, edits? }`. It takes no cookie: a session cookie is never a substitute for the token.
- **Who posts.** The comment has to be the maintainer's own for `latestReview` to count it, so it is posted with the token owner's forge token, the one their dashboard sign-in keeps. Without a live sign-in of the owner there is nothing to post with, and the call is refused (401) and says to sign in again.
- **The comment** says it came through the API and names the token's label.

## Refusals

401 for no token or an unknown one; 403 for a revoked or expired token and for an owner who is not a maintainer now; 409 for a SHA-256 that is not the proposal at the PR's head; 400 for a bad review (a send-back needs a note); 404 for a PR that is not open or does not hold the proposal; 429 for a flood or a repeat. Every call is a row in `actions`, refused or not.

## Not covered

Scopes (a token does one thing), per-PR tokens and webhooks (events are [#66](https://github.com/popcorn245/CornField/issues/66)).

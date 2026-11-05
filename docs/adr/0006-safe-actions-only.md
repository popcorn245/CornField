# ADR 0006: Show everything, act only in a few safe ways

Status: accepted (maintainer, 2026-10-17)

Amended 2026-10-20 (maintainer): one more safe action, post a release draft (drafts only: never published, never tagged), for the release notes ([#17](https://github.com/popcorn245/cornfield/issues/17)).

Amended 2026-11-03 (maintainer): landing on approval is an action the maintainer opted into, never a default. With `proposals: { approveLands: true }` an approval also asks the forge to land the spec PR, through the same green-only merge as Land it, pinned to the approved head, as the approver, and only once every check is green ([#68](https://github.com/popcorn245/cornfield/issues/68)).

Amended 2026-11-05 (maintainer): two more safe actions, both posted as the maintainer and both only asking: ask the developer's runner to start or stop a run (a request, or a stop request, for a run id; the runner does the work and decides what stopping means), and open an idea issue or post a request in a thread. cornfield runs no agent and holds no agent credentials ([spec 0005](../specs/0005-threads-and-agents.md) D10, [ADR 0012](0012-cornfield-asks-runners-act.md)).

## Decision

cornfield shows everything it can read. It acts only in these ways: approve or send back a proposal; land a PR whose required checks are green (the forge's own merge, never an override); re-run a failed check; and the pipeline's own steps. It never force-merges, never deploys by hand, never touches anything live.

## Why

A dashboard that can do anything becomes the riskiest thing in the house. Every action here is one the forge already allows the maintainer and that the forge itself guards (protected branches, required checks).

## Costs

Some clicks still happen on the forge. That is the point.

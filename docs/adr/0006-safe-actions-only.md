# ADR 0006: Show everything, act only in a few safe ways

Status: accepted (maintainer, 2026-10-17)

## Decision

cornfield shows everything it can read. It acts only in these ways: approve or send back a proposal; land a PR whose required checks are green (the forge's own merge, never an override); re-run a failed check; and the pipeline's own steps. It never force-merges, never deploys by hand, never touches anything live.

## Why

A dashboard that can do anything becomes the riskiest thing in the house. Every action here is one the forge already allows the maintainer and that the forge itself guards (protected branches, required checks).

## Costs

Some clicks still happen on the forge. That is the point.

# ADR 0001: The home is github.com/popcorn245/cornfield, MIT, two npm names

Status: accepted (maintainer, 2026-10-17)

## Decision

The canonical repo is `github.com/popcorn245/cornfield` on the maintainer's personal account. Issues, pull requests, releases and Claude Code cloud sessions all work there. The licence is MIT. On npm the package is published as `cornfield` (so `npx cornfield` works) and as `@popcorn245/cornfield` (a scoped name nobody else can take), with the same files.

## Why

A public tool needs a public home where outside contributors and cloud sessions can work without access to anyone's private forge. MIT puts the fewest conditions on people who self-host it. Two names: the short one is what people type, the scoped one is the stable, owned one.

## Costs

Two npm names to publish on every release (the release workflow does both). Work moves off the private forge the tool came from; that forge's repo becomes a user of cornfield through its own plugin.

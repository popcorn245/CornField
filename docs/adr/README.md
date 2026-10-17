# Architecture decision records

One record per decision a contributor could reasonably question. Each says what was decided, why, and what it costs. A new decision gets the next number; a reversed one is marked superseded, never deleted.

| ADR | Decision |
|---|---|
| [0001](0001-home-and-licence.md) | The home is github.com/popcorn245/cornfield, MIT, two npm names |
| [0002](0002-buildless-one-codebase-two-ways.md) | One buildless Node codebase, shipped as a Docker image and an npm CLI |
| [0003](0003-own-server-sqlite-forge-adapters.md) | Its own small server, a SQLite file, and forge adapters |
| [0004](0004-admins-only-loopback-until-sign-in.md) | Admins only, enforced on the server; loopback only until sign-in exists |
| [0005](0005-reviews-are-pr-comments.md) | A review is a comment on the spec PR; the latest wins |
| [0006](0006-safe-actions-only.md) | Show everything, act only in a few safe ways |
| [0007](0007-track-agents-do-not-launch.md) | v1 tracks agents by what they leave; it does not launch them |
| [0008](0008-house-is-an-optional-read-only-plugin.md) | The house is an optional plugin, read-only from a source |
| [0009](0009-generic-here-facts-in-config.md) | Generic logic in cornfield, a repo's facts in its config and plugins |
| [0010](0010-cornfield-uses-its-own-gate.md) | cornfield proposes its own changes on its own map |
| [0011](0011-vitest-for-tests.md) | Tests run on vitest, a dev dependency only |

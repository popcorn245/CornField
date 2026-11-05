# ADR 0012: cornfield asks; the developer's runners act

Status: proposed (maintainer, 2026-11-05), with [spec 0005](../specs/0005-threads-and-agents.md), which the maintainer approved for building the same day. Supersedes [ADR 0007](0007-track-agents-do-not-launch.md), which is marked so. Amends [ADR 0006](0006-safe-actions-only.md) (two safe actions) and [ADR 0003](0003-own-server-sqlite-forge-adapters.md) (threads live on the forge).

## Decision

cornfield starts an agent only by **asking**: it publishes a versioned request (on the forge by default, or as a signed push, or in a queue a runner pulls from) and the developer's own runner does the work with its own identity, model and budget. cornfield runs no agent process, calls no agent platform, holds no agent or model credentials, and never puts a credential in a request. It follows a run through what the run leaves on the forge and anything the runner chooses to report, using the same fenced-block pattern as reviews (ADR 0005). Threads are forge conversations, not cornfield data.

## Why

The developer owns the stack; cornfield is the view on top. Asking through the forge keeps every request visible and audited without cornfield, works with any runner in any language, and lets the forge's own permissions be the security boundary. Deleting cornfield loses the view, never the work.

## Costs

The developer runs a small listener, a CI workflow or a bot to turn a request into a run; cornfield documents example runners but ships none as a dependency. cornfield cannot kill a run, enforce a budget or stream logs: it can ask a runner to stop, cap how often it asks, and link to the runner's own logs.

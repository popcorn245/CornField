# ADR 0007: v1 tracks agents by what they leave; it does not launch them

Status: accepted (maintainer, 2026-10-17); **superseded by [ADR 0012](0012-cornfield-asks-runners-act.md)** (maintainer's go-ahead to build [spec 0005](../specs/0005-threads-and-agents.md), 2026-11-05). Tracking stays; launching is now asking a runner.

## Decision

In v1, cornfield follows coding agents through the traces they leave: branches, spec PRs, PRs and checks, linked to the issue and the proposal they belong to. Launching an agent (a Claude Code session, for example) from cornfield is a later issue ([roadmap](../roadmap.md)).

## Why

Tracking needs only read access to the forge, which v1 has anyway. Launching needs credentials for an agent platform, budgets and a way to stop a run: a design of its own.

## Costs

In v1 an agent is started outside cornfield; it shows up as soon as it pushes.

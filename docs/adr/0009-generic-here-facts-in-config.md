# ADR 0009: Generic logic in cornfield, a repo's facts in its config and plugins

Status: accepted (maintainer, 2026-10-17)

## Decision

cornfield holds the generic parts: the schema, the proposal format and validator, the personas format, the cloud registry format and validator, the detectors (hosts in code, Dockerfiles, images, CI workflows, a Caddyfile), sync and validate, the deriver contract, the CLI, the server and the explorer. A repo's facts stay with the repo: its own deriver (how its apps, routes and tables are read), its house source, the contents of its personas and cloud files, its proxy paths and stack details. Where a part was tangled with facts, the logic moved here and the facts became options (`ownDomains`, `caddyfiles`, `haContainer`, the roles a persona may have).

## Why

A tool that knows one house's hostnames is that house's tool. Options keep the generic part testable on a sample repo ([test/fixtures/sample](../../test/fixtures/sample)) instead of on someone's real infrastructure.

## Costs

A repo with an unusual layout writes a small deriver ([docs/derivers.md](../derivers.md)); the contract is versioned so that deriver keeps working.

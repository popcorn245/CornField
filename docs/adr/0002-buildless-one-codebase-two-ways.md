# ADR 0002: One buildless Node codebase, shipped as a Docker image and an npm CLI

Status: accepted (maintainer, 2026-10-17)

## Decision

cornfield is plain ES modules that Node and the browser load as written: no bundler, no transpiler, no build step, and no runtime dependency (js-yaml is the one *optional* dependency, for reading CI workflows). The same files ship two ways:

- a **Docker image** (`node:22-alpine`, the repo mounted at `/repo`, state in `/data`) for the always-on dashboard, on GHCR;
- an **npm CLI**, `npx cornfield`, run against a repo on a laptop.

A repo configures it with `cornfield.config.js` plus env vars for what differs per machine (`CORNFIELD_PORT`, `CORNFIELD_HOST`, `CORNFIELD_PUBLIC_URL`, `CORNFIELD_DATA`).

## Why

What runs is what was written: a stack trace points at the real line, a contributor edits a file and reloads, and nothing breaks between a dependency's release and ours. The explorer already ran this way and draws 5,000 nodes at frame rate without a framework.

## Costs

No TypeScript at runtime (JSDoc types only); no tree shaking, so modules stay small on purpose; a feature that seems to need a library is written small, or argued for in its own ADR.

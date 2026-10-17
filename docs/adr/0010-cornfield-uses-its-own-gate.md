# ADR 0010: cornfield proposes its own changes on its own map

Status: accepted (maintainer, 2026-10-17)

## Decision

cornfield maps itself: `topology.json` at the root is derived by the starter deriver (each folder a package, each module a node, imports as lines) plus the cloud deriver, and CI fails when it drifts. A change that adds, changes or removes a module, a route, a store or a flow is proposed on that map first (`docs/specs/proposals/NNNN-slug.json`, with scenarios) and reviewed on the map before it is built. [CONTRIBUTING.md](../../CONTRIBUTING.md) has the steps. The v1 spec was approved in chat, so it skipped the gate; its proposal ([0001-v1.json](../specs/proposals/0001-v1.json)) is the worked example.

## Why

The tool's best test is its own use. A gate it does not use itself would not stay usable.

## Costs

Every architectural PR carries a proposal file; it is deleted when what it proposed has landed.

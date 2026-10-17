# ADR 0011: Tests run on vitest, a dev dependency only

Status: accepted (Stage 1 extraction, 2026-10-17)

## Decision

The suite runs on vitest (with happy-dom for the tests that need a DOM), as a dev dependency. Nothing at runtime depends on it.

## Why

The suite came with the code: about 1,200 tests written for vitest, using its mocks, fake timers, `vi.stubGlobal` and per-file DOM environments (`// @vitest-environment happy-dom`). `node --test` has no per-file DOM environment, and rewriting the suite would have risked changing what it asserts in the same commit that moved it. The test files are plain JavaScript, like the rest of the repo.

## Costs

Two dev dependencies (vitest, happy-dom) and their tree. A later move to `node --test` is possible file by file once Node grows a DOM story the tests can use.

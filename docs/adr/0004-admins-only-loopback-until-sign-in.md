# ADR 0004: Admins only, enforced on the server; loopback only until sign-in exists

Status: accepted (maintainer, 2026-10-17)

## Decision

**Nothing is visible without signing in, and only admins see anything.** A signed-in non-admin gets one page: "this is the dev dashboard; ask a maintainer". The server enforces this on every route (the page, `topology.json`, proposals, the API), not the UI.

Until forge sign-in exists (v1), the server binds to loopback only (`127.0.0.1`, `localhost`, `::1`) and refuses any other address at startup ([server/bind.js](../../server/bind.js)). There is no switch to turn this off. The Docker image runs with host networking for the same reason.

## Why

The map of a repo is a map of its weak points: what calls what, which secrets live where (by name), what breaks when a provider is down. Shown to the wrong person it is a gift. A dashboard that is open "for now" stays open, so before sign-in there is no way to open it.

## Costs

Stage 1 users reach a remote install over an SSH tunnel. Contributors without maintainer rights see nothing in a hosted cornfield; they run it locally on their clone, where they are its only user.

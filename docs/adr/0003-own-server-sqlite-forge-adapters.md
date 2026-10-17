# ADR 0003: Its own small server, a SQLite file, and forge adapters

Status: accepted (maintainer, 2026-10-17); v1 work

## Decision

cornfield runs its own HTTP server (Node's `http`, no framework). In v1 it gains:

- **sign-in with GitHub or Forgejo** (OAuth); admins are the repo's maintainers (as the forge says: admin or maintain permission);
- **a SQLite file** in its data folder for threads, reviews and pipeline state (Node's built-in `node:sqlite`, so still no dependency);
- **forge adapters** for GitHub and Forgejo behind one interface: issues, pull requests, comments, checks, branches.

It does not depend on any one monorepo's API. Such an API is one optional *source*, through a plugin (a live layer, a permission checker).

## Why

The tool came from a monorepo whose own API it called for live data and reviews. Tied to that API it could serve one repo; with its own server and both forges it can serve anyone, and the monorepo keeps its API as a plugin.

## Costs

An OAuth app per install (documented, created by whoever installs it). A data folder to back up. Two forge APIs to keep up with; the adapter interface keeps the rest of the code from knowing which one it talks to.

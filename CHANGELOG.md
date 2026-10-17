# Changelog

All notable changes to cornfield. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The first commit: cornfield extracted from the topology tool of a private monorepo.
  - The explorer: the WebGL2 map with its Canvas 2D fallback, orbit, data-flow and House views, labels, search, layers, the bench (`/?bench=1`, `/?fixture=5k`).
  - Proposals: the format and its validator, Before / Diff / After, the scenario player, what-if edits, Approve / Send back (kept in cornfield's data folder until v1 posts them to the spec PR).
  - Personas, the cloud registry and its detectors, outage scenarios, the House view over a house source.
  - The deriver contract (version 1) and three derivers: `starter` (npm workspaces, modules and imports), `personas`, `cloud`.
  - The CLI: `serve`, `sync`, `validate`, `status`, `proposal`, `review`.
  - The server: an allowlist, never a folder; a strict Content-Security-Policy; loopback only until forge sign-in exists.
  - A Dockerfile, `compose.example.yml`, GitHub Actions for tests, secret scanning and (inert until switched on) releases.

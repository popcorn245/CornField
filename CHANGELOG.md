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
- The SQLite store (`server/db.js`, #2): `cornfield.db` in the data folder over Node's built-in `node:sqlite`, numbered migrations, and the four tables of v1: `sessions`, `reviews`, `actions`, `forge_cache`.
- Sign-in and the admins-only guard (`server/auth.js`, #5): GitHub or Forgejo OAuth (with PKCE and a signed state), sessions in `cornfield.db` (the cookie's value hashed, the forge token encrypted), the permission asked again every 15 minutes, the sign-in and "ask a maintainer" pages, Sign out in the header, and the guard on every route but `/healthz`. With sign-in configured and an https public URL the server may listen beyond loopback; without, it still refuses. Setting up an OAuth app on each forge: `docs/sign-in.md`.
- The forge interface and the GitHub adapter (`server/forge.js`, `server/forge-github.js`, `server/forge-http.js`, #3): who is signed in and their permission, issues, pull requests and their files, comments, checks, re-running a failed Actions job, landing a green pull request at the head its checks ran on, branches, a file at a ref; pagination, rate limits and errors in plain words. Tests run against recorded answers and a fake forge.
- The `docs` deriver: a repo's Markdown on the map as an app with a page per document, its links to other docs and to the code they describe; a broken link fails `validate`.
- `cornfield docs`: the docs as a small static site built from that map (a page per document, the links around it, a map of the docs' links), published for cornfield itself to GitHub Pages by `.github/workflows/pages.yml`.
- The deriver kit, `cornfield/deriver-kit`: the deriver contract as JSDoc types, `defineDeriver`, and a test kit (`fixtureRepo`, `runDeriver`, `checkDeriver`) that runs a repo's own deriver on a fixture repo as `sync` and `validate` would and lists everything `validate` would fail on. Guide: `docs/deriver-kit.md`.
- The `compose` deriver: stacks and containers from Docker compose files, and an app with a `runs-on` edge per host a Caddyfile or Traefik labels route to them (SRC-02). The sample repo's stack now comes from its compose file.
- The `openapi` deriver: an API's endpoints from its OpenAPI, Swagger or OpenCollection file, as page nodes with their methods under the API's app (SRC-05). `test/fixtures/openapi` is a repo with nothing but an OpenAPI file.
- The starter deriver reads Python packages, Go modules and Rust crates the way it reads npm workspaces: their manifests, the imports between them, and a dependency declared and never imported (SRC-04). A fixture repo per language in `test/fixtures/python`, `go` and `rust`.
- Light mode (MAP-01): the explorer follows the system's light or dark setting, and a toggle in the header steps through system, light and dark (kept in the browser; `?theme=light|dark` for one visit). Both renderers and the labels draw the light map, its colours derived from the dark ones: the same hues, deepened to at least 3:1 on the light ground (4.5:1 for text).
- Keyboard and screen readers (MAP-02): the map takes the focus and its keys (arrows pan, + and - zoom, 0 fits, N and P step through the nodes, Enter and Escape go into and out of the panel, Alt+arrow moves a node in Freeform); a live region says where the keyboard landed; Enter in the search selects the match; a what-if edge can be drawn from a list. The closed panel is inert, the menus say whether they are open, and the page has its landmarks and heading. axe-core (a dev dependency) checks each state of the page in the tests. [docs/accessibility.md](docs/accessibility.md).
- Home Assistant as a house source (SRC-01): with `CORNFIELD_HA_URL` and `CORNFIELD_HA_TOKEN` set, the server reads the floor, area, device and entity registries over the WebSocket API (read-only) and serves them as the house answer; areas map to a house file's rooms by name and alias, and a `mobile_app` device (a person's phone) is left out entirely. The token never leaves the server.

### Changed

- `sync` takes away an edge of a derived kind only for the deriver that emits that kind, at the end where it puts its own nodes (`madeBy` and `claims` from `deriveTopology`), so a hand-written edge into a derived node of another deriver stays.
- A container's `selfHosted` and `summary` are hand-written, no longer fields the code decides.
- Node 22.13 or newer (`engines.node`, was 22.5): the SQLite store runs on `node:sqlite` without a flag only from 22.13, and sign-in is its first user. The image (`node:22-alpine`) and CI (`node-version: 22`) already run a newer 22.

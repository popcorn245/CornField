# Roadmap: after v1

cornfield grows in the open. Each item below is an issue draft, ready to file on GitHub (Stage 2) with the labels shown. The v1 issues themselves are in [the v1 spec](specs/0001-v1.md#4-the-v1-issues). Anything that changes cornfield's architecture is proposed on cornfield's own map first ([CONTRIBUTING.md](../CONTRIBUTING.md)).

## The pipeline (the vision's order)

### Alignment threads
Labels: `enhancement`, `pipeline`
A thread per idea or issue, kept in the SQLite file: people and agents write, a thread can point at nodes (they light up) and at a proposal. Done when: a thread can be started from an issue or from a node, its messages show on the map's panel, and a thread links to the spec PR it led to.

### Mockups beside a proposal
Labels: `enhancement`, `pipeline`
A proposal can carry screens (images or HTML files in the spec branch) shown beside the nodes they belong to. Done when: a mockup listed in a proposal opens from the node it names, and Approve covers it.

### Deploys on the map
Labels: `enhancement`, `pipeline`
Read a repo's deploy runs (forge actions, or a deploy log a plugin reads; [docs/deploys.md](deploys.md): the forge side is built, a plugin's log is not) and light what each deploy restarted. Read-only: cornfield never deploys (ADR 0006). Done when: the last deploys are listed and selecting one lights its nodes.

### Release notes from the map
Labels: `enhancement`, `pipeline`
Draft release notes from the PRs merged since the last tag, grouped by what they changed on the map. Done when: a draft can be copied or posted as a release draft on the forge.

### The pipeline's own steps
Labels: `enhancement`, `pipeline`
The safe steps between stages (issue to spec PR, approved spec to build issue, green PR to landed) as actions with their audit. Done when: each step is one button, guarded like the v1 safe actions.

### Launching agents
Labels: `enhancement`, `agents`
Start a coding agent (a Claude Code session, for example) on an issue or an approved proposal, see it run, stop it. Needs its own design: credentials, budgets, limits. Done when: an approved proposal can start one agent run that shows up as a branch and a PR.

## Sources and derivers

### Home Assistant as a house source
Labels: `enhancement`, `house`
Read floors, areas and devices straight from Home Assistant's WebSocket API (read-only, a long-lived token in env) into the house answer; areas map to rooms by name and alias; `mobile_app` devices are never named. Done when: a repo with only a Home Assistant URL and token gets a House view.

### A compose deriver
Labels: `enhancement`, `deriver`
Stacks and containers from `docker-compose.yml` files (images, ports, `runs-on` from the Caddy or Traefik routes), so a self-hoster gets the Software band without writing a deriver. Done when: the sample repo's stack comes from its compose file instead of by hand.

### A world file
Labels: `enhancement`, `deriver`
Which machine each stack runs on (`stacks/world.json`: hostnames only, never an address), as machine nodes with `runs-on` edges. Done when: machines are derived, and the tailnet detector of the cloud deriver reads them.

### Starter for more languages
Labels: `enhancement`, `deriver`, `good first issue`
Python packages and imports, Go modules, Rust crates, the same way the starter reads npm workspaces. Done when: each has a fixture repo and a test.

### An OpenAPI deriver
Labels: `enhancement`, `deriver`
Endpoints from an OpenAPI (or OpenCollection) file, as page nodes with methods under the API app. Done when: a repo with an OpenAPI file gets its endpoints on the map.

## The map

### Light mode
Labels: `enhancement`, `explorer`
The explorer is dark only. Done when: it follows the system and a toggle, both renderers included.

### Keyboard and screen-reader pass
Labels: `accessibility`, `explorer`
Everything the pointer can do on the map, by keyboard; the panel and the player read well. Done when: an audit finds no blocker.

### Proposals for any repo, without the gate
Labels: `docs`
A guide for teams that want proposals without cornfield's own gate: writing one by hand, reviewing it, landing it.

## Project

### A docs site
Labels: `docs`
The docs folder as a small static site, built by cornfield's own derivers (the map of the docs links).

### Publish the deriver contract as a package
Labels: `enhancement`
Types (JSDoc) and a test kit for people writing derivers. Done when: a deriver can be tested against a fixture repo with one import.

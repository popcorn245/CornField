# Spec 0012: Work as a view (issues, PRs and proposals as nodes on a map of their own)

Status: **approved** (maintainer, in chat, 2026-11-13, on the mock: "That's fine, I think we can still have a listing component that shows the different work lists kinda like we had before"), so it skips the map review gate ([ADR 0010](../adr/0010-cornfield-uses-its-own-gate.md)). The four questions put with the mock are answered as recommended; the list stays, as a component. Its proposal is [proposals/0012-work-as-a-view.json](proposals/0012-work-as-a-view.json).

## What the maintainer asked for

> Starting to feel like the issues, PRs, and proposals are just more nodes and layers. Instead of work being off to the right, think that it's part of the view switcher to the left and shows just the map of work and what that's connected to.

## What stands in the way today

- **Work is a side panel**, opened by a button at the far end of the header, with six tabs (Specs, PRs, Issues, Threads, Runs, Deploys). A row lights the nodes it touches on the map, one row at a time. Nothing shows how the pieces of work relate to each other: which issue an agent is on, which PR closes it, which thread became which proposal, which deploy shipped which PR.
- **The links are already known, but only one at a time and in the browser.** A PR's files are read when its row is opened (`litFor` in `forge-panel-model.js`), a thread's `[[mentions]]` when it is opened (`litForThread`), a deploy's restarts (`litForDeploy`), a run's nodes (`litOfRun`), a proposal's added and changed nodes from its file.
- **The panel and the map compete for the screen.** At 1440×900 the panel takes 400 px of the map; on a phone it is a sheet over it (spec 0010 D7).

## Decisions

### D1. Work is a view, beside Map and Flow

- The view switch gains **Work**: Map · Flow · (House) · Work · Fit. The "waiting on you" number of spec 0010 D1 moves onto it as its badge ("Work 3", spoken "Work, 3 waiting on you"); it is unchanged in meaning.
- The **Work button and the side panel** at the far end of the header **go**. Their tabs become layers (D4), their rows become nodes (D2), their detail and actions move to the node panel (D5), and their lists become the Work list (D6).
- `state.view === 'work'`, laid out by its own function as the House view is (`house-model.js`), and refitted on entry like every view.

### D2. Work items are nodes; their links are edges

| Kind | What it is | Shape |
|---|---|---|
| `thread` | a forge conversation that points at the map (spec 0005) | circle |
| `issue` | an issue | circle with a mark |
| `proposal` | a spec proposal, local or on a PR | diamond |
| `run` | an agent run | hexagon |
| `pull` | a pull request that is not a spec PR | rounded square |
| `deploy` | a deploy | square |

- Each kind has its own colour, from new theme tokens `--corn-work-<kind>` with defaults, so a theme can set them (the theme contract, never a special case). Shape, the label's kind word and number (`PR #27`) tell kinds apart without colour.
- **Edges between work:** `became` (thread → proposal), `agent-on` (issue or proposal → run), `opened` (run → PR), `closes` (PR → issue, from `Closes #n` in its body), `implements` (spec PR's proposal), `shipped` (PR → deploy, by merge commit), `discusses` (thread → proposal by slug).
- **Edges to code:** `changes` (a PR's files, a proposal's changed nodes, a run's nodes), `adds` (a proposal's added nodes: drawn dashed, the node itself drawn as planned until it exists), `mentions` (a thread's or issue's `[[node]]`), `restarts` (a deploy's restarts).
- **Which work:** open, plus closed, merged or finished in the last 14 days. The Work list (D6) reaches older work, as the tabs do today.

### D3. The layout: lanes by stage, then the code it touches

- Four lanes left to right: **Talk** (threads, issues), **Decide** (proposals), **Build** (runs, PRs), **Ship** (deploys); then a column of **the code the work touches**, ordered by how much work touches each node. Within a lane, newest first; what waits on you first.
- **Only code that work touches** is drawn in the Work view; the rest of the map is not.
- Selecting a node dims all but it and its neighbours and names its edges (`closes`, `adds`), as the mock shows.
- **"Waiting on you"**, a toggle at the top left of the view, dims all but what D1 counts.
- On a phone the lanes run top to bottom (Talk, Decide, Build and Ship), and the code sits beside them.

### D4. Layers: one per kind of work

- In the Work view the Layers menu lists the six kinds and "Code they touch", each with its count (Proposals "3 to decide", Runs "1 waiting", Pull requests "8 open"), on or off like any layer.
- **On the Map view**, a new layer **Work**, off by default, puts a small badge (`PR #27`, `Issue #14`) on each node open work touches; the runs' pulse (`runs-map.js`) stays as it is.

### D5. The node panel shows a work node and its actions

- Kind, title, state pills, what it is connected to (each a link that selects that node), checks, and the words saying what the action will do, as the decision does today.
- The actions are today's, with their confirms and their server checks: a proposal opens its review (Before, Diff, After) and Approve or Send back; a PR Merge when green and Re-run failed; an issue Start an agent; a run its answer field and Continue or Stop; a thread Reply and Open on the forge; a deploy its logs and Re-run.
- A code node in the Work view shows the work touching it, and "Show on the map", which switches to the Map view with it selected.

### D6. The Work list: the lists, kept as a component

- A **List** toggle in the Work view opens the Work list where the side panel sat: the same lists as today's tabs (Specs grouped by who must act, PRs, Issues, Threads, Runs, Deploys), with the same filters, search and counts. It is one piece, `work-list`, built from today's list code.
- **A row selects its node** on the map, and the node panel shows it; the list does not repeat the detail.
- It is the keyboard's and the screen reader's overview of the Work view, as the Runs list is for the runs' marks today. It also reaches work older than 14 days.
- On a phone it is a sheet, under spec 0010 D7's rule: two sheets at most, the map keeps 35%.

### D7. One request for the graph, worked out on the server

- `GET /api/forge/work-graph` answers `{ ok, nodes, edges, problems }`: the work nodes of D2 with their stage, state, number or slug or run id, title, url, updated time and `waiting`; their edges; and the planned code nodes a proposal adds.
- **A PR's files are read once per head commit and kept**, as the PR detail is today; at most 50 open PRs and 300 files each, the rest said in `problems`.
- The same gate as every forge route: a signed-in maintainer of the configured repo. Not open to an embedding origin: that waits on the second embed key of spec 0011 D9.
- The browser keeps reading the lists' own routes for the Work list; the graph replaces only the one-row-at-a-time lighting.

### D8. Addresses

- `?view=work` opens the Work view. `?pr=21`, `?issue=14`, `?run=<id>`, `?thread=31`, `?spec=0100` open it with that node selected; the addresses the Work panel answers today (`?work=…&tab=…`) still work and land there.

## What a host app gets

A host uses `<corn-map view="work">` beside a `<corn-node-panel>` in a `<corn-scope>`: no separate `<corn-work>` tag is needed for the map of work. A `<corn-work-list>` tag, and the actions from another origin, wait on the second embed key (spec 0011 D9), which is the maintainer's decision.

## Where it stands

Step 1 built (the server's work graph: `server/work-graph.js`, `GET /api/forge/work-graph`, documented in [issues-and-prs](../issues-and-prs.md#the-work-graph)). Step 2 built: the Work view in cornfield's page (`explorer/work-view.js`, `explorer/work-model.js`): the view switch's Work button with its badge, six kinds of node with their shapes and `--corn-work-<kind>` tokens, the lanes and the code they touch, the Waiting on you toggle, the Layers menu's own rows, the node panel's work detail with "Open in Work" (to today's panel, for the actions), search finding work, and `?view=work`, `?pr=`, `?issue=`, `?run=`, `?thread=` and `?spec=`. The checks of a pull request are not in the graph: the node panel reads them from the pull request's own route when it opens. The header's Work button and the side panel stay until step 3. Steps 3 and 4 are not built.

## What gets built, in order

Each step is its own pull request and release; cornfield's page keeps working after each.

1. **The server's work graph** (D7): `server/work-graph.js`, the route, the PR files kept per head, tests against the fake forge, the request in `docs/`.
2. **The Work view** (D1 to D5, D8): the view, its layout, the node kinds, shapes and tokens, the layers, the node panel's work detail and actions, search finding work, the Waiting on you toggle, the addresses. The side panel stays reachable from the Work view while step 3 is built.
3. **The Work list and the panel retired** (D6): the lists as the `work-list` piece in the Work view; the header's Work button and the side panel removed; the phone's sheets.
4. **The Work layer on the Map view** (D4).

## What is not in this spec

- The `<corn-work-list>` tag and actions from an embedding origin (spec 0011 D9's second key).
- Editing work from the map (drawing an edge to link an issue to a PR).
- Work from more than one repo on one map.

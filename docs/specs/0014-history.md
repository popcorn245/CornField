# Spec 0014: History (the map's own git history: replay it, trace a node to its spec, and a History layer)

Status: **draft, a mock for review.** Nothing is decided until the maintainer answers the questions below. Its proposal is [proposals/0014-history.json](proposals/0014-history.json), with three mockups in [proposals/0014-history/](proposals/0014-history/). The mockups are stills of an explorable mock that runs on cornfield's own history (`explore.html` beside them, which reads `history.json`; serve the folder to open it, since a mockup inside cornfield never runs script).

## What the maintainer asked for

> Want to add git commit history to this tool in a couple ways.
>
> 1. To be able to replay your topology on a timeline and see the project actually grow like watching cells in a dish
> 2. Be able to click on any node and see the git history for that item and be able to link through to the source control to see what was in that commit
> 3. Maybe seeing git stuff as another layer
>
> The idea is we should be able to kind of use this to git blame and see the connection from this work. From spec to issue to pr to commit, full transparency. Let's start by mocking it and then go from there.

## What stands in the way today

- **The map has no past.** `topology.json` is the map as it is now. A node does not know when it appeared, what changed it, or why.
- **The trail from intent to code is in four places.** The spec is a file in `docs/specs/`, the issue and the pull request are on the forge, the commit is in git. Cornfield shows the first three as work (spec 0012) but only while they are open, and never ties a merged one back to the nodes it changed.
- **The trail has gaps nobody can see.** In cornfield's own 132 commits, every one names its pull request, but only 51 name an issue and 37 a spec. Nothing says which.

## What the mock shows

The mock is built from cornfield's own repo: the 320 nodes of `topology.json`, placed by the map's own layout (`computeOrbitalLayout`), and the 132 commits on `main` up to `45d37ba`. Every link in it goes to the real commit, pull request, issue or spec on GitHub. How it was read:

- A node's **commits** are those that changed its `file` (or anything under it, for a folder).
- A node is **born** at the first commit that added its file. 105 nodes are born in the first commit, the one that lifted cornfield out of the repo it grew in.
- A commit's **pull request** is the last `(#N)` in its title. Its **issues** are an earlier `(#N)`, an issue key like `[CF-45]` that an issue's title carries, or `Closes #N`. Its **specs** are a `spec 00NN` in its message, or a spec file it changed.
- Commit authors are left out: never a real person in a fixture.

## Decisions, as proposed

### D1. Replay: the map grows on a timeline

- A **Replay** button in the header, and a **timeline** strip along the bottom of the Map view: one mark per commit, its height the number of nodes it touched, its colour its kind (`feat`, `fix`, `docs`, other). Play, pause, step a commit back or forward, three speeds, drag to scrub, **Now** to come back.
- At a commit, the map shows only the nodes born by then and the edges between them. A node being born buds out of its parent and settles into its place; nodes the commit changed pulse once. The layout is today's and never moves, so the dish stays still while it fills.
- The strip's line under the marks is the commit at the playhead, as a trail (D2).
- A count in the corner: nodes, edges, commit *n* of *N*, and how many were born at this one.

Mockup: [replay.png](proposals/0014-history/replay.png).

### D2. A node's history in the node panel

- A **History** section: how many commits and pull requests changed it, and how many of its commits name a spec or an issue ("traced"), as a share.
- **Specs behind it**: every spec its commits name. Picking one lights every node that spec reached (D3).
- **Issues**: every issue its commits name, each a link.
- **Commits**, newest first: the date, the title, how many nodes it touched, and its **trail**: `Spec 0012 → Issue #283 → PR #284 → 0281cba`, each a link to the forge. A missing link is shown as a dashed `no spec` or `no issue`, so the gaps are seen. Choosing a commit moves the timeline to it and lights the other nodes it touched.
- **Born** in which commit, and the file as a link to the forge (already there as Open file, CF-45).

Mockup: [node-history.png](proposals/0014-history/node-history.png).

### D3. The History layer

- A row **History** under Overlays in the Layers menu, beside Runs in flight, Work and Words, remembered like the others.
- Each node gets a halo: its size is how often the node changed, its colour how recently (from this week to over a month), as of the timeline's commit. A legend says so.
- Picking a spec (from the node panel or a trail) dims the map to the nodes its commits touched and puts a bar on the map: `Spec 0012 · Work as a view: 6 commits, 72 nodes`, with the spec as a link. Its commits are marked on the timeline.

Mockup: [history-layer.png](proposals/0014-history/history-layer.png).

### D4. Where history comes from

- A new `core/history.js` reads the repo's history once per change of `HEAD` and keeps, per commit: its hash, date, title, pull request, issues, specs and the nodes it touched; per node: when it was born and its commits.
- A new route, `GET /api/history`, serves it (allowlisted on purpose), and the page reads it only when the History layer or Replay is first used.
- Links go to the forge cornfield already knows (`forge` in the config), so a Forgejo repo links to Forgejo.

## The questions

1. **How cornfield reads git.** Cornfield never runs anything from the repo, and today runs no program at all. Recommended: run `git log` read-only with fixed arguments (no repo hooks or config run by it), behind a setting that is off for a repo cornfield does not own. The alternatives are reading `.git` directly (a pack-file reader, heavy) or asking the forge's API (slow, and only the forge's view).
2. **Replay layout.** Recommended: today's layout, still, with nodes budding in (the mock). The alternative is laying out each commit's map again so it grows outward, which moves nodes as you watch.
3. **The trail's sources.** Recommended: what the commit says (titles, keys, `Closes #N`, spec numbers, spec files), as in the mock, plus the forge's own link from a pull request to the issues it closes, read once and kept. Should a commit that names nothing be flagged in `validate`, or only shown as a gap?
4. **Nodes that moved or went away.** A renamed file starts a new node in the mock. Recommended: follow renames (`git log --follow`), and show removed nodes as ghosts during a replay. Or leave both for later.

## What gets built, in order

Each step is its own pull request and release; cornfield's page keeps working after each.

1. **Reading history** (D4): `core/history.js`, the setting, `GET /api/history`, tests on a fixture repo, docs.
2. **The node panel's history** (D2): the History section with its trails and links, and picking a spec.
3. **The History layer** (D3): the halos, the legend, the spec bar, the strings and theme tokens.
4. **Replay** (D1): the timeline strip, the budding and pulses, keyboard and screen reader (a step says what was born and what changed), and reduced motion (no budding, nodes simply appear).

## What is not in this spec

- Diffs inside cornfield. A commit opens on the forge.
- History of branches other than the default one, and of open pull requests (those are work, spec 0012).
- Blame inside a file, line by line.

# Spec 0008: reading a big map (layout, labels, search, selection, edge kinds, type shapes)

Status: **built**: steps 1 to 3 in the first part, steps 4 to 7 in the second. Approved by the maintainer, in chat, 2026-11-11 ("Approve all 5 go"), so it skipped the map review gate ([ADR 0010](../adr/0010-cornfield-uses-its-own-gate.md)); every open question was answered as recommended. Its proposal, `proposals/0008-reading-a-big-map.json`, is in `git log`.

Issues: [#172](https://github.com/popcorn245/CornField/issues/172) (F23), [#173](https://github.com/popcorn245/CornField/issues/173) (F24), [#174](https://github.com/popcorn245/CornField/issues/174) (F25), [#176](https://github.com/popcorn245/CornField/issues/176) (F28), [#177](https://github.com/popcorn245/CornField/issues/177) (F29), [#218](https://github.com/popcorn245/CornField/issues/218) (the whole map fits but is mostly empty), from the 0.34 design review and its fixes.

The 0.34 review read one real map of 922 nodes and 3,632 edges in 19 types. At that size the map stops answering the questions it is for: *what is this cluster made of*, *where is the thing I named*, *what does this node touch*, *is that a read or a write*. What the review measured:

- **Labels.** Below zoom 0.6 only landmark types keep a label. Over the largest cluster at 0.5, **296 of 297** nodes on screen have none. At the first view of 0.34 (zoom 0.18) the 30 labels drawn were 4.3 to 4.7 px high. At 1× in the busiest cluster, 16 labels collide.
- **Search.** A 4-letter term matches 33 nodes: no count, no list, no next, and the camera stays at the first view's zoom. A term with no match shows nothing. Search reads labels only, so 4 of 58 services can be found by their kind.
- **Selection.** Selecting the root lights **694 of 824** nodes; the largest app lights 515 nodes and 1,590 edges. The camera never moves, so a selected service's 30 lines run off screen.
- **Edge kinds.** Reads, writes, calls, triggers, delivers and flow are the same 1.6 px curve with the same arrowhead; only the colour differs. A dash means three things: a usage link, a proposed edge, a cloud call that breaks at the next deploy (90 of those on this map).
- **Layout.** Since [#214](https://github.com/popcorn245/CornField/issues/214) the whole map fits, but most of it is empty ([#218](https://github.com/popcorn245/CornField/issues/218)). Every hub cluster sits on one ring whose radius grows with the number of clusters. On the fixture map **84.7%** of the 13,289 × 13,353 px box is more than 200 px from any node (76.4% of 9,755 px a side on the reviewed map). Fit is zoom 0.057 at 1440 and 0.026 at 390, where the median node is 1.0 px across.
- **Types.** Every node is a circle with a white core, 6 to 9 px across at the first view of 0.34, and under 3 px now that Fit shows the whole map. Five pairs of types sit under ΔE2000 13 (cloud/web 0, page/pkg 9.3, root/store 9.4, core/atom 10.7, app/molecule 12.1).

## The rule it answers to

> A node's colour says its type, but its panel says it in words; a proposal's marks are a colour and a shape. ([accessibility.md](../accessibility.md))

Extended to the whole map: **nothing on the map is told by colour alone, and nothing is drawn too small to read.** Each decision below is the smallest rule that meets that on a map of about 1,000 nodes.

## Decisions

### D1. Layout and the first view: pack the clusters by size, fit the whole map, name the clusters

- **Clusters are packed, not ringed.** The root and the data core stay in the middle. Each hub's cluster, largest first (ties by label), takes the free place nearest the centre, searched from the top clockwise, with today's 70 px between clusters. Childless hubs keep their outer ring. No physics: the same map always draws the same.
- **Measured** by running `explorer/layout.js` with only this step changed, on the fixture (`test/fixtures/big/make.js`, seed 245) and on the reviewed map, at the layers that are on at load:

| | Fixture today | Fixture packed | Real today | Real packed |
|---|---|---|---|---|
| Box (px a side) | 13,289 × 13,353 | 5,838 × 5,876 | 9,755 × 9,752 | 5,979 × 5,976 |
| More than 200 px from a node | 84.7% | 28.6% | 76.4% | 41.3% |
| Fit at 1440×900 / 390×844 | 0.056 / 0.026 | 0.128 / 0.059 | 0.077 / 0.035 | 0.126 / 0.057 |
| Median node on a phone at Fit | 1.0 px | 2.3 px | 1.4 px | 2.3 px |
| Hub titles that fit at 13 px, 1440 / 390 | 42 / 18 of 87 | 48 / 21 of 87 | 53 / 22 of 87 | 50 / 20 of 87 |

- **Targets the test holds on the fixture:** a box of at most 6,000 px a side; Fit at least 0.12 at 1440×900 and 0.055 at 390×844; at most 35% of the box more than 200 px from a node; still no two discs overlapping.
- **The first view is Fit:** the whole map, with hub titles at 13 px or more (D2), the largest clusters' titles first and the rest named on hover. A click or tap on a cluster's title frames that cluster. The hand-zoom floor is the fitted zoom (#214).
- **Stable for people who know the map:** the root and the data core stay in the middle, clusters are placed in today's order (largest first), and a cluster's place depends only on the clusters placed before it, so a new small cluster moves no bigger one.
- **Rejected:** several hub rings filled inside out (fixture / real: boxes of 6,656 / 7,326 px, Fit 0.112 / 0.103, 40% / 58% empty: one big cluster sets a ring's width and leaves its arc empty); grouping hubs by type, one run per type (7,261 / 10,653 px, Fit 0.103 / 0.071); a force layout (positions move between loads and with every change, and 922 nodes take seconds on a phone).

### D2. Labels: placed in a fixed priority order, never colliding, never under 11 px

- **No zoom cut-off.** Every visible node is a label candidate at every zoom. `LABEL_ZOOM` (0.6) goes.
- **Priority, highest first:** the selection; the current search match, then the other matches; the selection's lit neighbours (D5); nodes a proposal marks; hubs (today's landmark types: root, app, pkg, tool, store, rom, floor); then the rest, larger radius first, then more edges, then scene order. The order does not depend on the camera, so a pan never reshuffles it.
- **Placement is greedy.** Labels are placed in that order; a label whose screen box (plus 2 px) touches one already placed is skipped. The result: zero colliding pairs at any zoom.
- **A minimum on-screen size.** A drawn label is at least **11 px** (hubs 13 px, bold) whatever the zoom; zoomed in, it grows with the map as now. Text that would be smaller is not drawn smaller: it competes for room at 11 px.
- **No label, still named.** A node without a label shows it on hover and on keyboard focus (`N` / `P`), as a chip above everything else; on touch, a tap selects it and the peek names it.
- **What to expect.** Over the largest cluster at 0.5 we expect about a third of the 297 nodes labelled instead of 1. The build measures it on the synthetic big map (`test/fixtures/big`) and writes the number into the test.
- **Rejected:** lowering the cut-off (still all or nothing per type); scaling labels with the map below 11 px (4 px text is noise); trying other positions round a node when the first collides (labels jump as you pan); one title per cluster only (fails "what is this cluster made of").

### D3. Search reads names, ids, files, types and kinds; not descriptions

- **Reads:** the label, the id, the file path, the type (as a word and as its layer's name: "service", "Services") and the finer kind (spec 0009). Case does not matter.
- **Ranks:** a label that starts with the term, then a word of the label that does, then the label containing it, then id or file, then type or kind.
- **Rejected:** descriptions. On the reviewed map a common word would match hundreds of nodes and bury the one named. (Open question 2.)

### D4. Search shows a count, a list by type, and steps through matches

- **The count** sits in the field: "3 of 33". With no match it says "No match", and the list says `No node matches "…". Search reads names, files, types and kinds.` Both are announced.
- **The list** opens under the field, up to 50 rows, grouped by type (the Layers name, with a count), in rank order. Each row: the label and its parent's label. Past 50: "and 12 more: type more to narrow". Matches in layers that are off come last, under "In layers that are off", and choosing one turns its layer on.
- **Stepping:** `Enter` and `Shift+Enter` in the field, `↓` and `↑` in the list, `N` and `P` on the map while a search is on. Each step selects the match and flies to it at zoom 1 or closer.
- **On the map:** every match keeps its halo (`--corn-map-match`) and wins a label (D2); what does not match dims to the focus dim. The list's first row, "Frame all 33", fits the camera to every match.
- **Rejected:** a separate results panel (one more surface; the list is enough at 50); fuzzy matching (a reviewer cannot predict why a node matched).

### D5. Selection lights one hop, by any edge kind

- **Lit:** the selected node, its parent, its children and every node one edge away, of any kind. The root then lights its clusters, not 694 nodes; a page or a service lights what it reads, writes and calls.
- **Through its children:** the node panel has a switch, "Include its children's lines", off by default. On, it lights today's set (the children's neighbours too). For an app this is the useful view of what its pages touch.
- **By edge kind:** the panel lists the lit lines by kind with counts ("Calls 12 · Reads 9 · Owns 4"); choosing a kind lights only that kind. Each list is capped at 12 rows, with "and N more" (`capped.js`).
- **Rejected:** a numeric cap on lit nodes (which 40 of 366 pages is arbitrary, and dimming costs nothing); keeping paths-through as the default (the hub case is the common click and it lights most of the map).

### D6. The camera follows a selection made elsewhere, never a click

- **A click or tap on the map** leaves the camera where it is: the reader pointed at the node. The panel says what is off screen: "27 connected · 9 off screen · Frame them". `F` does the same.
- **A selection from search, a list, a link or the keyboard** flies the camera to frame the node and its lit set, if that fits at zoom 0.5 or closer; otherwise it centres the node at zoom 1. It frames inside the part of the map no sheet covers (`state.coveredBottom`).
- **Rejected:** always framing on click (the map moves under the pointer and the next click misses); never moving (the finding).

### D7. Edge kinds: one meaning per line style, one end mark per family, words when lit

| Line | Means | End mark (at the target) |
|---|---|---|
| solid, thin | owns (parent to child) | none |
| dotted | uses loosely (today's dashed usage link) | none |
| **dashed** | **proposed, not built**, whatever its kind | the kind's own mark |
| solid | data: `flow`, `reads`, `writes` | open chevron `>` |
| solid | service: `calls`, `triggers`, `delivers` | filled triangle |
| solid | place: `runs-on` | a bar across the line |
| solid | tokens: `uses`, `extends` | open diamond |

- **The dash keeps one meaning.** A usage link becomes dotted. A cloud call's `when` becomes tick marks at the middle of the edge: one tick for "breaks at the next deploy", two for "at the next renewal". The legend's two "Dashed:" lines become one.
- **Lit edges say their kind.** With a selection, each lit edge carries its kind word at its middle ("reads", "calls"), placed by the label layer below node labels (D2), so words never collide. The direction of a chevron says read or write: towards the page is a read.
- **The legend** ("Key" in Layers) draws each row with the real line and mark, not a coloured dot.
- **Rejected:** nine distinct end marks (too fine at 9 px); themable dash patterns (a dash is a meaning, not a look); colour-blind-safe colours alone (they still fail in greyscale and on a projector).

### D8. Types: a silhouette per family, a glyph per type, and a minimum colour distance

- **Silhouettes:** circle for code (app, page, pkg, core, token, atom, molecule, tool, rom, service, root); rounded square for data (store, table); hexagon for outside (external); square for where things run (stack, machine, container, device, floor, room); diamond for people (persona). A shape reads at 6 px, where no glyph does.
- **Glyphs:** the white core dot becomes a small built-in monochrome glyph per type, drawn once the node is at least 14 px across on screen. It goes through the path `theme.icons` already uses in both renderers, so a theme's icon for a type replaces it. A node with a finer kind shows its kind instead (spec 0009).
- **Distance:** in the default palette, any two types that share a silhouette are at least **ΔE2000 15** apart on both grounds, and every fill is at least 3:1 on its ground (or the outline is on). A test holds the default palette to it; `validate` warns, without failing, when a theme's map colours break it.
- **Rejected:** a ring per type (rings are already the halos and the diff marks); letters per type (page, pkg and persona all start with p); colour changes alone (five pairs under 13 today, and a brand theme re-picks them).

### D9. The theme contract

- **Batch E adds** (the small fixes, as that batch names them): a map label font `--corn-map-font`, an edge width `--corn-map-edge-width` and a glow `--corn-map-glow`.
- **This spec adds:** `--corn-map-label-min` (default `11px`; a theme may raise it, and below `9px` it is ignored), and `--corn-map-glyph` (the glyph's colour; `auto` is today's white core).
- **Not tokens:** line styles and end marks (D7) and silhouettes (D8). They carry meaning.
- **Hooks:** `search-count`, `search-results`, `search-group`, `search-result`, `search-empty`; `legend-key`; `lines-by-kind` and `frame-button` in the node panel.
- **`strings`:** `frame` ("Frame them") and `throughChildren` ("Include its children's lines").

## Sketches

The first view at 1440 after D1: Fit shows the whole map, clusters packed round the core, titles at 13 px:

```
+-- cornfield  Map Flow House  Fit  Layers . 15 of 21  [Search...]  Work  (@) ---------+
|                    o.o.o       Billing       o.o.o.o.o        Admin                  |
|          Help     o.o(B)o.o    o.o.o.o.o    o.o.o(J)o.o.o     o(K)o                  |
|          o(C)o     o.o.o.o    o.o.o(D)o.o   o.o.o.o.o.o.o      o.o      Docs         |
|           o.o                  o.o.o.o.o      Jobs app                  o(L)o        |
|    Search      o.o.o.o.o.o                                o.o.o.o.o                  |
|    o(E)o     o.o.o.o.o.o.o.o     [ root ]   . data .     o.o.o(M)o.o.o    Ledger     |
|     o.o     o.o.o.o(A)o.o.o.o.o  . core .  . tables .    o.o.o.o.o.o     o(N)o       |
|              o.o.o.o.o.o.o.o.o                           o.o.o.o.o         o.o       |
|               o.o.o.o.o.o.o        Shop api                Cloud services            |
|     Mail         Storefront       o.o(F)o.o.o            o.o.o(H)o.o.o               |
|    o(G)o                          o.o.o.o.o              o.o.o.o.o.o        Tools    |
|     o.o      Accounts   Media       o.o.o                 o.o.o.o           o(P)o    |
|              o(Q)o     o(R)o                                                o.o      |
+--------------------------------------------------------------------------------------+
  largest cluster nearest the core; a click on a title frames that cluster
```

At 1440, a search with 33 matches, the second chosen:

```
+-- cornfield  Map Flow House  Fit  Layers . 15 of 21 -[ sync__________ 2 of 33  ^ v x ]- Work +
|                                                       +-----------------------------------+  |
|            [Orders app]                               | Frame all 33                      |  |
|          o  o  o  o  o                                | Pages (21)                        |  |
|        o   o sync/list  o                             |   /sync/status       Orders app   |  |
|       o  (@) /sync/status <- halo, selected           | > /sync/list         Orders app   |  |
|        o   o  o  o  o                                 |   ...                             |  |
|          o  o  o  o                                   | Services (9)                      |  |
|                                                       |   sync-worker        Jobs app     |  |
|   every label 11 px or more; none overlap             | In layers that are off (3)        |  |
|   unmatched nodes dimmed                              | and 3 more: type more to narrow   |  |
|                                                       +-----------------------------------+  |
+----------------------------------------------------------------------------------------------+
```

A selected service at 1440: one hop lit, kinds in words, the panel's lines by kind:

```
          [table: orders] ---reads--->  (#) /orders              | Service . sync-worker     x |
                 ^                           ^                    | Calls 3 . Reads 2 . Owns 1 |
              writes                       calls                  | [x] Include its children's |
                 |                           |                    |     lines                  |
      <hex: payments> <=calls== ( SEL ) ==triggers==> (svc)       | 9 connected . 3 off screen |
                                   :                              | [ Frame them ]             |
                     - - proposed calls - - >  (svc, new)         |                            |
```

At 390, search takes the header; the list covers at most half the screen:

```
+------------------------------------+
| <  sync________  2 of 33   ^ v  x  |
+------------------------------------+
| Frame all 33                       |
| Pages (21)                         |
|   /sync/status         Orders app  |
| > /sync/list           Orders app  |
| Services (9)                       |
|   sync-worker          Jobs app    |
+------------------------------------+
|   (map, the match centred at 1x)   |
+------------------------------------+
```

## Open questions for the maintainer

**Answered 2026-11-11:** the maintainer took every recommendation below.

1. **Pack the clusters by size** (D1), so Fit is 1.6 to 2.3 times as close and the single ring people know becomes a packed disc? Recommendation: **yes**.
2. **Should search read descriptions?** Recommendation: **no**. Names, ids, files, types and kinds; revisit if you miss it.
3. **11 px as the floor for labels**, a theme may raise but not lower it? Recommendation: **yes**.
4. **A click on the map never moves the camera**; a selection from search, a list or a link does? Recommendation: **yes**.
5. **One hop as the default focus**, with "Include its children's lines" as a switch? Recommendation: **yes**.
6. **Silhouettes in this spec** (they need shader work in the WebGL renderer), not a later one? Recommendation: **yes**, as the last build step.
7. **ΔE2000 15** between same-silhouette types: an error for the default palette, a warning for a theme? Recommendation: **yes**.

## What gets built, in order

1. **Layout** (`layout.js`): clusters packed by size, the title that frames its cluster, and a test of D1's targets on the fixture.
2. **Search** (`explorer/search-model.js`, pure; `explorer/search.js`): what it reads, the rank, the groups, the count, stepping, the no-match words, Frame all. Tests in Node.
3. **Labels** (`labels.js`, `scene.js`): the priority, the greedy placer, the 11 px floor, the hover and focus chip. A test on the big fixture: zero collisions at the fitted zoom, 0.25, 0.5, 1 and 2, every label 11 px or more, and the labelled count at 0.5.
4. **Selection** (`scene.js`, `panels.js`): one hop, the switch, lines by kind, Frame them and `F`, the camera rule.
5. **Edges** (`scene.js`, both renderers, `layers.js` Key): usage dotted, ticks for `when`, the end marks, kind words on lit edges, the legend.
6. **Types** (`core/schema.js`, `explorer/glyphs.js`, both renderers): the palette to ΔE 15, the built-in glyphs, the silhouettes, the `validate` warning.
7. **The contract**: tokens, hooks and `strings` keys in `docs/theming.md`, with their tests.

## What is not in this spec

- The pile of external nodes on one point ([#148](https://github.com/popcorn245/CornField/issues/148)) and the zoom floor and Fit ([#171](https://github.com/popcorn245/CornField/issues/171)): fixed in [#214](https://github.com/popcorn245/CornField/issues/214).
- The contrast of labels dimmed in the Diff view ([#172](https://github.com/popcorn245/CornField/issues/172), part): batch D. The no-match words alone ([#173](https://github.com/popcorn245/CornField/issues/173), part): batch B.
- Tapping speed and the Canvas 2D glow ([#178](https://github.com/popcorn245/CornField/issues/178)): batch B.
- Project layers and finer kinds ([#175](https://github.com/popcorn245/CornField/issues/175), [#150](https://github.com/popcorn245/CornField/issues/150)): spec 0009.

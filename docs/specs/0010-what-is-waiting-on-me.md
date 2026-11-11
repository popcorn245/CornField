# Spec 0010: what is waiting on me (the Specs list, waiting runs, and Work on a phone)

Status: **approved** (maintainer, in chat, 2026-11-11: "Approve all 5 go"), so it skips the map review gate ([ADR 0010](../adr/0010-cornfield-uses-its-own-gate.md)). Every open question is answered as recommended. **Built** (all seven steps, 2026-11-11); its proposal, `proposals/0010-what-is-waiting-on-me.json`, is deleted (`git log` keeps it).

Issues: [#182](https://github.com/popcorn245/CornField/issues/182) (F34, the surfacing part), [#184](https://github.com/popcorn245/CornField/issues/184) (F36), [#193](https://github.com/popcorn245/CornField/issues/193) (F45), from the 0.34 design review.

The maintainer's question, every time they open cornfield, is *what is waiting on me?* The review found it has no answer in one place:

- **Specs.** The list is sorted by number: 77 rows for 71 proposals. The six spec PRs, the only rows you can approve, sit among rows 66 to 76, from 6,250 px down a 7,308 px list (8.6 screens at 1440). No group, no search, no review state on a row (only Local, Open, Draft), and the status says "77 open specs" though 70 are drafts.
- **Runs.** A run in the `waiting` state asks the maintainer a question ("Plan ready: approve to build, or tell me what to change"). Nothing outside the Runs tab says so: the Work button has no badge, the tab says "4" (open runs, not "1 waiting"), the proposal it asks about shows nothing, and the panel always opens on Specs. Reaching Continue takes 3 clicks and a scroll.
- **The phone.** Opening Work during a review leaves a **90 px** strip of map (10.6% of 844), covered by the Layers chip, Fit and the hint. Work alone opens expanded (map 282 px, 33.4%); after one tap on its handle, 673 px (79.7%).

## The rule it answers to

> The topology map is the main view, with useful panels and minimal controls. ([vision.md](../vision.md))

So: **one number says what waits on you, it is the same everywhere, and it never costs you the map.** It counts only what asks for the maintainer's decision.

## Decisions

### D1. "Waiting on you" is one number: specs to decide plus runs waiting on an answer

- **A spec to decide:** a proposal on an open, ready (not draft) spec PR with no maintainer review at the file's current hash: never reviewed, or changed since the last review.
- **A run waiting:** an open run in the `waiting` state that nobody has asked to stop (`canAnswer` in `runs-model.js`).
- **Not counted:** drafts with no PR, a draft PR, a spec sent back and not pushed since (it waits on the agent), an approved spec, failed or quiet runs, pull requests, issues, threads. Each of those is visible in its tab; none asks you a question.
- Shown only to a signed-in maintainer.
- **Rejected:** open runs (4 open, 1 waiting: the number the review found misleading); failed runs (Start again is a choice, not a question); everything open (a number that never reaches 0 is ignored).

### D2. Where it shows

- **The Work button** carries the number as a filled badge, "Work 3", spoken "Work, 3 waiting on you". At 0 there is no badge. The browser tab's title starts "(3)" (open question 6).
- **The tabs:** Specs and Runs show their share as a filled badge ("Specs 2", "Runs 1"); with nothing waiting they show their plain total like the other tabs. One number per tab.
- **Work opens on the tab with the oldest thing waiting**, else the tab used last. A waiting run is found in 1 click.
- **The proposal bar:** when a run is waiting on the open proposal, one line under the buttons: "A run is waiting on you: Plan ready: approve to build, … · Answer". Answer opens Work on Runs at that run, its reply field focused.
- **The map:** the run's mark on its nodes takes the waiting look batch C gives it. Nothing more.
- **Freshness:** the runs part follows the runs poll (60 s). The specs part is read at load, when Work opens, after Approve or Send back, and at most every 5 minutes, from the listing the server already keeps by PR head.
- **Rejected:** a separate inbox panel (Specs and Runs already are the inbox once sorted); push notifications in the browser (hooks already reach a chat: `spec.ready`, `run.state`).

### D3. The Specs list: grouped by who must act, one row per proposal

| Group | Holds | Order |
|---|---|---|
| **To decide** | D1's specs to decide | waiting longest first |
| **With the agent** | sent back and not pushed since; draft PRs | newest activity first |
| **Approved** | approved at the current hash, PR still open | newest first |
| **Drafts** | in the checkout or a worktree, no PR | by number; collapsed past 10 rows |

- **One row per proposal.** A PR's proposal wins over its local copy, which becomes a line in the row: "also in the checkout". Batch C does the de-duplication and the count; this spec keeps it.
- Empty groups are not shown. A landed proposal is deleted, so it never appears.
- **Rejected:** sorting by number (the finding); a flat list with a filter (the reader must know to use it); a Stale group (age is a fact on the row, not a decision for you).

### D4. Each row says its review state, by whom and when

- **The pill:** To decide · Changed since approved · Sent back · Approved · Draft PR · Local. Then the words: "Approved by maintainer-one · 2 h ago", "Sent back by maintainer-one · yesterday", "Waiting 2 days".
- **Where it comes from:** the server's listing carries `review: { verdict, by, at, current }` for each PR's proposal, read as the bar reads it (the latest maintainer comment) and kept by PR head, as the listing already is.
- **A failed read is said:** "Review state unknown · Try again", never a row that looks unreviewed (the lesson of [#154](https://github.com/popcorn245/CornField/issues/154)).
- **Rejected:** a tick or a cross with no words (fails without colour, and says nothing of whom); reading each PR's comments from the browser (one request per row).

### D5. One search field on Specs

A field above the list filters titles, slugs and summaries as you type; each group's header then says "2 of 6". The Filter chip stays off on Specs: the groups do its work. **Rejected:** facet filters by state (the groups are the states).

### D6. Run states: needs you, in motion, finished

- **Needs you:** `waiting`, not asked to stop. **In motion:** `requested`, `claimed`, `working`, `stop-requested`. **Finished:** `done`, `failed`, `stopped`, and `quiet` (it no longer counts as open; a report or a push brings it back to In motion).
- **The Runs list** is in that order: Needs you (oldest question first), In motion (newest first), Finished (newest first). Two runs of one request under two profiles stay together, in the group of the more urgent one.
- How each state looks without colour is batch C's (a glyph and a word per state). This spec only settles the groups and the order.
- **Rejected:** `failed` under Needs you (D1); `quiet` under In motion (it is not counted as open, so the group would lie).

### D7. Sheets on a phone: two at most, one expanded, the map keeps 35%

- **At most two sheets:** the review (the proposal bar or the scenario player) and one other (Work or the node panel). Opening Work closes the node sheet and the reverse; the node stays selected, and tapping it opens its sheet again.
- **Every sheet opens at peek.** Only a deep link opens one expanded, as now.
- **One expanded at a time.** Expanding one folds the other to a **stub**: one 44 px row with its title and its badge. Tapping the stub swaps them.
- **The map keeps at least 35% of the screen** (296 px at 844) in every state: an expanded sheet's height is capped to keep it. Review peek and Work peek leave 481 px (57%); Work expanded with the review as a stub leaves 296 px, against 90 px today.
- **The hint hides** while any sheet is expanded; Layers and Fit stay, in their one row.
- **The selected node stays in the 35%.** Today the backdrop of an expanded sheet blurs and dims the map, the selected node with it; that stays open as [#180](https://github.com/popcorn245/CornField/issues/180), and its fix must keep the node sharp and in the part of the map left showing.
- **Getting back:** tap the map or the handle to fold the expanded sheet to peek; ✕ closes a sheet; `Escape` folds, then closes.
- **Rejected:** Work as a full-screen page (it hides the map the review is about); three sheets at once (proposal and node already leave 60.4%, Work on top 10.6%); Work opening expanded (the 33.4% the review measured).

### D8. The theme contract

- **Hooks:** `waiting-badge` (on the Work button and the tabs), `spec-group`, `review-state` (the row's pill), `specs-search`, `run-group`, `waiting-line` (in the proposal bar), `sheet-stub`. A sheet's `data-sheet-state` gains `stub`.
- **States:** a spec to decide and a changed one are `waiting`; approved is `success`; this spec adds **`sent-back`**. (Batch E gives Local its own state.)
- **`strings`:** `waitingOnYou` ("waiting on you"), `toDecide` ("To decide"), `withAgent` ("With the agent"), `approvedGroup` ("Approved"), `drafts` ("Drafts"), `needsYou` ("Needs you"), `inMotion` ("In motion"), `finished` ("Finished"), `answer` ("Answer").

## Sketches

At 1440, signed in, two specs to decide and one run waiting:

```
+-- cornfield  Map Flow House  Fit  Layers . 15 of 21  [Search...]  [Work (3)]  (@) ----+
|                                    +-- Work ---------------------------- Refresh  x  -+
|                                    | [Specs (2)] PRs 9  Issues 4  Threads 2  Runs (1) |
|                                    | [ Find a spec_________________ ]                 |
|                                    | To decide . 2                                    |
|                                    |  0042 Retire the old export      [To decide]     |
|                                    |    Spec PR #31 . +1 ~3 -2 . waiting 2 days       |
|                                    |  0047 A second sign-in   [Changed since approved]|
|                                    |    Spec PR #35 . approved by maintainer-one, 3 d |
|                                    | With the agent . 1                               |
|                                    |  0045 Shared button       [Sent back]            |
|                                    |    by maintainer-one . yesterday                 |
|                                    | Approved . 1                                     |
|                                    |  0044 Faster import       [Approved] . 2 h ago   |
|                                    | > Drafts . 65                                    |
|                                    +--------------------------------------------------+
```

At 390, during a review: (A) both at peek, (B) Work expanded, (C) the review expanded:

```
  (A) peek + peek            (B) Work expanded          (C) review expanded
+--------------------------+ +--------------------------+ +--------------------------+
| cornfield  [Work 3]  (@) | | cornfield  [Work 3]  (@) | | cornfield  [Work 3]  (@) |
| [Layers]           [Fit] | | [Layers]           [Fit] | | [Layers]           [Fit] |
|                          | |                          | |                          |
|                          | |     map 296 px (35%)     | |     map 296 px (35%)     |
|     map 481 px (57%)     | |                          | |                          |
|                          | +--------------------------+ +--------------------------+
|                          | | 0042 Retire the  [stub]  | | == 0042 Retire the old   |
|                          | +--------------------------+ |    export                |
+--------------------------+ | == Work            x     | | +1 ~3 -2 . 2 scenarios   |
| == 0042 Retire the old   | | [Specs 2] PRs  [Runs 1]  | | Before  Diff  After      |
|    export                | | Needs you . 1            | | Play  Edit               |
| +1 ~3 -2 . 2 scenarios   | |  Plan ready: approve to  | | A run is waiting on you  |
| [Send back]  [Approve]   | |  build, or say what to   | |   . Answer               |
+--------------------------+ |  change.  [Continue]     | | [Send back]  [Approve]   |
| == Work: 2 to decide,    | |  [ Reply ______ ] [Stop] | +--------------------------+
|    1 run waiting         | | In motion . 3            | | Work: 3 waiting   [stub] |
+--------------------------+ +--------------------------+ +--------------------------+
```

## Open questions for the maintainer

**Answered 2026-11-11:** the maintainer took every recommendation below.

1. **The number counts specs to decide and runs waiting, nothing else** (not failed runs, not drafts)? Recommendation: **yes**.
2. **A spec you sent back leaves your count** until the agent pushes again? Recommendation: **yes**.
3. **Work opens on the tab with the oldest thing waiting**, not always on Specs? Recommendation: **yes**.
4. **On a phone, two sheets at most and the map keeps 35%**? Recommendation: **yes**.
5. **Drafts collapsed past 10 rows**? Recommendation: **yes**.
6. **The browser tab's title carries the number**, "(3) cornfield", so it shows from another tab? Recommendation: **yes**, it is one line.

## What gets built, in order

1. **The model** (`explorer/waiting-model.js`, pure): which specs are to decide, which runs need you, the number, the Specs groups and the run groups. Tests in Node.
2. **The server:** review state on the proposals listing (`server/proposal-pulls.js` with `server/reviews.js`), kept by PR head.
3. **Specs:** the groups, each row's review state, the search field, the tab's badge.
4. **Runs:** the groups and their order, the tab's badge.
5. **Everywhere else:** the Work button's badge, opening on the oldest, the proposal bar's line, the tab title.
6. **The phone:** two sheets at most, the stub, the 35% floor, the hint (`sheet-model.js`, `sheets.js`), with a test on the model.
7. **The contract:** hooks, the `sent-back` state and the `strings` keys in `docs/theming.md`, with their tests.

## What is not in this spec

- How each run state looks without colour, the reply garbled by a refresh, and the double listing and its count ([#182](https://github.com/popcorn245/CornField/issues/182) part, [#153](https://github.com/popcorn245/CornField/issues/153), [#184](https://github.com/popcorn245/CornField/issues/184) part): batch C.
- "No runner online" and what Approve says first ([#183](https://github.com/popcorn245/CornField/issues/183), [#152](https://github.com/popcorn245/CornField/issues/152)): spec 0007.
- Notifications outside cornfield: the hooks already carry `spec.ready` and `run.state`.
- The map's labels, search and layers: [spec 0008](0008-reading-a-big-map.md) and [spec 0009](0009-project-layers-and-finer-kinds.md).

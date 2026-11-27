# Spec 0015: A quieter Work view (code grouped, one panel, the action first)

Status: **approved** (maintainer, in chat, 2026-11-27, on the mock: "Let's do A first"), so it skips the map review gate ([ADR 0010](../adr/0010-cornfield-uses-its-own-gate.md)). Of the three directions put with the mock (A, trim and fold; B, the Work view as an inbox; C, one context panel for every view), A is this spec. B is being mocked separately and is not decided. Its proposal is [proposals/0015-a-quieter-work-view.json](proposals/0015-a-quieter-work-view.json), with its mockups in [proposals/0015-a-quieter-work-view/](proposals/0015-a-quieter-work-view/).

## What the maintainer asked for

> Next work should be reworking the workflow a bit. The work view is very clunky and interface is starting to feel cluttered. What can we do to address that in the next release

## What stands in the way today

Read on v0.62, on the big fixture with the fake forge (`test/fixtures/big/serve.js --forge`) at 1440 × 900, and on cornfield's own repo with `history: true`. The stills are `before-*.webp` beside the proposal.

1. **The code column is always on, and always wired.** 44 code nodes take 44 % of the Work view's width, and every `changes` and `adds` line is drawn before anything is picked. The lanes, the point of the view, sit behind a net of lines.
2. **Every spec is there twice.** 7 of Talk's 9 nodes are the conversation of a spec pull request whose proposal is already in Decide ("Thread #21 · Spec: A new…").
3. **Three panels share one screen.** The Work list (400 px, left) and the node panel (480 px, right) leave the map about 560 px. The list's spec cards say again what the node panel says.
4. **The action is at the foot of the node panel.** A proposal's panel lists its ten connections, then Review, around 690 px down. A Land it that cannot land yet is followed by two paragraphs saying why.
5. **"Waiting on you" is said four times:** the Work badge, the Waiting on you chip with its count, the list's tab badges, and a Waiting on you pill in the node panel.
6. **Three rows of controls over the map:** the header; the Work view's row of All work, Waiting on you and List; and the hint "Click a node to see what it is", which never leaves.
7. **History is in three places:** Replay in the header, History in the Layers menu, and its section in the node panel, where a code node can carry a paragraph of eighty issue links. The Layers menu lists every legend whether its layer is on or not, under the title "Section Toggles".
8. **Small things:** Enter in the search selects the node and leaves the results open over its panel.

## Decisions

### D1. The code a piece of work touches is grouped, and its lines are drawn for the selection only

- In the Work view the code column holds **one node per area**: the app or package under the root that holds the code (the area of `core/release-notes.js`), labelled with its name and how many of its nodes work touches ("api-catalog · 6"). A proposal's planned nodes are grouped under the area they would join, drawn as planned (dashed) while every node in the group is planned.
- Selecting an area **opens it in place**: its nodes are laid out under it, as today's column does, and the rest of the areas stay closed. Selecting it again, or Escape, closes it. Search and an address that names a code node open its area.
- The **lines from work to code** (`changes`, `adds`, `mentions`, `restarts`) are drawn only for the selected node and the node under the pointer (or the keyboard's). With nothing selected the map shows the lanes and the lines between work only. A line to a closed area ends at the area.
- The Layers menu's "Code they touch" row and its count are unchanged; turned off, the code column is gone as it is today.

### D2. A spec pull request's conversation folds into its proposal

- A `thread` whose only link to the work is `discusses` or `became` a proposal on a spec pull request is **not drawn as a node**. Its proposal carries a small count of the conversations folded into it, and the node panel lists them under Connected ("Discussed in Thread #21 · 4 comments").
- Choosing that row shows the thread in the node panel, with Reply and Open on the forge as today; the proposal stays selected on the map. `?thread=<n>` does the same.
- A thread that points at code, or at an issue, or at nothing on the map, stays in Talk. The Work list's Threads tab still lists every thread.
- The Threads row of the Layers menu counts only the threads drawn.

### D3. One side panel at a time

- The **Work list moves to the right**, into the node panel's place, and the two take turns: List opens the list; a row opens its detail in the same panel, with **Back** to the list (Escape too). Closing the panel closes both.
- Opening the list while a node is selected keeps the selection; the list scrolls to and marks its row.
- On a phone nothing changes: the list and the node panel are already two sheets that take turns (spec 0010 D7).
- The list's spec cards keep their title, their state and who must act; the summary, the counts and the scenario count are the node panel's.

### D4. The node panel leads with its action

For every node the panel shows, in this order:

1. The kind, the title, one state pill and one line of facts (who, when, the number).
2. **An action bar**, kept in view while the panel scrolls: the node's one next action as the primary button (Review for a proposal waiting on you, Land it for a green pull request, Continue for a run waiting on an answer, Reply for a thread), the next one or two beside it, and the rest under **⋯**. What it is today; only the order changes.
3. **One "Next" line** under the bar, when an action cannot be taken yet: "Then: approve, and Land it once docs finishes (1 check running)." It replaces the paragraphs. A failed check's Re-run stays in Checks.
4. **Sections, each with its count, closed unless they hold the action**: Connected, Checks, Files, Scenarios, History, Build issue. A section's open or closed is remembered per kind of node, in the browser.
- **Connected** groups its rows by relation: a group of one shows its row ("Agent on it Run 000003 · working"); a bigger one shows its count and opens ("Adds 5 planned nodes").
- **History** on any node shows its last five commits, and its specs and issues as counts that open, never all at once.
- The "Waiting on you" pill goes from the panel: the state pill and the action say it.

### D5. Each view's own controls sit in the header

- The header holds, after the View switch, **the controls of the view that is on**: on the Map, Replay (when the config has history on); in the Work view, Waiting on you and List. The second row of the Work view is gone. All work is not a button: Waiting on you is a toggle, off is all the work.
- Waiting on you is said by the Work badge and by the toggle when it is on. The list's tab badges stay (they say which tab).
- The hint "Click a node to see what it is" leaves after the first node is selected, and does not come back in that browser.
- On a phone the view's controls sit where the Layers chip is, on the map's top-left row, as today.

### D6. Layers: History holds Replay, legends follow their layer

- **Replay moves into the Layers menu**, as a button on the History row ("History · Replay"). Pressed, it turns the History layer on and opens the timeline as today. The header's Replay button goes (D5 puts a view's controls in the header; Replay is the History layer's, so it lives with it).
- A legend (Agent runs, History, Proposal marks) is shown in the menu **only while its layer is on**.
- The menu's title is **Layers**.

### D7. Small fixes

- Enter in the search, or a click on a result, closes the results.
- The lanes' names use the width the code column gives back: a name is cut at 32 characters, not 22.

## What a host app gets

Nothing new. `<corn-map view="work">` draws the grouped code, and `<corn-node-panel>` the new order; a host that styled the node panel's sections keeps its hooks (`section`, `row`, `more`), and the action bar is a new hook, `actions`, documented in [theming](../theming.md).

## What gets built, in order

One pull request with a commit per step; cornfield's page keeps working after each.

1. **The canvas** (D1, D2, D7's lane names): grouping in `explorer/work-model.js`, the lines for the selection in `explorer/work-view.js`, the folded threads.
2. **The panels** (D3, D4): the Work list in the right slot with Back, and the node panel's order, action bar and sections.
3. **The chrome** (D5, D6, D7's search): the header's view controls, Replay in the Layers menu, the legends, the hint, the search.

## What is not in this spec

- The Work view as an inbox (direction B). It is being mocked; it would be its own spec.
- One context panel for every view (direction C).
- Any change to the server's work graph: the grouping and the folding are the page's.

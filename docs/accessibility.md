# Keyboard and screen readers

Everything the pointer does on the map has a key, and a screen reader is told where the keyboard landed. This page lists the keys, walks through the explorer by keyboard alone, and says how it is checked.

## The keys

Tab reaches the map after the header's controls. Its outline shows it has the focus; a screen reader reads its name ("Topology map") and the keys below.

| Keys, on the map | What they do |
|---|---|
| Arrow keys | pan the map (with Shift, further) |
| `+` and `-` | zoom in and out, about the middle |
| `0` | fit the map to the screen |
| `N` or `]` | select the next node |
| `P` or `[` | select the previous node |
| `Home` and `End` | select the first and the last node |
| `F` | with a node selected, frame it and what it lights (the same as "Frame them" in its panel); a click on the map never moves the camera, a selection from search, a list, a link or the keyboard does |
| `Enter` | go to the selected node's panel |
| `Escape` | close the panel |
| `Alt` and an arrow | in Freeform, move the selected node (with Shift, further) |

The nodes are stepped through as the map reads: in rows from the top, each row from the left, over the nodes the current view and layers show. Each step selects the node (its neighbourhood lights up, its panel opens), puts it in the middle of what is not covered by the panel, and says, for example, "orders, table, 5 connections, 23 of 38".

Elsewhere:

| Where | Keys |
|---|---|
| The search box | it reads names, ids, files, types and kinds. What it found is said ("33 matches", or "No match for …"), and shown as a count in the field and a list under it, grouped by type. `Enter` selects the best match and flies to it, `Enter` again the next, `Shift+Enter` the one before; `↓` goes into the list (`↑` and `↓` move through it, `Enter` chooses, `Escape` goes back to the field), and its first row, "Frame all", fits every match on the screen. With a search on, `N` and `P` on the map step through its matches. `Escape` closes the list, and again clears the search. Each step says "3 of 33: /sync/list, in Orders app" |
| The node's panel | `Escape` closes it and gives the focus back to the map. A selection lights the node and what is one edge from it; its panel lists the lit lines by kind (a chip per kind lights that kind alone, and says how many lines) and has "Include its children's lines" for the wider set; each change is announced, and the focus stays on the control used |
| The Layers and Proposals menus | `Escape` closes them, back on their button |
| The Threads tab of that panel | a button in the panel's Show group; each thread is a row button that opens it, and a thread's messages are an ordered list named "Messages" with nothing to type into (replying is a link to the forge). **New idea** is a button that says it expands a labelled group (title, text, Open the idea, Cancel); its answer is a live status. A node's "Mentioned in" lists buttons that open the thread ([threads.md](threads.md)) |
| The Runs tab of that panel | a button in the panel's Show group; the groups are headings, the two switches are checkboxes, and the "Agent" mark has its reason in words ([agents.md](agents.md)) |
| The runs, on the Runs tab | each run has buttons: **Stop**, **Light on the map** (a toggle, pressed when lit) and **Timeline** (expanded or not); the timeline is a list named for its run, oldest first; two profiles of one request are a labelled group; a change of state or a collision is said through the live region ([agents.md](agents.md#runs-on-the-map)) |
| The Work toggle and panel | `Enter` opens the panel with the focus on its title, `Escape` closes it, back on the toggle; the tabs are buttons in a group, the one shown pressed; a selection replaces the list and takes the focus to its back control, which gives it back to the row; what it loaded, selected and lit, deploys included, is said; its Release notes (an action at the foot of the PRs list) have a read-only draft you can focus and select, Copy, and a confirm step that takes the focus and gives it back ([issues-and-prs.md](issues-and-prs.md), [deploys.md](deploys.md)) |
| A mockup of a proposal | `Enter` on its button in the node's panel opens it in a window that takes the focus and is announced (its title, and where it stands with the review); `Tab` stays inside, `Escape` or Close shuts it and the focus goes back to the button. A picture's alt text is its title. |
| The scenario player | `Space` plays and pauses, `Left` and `Right` step (the map leaves those keys to it while a scenario plays) |
| A dialog (Review tokens, Start an agent, the confirm step, a mockup) | `Tab` and `Shift+Tab` go round every control in it, selects, text areas, links and scrollable regions included (one list, [explorer/focusables.js](../explorer/focusables.js), is what every trap asks), and `Escape` leaves it |
| A proposal's what-if edits | `Ctrl+Z` undoes, `Ctrl+Shift+Z` or `Ctrl+Y` redoes, `Escape` backs out of a form or a drawing |

Drawing an edge in a what-if edit is a drag on the map. Without one: turn on Edit in the proposal toolbar, select the first node, then in its panel under "Try a change" pick the other end from "Edge to" and press "Draw an edge". The same form opens as at the end of a drag, with the focus on it.

## What is said, and when

The map's one polite live region says what the eyes would see change, once each and never on a background refresh: when a proposal has loaded, its title and what it holds ("Opened Meals: 4 changes, 3 scenarios for 2 personas."); the view on a switch ("After view"); a change row's node ("page-old, removed. The map is on it."); an undo or a redo and what it was ("Undid: Added the page “/one” under tasks"); and "Paused", "Resumed" or "Playing" for the scenario player (each step is said as it comes, as the list words it: "Step 2 of 3, as Adult: checkout page, Added. You pay. Allowed.").

## Colour, shape and size

- A proposal's four marks differ without colour: added is a dashed ring, changed a solid ring, removed a faded ring with its label struck through, and your own what-if edit a dotted ring. A line keeps the same rule: added is dashed, removed short-dashed and struck across, a what-if edit long-dashed; a usage link is dotted, so a dot is never a change. The legend ("Proposal marks") says so, and so do the dots in the bar and the change list.
- Every mark is 3:1 against the darkest and lightest ground the map draws, in light and dark, at the opacity it is drawn at; a label a diff dims is 3:1 as well (`cornfield validate` holds both for any theme).
- On a phone, or a coarse pointer, every control is 44 by 44 (the drawn size may be smaller: the hit area counts), and a change row is 28px tall at a desk. The counts say what they count ("4 nodes, 2 edges added").

## A walkthrough

The sample repo (`node cli/cornfield.js serve --repo test/fixtures/sample --port 3351`), keyboard only:

1. `Tab` goes through the header in order: reset the view, Map, Flow, House, Fit, Layers, the live chip (when a live layer is on), search, the Work toggle (with a forge), the account menu, then the map. `/` goes to the search from anywhere but a field. The account menu is a disclosure: `Enter` opens it (its button says it is expanded), `Tab` goes through Theme (System, Dark, Light, each with `aria-pressed`), Freeform layout (a switch), Review tokens, Proposals (only without the Work panel: with it, its Specs tab lists them), the links and Sign out; `Escape` closes it, back on the button, and a `Tab` out of it closes it too. Zoom has no buttons: `+` and `-` zoom, a pinch or the wheel too, and Fit is in the View switch.
2. On the map, `→` pans, `+` zooms in ("Zoom 47 percent"), `0` fits ("The whole map. Zoom 37 percent").
3. `N` selects the first node: "CI workflows, tool, 3 connections, 1 of 38". `N` again: "cloud.example.test, app, 2 connections, 2 of 38". `P` goes back; `End` goes to the last, "@acme/shared, pkg, 3 connections, 38 of 38".
4. `Enter` moves the focus to the panel's title, so a screen reader reads the panel from its start; `Tab` goes on to its close button, its links and buttons.
5. `Escape` closes the panel ("Panel closed") and the focus is on the map again.
6. In the search box, typing `orders` says "21 matches"; `Enter` selects the best one and says "1 of 21: order-summary, in @big/ui"; `↓` goes into the list, whose first row is "Frame all 21".
7. On Layers ("Layers · 13 of 20"), `Enter` opens the menu (its button says it is expanded); `Tab` goes through the layer toggles; `Escape` closes it, back on the button.
8. With a proposal open (`/?proposal=0002-checkout`), the whole review is there without the canvas, in this order. The proposal's title is an `h2` in the "Open proposal" region, and opening says "Opened Checkout: 6 changes, 3 scenarios for 2 personas." (one polite line). `Tab` reaches the source chip, the counts (each part takes you to its list), Before / Diff / After, Edit and the ⋯ menu; then the review column: **Changes, 6** (an `h3`, then a list: each change is a button, "Added checkout page, page", that selects it on the map), **Personas and scenarios, 3** (an `h3`; each persona an `h4`, "Adult, 1 scenario", with its scenarios; a scenario is a button with `aria-expanded` that opens an ordered list of its steps), the line that names the personas no scenario uses, and last the **Decision** group: Send back and Approve. Heading navigation reaches the title, each list and each persona in one key. A step is a button named as one sentence, "Step 2 of 3, as Adult: checkout page, Added. You pay. Allowed."; choosing it opens the player paused on that step, says the same sentence once, and keeps the focus on the step; `Escape` in the player closes it and puts the focus on the step it was on. Send back opens the note and moves focus to it; `Tab` from the note reaches Cancel, then "Send back with this note"; Cancel (or `Escape`) closes it and returns focus to Send back. The ⋯ menu is a menu button: it opens on `Enter`, `Space` or the arrow keys, the arrows move through it, and `Escape` closes it back to the button. On a phone the review column is the proposal sheet's body, with a two-part switch (`Changes | Scenarios`, a tab list: the arrow keys move between the tabs), and every control is at least 44px tall. A scenario's verdicts are words ("Allowed", "Refused: …", "Not checked: …"), never a colour alone. What a reviewer has opened or played is remembered in the browser as a tick; it is information, never required, and not part of the review.

9. With a forge in the config, `Tab` reaches the "Work" toggle after the search. `Enter` opens its panel on Specs (the title has the focus; "Work" is said, then "2 specs shown"). `Tab` goes through the tabs, Specs, PRs, Issues, Threads, Runs and Deploys (buttons in a group, the one shown pressed), the Filter chip (`Enter` shows the state, label and author lists and the search behind it), then each row. On PRs, `Enter` on a pull request selects it: its detail replaces the list, the focus is on its back control ("All pull requests"), and "Pull request 12, Meals page: 3 files, 2 on the map, 2 nodes lit. 1 check passed." is said. The back control returns to the list with the focus on the row. Its files follow, each node a button that selects it on the map. `Escape` closes the panel, back on the button. In a selected pull request, `Tab` reaches Re-run on a failed check and Land it. `Enter` on Land it opens a dialog: the focus is on Cancel, `Tab` moves between Cancel and Land it and cannot leave, `Escape` or Cancel closes it with the focus back on Land it, and what will land (pull request, commit, where it goes, each check) is read out. The pipeline's steps use the same dialog: in the Issues list an open issue has Start a spec, and a selected spec pull request with an approved proposal has Open the build issue; each reads the plan first ("Looking at what a spec for issue 7 would make"), then the dialog reads out what will be made, with the file and the description in boxes that `Tab` reaches and the arrows scroll, and Start the spec or Open the issue confirms. A step done before is not asked again: it says so. What an action came to is said through the live region.

While closed, the node panel and the issues and PRs panel wait off screen; they are `inert` then, so `Tab` never lands on their buttons out of sight.

## How it is checked

- **In the test suite** ([test/explorer/a11y.test.js](../test/explorer/a11y.test.js)): [axe-core](https://github.com/dequelabs/axe-core) runs over the page's own markup and stylesheets in each state (the map, the Layers menu, a node's panel, a proposal open with what-if editing, the scenario player, the issues and PRs panel with a pull request selected, a proposal's mockups in the panel and open in their window, in both themes) for WCAG 2.2 A and AA and axe's best practices, and finds nothing. The keys above are tested there too. The test runs on happy-dom, which has no layout, so colour contrast is checked in a browser instead (next point).
- **In a browser**: the same axe rules, colour contrast included, in Chromium over the sample repo, in twelve states: the map, the Layers and Proposals menus, a node's panel, a phone with and without the panel, a proposal open, the scenario player, the data-flow view and the House view, and the issues and PRs panel open and with a pull request selected (on a desktop and on a phone), each in the dark and the light theme. No violations.

What axe cannot judge, and was looked at by hand: the reading order of the steps, the words said, and that every pointer action has a key. A pass with a real screen reader (NVDA, VoiceOver) is welcome: open an issue with what it reads badly.

## Limits

- The map itself is a picture: a screen reader learns about a node by stepping to it, not by exploring the canvas. The node's panel holds what the picture shows about it (its type, connections, what reads and writes it, a proposal's changes).
- A node's colour says its type, but its panel says it in words; a proposal's marks are a colour and a shape (a dashed ring for added, a strike for removed), and the counts chip lists them in words.

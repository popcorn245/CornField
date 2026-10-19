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
| `Enter` | go to the selected node's panel |
| `Escape` | close the panel |
| `Alt` and an arrow | in Freeform, move the selected node (with Shift, further) |

The nodes are stepped through as the map reads: in rows from the top, each row from the left, over the nodes the current view and layers show. Each step selects the node (its neighbourhood lights up, its panel opens), puts it in the middle of what is not covered by the panel, and says, for example, "orders, table, 5 connections, 23 of 38".

Elsewhere:

| Where | Keys |
|---|---|
| The search box | `Enter` selects the first node whose name matches; no match is said |
| The node's panel | `Escape` closes it and gives the focus back to the map |
| The Layers and Proposals menus | `Escape` closes them, back on their button |
| The scenario player | `Space` plays and pauses, `Left` and `Right` step (the map leaves those keys to it while a scenario plays) |
| A proposal's what-if edits | `Ctrl+Z` undoes, `Ctrl+Shift+Z` or `Ctrl+Y` redoes, `Escape` backs out of a form or a drawing |

Drawing an edge in a what-if edit is a drag on the map. Without one: select the first node, then in its panel under "Try a change" pick the other end from "Edge to" and press "Draw an edge". The same form opens as at the end of a drag, with the focus on it.

## A walkthrough

The sample repo (`node cli/cornfield.js serve --repo test/fixtures/sample --port 3351`), keyboard only:

1. `Tab` goes through the header in order: reset the view, Layers, Data flow, House, Proposals, search, Orbit, the zoom buttons, the theme toggle (system, light, dark; its name says which is on), then the map.
2. On the map, `→` pans, `+` zooms in ("Zoom 47 percent"), `0` fits ("The whole map. Zoom 37 percent").
3. `N` selects the first node: "CI workflows, tool, 3 connections, 1 of 38". `N` again: "cloud.example.test, app, 2 connections, 2 of 38". `P` goes back; `End` goes to the last, "@acme/shared, pkg, 3 connections, 38 of 38".
4. `Enter` moves the focus to the panel's title, so a screen reader reads the panel from its start; `Tab` goes on to its close button, its links and buttons.
5. `Escape` closes the panel ("Panel closed") and the focus is on the map again.
6. In the search box, typing `orders` and `Enter` selects "/api/v1/orders, page, 4 connections, 23 of 38".
7. On Layers, `Enter` opens the menu (its button says it is expanded); `Tab` goes through the layer toggles; `Escape` closes it, back on the button.
8. With a proposal open (`/?proposal=0002-checkout`), `Tab` reaches Before / Diff / After, the counts chip and its list of changes (each one takes the map to that change), the scenarios, the what-if controls, the note and Approve / Send back. A scenario's player reads each step as it comes (a polite live region).

While closed, the node panel waits off screen; it is `inert` then, so `Tab` never lands on its buttons out of sight.

## How it is checked

- **In the test suite** ([test/explorer/a11y.test.js](../test/explorer/a11y.test.js)): [axe-core](https://github.com/dequelabs/axe-core) runs over the page's own markup and stylesheets in each state (the map, the Layers menu, a node's panel, a proposal open with what-if editing, the scenario player) for WCAG 2.2 A and AA and axe's best practices, and finds nothing. The keys above are tested there too. The test runs on happy-dom, which has no layout, so colour contrast is checked in a browser instead (next point).
- **In a browser**: the same axe rules, colour contrast included, in Chromium over the sample repo, in ten states: the map, the Layers and Proposals menus, a node's panel, a phone with and without the panel, a proposal open, the scenario player, the data-flow view and the House view, each in the dark and the light theme. No violations.

What axe cannot judge, and was looked at by hand: the reading order of the steps, the words said, and that every pointer action has a key. A pass with a real screen reader (NVDA, VoiceOver) is welcome: open an issue with what it reads badly.

## Limits

- The map itself is a picture: a screen reader learns about a node by stepping to it, not by exploring the canvas. The node's panel holds what the picture shows about it (its type, connections, what reads and writes it, a proposal's changes).
- A node's colour says its type, but its panel says it in words; a proposal's marks are a colour and a shape (a dashed ring for added, a strike for removed), and the counts chip lists them in words.

# Spec 0016: The Work inbox (Work opens on what needs you; the lane map becomes Graph)

Status: **approved** (maintainer, in chat, 2026-11-27, on the mock: "Kk mock is fine, let's go with it"), so it skips the map review gate ([ADR 0010](../adr/0010-cornfield-uses-its-own-gate.md)). The four questions put with the mock are answered as recommended (below). It builds on [spec 0015](0015-a-quieter-work-view.md) (a quieter Work view) and changes [spec 0012](0012-work-as-a-view.md) in one place: what the Work view opens on. Its proposal is [proposals/0016-work-inbox.json](proposals/0016-work-inbox.json), with four stills in [proposals/0016-work-inbox/](proposals/0016-work-inbox/). The stills come from an explorable mock beside them (`explore.html`, self-contained) on two sets of data: the review rig's work graph as the real server answers it against the fake forge (`test/fixtures/big/serve.js --forge`), and cornfield's own open work on 2026-11-27.

## What the maintainer asked for

Direction B of the Work view review ("A quieter Work view", 2026-11-26): *Work opens on a queue of your next actions (approve, land, answer a run). The lane map becomes a secondary "Graph" toggle.* The maintainer: "love this inbox idea", then, on the mock, "let's go with it".

## What stands in the way today

- **The Work view answers "how does the work relate?", not "what do I do next?"** Spec 0010 asked the second question and answered it with one number. Spec 0012 moved that number onto the Work button, but what it counts is spread over four lanes among 20-odd other nodes. Even with spec 0015's dimming, the reader still has to find the bright ones, open each, and read its panel to learn the action.
- **Things that need you but are not "waiting on you" have no place.** A pull request with a failed check, a run that failed, a run that finished with a pull request ready, an approved spec PR not yet landed, an issue nobody is on: each is visible in its lane or its Work list tab. None is surfaced, and spec 0010 D1 rightly keeps them out of the number.
- **The Work list (spec 0012 D6) is sorted by kind**, so the next action is still one tab and one scroll away.

## What the mock shows

On the rig at 1440×900: four things wait on you (specs 0013, 0100 and 0104, and run 000003, which is asking about spec 0100) in three rows. Four more are your move: PR #13 (lint failed), run 000005 (failed), run 000004 (done, PR #14 ready) and spec 0102 (approved, not landed). Issue #3 has nobody on it. Eight things are in motion, one is done lately, and 64 drafts sit in the checkout. On cornfield's own repo today the inbox is empty of anything waiting, and the three open issues (#270, #271, #275) sit under Nobody on it.

## Decisions

### D1. Work opens on the Inbox; the lane map is Graph

- The Work view gains a toggle in the header, beside the view switch (where spec 0015 puts a view's own controls): **Inbox · Graph**. Work opens on **Inbox**. **Graph** is the lane map of spec 0012 D3 with spec 0015's cleanups, unchanged. The choice is remembered like a layer.
- `G` switches between them. `?view=work` opens the Inbox. `?view=work&as=graph` opens Graph. The addresses that select a piece of work (`?pr=`, `?issue=`, `?run=`, `?thread=`, `?spec=`) open whichever of the two was used last, with that work selected.
- The Inbox is a two-column surface, the queue on the left (about 440 px) and the selected item on the right. It is a view of its own, not a panel over the map, so spec 0015's one-panel rule is kept.

### D2. The queue: groups decided by state, never filed by hand

Every row is placed by rules on the work's own state, from the same work graph (spec 0012 D7). Nothing is archived, starred or moved by hand (D7).

| Group | Holds | Order | Starts |
|---|---|---|---|
| **Waiting on you** | spec 0010 D1, unchanged: specs to decide (to decide, or changed since approved) and runs waiting on an answer | oldest first | open |
| **Your move** | not asked, but one action finishes it: a pull request with a failed check (Re-run failed), a failed run (Start again), a finished run whose pull request is open (Land it), an approved spec PR (Land it) | oldest first | open |
| **Nobody on it** | an open issue no open run is on (Start an agent), an idea thread with no spec (Reply) | oldest first | open |
| **In motion** | runs requested, claimed or working; specs sent back or on a draft PR; a pull request whose checks run; a running deploy | oldest first | folded |
| **Done lately** | merged, finished, stopped or closed in the graph's 14 days | newest first | folded |
| **Drafts** | proposals only in the checkout (spec 0012 D4), as a count that opens the Work list on them | | folded |

- A **thread that belongs to a spec** is not a row: spec 0015 folds it into its spec, and the Inbox follows.
- Each row is one line of title (`Spec 0100 · A new flow…`, the reference first) and one line of **why it is here**, in words: "Ready for your decision · docs running · 1 passed", "lint failed · test running", "Failed: the tests fail on the new version…", "Nobody is on it · design, polish". Its age is on the right, and its one action appears on hover, on focus and on a touch screen.
- An empty Waiting on you says so in a line at the top: "Nothing waits on you."

### D3. The number is spec 0010's, unchanged

- The Work button's badge, the tab title's "(3)" and "Waiting on you" count exactly what spec 0010 D1 counts. **Your move** and **Nobody on it** are not counted and never badge anything. Their group headers say so ("not counted").

### D4. One row per subject

- A run waiting on an answer about a spec that also waits on you rides in that spec's row ("and run 000003 waits on your answer") instead of a row of its own. The spec's detail shows both asks, the spec's first.
- The count is unchanged: two things waiting in one row count as two. The queue's heading says "4 waiting on you in 3 rows" when the two differ.
- Only this pairing folds. A run about an issue, or a pull request a run opened, keeps its own row, since its action is different.

### D5. The selected item: its ask first, then what is around it

- The right column is spec 0015's node panel for that work, laid out wide: the reference and title, the state pills, then the **ask**: one box with the question in words ("Run 000003 asks: Plan ready: approve to build, or tell me what to change."), the one primary action and its secondary (Review and Send back; an answer field with Continue and Stop; Land it; Re-run failed), and a line saying what the action will do. The actions, their confirm steps and their server checks are today's (spec 0012 D5), unchanged.
- **Around it**: a small drawing of the item, the work it is linked to on the left (each a link that selects it), and the code it touches on the right grouped by app as spec 0015 groups it (solid for changes, dashed for adds). Below it are **Show in Graph** and **Show on the map**.
- Then Connected work, On the map (the nodes, at most 14 and "+ n more"), and the facts (author, pull request, checks, cost of a run, updated).
- In Graph, selecting a node shows the same detail in the side slot, without Around it, since the graph already draws it.

### D6. Keyboard, screen reader and acting

- The queue is a list with one row selected. `J` and `K` (and the arrows) move through it, `Enter` does the row's primary action (with its confirm step where it has one today), and `Escape` comes back from the detail on a phone.
- After an action the row takes its new state (it leaves Waiting on you once the forge says so) and the selection moves to the **next row**, as an inbox does. Nothing is undone by cornfield: an action that has a confirm step today keeps it.
- On opening, a screen reader hears "Inbox: 4 waiting on you in 3 rows, 4 your move, 1 nobody on it." Each row is read as its reference, title, why and age.

### D7. No snooze, no dismiss

- A row leaves a group only when its state changes. Snooze is left for later, if the queue starts to feel stale in use. Hiding work that still needs you is how an inbox starts to lie, the failure spec 0010 D4 guards against.

### D8. On a phone

- The queue takes the width. Picking a row opens its detail as a sheet under spec 0010 D7's rule (the map is not on the screen in the Inbox, so the 35% rule binds only in Graph). **‹ Inbox** and `Escape` come back.

### D9. What the work graph adds

The Inbox needs three facts the graph does not carry yet. All are read where the server already reads them:

- a run's **question and brief** (`report.note`, `brief`), from the runs store;
- a pull request's **checks** as counts by state (failed, running, passed), from the PR detail already kept per head commit (spec 0012 D7);
- a finished run's **pull request number and state**, from the run.

## The questions, answered

1. **What counts in the badge:** only spec 0010 D1's (specs to decide, runs waiting on an answer). Your move and Nobody on it are shown, not counted.
2. **One row per subject or per item:** per subject, for the one pairing in D4. The count stays per item.
3. **Snooze or dismiss:** neither, for now (D7).
4. **Where the lanes go:** they stay in Work, as Graph, behind a toggle. They are not moved to the Map view as a layer.

## What gets built, in order

Each step is its own pull request and release; cornfield's page keeps working after each. All of them follow spec 0015's release.

1. **The graph carries what the Inbox needs** (D9): `server/work-graph.js`, tests against the fake forge, the request in `docs/issues-and-prs.md`.
2. **The Inbox's rules** (D2 to D4): `explorer/inbox-model.js`, pure (no DOM), with the groups, the reasons in words, the order and the folding, tested on the rig's graph.
3. **The Inbox in the page** (D1, D5 to D8): `explorer/pieces/inbox.js`, the Inbox · Graph toggle and its address, the queue and the detail with its actions, Around it, the keyboard, the screen reader's words, the phone's sheet, the strings and theme hooks, and a browser proof on the rig (`test/fixtures/big/inbox-proof.mjs`).

## Where it stands

Steps 1 to 3 are built. Step 3 differs from D5 in one place, on purpose: the selected row's detail is the node panel beside the queue, not a new pane, because spec 0015 already made that panel lead with the ask (its action bar first, one line on what comes next). Still to come: **Around it** (D5's small map of what the selected work touches), the Inbox's words in the page's `strings`, and the browser proof on the rig (`test/fixtures/big/inbox-proof.mjs`). One theme hook is added (`inbox`); its groups, rows, counts and tags are the page's own `section`, `row`, `count` and `tag`, so the documented list grows by one, to 201.

## What is not in this spec

- Snooze, dismiss or "mark done" (D7).
- Counting anything new in the badge (D3).
- **An approved spec that nothing is building.** On cornfield's own repo, specs 0011 and 0013 are approved and not yet built. The mock's "today" set shows them under Your move to ask whether that is wanted, but cornfield cannot tell yet: a proposal in the checkout does not say whether it is approved, or whether an issue or run builds it. That needs its own decision.
- Notifications outside the page (hooks already reach a chat: `spec.ready`, `run.state`).

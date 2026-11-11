# Spec 0006: scenarios and personas in review

Status: **proposed**. Its proposal is [`proposals/0006-scenarios-and-personas.json`](proposals/0006-scenarios-and-personas.json): what this adds and changes on cornfield's own map, with scenarios that name personas.

Issues: [#149](https://github.com/popcorn245/CornField/issues/149) scenarios sit behind Play, and nothing says who a scenario is for (F09); [#162](https://github.com/popcorn245/CornField/issues/162) no way to read a scenario's steps as a list, and no complete non-visual path through a review (F13). Both come from the 0.34 design review.

## The rule this answers to

How the maintainer reviews, as the design review was told:

> A review means: look at Before / Diff / After on the map, play the scenarios, try what-if edits, then Approve or Send back.

The maintainer, on #149: "The scenarios are pretty much the focal point when I am reviewing. The new list of diff stuff with icons is awesome, but just as important to see the actual user personas and what scenarios apply to them."

So the test for every decision below: *is a scenario, and who it is for, as easy to reach as a change?*

## What the review found (0.34.0, a 922-node map, six rich proposals)

- The scenarios are behind **Play**: 1 click at 1440, 2 taps at 390. The bar says "5 scenarios", and that opens the change list, not the scenarios.
- A scenario's row is "title · N steps". Who it is for shows only while it plays, and only if it names an actor: **2 of the 26 scenarios** in the six rich proposals do, and **none** in the 64 small ones.
- A scenario's steps can be read as a list only under **Edit**, as editable text boxes. Each step's verdict (allowed, refused, not checked) shows one step at a time, while playing.
- The player keeps the zoom at the 0.18 floor for every step of an 11-step walk. The step's label is about 4.5 px tall. On a phone the player opens as a peek with no controls, under a second sheet: 285 px of sheets, 5 taps to step back once.
- Choosing a scenario drops keyboard focus to `body`. The change list is 15 bare buttons (0 list items); the scenario list is 5. The proposal's title is not a heading.

## Decisions

### D1. Scenarios sit beside the changes, in a review column (1440) or a second tab of the sheet (390)

From 768 px wide (where the phone's sheets stop), an open proposal docks a **review column** on the left, below the bar: 400 px wide, 320 px under 1024. It holds two sections, both open by default, one under the other: **Changes · 18** and **Personas and scenarios · 5**. The map is drawn in the space the column leaves; every camera fit (open, a change, a step) uses that space. The decision (Send back, Approve and the line about what Approve does, spec 0007) moves to the column's foot, after both lists.

On a phone the proposal sheet, expanded, has a two-part switch at its top: **Changes · 6 | Scenarios · 3**. It opens on Scenarios when the proposal has any. The peek reads "Checkout · 6 changes · 3 scenarios for 2 personas".

The counts' "5 scenarios" part opens the Scenarios section (it scrolls into view at 1440; the switch moves to it at 390).

- **Why a column:** the change list today is a box over the map, and a change chosen in it is centred under the box. A docked column takes its width from the map instead of covering it, and holds both lists at once.
- **Why stacked, not side by side:** two 330 px lists at 1440 leave the map 780 px. Both sections have headings, so a reader jumps between them in one key.
- **Rejected:** tabs at 1440 (one list is always hidden, and the maintainer called them equally important); a floating box (it hides what it points at); keeping Play as the way in (the scenarios stay one step further away than the changes).

### D2. Personas first: each persona, then the scenarios that apply to it

The Scenarios section groups by persona, in the order of the personas file, then a group **Anyone** last.

- **"Applies to" means "acts in".** A scenario applies to a persona when that persona is its `actor`, or the `actor` of any of its steps. This is the data cornfield already has (`core/proposal.js`, `stepActor` in `explorer/scenario.js`): no new field.
- **A step may change who acts,** as today: its own `actor` wins over the scenario's. Such a scenario is listed under each persona that acts in it, and its step list says who acts at each step ("2 · As Admin"). This is how a hand-over reads (a guest asks, an admin answers).
- **A scenario with no actor anywhere is listed under Anyone.** It is not hidden and not given a persona it did not name.
- **Coverage:** the last line of the section names the personas on the map that act in no scenario of this proposal: "Not in any scenario: Child, Outside contributor". It is a fact to look at, not a warning.
- **A persona is who acts, not how they review.** A maintainer with a screen reader is the maintainer persona. Access needs are covered by D4, not by personas.
- **Rejected:** a new `personas: []` field on a scenario that only labels it (a second way to say who acts, which the checks would ignore); grouping by scenario and listing personas inside (the maintainer asked for personas first).

### D3. A scenario with no persona: a warning in `cornfield proposal`, nothing in `validate`

`cornfield proposal <file>` prints one warning per scenario that names no actor, after the counts and before "The proposal is valid.": `Warning: scenarios[2] "the-old-page-goes" names no persona; it is listed under Anyone.` The exit code stays 0. When the map has no persona nodes at all, it prints one line instead: `Warning: the map has no personas (topology.personas.json); every scenario is listed under Anyone.`

- **Why the authoring tool:** the agent writing the proposal runs it on every draft (CONTRIBUTING step 2), so the warning reaches the author at the moment it is cheap to act on.
- **Rejected:** an error (2 of 26 scenarios would pass today; an outage or a pipeline scenario honestly has no actor); a `validate` warning (it runs in CI on every push, where nobody is writing the scenario, and it checks only the checkout's proposals, not spec PRs).
- **cornfield's own map gets personas.** It has none today, so its own proposals cannot name one. The first build step adds `topology.personas.json` with four archetypes: Maintainer, Reader (signed in, not a maintainer), Agent (the drafting agent's or runner's account) and Guest (no account).

### D4. Each scenario's steps read as a list, with verdicts, without playing it

Every scenario row has a disclosure (▸). Open, it shows an ordered list of its steps. Each step reads, in this order: its number, who acts ("As Admin", left out when nobody does), the node it touches (an edge step names both ends: "checkout page → orders table"), the node's mark in this proposal (Added, Changed, Removed, or nothing), the step's text, and its verdict in words: **Allowed**, **Refused: <reason>**, **Expected refused, was allowed** (a mismatch), **Not checked: <why>**, or nothing for a step with no actor.

- The row itself says "4 steps · walks 3 of 9 changes" and, once checked, "3 allowed · 1 refused".
- **Choosing a step goes to it:** the player opens, paused, on that step, and the camera moves to the step's node (D6). The list stays open, and focus stays on the step.
- **When checks run:** when a scenario is opened or played, as one batch (`planChecks`, `explorer/check-model.js`). Not for every scenario when the proposal opens: a checker may be a live API, and a 70-proposal map would ask hundreds of checks nobody reads.
- **Rejected:** reusing Edit's Steps list (every step is a text box, so reading invites edits); verdicts only in the player (one at a time, and gone when it closes).

### D5. The non-visual path: the whole review without the canvas

The list in D4 is also the path for a screen reader, a keyboard, or a quick read. In document order:

| Part | Role and name | Announced |
|---|---|---|
| Proposal title | `h2`, in the bar's region "Open proposal" | on open, politely: "Opened Checkout: 6 changes, 3 scenarios for 2 personas." |
| Source chip ([#158](https://github.com/popcorn245/CornField/issues/158)) | text, then a link "PR #23" | read with the title |
| Before / Diff / After | group "Compare", buttons with `aria-pressed` | "Diff view" on change |
| Changes | `h3` "Changes, 6", then a `ul`; each row a button "Added checkout page, page" | |
| Personas and scenarios | `h3` "Personas and scenarios, 3"; each persona an `h4` "Adult, 1 scenario"; its scenarios a `ul` | |
| A scenario | a button with `aria-expanded` controlling its `ol` of steps | "expanded" or "collapsed" |
| A step | a button "Step 2 of 3, as Adult: checkout page, Added. You pay. Allowed." | on choosing it, the player's polite line says the same |
| Coverage line | text | |
| Decision | group "Decision": the consequence line (spec 0007) is Approve's `aria-describedby`; Send back; Approve | |

- **Focus rules:** opening a scenario keeps focus on its button; choosing a step keeps focus on the step; Escape in the player returns focus to the step it was on. Focus never falls to `body`.
- **The canvas stays as it is** (`role="application"`, "Topology map"): everything a reviewer needs is in the lists, so the map is an aid, not the only source.
- From page load: heading navigation reaches the title, Changes, Personas and scenarios and each persona in 1 key each; the decision is the column's last group.
- **Rejected:** a separate "text view" page (two views drift apart); putting text inside the canvas (no screen reader reads it reliably).

### D6. Play: one player bar under the map, following the camera rule

Once the list exists, Play is a way to watch, not the way in. The player is one bar at the foot of the map area (not over the column):

- **Controls:** ◀ Previous, ⏸ Pause / ▶ Play, Next ▶, then "2 of 4 · As Adult · <text> · Allowed", the speed menu, and ✕ Close. The As menu stays (it acts every step as another persona; its first choice stays "As written").
- **The list follows:** the current step is marked in the open step list (`aria-current="step"`). Playing a scenario opens its list.
- **The end:** "Played to the end" with **Play again** and **Next scenario** (the next one in the persona order). Nothing advances on its own past the end.
- **The camera rule** (being built now as [#159](https://github.com/popcorn245/CornField/issues/159)): the step's node is inside the free map (minus the bar, the column and the player), at a zoom where its label is readable (at least `LABEL_ZOOM`); an edge step fits both ends.
- **On a phone** the player is one 44 px row at the foot of the sheet, ◀ ⏸ ▶ always visible; the proposal sheet folds to its peek while a scenario plays.
- **Rejected:** the player as a second sheet (285 px of sheets, controls hidden); auto-playing the next scenario (a reviewer loses their place).

### D7. The theme contract

Hooks (`data-corn`, added to `docs/theming.md`; adding one is not breaking):

| Hook | What it is |
|---|---|
| `review-column` | the docked review column at 1440, or the expanded sheet's body at 390 |
| `change-list`, `scenario-list` | the two sections, each with its heading and list |
| `persona-group` | one persona's heading and its scenarios |
| `step-list`, `step` | a scenario's ordered steps, one step |
| `decision` | the column's foot: the consequence line, Send back, Approve (spec 0007 fills it) |

A step's verdict is a `state-pill`: `success` for allowed (or refused as expected), `failure` for refused or a mismatch, and no state for not checked. The words always carry the meaning. Scenario rows stay `row`; the phone's switch is `tabs` and `tab`.

`strings` keys (labels only, one line each): `changes` "Changes", `personasAndScenarios` "Personas and scenarios", `anyone` "Anyone", `notInAnyScenario` "Not in any scenario", `steps` "Steps", `previousStep` "Previous", `nextStep` "Next", `pause` "Pause", `play` "Play", `playAgain` "Play again", `nextScenario` "Next scenario", `notChecked` "Not checked".

## Sketches

At 1440×900, a proposal open, one scenario's steps open, step 2 playing:

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◆ cornfield  Map  Flow  House  Fit  Layers · 13 of 20  Search...                  Work  (M)  │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ Checkout  PR #23 · Open · 2 checks passed                                                    │
│ +2 nodes +2 links · 1 changed · 1 removed · 3 scenarios   [Before|Diff|After]    Edit    ⋯   │
├────────────────────────────────────┬─────────────────────────────────────────────────────────┤
│ Changes · 6                     ▾  │                                                         │
│  ┊ Added    checkout page    page  │        ┊○ checkout page  ◀ step 2, labelled             │
│  ┊ Added    checkout API     page  │           ╲                                             │
│  │ Changed  cart page        page  │            ○ orders table                               │
│  … 3 more                          │                                                         │
│ Personas and scenarios · 3      ▾  │                                                         │
│ Adult · 1 scenario                 │                                                         │
│  ▾ An adult pays for the basket    │                                                         │
│    3 steps · walks 3 of 6 changes  │                                                         │
│    1 As Adult · cart page  Allowed │                                                         │
│  ▶ 2 As Adult · checkout   Allowed │                                                         │
│    3 As Adult · orders     Refused │                                                         │
│ Guest (no account) · 1 scenario    │                                                         │
│  ▸ A guest tries the checkout      │                                                         │
│ Anyone · 1 scenario                │                                                         │
│  ▸ The old confirm page goes       │                                                         │
│ Not in any scenario: Child, Admin  │ ◀ Previous  ⏸ Pause  Next ▶  2 of 3 · As Adult · Allowed │
├────────────────────────────────────┤                                       5 s ▾      ✕     │
│ Approve posts an approval on PR    │                                                         │
│ #23. It does not land it.          │                                                         │
│              Send back   Approve   │                                                         │
└────────────────────────────────────┴─────────────────────────────────────────────────────────┘
```

At 390×844, the sheet expanded on Scenarios, the same step playing:

```
┌──────────────────────────────────────┐
│ ◆   Map  Flow  House      Work  (M)  │
├──────────────────────────────────────┤
│        ┊○ checkout page  (step 2)    │
│           ╲                          │
│            ○ orders table            │
├─────────────────═══──────────────────┤
│ Checkout  PR #23 · Open · passed     │
│ [ Changes · 6 | Scenarios · 3 ]      │
│ Adult · 1 scenario                   │
│  ▾ An adult pays for the basket      │
│    1 As Adult · cart page    Allowed │
│  ▶ 2 As Adult · checkout     Allowed │
│    3 As Adult · orders       Refused │
│ Guest (no account) · 1 scenario      │
│  ▸ A guest tries the checkout        │
│ Anyone · 1 scenario                  │
│  ▸ The old confirm page goes         │
├──────────────────────────────────────┤
│  ◀    ⏸    ▶    2 of 3 · Allowed   ✕ │
├──────────────────────────────────────┤
│ Approve posts an approval on PR #23. │
│ [ Send back ]          [ Approve ]   │
└──────────────────────────────────────┘
```

## Open questions for the maintainer

Each has a recommendation, so "yes to all" is an answer.

1. **A record of what was seen.** Should cornfield remember which scenarios a reviewer played to the end or opened, and show it? **Recommend yes, as information only:** a tick on the row ("Played", "Read"), and "3 of 5 scenarios played" in the decision line. Kept in the reviewer's browser per proposal and PR head; never blocks Approve; not written into the review comment (that would change the review block, which is strictly `{ verdict, note, edits }`).
2. **A warning, or more?** D3 warns in `cornfield proposal` only. **Recommend keeping it a warning** and looking again once most proposals name personas.
3. **Phone default tab.** D1 opens the sheet on Scenarios when there are any. **Recommend yes**, and remember the reviewer's last choice in the browser.
4. **Checks for every scenario at open.** D4 checks a scenario when it is opened or played. **Recommend keeping that**; add "Check all" later only if the row summaries are missed.
5. **cornfield's own personas.** D3 adds Maintainer, Reader, Agent and Guest to cornfield's map. **Recommend these four**, with roles `maintainer`, `reader`, `agent` and no account.

## What gets built, in order

Each step ships on its own and leaves review working.

1. **cornfield's personas:** `topology.personas.json` (D3), `sync`, and the warning in `cornfield proposal`, with tests.
2. **The scenario list model** (pure, tested in Node): group by persona, Anyone, coverage, step rows with node, mark and verdict words.
3. **The review column at 1440 and the sheet switch at 390** (D1), holding today's change list and the new scenario list, with the headings and lists of D5. Play and its list go.
4. **Step lists and verdicts** (D4), choosing a step opens the player paused there.
5. **The player bar** (D6): one bar, the end state, the list following it, the phone row.
6. **Hooks and strings** (D7), in `docs/theming.md` and its tests; an axe run and a keyboard walk test of the D5 path.

## What is not in this spec

- What Approve and Send back do, and the words above them: spec 0007.
- The camera fixes on open, on a chosen change and on a step ([#156](https://github.com/popcorn245/CornField/issues/156), [#157](https://github.com/popcorn245/CornField/issues/157), [#159](https://github.com/popcorn245/CornField/issues/159)), the focus fixes ([#161](https://github.com/popcorn245/CornField/issues/161)) and the phone player's controls ([#160](https://github.com/popcorn245/CornField/issues/160)): small fixes, being built now. D6 relies on them.
- Labels, search and selection on a big map: spec 0008.
- Who may see the dashboard, and what a persona may do in production: unchanged.

# Spec 0007: the decision: what Approve and Send back do, and when

Status: **approved** (maintainer, in chat, 2026-11-11: "Approve all 5 go"), so it skips the map review gate ([ADR 0010](../adr/0010-cornfield-uses-its-own-gate.md)). Every open question is answered as recommended. **Built** (all seven steps; a run on Send back stays its own issue). Its proposal, which added the decision model to cornfield's own map, was deleted when it was built; `git log` keeps it.

Issues: [#152](https://github.com/popcorn245/CornField/issues/152) Approve fires at once on a draft PR with checks still running, says nothing first, and drops an open what-if edit (F01); [#166](https://github.com/popcorn245/CornField/issues/166) what-if: a new node lands off screen, the counts ignore it, and there is no view without your edits (F17); [#183](https://github.com/popcorn245/CornField/issues/183) "No runner online" is a faint line inside the Runs tab, and Approve says nothing (F35). All three come from the 0.34 design review.

## The rule this answers to

How the maintainer reviews, as the design review was told:

> A review means: look at Before / Diff / After on the map, play the scenarios, try what-if edits, then Approve or Send back. Approve lands the PR once checks are green, and a run follows.

And from [ADR 0006](../adr/0006-safe-actions-only.md): an action that commits is one the maintainer chose, knowing what it does. So the test for every decision below: *before the click, does the maintainer know what this click will do, in this exact state?*

## What the review found (0.34.0)

- Approve has **0 confirmations** and **no undo**. It became pressable 16 to 25 ms after the bar showed, whatever the PR's state. It posted on PR #24, a **draft** with its `docs` check still running.
- Nothing near Approve says what it does: post a comment, land the PR (`approveLands`), ask for a run (`agents.on`). After it, Approve stays enabled and can be pressed again.
- With the "Add a node" form open and its edit refused, Approve posted `"edits": []` and said nothing about the edit left behind.
- With the runner offline or never seen, the review page says "runner" nowhere. The only line is 11 px, inside the Runs tab.
- A what-if node was placed off screen (canvas y −23). The counts did not change. To see the proposal without your edits you must undo each one.

## Decisions

### D1. A line above the buttons says what Approve does, in this state

The decision sits at the foot of the review column (spec 0006 D1), or the foot of the sheet on a phone: one line, then **Send back** and **Approve**. The line is Approve's `aria-describedby`, so a screen reader hears it with the button. It is built from parts, each short, and only the parts that apply are shown.

| State | The line |
|---|---|
| Open, checks passed, `approveLands` off | Approve posts an approval on PR #23. It does not land it. |
| Open, checks passed, `approveLands` on | Approve posts an approval on PR #23 and lands it. |
| Open, 1 check running, `approveLands` off | Approve posts an approval on PR #23. 1 check is still running. |
| Open, 1 check running, `approveLands` on | Approve posts an approval on PR #23. It lands once 1 running check passes. |
| Open, a check failed, `approveLands` off | Approve posts an approval on PR #23. `lint` failed. |
| Open, a check failed, `approveLands` on | Approve posts an approval on PR #23. It will not land: `lint` failed. |
| Open, no checks, `approveLands` on | Approve posts an approval on PR #23. It will not land: the PR has no checks. |
| Draft, `approveLands` off | PR #24 is a draft. Approve posts an approval on it. |
| Draft, `approveLands` on | PR #24 is a draft. Approve posts an approval; it lands only if the PR is marked ready within 60 minutes. |
| … and `agents.on['spec.approved']` is set | Then a code run is asked for. |
| … the runner (pull) polled within its window | A runner is online. |
| … the runner (pull) has been quiet | No runner has polled for 2 h: the run will wait. |
| … no runner has ever polled | No runner has polled yet: the run will wait. |
| … the transport is the forge or push | The request is posted for your runner. |
| … the reviewer has what-if edits | Your 2 edits go in the comment, for the agent to fold in. |
| A draft in the checkout or a worktree | Draft in the checkout: push it as a spec PR to review it here. |
| The PR's state could not be read | Could not read PR #23's checks. Approve posts an approval on it. |

- **Where the facts come from:** one route, `GET /proposals/<slug>/decision?source=pull/<n>`, answers `{ pull: { number, draft }, checks: { passed, running, failed: [names] }, lands, run: null | { kind, transport, runner, lastSeen } }`, read fresh from the forge, the config (`proposals.approveLands`, `agents.on`) and `runnerPresence`. The page asks when the proposal opens, every 30 s while it is open, when the window gets focus, and at the end of the hold (D3). A pure `explorer/decision-model.js` turns that and the page's own state (edits, an open form, the last review) into the line and D2's answer.
- **The runner, outside review** ([#183](https://github.com/popcorn245/CornField/issues/183)): while a run would wait, the Work button carries a dot (its name gains ", no runner online"), the Runs tab and Start an agent show a `notice` at the top in place of the 11 px meta line, and **Ask the runner** reads **Queue it (no runner online)**. Only the pull transport has runners that poll, so only it shows any of this.
- **Rejected:** a tooltip on Approve (hidden on touch and from most screen readers); one fixed sentence for every state (it would be wrong in most of them).

### D2. When Approve is allowed, when it asks first, and when it is refused

Telling comes first; asking is for the few states where the click most likely is not what the maintainer means. **Asking is in place:** the first press turns the line into the question and the button into **Approve anyway**; focus stays on it, and the question is announced (`role="alert"`). Escape, or any other action, takes it back. No modal.

| State | Approve | The words |
|---|---|---|
| Open PR, checks passed or running | allowed | the line (D1) |
| Checks failed | **asks** | "`lint` failed on PR #23. Approve anyway?" |
| Draft PR | **asks** | "PR #24 is a draft: its author has not marked it ready. Approve anyway?" |
| A what-if form holds input | **asks** | "Your Add a node form is not added. Approve without it?" |
| Edits, and `approveLands` on | **asks** | "PR #23 lands as written; your 2 edits only go in the comment. Approve anyway?" |
| No runner online | allowed | the line (D1) |
| Already approved at this head | done | Approve reads **Approved** (`aria-disabled`, so it keeps focus); a push makes it live again |
| A draft in the checkout or a worktree, no PR | refused | the line (D1); both buttons `aria-disabled`, focusable, and the reason shows on a phone too ([#164](https://github.com/popcorn245/CornField/issues/164)) |
| Sign-in ended during the review | refused at the press | "Your sign-in has ended. Sign in again: your edits are kept here." |
| No longer a maintainer | refused at the press | "maintainer-one no longer maintains this repo, so the forge would not count the review." |

Why each "asks":

- **Checks failed.** On a spec PR the checks are mostly `validate` and the docs. A red one usually means the proposal or the spec does not hold against the map: the thing being approved may be wrong. One extra press, only in that state.
- **Draft.** The author has said it is not finished. This is the case the review hit (PR #24).
- **An open form.** The maintainer started an edit and has not finished it. Dropping it silently is what [#152](https://github.com/popcorn245/CornField/issues/152) found.
- **Edits with `approveLands`.** What lands is the PR as written, not what the maintainer is looking at. Without `approveLands` the agent folds the edits in before anything lands, so the line alone is enough.

Why the rest only tell: **running checks** are what the lander already waits for, so asking would add a click for nothing the line does not say; **no runner** does not change the approval, only when its run starts. The two "refused at the press" states are the server's answers (401 and 403) in words; the dashboard is for maintainers only, so they show only when something changed mid-review.

- **Rejected:** disabling Approve until checks are green (it blocks a maintainer who knows the red check is unrelated, and the lander already guards the landing); a confirm on every approval (a confirm that always appears is clicked through).

### D3. Undo: a 5-second hold before anything leaves the page

Pressing Approve (or Approve anyway) starts a hold: the button reads **Approving in 5 s**, with **Undo** beside it, and focus moves to Undo. Nothing is sent until the hold ends; Undo ends it and sends nothing. At the end the page reads the decision facts once more (D1); if the state now asks (a check failed meanwhile), it asks instead of posting. Send back gets the same hold. Under reduced motion there is no countdown bar, only the words.

What the forge allows, and why undo is not "take it back afterwards":

- GitHub and Forgejo let the author **delete or edit** their own comment. But cornfield's rule ([ADR 0005](../adr/0005-reviews-are-pr-comments.md), `latestReview`) makes an edited review count for nothing, along with every older review of that proposal; and deleting it brings the review before it back to life, which may be an older approval or Send back.
- By the time the comment is posted, `spec.approved` has gone to every hook, a trigger may have posted a run request, and the lander looks at the PR **at once**. A green PR can land within seconds. None of this can be recalled.

So the only clean undo is before the post. After it, the maintainer changes their mind the way the docs already say: **Send back** posts a newer review, and the decision foot shows **Cancel landing** while a landing waits (the Work panel's Cancel, brought here). A run that was asked for is stopped with **Stop** in Runs.

- **Rejected:** deleting the comment (above); a server-side hold (a new store and timer for 5 seconds; the review API, used by scripts, needs none); a "withdrawn" verdict (it changes the review block every reader parses: open question 3).

### D4. What-if edits at decision time

- **Send back** carries the applied edits as the proposed edits, as today. A form holding input asks first, as Approve does. The line under the note says: "Posts your note and 2 edits on PR #23 for the drafting agent. No run is asked for."
- **Approve** carries the applied edits in the comment, as today; the line says so (D1), and with `approveLands` it asks (D2).
- **Never silently dropped:** an edit refused by its form was never applied and is not sent; the form's own red line stays, and D2's "open form" question names it.
- **After a send:** the map returns to the proposal as written, and the sent edits stay readable in a line, **Sent with 2 edits ▸**, which opens a read-only list. Today they vanish but for "Sent with your 1 edit".

### D5. Seeing the proposal without your edits, and counting them apart

- **My edits**, a pressed toggle beside Before / Diff / After, shown only when there are edits. Off, the map is drawn from the proposal as written (`rebuildProposalMap(state.proposal)`); the edits are kept, the Edit tools say "Turn My edits on to edit", and Approve and Send back still carry them (the line says so). Its name is not "As written", which the player's As menu already uses for personas.
- **The counts never mix the two.** The proposal's counts stay the proposal's. Edits are a part of their own, with the edit mark's own shape ([#169](https://github.com/popcorn245/CornField/issues/169)): "+2 nodes +1 link · 1 changed · yours: +1 node". In the change list, **Your edits · 1** is the first group, not the last row.
- **A new node lands in view:** the camera moves to a node or edge an edit adds, in the free part of the map, and marks it once.
- **Rejected:** "Before / Diff / After" gaining a fourth view (the toggle combines with all three); counting edits into the proposal's numbers (the reviewer can no longer tell what the agent proposed).

### D6. Send back: the note, where it goes, what the author gets

Unchanged in substance; written down so the line in D4 is true.

- The note is required ("Say what should change before you send it back."). It is posted with the edits as a comment on the spec PR, as the maintainer: one line for people ("Sent back `0002-checkout` with 2 edits (maintainer-one, in cornfield).", the note quoted), then the `cornfield-review` block `{ "verdict": "notes", "note", "edits" }`.
- The author, usually an agent, gets it three ways: the comment on the PR; `cornfield review <slug>`, which prints the latest maintainer review as JSON for `applyEdits`; and the `spec.sentBack` hook, which carries the note and the edits.
- A send-back asks for **no run**: spec 0005 D10 lets a trigger fire only on `spec.approved`, `build.opened` and `/agent`. Whether to add one is open question 4.

### D7. The theme contract

Hooks (`data-corn`, added to `docs/theming.md`): `decision` (the foot that holds the line, Send back and Approve; shared with spec 0006, added by whichever is built first) and `sent-edits` (the read-only list of edits sent with a review). The line and the toggle are reached through their regions.

`strings` keys: `approveAnyway` "Approve anyway", `sendBackAnyway` "Send back anyway", `undo` "Undo", `approved` "Approved", `myEdits` "My edits", `cancelLanding` "Cancel landing", `queueIt` "Queue it". The lines of D1 are not keys: they hold numbers and names, and a `strings` value is a fixed one-line label.

## Sketches

At 1440×900: a draft PR with a check running, `approveLands` on, a trigger set, no runner seen for 2 h, one edit. Approve was pressed once and is asking.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◆ cornfield  Map  Flow  House  Fit  Layers · 13 of 20  Search...                  Work• (M)  │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ Checkout  PR #24 · Draft · 1 of 2 checks running                                             │
│ +2 nodes +1 link · 1 changed · yours: +1 node    [Before|Diff|After]  [My edits ✓]  Edit  ⋯  │
├────────────────────────────────────┬─────────────────────────────────────────────────────────┤
│ Changes · 6                     ▾  │                                                         │
│  ✎ Your edits · 1                  │                                                         │
│    Added  gift note page     page  │          ✎○ gift note page   ◀ in view, marked once     │
│  ┊ Added  checkout page      page  │            ╲                                            │
│  … 5 more                          │             ┊○ checkout page                            │
│ Personas and scenarios · 3      ▸  │                                                         │
│                                    │                                                         │
├────────────────────────────────────┤                                                         │
│ PR #24 is a draft. Approve posts   │                                                         │
│ an approval; it lands only if the  │                                                         │
│ PR is marked ready within 60 min.  │                                                         │
│ Then a code run is asked for. No   │                                                         │
│ runner has polled for 2 h: the run │                                                         │
│ will wait. Your 1 edit goes in the │                                                         │
│ comment, for the agent to fold in. │                                                         │
│ ⚠ PR #24 is a draft: its author    │                                                         │
│ has not marked it ready.           │                                                         │
│      Send back   [Approve anyway]  │                                                         │
└────────────────────────────────────┴─────────────────────────────────────────────────────────┘
```

At 390×844: an open PR, checks passed, `approveLands` on, after pressing Approve (the hold):

```
┌──────────────────────────────────────┐
│ ◆   Map  Flow  House      Work  (M)  │
├──────────────────────────────────────┤
│                                      │
│        ┊○ checkout page              │
│           ╲                          │
│            ○ orders table            │
│                                      │
├─────────────────═══──────────────────┤
│ Checkout  PR #23 · Open · passed     │
│ +2 nodes +1 link · 1 changed         │
│ [Before|Diff|After]          Edit ⋯  │
├──────────────────────────────────────┤
│ Approve posts an approval on PR #23  │
│ and lands it. Then a code run is     │
│ asked for. A runner is online.       │
│ [ Send back ]  [Approving in 5 s]    │
│                [      Undo      ]    │
└──────────────────────────────────────┘
```

## Open questions for the maintainer

**Answered 2026-11-11:** the maintainer took every recommendation below.

Each has a recommendation, so "yes to all" is an answer.

1. **The four "asks".** Failed checks, a draft, an open form, and edits with `approveLands` ask first; everything else only tells. **Recommend yes.**
2. **The hold.** 5 seconds, for Approve and Send back, in the page. **Recommend 5 s**; it is one constant, and a reviewer who finds it slow is the signal to shorten it.
3. **Taking an approval back after it is posted.** D3 leaves it to Send back and Cancel landing. A `"verdict": "withdrawn"` would let a maintainer clear a review without sending it back, but every reader of the review block (the CLI, the lander, the API, agents) would have to learn it. **Recommend not now**; revisit if Send back is used as an undo in practice.
4. **A run on Send back.** An opt-in `agents.on['spec.sentBack']`, so a send-back can ask the drafting agent for a new draft, would be a fourth trigger event in spec 0005 D10. It is a maintainer's act, so it fits D10's rule. **Recommend yes, in its own issue**, not in this spec.
5. **The decision route reads the forge every 30 s while a proposal is open.** That is two forge calls (the PR and its checks) per tab. **Recommend yes**, sharing the forge cache the Specs list already keeps, so two tabs do not ask twice.

## What gets built, in order

Each step ships on its own.

1. **The decision route and model:** `GET /proposals/<slug>/decision` and `explorer/decision-model.js`, pure, with a test per row of D1 and D2.
2. **The line** (D1), as Approve's description, at 1440 and 390. Approve reads Approved after an approval.
3. **Ask first** (D2), in place, for the four states, and the refusals in words.
4. **The hold and Undo** (D3), for both buttons, with Cancel landing in the decision foot.
5. **What-if at decision time** (D4, D5): the open-form question, My edits, the separate counts, the new node in view, Sent with N edits.
6. **The runner outside review** (D1, [#183](https://github.com/popcorn245/CornField/issues/183)): the Work dot, the notices, Queue it.
7. **Hooks and strings** (D7), in `docs/theming.md` and its tests.

If spec 0006 is not built yet, step 2 puts the line in today's toolbar, above the two buttons, and moves it into the column's foot when 0006's column lands.

## What is not in this spec

- Where the scenarios live and the review column itself: [spec 0006](0006-scenarios-and-personas.md).
- The source chip on the bar (PR number, draft or open, checks: [#158](https://github.com/popcorn245/CornField/issues/158)), focus after a verdict ([#161](https://github.com/popcorn245/CornField/issues/161)), Send back's place on a phone with the keyboard up ([#163](https://github.com/popcorn245/CornField/issues/163)), and a reason for a disabled Approve on a phone ([#164](https://github.com/popcorn245/CornField/issues/164)): small fixes, being built now. D1 reads the same facts as [#158](https://github.com/popcorn245/CornField/issues/158)'s chip.
- What is waiting on the maintainer (waiting runs, the Specs list, Work on a phone): spec 0010.
- The review API: it already says what it did in its answer, has no form and no page, and takes no hold. Its checks are unchanged.

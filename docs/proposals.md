# Proposals in your own repo

A proposal is a JSON file that says what a change would add, change and remove on the map, with scenarios that walk through it. cornfield draws it over your map (Before / Diff / After), plays its scenarios, lets a reviewer try what-if edits, and records an Approve or a Send back.

cornfield itself makes every architectural change go through a proposal first ([CONTRIBUTING.md](../CONTRIBUTING.md), [ADR 0010](adr/0010-cornfield-uses-its-own-gate.md)). That is cornfield's own rule, its *gate*. Your repo does not need it: proposals work in any repo cornfield maps, for the changes you choose, with whatever review your team already has. This guide is the whole loop without the gate: write one by hand, review it, land it.

## Where proposals live

Two keys of `cornfield.config.js` ([config.md](config.md)), both optional:

```js
export default {
  proposals: 'docs/specs/proposals', // the folder of proposal files, in the checkout (the default)
  worktrees: '.claude/worktrees',    // a folder of git worktrees: each one's proposals folder is listed too, as a draft
};
```

Every `*.json` in the proposals folder is a proposal (a `*.review.json` is not). The file name without `.json` is its slug: `0002-checkout.json` is `0002-checkout`. A number in front keeps them in order; nothing requires it.

## 1. Write one by hand

Start from your map: the ids you point at are the ones in `topology.json` (`npx cornfield status` lists what it holds). A small, complete proposal:

```json
{
  "version": 1,
  "title": "Checkout",
  "summary": "A checkout page that writes the order through the API.",
  "nodes": {
    "add": [
      { "id": "page-web-checkout", "label": "/checkout", "type": "page", "parent": "app-web", "desc": "Pay for the basket." },
      { "id": "page-api-checkout", "label": "/api/v1/checkout", "type": "page", "parent": "app-api", "desc": "Turns the basket into an order." }
    ],
    "change": [
      { "id": "page-web-cart", "set": { "desc": "The basket: change it, then go to the checkout." }, "why": "the basket now leads to the checkout" }
    ]
  },
  "edges": {
    "add": [
      { "from": "page-api-checkout", "to": "table-orders", "kind": "writes", "status": "proposed", "label": "orders.add" }
    ]
  },
  "scenarios": [
    {
      "id": "adult-pays",
      "title": "An adult pays for the basket",
      "steps": [
        { "node": "page-web-checkout", "text": "You open the checkout from the basket." },
        { "edge": { "from": "page-api-checkout", "to": "table-orders", "kind": "writes" }, "text": "The API writes the order." }
      ]
    }
  ]
}
```

What to know while writing:

- **Nodes.** `add` takes any node field; `type` is one of the schema's types (`app`, `page`, `pkg`, `core`, `table`, `service`, `external`, `stack`, `container`, …), and `parent` adds the ownership line from the parent. Its colour comes from its type. `change` sets fields on a node of the map and says `why`; `remove` names a node and says `why`.
- **Edges.** An edge is named by `from` + `to` + `kind` (no `kind` is the ownership line; a `flow` edge names its `flow` too). `kind` is one of `flow`, `reads`, `writes`, `uses`, `extends`, `calls`, `triggers`, `delivers`, `runs-on`. `"status": "proposed"` draws a flow-like edge dashed, with its label in italics, until it is built.
- **Scenarios.** Each step points at a node (`{ "node": id }`) or an edge (`{ "edge": { from, to, kind } }`) and says, in a sentence, what happens there. A step may point at anything in the map or in the proposal, including what the proposal removes, so a scenario can show the old path going away. Steps can also carry an `actor` (a persona), an `at` (where it happens) and a permission `check`; an outage scenario lists the cloud nodes it takes `down`.
- **A sketch, not the map.** A proposal never edits `topology.json`, and it is held to fewer rules than the map: a page's label must still be a route (`/checkout`), but a `reads` edge without `keys` is fine here. `topology.json` stays derived from the code.
- **Mockups.** A proposal may carry the screens it is about: `"mockups": [{ "node": "page-web-checkout", "path": "0002-checkout/checkout.svg", "title": "The checkout page: the basket total and a Pay button" }]`. The `node` is one the proposal adds, changes or removes; the `path` is relative to the proposals folder and stays inside it (no `..`, no leading slash), and ends in `png`, `jpg`, `jpeg`, `webp`, `svg` or `html`; the `title` says what the screen is and is its alt text. Keep the files in the spec branch beside the proposal (the sample repo has `0002-checkout/`). `cornfield proposal` and `validate` report a path that leaves the folder, a type that is not allowed, and a node the proposal does not touch; `validate` also fails when a listed file is not there. A proposal without `mockups` is valid as it always was.

The full format, every field and every rule, is the comment at the top of [core/proposal.js](../core/proposal.js). The sample repo's [0002-checkout.json](../test/fixtures/sample/docs/specs/proposals/0002-checkout.json) has actors, a permission check and an outage; cornfield's own v1 proposal, [0001-v1.json](https://github.com/popcorn245/CornField/blob/ede6b6e/docs/specs/proposals/0001-v1.json) (deleted when v1 landed, as a landed proposal is), is a large real one.

Check it against the map as you go:

```sh
npx cornfield proposal docs/specs/proposals/0002-checkout.json
```

It prints the counts (`4 added · 1 changed · 0 removed · 3 scenarios`), then either each mistake with where it is (`nodes.add[0].parent: Parent "app-shop" is in neither the map nor the added nodes.`) and exit code 1, or every item's status against the map and "The proposal is valid."

## 2. Review it

On the map:

```sh
npx cornfield serve        # http://127.0.0.1:3350, then Proposals in the header
```

or open one straight away at `http://127.0.0.1:3350/?proposal=0002-checkout`. A draft in a worktree shows in the list with the worktree's name.

With a `forge` and [sign-in](sign-in.md) configured, the list also holds the proposals of **open pull requests** that add or change a file directly in the proposals folder, each read at the PR's head commit and listed as `Spec PR #23 by someone` (a draft PR says so). That is how a proposal gets reviewed before it is merged: open the spec PR and pick it from the menu. A PR that deletes a proposal lists nothing; one that only touches code is not listed. The PRs are asked of the forge with the signed-in maintainer's own token, so a private repo's PRs show for those who can see them. If the forge cannot be asked (it is down, or the sign-in has to be renewed) the menu says why above the list and still lists the checkout and the worktrees. What a PR's head commit holds is read once and kept (in memory), so opening the menu again asks the forge only for the open PRs; a PR pushed to is read again at its new head. Without a forge the list is the checkout and the worktrees, as before.

- **Before / Diff / After.** Diff rings what is added (dashed), changed (amber) and removed (red, label struck through) and dims the rest; Before and After show the map as it is and as it would be. The counts chip lists every change; a row takes you to it.
- **Scenarios.** Each plays step by step over the map, the step's text in the player at the bottom. Space plays and pauses, the arrow keys step.
- **What-if edits.** Add or remove a node or an edge, draw an edge by dragging from one node to another, add, reword or reorder steps. Edits are violet and can be undone; they never touch the file.
- **Mockups.** Select a node the proposal lists a mockup for: its panel has a button per mockup, with where it stands (`Not reviewed yet`, `Reviewed`, `Changed since you approved`, `File not found`). A click, or Enter, opens it in a window over the map: a picture with its title as alt text, or an HTML page in a frame. Escape closes it and the focus goes back to the button. Mockups of a spec PR are read at the PR's head commit, like the proposal.
- **Approve or Send back.** Send back needs a note. Either one is posted as a **comment on the spec PR**, as you (your own token, so the PR shows who said it), with the edits you made. The comment is one line for people ("Approved `0002-checkout` with 2 edits (you, in cornfield).", the note quoted under it) and a fenced block for the agent, named for the proposal:

  `````text
  ```cornfield-review 0002-checkout
  { "verdict": "notes", "note": "Make the checkout one page.", "edits": [ { "op": "remove-node", "id": "page-web-confirm" } ] }
  ```
  `````

  An approval also records what it covers: `"proposal"`, the SHA-256 of the proposal file as the PR's head holds it when you approve (so "Open the build issue" waits for a new approval after a push that changes the file). An approval of a proposal that lists mockups also covers them: cornfield reads each file at the PR's head as you approve and puts `"mockups": [{ "node", "path", "sha256" }]` in the same block (the page never sends hashes). A mockup changed afterwards shows as `Changed since you approved` until a new approval; Send back records none.

  The **latest comment by an admin** (someone who maintains the repo) is the review. A block from anyone else, a block that is not exactly `{ verdict, note, edits }` (not JSON, another verdict, an extra key) and a quoted one are ignored, so a reader cannot overrule a maintainer and a typo cannot break the page. A review comment that was **edited** after it was posted does not count, and neither does anything older on that proposal: on both forges someone with write access can edit anyone's comment, so to change your mind, post a new review. You can write one by hand on the PR in the same shape; the bar shows the latest one when the proposal opens ("Approved 3 minutes ago"). Every post is written to cornfield's audit table (who, which PR, what the forge answered). Nothing is written into the checkout.
- **A draft with no PR cannot be reviewed.** A proposal from the checkout or a worktree has no PR to hold a review, so its buttons are off and the bar says to push it as a spec PR (its mockups read `Not reviewed yet`). Reviews that earlier versions kept in the data folder (`<dataDir>/reviews/<source>/<slug>.review.json`) are carried over once: the first time you open the menu signed in, each one is posted as a comment on the one open spec PR that holds its proposal (unless that PR already has a review of it, which is newer), and the file is renamed `….review.json.migrated` and never read again. One whose proposal is on no PR yet waits for one.

**Mockups are untrusted.** A branch can put anything in an HTML or SVG file, so cornfield never lets one run script against its own page. Every mockup is served at `/proposals/<slug>/mockups/<n>` (by its position in the list, never by a path in the request; behind the sign-in and the Host check like every route) with the type its extension names, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: sandbox; default-src 'none'; …` (no script, no network, an opaque origin, even if the address is opened on its own), and only cornfield's own page may frame it. The explorer shows pictures and SVG in an `<img>`, and HTML in an `<iframe sandbox>` with no `allow-` keyword at all. A file is at most 5 MB, and a link that leads out of the proposals folder is not followed. Do not put a secret in a mockup: it is read by everyone who can open the proposal.

Whoever is writing the proposal reads the review from the PR with:

```sh
CORNFIELD_FORGE_TOKEN=… npx cornfield review 0002-checkout        # --pr 23 to name the PR
```

It finds the one open spec PR that holds the proposal (or takes `--pr`), reads its comments, and prints the latest admin review: `{ "version": 1, "slug": "…", "verdict": "approved" | "notes", "note": "…", "edits": [ … ], "proposal": "…", "mockups": [ … ], "at": "…", "by": "…", "comment": { "id": "…", "url": "…" } }` (`mockups` only on an approval of a proposal that lists some). The token is a GitHub (or Forgejo) token that can see the repo's PRs; `GITHUB_TOKEN` and `GH_TOKEN` work on GitHub, and only reads are made. The edits are in the same terms the viewer used (`add-node`, `remove-edge`, `add-step`, …); `applyEdits` from cornfield's core folds them into the proposal. A script for it, in your repo with cornfield installed:

```js
// fold-review.mjs: node fold-review.mjs <proposal.json> <review.json>
import fs from 'node:fs';
import { applyEdits } from 'cornfield';

const [file, reviewFile] = process.argv.slice(2);
const proposal = JSON.parse(fs.readFileSync(file, 'utf8'));
const { edits = [] } = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
fs.writeFileSync(file, `${JSON.stringify(applyEdits(proposal, edits), null, 2)}\n`);
console.log(`Folded ${edits.length} edit(s) into ${file}`);
```

```sh
npx cornfield review 0002-checkout > review.json
node fold-review.mjs docs/specs/proposals/0002-checkout.json review.json
npx cornfield proposal docs/specs/proposals/0002-checkout.json
```

Then fix what the note asks for by hand, and ask for another look.

**Off the map, in a pull request.** The proposal is a plain JSON file, so it can be reviewed like any other: open a PR with it, and let the reviewer read the diff, or check it out and run `cornfield serve` to look at it on the map. CI already checks it: `cornfield validate` checks every proposal in the folder against the map (below). What the verdict is and where it is written is your team's call; cornfield's own rule is the comment above.

## 3. Land it

Build the change as you normally would, then bring the map up to date:

```sh
npx cornfield sync         # topology.json from the code, now with what you built
npx cornfield proposal docs/specs/proposals/0002-checkout.json
```

Against the new map each item reads:

| Status | What it means |
|---|---|
| `pending` | not built yet |
| `landed` | built as proposed: the added node exists with that type and parent, the edge exists, the change's fields hold, the removed item is gone |
| `diverged` | built differently: an added node of another type or under another parent, an edge between the same two nodes of another kind, a changed node that is gone |
| `live` | drawn by the live layer, never in `topology.json` (a room, a device) |

While a change is half built, the proposal still validates: once something it adds exists as proposed, "already exists" for an added item and "does not exist" for a removed or changed one are expected and skipped. A part that points at nothing (a parent, an edge end or a step that is in neither the map nor the proposal) is always a mistake.

**Delete the proposal in the PR that lands it.** Once every item is `landed` (or you have decided the `diverged` ones are right), the file has done its job; `git log` keeps it. A proposal that only changes or removes things has to be deleted then: with nothing added it cannot show it has been built, so `validate` reports its targets as missing and says so.

## In CI

`cornfield validate` (the schema, the map's drift from the code, the personas and cloud files) also checks every proposal in the proposals folder, so a proposal that no longer reads against the map fails the build:

```yaml
- run: npx cornfield validate
```

Drafts in a worktree and proposals of spec PRs are not checked: only the checkout's proposals folder is.

## Not covered here

- cornfield's own rule of *which* changes need a proposal is in [CONTRIBUTING.md](../CONTRIBUTING.md). For your repo, pick your own: some teams propose every new service, some only what crosses a team's boundary.
- Forgejo as the forge is v1 work still to land ([specs/0001-v1.md](specs/0001-v1.md)); reviews as PR comments work on GitHub today.

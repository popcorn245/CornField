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

The full format, every field and every rule, is the comment at the top of [core/proposal.js](../core/proposal.js). The sample repo's [0002-checkout.json](../test/fixtures/sample/docs/specs/proposals/0002-checkout.json) has actors, a permission check and an outage; cornfield's own [0001-v1.json](specs/proposals/0001-v1.json) is a large real one.

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

With a `forge` and [sign-in](sign-in.md) configured, the list also holds the proposals of **open pull requests** that add or change a file directly in the proposals folder, each read at the PR's head commit and listed as `Spec PR #23 by someone` (a draft PR says so). That is how a proposal gets reviewed before it is merged: open the spec PR and pick it from the menu. A PR that deletes a proposal lists nothing; one that only touches code is not listed. The PRs are asked of the forge with the signed-in maintainer's own token, so a private repo's PRs show for those who can see them. If the forge cannot be asked (it is down, or the sign-in has to be renewed) the menu says why above the list and still lists the checkout and the worktrees. Without a forge the list is the checkout and the worktrees, as before.

- **Before / Diff / After.** Diff rings what is added (dashed), changed (amber) and removed (red, label struck through) and dims the rest; Before and After show the map as it is and as it would be. The counts chip lists every change; a row takes you to it.
- **Scenarios.** Each plays step by step over the map, the step's text in the player at the bottom. Space plays and pauses, the arrow keys step.
- **What-if edits.** Add or remove a node or an edge, draw an edge by dragging from one node to another, add, reword or reorder steps. Edits are violet and can be undone; they never touch the file.
- **Approve or Send back.** Send back needs a note. Either one is kept with the edits you made, in cornfield's data folder (`<dataDir>/reviews/<source>/<slug>.review.json`, by default under `~/.cornfield/`), never in the checkout. (A proposal of a spec PR cannot be approved or sent back from cornfield yet: comment on the PR until reviews are posted there.)

Whoever is writing the proposal reads the last review with:

```sh
npx cornfield review 0002-checkout
```

It prints the review as stored: `{ "version": 1, "verdict": "approved" | "notes", "note": "…", "edits": [ … ], "at": "…" }`. The edits are in the same terms the viewer used (`add-node`, `remove-edge`, `add-step`, …); `applyEdits` from cornfield's core folds them into the proposal. A script for it, in your repo with cornfield installed:

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

**Off the map, in a pull request.** The proposal is a plain JSON file, so it can be reviewed like any other: open a PR with it, and let the reviewer read the diff, or check it out and run `cornfield serve` to look at it on the map. CI already checks it: `cornfield validate` checks every proposal in the folder against the map (below). What the verdict is and where it is written is your team's call; cornfield's own rule is a PR review comment.

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
- Reviews as forge PR comments, proposals read from spec branches and sign-in are v1 work ([specs/0001-v1.md](specs/0001-v1.md)). Until then the review is kept in cornfield's data folder, and cornfield only listens on loopback.

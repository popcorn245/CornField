# Issues and pull requests

When the config names a forge (`forge: { type: 'github', repo: 'owner/name' }`, [config](config.md)) and a maintainer is signed in ([sign-in](sign-in.md)), the view switch has a **Work** button: the map of the repo's work ([below](#the-work-view)), with the actions on its pull requests, issues, proposals, runs, threads and deploys in the node panel, and the lists of them in the **Work list**. With no forge in the config, or without sign-in, the button and the lists are not there, and nothing else changes.

## The Work list

The **List** toggle at the top left of the Work view opens it where the side panel used to be (the left of the map, a bottom sheet on a phone). Its tabs run in the order of the loop, each with a count where there is one: **Specs**, **PRs**, **Issues**, **Threads**, **Runs** and **Deploys**. It opens on the tab with the oldest thing waiting on you, else on Specs.

**A row selects its node.** It does not repeat the detail: the node is selected on the map (the camera goes to it), and the node panel shows it and its actions ([below](#the-node-panels-actions)). A row for work older than the graph's 14 days, or past its limits, has no node on the map: it opens in the node panel by the same path, without selecting anything. The list is the keyboard's and the screen reader's overview of the view: its rows are buttons, in the order of the lists.

- **Specs** lists the proposals, grouped by who must act: the same list as the Proposals menu, with the title, a state pill (Open or Draft for a spec PR, Local for one only in the checkout or a worktree), a line of what it is for, and the spec number, the PR, the +/~/− counts and the scenarios. **New idea** is at the foot of the list.
- **PRs** and **Issues** are two lists, newest first, read through cornfield's server (the browser never talks to the forge, and never sees a token). A row has a link out to the forge beside it.
- **Filters** on what is loaded, behind one **Filter** chip that shows how many are on: state (a pull request is open, merged, or closed without landing; an issue open or closed), label, author, and a search over the title, number, author and labels. The line under the tabs says how many pass.
- **Runs** lists the agent runs, one row each (a run is selected like any piece of work), and groups the work by issue and proposal, marking what agents made: [agents](agents.md). Its two filters are behind the same chip.
- The counts of PRs, Issues and Threads are the open ones, read once, quietly, the first time the list opens (through the server's cache, like any list); Specs is asked again each time it is shown, as the Proposals menu is.
- A **Threads** tab lists the ideas (issues labelled `idea`) and the spec PRs' conversations, newest activity first. **New idea** opens an issue as you. A node's panel lists the threads that mention it: [threads](threads.md).
- **Release notes …**, at the foot of the PRs list, is [below](#release-notes).
- Rate limits and errors are a line in the list in words ("GitHub's limit for this sign-in is used up; it resets at 21:14 UTC"), never a blank list. While the forge cannot be asked, the last answer cornfield saw is shown and says it is old. **Refresh** asks the forge again (and the work graph, in the Work view).

## The node panel's actions

Select a piece of work in the Work view, or pick its row in the list, and the node panel holds its state, what it is connected to, the words saying what each action will do, and the actions themselves. They are the ones the side panel had, with the same confirm steps and the same server checks ([below](#what-the-server-checks-again)):

- **A proposal:** **Review** goes back to the map and opens the review over it (Before, Diff, After); **Approve** and **Send back** are the review's own, with the decision's confirm. A proposal that waits on you says so.
- **A pull request:** its state, branch and author, **Land it** with **Open on GitHub** (or Forgejo) beside it, its checks with **Re-run** on a failed one the forge lets cornfield run again, what it changes (each file with the nodes it is on, as a button that selects that node), a spec pull request's **Open the build issue**, a landing that waits on its approval (with **Cancel**), and the run that made it. The checks are read from the pull request's own route when the panel opens (the graph does not hold them).
- **An issue:** **Start an agent** and, on an open one, **Start a spec** (the pipeline's first step, [below](#the-pipelines-own-steps)).
- **A run:** its card: state, what it is about, limits and what the runner reported, the nodes it changes, links, the **answer field** of a run that waits (reply, **Continue** or **Stop**), **Stop**, **Start again** and the timeline.
- **A thread:** its messages, read-only, the nodes they mention, **Reply on GitHub** and **Open on the forge** (a thread is a conversation on the forge: you reply there).
- **A deploy:** what it restarted (each node a button that selects it) and **Open the logs on GitHub**. Cornfield has no way to run a workflow again, so a deploy has no Re-run.
- **A node of code:** the work that touches it, and **Show on the map**, which goes back to the Map view with it selected.

Nothing is lit on the map for a selected pull request any more: the Work view draws what it touches (a `changes` line to each node its files are, `closes`, `shipped`), and selecting the node dims all but it and its neighbours.

## The pipeline's own steps

Between an idea and a release there are three steps cornfield does for you, each **one button with a confirm step**, each guarded and audited like the actions below (they are [ADR 0006](adr/0006-safe-actions-only.md)'s "the pipeline's own steps"). None of them starts an agent ([ADR 0007](adr/0007-track-agents-do-not-launch.md)): they only make a branch, a file, a pull request or an issue on the forge, as you.

1. **Start a spec**, on an open issue (in its node panel). It makes a branch `spec/<nnnn>-<slug>` (`nnnn` is the issue's number in four digits at least, so the proposal reads and sorts like the others, `0013-meals`; the slug is the issue's title, lower case, at most 48 characters) from the config's `forge.baseBranch` (`main` when unset), one commit adding a stub proposal `<proposals folder>/<nnnn>-<slug>.json` (a title and a one-sentence summary that point back at the issue, and nothing a proposal would claim; it passes the proposal validator), and a **draft** pull request "Spec: <title>" whose description starts `Refs #<n>`. The spec then shows on the Specs tab like any other spec PR, and the Proposals review applies.
2. **Open the build issue**, on a spec pull request (its node panel, in the Work view) that changes a proposal whose latest review by a maintainer approves the proposal **as the pull request's head holds it now** ([reviews](proposals.md)): an approval records the SHA-256 of the proposal file it covers, so a push that changes the file after the approval waits for a new one (the Specs list says "Changed since it was approved"). It opens an issue "Build: <proposal title>" that links the spec pull request, names the proposal and the commit it was read at, says who approved it, and lists the proposal as approved (the review's what-if edits folded in) as a checklist: each node to add, change and remove, then each edge. A proposal that is sent back, has no review, whose approval someone edited, or that a non-maintainer "approved" has no button; the panel says why.
3. **Land it**, on a green pull request: the same action as below, not a second one.

**The confirm step shows exactly what will be made.** Clicking the button asks the server for the *plan* (`GET`, read from the forge now) and shows it in the dialog: the issue or pull request, the branch, the file's whole text and the description in full. Confirming sends back only the plan's digest (and, for the build issue, the proposal and the commit that were shown); the server plans again from the forge and refuses (409) if it is not the same plan, so what is made is what was shown. A page cannot name the branch, the path or the text.

**A second click makes nothing twice.** If the plan finds what an earlier ask made (an open pull request from a `spec/<nnnn>-` branch for that issue; an issue whose description carries the step's `cornfield-build` marker for that pull request and proposal, closed or open; either one only when a maintainer opened it, so someone who can open an issue or a pull request cannot plant one to block a step), the node panel says so, with a link, and shows no dialog; the action answers 200 with `created: false`. A half-made spec (the branch and the file are there, the pull request failed) is picked up where it stopped. A branch of that name with other work on it and no pull request is refused rather than committed onto: cornfield only ever *adds* a branch, a file, a pull request, an issue.

The build issue is found again by the forge's search for the proposal's name (GitHub's issue search; Forgejo's issue keyword search), together with the 100 newest issues, since a search index can lag a moment behind an issue just opened. Two people asking for the same step at once get one answer: the second is told to wait (429) while the first is being done, whoever they are.

**Text from a proposal or an issue does nothing in what is made.** It goes into a new issue or pull request as a code span, or with its markup turned into entities and every mention and reference broken by a zero-width space (`@​team`, `#​12`, `other/repo#​1`, `GH-​1`, `https:​//`). An entity is not enough on its own: Markdown turns `&#64;` back into `@` before the forge looks for mentions, so a proposal could otherwise ping people or cross-reference other repositories from your account.

**What a collaborator with write access can still do.** On both forges, someone with write access can edit or delete other people's issues and comments. They could paste the build marker into an existing maintainer's issue, so step 2 reports that issue as the one already made instead of opening a new one; or delete a maintainer's later Send back, so an earlier approval of the *same* file becomes the latest review again. Neither makes anything: the confirm step shows the issue found, or who approved and when, before anything is done. An edited review comment, and an approval of a different version of the file, never count. Give write access only to people you trust with the repo.

Both steps go through the checks of the table below (method, signed in, same origin, flood, JSON and 4 KB, twice, maintainer now, state) and are rows in the audit as `spec` (target `owner/name#<issue>`) and `build` (target `owner/name#<pull>/<proposal>`). Text from the forge or from a proposal (a node's label, a `why`) goes into the new issue only as a code span or with its markup, mentions and references turned into entities, so a proposal cannot ping anyone or close an issue from there.

## Land a green pull request, re-run a failed check

A pull request in the node panel has two actions, for a signed-in maintainer; with the pipeline's two steps above they are the only things cornfield does to a forge. Never a force-merge, never a deploy, nothing that touches anything live.

- **Land it** is there when the pull request is open, not a draft, and every check on its head is green (a check that is neutral or skipped does not stand in the way, but at least one must have passed: no checks, or only skipped and neutral ones, is not green). Otherwise the node panel says why under it ("Can't land yet: lint failed, test is still running."). It opens a **confirm dialog** that shows exactly what will land: the pull request, its head commit, the branch it comes from and goes into, how it lands (the config's `forge.mergeMethod`: a merge commit, squashed, or rebased; `merge` when unset), and each check. **Land it** there lands that commit with the forge's own merge; **Cancel** or Escape does nothing.
- **Re-run** is on a failed or cancelled check the forge lets cornfield run again (a GitHub Actions job; a cancelled one is usually a newer push's concurrency group stopping it). A check that passed or is still running has none. A failed check the forge cannot re-run from here (a plain commit status, or anything on Forgejo) says so beside it, and where to do it.

Every answer is a line in the node panel and is said through the live region ("Pull request #12 landed as fff0000.", "Pull request #12 was not landed: …"), and the panel then asks the forge again so the list and the checks are true.

### What the server checks again

The page is never trusted. Each action is a `POST` to cornfield's own server, which refuses in this order, in words, and (from the flood ceiling on) writes the refusal down:

| | Refused when | Answer |
|---|---|---|
| Method | not `POST` | 405 |
| Signed in | no session (or no sign-in configured: nobody to act as) | 401 (403) |
| Origin | the request is not from a page of this server (`Origin` and `Sec-Fetch-Site`, the `Host`; with a public URL, an `Origin` under its host must carry its scheme too). A page on a sibling subdomain is same-site, so the cookie rides along: its refusal is **not counted** toward the flood ceiling below, so it cannot use up your budget, and is written down at most once a minute per person | 403 |
| Flood | more than 60 attempts of any kind in a minute by one person: refused **without** writing a row, so a flood cannot grow the audit table | 429, with `Retry-After` |
| Body | not JSON, or larger than 4 KB (answered at once, the rest not read) | 415, 413 |
| Twice | the same action on the same target is already running or was asked in the last 5 seconds; more than 20 actions in a minute | 429, with `Retry-After` |
| Maintainer | the guard says reader; and again, at that moment, the forge says the permission is no longer admin or maintain | 403 |
| State | the pull request is not open, is a draft, a check is not green, or the forge says it is not ready (above) | 409 |
| Head | the commit the page showed is not the pull request's head now (somebody pushed): look again | 409 |
| Re-run | the check is not on that head, has not failed (or been cancelled), or the forge cannot run it again | 409 |
| Spec | the issue is closed or is a pull request; the plan is not the one the page showed (the issue was edited); the base branch is not there; the branch holds other work | 409 (404) |
| Build issue | the pull request is closed or does not hold the proposal; no approval by a maintainer now; the commit or the plan is not the one shown (a push, a new review) | 409 |

The merge itself goes through the forge interface's `merge(n, { onlyIfGreen: true, sha })`, which reads the pull request and its checks once more and asks the forge to land that commit only (GitHub's `sha`, Forgejo's `head_commit_id`): a push in between makes the forge refuse rather than land untested code. There is no force option and no admin override to ask for.

Just before it lands, the forge is asked once more what it knows besides the checks:

- **GitHub:** its own `mergeable_state` must be `clean` (branch protection's required checks and reviews met, no conflicts, the branch not behind), and no workflow run on the head may still be queued or running. Just after a push a fast check (a secret scan) can be green before a slow workflow has registered its own check, so "every check is green" alone could pass a commit nothing has tested yet.
- **Forgejo:** the pull request must be `mergeable`. Its API does not say which checks branch protection requires, nor list a job that has not reported a status yet, so the gap above stays open there.

**Branch protection's required checks are the real backstop**, on both forges: cornfield asks the forge to merge, and the forge refuses what its rules do not allow. Turn on required status checks for the branch pull requests land on.

### The audit

Every attempt is a row in the `actions` table of `cornfield.db`: when, who, `merge`, `rerun`, `spec` or `build`, the target (`owner/name#12`, or `owner/name#13/run:42`), the request (the number, the commit, the check), and the status and answer. It is written before the forge is asked and finished after, so a refusal, a forge error and a success are all there; a row with no status is an attempt that did not get an answer. If the table cannot be written, nothing is done (503). Read it with any SQLite tool: `SELECT at, login, action, target, status FROM actions ORDER BY id DESC`.

## Deploys

Another list, **Deploys**, shows the latest deploys (workflow runs); a selected one's node panel names the nodes it restarted, from a mapping in the config. It has its own page: [deploys](deploys.md).

## Who it asks as

The server asks the forge as the signed-in maintainer, with their own token ([sign-in](sign-in.md)), through the same adapter as everything else. The lists and details only read; the actions above (landing, re-running, the pipeline's two steps) and the draft release are the only writes. Without sign-in (a tool on your own machine, Stage 1) there is nobody to ask as, so the Work view is not offered and the routes answer 403 in words, as the Proposals menu lists no spec PRs then. Asking anonymously would work for a public repo, but every visitor would share the forge's unauthenticated limit (60 requests an hour on GitHub), with nothing kept between them.

Answers are kept in `cornfield.db` for a minute per user and request, with an ETag, so opening the list is not a dozen API calls; **Refresh** goes past it.

The routes, for the curious (all behind the sign-in guard):

| Route | Answers |
|---|---|
| `/api/forge/issues?state=open\|closed\|all&labels=a,b&limit=100` | issues (not pull requests) |
| `/api/forge/issues/<n>` | one issue, open or closed (404 for a pull request or no such issue); a deep link to an issue that is not in the open list asks it ([agents](agents.md#deep-links)) |
| `/api/forge/pulls?state=open\|closed\|all&limit=100` | pull requests |
| `/api/forge/pulls/<n>` | one pull request with its files and the checks on its head (each check says whether cornfield can re-run it), and `specs`: the proposals it changes and whether a maintainer has approved each |
| `POST /api/forge/pulls/<n>/merge` `{ "sha" }` | lands it at that head, if green |
| `POST /api/forge/pulls/<n>/rerun` `{ "sha", "check" }` | re-runs one failed or cancelled check on that head |
| `GET /api/forge/issues/<n>/spec` | the plan of step 1: the branch, the file's text and the pull request it would make, or the pull request it made already (never kept) |
| `POST /api/forge/issues/<n>/spec` `{ "digest" }` | starts the spec, if the plan is still that one |
| `GET /api/forge/pulls/<n>/build?slug=<proposal>` | the plan of step 2: the issue it would open, or the one it opened already (never kept) |
| `POST /api/forge/pulls/<n>/build` `{ "slug", "sha", "digest" }` | opens the build issue, if the plan is still that one |
| `/api/forge/work` | what the Runs tab groups: pull requests and issues of any state, branches, open spec PRs and the `agents` rules ([agents](agents.md)) |
| `/api/forge/work-graph` | the map of work ([below](#the-work-graph)): `nodes`, `edges` and `problems`; for the page only, never to an embedding origin |
| `/api/forge/threads?state=open\|closed\|all&limit=100` | the threads: ideas and spec conversations, newest activity first, each with the `[[mentions]]` its text holds as written, never the text; 404 when `threads: false` ([threads](threads.md)) |
| `/api/forge/threads/<n>` | one thread's messages, as written (the opening text first), to read; 404 for a number that is no thread |
| `POST /api/forge/threads` `{ title, body }` | opens an idea: an issue with the label, as you; guarded and audited as above, JSON up to 96 KB, never cached |
| `/api/forge/deploys?limit=100` | the workflow runs that are deploys, with what the config says each restarted ([deploys](deploys.md)) |
| `/api/forge/release-notes?since=<tag>` | the notes since a tag: the groups, the Markdown, the tags to choose from (kept like the others) |
| `POST /api/forge/release-drafts` `{ tag, since?, name? }` | keeps the notes as a draft release for `tag` (never cached; guarded as above) |

At most 300 items a list. These paths are cornfield's own: a `proxy` entry for `/api/` in the config does not shadow them.

## The work graph

`GET /api/forge/work-graph` is the Work view's one request ([spec 0012](specs/0012-work-as-a-view.md)): the pieces of work as nodes, how they link to each other and to the map's code as edges, worked out on the server by [server/work-graph.js](../server/work-graph.js). It has the gate of every forge route (a signed-in maintainer of the configured repo: 401 signed out, 403 otherwise and without sign-in), is kept like the others (a minute per user, an `ETag`, `Cache-Control: no-cache` asks the forge again), and is not open to an embedding origin: it waits on the second embed key ([embedding](embedding.md)).

```json
{ "ok": true, "forge": "github", "repo": "owner/name", "at": "…", "rate": null,
  "nodes": [
    { "id": "pull:27", "kind": "pull", "stage": "build", "title": "Add the CSV export", "state": "open", "open": true, "waiting": false, "number": 27, "url": "…", "updated": "2026-11-12T09:00:00Z", "draft": false, "author": "agent-four" },
    { "id": "proposal:0100-retire", "kind": "proposal", "stage": "decide", "title": "Retire the export", "state": "to-decide", "open": true, "waiting": true, "slug": "0100-retire", "number": 41, "url": "…", "updated": "…" },
    { "id": "new-thing", "kind": "code", "planned": true, "label": "New thing", "type": "service" } ],
  "edges": [ { "from": "pull:27", "to": "issue:14", "rel": "closes" }, { "from": "proposal:0100-retire", "to": "new-thing", "rel": "adds" } ],
  "problems": [ { "source": "runs", "text": "The agent runs could not be read: …" } ] }
```

- **Nodes**, one per piece of work, with `id` (`thread:<n>`, `issue:<n>`, `proposal:<slug>`, `run:<runId>`, `pull:<n>`, `deploy:<id>`), `kind`, `stage` (`talk`: threads and issues; `decide`: proposals; `build`: runs and pull requests; `ship`: deploys), `title`, `state`, `open`, `waiting` (spec 0010's rule: a spec to decide, a run waiting on an answer), `url`, `updated`, and its `number`, `slug`, `runId` or `deployId`. `url` is an `http(s)` link or `null`. `title`, `author`, a planned node's `label` and `type` are text from the forge or from a pull request's files: render them as text, never as HTML. A spec PR is a `proposal` node (its pull request's number is `number`), not a `pull` node; when two spec PRs hold the same slug, the open one updated last is `proposal:<slug>` and the other `proposal:<slug>@<n>` (each is a row of the Specs list, and each counts); issues and pull requests share one run of numbers on both forges, so `thread:<n>` (an idea's issue, or a spec PR's conversation under the PR's number) is never also `issue:<n>`; an idea (an issue with the threads label) is a `thread`, not an `issue`. A node the map does not hold yet that a proposal adds is `{ id, kind: "code", planned: true, label, type }`; code that exists is on the map the page has, and is only named by edges.
- **Edges** `{ from, to, rel }`, never to an id that is neither a node of the answer, nor a node of the map, nor a planned one: `became` (idea to the proposal the spec PR names it in), `discusses` (a spec PR's conversation, or an idea's `cornfield-thread` block, to the proposal), `agent-on` (issue, thread or proposal to a run), `opened` (run to the pull request or spec PR it opened), `closes` (`Closes #n`, and the other words both forges close an issue by: close, closed, fix, fixes, fixed, resolve, resolves, resolved, in any case; not in code or an HTML comment, not another repo's `owner/name#n`, and never to a spec PR's conversation, since no keyword closes a pull request), `implements` (a pull request to the proposal whose build issue it closes, or that a code run on it opened), `shipped` (a merged pull request to the deploy at its merge commit; its head when the forge gave none), `changes` (a pull request's files, a proposal's changed nodes, a run's nodes), `adds` (a proposal's new nodes), `mentions` (an issue's or thread's `[[node]]`) and `restarts` (a deploy's restarts). A map node whose id looks like a work node's (`pull:3`) is left out of the edges and named in `problems`.
- **Which work**: open, and closed, merged or finished in the last 14 days. The closed pull requests are asked for most recently updated first and the closed issues updated since the window began, so an old issue closed today is in it; a list that comes back full (200 open issues, 100 closed pull requests or issues, 100 workflow runs reaching into the window) says so in `problems`.
- **What it costs**: a pull request's files are read once for a head commit and kept, as is a proposal's file; a refresh asks only for the lists (open and recently closed pull requests, issues, runs), a thread's comments when its last activity moved, and a spec PR's review state as the Specs list does. Every open pull request's files are read (the Specs list reads the same ones, and the two share what is kept, so a page that asks for both asks the forge once), so every open spec PR is drawn and `waiting` is the number the page shows; at most 50 other open pull requests (and 50 recently closed), 300 files each, 100 threads and 100 local drafts are drawn; the rest is named in `problems`. On a repo of 50 open pull requests of 300 files, 200 issues, 100 threads and 100 runs, a first answer is about 300 forge requests (six at a time; about 9 seconds at 150 ms a request) and a refresh where nothing moved about 8, so a page that refreshes it once a minute stays far inside GitHub's 5,000 an hour.
- **A source that cannot be read** (threads off, no runs store, a forge call refused or rate-limited) is a line in `problems` (`{ source, text }`); the rest of the graph is answered. Only when the forge cannot be asked at all and nothing was read is it the error, or the last answer with `stale`, as the other routes.

## Release notes

**Release notes …**, at the foot of the PRs list, drafts the notes for the next release from the pull requests merged since the last tag, grouped by what they changed on the map. It reads the forge and the map and changes nothing until you post.

- **Since.** The notes start from the highest version tag (`v1.2.3`; a tag that is not a version is not a release) unless you choose another from the list. A pull request counts when it merged into the repo's default branch after the commit that tag names was made; one merged into another branch (a release or backport branch, a stacked branch) is left out. With no version tag yet, every merged pull request counts. At most the newest 100 are read for their files; the line under the title says when there were more.
- **Groups follow the map's hierarchy.** Each file of a pull request lands on the deepest node whose `file` holds it, as in a pull request's files in the node panel above; that node's **area** is the app, package or other branch just below the root. A pull request is listed under each area it touched, with the nodes it changed there. One that touches nothing on the map goes under **Other**, last. Areas come in the map's own order.
- **Breaking** comes first: a pull request carrying the `breaking` label is listed there, and only there. Name another label with `releaseNotes: { breakingLabel: 'semver-major' }` in the [config](config.md).
- Each line links its pull request: `- Title ([#12](url) by @author) · node, node`. Titles are escaped, so a title cannot make a link, a heading or markup of its own. The same pull requests and the same map always give the same Markdown.
- **Copy** puts the Markdown on the clipboard; where the browser does not allow that, it selects the text and says to press Ctrl+C (Command+C on a Mac).
- **Post as draft** asks first: it shows the tag the draft is for (the package's version when that has no tag yet, else the next patch of the latest tag; change it) and says what will and will not happen, and only **Create the draft** sends anything. It creates a **draft release** on the forge and nothing more: it never publishes, and never makes or pushes a tag (a draft has none until it is published on the forge, by you). **What publishing then does is the forge's, not cornfield's:** when you publish the draft on GitHub or Forgejo and its tag does not exist yet, the forge creates the tag at that moment, on the default branch's head as it is then (which may have moved on since the notes were drafted), and a pushed `v*` tag is what starts this repo's release workflow ([RELEASING.md](../RELEASING.md)). So check the draft's target before you publish, or push the tag yourself first. That GitHub keeps a draft for a tag that does not exist without creating it is what its API documents and what the answer shows (the draft's address is `…/releases/tag/untagged-…`); it has not been tried against a live repo from here. Posting is one of the pipeline's steps in the [roadmap](roadmap.md); the rest of the page stays read-only.

What posting asks of the server, which is the only write in this panel:

- It is a `POST` from cornfield's own page only (the same check as the proposal review and sign-out), by a signed-in maintainer.
- The server asks the forge **again, at that moment,** who is signed in and whether they still maintain the repo; a maintainer demoted a minute ago is refused, in words.
- It writes a row to the audit (`actions` in `cornfield.db`: who, `release-draft`, `owner/name@tag`, the request) **before** the forge is asked, and the forge's answer after; if the row cannot be written, nothing is posted.
- The page sends only the tag (and the tag to start from). The server drafts the notes itself, from the forge and the map, so what is posted is what the preview says for the same inputs, never text from the page.

From a terminal, `cornfield notes [--since <tag>] [--breaking-label <label>]` prints the same Markdown on stdout (a line saying how many pull requests on stderr), so it pipes into a file or a release form. It reads the forge named in the config with the token in `CORNFIELD_FORGE_TOKEN` (a public repo answers without one, at the forge's lower limit), reads the map from `topology.json`, and changes nothing.

## On a phone

Below 768px the Work list and the node panel are bottom sheets, like the proposal bar (spec 0010 D7): a peek (the title and the line under it) until you tap or swipe the handle, then at most half the screen with its own scroll, and the map keeps at least 35% of it. **At most two sheets are open, and one of them is the review's**, so the list and the node panel take turns: selecting a row shows the node's sheet and the list folds away; the **List** toggle at the top left of the Work view brings the list back (the node stays selected, and tapping it opens its sheet again). This is also the phone's way into the work: the toggle is on the map, not behind a selected node.

## By keyboard and screen reader

The Work view's toggles are buttons: Tab reaches **List** (it says whether it is expanded); Enter opens the list with the focus on its title, and Tab goes on through the tabs (buttons, the one shown pressed), the Filter chip and the filters behind it, then the rows. A row is a button that says whether its piece of work is the one the node panel shows; Enter on it selects the node (the live region says its name, kind and state, and where it is among the nodes: "Pull request #27 · Add the CSV export, open, 3 of 24"), and the focus stays on the row, so the list can be read down. The node panel is where **Enter** on the map goes, and `Escape` comes back. On Release notes the focus goes through the tag list, the draft (a read-only text box you can scroll and select), Copy and Post as draft; the confirm step takes the focus to its tag field, Enter there creates the draft, and Escape or Cancel closes it with nothing sent and the focus back on the button. Escape closes the list and gives the focus back to the List toggle (a field keeps its own Escape). Closed, the list is inert. **Land it**, **Re-run**, **Start an agent** and a run's answer buttons are buttons in the node panel. Land it opens the confirm dialog (a `role="dialog"`, `aria-modal`, named by its title and described by what will land) with the focus on **Cancel**, so Enter does nothing risky; Tab and Shift+Tab move between Cancel and Land it and cannot leave the dialog, Escape or Cancel closes it with the focus back on the button, and the dialog's title, the commit and the checks are read out when it opens. While an action is running the buttons are off. A list loading, the filters' count, a pull request shown (its files, how many are on the map, its checks), a draft made, copied or posted, a failure and the list closing are all said through the map's live region ([accessibility](accessibility.md)). Colours are the explorer's theme tokens, so the list is right in light and dark; a state is a word as well as a colour.

## The Work view

The View switch's **Work** button (shown when the config names a forge) opens the map of work : threads, issues, proposals, agent runs, pull requests and deploys as nodes in four lanes (Talk, Decide, Build, Ship), then the code they touch, with a line for each link (`closes`, `changes`, `adds` dashed, `mentions` dotted; the three colours are `--corn-work-edge-work`, `-code` and `-adds`, [theming](theming.md)). Its badge is the number waiting on you, the Work button's own. Selecting a node dims all but it and its neighbours and names its lines; **Waiting on you** (top left) dims all but what waits. The Layers menu lists the six kinds, **Drafts** and "Code they touch", each on or off (Drafts starts off: those are proposals that are only files in the checkout, with no pull request, and nobody has been asked to decide them; on, they have a lane of their own beside Decide); the Map's layers are as you left them when you go back. The node panel shows the piece of work, what it is connected to (each a link) and its actions ([above](#the-node-panels-actions)); **List** opens the [Work list](#the-work-list). Search finds work by `#21`, `PR 21`, a spec's number or name, or words of a title; a result from another view opens the Work view on it.

It asks `GET /api/forge/work-graph` once when it opens, again on Refresh and every minute while it is open. The first answer of a big repository can take several seconds (about 300 forge requests): the view shows its lanes, empty, with "Reading the work from the forge" at once, and the page works meanwhile (the views, the Layers menu, search); a refresh keeps the last answer on the map, says "Updating…", and if it fails says so in a line under the toggles and keeps what it had. Signed out, not a maintainer or offline, the first answer is refused in the map's own card.

The lanes are laid out for the screen: a lane is cut into the columns that show the most at once, only what the layers show takes a place, and the first fit leaves room for the names under the nodes. The names are the map's own label placing (a name that would run into another is not drawn, except what waits, the selected node and its neighbours; the pointer names any node), the lanes' titles are lines of the page in screen space, and on a phone the lanes run top to bottom, Build and Ship together, with the code beside them and each piece of work named by its tag (`PR #27`).

By keyboard: `N` and `P` step through the lanes (Talk, Decide, the drafts, Build, Ship, then the code, most touched first), an arrow goes to the nearest node that way (`Shift` and an arrow still pan), `Enter` goes into the node panel and `Escape` comes back. The live region says the name, the kind and state, what waits on you and the place: "Spec 0100 · A new flow…, proposal, to decide, waiting on you, 2 of 24".

Addresses: `?view=work`; `?pr=21`, `?issue=14`, `?thread=31`, `?run=<id>` and `?spec=0100` (a number or a name) open it with that node selected. A piece of work the view does not draw (older than its 14 days, or past its limits: a link posted in chat weeks ago) opens the Work list on its tab and the node panel shows it, with its actions; `?issue=` finds an idea too (the forge numbers it as an issue; the view draws it as a thread). A number or a name that is nowhere is a line in the list, said through the live region, never a blank. The old panel had no `?work=…&tab=…` address, and none is added.

### The Work layer on the Map view

The Map view's Layers menu has one more row, **Work**, under Overlays beside Runs in flight ([spec 0012 D4](specs/0012-work-as-a-view.md)). It is **off by default**, and with it off nothing of it is on the page and nothing is asked of the server. It is there when the config names a forge and somebody is signed in (the same test as the Work view's **List** toggle); with no forge, or signed out, the row is absent and a remembered "on" asks for nothing. Its count says how many nodes of the map open work touches ("31 nodes"), or where the answer is: "reading…" while the first read is on its way, "not read yet" until the layer is first on, "sign in again", "offline" or "not read" when the forge could not be read. Whether it is on is kept in the browser like the other layers (`cornfield:layers`).

On, each node open work touches gets a small **badge** over it: `PR #27`, `Issue #14`, `Thread #31`, `Spec 0100`, `Run 000003` or `Deploy`, bordered in the kind's colour (`--corn-work-<kind>`). A node touched by several pieces of work shows the most pressing one, **what waits on you first**, then the newest, and `+N` for the rest ("Spec 0100 +2"). What touches a node is the graph's edges from work to code (`changes`, `adds`, `mentions`, `restarts`); only **open** work counts, a proposal that is only a file in the checkout (a Work view draft) does not, and a node a proposal plans (`adds` to something the map does not hold yet) has no badge. Badges are drawn in screen space (11 px at every zoom, centred over the node) and placed by the rules the names under the nodes follow (`placeLabels`): the names are placed first and never moved, the selected node's badge comes first, then those that wait on you, and a badge that would touch a name or another badge is not drawn, so zoomed out you see few and zoomed in more. Badges show on the Map view only (not Flow, House or Work) and not while a proposal is under review. The runs' pulse is a layer of its own and is unchanged.

**One read.** The layer and the Work view share the one request for the graph, its loading state and its once-a-minute poll: turning the layer on asks only when the Work view has not read it, the Work view opened while the layer's read is on its way waits for that read instead of starting another, and while the layer is off nothing is polled.

**Selecting a badged node** adds an **Open work** section first in the node panel: each piece of open work is a link to the Work view with it selected (`?view=work&pr=27`, so a new tab goes there too; a click opens the view in place), with an arrow to the forge only where the address is http(s). Every word from the forge is escaped.

By keyboard and screen reader: the row is a button in the Layers menu, in the tab order, with `aria-pressed` and its count in its name; `N` and `P` landing on a badged node add its work to what is said ("@big/analytics, pkg, 21 connections, 761 of 824, 3 open: Spec 0100 (waiting on you), PR #13, Issue #5"); the badges themselves are decoration (`aria-hidden`).

The Work list's **tab strip** scrolls sideways: a vertical mouse wheel over it moves it, the tab that is on is brought into view (the last, Deploys, to the end of the strip, clear of the fade), and Tab to a tab brings it whole into view.


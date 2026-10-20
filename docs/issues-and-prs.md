# Issues and pull requests

When the config names a forge (`forge: { type: 'github', repo: 'owner/name' }`, [config](config.md)) and a maintainer is signed in ([sign-in](sign-in.md)), the header has an **Issues & PRs** button. It opens a panel with the repo's pull requests and issues, and what a pull request changes is lit on the map. With no forge in the config, or without sign-in, the button and the panel are not there, and nothing else changes.

## The panel

- **Pull requests** and **Issues** are two lists, newest first, read through cornfield's server (the browser never talks to the forge, and never sees a token).
- **Filters** on what is loaded: state (a pull request is open, merged, or closed without landing; an issue open or closed), label, author, and a search over the title, number, author and labels. The line under the title says how many pass.
- A third tab, **Agents**, groups the work by issue and proposal and marks what agents made: [agents](agents.md).
- A row links out to the forge. An issue's whole row is the link (an open one also has **Start a spec**, below); a pull request's row selects it, with a link beside it.
- Rate limits and errors are a line in the panel in words ("GitHub's limit for this sign-in is used up; it resets at 21:14 UTC"), never a blank list. While the forge cannot be asked, the last answer cornfield saw is shown and says it is old. **Refresh** asks the forge again.

## A pull request lights the map

Select a pull request and the panel asks for its files and the checks on its head commit:

- Each **file** lights the node whose `file` holds it. When several nodes' `file`s hold it, the deepest wins: a node for the file itself, else the nearest folder above it (a package). A file that holds several nodes lights all of them. A renamed file lights the node of its old path as well.
- A **failing check** lights the test files its name names (`vitest test/server/auth.test.js` names that file; `lint` names none, and the panel says so). This is strict on purpose: a check is only taken to be about a file when its name says so, because lighting a test that did not fail is worse than lighting none. Most CI names its jobs (`test`, `build (22)`), so it lights only where a workflow names a job per test file; the check's link opens its log either way. Lighting from the failure itself (the files a check's annotations point at) needs the forge interface to read annotations, for both forges: a follow-up, not this panel.
- Lit nodes get the amber glow of a search match, the tests of a failing check turn red as well, and everything else fades back. Each node in the panel has a button that selects it on the map.
- A file on no node is listed, with the others, as "not on the map". Nothing is dropped.

Select the pull request again, or press **Clear**, to let go. Closing the panel leaves the lights on, and the button says which pull request they are (`#12`).

## The pipeline's own steps

Between an idea and a release there are three steps cornfield does for you, each **one button with a confirm step**, each guarded and audited like the actions below (they are [ADR 0006](adr/0006-safe-actions-only.md)'s "the pipeline's own steps"). None of them starts an agent ([ADR 0007](adr/0007-track-agents-do-not-launch.md)): they only make a branch, a file, a pull request or an issue on the forge, as you.

1. **Start a spec**, on an open issue in the Issues list. It makes a branch `spec/<nnnn>-<slug>` (`nnnn` is the issue's number in four digits at least, so the proposal reads and sorts like the others, `0013-meals`; the slug is the issue's title, lower case, at most 48 characters) from the config's `forge.baseBranch` (`main` when unset), one commit adding a stub proposal `<proposals folder>/<nnnn>-<slug>.json` (a title and a one-sentence summary that point back at the issue, and nothing a proposal would claim; it passes the proposal validator), and a **draft** pull request "Spec: <title>" whose description starts `Refs #<n>`. The spec then shows in the Proposals menu like any other spec PR, and the Proposals review applies.
2. **Open the build issue**, on a selected spec pull request that changes a proposal whose latest review by a maintainer approves the proposal **as the pull request's head holds it now** ([reviews](proposals.md)): an approval records the SHA-256 of the proposal file it covers, so a push that changes the file after the approval waits for a new one (the panel says "Changed since it was approved"). It opens an issue "Build: <proposal title>" that links the spec pull request, names the proposal and the commit it was read at, says who approved it, and lists the proposal as approved (the review's what-if edits folded in) as a checklist: each node to add, change and remove, then each edge. A proposal that is sent back, has no review, whose approval someone edited, or that a non-maintainer "approved" has no button; the panel says why.
3. **Land it**, on a green pull request: the same action as below, not a second one.

**The confirm step shows exactly what will be made.** Clicking the button asks the server for the *plan* (`GET`, read from the forge now) and shows it in the dialog: the issue or pull request, the branch, the file's whole text and the description in full. Confirming sends back only the plan's digest (and, for the build issue, the proposal and the commit that were shown); the server plans again from the forge and refuses (409) if it is not the same plan, so what is made is what was shown. A page cannot name the branch, the path or the text.

**A second click makes nothing twice.** If the plan finds what an earlier ask made (an open pull request from a `spec/<nnnn>-` branch for that issue; an issue whose description carries the step's `cornfield-build` marker for that pull request and proposal, closed or open; either one only when a maintainer opened it, so someone who can open an issue or a pull request cannot plant one to block a step), the panel says so, with a link, and shows no dialog; the action answers 200 with `created: false`. A half-made spec (the branch and the file are there, the pull request failed) is picked up where it stopped. A branch of that name with other work on it and no pull request is refused rather than committed onto: cornfield only ever *adds* a branch, a file, a pull request, an issue.

The build issue is found again by the forge's search for the proposal's name (GitHub's issue search; Forgejo's issue keyword search), together with the 100 newest issues, since a search index can lag a moment behind an issue just opened. Two people asking for the same step at once get one answer: the second is told to wait (429) while the first is being done, whoever they are.

**Text from a proposal or an issue does nothing in what is made.** It goes into a new issue or pull request as a code span, or with its markup turned into entities and every mention and reference broken by a zero-width space (`@​team`, `#​12`, `other/repo#​1`, `GH-​1`, `https:​//`). An entity is not enough on its own: Markdown turns `&#64;` back into `@` before the forge looks for mentions, so a proposal could otherwise ping people or cross-reference other repositories from your account.

**What a collaborator with write access can still do.** On both forges, someone with write access can edit or delete other people's issues and comments. They could paste the build marker into an existing maintainer's issue, so step 2 reports that issue as the one already made instead of opening a new one; or delete a maintainer's later Send back, so an earlier approval of the *same* file becomes the latest review again. Neither makes anything: the confirm step shows the issue found, or who approved and when, before anything is done. An edited review comment, and an approval of a different version of the file, never count. Give write access only to people you trust with the repo.

Both steps go through the checks of the table below (method, signed in, flood, maintainer now, same origin, JSON and 4 KB, twice, state) and are rows in the audit as `spec` (target `owner/name#<issue>`) and `build` (target `owner/name#<pull>/<proposal>`). Text from the forge or from a proposal (a node's label, a `why`) goes into the new issue only as a code span or with its markup, mentions and references turned into entities, so a proposal cannot ping anyone or close an issue from there.

## Land a green pull request, re-run a failed check

A selected pull request has two actions, for a signed-in maintainer; with the pipeline's two steps above they are the only things cornfield does to a forge. Never a force-merge, never a deploy, nothing that touches anything live.

- **Land it** is there when the pull request is open, not a draft, and every check on its head is green (a check that is neutral or skipped does not stand in the way, but at least one must have passed: no checks, or only skipped and neutral ones, is not green). Otherwise the panel says why in its place ("Not every check is green: lint failed; test is still running."). It opens a **confirm dialog** that shows exactly what will land: the pull request, its head commit, the branch it comes from and goes into, how it lands (the config's `forge.mergeMethod`: a merge commit, squashed, or rebased; `merge` when unset), and each check. **Land it** there lands that commit with the forge's own merge; **Cancel** or Escape does nothing.
- **Re-run** is on a failed or cancelled check the forge lets cornfield run again (a GitHub Actions job; a cancelled one is usually a newer push's concurrency group stopping it). A check that passed or is still running has none. A failed check the forge cannot re-run from here (a plain commit status, or anything on Forgejo) says so beside it, and where to do it.

Every answer is a line in the panel and is said through the live region ("Pull request #12 landed as fff0000.", "Pull request #12 was not landed: …"), and the panel then asks the forge again so the list and the checks are true.

### What the server checks again

The page is never trusted. Each action is a `POST` to cornfield's own server, which refuses in this order, in words, and writes the refusal down:

| | Refused when | Answer |
|---|---|---|
| Method | not `POST` | 405 |
| Signed in | no session (or no sign-in configured: nobody to act as) | 401 (403) |
| Flood | more than 60 attempts of any kind in a minute by one person: refused **without** writing a row, so a page on a sibling subdomain (same-site, so the cookie rides along) cannot grow the audit table | 429, with `Retry-After` |
| Maintainer | the guard says reader; and again, at that moment, the forge says the permission is no longer admin or maintain | 403 |
| Origin | the request is not from a page of this server (`Origin` and `Sec-Fetch-Site`, the `Host`), is not JSON, or is larger than 4 KB (answered at once, the rest not read) | 403, 415, 413 |
| Twice | the same action on the same target is already running or was asked in the last 5 seconds; more than 20 actions in a minute | 429, with `Retry-After` |
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

Another list, **Deploys**, shows the latest deploys (workflow runs) and lights the nodes a selected one restarted, from a mapping in the config. It has its own page: [deploys](deploys.md).

## Who it asks as

The server asks the forge as the signed-in maintainer, with their own token ([sign-in](sign-in.md)), through the same adapter as everything else. The lists and details only read; the actions above (landing, re-running, the pipeline's two steps) and the draft release are the only writes. Without sign-in (a tool on your own machine, Stage 1) there is nobody to ask as, so the panel is not offered and the routes answer 403 in words, as the Proposals menu lists no spec PRs then. Asking anonymously would work for a public repo, but every visitor would share the forge's unauthenticated limit (60 requests an hour on GitHub), with nothing kept between them.

Answers are kept in `cornfield.db` for a minute per user and request, with an ETag, so opening the panel is not a dozen API calls; **Refresh** goes past it.

The routes, for the curious (all behind the sign-in guard):

| Route | Answers |
|---|---|
| `/api/forge/issues?state=open\|closed\|all&labels=a,b&limit=100` | issues (not pull requests) |
| `/api/forge/pulls?state=open\|closed\|all&limit=100` | pull requests |
| `/api/forge/pulls/<n>` | one pull request with its files and the checks on its head (each check says whether cornfield can re-run it), and `specs`: the proposals it changes and whether a maintainer has approved each |
| `POST /api/forge/pulls/<n>/merge` `{ "sha" }` | lands it at that head, if green |
| `POST /api/forge/pulls/<n>/rerun` `{ "sha", "check" }` | re-runs one failed or cancelled check on that head |
| `GET /api/forge/issues/<n>/spec` | the plan of step 1: the branch, the file's text and the pull request it would make, or the pull request it made already (never kept) |
| `POST /api/forge/issues/<n>/spec` `{ "digest" }` | starts the spec, if the plan is still that one |
| `GET /api/forge/pulls/<n>/build?slug=<proposal>` | the plan of step 2: the issue it would open, or the one it opened already (never kept) |
| `POST /api/forge/pulls/<n>/build` `{ "slug", "sha", "digest" }` | opens the build issue, if the plan is still that one |
| `/api/forge/work` | what the Agents tab groups: pull requests and issues of any state, branches, open spec PRs and the `agents` rules ([agents](agents.md)) |
| `/api/forge/deploys?limit=100` | the workflow runs that are deploys, with what the config says each restarted ([deploys](deploys.md)) |
| `/api/forge/release-notes?since=<tag>` | the notes since a tag: the groups, the Markdown, the tags to choose from (kept like the others) |
| `POST /api/forge/release-drafts` `{ tag, since?, name? }` | keeps the notes as a draft release for `tag` (never cached; guarded as above) |

At most 300 items a list. These paths are cornfield's own: a `proxy` entry for `/api/` in the config does not shadow them.

## Release notes

The **Release notes** tab drafts the notes for the next release from the pull requests merged since the last tag, grouped by what they changed on the map. It reads the forge and the map and changes nothing until you post.

- **Since.** The notes start from the highest version tag (`v1.2.3`; a tag that is not a version is not a release) unless you choose another from the list. A pull request counts when it merged into the repo's default branch after the commit that tag names was made; one merged into another branch (a release or backport branch, a stacked branch) is left out. With no version tag yet, every merged pull request counts. At most the newest 100 are read for their files; the line under the title says when there were more.
- **Groups follow the map's hierarchy.** Each file of a pull request lands on the deepest node whose `file` holds it, as in the panel above; that node's **area** is the app, package or other branch just below the root. A pull request is listed under each area it touched, with the nodes it changed there. One that touches nothing on the map goes under **Other**, last. Areas come in the map's own order.
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

Below 768px the panel is a bottom sheet, like the node panel and the proposal bar: a peek (its title and the line under it) until you tap or swipe its handle, then half the screen with its own scroll. Selecting a node from it collapses the sheet, so the map and the node's own sheet show.

## By keyboard and screen reader

Tab reaches the button in the header; Enter opens the panel with the focus on its title, and Tab goes on through the lists, the filters and the rows. On Release notes it goes through the tag list, the draft (a read-only text box you can scroll and select), Copy and Post as draft; the confirm step takes the focus to its tag field, Enter there creates the draft, and Escape or Cancel closes it with nothing sent and the focus back on the button. Escape closes it and gives the focus back to the button (a field keeps its own Escape). Closed, the panel is inert. **Land it** and **Re-run** are buttons in the selected pull request's section. Land it opens the confirm dialog (a `role="dialog"`, `aria-modal`, named by its title and described by what will land) with the focus on **Cancel**, so Enter does nothing risky; Tab and Shift+Tab move between Cancel and Land it and cannot leave the dialog, Escape or Cancel closes it with the focus back on the button, and the dialog's title, the commit and the checks are read out when it opens. While an action is running the buttons are off. A list loading, the filters' count, a pull request selected (its files, how many are on the map, its checks), a draft made, copied or posted, a failure and closing are all said through the map's live region ([accessibility](accessibility.md)). Colours are the explorer's theme tokens, so the panel is right in light and dark; a state is a word as well as a colour.

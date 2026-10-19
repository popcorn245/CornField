# Issues and pull requests

When the config names a forge (`forge: { type: 'github', repo: 'owner/name' }`, [config](config.md)) and a maintainer is signed in ([sign-in](sign-in.md)), the header has an **Issues & PRs** button. It opens a panel with the repo's pull requests and issues, and what a pull request changes is lit on the map. With no forge in the config, or without sign-in, the button and the panel are not there, and nothing else changes.

## The panel

- **Pull requests** and **Issues** are two lists, newest first, read through cornfield's server (the browser never talks to the forge, and never sees a token).
- **Filters** on what is loaded: state (a pull request is open, merged, or closed without landing; an issue open or closed), label, author, and a search over the title, number, author and labels. The line under the title says how many pass.
- A row links out to the forge. An issue's whole row is the link; a pull request's row selects it, with a link beside it.
- Rate limits and errors are a line in the panel in words ("GitHub's limit for this sign-in is used up; it resets at 21:14 UTC"), never a blank list. While the forge cannot be asked, the last answer cornfield saw is shown and says it is old. **Refresh** asks the forge again.

## A pull request lights the map

Select a pull request and the panel asks for its files and the checks on its head commit:

- Each **file** lights the node whose `file` holds it. When several nodes' `file`s hold it, the deepest wins: a node for the file itself, else the nearest folder above it (a package). A file that holds several nodes lights all of them. A renamed file lights the node of its old path as well.
- A **failing check** lights the test files its name names (`vitest test/server/auth.test.js` names that file; `lint` names none, and the panel says so). This is strict on purpose: a check is only taken to be about a file when its name says so, because lighting a test that did not fail is worse than lighting none. Most CI names its jobs (`test`, `build (22)`), so it lights only where a workflow names a job per test file; the check's link opens its log either way. Lighting from the failure itself (the files a check's annotations point at) needs the forge interface to read annotations, for both forges: a follow-up, not this panel.
- Lit nodes get the amber glow of a search match, the tests of a failing check turn red as well, and everything else fades back. Each node in the panel has a button that selects it on the map.
- A file on no node is listed, with the others, as "not on the map". Nothing is dropped.

Select the pull request again, or press **Clear**, to let go. Closing the panel leaves the lights on, and the button says which pull request they are (`#12`).

## Land a green pull request, re-run a failed check

A selected pull request has two actions, for a signed-in maintainer, and they are the only things cornfield does to a forge. Never a force-merge, never a deploy, nothing that touches anything live.

- **Land it** is there when the pull request is open, not a draft, and every check on its head is green (a check that is neutral or skipped does not stand in the way; no checks at all is not green). Otherwise the panel says why in its place ("Not every check is green: lint failed; test is still running."). It opens a **confirm dialog** that shows exactly what will land: the pull request, its head commit, the branch it comes from and goes into, the merge made by the forge, and each check. **Land it** there lands that commit with the forge's own merge; **Cancel** or Escape does nothing.
- **Re-run** is on a failed check the forge lets cornfield run again (a GitHub Actions job). A check that passed, is still running or was cancelled has none. A failed check the forge cannot re-run from here (a plain commit status, or anything on Forgejo) says so beside it, and where to do it.

Every answer is a line in the panel and is said through the live region ("Pull request #12 landed as fff0000.", "Pull request #12 was not landed: …"), and the panel then asks the forge again so the list and the checks are true.

### What the server checks again

The page is never trusted. Each action is a `POST` to cornfield's own server, which refuses in this order, in words, and writes the refusal down:

| | Refused when | Answer |
|---|---|---|
| Method | not `POST` | 405 |
| Signed in | no session (or no sign-in configured: nobody to act as) | 401 (403) |
| Maintainer | the guard says reader; and again, at that moment, the forge says the permission is no longer admin or maintain | 403 |
| Origin | the request is not from a page of this server (`Origin` and `Sec-Fetch-Site`, the `Host`), or is not JSON | 403, 415 |
| Twice | the same action on the same target is already running or was asked in the last 5 seconds; more than 20 actions in a minute | 429, with `Retry-After` |
| State | the pull request is not open, is a draft, or a check is not green | 409 |
| Head | the commit the page showed is not the pull request's head now (somebody pushed): look again | 409 |
| Re-run | the check is not on that head, has not failed, or the forge cannot run it again | 409 |

The merge itself goes through the forge interface's `merge(n, { onlyIfGreen: true, sha })`, which reads the pull request and its checks once more and asks the forge to land that commit only (GitHub's `sha`, Forgejo's `head_commit_id`): a push in between makes the forge refuse rather than land untested code. There is no force option and no admin override to ask for.

### The audit

Every attempt is a row in the `actions` table of `cornfield.db`: when, who, `merge` or `rerun`, the target (`owner/name#12`, or `owner/name#13/run:42`), the request (the number, the commit, the check), and the status and answer. It is written before the forge is asked and finished after, so a refusal, a forge error and a success are all there; a row with no status is an attempt that did not get an answer. If the table cannot be written, nothing is done (503). Read it with any SQLite tool: `SELECT at, login, action, target, status FROM actions ORDER BY id DESC`.

## Who it asks as

The server asks the forge as the signed-in maintainer, with their own token ([sign-in](sign-in.md)), through the same adapter as everything else. The lists and details only read; the two actions above are the only writes. Without sign-in (a tool on your own machine, Stage 1) there is nobody to ask as, so the panel is not offered and the routes answer 403 in words, as the Proposals menu lists no spec PRs then. Asking anonymously would work for a public repo, but every visitor would share the forge's unauthenticated limit (60 requests an hour on GitHub), with nothing kept between them.

Answers are kept in `cornfield.db` for a minute per user and request, with an ETag, so opening the panel is not a dozen API calls; **Refresh** goes past it.

The routes, for the curious (all behind the sign-in guard):

| Route | Answers |
|---|---|
| `/api/forge/issues?state=open\|closed\|all&labels=a,b&limit=100` | issues (not pull requests) |
| `/api/forge/pulls?state=open\|closed\|all&limit=100` | pull requests |
| `/api/forge/pulls/<n>` | one pull request with its files and the checks on its head (each check says whether cornfield can re-run it) |
| `POST /api/forge/pulls/<n>/merge` `{ "sha" }` | lands it at that head, if green |
| `POST /api/forge/pulls/<n>/rerun` `{ "sha", "check" }` | re-runs one failed check on that head |

At most 300 items a list. These paths are cornfield's own: a `proxy` entry for `/api/` in the config does not shadow them.

## On a phone

Below 768px the panel is a bottom sheet, like the node panel and the proposal bar: a peek (its title and the line under it) until you tap or swipe its handle, then half the screen with its own scroll. Selecting a node from it collapses the sheet, so the map and the node's own sheet show.

## By keyboard and screen reader

Tab reaches the button in the header; Enter opens the panel with the focus on its title, and Tab goes on through the lists, the filters and the rows. Escape closes it and gives the focus back to the button (a field keeps its own Escape). Closed, the panel is inert. **Land it** and **Re-run** are buttons in the selected pull request's section. Land it opens the confirm dialog (a `role="dialog"`, `aria-modal`, named by its title and described by what will land) with the focus on **Cancel**, so Enter does nothing risky; Tab and Shift+Tab move between Cancel and Land it and cannot leave the dialog, Escape or Cancel closes it with the focus back on the button, and the dialog's title, the commit and the checks are read out when it opens. While an action is running the buttons are off. A list loading, the filters' count, a pull request selected (its files, how many are on the map, its checks), a failure and closing are all said through the map's live region ([accessibility](accessibility.md)). Colours are the explorer's theme tokens, so the panel is right in light and dark; a state is a word as well as a colour.

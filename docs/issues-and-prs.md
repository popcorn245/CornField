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

## Deploys

A third list, **Deploys**, shows the latest deploys (workflow runs) and lights the nodes a selected one restarted, from a mapping in the config. It has its own page: [deploys](deploys.md).

## Who it asks as

The server asks the forge as the signed-in maintainer, with their own token ([sign-in](sign-in.md)), through the same adapter as everything else; it only reads. Without sign-in (a tool on your own machine, Stage 1) there is nobody to ask as, so the panel is not offered and the routes answer 403 in words, as the Proposals menu lists no spec PRs then. Asking anonymously would work for a public repo, but every visitor would share the forge's unauthenticated limit (60 requests an hour on GitHub), with nothing kept between them.

Answers are kept in `cornfield.db` for a minute per user and request, with an ETag, so opening the panel is not a dozen API calls; **Refresh** goes past it.

The routes, for the curious (all `GET`, all behind the sign-in guard):

| Route | Answers |
|---|---|
| `/api/forge/issues?state=open\|closed\|all&labels=a,b&limit=100` | issues (not pull requests) |
| `/api/forge/pulls?state=open\|closed\|all&limit=100` | pull requests |
| `/api/forge/pulls/<n>` | one pull request with its files and the checks on its head |
| `/api/forge/deploys?limit=100` | the workflow runs that are deploys, with what the config says each restarted ([deploys](deploys.md)) |

At most 300 items a list. These paths are cornfield's own: a `proxy` entry for `/api/` in the config does not shadow them.

## On a phone

Below 768px the panel is a bottom sheet, like the node panel and the proposal bar: a peek (its title and the line under it) until you tap or swipe its handle, then half the screen with its own scroll. Selecting a node from it collapses the sheet, so the map and the node's own sheet show.

## By keyboard and screen reader

Tab reaches the button in the header; Enter opens the panel with the focus on its title, and Tab goes on through the lists, the filters and the rows. Escape closes it and gives the focus back to the button (a field keeps its own Escape). Closed, the panel is inert. A list loading, the filters' count, a pull request selected (its files, how many are on the map, its checks), a failure and closing are all said through the map's live region ([accessibility](accessibility.md)). Colours are the explorer's theme tokens, so the panel is right in light and dark; a state is a word as well as a colour.

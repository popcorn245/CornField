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

## Who it asks as

The server asks the forge as the signed-in maintainer, with their own token ([sign-in](sign-in.md)), through the same adapter as everything else; it only reads, except for the one draft release described above. Without sign-in (a tool on your own machine, Stage 1) there is nobody to ask as, so the panel is not offered and the routes answer 403 in words, as the Proposals menu lists no spec PRs then. Asking anonymously would work for a public repo, but every visitor would share the forge's unauthenticated limit (60 requests an hour on GitHub), with nothing kept between them.

Answers are kept in `cornfield.db` for a minute per user and request, with an ETag, so opening the panel is not a dozen API calls; **Refresh** goes past it.

The routes, for the curious (all `GET` but the last, all behind the sign-in guard):

| Route | Answers |
|---|---|
| `/api/forge/issues?state=open\|closed\|all&labels=a,b&limit=100` | issues (not pull requests) |
| `/api/forge/pulls?state=open\|closed\|all&limit=100` | pull requests |
| `/api/forge/pulls/<n>` | one pull request with its files and the checks on its head |
| `/api/forge/release-notes?since=<tag>` | the notes since a tag: the groups, the Markdown, the tags to choose from (kept like the others) |
| `POST /api/forge/release-drafts` `{ tag, since?, name? }` | keeps the notes as a draft release for `tag` (never cached; guarded as above) |

At most 300 items a list. These paths are cornfield's own: a `proxy` entry for `/api/` in the config does not shadow them.

## Release notes

A third tab, **Release notes**, drafts the notes for the next release from the pull requests merged since the last tag, grouped by what they changed on the map. It reads the forge and the map and changes nothing until you post.

- **Since.** The notes start from the highest version tag (`v1.2.3`; a tag that is not a version is not a release) unless you choose another from the list. A pull request counts when it merged after the commit that tag names was made. With no version tag yet, every merged pull request counts. At most the newest 100 are read for their files; the line under the title says when there were more.
- **Groups follow the map's hierarchy.** Each file of a pull request lands on the deepest node whose `file` holds it, as in the panel above; that node's **area** is the app, package or other branch just below the root. A pull request is listed under each area it touched, with the nodes it changed there. One that touches nothing on the map goes under **Other**, last. Areas come in the map's own order.
- **Breaking** comes first: a pull request carrying the `breaking` label is listed there, and only there. Name another label with `releaseNotes: { breakingLabel: 'semver-major' }` in the [config](config.md).
- Each line links its pull request: `- Title ([#12](url) by @author) · node, node`. Titles are escaped, so a title cannot make a link, a heading or markup of its own. The same pull requests and the same map always give the same Markdown.
- **Copy** puts the Markdown on the clipboard; where the browser does not allow that, it selects the text and says to press Ctrl+C (Command+C on a Mac).
- **Post as draft** asks first: it shows the tag the draft is for (the package's version when that has no tag yet, else the next patch of the latest tag; change it) and says what will and will not happen, and only **Create the draft** sends anything. It creates a **draft release** on the forge and nothing more: it never publishes, and never makes or pushes a tag (a draft has none until it is published on the forge, by you). Posting is one of the pipeline's steps in the [roadmap](roadmap.md); the rest of the page stays read-only.

What posting asks of the server, which is the only write in this panel:

- It is a `POST` from cornfield's own page only (the same check as the proposal review and sign-out), by a signed-in maintainer.
- The server asks the forge **again, at that moment,** who is signed in and whether they still maintain the repo; a maintainer demoted a minute ago is refused, in words.
- It writes a row to the audit (`actions` in `cornfield.db`: who, `release-draft`, `owner/name@tag`, the request) **before** the forge is asked, and the forge's answer after; if the row cannot be written, nothing is posted.
- The page sends only the tag (and the tag to start from). The server drafts the notes itself, from the forge and the map, so what is posted is what the preview says for the same inputs, never text from the page.

From a terminal, `cornfield notes [--since <tag>] [--breaking-label <label>]` prints the same Markdown on stdout (a line saying how many pull requests on stderr), so it pipes into a file or a release form. It reads the forge named in the config with the token in `CORNFIELD_FORGE_TOKEN` (a public repo answers without one, at the forge's lower limit), reads the map from `topology.json`, and changes nothing.

## On a phone

Below 768px the panel is a bottom sheet, like the node panel and the proposal bar: a peek (its title and the line under it) until you tap or swipe its handle, then half the screen with its own scroll. Selecting a node from it collapses the sheet, so the map and the node's own sheet show.

## By keyboard and screen reader

Tab reaches the button in the header; Enter opens the panel with the focus on its title, and Tab goes on through the lists, the filters and the rows. On Release notes it goes through the tag list, the draft (a read-only text box you can scroll and select), Copy and Post as draft; the confirm step takes the focus to its tag field, Enter there creates the draft, and Escape or Cancel closes it with nothing sent and the focus back on the button. Escape closes it and gives the focus back to the button (a field keeps its own Escape). Closed, the panel is inert. A list loading, the filters' count, a pull request selected (its files, how many are on the map, its checks), a draft made, copied or posted, a failure and closing are all said through the map's live region ([accessibility](accessibility.md)). Colours are the explorer's theme tokens, so the panel is right in light and dark; a state is a word as well as a colour.

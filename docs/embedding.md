# Embedding: letting another app of yours in

By default cornfield answers only its own page. With `embed.origins` you can list the origin of **another app of your own** (a task board, an internal portal) so that a page there can read the map and the proposals, and decide a review, as the maintainer who is signed in to cornfield in the same browser. This page has two halves. [The server's](#the-key): what it lets in, what it does not, and what listing an origin means; nothing there is on until you list an origin. [The components](#the-components): cornfield's interface as web components you put on your own page, which need no server at all when you hand them the data yourself.

```js
// cornfield.config.js, served at https://map.example.com
export default {
  embed: { origins: ['https://tasks.example.com'] },
};
```

## The key

`embed.origins` is a list of origins, each written exactly: a scheme, a host and an optional port, like `https://tasks.example.com` or `https://tasks.example.com:8443`.

- **No path, not even a trailing slash**, no query, no fragment, no user name, no wildcard (`https://*.example.com` is refused: list each one).
- **`https` only.** Plain `http` is allowed for this machine's own names, so a page you are building can use it: `localhost`, any `*.localhost`, `127.0.0.1` and `[::1]`.
- The scheme and host are lower-cased and a default port is dropped, so the same origin written two ways is one entry. At most 20.
- **Empty or absent by default**, which is how cornfield has always behaved: with nothing listed, every response is what it was without the key.

A wrong entry stops cornfield (and `cornfield validate`) with the entry's place and what is wrong, in words, for example `embed.origins[1] "https://tasks.example.com/" has a path, query or fragment (a trailing slash counts): list the origin only, like https://tasks.example.com.`

## What a listed origin may read

A page on a listed origin that calls `fetch(url, { credentials: 'include' })` gets an answer it can read, from these routes and no others:

| Route | |
|---|---|
| `/cornfield/config.json`, `/topology.json`, `/topology.cloud.json` | what the map is made from |
| `/proposals`, `/proposals/<slug>.json`, `/proposals/<slug>/decision`, `/proposals/<slug>/mockups` | the proposals, the facts the line above Approve is made from, and the list of a proposal's mockups (not the files) |
| `/proposals/<slug>/review` | the latest review (and, below, the one write) |
| `/api/forge/pulls/<n>` | one pull request, with its files and checks (the proposal bar reads it) |
| `/cornfield/theme.css`, `/cornfield/theme/<name>.css`, `/cornfield/theme/assets/…` | the look, so a component there can wear it |
| `/cornfield/components/<file>` | the web components themselves, as module scripts ([below](#from-the-server)); open without a session |

For a request whose `Origin` is exactly a listed origin the answer carries `Access-Control-Allow-Origin: <that origin>` (never `*`), `Access-Control-Allow-Credentials: true`, `Vary: Origin` and `Access-Control-Expose-Headers: X-Proposal-Sha256, X-Proposal-Source, X-Proposals-Forge-Error` (the headers the explorer reads from a proposal). The refusals on these routes carry them too, so the page can tell "sign in" (401) from "not found". The theme routes answer without a session and carry no `Allow-Credentials`: they hold nothing the session decides, so fetch them without credentials (the default).

The browser's preflight (`OPTIONS`) is answered, before the sign-in guard because a preflight carries no cookie, for the methods and the one request header (`Content-Type`) each route needs and no others.

**Everything else gets no CORS header, so the browser keeps it out of the page**: the routes that make or list tokens (`/api/review-tokens`, `/api/agent-tokens`), agent runs, every other `/api/forge/…` route, the explorer's own files, and the sign-in routes. Those wait for a later step and a second key.

## What a listed origin may write

Two writes, and only these:

- **`PUT /proposals/<slug>/review`**: Approve or Send back, as the signed-in maintainer.
- **`POST /api/forge/pulls/<n>/landing/cancel`**: the Undo of an approval's hold ([land on approval](proposals.md#land-on-approval)).

cornfield's own rule for a write stays: it comes from cornfield's own page. A listed origin is accepted for these two as well when **all** of these hold: the `Origin` header is there and is exactly a listed origin; `Sec-Fetch-Site` is `same-site` (or is not sent, as a browser too old to send it still sends `Origin` on a cross-origin write, and its cookie would not travel from another site anyway; any other value, `cross-site` included, is refused); the `Host` check passes; and there is a signed-in maintainer's session, which every write needs. Every other write from a listed origin is refused exactly as a stranger's is, and does nothing.

## What listing an origin means

**Every script that runs on a listed origin can ask cornfield as the maintainer who is signed in, and decide a review.** Cross-site scripting on that app, a browser extension that injects into it, a dependency that is compromised: each can read what the maintainer can read and approve what the maintainer can approve, while they are signed in to cornfield. List only an app you would trust with your own login, keep its own scripts under a Content-Security-Policy, and list as few origins as you can.

A loopback origin (`http://localhost:5173`, `http://tasks.localhost:5173`) is whatever program on this machine listens on that port, so list one only while you use it, and take it out before cornfield is shared.

**The cookie does not change.** It stays `HttpOnly`, `SameSite=Lax` and host-only (no `Domain`). So a page that is not cornfield never sees it, and it travels only on a request that is **same-site** with cornfield: the page and cornfield must share a registrable domain, like `tasks.example.com` and `map.example.com` (both `example.com`). A port is part of an origin but not of a site, so `localhost:5173` and `localhost:3350` are the same site. If the two are different sites (`tasks.example.org` and `map.example.com`), the browser does not send the cookie, a read answers `401`, and listing the origin does not change that.

**The public-suffix limit.** A "site" is the domain just under a public suffix. If both apps sit under a suffix that many unrelated people share (`a.co.uk` and `b.co.uk`, or two names under a hosting platform's shared domain, where each customer gets a name of their own), they are different sites, and the cookie will not travel; give both apps names under a domain you own. The reverse matters too: any page on a name under that same domain (`blog.example.com`) is same-site with cornfield, and a browser sends the cookie on its simple requests (a GET, a form post) even when that page is not listed. cornfield's own checks refuse such a write (the origin must be cornfield's or a listed one for two routes), and the page cannot read the answer, but if you run untrusted pages under the same domain, give cornfield a domain of its own.

## Signing in and returning

An embedded page that gets `401` sends the maintainer to cornfield to sign in, and cornfield sends them back:

```
https://map.example.com/auth/start?returnTo=https%3A%2F%2Ftasks.example.com%2Freviews%2F7
```

`returnTo` is read only when at least one origin is listed (with none, it is ignored, as it always was), and is honoured only when it is an absolute URL whose origin is cornfield's own or exactly a listed origin (the path, query and fragment are kept). Anything else (another host, `https://tasks.example.com.evil.test`, a user name in the URL, a backslash, another scheme or port, `//host`, `javascript:`) is ignored, and the sign-in ends where it always has: on cornfield's map (or on `return`, the same-origin path parameter, which keeps its rules and never takes an absolute URL).

## What does not change

- **cornfield cannot be framed**: `frame-ancestors 'none'` and `X-Frame-Options: DENY` stay on every response. A listed origin reads cornfield's data; it does not show cornfield's page in a frame.
- **The Content-Security-Policy of cornfield's own page** (everything from its own origin) is unchanged.
- **The `Host` check** (421 for any `Host` that is not a loopback name or the public URL's host) runs first, on every route, listed origin or not.
- **The session cookie** (above), and the sign-in itself.

## What the host app's own Content-Security-Policy needs

The host app's policy governs what its pages may fetch. If it has one, allow cornfield's origin for what you use:

- `connect-src https://map.example.com`: the `fetch` calls above.
- `style-src https://map.example.com` for the theme's stylesheets, `font-src https://map.example.com` for the fonts they name, and `img-src https://map.example.com` for its images (all under `/cornfield/theme…`).
- `script-src https://map.example.com` when you load the components from the server ([the exact policy](#the-hosts-content-security-policy-for-the-components)).

## Behind a reverse proxy

The proxy must pass `Origin`, `Sec-Fetch-Site` and `Host` through unchanged, answer `OPTIONS` by passing it on (cornfield answers the preflight), and must not add its own `Access-Control-*` headers: two of them make the browser refuse the answer.

## Trying it on one machine

Chromium resolves `*.localhost` to this machine, so two names are two origins that are also the same site. `node test/fixtures/big/embed-proof.mjs` ([the rig's README](../test/fixtures/big/README.md)) serves a blank host page and a cornfield on two such names, signs in, and shows what the browser sent and what came back for a listed origin, an unlisted one on the same site and a page on a different site.

## The components

cornfield's interface is also a set of web components, built with [StencilRS](https://github.com/popcorn245/StencilRS), that another app puts on its own page. Each is a thin shell over the same engine cornfield's own page runs (`explorer/pieces/`), so a map in your app is the map you see in cornfield: the same drawing, the same keys, the same way a tap selects. So far there are three: [`<corn-review>`](#corn-review-the-one-tag-review), a proposal on the map with Approve and Send back, in one tag; [`<corn-map>`](#properties-events-and-methods); and [`<corn-scope>`](#corn-scope-and-src-reading-a-cornfield-server), which reads a cornfield server for the pieces inside it (`<corn-scope>` and a map's `src` come with the release after 0.48.0, `<corn-review>` with the one after that).

### Getting the components

Two ways, one build, one version number. The root package (`cornfield` on npm) has no part in either: it takes no dependency and has no build step, and a checkout that runs `node cli/cornfield.js` builds nothing.

#### From the server

Every cornfield **image** serves the components at `/cornfield/components/`, so they always match the server they talk to and a host needs one line:

```html
<script type="module" src="https://map.example.com/cornfield/components/corn-map.js"></script>
```

Your page's origin has to be in `embed.origins` (above): a browser fetches a module script from another origin with CORS, and without the cookie, and cornfield answers CORS only for a listed origin. For `https://tasks.example.com` the answer to the script and to each chunk it imports carries:

```
Access-Control-Allow-Origin: https://tasks.example.com
Vary: Origin
```

and no `Access-Control-Allow-Credentials` (the modules are fetched without the cookie). From an origin that is not listed there is no `Access-Control-Allow-Origin`, so the browser refuses the module and the tag stays an unknown element; with no origin listed at all, nothing is added to any response.

What is there (the files of the build, and only those; `manifest.json` lists them and is not itself served, a request for any other name, a folder, a dotfile or a path out of the folder is a plain 404):

| File | What it is |
|---|---|
| `corn-review.js` | registers `<corn-review>`: load this one for the review ([below](#corn-review-the-one-tag-review)) |
| `corn-map.js` | registers `<corn-map>`: load this one for the map |
| `corn-scope.js` | registers `<corn-scope>` ([below](#corn-scope-and-src-reading-a-cornfield-server)) |
| `index.js` | registers every component, and exports `version` |
| `chunks/runtime-<hash>.js` | the Stencil runtime, shared by every entry |
| `chunks/_corn-default-tokens-<hash>.js` | the engine every component shares, with the default tokens (the bundler names a shared chunk after its first module) |
| `chunks/map-<hash>.js` | the map piece and what only it draws with |
| `chunks/corn-review-<hash>.js` | the review: the proposal's bar, the change list and the scenario player, the node panel and the decision (the review loads it, and nothing else does) |
| `chunks/scope-<hash>.js` | a scope: `corn-scope.js` loads it at once, `corn-map.js` only when a map has a `src` |
| `chunks/status-<hash>.js`, `chunks/source-address-<hash>.js` | reading a server, its states and the server's theme (and the address checks): what a map with a `src`, a scope and a review with a `src` share |
| `chunks/review-source-<hash>.js` | what a review's `src` brings: loaded by `corn-review.js` only when a review has one |
| `chunks/rolldown-runtime-<hash>.js` | a few lines the bundler shares between chunks |
| `tokens.css` | cornfield's default tokens at zero specificity (optional: [Tokens](#tokens-and-the-theme-attribute)) |
| `version.json` | `{ "name": "@popcorn245/cornfield-components", "cornfield": "0.48.0" }` |
| `types/*.d.ts` | the declarations, as text |

**Caching.** Each answer has a strong `ETag` and the file's type with `nosniff`, and is compressed when the browser accepts it. `chunks/…-<hash>.js` are named by their content, so they are cached for a year (`public, max-age=31536000, immutable`). `corn-map.js`, `corn-scope.js`, `index.js`, `tokens.css`, `version.json` and the types are `no-cache`: the browser asks every time and gets a `304` when nothing changed, so a host always gets the version of the server it talks to, the moment that server is updated.

**It is open.** The route answers before the sign-in guard, like the theme's stylesheets, because a module script is fetched without the cookie. It holds no secret: it is the published package, the same files as on GitHub and npm. What anyone who can reach the server learns from it, signed in or not:

- the components' code, their type declarations and `tokens.css`;
- **which cornfield this is**: the release number is in `version.json` and in `index.js` (`export const version`); `manifest.json` carries it too but is never served. A signed-out visitor could not learn it before: `/cornfield/config.json`, which also carries it, is behind the sign-in. It is kept open on purpose: a host needs it to tell a mismatch, and the code of every version is public anyway. Keep the server updated, as with any version you publish;
- whether this server was built with the components (an image) or runs from a checkout (the `404` says so).

Nothing of the map, the proposals, the repo, the config or the session is reachable this way. `Host` is checked before this route answers (`421` for a name the server does not answer to), and only `GET` and `HEAD` are answered here: any other method on these paths goes to the sign-in guard as before.

**A checkout has no build.** cornfield has no build step, so a server started from a plain checkout has no components and answers `/cornfield/components/…` with a plain `404` that says so and how to build them (`cd components && npm ci && npm run build`: the server then serves `components/dist`, the one place it looks, beside its own `server/`). The image builds them while it is built and keeps only the result.

#### From npm

```sh
npm install @popcorn245/cornfield-components
```

```js
import '@popcorn245/cornfield-components/corn-review';  // registers <corn-review>
import '@popcorn245/cornfield-components/corn-map';     // registers <corn-map>
import '@popcorn245/cornfield-components/corn-scope';   // registers <corn-scope>; '@popcorn245/cornfield-components' registers every component
```

**On npm since 0.48.0**, published by each release with a provenance attestation ([RELEASING.md](../RELEASING.md#the-web-components-on-npm)). The package has the same files as above (`dist/`), the type declarations (`types` in its `exports`), and `"sideEffects": true`: importing a module is what registers its custom element, so a bundler must not drop an `import '…/corn-map'` that uses nothing from it (`true` tells it not to).

**One version.** The components are released with cornfield under the same number: `@popcorn245/cornfield-components@0.48.0` is the build of cornfield `0.48.0`, the one that cornfield's image serves, and `version.json`, the `version` export and the package say the same. Each release builds them with the version it just made. For a page that talks to a server, use the server's copy; if you install the package, keep it at your server's version: a scope or a map with `src` shows a notice when the two differ by a minor or more ([versions](#what-the-person-sees-and-what-is-said)).

#### Building them yourself

```sh
cd components
npm ci
npm run build        # dist/: ES modules, tokens.css, types/, version.json and manifest.json
npm run dev          # the demo page, http://localhost:3639/demo/: two maps from the synthetic fixture, one light and one dark
npm run check        # build, tests in happy-dom, tests in headless Chrome, the size budget (set CHROME_PATH where there is no Google Chrome)
```

### `<corn-review>`: the one-tag review

A maintainer reviews a proposal and presses **Approve** or **Send back** inside your own app, with one tag:

```html
<script type="module" src="https://map.example.com/cornfield/components/corn-review.js"></script>

<corn-review src="https://map.example.com" proposal="0042-retire-the-old-export"></corn-review>
```

It reads the map and the proposal from the cornfield server `src`, as the maintainer who is signed in to it in the same browser, and shows them as cornfield's own page does: the proposal on the map narrowed to the change, its bar (the proposal's name, the copy under review, what it adds, changes and removes, **Before**, **Diff**, **After**, **Whole map**), the change list with the personas and scenarios and the scenario player, the node panel for what is selected, and at the foot of the list the decision: one line that says what Approve will do in this exact state, **Send back** and **Approve**. It is one engine with cornfield's page (`explorer/pieces/review.js`): the same drawing, keys, words, hold and refusals.

**What it needs:**

- **A listed origin and a signed-in maintainer.** Your page's origin is in the server's [`embed.origins`](#the-key), the two are on one site ([signing in](#signing-in-and-returning)), and the maintainer has signed in to cornfield in this browser. Without that the review says so, in its box ([below](#what-the-person-sees-and-what-is-said-in-a-review)).
- **A height from your page.** The element is `display: block` and fills **100% of the box your page gives it**; give it a height with your own CSS (`corn-review { height: 680px }`, a grid cell, a flex child). With none it is 24rem tall (the minimum of the box inside), so a review dropped in is visible, and it is never lower than that, however much room you leave. A host page's `html { font-size }` changes what 24rem is. About **1100 by 680** is comfortable: the change list sits at the left, the bar on top, the node panel on the right. **Under 768px by its own width** (not the window's) it is cornfield's phone layout, with the bar and the list as bottom sheets; give it a tall box there (390 by 700 works).
- **The policy** of [a host that loads the components from the server](#the-hosts-content-security-policy-for-the-components): `script-src` and `connect-src` for the server's origin (and `img-src` for the theme's icons). It makes no inline style and no `eval`; the styles are constructable stylesheets.
- **Nothing else of your page's**: it asks no other route and no other origin ([what it asks](#what-it-asks-and-with-what)).

| Property | Attribute | What it is |
|---|---|---|
| `src` | `src` | the server's base address (`https://map.example.com`, with an optional path). Another value is refused and said (`address`), and nothing is asked: not even the proposal, of your own page's origin in its place. Read when the element connects: **a new `src` is a new review** (it is made again) |
| `proposal` | `proposal` | the proposal's **name** (`0042-retire-the-old-export`), which the review reads from the server once it has the map; or, as a property only, the proposal **object**, shown for reading with no request for it (no Approve or Send back: a decision needs the name and the copy). `null` closes it. Not reflected |
| `source` | `source` | which copy of the proposal: `checkout`, `pull/31` (a spec PR, the only kind a decision can be made on) or a worktree's name. With none, the server answers with the first copy it lists |
| `view` | `view` (reflected) | `before`, `diff` or `after`. Set it to choose; **it follows the reviewer's own choice** on the bar, so reading it gives what is shown |
| `node` | `node` (reflected) | the id of the selected node. Set it to select; it follows a click or a key, as a map's does |
| `theme` | `theme` (reflected) | `light`, `dark`, or `auto` (the default): the ground the review is drawn for, as on `corn-map` ([Tokens](#tokens-and-the-theme-attribute)) |
| `useTheme` | `use-theme` | wear the server's theme ([below](#the-servers-theme-use-theme)): its rules go into this shadow root and its `--corn-*` tokens onto this element, and nothing into your document |
| `topology`, `config` | none | for a host that fetches for itself: the objects `topology.json` and `/cornfield/config.json` hold. With both, the review reads neither from the server (it still reads the proposal, and decides, there) |
| `strings` | none | your own words (`strings` keys to text). **When you set it, it is the words spoken**: the server's are not mixed in (as on a scope) |
| `checker` | none | the permission checker for the scenarios' checked steps, **a module your page imported itself**: `{ check(items, { signal }) }` ([plugins](config.md#sources)). A config never names one that is loaded ([config never becomes script](#corn-scope-and-src-reading-a-cornfield-server)); with none a checked step reads "Not checked" |

| Event | `detail` |
|---|---|
| `cornReady` | none: the map is drawn and the proposal asked for is open (or has said why it is not), once each time the element is put in the page |
| `cornSelect` | once per change of the selection, whoever made it: the same as `corn-map`'s. Its fields: `id`, `kind`, `source`, `from`, `to`. `kind` is `node` or `edge`, or null when cleared; `id` is the node's id, `from->to` for an edge, or null; `source` is `tap`, `keyboard`, `api` or `state` |
| `cornNavigate` | the open proposal or its view changed: **what cornfield's own page would have put in its address bar**. Your page decides what to do with it (set its own address, keep it in state, ignore it); the component never touches `location` or `history`. Its fields: `proposal`, `source`, `view`, `change`. `proposal` is the name (null once closed, or for a proposal handed in as an object); `source` is the copy only when it was asked for by name (as the page leaves it out of the address otherwise); `view` is `before`, `diff` or `after`, or null once closed; `change` is `opened`, `view` or `closed` |
| `cornDecision` | the server took Approve or Send back, **after it answered**, once per decision. Its fields: `outcome`, `proposal`, `source`, `open`, `review`. `outcome` is `approved` or `notes`; `proposal` and `source` name the proposal **the decision was for**, read when the button was pressed (never from what is open when the answer comes); `open` is false when another proposal was opened, or this one closed, while it was sent; `review` is what the server answered: `{ verdict, at, by, posted, … }` (`posted: false` when the same approval stood already, and nothing new was posted) |
| `cornAuth` | the server answered a read or the press with 401 or 403: the maintainer has to sign in. The review shows [the card](#what-the-person-sees-and-what-is-said-in-a-review); your page may show its own. Its fields: `status`, `signIn`, `during`. `signIn` is `<src>/auth/start?returnTo=<this page>`; `during` says what was refused: `load` (the map), `proposal` (opening it), `facts` (the line above Approve), `review` (reading the last decision), `send` (the press) or `landing` (Undo) |
| `cornError` | something the review could not do. Its fields: `kind`, `message`. `kind` is `not-listed`, `offline`, `server`, `address`, `version`, `theme` (as [a map's](#what-the-person-sees-and-what-is-said)) or `proposal` (the proposal did not open: there is none of that name, or the server refused or failed; `message` is what the bar says) |

Events bubble and cross the shadow root (`composed`). `cornSelect` and `cornNavigate` fire for a change you made yourself as well; setting `proposal`, `view` or `node` to what is shown already does nothing and says nothing, so **answering an event by setting the property it describes does not loop** (set `proposal` to the name `cornNavigate` gave and the proposal stays open, whichever copy the server found). `cornAuth` with `during: 'facts'` is said once, not every half minute while the poll is refused.

| Method | What it does |
|---|---|
| `fit()` | puts the whole map in view |
| `focusNode(id)` | selects the node and brings it and what it lights into view (nothing happens when there is no such node) |
| `refresh()` | reads the tokens again and draws, as a map's does |

All three return a promise.

```js
const review = document.querySelector('corn-review');
review.addEventListener('cornNavigate', (e) => myRouter.replace({ proposal: e.detail.proposal, view: e.detail.view }));
review.addEventListener('cornDecision', (e) => {
  if (e.detail.outcome === 'approved') myTask.markReviewed(e.detail.proposal, e.detail.source);
});
review.addEventListener('cornAuth', (e) => console.info('sign in at', e.detail.signIn));
```

#### What the person sees, and what is said, in a review

The states of the load are the ones [a map shows](#what-the-person-sees-and-what-is-said) (loading, signed out, not a maintainer, not listed, offline, a server error, a bad address, and the version notice), in **the same card, with the same words, hooks, parts and `strings` keys**, in the middle of the review's stage while the review has no map; once the map is drawn they are gone. They are the load's, so a review needs nothing for them but the tag.

- **Signing in.** Signed out, the card says "You are not signed in to cornfield" and holds a real link, "Sign in to cornfield", to `<src>/auth/start?returnTo=<this page's address>`, with `target="_top"`: following it (or your page doing so with `signIn` from `cornAuth`) takes the browser to cornfield and back to your page, where the review loads and the proposal is open. A review does not navigate by itself. The server follows `returnTo` only for a listed origin, and the address the maintainer comes back to is whatever your page's address is: **put what the review needs to open (the proposal) in that address**, which `cornNavigate` gives you what to write.
- **A session that ends while a review is open.** A read or a press the server refuses with 401 or 403 puts **the same card, with the same link**, over the map (the line above Approve and the decision say it in words too, and keep what was typed: a note is not lost), and `cornAuth` says what was refused. A decision that is taken afterwards (the person signed in in another tab and pressed again) takes the card away.
- **A proposal that cannot be opened** is said in the bar, in words: "There is no proposal called 0099-nothing." (with the same name under another source, from the list the server gives, as a button, when it has one), or why the server failed, with Retry and Close. There is **no "Open the specs list"** here: that list is cornfield's own page's, and a button that goes nowhere is left out. `cornError` says `proposal` once. A session that may not read it shows the sign-in card.
- **A proposal with no copy on a spec PR** (a draft in the checkout or a worktree) can be looked at but not decided on: the foot says to push it as a spec PR to review it ([proposals](proposals.md)).

#### What a decision does

The same as on cornfield's page, one engine. **Approve** takes no note: one line above it says what it will do in this exact state (the PR, its checks, whether it lands, whether a run waits for a runner); a press with something the maintainer should know first (checks failed, a draft) asks first, in place; then a **hold of five seconds with Undo**, the focus on Undo, before anything leaves the page, and the end of the hold reads the facts once more. **Send back** opens a note field (the focus goes to it; Cancel gives the focus back to Send back) and needs a note. What is sent is what was on screen at the press, with the version it was about (`sha256` of the proposal, `headSha` of the PR): **the server refuses a version or a head the page was not shown** (409: someone pushed since), a maintainer who is one no longer (403) and a missing sign-in (401), and answers a repeat of an approval that stands with that one, posting nothing (`posted: false`). Each refusal and each failure is a line in the foot, never an `alert`, and the note stays. Closing the proposal, opening another, hiding the tab, going offline, Undo and Escape each stop a hold, and say so.

`cornDecision` is said **once the server has answered**, never before, with the answer. After an approval the proposal's PR is approved on the forge as the signed-in maintainer, and the server lands it when the checks allow (the line above Approve says if it will). After a Send back the note is posted on the PR, for the agent drafting the spec to read. What your app does with it (mark a task reviewed, move a card) is yours.

#### What it asks, and with what

The rows of the [request table](#corn-scope-and-src-reading-a-cornfield-server) above: the config and the map, the proposal, the facts, the last review, the PR's chip, and for a decision the two writes (`PUT /proposals/<name>/review` and `POST /api/forge/pulls/<n>/landing/cancel`), **all with the session** (`credentials: 'include'`) **and only to `src`'s own origin**; the theme without. Every one is on a route of the server's [list](#what-a-listed-origin-may-read), and nothing is asked of any other origin. The requests a decision makes are byte for byte what cornfield's own page sends for the same steps, but for the address being absolute and `credentials: 'include'` (`test/fixtures/big/review-proof.mjs` records both and compares).

#### What it does not do yet

- **Only the map reads a server through a scope so far.** A scope shares its instance with one map; the node panel, Layers and search come as pieces of their own. (A `<corn-review>` reads a server on its own: it is not inside a scope yet.)
- **No proposal on a map alone.** A proposal drawn on the map, with its Before, Diff and After, is the review's: [`<corn-review>`](#corn-review-the-one-tag-review).
- **No panels.** Selecting a node says so through `cornSelect`; what to show for it is your app's. The node panel, Layers and search are later components (the review has the node panel inside it).
- **No freeform positions.** Dragging a node and saving where it was put are cornfield's own page's; a map in your page stores nothing in your page's storage.
- **Reduced motion** is read when the map is made: under it the flow packets stand still and the camera jumps where it would glide, as on the page.

### The size it adds

The build records the gzipped size of the shared runtime, of `corn-map` and of `corn-review` with their engine, of each with what a `src` brings, and of `corn-scope` with what it loads, in `components/size-budget.json`, and CI fails when any grows by more than 5%: `npm run size:record` writes the new numbers when a growth is on purpose. Today (gzip, level 9, besides the shared runtime, which is 28.1 kB): **`corn-map` with its engine 82.2 kB**, which is all a map you hand its data loads; a `corn-map` with a `src` loads 11 kB more, once, when it first has one; **`corn-review` 142.0 kB** (the map, the proposal's bar, the change list and player, the node panel and the decision), and **151.2 kB** with a `src` (9 kB for the load, the card and the server's theme, in `chunks/review-source-<hash>.js`, loaded only for a `src`); `corn-scope` with what it loads 64.1 kB. The components share the engine's chunks and make no second copy of it, so a page with a review and a map loads the engine once. The price of sharing is that a map alone now loads what the review uses of the modules they share: `corn-map` was 70.7 kB before the review arrived (about 11 kB less).

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

## Behind a reverse proxy

The proxy must pass `Origin`, `Sec-Fetch-Site` and `Host` through unchanged, answer `OPTIONS` by passing it on (cornfield answers the preflight), and must not add its own `Access-Control-*` headers: two of them make the browser refuse the answer.

## Trying it on one machine

Chromium resolves `*.localhost` to this machine, so two names are two origins that are also the same site. `node test/fixtures/big/embed-proof.mjs` ([the rig's README](../test/fixtures/big/README.md)) serves a blank host page and a cornfield on two such names, signs in, and shows what the browser sent and what came back for a listed origin, an unlisted one on the same site and a page on a different site.

## The components

cornfield's interface is also a set of web components, built with [StencilRS](https://github.com/popcorn245/StencilRS), that another app puts on its own page. Each is a thin shell over the same engine cornfield's own page runs (`explorer/pieces/`), so a map in your app is the map you see in cornfield. So far there is one: `<corn-map>`.

**Not published yet.** The package, `@popcorn245/cornfield-components`, is private for now and is not on npm, and cornfield's server does not serve it yet. You build it from a checkout of cornfield, and the root package (`cornfield` on npm, the image) has no part in it: it takes no dependency and has no build step.

```sh
cd components
npm ci
npm run build        # dist/: ES modules, tokens.css, types/ and version.json
npm run dev          # the demo page, http://localhost:3639/demo/: two maps from the synthetic fixture, one light and one dark
npm run check        # build, tests in happy-dom, tests in headless Chrome, the size budget (set CHROME_PATH where there is no Google Chrome)
```

### Loading it

The build is ES modules: one file per component, one for all, and a shared chunk that holds the Stencil runtime. Copy `dist/` to where your app serves its files (or import it from your bundler) and load the one you want:

```html
<script type="module" src="/vendor/cornfield/corn-map.js"></script>   <!-- or index.js: every component -->
<link rel="stylesheet" href="/vendor/cornfield/tokens.css">           <!-- optional: see Tokens below -->

<corn-map id="map"></corn-map>
<script>
  const map = document.querySelector('#map');
  map.topology = await (await fetch('/my/topology.json')).json();     // the object topology.json holds: { nodes, edges }
  map.addEventListener('cornSelect', (e) => openMyPanel(e.detail.id));
</script>
```

`corn-map` with a `topology` is complete: it asks no server for anything. (Fetching from a cornfield server with `src`, and showing a proposal, come with later components: they are not in `<corn-map>` yet.) The package's types declare the tag: `document.querySelector('corn-map')` is an `HTMLCornMapElement`, its properties are typed, and `addEventListener('cornSelect', …)` gives a typed `detail`.

### Properties, events and methods

| Property | Attribute | What it is |
|---|---|---|
| `topology` | none | the map to draw: the object `topology.json` holds. It is not changed: the map works on copies |
| `node` | `node` (reflected) | the id of the selected node. Set it to select; it follows a click or a key, so reading it gives the selection |
| `view` | `view` | `map` (default) or `dataflow` |
| `theme` | `theme` (reflected) | `light`, `dark`, or `auto` (the default): see Tokens |
| `renderer` | `renderer` | `auto` (WebGL2 when there is one, default) or `canvas2d` |

| Event | `detail` |
|---|---|
| `cornSelect` | `{ id, kind }` after every change of the selection, whoever made it (a click, a key, `node`, `focusNode()`): `kind` is `node` (an `edge` comes with proposals) and `id` is null when it was cleared |
| `cornReady` | none: the first frame with a map in it is drawn |

Events bubble and cross the shadow root, so a listener on any ancestor hears them. `cornSelect` fires for a change you made yourself with `node` as well, and setting `node` to what it already is does nothing, so handling the event by setting `node` does not loop.

| Method | What it does |
|---|---|
| `fit()` | puts the whole map in view |
| `focusNode(id)` | selects the node and brings it into view (nothing happens when there is no such node) |
| `refresh()` | reads the tokens again and draws: for a change the map cannot see (a rule added to the page's head, a class on `<html>`) |

All three return a promise.

### Sizing

The element is `display: block` and **fills the box its host gives it**: give `corn-map` a width and a height with your own CSS (`corn-map { height: 520px }`, a grid cell, a flex child) and the map follows it when it changes. With no height it is as tall as a small floor (16rem), so a map dropped in is visible. Nothing inside is sized from the window: a map in a 400px column of a wide window is a 400px map. The element keeps `display` for itself (a page's `* { all: revert }` would make it inline and give it no box); `[hidden]` hides it as usual.

### Tokens and the `theme` attribute

Every `--corn-*` token of cornfield's theme contract ([theming.md](theming.md)) inherits into the shadow root, and the map reads its own from the element, so **a map is themed like any other element: with CSS custom properties**.

- **The defaults.** The first `corn-*` element on a page adds cornfield's default tokens to the document, once (`document.adoptedStyleSheets`), generated from `explorer/tokens.css` at build time with every selector at **zero specificity** (`:where(...)`). So any ordinary rule of yours overrides them: `:root { --corn-ground: #101a2e }` for every map, `.tasks { --corn-accent: #7a3e00 }` for the maps in one wrapper, `#board-map { --corn-map-node-app: #c0392b }` for one. The same sheet ships as `tokens.css` for a page that prefers a `<link>`.
- **Light and dark.** With no `theme` attribute, the page's own `<html data-theme="light|dark">`, else the system's `prefers-color-scheme`, decides, as on cornfield's own page (and the map follows when either changes). `theme="light"` or `theme="dark"` forces that mode for the element: the generated sheet declares that mode's tokens on the element itself. So to change a token for a forced element, put the rule **on that element** (`#board-map { --corn-ground: … }`); a rule on `:root` reaches an element that follows the page but not one that is forced.
- **Two maps, two sets of tokens** work: each map reads the tokens at its own element.
- **After changing a token at run time** with something the map cannot see, call `map.refresh()`. Changing the `theme` attribute does it for you.
- **One limit.** Inside a shadow root a rule cannot ask what `<html>` says, so a theme that restyles a part by light or dark has to do it through tokens.

### Parts

Every `data-corn` hook inside a component is also a `part` of the same name, so your CSS can reach one element: `corn-map::part(map-stage) { background: #fff }`. `corn-map` has `map-stage` (the box the canvases sit in), `map-canvas`, `label-canvas` and `map-overlay`. A `[data-corn="…"]` rule of your page does not reach into a shadow root; a theme written against hooks needs `::part()`, or tokens. The tags, properties, events, methods and parts are public: [theming.md](theming.md#web-components-tags-properties-events-methods-and-parts) lists them, and a test holds the list against the source.

### Keyboard and screen readers

The canvas is focusable (Tab), named "Topology map", and described by the map's keys. Its keys act **only while focus is inside the map**: arrows pan, `+` and `-` zoom, `0` fits, `N` and `P` (or `]` and `[`) select the next and the previous node, `Home` and `End` the first and the last, `F` frames the selected node and what it lights, `Escape` clears the selection. What the keyboard landed on is said in a polite live region inside the map. A key the map handled is marked `defaultPrevented`, and is not stopped: your own handlers still see it, and can tell by that flag that the map took it.

### What it does not do yet

- **No `src`, no fetching.** The map draws what you hand it. Reading from a cornfield server (and so the server half above) belongs to `corn-scope`, a later component.
- **No proposal.** A proposal drawn on the map, with its Before, Diff and After, comes with the review components.
- **No panels.** Selecting a node says so through `cornSelect`; what to show for it is your app's. The node panel, Layers and search are later components.
- **No freeform positions, no flights.** Dragging a node, saving where it was put, and the animated camera are cornfield's own page's; `focusNode()` moves the camera at once.
- **Reduced motion** is read when the map is made (the flow packets stand still), as on the page.
- **Not served by cornfield yet, and not on npm.** One `<script>` line from a server, and `npm install`, come later.

### The size it adds

The build records the gzipped size of the shared runtime and of `corn-map` with its engine in `components/size-budget.json`, and CI fails when either grows by more than 5%: `npm run size:record` writes the new numbers when a growth is on purpose.


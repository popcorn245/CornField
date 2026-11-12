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

cornfield's interface is also a set of web components, built with [StencilRS](https://github.com/popcorn245/StencilRS), that another app puts on its own page. Each is a thin shell over the same engine cornfield's own page runs (`explorer/pieces/`), so a map in your app is the map you see in cornfield: the same drawing, the same keys, the same way a tap selects. So far there is one: `<corn-map>`.

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
| `corn-map.js` | registers `<corn-map>`: load this one for the map |
| `index.js` | registers every component, and exports `version` |
| `chunks/runtime-<hash>.js` | the Stencil runtime, shared by every entry |
| `chunks/corn-map-<hash>.js` | the map and the engine it wraps |
| `tokens.css` | cornfield's default tokens at zero specificity (optional: [Tokens](#tokens-and-the-theme-attribute)) |
| `version.json` | `{ "name": "@popcorn245/cornfield-components", "cornfield": "0.48.0" }` |
| `types/*.d.ts` | the declarations, as text |

**Caching.** Each answer has a strong `ETag` and the file's type with `nosniff`, and is compressed when the browser accepts it. `chunks/…-<hash>.js` are named by their content, so they are cached for a year (`public, max-age=31536000, immutable`). `corn-map.js`, `index.js`, `tokens.css`, `version.json` and the types are `no-cache`: the browser asks every time and gets a `304` when nothing changed, so a host always gets the version of the server it talks to, the moment that server is updated.

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
import '@popcorn245/cornfield-components/corn-map';   // registers <corn-map>; '@popcorn245/cornfield-components' registers every component
```

**Published from the next release once the maintainer adds the npm token** ([RELEASING.md](../RELEASING.md#the-web-components-on-npm)); until then the package is built in every release but not on npm, and the server is the way. The package has the same files as above (`dist/`), the type declarations (`types` in its `exports`), and `"sideEffects": true`: importing a module is what registers its custom element, so a bundler must not drop an `import '…/corn-map'` that uses nothing from it (`true` tells it not to).

**One version.** The components are released with cornfield under the same number: `@popcorn245/cornfield-components@0.48.0` is the build of cornfield `0.48.0`, the one that cornfield's image serves, and `version.json`, the `version` export and the package say the same. Each release builds them with the version it just made. For a page that talks to a server, use the server's copy; if you install the package, keep it at your server's version (a later component with `src` will say when they differ by a minor or more).

#### Building them yourself

```sh
cd components
npm ci
npm run build        # dist/: ES modules, tokens.css, types/, version.json and manifest.json
npm run dev          # the demo page, http://localhost:3639/demo/: two maps from the synthetic fixture, one light and one dark
npm run check        # build, tests in happy-dom, tests in headless Chrome, the size budget (set CHROME_PATH where there is no Google Chrome)
```

### Loading it

The build is ES modules: one file per component, one for all, and a shared chunk that holds the Stencil runtime. Load it from the server (above), import it from your bundler, or copy `dist/` to where your app serves its files, and load the one you want:

```html
<script type="module" src="/vendor/cornfield/corn-map.js"></script>   <!-- or index.js: every component -->
<link rel="stylesheet" href="/vendor/cornfield/tokens.css">           <!-- optional: see Tokens below -->

<corn-map id="map"></corn-map>
<script type="module">
  const map = document.querySelector('#map');
  map.topology = await (await fetch('/my/topology.json')).json();     // the object topology.json holds: { nodes, edges }
  map.addEventListener('cornSelect', (e) => openMyPanel(e.detail.id));
</script>
```

`corn-map` with a `topology` is complete: it asks no server for anything. (Fetching from a cornfield server with `src`, and showing a proposal, come with later components: they are not in `<corn-map>` yet.)

**Types.** The package declares the tag: `document.querySelector('corn-map')` is an `HTMLCornMapElement`, its properties are typed, `addEventListener('cornSelect', …)` gives a typed `detail` (`CornSelectDetail`), and `document.createElement('corn-map')` knows the element. For JSX, `LocalJSX.IntrinsicElements` holds the tag with its properties and an `onCornSelect` handler; merge it into your framework's own JSX namespace, for React:

```ts
import type { LocalJSX } from '@popcorn245/cornfield-components';
declare module 'react' { namespace JSX { interface IntrinsicElements extends LocalJSX.IntrinsicElements {} } }
```

### With a Content-Security-Policy

`<corn-map>` works under a strict policy such as `default-src 'self'; style-src 'self'`, with no `'unsafe-inline'` and no `'unsafe-eval'`, as long as you serve the files from your own origin (or load them from a cornfield server: [the exact policy](#the-hosts-content-security-policy-for-the-components)):

- **Scripts:** the modules, from wherever you serve `dist/` (`script-src 'self'`, or that origin). They run no `eval`, start no worker and make no `blob:` or `data:` URL.
- **Styles:** the component's own styles and the default tokens are constructable stylesheets (`adoptedStyleSheets`), which a policy does not govern, so `style-src` needs nothing for them. A `<link>` to `tokens.css` needs `style-src` to allow where it is served.
- **Connections and images:** none. The map draws what you hand it.

(A browser without constructable stylesheets would fall back to a `<style>` element for the default tokens, which such a policy blocks; every browser that runs the components has them.) Tried in headless Chrome with that policy as a response header and a page whose own CSS resets every element: no violation reported, and the map is styled and drawn.

### The host's Content-Security-Policy for the components

If the host page has a Content-Security-Policy and loads the components from a cornfield server (`https://map.example.com`), this is what it needs, and it is enough (a page under exactly this policy loads the map from a listed origin and draws it, in `components/test/host.test.ts`):

```
Content-Security-Policy: default-src 'self'; script-src 'self' https://map.example.com; connect-src 'self' https://map.example.com; img-src 'self' https://map.example.com; style-src 'self'
```

- `script-src https://map.example.com`: the entry and the chunks it imports. Nothing else of the components is script: no `eval`, no worker, no `blob:` or `data:` URL.
- `connect-src https://map.example.com`: for the `fetch` calls your page (and later components with `src`) make to the server, `version.json` among them. `<corn-map>` with a `topology` makes none.
- `img-src https://map.example.com`: for the images of the server's theme, which a map draws.
- `style-src 'self'` and **no `'unsafe-inline'`**: the components' styles are constructable stylesheets, which `style-src` does not govern, so nothing inline is needed. Add `https://map.example.com` to `style-src` only if you link its `tokens.css` or the theme's stylesheets from there, and to `font-src` if the theme names fonts.

When you install from npm and bundle, `script-src 'self'` is enough for the components.

### Properties, events and methods

| Property | Attribute | What it is |
|---|---|---|
| `topology` | none | the map to draw: the object `topology.json` holds. It is not changed: the map works on copies. A new object replaces the map (the selection stays when the new one has the node); what is not a node or an edge is left out |
| `node` | `node` (reflected) | the id of the selected node. Set it to select; it follows a click or a key, so reading it gives the selection. A node the map has not got yet is selected when a topology brings it |
| `view` | `view` | `map` (default) or `dataflow` |
| `theme` | `theme` (reflected) | `light`, `dark`, or `auto` (the default): see Tokens |
| `renderer` | `renderer` | `auto` (WebGL2 when there is one, default) or `canvas2d` |

| Event | `detail` |
|---|---|
| `cornSelect` | once per change of the selection, whoever made it. Its fields: `id`, `kind`, `source`, `from`, `to`. `kind` is `node` or `edge`, or null when the selection was cleared (and `id` is null). `id` is the node's id, or `from->to` for an edge, whose ends are also in `from` and `to`. `source` says who: `tap`, `keyboard`, `api` (`node` or `focusNode()`), or `state` (a new topology without the selected node) |
| `cornReady` | none: the first frame with a map in it is drawn, once each time the element is put in the page |

Events bubble and cross the shadow root, so a listener on any ancestor hears them. `cornSelect` fires for a change you made yourself with `node` as well (`source` is `api`), and setting `node` to what is already selected does nothing and says nothing, so handling the event by setting `node` does not loop.

| Method | What it does |
|---|---|
| `fit()` | puts the whole map in view |
| `focusNode(id)` | selects the node and brings it and what it lights into view (nothing happens when there is no such node) |
| `refresh()` | reads the tokens again and draws: for a token you change at run time where the map cannot see it (a stylesheet added to your page's head, a class or a style on a wrapper) |

All three return a promise. The map follows by itself the changes it can see: its `theme`, your `<html data-theme>` or class, and the system's light or dark; `refresh()` is for the rest.

### Sizing and layout

The element is `display: block` and **fills the box its host gives it**: give `corn-map` a width and a height with your own CSS (`corn-map { height: 520px }`, a grid cell, a flex child) and the map follows it when it changes. With no height it is 16rem tall, so a map dropped in is visible. Nothing inside is sized from the window: a map in a 400px column of a wide window is a 400px map.

- **Your rules on the element win**: its display (a class with `display: none` hides it), its size, its margins. Nothing of the element's own is `!important` except `[hidden]`, which always hides it.
- **The 16rem minimum is the stage's**, inside the shadow root, so a page that resets every element (`* { all: revert }`) still gets a visible map (the element itself goes inline, as such a page asks). To make a map lower than 16rem, say so on the part too: `corn-map { height: 120px } corn-map::part(map-stage) { min-height: 0 }`.
- **It can wait unseen**: made inside a parent with `display: none`, or in a box of no size, it is fitted to its box when it gets one.
- **A parent may scale it**: a tap lands on the node under it inside a `transform: scale()` or a CSS `zoom`, in a scrolled container, and on a right-to-left page. Under a CSS `zoom` the map is drawn at its unzoomed size and scaled, so it is softer.
- **One element, one map.** Two on a page are two maps (each its own selection, camera and tokens); moved in the page, an element makes new canvases; removed, it ends its map and gives its WebGL context back, so making and removing many does not run the browser out of contexts.
- **A large map** is laid out when it is set, on the main thread: 5,000 nodes and 15,000 edges took 1.8 s before the first frame in headless Chrome on the machine the tests run on.

### The wheel and touch

On your page **the wheel is your page's while the pointer only passes over the map**: the page scrolls. The map takes the wheel, to zoom, when it has the focus (a click on it, or Tab) or while Ctrl or Cmd is held, which is also how a trackpad's pinch arrives. On a touch screen a finger on the map pans it and two fingers zoom it, so the page does not scroll from inside the map: leave room around a map that fills a phone's width. (cornfield's own page, which is all map, zooms with the wheel as always.)

### Tokens and the `theme` attribute

Every `--corn-*` token of cornfield's theme contract ([theming.md](theming.md)) inherits into the shadow root, and the map reads its own from the element, so **a map is themed like any other element: with CSS custom properties**.

- **The defaults.** The first `corn-*` element on a page adds cornfield's default tokens to the document, once (`document.adoptedStyleSheets`; a second copy of the package on the page finds the first's sheet and adds none), generated from `explorer/tokens.css` at build time with every selector at **zero specificity** (`:where(...)`). So any ordinary rule of yours overrides them: `:root { --corn-ground: #101a2e }` for every map, `.tasks { --corn-accent: #7a3e00 }` for the maps in one wrapper, `#board-map { --corn-map-node-app: #c0392b }` for one. An element inside a shadow root of your own adds the sheet to that root as well, once, for the rules on its `theme` attribute. The same sheet ships as `tokens.css` for a page that prefers a `<link>`.
- **Light and dark.** With no `theme` attribute, your page's own `<html data-theme="light|dark">`, else the system's `prefers-color-scheme`, decides, as on cornfield's own page (and the map follows when either changes). `theme="light"` or `theme="dark"` forces that mode for the element: the generated sheet declares that mode's tokens on the element itself. So to change a token for a forced element, put the rule **on that element** (`#board-map { --corn-ground: … }`); a rule on `:root` reaches an element that follows the page but not one that is forced.
- **Two maps, two sets of tokens** work: each map reads the tokens at its own element.
- **After changing a token at run time** where the map cannot see it, call `map.refresh()`. Changing the `theme` attribute, or your `<html>`'s `data-theme` or class, needs no call.
- **One limit.** Inside a shadow root a rule cannot ask what `<html>` says, so a theme that restyles a part by light or dark has to do it through tokens.

### Parts

Every `data-corn` hook inside a component is also a `part` of the same name, so your CSS can reach one element: `corn-map::part(map-stage) { background: #fff }`. `corn-map` has `map-stage` (the box the canvases sit in), `map-canvas`, `label-canvas` and `map-overlay`. A `[data-corn="…"]` rule of your page does not reach into a shadow root; a theme written against hooks needs `::part()`, or tokens. The tags, properties, events, methods and parts are public: [theming.md](theming.md#web-components-tags-properties-events-methods-and-parts) lists them, and a test holds the list against the source.

### Keyboard and screen readers

A screen reader finds an application named "Topology map", described by the map's keys, and a polite status region that says where the keyboard landed. The canvas is reached by Tab. Its keys act **only while the focus is inside the map**: arrows pan, `+` and `-` zoom, `0` fits, `N` and `P` (or `]` and `[`) select the next and the previous node and bring it into view, `Home` and `End` the first and the last, `F` frames the selected node and what it lights, `Escape` clears the selection ("Selection cleared"). These are the keys of cornfield's own page, from the same code; the page's Enter (into its node panel) and Alt with an arrow (Freeform) do nothing in a map with no panel and no Freeform. A key the map handled is marked `defaultPrevented`, and is not stopped: your own handlers still see it, and can tell by that flag that the map took it.

### What it does not do yet

- **No `src`, no fetching.** The map draws what you hand it. Reading from a cornfield server (and so the server half above) belongs to `corn-scope`, a later component.
- **No proposal.** A proposal drawn on the map, with its Before, Diff and After, comes with the review components.
- **No panels.** Selecting a node says so through `cornSelect`; what to show for it is your app's. The node panel, Layers and search are later components.
- **No freeform positions.** Dragging a node and saving where it was put are cornfield's own page's; a map in your page stores nothing in your page's storage.
- **Reduced motion** is read when the map is made: under it the flow packets stand still and the camera jumps where it would glide, as on the page.

### The size it adds

The build records the gzipped size of the shared runtime and of `corn-map` with its engine in `components/size-budget.json`, and CI fails when either grows by more than 5%: `npm run size:record` writes the new numbers when a growth is on purpose. Today: the runtime is 28.0 kB and `corn-map` with its engine 64.4 kB (gzip, level 9).

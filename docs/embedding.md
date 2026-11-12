# Embedding: letting another app of yours in

By default cornfield answers only its own page. With `embed.origins` you can list the origin of **another app of your own** (a task board, an internal portal) so that a page there can read the map and the proposals, and decide a review, as the maintainer who is signed in to cornfield in the same browser. This page is the server's half: what it lets in, what it does not, and what listing an origin means. Nothing here is on until you list an origin.

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

**The cookie does not change.** It stays `HttpOnly`, `SameSite=Lax` and host-only (no `Domain`). So a page that is not cornfield never sees it, and it travels only on a request that is **same-site** with cornfield: the page and cornfield must share a registrable domain, like `tasks.example.com` and `map.example.com` (both `example.com`). A port is part of an origin but not of a site, so `localhost:5173` and `localhost:3350` are the same site. If the two are different sites (`tasks.example.org` and `map.example.com`), the browser does not send the cookie, a read answers `401`, and listing the origin does not change that.

**The public-suffix limit.** A "site" is the domain just under a public suffix. If both apps sit under a suffix that many unrelated people share (`you.github.io` and `me.github.io`, `a.co.uk` and `b.co.uk`, a hosting platform's `*.pages.dev`), they are different sites, and the cookie will not travel; give both apps names under a domain you own. The reverse matters too: any page on a name under that same domain (`blog.example.com`) is same-site with cornfield, and a browser sends the cookie on its simple requests (a GET, a form post) even when that page is not listed. cornfield's own checks refuse such a write (the origin must be cornfield's or a listed one for two routes), and the page cannot read the answer, but if you run untrusted pages under the same domain, give cornfield a domain of its own.

## Signing in and returning

An embedded page that gets `401` sends the maintainer to cornfield to sign in, and cornfield sends them back:

```
https://map.example.com/auth/start?returnTo=https%3A%2F%2Ftasks.example.com%2Freviews%2F7
```

`returnTo` is honoured only when it is an absolute URL whose origin is cornfield's own or exactly a listed origin (the path, query and fragment are kept). Anything else (another host, `https://tasks.example.com.evil.test`, a user name in the URL, a backslash, another scheme or port, `//host`, `javascript:`) is ignored, and the sign-in ends where it always has: on cornfield's map (or on `return`, the same-origin path parameter, which keeps its rules and never takes an absolute URL).

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

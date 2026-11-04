# Sign-in

cornfield shows a map of a repo's weak points, so a hosted cornfield shows nothing to anyone who has not signed in, and everything only to the repo's maintainers ([ADR 0004](adr/0004-admins-only-loopback-until-sign-in.md)). Sign-in is with the repo's own forge, GitHub or Forgejo, over OAuth.

- **Signed out:** every route answers 401; a page you open is the sign-in page.
- **Signed in, not a maintainer:** one page, "this is the dev dashboard; ask a maintainer", and 403 for everything else.
- **A maintainer:** the dashboard. On GitHub that is the repo's `admin` or `maintain` permission; on Forgejo, which has no maintain level, its admins (and its owner).

The server enforces this on every route, the explorer's own files included; only `/healthz` (`{ "ok": true }`, for health checks), the sign-in routes under `/auth/` and `POST /api/reviews` answer without a session. The last takes a **review token** instead, never a cookie ([below](#review-tokens), [proposals.md](proposals.md)). The forge is asked for your permission when you sign in and, for a maintainer, again once the session is 15 minutes old, so someone who loses maintainer rights loses the dashboard within 15 minutes. While the forge cannot be asked, the answer is 503, never a pass. Someone who is not a maintainer is asked again only when they sign in again: cornfield keeps no token of theirs, so if you were just made a maintainer, sign out and sign in.

## Without sign-in

With no OAuth app configured, cornfield is a tool on your own machine: it shows everything, and it only listens on loopback (`127.0.0.1`, `localhost`, `::1`). It refuses any other address at startup.

## Which `Host` it answers

Listening on loopback is not enough on its own: a web page on another site can point its own hostname at `127.0.0.1` (DNS rebinding) and read what cornfield answers from your browser. So the server also checks the `Host` header of every request, before the guard and before any `proxy` path, and answers anything else with `421 Misdirected Request`:

- **Without sign-in:** `localhost`, `127.0.0.1` or `[::1]`, with or without a port. Open it at one of those, not at a name of your own that points at this machine (an SSH port forward to `localhost` is fine).
- **With sign-in:** the host of the public URL, and the loopback names above. Loopback stays because the image's health check asks `http://127.0.0.1:<port>/healthz` from inside the container; the guard still applies to every other route there, and a page on another site cannot make your browser send a loopback `Host` to your hosted cornfield's name. Your reverse proxy must pass the original `Host` on, not rewrite it to the upstream's address, or every request gets 421. Caddy (`reverse_proxy`) and Traefik do this by default; nginx does not, so add `proxy_set_header Host $host;` next to `proxy_pass`.
- `/healthz` follows the same rule; it is not exempt.

Names are compared in any case and the port is ignored: DNS rebinding changes the name, not the port, and a proxy may or may not keep `:443`. A request with no `Host` (HTTP/1.0), with two, or whose request line names another host (`GET http://other/…`) does not pass, and `X-Forwarded-Host` is never read.

## What to set

Sign-in is configured by env only, never by the config file:

| Env | What |
|---|---|
| `CORNFIELD_GITHUB_CLIENT_ID`, `CORNFIELD_GITHUB_CLIENT_SECRET` | the OAuth app, when the config's `forge.type` is `github` |
| `CORNFIELD_FORGEJO_CLIENT_ID`, `CORNFIELD_FORGEJO_CLIENT_SECRET` | the OAuth app, when it is `forgejo` |
| `CORNFIELD_SESSION_SECRET` | at least 32 random characters: `openssl rand -base64 48` |
| `CORNFIELD_PUBLIC_URL` | the origin people open cornfield at, like `https://cornfield.example.org` (or `publicUrl` in the config) |

The config's `forge` names the forge and the repo whose maintainers may sign in (`forge: { type: 'github', repo: 'owner/name' }`; a Forgejo, or a GitHub Enterprise Server, also needs its `url`).

Half of it set is an error at startup, not a quiet fallback to no sign-in: an id without its secret, the other forge's pair, no session secret, a short one, or no public URL.

The session secret names sessions and encrypts the forge tokens kept in them; change it and everyone is signed out.

## Where it may listen

- **Loopback:** always.
- **Any other address** (`CORNFIELD_HOST=0.0.0.0`, as in a container): only with sign-in configured **and** an `https` public URL. Otherwise it refuses at startup and says why. Put a reverse proxy that ends TLS in front of it.

With sign-in on loopback, an `http://127.0.0.1:3350` public URL works for trying it out on your own machine.

## Create the OAuth app on GitHub

1. Open **Settings → Developer settings → OAuth Apps → New OAuth App** (for an organization's repo: the organization's settings, same path), or <https://github.com/settings/applications/new>.
2. **Homepage URL:** the public URL.
3. **Authorization callback URL:** the public URL with `/auth/callback`, like `https://cornfield.example.org/auth/callback`.
4. Register it, then **Generate a new client secret**. Put the client id and the secret in `CORNFIELD_GITHUB_CLIENT_ID` and `CORNFIELD_GITHUB_CLIENT_SECRET`.

cornfield asks for the `repo` scope: it reads a private repo's pull requests and files, posts reviews as comments, and lands green pull requests, all as the signed-in maintainer. For an organization that restricts OAuth apps, an owner approves the app once.

On GitHub Enterprise Server the steps are the same on your instance; set the config's `forge.url` to it.

## Create the OAuth app on Forgejo

1. Open **Settings → Applications → Manage OAuth2 applications** (your user's, or the organization's).
2. **Application name:** cornfield. **Redirect URIs:** the public URL with `/auth/callback`.
3. Keep **Confidential client** on, and create it. Put the client id and the secret in `CORNFIELD_FORGEJO_CLIENT_ID` and `CORNFIELD_FORGEJO_CLIENT_SECRET`.

Set the config's `forge.url` to the instance, like `https://forgejo.example.org` (with its path, when it is served under one).

## What it keeps

A session is a row of `cornfield.db` in the data folder ([config](config.md)): who you are, your permission, when it was last asked, and, for a maintainer only, your forge token, encrypted. The cookie holds a random value whose hash names the row, so the file alone opens no session. Sessions last 7 days; **Sign out** in the header ends one at once. The token never reaches the browser, and never reaches a `proxy` upstream either: cornfield's own cookies are taken out of what a proxied path forwards, and an upstream cannot set them.

A token cornfield no longer needs is revoked at the forge: a non-maintainer's right after sign-in, and a maintainer's when the session ends (sign-out, expiry, or no longer a maintainer). GitHub lets the app do that; Forgejo's API has no such call, so on Forgejo revoke cornfield in **Settings → Applications → Authorized OAuth2 applications** when you stop using it.

## Landing on approval

With `proposals: { approveLands: true }` ([proposals.md](proposals.md#land-on-approval)) an approval also lands the spec PR once its checks are green, **as the approver**, with the forge token their session keeps. It follows the session the way a review token does: when the approver's session ends before the checks finish (Sign out, expiry, a revoked token), the landing stops with "left open: sign in to land", merges nothing and posts no comment (there is no token to post one with). It needs sign-in at all: with the key on and no sign-in cornfield does not start.

## The spec poll

With a [hook](config.md#hooks) that subscribes to `spec.ready`, cornfield lists the open spec PRs on a timer ([`hookPoll`](config.md#hook-poll)) so the event fires with nobody at the dashboard. A timer has no request, so it has no cookie: it looks with the token the newest live session of a maintainer keeps, as a [review through the API](proposals.md) does, and asks the forge first who that is and whether they maintain the repo now. Never a token from the config; cornfield has none.

- **No live maintainer session, no poll.** Signed out, expired, or demoted, a session holds no usable token. The poll then skips quietly (one log line when the gap starts, one when a session is back) and cornfield keeps running. It looks again at the next tick after a maintainer signs in.
- **A restart** drops no session (they are in the SQLite file), so the poll picks up as soon as it runs, with the sessions that were live.
- **It only reads.** With that token the poll asks who its owner is, their permission, and the open spec PRs (their files, and a proposal it announces); it never writes. The log names whose sign-in it looks with each time that changes, and after `close()` a look in flight lists nothing.

## Review tokens

A maintainer can make **review tokens** in the dashboard, so a script or a chat bot can send their Approve or Send back through `POST /api/reviews` ([proposals.md](proposals.md#2-review-it)). They are kept in `review_tokens` in the same file: a SHA-256 hash (never the token, which is shown once), who made it, a label, when it was made, when it expires (30 days unless asked, 90 at most), when it was revoked and last used.

- **The comment is the maintainer's own.** A review only counts when a maintainer wrote its comment, and cornfield has no forge token of its own, so a review that came through the API is posted with the forge token above, the one the token's owner's session keeps. A review token therefore works while its owner has a live session (7 days, or until Sign out) and is refused with a 401 when they have none; signing in again makes the same token work again. It does not make a session last longer, and it does not keep a forge token that would otherwise be revoked.
- **The permission is asked on every call.** Not the session's 15-minute-old answer: the forge is asked who the token is and whether they maintain the repo now. A demoted owner is refused (403) with the token untouched, and it works again if they are made a maintainer again.
- **No cookie.** The call is the one route before the sign-in guard. It reads the `Authorization: Bearer cf_rt_…` header and nothing else; a session cookie is never a substitute, and a review token is no way into any other route (the routes that make, list and revoke tokens take a signed-in maintainer from cornfield's own page, with the same-origin check of sign-out). The `Host` check above is not loosened: call it at the public URL.
- **Every call is a row** in `actions` (`review`), accepted or refused; a call with no token or one nobody holds is written down too, up to 20 a minute from everyone together (more is answered 429 and not written, so no one can fill the file).

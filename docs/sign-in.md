# Sign-in

cornfield shows a map of a repo's weak points, so a hosted cornfield shows nothing to anyone who has not signed in, and everything only to the repo's maintainers ([ADR 0004](adr/0004-admins-only-loopback-until-sign-in.md)). Sign-in is with the repo's own forge, GitHub or Forgejo, over OAuth.

- **Signed out:** every route answers 401; a page you open is the sign-in page.
- **Signed in, not a maintainer:** one page, "this is the dev dashboard; ask a maintainer", and 403 for everything else.
- **A maintainer:** the dashboard. On GitHub that is the repo's `admin` or `maintain` permission; on Forgejo, which has no maintain level, its admins (and its owner).

The server enforces this on every route, the explorer's own files included; only `/healthz` (`{ "ok": true }`, for health checks) and the sign-in routes under `/auth/` answer without a session. The forge is asked for your permission when you sign in and, for a maintainer, again once the session is 15 minutes old, so someone who loses maintainer rights loses the dashboard within 15 minutes. While the forge cannot be asked, the answer is 503, never a pass. Someone who is not a maintainer is asked again only when they sign in again: cornfield keeps no token of theirs, so if you were just made a maintainer, sign out and sign in.

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

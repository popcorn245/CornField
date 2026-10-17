# The cloud: what you depend on and do not control

The cloud deriver draws the services outside your house (or company) that the code depends on: where it runs (DNS, certificates, push services, APIs it calls), where software comes from (registries, package managers, CI actions) and the accounts behind them (by role, never personal details). Each service is one node with its plan and a "breaks if it is down" line; the lines into it say *when* an outage bites: now (`run`), at the next deploy (`deploy`), or at the next certificate renewal (`renew`). "X is down" plays as an outage scenario.

## The registry: `topology.cloud.json`

```json
{
  "version": 1,
  "services": [
    {
      "id": "cloudflare",
      "label": "Cloudflare",
      "roles": ["runtime", "account"],
      "desc": "DNS for the domain, and the DNS-01 challenge behind every certificate.",
      "breaks": "Now: names stop resolving once cached answers expire. At the next renewal: no certificate.",
      "plan": { "tier": "free" },
      "match": { "caddy": ["dns cloudflare"], "hosts": ["1.1.1.1"] },
      "uses": [{ "from": "machine-server-1", "label": "resolves the domain", "why": "Name resolution is not in any file" }]
    }
  ],
  "web": { "label": "Public web", "desc": "Any page a person points the API at.", "breaks": "One page fails." },
  "links": [{ "host": "www.openstreetmap.org", "why": "A link a person follows; never fetched" }]
}
```

- `match` lists what claims the detectors' evidence: `hosts` (exact, or `*.example.org`), `images`, `registries` (`docker.io/`, `ghcr.io/`), `caddy`, `env` (names only, never values, never drawn), `libs`, `routes`, `webhooks`, `actions` (`actions/`), `packages` (`npm`, `pypi`, `apk`, `apt`), `tailnet`.
- `uses` is for what no file shows (an account, something set in an app's own UI), each with a `why`.
- `links` are outside hosts that only appear as links a person follows.
- **It cannot drift.** Evidence no entry claims fails `validate`, naming the file; an entry nothing uses fails too (unless its plan is `off`). Strings are checked for privacy: no `@`, no long digit runs, no URL paths.

## The detectors

| Detector | Reads | Draws from |
|---|---|---|
| Hosts in code | every `https://<host>` in source and page files (by default the starter's packages; option `code`) | the module or package node holding the file |
| Dockerfiles | `FROM` images and the package installs of `RUN`s | the node holding the Dockerfile, `deploy` |
| Images | the `image` of container nodes another deriver made | the container, `deploy` |
| CI | `.github/workflows` and `.forgejo/workflows`: `uses:`, job images, downloads, installs, `docker run` (needs js-yaml, an optional dependency) | a `tool-ci` node (or `options.ci.from`), `deploy` |
| Caddy | the Caddyfiles named in `options.caddyfiles: [{ file, from }]`: DNS-01 providers, resolvers, the ACME CA | the node named, `renew` |

Options: `{ ownDomains, code, ci: { from }, dockerfiles, caddyfiles }`. `ownDomains` are never outside (your own domains). A repo's own deriver can add evidence of any kind (`lib`, `route`, `env`…) before the cloud deriver runs.

Without a `topology.cloud.json` the deriver only says how many outside hosts and sources it found, so a first `sync` never fails on it.

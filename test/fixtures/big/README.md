# The big map and the retro theme (a review rig)

A generated repo at the scale of a big real one, and a brand theme, for design reviews and tests. Nothing generated is committed; only the generator.

- `make.js`: `node test/fixtures/big/make.js --out <dir> [--seed 245] [--theme retro]` writes a servable repo: 922 nodes, 3,632 edges in 19 types, `topology.cloud.json`, `cornfield.config.js`, a stub for every file the map cites, and about 70 proposals. Deterministic for a seed.
- `serve.js`: generates the repo and serves it.
- `../themes/retro/`: the `retro` brand theme (cream and deep indigo, radius 0, ink borders, hard shadows, a red accent, a pixel title face and a rounded body face, an "Arcade" logo and wordmark). `--theme retro` wires it into the generated config.

## Serve it

```sh
node test/fixtures/big/serve.js --port 3401                  # (a) the default theme
node test/fixtures/big/serve.js --theme retro --port 3402    # (b) the retro theme
```

Open the URL it prints. These two run with no sign-in (loopback), so every route answers.

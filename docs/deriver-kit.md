# The deriver kit: put your own code on the map

cornfield's map is only useful if it is true. The built-in derivers already map your packages, modules, personas and cloud services. Your project has more than that, though: API routes, background jobs, queues, the tables a migration creates. cornfield cannot guess those. A **deriver** of your own reads that code and tells the map about it, and `cornfield validate` in CI keeps the map true from then on.

The kit is how you write such a deriver and know it works. It ships inside the `cornfield` package as one import:

```js
import { defineDeriver, fixtureRepo, runDeriver, checkDeriver } from 'cornfield/deriver-kit';
```

It has no dependencies of its own and works with any test runner, or with none.

## 1. Write the deriver

A deriver is a plain ES module in your repo (the contract is in [derivers.md](derivers.md)). Wrap it in `defineDeriver`, which checks it against the contract when the module loads instead of at your first sync. It also gives your editor the types, so `ctx` and the result autocomplete.

```js
// tools/cornfield/routes.js
import path from 'node:path';
import { defineDeriver } from 'cornfield/deriver-kit';

export default defineDeriver({
  name: 'routes',
  contract: 1,
  derive(ctx) {
    const app = ctx.options.app;                  // the app node the routes hang from, from your config
    if (!ctx.nodes.some((n) => n.id === app)) throw new Error(`no node "${app}" to hang the routes from`);
    const files = ctx.walk('packages/api/routes', (f) => f.endsWith('.js'));
    const id = (f) => `page-${path.posix.basename(f, '.js')}`;
    return {
      nodes: files.map((f) => ({ id: id(f), type: 'page', label: `/${path.posix.basename(f, '.js')}`, file: f })),
      edges: files.map((f) => ({ from: app, to: id(f) })),
      pageOwners: [app],                          // these pages are this deriver's: a deleted route leaves the map
    };
  },
});
```

Then name it in your config, after the derivers whose nodes it builds on:

```js
// cornfield.config.js
export default {
  derivers: ['starter', { use: './tools/cornfield/routes.js', options: { app: 'pkg-api' } }, 'personas', 'cloud'],
};
```

## 2. Test it against a fixture repo

`checkDeriver` runs your deriver on a repo the way `cornfield sync` and `cornfield validate` would. It runs any derivers you list in `before` first, syncs what they make into a fresh map, and runs every check `validate` would. If anything would fail, it throws one error that lists every problem. Otherwise it returns the run so you can assert on it.

```js
// tools/cornfield/routes.test.js (vitest here; node:test, jest or mocha read the same)
import { test, expect } from 'vitest';
import { checkDeriver } from 'cornfield/deriver-kit';
import routes from './routes.js';

test('each route file is a page of the API', async () => {
  const run = await checkDeriver(routes, {
    files: {
      'package.json': { name: 'acme', workspaces: ['packages/*'] },
      'packages/api/package.json': { name: '@acme/api' },
      'packages/api/index.js': 'export {};',
      'packages/api/routes/cart.js': 'export default () => "cart";',
    },
    before: ['starter'],                 // the built-in that makes pkg-api
    options: { app: 'pkg-api' },
  });
  expect(run.nodes.map((n) => n.label)).toEqual(['/cart']);
});
```

`files` builds a throwaway repo in the temp folder and removes it afterwards. An object value is written as JSON. To test against a fixture folder you keep in your repo, use `root` instead:

```js
const run = await checkDeriver(routes, { root: 'test/fixtures/shop', before: ['starter'], options: { app: 'pkg-api' } });
```

To change a copy of that fixture without touching the original, use `fixtureRepo`:

```js
import { fixtureRepo, runDeriver } from 'cornfield/deriver-kit';

const repo = fixtureRepo({ 'packages/api/routes/new.js': 'export default 1;' }, { from: 'test/fixtures/shop' });
try {
  const run = await runDeriver(routes, { root: repo.root, before: ['starter'], options: { app: 'pkg-api' } });
  // …
} finally {
  repo.cleanup();                        // or: using repo = fixtureRepo(…)
}
```

## What `checkDeriver` checks

These are the checks `cornfield validate` would fail on, each reported as one line:

| Line starts with | What it means |
|---|---|
| `problem:` | your deriver returned it in `problems` |
| `schema:` | the synced map breaks the schema: an unknown node type, a page label without a leading `/`, an edge to a node that does not exist, a typed edge missing its fields |
| `paths:` | a node's `file` is not in the repo |
| `validate:` | your deriver's own `validate(ctx, topology)` said so |
| `drift:` | a second sync would still change something, so the deriver is not stable |
| `owns:` | it makes a node it does not own (the type is not in `owns`, the id is not in `ownedIds`, and it is not a page of one of its `pageOwners`), so sync would keep that node after the code drops it. Pass `allowUnowned: true` if you mean to hand those nodes over to people. |

A deriver that throws is reported by name (`Deriver "routes" failed: …`), as `sync` reports it.

## What a run holds

`runDeriver` returns the same run without throwing. It holds:

- `nodes`, `edges`, `warnings`, `problems` and `info`: what your deriver returned;
- `derived`: every deriver's output merged;
- `topology` and `changes`: the map a sync writes, and what it changed. Pass `map` to sync over a committed map instead of an empty one;
- `schemaProblems`, `pathProblems`, `validateProblems`, `driftProblems` and `unowned`: the checks from the table above;
- `root`: the repo it ran on.

`runProblems(run)` turns a run into the lines `checkDeriver` would throw.

## The types

The kit's JSDoc types describe the contract: `Deriver`, `DeriverContext`, `DeriverResult`, `MapNode`, `MapEdge`, `Evidence`, `RepoReader`, `DeriverRun`. `defineDeriver` applies them for you. To name one yourself:

```js
/** @type {import('cornfield/deriver-kit').DeriverContext} */
```

## Then keep the map true

With the deriver in your config:

- `cornfield sync` writes what it finds into `topology.json`;
- `cornfield validate` in CI fails when the code moves and the map has not;
- `cornfield serve` shows your routes on the map, next to everything else.

When the code changes in a way your deriver no longer understands, make it throw a clear error rather than guess. The map should never be quietly wrong.

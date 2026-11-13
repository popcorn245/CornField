// The package build: ES modules in dist/, one entry per component (dist/corn-map.js, which registers the tag) and one for all (dist/index.js),
// sharing the runtime and the engine in chunks. Type declarations and tokens.css are written by scripts/build.mjs after this.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChunkingContext } from 'rolldown';
import stencilrs from '@popcorn245/stencilrs/vite';
import { defineConfig } from 'vite';
import { componentTags, cornTokens, define } from './scripts/shared.mjs';

const entries: Record<string, string> = { index: 'src/index.ts' };
const reachCache = new WeakMap<ChunkingContext, Map<string, Set<string>>>();
/** The modules an entry imports, statically, directly or not (worked out once per build from the module graph) */
function reach(ctx: ChunkingContext, name: string): Set<string> {
  let byName = reachCache.get(ctx);
  if (!byName) reachCache.set(ctx, (byName = new Map()));
  const known = byName.get(name);
  if (known) return known;
  const seen = new Set<string>();
  const walk = (id: string) => { if (seen.has(id)) return; seen.add(id); for (const next of ctx.getModuleInfo(id)?.importedIds || []) walk(next); };
  walk(resolve(`src/components/${name}/${name}.tsx`));
  byName.set(name, seen);
  return seen;
}
const isComponent = (id: string) => /[\\/]src[\\/]components[\\/]/.test(id);
/** What `corn-map` and `corn-scope` both import, statically: the engine's chunk */
function sharedEngine(ctx: ChunkingContext, id: string): boolean {
  return reach(ctx, 'corn-map').has(id) && reach(ctx, 'corn-scope').has(id) && !isComponent(id);
}
/**
 * What the review's sections (`corn-proposal`, `corn-changes`, `corn-decision`) and `corn-review` use between them and no other component does: one chunk. Before the
 * sections were tags the review had all of it in a chunk of its own; a bundler's default would cut it into one chunk for each set of entries that use a module,
 * and a review loads the pieces of those chunks, each compressed on its own, a few percent bigger. A section loads the same chunk (they are used together).
 * A module another component loads too stays out, and so does one that would make the chunk and another import each other (a module out of the group that
 * a module of the group imports and that imports one of the group's own: a bundler merges the two to break the cycle, and then every component that
 * loads the one loads the other), found by taking such modules out until none is left.
 */
const SECTIONS = ['corn-proposal', 'corn-changes', 'corn-decision'];
const COMPONENTS = readdirSync('src/components');
const groupCache = new WeakMap<ChunkingContext, Map<string, Set<string>>>();
/**
 * The modules of a group: those whose users (the components that load them) are all in `allowed` and at least two, and at least one of them in `needs`, less any that would make
 * the group and a chunk that is not in it import each other (a module out of the group that a module of the group imports and that imports one of the group's own: the
 * bundler merges the two to break the cycle, and then every component that loads the one loads the other), found by taking such modules out until none is left
 */
function groupOf(ctx: ChunkingContext, name: string, allowed: string[], needs: string[], taken: Set<string> = new Set()): Set<string> {
  let byName = groupCache.get(ctx);
  if (!byName) groupCache.set(ctx, (byName = new Map()));
  const known = byName.get(name);
  if (known) return known;
  const all = new Set<string>();
  for (const tag of COMPONENTS) for (const id of reach(ctx, tag)) all.add(id);
  const imports = (id: string) => (ctx.getModuleInfo(id)?.importedIds || []).filter((next) => all.has(next));
  const group = new Set<string>();
  for (const id of all) {
    if (isComponent(id) || sharedEngine(ctx, id) || taken.has(id)) continue;
    const users = COMPONENTS.filter((tag) => reach(ctx, tag).has(id));
    if (users.length >= 2 && users.every((tag) => allowed.includes(tag)) && users.some((tag) => needs.includes(tag))) group.add(id);
  }
  for (let again = true; again;) {
    again = false;
    const below = new Set<string>();
    const walk = (id: string) => { for (const next of imports(id)) if (!below.has(next)) { below.add(next); walk(next); } };
    for (const id of group) walk(id);
    for (const id of [...group]) {
      for (const other of all) if (!group.has(other) && below.has(other) && imports(other).includes(id)) { group.delete(id); again = true; break; }
    }
  }
  byName.set(name, group);
  return group;
}
const reviewFamily = (ctx: ChunkingContext) => groupOf(ctx, 'review-pieces', ['corn-review', ...SECTIONS], SECTIONS);
for (const name of COMPONENTS) entries[name] = `src/components/${name}/${name}.tsx`;
void componentTags; // (the tag list of tokens.css comes from the same folder)

export default defineConfig({
  plugins: [cornTokens(), stencilrs()],
  define,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry: entries, formats: ['es'], fileName: (_format, name) => `${name}.js` },
    rolldownOptions: {
      preserveEntrySignatures: 'allow-extension', // (the group of the review's sections leaves its dependencies where they are: includeDependenciesRecursively: false needs it)
      output: {
        // A chunk is named after its first module, so the engine every component shares would be `_corn-default-tokens-…` (the tokens are its first
        // module): it is named for what it is
        chunkFileNames: (chunk) => (chunk.moduleIds.some((id) => id.includes('corn-default-tokens')) ? 'chunks/engine-[hash].js' : 'chunks/[name]-[hash].js'),
        // The runtime is one chunk of its own, whatever components are built: every entry shares it (the budget in size-budget.json holds its size).
        // The engine the map and the scope both load is one chunk too, as it was before the pieces around the map came: an entry that needs only part
        // of it (the node panel's) would otherwise split it in two, and a map would load two chunks that compress worse than one
        codeSplitting: {
          groups: [
            { name: 'runtime', test: /node_modules[\\/]@stencil[\\/]core/, priority: 2 },
            { name: (id: string, ctx: ChunkingContext) => (sharedEngine(ctx, id) ? 'engine' : null), priority: 1 },
            { name: (id: string, ctx: ChunkingContext) => (reviewFamily(ctx).has(id) ? 'review-pieces' : null), includeDependenciesRecursively: false, priority: 0 },
          ],
        },
      },
    },
  },
});

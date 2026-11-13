// The package build: ES modules in dist/, one entry per component (dist/corn-map.js, which registers the tag) and one for all (dist/index.js),
// sharing the runtime and the engine in chunks. Type declarations and tokens.css are written by scripts/build.mjs after this.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChunkingContext } from 'rolldown';
import stencilrs from '@popcorn245/stencilrs/vite';
import { defineConfig } from 'vite';
import { componentTags, cornTokens, define } from './scripts/shared.mjs';

const entries: Record<string, string> = { index: 'src/index.ts' };
/** What `corn-map` and `corn-scope` both import, statically: the engine's chunk (worked out once per build from the module graph) */
let engine: { ctx: ChunkingContext; ids: Set<string> } | null = null;
function sharedEngine(ctx: ChunkingContext): Set<string> {
  if (engine && engine.ctx === ctx) return engine.ids;
  const reach = (entry: string) => {
    const seen = new Set<string>();
    const walk = (id: string) => { if (seen.has(id)) return; seen.add(id); for (const next of ctx.getModuleInfo(id)?.importedIds || []) walk(next); };
    walk(entry);
    return seen;
  };
  const map = reach(resolve(`src/components/corn-map/corn-map.tsx`));
  const scope = reach(resolve(`src/components/corn-scope/corn-scope.tsx`));
  engine = { ctx, ids: new Set([...map].filter((id) => scope.has(id) && !/[\\/]src[\\/]components[\\/]/.test(id))) };
  return engine.ids;
}
for (const name of readdirSync('src/components')) entries[name] = `src/components/${name}/${name}.tsx`;
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
            { name: (id: string, ctx: ChunkingContext) => (sharedEngine(ctx).has(id) ? 'engine' : null), priority: 1 },
          ],
        },
      },
    },
  },
});

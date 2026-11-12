// The package build: ES modules in dist/, one entry per component (dist/corn-map.js, which registers the tag) and one for all (dist/index.js),
// sharing the runtime and the engine in chunks. Type declarations and tokens.css are written by scripts/build.mjs after this.
import { readdirSync } from 'node:fs';
import stencilrs from '@popcorn245/stencilrs/vite';
import { defineConfig } from 'vite';
import { componentTags, cornTokens, define } from './scripts/shared.mjs';

const entries: Record<string, string> = { index: 'src/index.ts' };
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
        // The runtime is one chunk of its own, whatever components are built: every entry shares it (the budget in size-budget.json holds its size)
        codeSplitting: { groups: [{ name: 'runtime', test: /node_modules[\\/]@stencil[\\/]core/ }] },
      },
    },
  },
});

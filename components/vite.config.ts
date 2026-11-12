// Dev server: `npm run dev` serves demo/index.html (two maps from the synthetic fixture), with the components compiled as they are edited.
import stencilrs from '@popcorn245/stencilrs/vite';
import { defineConfig } from 'vite';
import { cornTokens, define, demoTopology, server } from './scripts/shared.mjs';

export default defineConfig({
  plugins: [cornTokens(), demoTopology(), stencilrs()],
  define,
  server: { ...server, port: 3639 },
});

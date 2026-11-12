// The shell's tests in happy-dom: fast, no browser. The tests that need a layout and a GPU are the *.browser.test.ts ones (vitest.browser.config.ts).
import stencilrs from '@popcorn245/stencilrs/vite';
import { defineConfig } from 'vitest/config';
import { cornTokens, define, demoTopology, server } from './scripts/shared.mjs';

export default defineConfig({
  plugins: [cornTokens(), demoTopology(), stencilrs()],
  define,
  server,
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.browser.test.ts'],
  },
});

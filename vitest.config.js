import os from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node by default; a test that needs a DOM says so on its first lines: `@vitest-environment happy-dom`
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.js'],
    exclude: ['**/node_modules/**', '**/.claude/**', 'test/fixtures/**'],
    testTimeout: process.env.CI ? 60_000 : 20_000,
    hookTimeout: process.env.CI ? 60_000 : 30_000,
    maxWorkers: Math.max(2, Math.floor(os.availableParallelism() / 2)),
  },
});

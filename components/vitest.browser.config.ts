// The tests in headless Chrome (Playwright), as the StencilRS starter runs them. On a machine with no Google Chrome, point CHROME_PATH at a Chromium.
import stencilrs from '@popcorn245/stencilrs/vite';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import type { BrowserCommand } from 'vitest/node';
import { cornTokens, define, demoTopology, server } from './scripts/shared.mjs';

const executablePath = process.env.CHROME_PATH;

// Things the page cannot do to itself: the browser's own settings, set through Playwright
const colorScheme: BrowserCommand<['light' | 'dark']> = async (ctx, scheme) => { await (ctx as any).page.emulateMedia({ colorScheme: scheme }); };
const viewport: BrowserCommand<[number, number]> = async (ctx, width, height) => { await (ctx as any).page.setViewportSize({ width, height }); };

export default defineConfig({
  plugins: [cornTokens(), demoTopology(), stencilrs()],
  define,
  server,
  optimizeDeps: { include: ['@stencil/core/app-data', '@stencil/core/runtime/client/standalone', 'axe-core'] },
  test: {
    include: ['test/**/*.browser.test.ts'],
    testTimeout: 60_000,
    browser: {
      enabled: true,
      headless: true,
      // Reduced motion on: the map's flow packets are still, so a picture is the same picture twice
      provider: playwright({
        launchOptions: executablePath ? { executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } : { channel: 'chrome' },
        contextOptions: { reducedMotion: 'reduce' },
      }),
      commands: { colorScheme, viewport },
      instances: [{ browser: 'chromium' }],
    },
  },
});

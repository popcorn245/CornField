// The tests in headless Chrome (Playwright), as the StencilRS starter runs them. On a machine with no Google Chrome, point CHROME_PATH at a Chromium.
import stencilrs from '@popcorn245/stencilrs/vite';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import type { BrowserCommand } from 'vitest/node';
import { fakeCornfield } from './scripts/fake-cornfield.mjs';
import { cornTokens, define, demoTopology, server, version } from './scripts/shared.mjs';

const executablePath = process.env.CHROME_PATH;

// Things the page cannot do to itself: the browser's own settings, set through Playwright
const colorScheme: BrowserCommand<['light' | 'dark']> = async (ctx, scheme) => { await (ctx as any).page.emulateMedia({ colorScheme: scheme }); };
const viewport: BrowserCommand<[number, number]> = async (ctx, width, height) => { await (ctx as any).page.setViewportSize({ width, height }); };

export default defineConfig({
  plugins: [cornTokens(), demoTopology(), fakeCornfield(version), stencilrs()],
  define,
  server,
  optimizeDeps: { include: ['@stencil/core/app-data', '@stencil/core/runtime/client/standalone', 'axe-core'] },
  test: {
    include: ['test/**/*.browser.test.ts'],
    testTimeout: 60_000,
    // One file at a time: files run side by side share one browser, a page that is not in front gets its frames late, and the tests that
    // wait for a steady picture would take a frame that has not come yet for a steady one
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      // Reduced motion on: the map's flow packets are still, so a picture is the same picture twice
      provider: playwright({
        // A 2d canvas drawn on the GPU is moved to the CPU by Chrome at a moment that depends on timing, and the two draw a few pixels apart,
        // so a test comparing pictures would compare which frame the move came on: the 2d canvas stays on the CPU, and a picture is the same picture
        launchOptions: executablePath ? { executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-accelerated-2d-canvas'] } : { channel: 'chrome', args: ['--disable-accelerated-2d-canvas'] },
        contextOptions: { reducedMotion: 'reduce' },
      }),
      commands: { colorScheme, viewport },
      instances: [{ browser: 'chromium' }],
    },
  },
});

import { defineConfig } from '@playwright/test';

// Regenerates the pictures in docs/images (used by README.md): npm run screenshots
export default defineConfig({
  testDir: '.',
  testMatch: 'screenshots.spec.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: '../runs/screenshots-output',
  use: { channel: process.env.BROWSER_CHANNEL ?? 'chrome', headless: true, viewport: { width: 1400, height: 860 }, deviceScaleFactor: 1 },
});

import { defineConfig } from '@playwright/test';

// Real Chrome (the system install), real server, real SCRAM through the installed runtime. One worker: runs share the engine.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: '../runs/e2e-output',
  use: {
    channel: process.env.BROWSER_CHANNEL ?? 'chrome',
    headless: true,
    viewport: { width: 1400, height: 860 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});

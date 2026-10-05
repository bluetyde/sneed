import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose `root` is the web app: tests live at the repository root and in e2e/ (Playwright, not Vitest).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'e2e/**', 'dist/**'],
  },
});

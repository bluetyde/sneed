import { test as base, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { App, newServer } from './fixtures.js';

// Failure paths a student can hit. The server is real; the engine is replaced only where the failure cannot be caused honestly.

const emptyState = { distro: 'Ubuntu', linuxRoot: '/root/none', stateDir: path.join(tmpdir(), 'sneed-e2e-no-runtime') };

const cancelledRecord = {
  status: 'cancelled',
  completeness: 'unknown',
  reasons: ['cancelled'],
  method: 'exact',
  input_hashes: { model_hash: 'x' },
  settings: { limitOrder: 2 },
  assumptions: {},
  engine: { name: 'SCRAM', version: '0.16.2' },
  warnings: [],
  caveats: [],
  minimal_cut_sets: [],
  top_event_probability: null,
  approximation_value: null,
};

base.describe('failure paths', () => {
  base('with no SCRAM runtime installed the built-in engine still runs; choosing SCRAM says so, explains the fix and never offers a doomed Run', async ({ page }) => {
    const { server, dir } = await newServer({ runtimeEnv: emptyState });
    try {
      const app = new App(page);
      await page.goto(server.url);
      await app.ready();
      await expect(page.getByTestId('runtime-state')).toContainText('SCRAM runtime not installed');
      await expect(page.getByTestId('engine')).toHaveValue('builtin');
      await expect(page.getByTestId('run')).toBeEnabled(); // the default engine needs no install
      await app.run();
      expect(await app.topProbability()).toBeCloseTo(0.19, 12);
      await app.tab('results');
      await expect(page.getByTestId('results')).toContainText('built into the app, nothing to install');
      await page.getByTestId('engine').selectOption('scram');
      await expect(page.getByTestId('run')).toBeDisabled();
      await expect(page.getByTestId('run-pill')).toContainText('npm run runtime -- install');
      await app.tab('results');
      await expect(page.getByTestId('stale')).toBeVisible(); // the shown result was made with the other engine
      await expect(app.win).toHaveAttribute('data-valid', 'true'); // editing and checking still work
      await page.getByTestId('engine').selectOption('both');
      await expect(page.getByTestId('run')).toBeEnabled(); // the built-in engine still answers
      await page.getByTestId('run').click();
      await expect(page.getByTestId('cross-check')).toHaveAttribute('data-agree', 'unavailable');
      await expect(page.getByTestId('cross-check')).toContainText('No second opinion');
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  base('a long run shows Running, can be cancelled with the button or Escape, and the cancel is recorded', async ({ page }) => {
    const { server, dir } = await newServer({
      analyzeFn: (_text, opts) =>
        new Promise((resolve) => {
          opts.signal?.addEventListener('abort', () => resolve({ kind: 'ran', runDir: path.join(dir, 'runs', 'fake-cancelled'), record: cancelledRecord as never }), { once: true });
        }),
    });
    try {
      const app = new App(page);
      await page.goto(server.url);
      await app.ready();
      await page.getByTestId('engine').selectOption('scram'); // the stand-in engine is SCRAM's
      for (const how of ['button', 'escape'] as const) {
        await page.getByTestId('run').click();
        await expect(page.getByTestId('run-pill')).toHaveText('Running…');
        await expect(page.getByTestId('cancel')).toBeVisible();
        await expect(page.getByTestId('run')).toBeHidden();
        await expect(page.getByTestId('method')).toBeDisabled();
        await expect(page.getByTestId('engine')).toBeDisabled();
        if (how === 'button') await page.getByTestId('cancel').click();
        else await page.keyboard.press('Escape');
        await expect(page.getByTestId('result-status')).toContainText('cancelled');
        await expect(page.getByTestId('results')).toContainText('cancelled before it finished');
        await expect(page.getByTestId('top-probability')).toHaveCount(0); // a cancelled run shows no number
        await expect(page.getByTestId('run')).toBeVisible();
      }
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  base('a server refusal is explained, and an unexpected server error is shown without details', async ({ page }) => {
    let mode: 'refuse' | 'boom' = 'refuse';
    const { server, dir } = await newServer({
      analyzeFn: async () => {
        if (mode === 'boom') throw new Error('secret failure at C:\\Users\\x');
        return { kind: 'refused', errors: [{ code: 'E_EXPORT_LIMIT', severity: 'error', path: '/', message: 'voting gate "V" is too large' }], warnings: [] } as never;
      },
    });
    try {
      const app = new App(page);
      await page.goto(server.url);
      await app.ready();
      await page.getByTestId('engine').selectOption('scram'); // the stand-in engine is SCRAM's
      await page.getByTestId('run').click();
      await expect(page.getByTestId('results')).toContainText('refused before the engine started');
      await expect(page.getByTestId('results')).toContainText('E_EXPORT_LIMIT');
      await expect(page.getByTestId('results')).toContainText('too large to hand to the engine');
      mode = 'boom';
      await page.getByTestId('run').click();
      await expect(page.getByTestId('results')).toContainText('internal error');
      await expect(page.getByTestId('results')).not.toContainText('secret');
      await expect(page.getByTestId('results')).not.toContainText('Users');
      await expect(page.getByTestId('run')).toBeEnabled(); // the editor recovers
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  base('if the server goes away the editor says it cannot check the model, and Run stays blocked', async ({ page }) => {
    const { server, dir } = await newServer();
    const app = new App(page);
    await page.goto(server.url);
    await app.ready();
    await server.close();
    await app.setProbability('E1', '0.3');
    await expect(page.getByTestId('notice')).toContainText('Could not check the model');
    await expect(page.getByTestId('run')).toBeDisabled();
    await expect(page.getByTestId('run-pill')).toContainText('not been checked');
    rmSync(dir, { recursive: true, force: true });
  });

  base('a file that cannot be drawn is refused when opened and the open work is untouched', async ({ page }) => {
    const { server, dir } = await newServer();
    try {
      const app = new App(page);
      await page.goto(server.url);
      await app.ready();
      await page.request.put(`${server.url}/api/models/broken`, { headers: { 'x-sneed-request': '1' }, data: { text: JSON.stringify({ top: 'G1', events: 'no', gates: [] }) } });
      await app.setProbability('E1', '0.4');
      page.once('dialog', (d) => void d.accept());
      await app.action('open').click();
      await page.locator('button[data-model="broken"]').click();
      await expect(page.getByTestId('notice')).toContainText('cannot be drawn');
      await expect(app.node('E1')).toContainText('p = 0.4');
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

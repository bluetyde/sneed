import path from 'node:path';
import { buildSharedEventTree, expect, saveSharedModel, SHARED_MODEL, test } from '../e2e/fixtures.js';

// Pictures for the README, taken from the real app with example (invented) numbers. Run with: npm run screenshots
const OUT = path.resolve(import.meta.dirname, '..', 'docs', 'images');

test('a fault tree, analysed', async ({ app, page }) => {
  await app.open();
  await saveSharedModel(page, SHARED_MODEL(0.1));
  await app.action('open').click();
  await page.locator('button[data-model="shared"]').click();
  await expect(page.getByTestId('doc-name')).toContainText('shared');
  await app.run();
  await app.tab('results');
  await expect(page.getByTestId('result-status')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'fault-tree.png') });
});

test('an event tree, analysed', async ({ app, page }) => {
  await app.open();
  await buildSharedEventTree(page);
  await page.locator('[data-action="et-run"]').click();
  await expect(page.getByTestId('et-result-status')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'event-tree.png') });
  const drawing = page.getByTestId('et-drawing');
  await drawing.scrollIntoViewIfNeeded();
  await expect(drawing).toContainText('per year');
  await drawing.screenshot({ path: path.join(OUT, 'event-tree-drawing.png') });
});

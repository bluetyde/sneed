import type { Page } from '@playwright/test';
import { expect, test, buildSharedEventTree as build, SHARED_MODEL, saveSharedModel } from './fixtures.js';

const savedRuns = async (page: Page): Promise<number> => ((await (await page.request.get('/api/event-tree-runs')).json()) as { runs: unknown[] }).runs.length;

/** Presses Analyse and waits until the new analysis is on the server's list (and so on the Compare list). */
async function analyse(page: Page): Promise<void> {
  const before = await savedRuns(page);
  await page.locator('[data-action="et-run"]').click();
  await expect.poll(() => savedRuns(page)).toBe(before + 1);
  await expect(page.getByTestId('et-result-status')).toBeVisible();
  if (before + 1 >= 2) await expect(page.locator('#et-cmp-b option')).toHaveCount(Math.min(before + 1, 100)); // the Compare list has caught up
  await expect(page.locator('[data-action="et-run"]')).toBeEnabled();
}

// Compare two saved analyses of an event tree (plan 13, stage S4), on plan 13 case 6.2: S = 0.1 then S = 0.2.
// P(A fails and B fails) = S + (1 - S) x 0.2 x 0.3: 0.154 then 0.248, so the frequency at 0.5 per year goes 0.077 -> 0.124.

test.describe('comparing saved event-tree analyses', () => {
  test('two analyses of the same tree: same inputs, nothing changed, said in words', async ({ app, page }) => {
    await app.open();
    await build(page);
    await analyse(page);
    await analyse(page);
    await page.locator('[data-action="et-compare"]').click();
    await expect(page.getByTestId('et-compare-same')).toContainText('numbers should be identical');
    await expect(page.getByTestId('et-compare-seq-same')).toContainText('All 4 sequence frequencies are identical');
    await expect(page.getByTestId('et-compare-end-same')).toBeVisible();
    await expect(page.getByTestId('et-compare-total')).toContainText('no change');
  });

  test('the fault-tree model saved again: the changed frequencies are listed with from, to and ratio, and the inputs are said to differ', async ({ app, page }) => {
    await app.open();
    await build(page);
    await analyse(page);
    await saveSharedModel(page, SHARED_MODEL(0.2));
    await page.locator('[data-mode="fault-tree"]').click();
    await page.locator('[data-mode="event-tree"]').click();
    await expect(page.getByTestId('et-model-changed')).toBeVisible();
    await page.locator('[data-action="et-adopt"]').click();
    await expect(page.getByTestId('et-no-problems')).toBeVisible();
    await analyse(page);
    await expect(page.getByTestId('et-stale')).toHaveCount(0);
    await page.locator('[data-action="et-compare"]').click();
    const inputs = page.getByTestId('et-compare-inputs');
    await expect(inputs).toContainText('The fault-tree model differs');
    await expect(inputs).toContainText('The event tree differs'); // the document pins the model hash
    const row = page.getByTestId('et-compare-seqs').locator('tr[data-seq="H1:fails,H2:fails"]');
    await expect(row.locator('th')).toHaveText('Injection fails, Cooling fails');
    await expect(row.locator('td').nth(0)).toHaveText('0.077');
    await expect(row.locator('td').nth(1)).toHaveText('0.124');
    await expect(row.locator('td').nth(2)).toHaveText('+0.047 (×1.61039)');
    // the total is the initiating-event frequency whatever the model says: it did not move
    await expect(page.getByTestId('et-compare-total')).toContainText('no change');
    if (process.env.SNEED_SHOT3) await page.getByTestId('et-compare').screenshot({ path: process.env.SNEED_SHOT3 });
    const text = (await page.getByTestId('et-compare-result').textContent()) ?? '';
    expect(text).not.toMatch(/better|worse|safer|improv|degrad/i); // a difference is a difference
  });

  test('the choice follows the two newest analyses, can be changed by keyboard, and a pair that is the same one is not compared', async ({ app, page }) => {
    await app.open();
    await build(page);
    await analyse(page);
    await analyse(page);
    const a = page.locator('#et-cmp-a');
    const b = page.locator('#et-cmp-b');
    await b.selectOption({ index: 1 });
    await a.selectOption({ index: 1 });
    await expect(page.locator('[data-action="et-compare"]')).toBeDisabled();
    await expect(page.getByTestId('et-compare')).toContainText('Choose two different analyses');
    await a.selectOption({ index: 2 });
    await expect(page.locator('[data-action="et-compare"]')).toBeEnabled();
    await page.locator('[data-action="et-compare"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('et-compare-result')).toBeVisible();
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByTestId('et-compare-result')).toHaveCount(0);
  });
});

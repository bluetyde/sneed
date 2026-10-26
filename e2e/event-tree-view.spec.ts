import type { Page } from '@playwright/test';
import { expect, test, SHARED_MODEL as MODEL, saveSharedModel } from './fixtures.js';

// The small things of the event-tree screen that the larger flows in event-tree.spec.ts pass through without looking at: the limits of the
// heading buttons, what Save, New and Open do with unsaved work, the note for a student with no saved model, how an end state that is an
// example is named in a result, and what a run that failed says. Each has a mutant in tests/mutation/verifier_mutations.py ("etview").

const mode = (page: Page, which: 'fault-tree' | 'event-tree') => page.locator(`[data-mode="${which}"]`);

async function newTreeOnSharedModel(page: Page): Promise<void> {
  await page.locator('[data-action="et-new"]').click();
  await expect(page.locator('[data-field="et-h-event-H1"]')).toBeVisible();
  await page.locator('[data-field="et-model"]').selectOption('shared');
  await expect(page.locator('[data-field="et-h-event-H1"] option[value="X"]')).toHaveCount(1);
  await page.locator('[data-field="et-h-event-H1"]').selectOption('X');
  await page.locator('[data-field="et-set-all"]').selectOption('ES1');
}

test.describe('event tree screen, small behaviours', () => {
  test('a student with no saved model is told so', async ({ app, page }) => {
    await app.open();
    await mode(page, 'event-tree').click();
    await page.locator('[data-action="et-new"]').click();
    await expect(page.getByTestId('et-no-models')).toBeVisible();
  });

  test('the heading buttons keep to their limits: the only heading cannot be removed, the first cannot move up, the last cannot move down, and there are at most 12', async ({ app, page }) => {
    await app.open();
    await saveSharedModel(page, MODEL(0.1));
    await mode(page, 'event-tree').click();
    await newTreeOnSharedModel(page);
    await expect(page.locator('[data-action="et-remove-H1"]')).toBeDisabled();
    await expect(page.locator('[data-action="et-up-H1"]')).toBeDisabled();
    await expect(page.locator('[data-action="et-down-H1"]')).toBeDisabled();
    await page.locator('[data-action="et-add-heading"]').click();
    await expect(page.locator('[data-action="et-remove-H1"]')).toBeEnabled();
    await expect(page.locator('[data-action="et-down-H1"]')).toBeEnabled();
    await expect(page.locator('[data-action="et-up-H1"]')).toBeDisabled();
    await expect(page.locator('[data-action="et-down-H2"]')).toBeDisabled();
    for (let n = 3; n <= 12; n++) {
      await expect(page.locator('[data-action="et-add-heading"]')).toBeEnabled();
      await page.locator('[data-action="et-add-heading"]').click();
      await expect(page.locator(`[data-heading="H${n}"]`)).toHaveCount(1);
    }
    await expect(page.locator('[data-action="et-add-heading"]')).toBeDisabled();
  });

  test('Save of a tree with no name asks for one; New and Open ask before throwing unsaved work away, and keep it when the student says no', async ({ app, page }) => {
    await app.open();
    await saveSharedModel(page, MODEL(0.1));
    await mode(page, 'event-tree').click();
    await newTreeOnSharedModel(page);
    await page.locator('[data-action="et-save"]').click();
    await expect(page.locator('#save-name')).toBeVisible(); // no name yet: the dialog, not a silent save
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.locator('[data-field="et-name"]').fill('Work in progress');
    await page.locator('[data-field="et-name"]').press('Enter');
    await expect(page.getByTestId('et-dirty')).toBeVisible();
    const asked: string[] = [];
    page.on('dialog', (d) => {
      asked.push(d.message());
      void d.dismiss();
    });
    await page.locator('[data-action="et-new"]').click();
    await page.locator('[data-action="et-open"]').click();
    expect(asked).toHaveLength(2);
    expect(asked.every((m) => m.includes('Discard the unsaved changes'))).toBe(true);
    await expect(page.locator('[data-field="et-name"]')).toHaveValue('Work in progress');
    await expect(page.locator('[data-tree]')).toHaveCount(0); // the Open dialog never appeared
  });

  test('a result names an example end state as an example whatever the student called it, and draws no approximation unless asked', async ({ app, page }) => {
    await app.open();
    await saveSharedModel(page, MODEL(0.1));
    await mode(page, 'event-tree').click();
    await newTreeOnSharedModel(page);
    await page.locator('[data-field="et-e-name-ES1"]').fill('Sunny day');
    await page.locator('[data-field="et-e-name-ES1"]').press('Enter');
    await page.locator('[data-action="et-run"]').click();
    await expect(page.getByTestId('et-result-status')).toHaveText(/completed \/ complete/);
    await expect(page.getByTestId('et-result-ends').locator('tr[data-end="ES1"] th')).toHaveText('Sunny day (example)');
    await expect(page.getByTestId('et-result-seqs').locator('th', { hasText: 'Approximation' })).toHaveCount(0);
  });

  test('a run that failed says why, in words, and shows no numbers', async ({ app, page }) => {
    await app.open();
    await saveSharedModel(page, MODEL(0.1));
    await mode(page, 'event-tree').click();
    await newTreeOnSharedModel(page);
    await page.route('**/api/event-tree/run', async (route) => {
      const real = await route.fetch();
      const body = (await real.json()) as { kind: string; record: Record<string, unknown> };
      body.record = { ...body.record, status: 'failed', completeness: 'unknown', reasons: ['timeout'], sequences: [], total: null };
      await route.fulfill({ response: real, json: body });
    });
    await page.locator('[data-action="et-run"]').click();
    await expect(page.getByTestId('et-failed')).toContainText('took too long');
    await expect(page.getByTestId('et-total')).toHaveCount(0);
  });
});

import type { Page } from '@playwright/test';
import { expect, test, SHARED_MODEL as MODEL, saveSharedModel } from './fixtures.js';

// Plan 13 case 6.2: S (0.1), a (0.2), b (0.3); heading A fails if X = S OR a occurs, heading B if Y = S OR b occurs; 0.5 per year.
// Exact: both fail 0.154 (0.077 per year), A fails and B works 0.126 (0.063), A works and B fails 0.216 (0.108), both work 0.504 (0.252).
const saveModel = saveSharedModel;

const mode = (page: Page, which: 'fault-tree' | 'event-tree') => page.locator(`[data-mode="${which}"]`);

/** Builds the 6.2 tree through the page: two headings on X and Y, every sequence ending in the one example end state. */
async function buildSharedTree(page: Page): Promise<void> {
  await page.locator('[data-action="et-new"]').click();
  await expect(page.locator('[data-field="et-h-event-H1"]')).toBeVisible();
  await page.locator('[data-field="et-model"]').selectOption('shared'); // the first saved model is not necessarily this one
  await expect(page.locator('[data-field="et-h-event-H1"] option[value="X"]')).toHaveCount(1);
  await page.locator('[data-field="et-h-name-H1"]').fill('A');
  await page.locator('[data-field="et-h-name-H1"]').press('Enter');
  await page.locator('[data-field="et-h-event-H1"]').selectOption('X');
  await page.locator('[data-action="et-add-heading"]').click();
  await page.locator('[data-field="et-h-name-H2"]').fill('B');
  await page.locator('[data-field="et-h-name-H2"]').press('Enter');
  await page.locator('[data-field="et-h-event-H2"]').selectOption('Y');
  await page.locator('[data-field="et-ie-freq"]').fill('0.5');
  await page.locator('[data-field="et-ie-freq"]').press('Enter');
  await expect(page.locator('[data-seq]')).toHaveCount(4);
  await page.locator('[data-field="et-set-all"]').selectOption('ES1');
}

const value = async (page: Page, testId: string, row: string): Promise<number> => Number(await page.getByTestId(testId).locator(row).locator('td[data-value]').first().getAttribute('data-value'));

test.describe('event tree editor', () => {
  test('the shared-event case: built through the page, analysed, with the partition check and the assumptions', async ({ app, page }) => {
    await app.open();
    await saveModel(page, MODEL(0.1));
    await mode(page, 'event-tree').click();
    await buildSharedTree(page);
    await expect(page.getByTestId('et-no-problems')).toBeVisible();
    await expect(page.getByTestId('et-pill')).toHaveText('Ready to analyse');
    await page.locator('[data-action="et-run"]').click();
    await expect(page.getByTestId('et-result-status')).toHaveText(/completed \/ complete/);
    expect(await value(page, 'et-result-seqs', 'tr[data-seq="H1:fails,H2:fails"]')).toBeCloseTo(0.077, 12);
    expect(await value(page, 'et-result-seqs', 'tr[data-seq="H1:fails,H2:works"]')).toBeCloseTo(0.063, 12);
    expect(await value(page, 'et-result-seqs', 'tr[data-seq="H1:works,H2:fails"]')).toBeCloseTo(0.108, 12);
    expect(await value(page, 'et-result-seqs', 'tr[data-seq="H1:works,H2:works"]')).toBeCloseTo(0.252, 12);
    expect(await value(page, 'et-result-ends', 'tr[data-end="ES1"]')).toBeCloseTo(0.5, 12);
    expect(Number(await page.getByTestId('et-total').getAttribute('data-value'))).toBeCloseTo(0.5, 12);
    await expect(page.getByTestId('et-partition')).toContainText('add up to 1');
    await expect(page.getByTestId('et-assumptions')).toContainText('per-year');
    await expect(page.getByTestId('et-caveat').first()).toContainText('not a plant figure');
    await expect(page.getByTestId('et-result-ends').locator('tr[data-end="ES1"] th')).toContainText('(example)');
    await expect(page.getByTestId('et-pill')).toHaveText('Result is current');
    await expect(page.getByTestId('et-approximation')).toHaveCount(0); // never unless asked
  });

  test('the approximation is shown only on request, labelled, next to the exact numbers; changing it marks the old result', async ({ app, page }) => {
    await app.open();
    await saveModel(page, MODEL(0.1));
    await mode(page, 'event-tree').click();
    await buildSharedTree(page);
    await page.locator('[data-action="et-run"]').click();
    await expect(page.getByTestId('et-result-status')).toBeVisible();
    await page.locator('#et-approx').check();
    await expect(page.getByTestId('et-stale')).toBeVisible(); // it was made without the approximation
    await page.locator('[data-action="et-run"]').click();
    await expect(page.getByTestId('et-approximation')).toBeVisible();
    await expect(page.getByTestId('et-approximation')).toContainText('different kind of number');
    // A fails, B works: exact 0.063 per year; "success branches ignored" counts only A's failure: 0.5 x 0.28 = 0.14
    const row = page.getByTestId('et-result-seqs').locator('tr[data-seq="H1:fails,H2:works"]');
    await expect(row.locator('td').nth(3)).toHaveText('0.14');
    await expect(row.locator('td').nth(4)).toHaveText('2.22222');
    await expect(page.getByTestId('et-stale')).toHaveCount(0);
  });

  test('a changed saved model is named, can be checked against, and an old result is marked out of date', async ({ app, page }) => {
    await app.open();
    await saveModel(page, MODEL(0.1));
    await mode(page, 'event-tree').click();
    await buildSharedTree(page);
    await page.locator('[data-action="et-saveas"]').click();
    await page.locator('#save-name').fill('shared-et');
    await page.getByTestId('save-confirm').click();
    await expect(page.getByTestId('doc-name')).toContainText('shared-et');
    await page.locator('[data-action="et-run"]').click();
    await expect(page.getByTestId('et-result-status')).toBeVisible();
    // the model is saved again with another probability, behind the event tree's back
    await saveModel(page, MODEL(0.2));
    await mode(page, 'fault-tree').click();
    await mode(page, 'event-tree').click();
    await expect(page.getByTestId('et-model-changed')).toBeVisible();
    await expect(page.getByTestId('et-problems')).toContainText('E_STALE_MODEL');
    await expect(page.locator('[data-action="et-run"]')).toBeDisabled();
    await expect(page.getByTestId('et-stale')).toBeVisible();
    await page.locator('[data-action="et-adopt"]').click();
    await expect(page.getByTestId('et-no-problems')).toBeVisible();
    await expect(page.getByTestId('et-stale')).toBeVisible(); // the numbers on show are still those of the old model's hash
    await page.locator('[data-action="et-run"]').click();
    await expect(page.getByTestId('et-stale')).toHaveCount(0);
    // P(A fails, B fails) with S = 0.2: 0.2 + 0.8 x 0.2 x 0.3 = 0.248, x 0.5 = 0.124
    expect(await value(page, 'et-result-seqs', 'tr[data-seq="H1:fails,H2:fails"]')).toBeCloseTo(0.124, 12);
  });

  test('a saved event tree opens again with the same meaning', async ({ app, page }) => {
    await app.open();
    await saveModel(page, MODEL(0.1));
    await mode(page, 'event-tree').click();
    await buildSharedTree(page);
    await page.locator('[data-action="et-saveas"]').click();
    await page.locator('#save-name').fill('shared-et');
    await page.getByTestId('save-confirm').click();
    await expect(page.getByTestId('doc-name')).toContainText('shared-et');
    await expect(page.getByTestId('et-hash')).toHaveAttribute('data-hash', /^[0-9a-f]{64}$/); // the check after the last edit has finished
    const hash = await page.getByTestId('et-hash').getAttribute('data-hash');
    await page.reload();
    await app.ready();
    await mode(page, 'event-tree').click();
    await page.locator('[data-action="et-open"]').click();
    await page.locator('[data-tree="shared-et"]').click();
    await expect(page.getByTestId('et-hash')).toHaveAttribute('data-hash', hash!);
    await expect(page.getByTestId('et-no-problems')).toBeVisible();
  });

  test('problems are named, not hidden: a sequence without an end state, and a frequency that is not a number', async ({ app, page }) => {
    await app.open();
    await saveModel(page, MODEL(0.1));
    await mode(page, 'event-tree').click();
    await page.locator('[data-action="et-new"]').click();
    await expect(page.getByTestId('et-problems')).toContainText('E_NO_END_STATE'); // the author must choose
    await expect(page.locator('[data-action="et-run"]')).toBeDisabled();
    await expect(page.getByTestId('et-pill')).toContainText('Analysis blocked');
    await page.locator('[data-field="et-ie-freq"]').fill('lots');
    await page.locator('[data-field="et-ie-freq"]').press('Enter');
    await expect(page.locator('#et-ie-freq-err')).toBeVisible();
    await page.locator('[data-field="et-ie-freq"]').fill('0.2');
    await page.locator('[data-field="et-ie-freq"]').press('Enter');
    await expect(page.locator('#et-ie-freq-err')).toHaveCount(0);
  });

  test('bypass and ordering: asking B only if A works leaves three sequences; moving B above A drops the condition', async ({ app, page }) => {
    await app.open();
    await saveModel(page, MODEL(0.1));
    await mode(page, 'event-tree').click();
    await buildSharedTree(page);
    await page.locator('[data-field="et-h-ask-H2"]').selectOption('H1|works');
    await expect(page.locator('[data-seq]')).toHaveCount(3);
    await page.locator('[data-action="et-up-H2"]').click();
    await expect(page.locator('[data-seq]')).toHaveCount(4);
    await expect(page.locator('[data-field="et-h-ask-H1"]')).toHaveValue('');
  });

  test('keyboard only: add a heading with Tab and Enter, and every control has a name', async ({ app, page }) => {
    await app.open();
    await saveModel(page, MODEL(0.1));
    await mode(page, 'event-tree').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('et')).toBeVisible();
    await app.tabTo(page.locator('[data-action="et-new"]'));
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-field="et-h-event-H1"]')).toBeVisible();
    await app.tabTo(page.locator('[data-action="et-add-heading"]'));
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-heading="H2"]')).toBeVisible();
    // no unnamed form control inside the view
    const unnamed = await page.getByTestId('et').evaluate((root) =>
      [...root.querySelectorAll('input, select, button')].filter((el) => {
        const e = el as HTMLInputElement;
        const label = e.getAttribute('aria-label') ?? (e.id ? document.querySelector(`label[for="${e.id}"]`)?.textContent : null) ?? (e.closest('label')?.textContent) ?? e.textContent;
        return !label || label.trim() === '';
      }).map((el) => el.outerHTML.slice(0, 100)),
    );
    expect(unnamed).toEqual([]);
  });
});

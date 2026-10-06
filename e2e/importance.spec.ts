import { expect, test } from './fixtures.js';

test.describe('importance measures', () => {
  test('asked for, shown with its definitions and assumptions, and gone as soon as the model changes', async ({ app, page }) => {
    await app.open();
    await app.tab('results');
    await expect(page.getByTestId('importance-table')).toHaveCount(0); // never automatic
    await page.getByTestId('compute-importance').click();
    const table = page.getByTestId('importance-table');
    await expect(table).toBeVisible();
    // E1 OR E2 with 0.1 each: top 0.19, Birnbaum 0.9, RAW 1/0.19 = 5.263, RRW 0.19/0.1 = 1.9, FV 0.09/0.19 = 0.4737
    const row = table.locator('tr[data-event="E1"]');
    await expect(row.locator('td').nth(1)).toHaveText('0.9');
    await expect(row.locator('td').nth(2)).toHaveText('5.263');
    await expect(row.locator('td').nth(3)).toHaveText('1.9');
    await expect(row.locator('td').nth(4)).toHaveText('0.4737');
    await expect(page.getByTestId('results')).toContainText('What these measures mean');
    await page.getByText('What these measures mean').click();
    await expect(page.getByTestId('results')).toContainText('Birnbaum');
    await expect(page.getByTestId('results')).toContainText('not a design or licensing finding');
    await expect(page.getByTestId('compute-importance')).toHaveText('Compute again');
    await app.setProbability('E1', '0.3');
    await expect(page.getByTestId('importance-table')).toHaveCount(0); // it described the model before the edit
    await expect(page.getByTestId('compute-importance')).toHaveText('Compute importance');
  });

  test('an event in every cut set has an infinite reduction worth, shown as that', async ({ app, page }) => {
    await app.open();
    await app.select('G1');
    await app.tab('properties');
    await app.field('type').selectOption('and');
    await app.tab('results');
    await page.getByTestId('compute-importance').click();
    const row = page.getByTestId('importance-table').locator('tr[data-event="E1"]');
    await expect(row.locator('td').nth(3)).toHaveText('∞');
    await expect(row.locator('td').nth(4)).toHaveText('1');
  });

  test('a model with a problem cannot be asked about', async ({ app, page }) => {
    await app.open();
    await app.select('E2');
    await page.keyboard.press('Delete'); // the OR gate is left with one input: a problem to fix
    await app.tab('problems');
    await expect(page.getByTestId('run')).toBeDisabled();
    await app.tab('results');
    await expect(page.getByTestId('compute-importance')).toBeDisabled();
  });

  test('keyboard: the button is reachable and the table has a caption name and row headers', async ({ app, page }) => {
    await app.open();
    await app.tab('results');
    await page.getByTestId('compute-importance').focus();
    await page.keyboard.press('Enter');
    const table = page.getByTestId('importance-table');
    await expect(table).toBeVisible();
    expect(await table.getAttribute('aria-label')).toMatch(/Importance measures/);
    expect(await table.locator('tbody th[scope=row]').count()).toBeGreaterThan(1);
    expect(await table.locator('thead th[scope=col]').count()).toBe(6);
  });
});

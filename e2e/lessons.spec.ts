import { expect, test } from './fixtures.js';

const step = (page: import('@playwright/test').Page, id: string) => page.locator(`[data-testid="lesson-step"][data-step="${id}"]`);

test.describe('lessons', () => {
  test('lesson 1 from the keyboard alone: start, build, run, read the result, show the hand calculation', async ({ app, page }) => {
    await app.open();
    // reach the Lesson tab and the lesson list with Tab only
    await app.keyTab('lesson');
    const start = page.locator('[data-testid="start-lesson"][data-lesson="01-single-pump"]');
    await app.tabTo(start);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('lesson-title')).toHaveText('A single pump');
    await expect(app.nodes()).toHaveCount(0); // a lesson starts from nothing
    await expect(page.getByTestId('lesson-blank')).toContainText('empty'); // and says so, instead of calling the empty model unreadable
    await expect(step(page, 'one-event')).toHaveAttribute('data-done', 'false');
    await expect(step(page, 'one-event')).toContainText('Next');

    // the hand calculation is held back until the student has tried
    await expect(page.getByTestId('show-calc')).toBeDisabled();
    await expect(page.getByTestId('lesson-calc')).toHaveCount(0);

    await app.tabTo(app.action('add-event'));
    await page.keyboard.press('Enter');
    await expect(app.nodes()).toHaveCount(1);
    // naming the event P: Enter on the node moves focus to the Name field
    await app.tabTo(app.node('E1'));
    await page.keyboard.press('Enter');
    await expect(app.field('name')).toBeFocused();
    await page.keyboard.type('P');
    await page.keyboard.press('Enter');
    await app.keyTab('lesson');
    for (const id of ['one-event', 'set-probability', 'top-is-p']) await expect(step(page, id)).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('lesson-run-prompt')).toBeVisible();
    await expect(page.getByTestId('lesson-complete')).toHaveCount(0); // steps alone do not complete a lesson

    await page.keyboard.press('Control+Enter');
    await expect(page.getByTestId('result-status')).toBeVisible({ timeout: 90_000 });
    expect(await app.topProbability()).toBeCloseTo(0.1, 12);
    await app.keyTab('lesson');
    await expect(page.getByTestId('lesson-complete')).toContainText('One pump, p = 0.1');
    await expect(page.getByTestId('lesson-tab-complete')).toBeVisible();

    await app.tabTo(page.getByTestId('show-calc'));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('lesson-calc')).toContainText('0.1');
  });

  test('lesson 2: AND gives 0.01, switching the gate to OR makes the result stale until run again, then 0.19', async ({ app, page }) => {
    await app.open();
    await app.tab('lesson');
    await page.locator('[data-lesson="02-redundant-pumps"]').click();
    await app.action('add-and').click();
    await expect(app.nodes()).toHaveCount(3);
    await app.setName('E1', 'P1');
    await app.setName('E2', 'P2');
    await app.tab('lesson');
    await expect(step(page, 'two-events')).toHaveAttribute('data-done', 'true');
    await expect(step(page, 'and-top')).toHaveAttribute('data-done', 'true');
    await expect(step(page, 'switch-to-or')).toHaveAttribute('data-done', 'false');

    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.01, 12);
    await app.tab('lesson');
    await expect(step(page, 'switch-to-or')).toContainText('Next');
    await expect(page.getByTestId('lesson-complete')).toHaveCount(0); // steps left

    await app.select('G1');
    await app.tab('properties');
    await app.field('type').selectOption('or');
    await app.tab('lesson');
    await expect(step(page, 'switch-to-or')).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('lesson-complete')).toHaveCount(0); // the 0.01 result is out of date for this model
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.19, 12);
    await app.tab('lesson');
    await expect(page.getByTestId('lesson-complete')).toContainText('OR');
  });

  test('a wrong probability is named, and the lesson does not complete', async ({ app, page }) => {
    await app.open();
    await app.tab('lesson');
    await page.locator('[data-lesson="02-redundant-pumps"]').click();
    await app.action('add-or').click();
    await app.setName('E1', 'P1');
    await app.setName('E2', 'P2');
    await app.setProbability('E1', '0.5');
    await app.run();
    await app.tab('lesson');
    await expect(step(page, 'two-events')).toHaveAttribute('data-done', 'false');
    await expect(page.getByTestId('lesson-complete')).toHaveCount(0);
    await app.setProbability('E1', '0.1');
    await app.run();
    await app.tab('lesson');
    await expect(page.getByTestId('lesson-complete')).toBeVisible();
  });

  test('lesson 3: one shared supply completes, a second supply event is named as the mistake', async ({ app, page }) => {
    await app.open();
    await app.tab('lesson');
    await page.locator('[data-lesson="03-shared-power-supply"]').click();
    // G1 = AND(G2, G3), each an OR of two events
    await app.action('add-and').click(); // G1 with E1, E2
    await app.select('E1');
    await app.action('delete').click();
    await app.select('E2');
    await app.action('delete').click();
    await app.select('G1');
    await app.action('add-or').click(); // G2 with E1, E2 (the freed ids are reused)
    await app.select('G1');
    await app.action('add-or').click(); // G3 with E3, E4
    await app.select('E4');
    await app.action('delete').click();
    await app.setName('E1', 'P1');
    await app.setName('E2', 'S');
    await app.setName('E3', 'P2');
    await app.setProbability('E2', '0.05');
    // the same supply S under the second pump's gate
    await app.select('G3');
    await app.tab('properties');
    await app.field('add-input').selectOption('E2');
    await page.getByRole('button', { name: 'Add input' }).click();
    await app.tab('lesson');
    for (const id of ['three-events', 'and-of-pumps', 'one-s-twice']) await expect(step(page, id)).toHaveAttribute('data-done', 'true');
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.0595, 12);
    await app.tab('lesson');
    await expect(page.getByTestId('lesson-complete')).toContainText('One supply S');

    // a separate supply event for the second pump: more than three events, and the lesson says why that is different
    await app.select('G3');
    await app.action('add-event').click();
    await app.tab('lesson');
    await expect(page.locator('[data-mistake="two-copies"]')).toBeVisible();
    await expect(page.getByTestId('lesson-complete')).toHaveCount(0);
  });
});
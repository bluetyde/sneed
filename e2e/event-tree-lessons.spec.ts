import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

// The three event-tree lessons (plan 13, stage S5), worked through the real page.

async function start(page: Page, id: string): Promise<void> {
  await page.locator('[data-mode="event-tree"]').click();
  await expect(page.getByTestId('et')).toBeVisible();
  await page.getByTestId('et-lessons').locator('summary').first().click();
  await page.locator(`[data-testid="et-start-lesson"][data-lesson="${id}"]`).click();
  await expect(page.getByTestId('et-lesson-step').first()).toBeVisible();
  await expect(page.locator('[data-field="et-h-event-H1"] option').nth(1)).toBeAttached(); // the lesson's model is loaded
}
const step = (page: Page, id: string) => page.locator(`[data-testid="et-lesson-step"][data-step="${id}"]`);
const setFrequency = async (page: Page, v: string): Promise<void> => {
  await page.locator('[data-field="et-ie-freq"]').fill(v);
  await page.locator('[data-field="et-ie-freq"]').press('Enter');
};
const analyse = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-action="et-run"]')).toBeEnabled();
  await page.locator('[data-action="et-run"]').click();
  await expect(page.getByTestId('et-result-status')).toBeVisible();
};
/** Lesson 1: the end state follows how many headings failed on the path (none, one, one, both). */
const assignByFailures = async (page: Page): Promise<void> => {
  for (const [i, state] of [1, 2, 2, 3].entries()) await page.locator(`[data-field="et-s-end-${i}"]`).selectOption({ index: state });
};

test.describe('event-tree lessons', () => {
  test('they are listed with their goals, and the instructor\'s answers are never in the page', async ({ app, page }) => {
    await app.open();
    await page.locator('[data-mode="event-tree"]').click();
    await page.getByTestId('et-lessons').locator('summary').first().click();
    await expect(page.getByTestId('et-start-lesson')).toHaveCount(3);
    const text = (await page.getByTestId('et-lessons').textContent()) ?? '';
    expect(text).toContain('two independent safety functions');
    expect(text).toContain('share a cause');
    expect(text).toContain('not always asked');
    expect(text).toContain('describes no real plant');
    expect(text).not.toContain('partition the possible outcomes'); // an instructor's model answer
    expect(await page.content()).not.toContain('partition the possible outcomes');
  });

  test('lesson 1, independent headings: built step by step, the steps tick, the analysis matches, the hand calculation waits', async ({ app, page }) => {
    await app.open();
    await start(page, 'et-01-independent-headings');
    // a lesson starts with nothing credited and no mistake shown
    await expect(step(page, 'frequency')).toHaveAttribute('data-done', 'false');
    await expect(page.getByTestId('et-lesson-mistakes')).toHaveCount(0);
    await expect(page.getByTestId('et-show-calc')).toBeDisabled();
    await setFrequency(page, '0.1');
    await expect(step(page, 'frequency')).toHaveAttribute('data-done', 'true');
    await page.locator('[data-action="et-add-heading"]').click();
    await page.locator('[data-field="et-h-event-H2"]').selectOption('COOL');
    await expect(step(page, 'headings')).toHaveAttribute('data-done', 'true');
    await expect(step(page, 'paths')).toHaveAttribute('data-done', 'true');
    await page.locator('[data-action="et-add-end"]').click();
    await page.locator('[data-action="et-add-end"]').click();
    await expect(step(page, 'end-states')).toHaveAttribute('data-done', 'true');
    await expect(step(page, 'assign')).toHaveAttribute('data-done', 'false');
    await assignByFailures(page);
    await expect(step(page, 'assign')).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('et-lesson-run-prompt')).toBeVisible();
    await expect(page.getByTestId('et-lesson-complete')).toHaveCount(0); // not complete until an analysis matches
    await analyse(page);
    await expect(page.getByTestId('et-lesson-complete')).toContainText('Two independent headings at 0.1 per year');
    await expect(page.getByTestId('et-lesson-calc')).toHaveCount(0);
    await expect(page.getByTestId('et-show-calc')).toBeEnabled();
    await page.getByTestId('et-show-calc').click();
    await expect(page.getByTestId('et-lesson-calc')).toContainText('0.0891');
    // the numbers on the page are the oracle's
    const row = page.getByTestId('et-result-seqs').locator('tr[data-seq="H1:works,H2:works"]');
    await expect(row.locator('td').nth(2)).toHaveText('0.0891');
  });

  test('a lesson is not completed by wrong work: another frequency, the headings the wrong way round, or a stale analysis', async ({ app, page }) => {
    await app.open();
    await start(page, 'et-01-independent-headings');
    await setFrequency(page, '0.2');
    await page.locator('[data-action="et-add-heading"]').click();
    await page.locator('[data-field="et-h-event-H2"]').selectOption('COOL');
    await page.locator('[data-action="et-add-end"]').click();
    await page.locator('[data-action="et-add-end"]').click();
    await page.locator('[data-field="et-set-all"]').selectOption('ES1');
    await analyse(page);
    await expect(step(page, 'frequency')).toHaveAttribute('data-done', 'false');
    await expect(page.getByTestId('et-lesson-complete')).toHaveCount(0);
    // right frequency, but not analysed again: the old analysis is not accepted
    await setFrequency(page, '0.1');
    await assignByFailures(page); // grouped by the number of failed headings, as the lesson asks
    await expect(page.getByTestId('et-lesson-complete')).toHaveCount(0);
    await analyse(page);
    await expect(page.getByTestId('et-lesson-complete')).toBeVisible();
    // swap the order of the two headings: the numbers per path are different events, so no match
    await page.locator('[data-action="et-down-H1"]').click();
    await expect(page.getByTestId('et-lesson-complete')).toHaveCount(0);
  });

  test('lesson 2, the shared event: the prediction is asked for first and shown beside the result with the product of the probabilities', async ({ app, page }) => {
    await app.open();
    await start(page, 'et-02-shared-event');
    await setFrequency(page, '0.5');
    await page.locator('[data-field="et-h-event-H1"]').selectOption('X');
    await page.locator('[data-action="et-add-heading"]').click();
    await page.locator('[data-field="et-h-event-H2"]').selectOption('Y');
    await expect(step(page, 'headings')).toHaveAttribute('data-done', 'true');
    await page.locator('[data-field="et-set-all"]').selectOption('ES1');
    await expect(step(page, 'predict')).toHaveAttribute('data-done', 'false');
    await page.locator('[data-field="et-prediction"]').fill('0.05');
    await page.locator('[data-field="et-prediction"]').press('Enter');
    await expect(step(page, 'predict')).toHaveAttribute('data-done', 'true');
    await analyse(page);
    const reveal = page.getByTestId('et-lesson-reveal');
    await expect(reveal).toContainText('You predicted 0.05 per year');
    await expect(reveal).toContainText('gives 0.077 per year');
    await expect(reveal).toContainText('0.28 and 0.37');
    await expect(reveal).toContainText('0.0518 per year');
    await expect(reveal).toContainText('32.7 percent below');
    if (process.env.SNEED_SHOT4) await page.getByTestId('et-lessons').screenshot({ path: process.env.SNEED_SHOT4 });
    await expect(page.getByTestId('et-lesson-complete')).toContainText('share the support system S');
    const text = (await page.getByTestId('et-lesson-calc').count()) === 0 ? 'hidden' : 'shown';
    expect(text).toBe('hidden');
  });

  test('lesson 2: analysing before predicting gives nothing to compare, and the lesson is not complete', async ({ app, page }) => {
    await app.open();
    await start(page, 'et-02-shared-event');
    await setFrequency(page, '0.5');
    await page.locator('[data-field="et-h-event-H1"]').selectOption('X');
    await page.locator('[data-action="et-add-heading"]').click();
    await page.locator('[data-field="et-h-event-H2"]').selectOption('Y');
    await page.locator('[data-field="et-set-all"]').selectOption('ES1');
    await analyse(page);
    await expect(page.getByTestId('et-lesson-no-prediction')).toBeVisible();
    await expect(page.getByTestId('et-lesson-reveal')).toHaveCount(0);
    await expect(page.getByTestId('et-lesson-complete')).toHaveCount(0);
    // a guess typed after seeing the result is not shown beside it
    await page.locator('[data-field="et-prediction"]').fill('0.077');
    await page.locator('[data-field="et-prediction"]').press('Enter');
    await expect(page.getByTestId('et-lesson-reveal')).toHaveCount(0);
    await analyse(page);
    await expect(page.getByTestId('et-lesson-reveal')).toContainText('You predicted 0.077 per year');
    await expect(page.getByTestId('et-lesson-complete')).toBeVisible();
  });

  test('lesson 3, bypass: three sequences and the exact numbers; the other branch is named as a mistake', async ({ app, page }) => {
    await app.open();
    await start(page, 'et-03-bypass');
    await setFrequency(page, '0.5');
    await page.locator('[data-field="et-h-event-H1"]').selectOption('X');
    await page.locator('[data-action="et-add-heading"]').click();
    await page.locator('[data-field="et-h-event-H2"]').selectOption('Y');
    await page.locator('[data-field="et-h-ask-H2"]').selectOption('H1|fails');
    await expect(page.getByTestId('et-lesson-mistakes')).toContainText('WORKED');
    await expect(step(page, 'bypass')).toHaveAttribute('data-done', 'false');
    await page.locator('[data-field="et-h-ask-H2"]').selectOption('H1|works');
    await expect(page.getByTestId('et-lesson-mistakes')).toHaveCount(0);
    await expect(step(page, 'bypass')).toHaveAttribute('data-done', 'true');
    await expect(step(page, 'paths')).toHaveAttribute('data-done', 'true');
    await page.locator('[data-field="et-set-all"]').selectOption('ES1');
    await analyse(page);
    await expect(page.getByTestId('et-lesson-complete')).toContainText('Cooling asked only if Injection worked');
    const row = page.getByTestId('et-result-seqs').locator('tr[data-seq="H1:fails"]');
    await expect(row.locator('td').nth(2)).toHaveText('0.14');
  });

  test('the mistakes are named: the top event as a heading, two headings on one event, a frequency of zero', async ({ app, page }) => {
    await app.open();
    await start(page, 'et-02-shared-event');
    await page.locator('[data-field="et-h-event-H1"]').selectOption('TOP');
    await expect(page.getByTestId('et-lesson-mistakes')).toContainText('TOP is the event that both fail');
    await page.locator('[data-field="et-h-event-H1"]').selectOption('X');
    await page.locator('[data-action="et-add-heading"]').click();
    await page.locator('[data-field="et-h-event-H2"]').selectOption('X');
    await expect(page.getByTestId('et-lesson-mistakes')).toContainText('same event');
    await page.locator('[data-field="et-h-event-H2"]').selectOption('Y');
    await setFrequency(page, '0');
    await expect(page.getByTestId('et-lesson-mistakes')).toContainText('frequency of 0');
    await setFrequency(page, '0.5');
    await expect(page.getByTestId('et-lesson-mistakes')).toHaveCount(0);
  });

  test('starting a lesson asks before it replaces unsaved work, and leaving a lesson keeps the tree', async ({ app, page }) => {
    await app.open();
    await page.locator('[data-mode="event-tree"]').click();
    await page.locator('[data-action="et-new"]').click();
    await page.locator('[data-field="et-ie-name"]').fill('My own initiating event');
    await page.locator('[data-field="et-ie-name"]').press('Enter');
    await expect(page.getByTestId('et-dirty')).toBeVisible();
    let asked = 0;
    page.once('dialog', (d) => {
      asked++;
      void d.dismiss();
    });
    await page.getByTestId('et-lessons').locator('summary').first().click();
    await page.locator('[data-testid="et-start-lesson"]').first().click();
    await expect.poll(() => asked).toBe(1);
    await expect(page.locator('[data-field="et-ie-name"]')).toHaveValue('My own initiating event'); // declined: nothing replaced
    page.once('dialog', (d) => void d.accept());
    await page.locator('[data-testid="et-start-lesson"]').first().click();
    await expect(page.getByTestId('et-lesson-step').first()).toBeVisible();
    await page.getByTestId('et-leave-lesson').click();
    await expect(page.getByTestId('et-lesson-step')).toHaveCount(0);
    await expect(page.locator('[data-field="et-ie-freq"]')).toBeVisible(); // the tree is still there
  });

  test('keyboard only: a lesson can be started and its prediction typed without a mouse', async ({ app, page }) => {
    await app.open();
    await page.locator('[data-mode="event-tree"]').focus();
    await page.keyboard.press('Enter');
    const summary = page.getByTestId('et-lessons').locator('summary').first();
    await app.tabTo(summary);
    await page.keyboard.press('Enter');
    const startBtn = page.locator('[data-testid="et-start-lesson"][data-lesson="et-02-shared-event"]');
    await app.tabTo(startBtn);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('et-lesson-step').first()).toBeVisible();
    await app.tabTo(page.locator('[data-field="et-prediction"]'));
    await page.keyboard.type('0.1');
    await page.keyboard.press('Enter');
    await expect(step(page, 'predict')).toHaveAttribute('data-done', 'true');
  });

  test('a saved model with the same name as the lesson model is not replaced: the lesson uses a numbered name and says so', async ({ app, page }) => {
    await app.open();
    const lessonFile = path.join(import.meta.dirname, '..', 'lessons', 'event-trees', '02-shared-event.json');
    const lessonModel = (JSON.parse(readFileSync(lessonFile, 'utf8')) as { model: { document: unknown } }).model.document;
    const mine = JSON.stringify({ ...(lessonModel as object), top: 'X' }); // a different, valid model under the lesson's name
    const put = (text: string) => page.request.put('/api/models/lesson-et-shared', { headers: { 'x-sneed-request': '1' }, data: { text } });
    try {
      expect((await put(mine)).ok()).toBe(true);
      await start(page, 'et-02-shared-event');
      await expect(page.getByTestId('notice')).toContainText('already exists and is not this lesson');
      await expect(page.locator('[data-field="et-model"]')).toHaveValue('lesson-et-shared-2');
      const kept = (await (await page.request.get('/api/models/lesson-et-shared')).json()) as { text: string };
      expect(kept.text).toBe(mine); // untouched
    } finally {
      await put(JSON.stringify(lessonModel, null, 2) + String.fromCharCode(10)); // put the shared worker server back as the other tests expect it
    }
  });
});

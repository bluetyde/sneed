import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures.js';

test.describe('compare saved runs', () => {
  test('OR then AND on the same events: the probability, the cut sets and the gate change are all shown', async ({ app, page }) => {
    await app.open();
    await app.run(); // E1 OR E2, 0.1 each
    expect(await app.topProbability()).toBeCloseTo(0.19, 12);
    await app.select('G1');
    await app.tab('properties');
    await app.field('type').selectOption('and');
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.01, 12);

    await app.tab('compare');
    await expect(page.getByTestId('compare-result')).toHaveCount(0); // nothing is compared until asked
    await page.getByTestId('compare-go').click(); // defaults: the second newest run against the newest
    await expect(page.getByTestId('compare-probability')).toHaveAttribute('data-from', /^0\.19/);
    await expect(page.getByTestId('compare-probability')).toHaveAttribute('data-to', /^0\.01/);
    await expect(page.getByTestId('compare-probability')).toContainText('then');
    await expect(page.getByTestId('compare-model-changes')).toContainText('Gate G1: type or then and');
    const rows = page.locator('[data-testid="compare-cutsets"] tbody tr');
    await expect(rows).toHaveCount(3); // E1 and E2 only in the earlier run, E1 + E2 only in the later one
    await expect(page.locator('tr[data-change="removed"]')).toHaveCount(2);
    await expect(page.locator('tr[data-change="added"]')).toContainText('E1, E2');
    // nothing judges the change
    await expect(page.getByTestId('compare-result')).not.toContainText(/better|worse|safer|improve/i);

    // choose the other direction
    await page.locator('[data-field="compare-a"]').selectOption({ index: 0 });
    await page.locator('[data-field="compare-b"]').selectOption({ index: 1 });
    await page.getByTestId('compare-go').click();
    await expect(page.getByTestId('compare-probability')).toHaveAttribute('data-from', /^0\.01/);
    await expect(page.getByTestId('compare-model-changes')).toContainText('Gate G1: type and then or');

    await page.getByRole('button', { name: 'Clear comparison' }).click();
    await expect(page.getByTestId('compare-result')).toHaveCount(0);
  });

  test('two runs of the same model: unchanged, and the models are said to be the same', async ({ app, page }) => {
    await app.open();
    await app.run();
    await page.getByTestId('run').click();
    await expect(page.getByTestId('run-pill')).toHaveText('Result is current');
    // the second run is a new run folder; wait until the list has it
    await app.tab('compare');
    await expect(page.locator('[data-field="compare-b"] option')).not.toHaveCount(0);
    await page.getByTestId('compare-go').click();
    await expect(page.getByTestId('compare-model-same')).toBeVisible();
    await expect(page.getByTestId('compare-probability')).toContainText('unchanged');
  });

  test('from the keyboard alone: reach the tab, choose runs, compare', async ({ app, page }) => {
    await app.open();
    await app.run();
    await app.select('E1');
    await app.tab('properties');
    await app.field('probability').fill('0.5');
    await app.field('probability').press('Enter');
    await app.run();
    await app.keyTab('compare');
    await app.tabTo(page.getByTestId('compare-go'));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('compare-model-changes')).toContainText('Event E1: probability 0.1 then 0.5');
    await expect(page.getByTestId('compare-probability')).toHaveAttribute('data-to', /^0\.55/);
  });

  test('two runs of the same model, method and engine whose numbers differ are called unexpected', async ({ app, page, srv }) => {
    // The real engine cannot be made to disagree with itself, so two saved runs are written by hand into the run folder, then removed.
    const runs = path.join(srv.dir, 'runs');
    const ids = ['9999-01-01T00-00-00-000Z-fake-a', '9999-01-01T00-00-01-000Z-fake-b'];
    const rec = (p: number): string =>
      JSON.stringify({ schema_version: 1, status: 'completed', completeness: 'complete', method: 'exact', top_event_probability: p, assumptions: {}, engine: { name: 'SCRAM', version: '0.16.2' }, input_hashes: { model_hash: 'same' }, minimal_cut_sets: [{ events: ['E1'], probability: p }] });
    try {
      ids.forEach((id, i) => {
        mkdirSync(path.join(runs, id, 'native'), { recursive: true });
        writeFileSync(path.join(runs, id, 'results.json'), rec(i === 0 ? 0.1 : 0.2));
        writeFileSync(path.join(runs, id, 'native', 'model.json'), JSON.stringify({ events: [{ id: 'E1', probability: 0.1 }], gates: [], top: 'E1' }));
      });
      await app.open();
      await app.tab('compare');
      await page.getByTestId('compare-go').click();
      await expect(page.getByTestId('compare-unexpected')).toContainText('same model with the same method and engine');
      await expect(page.getByTestId('compare-cutsets')).toContainText('0.2');
    } finally {
      for (const id of ids) rmSync(path.join(runs, id), { recursive: true, force: true });
    }
  });
});

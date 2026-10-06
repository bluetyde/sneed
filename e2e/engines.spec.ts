import { expect, test } from './fixtures.js';

test.describe('the two engines', () => {
  test('the built-in engine is the default and gives the hand-checked answers, shown as built into the app', async ({ app, page }) => {
    await app.open();
    await expect(page.getByTestId('engine')).toHaveValue('builtin');
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.19, 12);
    expect(await app.cutSets()).toEqual(['E1', 'E2']);
    await expect(page.getByTestId('results')).toContainText('sneed-bdd');
    await expect(page.getByTestId('results')).toContainText('built into the app, nothing to install');
    await expect(page.getByTestId('results')).toContainText('Engine build'); // the hash of the engine's source files, so a changed solver is a different build
    const build = await page.getByTestId('results').locator('dd code').first().textContent();
    expect(build).toMatch(/^[0-9a-f]{16}$/);
    await expect(page.getByTestId('cross-check')).toHaveCount(0); // a second opinion only when asked for
  });

  test('"Both, and compare" runs SCRAM too and says the two engines agree', async ({ app, page }) => {
    await app.open();
    await page.getByTestId('engine').selectOption('both');
    await app.run();
    await expect(page.getByTestId('cross-check')).toHaveAttribute('data-agree', 'true');
    await expect(page.getByTestId('cross-check')).toContainText('The two engines agree');
    await expect(page.getByTestId('cross-check')).toContainText('SCRAM');
    expect(await app.topProbability()).toBeCloseTo(0.19, 12); // the number shown is the built-in engine's
  });

  test('SCRAM alone still works and is labelled with its runtime', async ({ app, page }) => {
    await app.open();
    await page.getByTestId('engine').selectOption('scram');
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.19, 12);
    await expect(page.getByTestId('results')).toContainText('installed,');
  });

  test('changing the engine makes the shown result out of date until it is run again', async ({ app, page }) => {
    await app.open();
    await app.run();
    await expect(page.getByTestId('run-pill')).toHaveText('Result is current');
    await page.getByTestId('engine').selectOption('scram');
    await expect(page.getByTestId('run-pill')).toHaveText('Result out of date');
    await app.run();
    await expect(page.getByTestId('run-pill')).toHaveText('Result is current');
  });

  test('both engines agree on a model with a K-of-N gate under another gate', async ({ app, page }) => {
    await app.open();
    await app.select('G1');
    await app.action('add-vote').click(); // a K-of-N gate under G1
    await page.getByTestId('engine').selectOption('both');
    await app.run();
    await expect(page.getByTestId('cross-check')).toHaveAttribute('data-agree', 'true');
  });
});

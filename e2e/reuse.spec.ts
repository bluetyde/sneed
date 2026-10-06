import { expect, test } from './fixtures.js';

test.describe('an identical saved run is offered, not silently run again', () => {
  test('the second Run of the same model, method and engine offers the saved result; showing it runs nothing', async ({ app, page }) => {
    await app.open();
    await app.run(); // the first run is saved
    await app.runOffer();
    await expect(page.getByTestId('reuse-offer')).toContainText('This exact run is already saved');
    await expect(page.getByTestId('run-pill')).toHaveText('A saved result for this run exists');
    const before = await page.evaluate(async () => (await (await fetch('/api/runs')).json()).runs.length);
    await page.getByTestId('use-saved').click();
    await expect(page.getByTestId('reused')).toContainText('nothing was run now');
    await expect(page.getByTestId('reuse-offer')).toHaveCount(0);
    expect(await app.topProbability()).toBeCloseTo(0.19, 12);
    expect(await page.evaluate(async () => (await (await fetch('/api/runs')).json()).runs.length)).toBe(before); // no new run folder
  });

  test('"Run again" makes a new run; changing the method or the model withdraws the offer', async ({ app, page }) => {
    await app.open();
    await app.run();
    await app.runOffer();
    const before = await page.evaluate(async () => (await (await fetch('/api/runs')).json()).runs.length);
    await page.getByTestId('run-fresh').click();
    await expect(page.getByTestId('reuse-offer')).toHaveCount(0);
    await expect(page.getByTestId('run-pill')).toHaveText('Result is current');
    expect(await page.evaluate(async () => (await (await fetch('/api/runs')).json()).runs.length)).toBe(before + 1);
    await app.runOffer();
    await page.getByTestId('method').selectOption('rare-event');
    await expect(page.getByTestId('reuse-offer')).toHaveCount(0);
  });

  test('the buttons of the offer are reachable by keyboard', async ({ app, page }) => {
    await app.open();
    await app.run();
    await app.runOffer();
    await page.getByTestId('use-saved').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('run-fresh')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('run-pill')).toHaveText('Result is current');
  });
});

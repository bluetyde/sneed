import { expect, test } from './fixtures.js';

// Keyboard only: these tests never call click(), mouse or hover. Everything is reached with Tab and the arrow keys.

test.describe('keyboard-only operation', () => {
  test('edit two probabilities, run, and read the result without touching the mouse', async ({ app, page }) => {
    await app.open();
    await app.tabTo(app.node('G1')); // the drawing is reachable: one roving Tab stop
    await expect(app.node('G1')).toBeFocused();
    await page.keyboard.press('ArrowDown'); // first input of G1
    await expect(app.node('E1')).toBeFocused();
    await expect(app.node('E1')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Enter'); // edit: focus lands in the properties panel
    await expect(app.field('name')).toBeFocused();
    await page.keyboard.type('Pump 1');
    await page.keyboard.press('Tab'); // probability
    await expect(app.field('probability')).toBeFocused();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('0.3');
    await page.keyboard.press('Enter');
    await expect(app.node('E1')).toContainText('p = 0.3');

    await app.tabTo(app.node('E1')); // the selected node is the Tab stop again
    await page.keyboard.press('ArrowRight'); // sibling E2
    await expect(app.node('E2')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(app.field('name')).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('0.2');
    await page.keyboard.press('Enter');

    await page.keyboard.press('Control+Enter'); // run
    await expect(page.getByTestId('result-status')).toBeVisible({ timeout: 90_000 });
    expect(await app.topProbability()).toBeCloseTo(0.44, 12); // 1 - 0.7 * 0.8
    await expect(page.getByTestId('run-pill')).toHaveText('Result is current');
    // the cut sets are buttons: reachable and operable from the keyboard
    await app.tabTo(page.locator('[data-testid="cut-set"][data-events="E1"]'));
    await page.keyboard.press('Enter');
    await expect(page.locator('g.node.hl[data-id="E1"]')).toHaveCount(1);
    await expect(page.getByTestId('explain')).toContainText('Pump 1');
  });

  test('add a gate with the ribbon, walk the tree with the arrows, delete with the Delete key, undo with Ctrl+Z', async ({ app, page }) => {
    await app.open();
    await app.tabTo(app.node('G1'));
    await page.keyboard.press('Space'); // select G1: new nodes attach to it
    await expect(app.node('G1')).toHaveAttribute('aria-pressed', 'true');
    await app.tabTo(app.action('add-and'));
    await page.keyboard.press('Enter');
    await expect(app.nodes()).toHaveCount(6);
    await app.tabTo(app.node('G2')); // the new gate is selected, so it is the Tab stop
    await page.keyboard.press('ArrowDown');
    await expect(app.node('E3')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(app.node('E4')).toBeFocused();
    await page.keyboard.press('ArrowUp'); // up to the parent
    await expect(app.node('G2')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(app.node('G1')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight'); // G1's third input: G2
    await expect(app.node('G2')).toBeFocused();
    await page.keyboard.press('Delete');
    await expect(app.node('G2')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(app.node('G2')).toHaveCount(1);
    await page.keyboard.press('Control+y');
    await expect(app.node('G2')).toHaveCount(0);
  });

  test('Ctrl+S opens Save as, Enter confirms, Escape closes, and focus is trapped in the dialog', async ({ app, page }) => {
    await app.open();
    await page.keyboard.press('Control+s');
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#save-name')).toBeFocused();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      // a native modal dialog makes the page behind it inert: Tab cycles through the dialog and the browser's own controls,
      // and focus never lands on the editor underneath
      expect(await page.evaluate(() => !!document.activeElement?.closest('.win'))).toBe(false);
    }
    await page.locator('#save-name').focus();
    await page.keyboard.type('keyboard-model');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('doc-name')).toContainText('keyboard-model');
    await page.keyboard.press('Control+s'); // already named: saves without asking
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await app.tabTo(app.action('open'));
    await page.keyboard.press('Enter');
    await expect(page.locator('button[data-model="keyboard-model"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
  });

  test('the side tabs follow the arrow-key pattern and the focus ring is visible', async ({ app, page }) => {
    await app.open();
    await app.tabTo(page.locator('[data-tab="properties"]'));
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-tab="problems"]')).toBeFocused();
    await expect(page.locator('[data-tab="problems"]')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-tab="results"]')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-tab="lesson"]')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-tab="properties"]')).toHaveAttribute('aria-selected', 'true');
    await app.tabTo(app.node('G1'));
    const ring = await app.node('G1').locator('.ring').evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(ring)).toBe(1); // :focus-visible shows the ring
  });

  test('zoom and fit work from the keyboard', async ({ app, page }) => {
    await app.open();
    await app.tabTo(app.node('G1'));
    const scale = async (): Promise<number> => Number(await page.locator('.canvas-wrap').getAttribute('data-scale'));
    const start = await scale();
    await page.keyboard.press('+');
    expect(await scale()).toBeGreaterThan(start);
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    expect(await scale()).toBeLessThan(start);
    await page.keyboard.press('0');
    expect(await scale()).toBeCloseTo(start, 1);
  });
});

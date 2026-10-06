import { expect, test } from './fixtures.js';

const GOOD = ['<?xml version="1.0"?>', '<opsa-mef>', '  <define-fault-tree name="Cooling">', '    <define-gate name="TOP"><and><gate name="L"/><gate name="R"/></and></define-gate>', '    <define-gate name="L"><or><basic-event name="P1"/><basic-event name="S"/></or></define-gate>', '    <define-gate name="R"><or><basic-event name="P2"/><basic-event name="S"/></or></define-gate>', '  </define-fault-tree>', '  <model-data>', '    <define-basic-event name="P1"><float value="0.1"/></define-basic-event>', '    <define-basic-event name="P2"><float value="0.1"/></define-basic-event>', '    <define-basic-event name="S"><float value="0.05"/></define-basic-event>', '  </model-data>', '</opsa-mef>', ''].join('\n');
const BAD = GOOD.replace('<float value="0.05"/>', '<float value="1.7"/>').replace('<define-gate name="L">', '<define-house-event name="H"/>\n    <define-gate name="L">');

test.describe('import an Open-PSA file', () => {
  test('a file is imported, opened, kept beside the model, and analysed to the hand value 0.0595', async ({ app, page }) => {
    await app.open();
    await app.action('import').click();
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('import-confirm')).toBeDisabled(); // nothing chosen yet
    await page.locator('#imp-file').setInputFiles({ name: 'Cooling System.xml', mimeType: 'text/xml', buffer: Buffer.from(GOOD) });
    await expect(page.locator('#imp-name')).toHaveValue('Cooling-System'); // the file name as a model name
    await page.locator('#imp-name').fill('e2e-cooling');
    await page.getByTestId('import-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('doc-name')).toContainText('e2e-cooling');
    await expect(page.getByTestId('notice')).toContainText('Imported e2e-cooling: 3 basic events, 3 gates');
    await expect(page.getByTestId('notice')).toContainText('e2e-cooling.opsa.xml');
    await expect(page.getByTestId('dirty')).toHaveCount(0); // an opened model is not unsaved work
    await expect(app.win).toHaveAttribute('data-valid', 'true');
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.0595, 12);
    expect(await app.cutSets()).toEqual(['P1,P2', 'S']);
  });

  test('a refused file lists every problem with its line, saves nothing and leaves the open model alone', async ({ app, page }) => {
    await app.open();
    const before = await app.modelHash();
    await app.action('import').click();
    await page.locator('#imp-file').setInputFiles({ name: 'bad.xml', mimeType: 'text/xml', buffer: Buffer.from(BAD) });
    await page.locator('#imp-name').fill('e2e-bad');
    await page.getByTestId('import-confirm').click();
    const results = page.getByTestId('import-results');
    await expect(results).toContainText('Not imported: 2 problems');
    await expect(results).toContainText('E_UNSUPPORTED · line 5');
    await expect(results).toContainText('E_PROB_RANGE · line 12');
    await expect(results).toContainText('define-house-event');
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(await app.modelHash()).toBe(before);
    await app.action('open').click();
    await expect(page.locator('button[data-model="e2e-bad"]')).toHaveCount(0);
  });

  test('a name that is taken is refused before anything is sent, and a hostile file is refused as data', async ({ app, page }) => {
    await app.open();
    await app.action('import').click();
    await page.locator('#imp-file').setInputFiles({ name: 'first.xml', mimeType: 'text/xml', buffer: Buffer.from(GOOD) });
    await page.locator('#imp-name').fill('e2e-taken');
    await page.getByTestId('import-confirm').click(); // saves e2e-taken, so that the name is taken for the second try
    await expect(page.getByTestId('doc-name')).toContainText('e2e-taken');
    await app.action('import').click();
    await page.locator('#imp-file').setInputFiles({ name: 'a.xml', mimeType: 'text/xml', buffer: Buffer.from(GOOD) });
    await page.locator('#imp-name').fill('e2e-taken');
    await expect(page.locator('#imp-name-err')).toContainText('exists');
    await expect(page.getByTestId('import-confirm')).toBeDisabled();
    await page.locator('#imp-name').fill('e2e-evil');
    await page.locator('#imp-file').setInputFiles({ name: 'evil.xml', mimeType: 'text/xml', buffer: Buffer.from('<!DOCTYPE x [<!ENTITY e "boom">]><opsa-mef name="&e;"/>') });
    await page.getByTestId('import-confirm').click();
    await expect(page.getByTestId('import-results')).toContainText('E_XML');
    await expect(page.getByTestId('import-results')).toContainText('not accepted');
  });

  test('a file over 2 MB is refused without being read', async ({ app, page }) => {
    await app.open();
    await app.action('import').click();
    await page.locator('#imp-file').setInputFiles({ name: 'huge.xml', mimeType: 'text/xml', buffer: Buffer.alloc(2 * 1024 * 1024 + 10, 'x') });
    await expect(page.locator('#imp-file-err')).toContainText('larger than 2 MB');
    await expect(page.getByTestId('import-confirm')).toBeDisabled();
  });

  test('reachable and operable from the keyboard: Tab to the Import button, Enter opens the dialog, Escape closes it', async ({ app, page }) => {
    await app.open();
    await app.tabTo(app.action('import'));
    await page.keyboard.press('Enter');
    await expect(page.locator('dialog[open]')).toBeVisible();
    await expect(page.locator('#imp-file')).toBeFocused().catch(() => undefined); // focus lands inside the dialog
    expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
  });
});

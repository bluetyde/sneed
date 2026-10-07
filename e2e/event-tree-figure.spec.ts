import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test, buildSharedEventTree as build } from './fixtures.js';

// The drawing, the files and the print sheet of an event tree (plan 13, stage S4), on plan 13 case 6.2 (shared event, 0.5 per year).

const figureTexts = (page: Page, svg: string): Promise<string[]> =>
  page.evaluate((t) => {
    const d = new DOMParser().parseFromString(t, 'image/svg+xml');
    if (d.querySelector('parsererror')) throw new Error('not well-formed');
    return [...d.querySelectorAll('text')].map((x) => x.textContent ?? '');
  }, svg);

test.describe('event tree drawing, files and print', () => {
  test('the drawing has one line per sequence; frequencies appear only with a current result, and go away when it is old', async ({ app, page }) => {
    await app.open();
    await build(page);
    const drawing = page.getByTestId('et-drawing');
    await expect(drawing.locator('svg')).toHaveCount(1);
    let text = await drawing.textContent();
    expect(text).toContain('Injection');
    expect(text).toContain('Cooling');
    expect(text).toContain('1. End state 1 (example)');
    expect(text).toContain('4. End state 1 (example)');
    expect(text).not.toMatch(/0\.077 per year/);
    if (process.env.SNEED_SHOT) await drawing.screenshot({ path: process.env.SNEED_SHOT });
    await page.locator('[data-action="et-run"]').click();
    await expect(page.getByTestId('et-result-status')).toBeVisible();
    text = await drawing.textContent();
    expect(text).toMatch(/0\.077 per year/);
    expect(text).toMatch(/0\.063 per year/);
    expect(text).toMatch(/0\.108 per year/);
    expect(text).toMatch(/0\.252 per year/);
    expect(text).toContain('add up to 1');
    if (process.env.SNEED_SHOT2) await drawing.screenshot({ path: process.env.SNEED_SHOT2 });
    await page.locator('[data-field="et-ie-freq"]').fill('0.7'); // the result now describes another tree
    await page.locator('[data-field="et-ie-freq"]').press('Enter');
    await expect(page.getByTestId('et-stale')).toBeVisible();
    text = await drawing.textContent();
    expect(text).not.toMatch(/0\.077 per year/);
    expect(text).toContain('NO CURRENT RESULT');
  });

  test('a heading asked only on some paths has no branch where it is not asked: three lines, not four', async ({ app, page }) => {
    await app.open();
    await build(page);
    await page.locator('[data-field="et-h-ask-H2"]').selectOption('H1|works');
    await expect(page.locator('[data-seq]')).toHaveCount(3);
    const text = (await page.getByTestId('et-drawing').textContent()) ?? '';
    expect(text).toContain('3. ');
    expect(text).not.toContain('4. ');
    expect(text).toContain('asked only if Injection works');
  });

  test('SVG: a download of a well-formed figure with the drawing and the current result', async ({ app, page }) => {
    await app.open();
    await build(page);
    await page.locator('[data-action="et-run"]').click();
    await expect(page.getByTestId('et-result-status')).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="et-svg"]').click()]);
    expect(download.suggestedFilename()).toMatch(/^[A-Za-z0-9._-]+\.svg$/);
    const texts = (await figureTexts(page, readFileSync((await download.path())!, 'utf8'))).join('\n');
    expect(texts).toContain('0.077 per year');
    expect(texts).toContain('not a plant figure');
    expect(texts).toContain('Injection: fails when X occurs');
    await expect(page.getByTestId('notice')).toContainText('SVG');
  });

  test('a result that is out of date is not drawn into the file as if it were current', async ({ app, page }) => {
    await app.open();
    await build(page);
    await page.locator('[data-action="et-run"]').click();
    await expect(page.getByTestId('et-result-status')).toBeVisible();
    await page.locator('[data-field="et-ie-freq"]').fill('0.9');
    await page.locator('[data-field="et-ie-freq"]').press('Enter');
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="et-svg"]').click()]);
    const text = readFileSync((await download.path())!, 'utf8');
    expect(text).toContain('NO CURRENT RESULT');
    expect(text).not.toContain('0.077 per year');
  });

  test('PNG: a real image of the drawing, not blank', async ({ app, page }) => {
    await app.open();
    await build(page);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="et-png"]').click()]);
    const bytes = readFileSync((await download.path())!);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.readUInt32BE(16)).toBeGreaterThan(600);
    const dark = await page.evaluate(async (b64) => {
      const img = new Image();
      await new Promise<void>((r, j) => { img.onload = () => r(); img.onerror = () => j(new Error('decode')); img.src = `data:image/png;base64,${b64}`; });
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i]! < 100 && px[i + 3]! > 200) n++;
      return n;
    }, bytes.toString('base64'));
    expect(dark).toBeGreaterThan(500);
  });

  test('printing shows only the sheet (drawing and both tables), and it is gone again afterwards', async ({ app, page }) => {
    await app.open();
    await build(page);
    await page.locator('[data-action="et-run"]').click();
    await expect(page.getByTestId('et-result-status')).toBeVisible();
    expect(await page.getByTestId('print-sheet').count()).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({ media: 'print' });
    const sheet = page.getByTestId('print-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('svg')).toHaveCount(1);
    await expect(sheet.locator('table.sheet-table')).toHaveCount(2);
    await expect(sheet.locator('table.sheet-table').first().locator('tbody tr')).toHaveCount(4);
    await expect(sheet).toContainText('Injection fails, Cooling fails');
    await expect(sheet).toContainText('0.077');
    await expect(page.getByTestId('et')).toBeHidden();
    const pdf = await page.pdf({ format: 'A4' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.emulateMedia({ media: 'screen' });
    expect(await page.getByTestId('print-sheet').count()).toBe(0);
  });

  test('the fault-tree print sheet is still what prints in the fault-tree view', async ({ app, page }) => {
    await app.open();
    await app.run();
    await page.locator('[data-mode="event-tree"]').click();
    await page.locator('[data-mode="fault-tree"]').click();
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await expect(page.getByTestId('print-sheet')).toContainText('Top event probability');
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  });
});

import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures.js';

test.describe('saving the drawing as an image and printing it', () => {
  test('SVG: a download of a well-formed figure with the drawing and the current result', async ({ app, page }) => {
    await app.open();
    await app.run();
    const [download] = await Promise.all([page.waitForEvent('download'), app.action('export-svg').click()]);
    expect(download.suggestedFilename()).toMatch(/^[A-Za-z0-9._-]+\.svg$/);
    const text = readFileSync((await download.path())!, 'utf8');
    const parsed = await page.evaluate((t) => {
      const d = new DOMParser().parseFromString(t, 'image/svg+xml');
      return { error: d.querySelector('parsererror')?.textContent ?? null, root: d.documentElement.localName, texts: [...d.querySelectorAll('text')].map((x) => x.textContent) };
    }, text);
    expect(parsed.error).toBeNull();
    expect(parsed.root).toBe('svg');
    expect(parsed.texts.join('\n')).toContain('Top event probability: 0.19.');
    expect(parsed.texts.join('\n')).toContain('E1');
    await expect(page.getByTestId('notice')).toContainText('SVG');
  });

  test('PNG: a download that is a real PNG image of the drawing, drawn by the browser from the same figure', async ({ app, page }) => {
    await app.open();
    await app.run();
    const [download] = await Promise.all([page.waitForEvent('download'), app.action('export-png').click()]);
    expect(download.suggestedFilename()).toMatch(/\.png$/);
    const bytes = readFileSync((await download.path())!);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    expect(width).toBeGreaterThan(600);
    expect(height).toBeGreaterThan(300);
    // not a blank page: decode it and look for dark pixels
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

  test('a result that is out of date is not drawn into the figure as if it were current', async ({ app, page }) => {
    await app.open();
    await app.run();
    await app.setProbability('E1', '0.3'); // the shown result is now for an earlier model
    const [download] = await Promise.all([page.waitForEvent('download'), app.action('export-svg').click()]);
    const text = readFileSync((await download.path())!, 'utf8');
    expect(text).toContain('NO CURRENT RESULT');
    expect(text).not.toContain('Top event probability');
  });

  test('printing shows only the sheet (drawing, result, cut set table), and it is gone again afterwards', async ({ app, page }) => {
    await app.open();
    await app.run();
    expect(await page.getByTestId('print-sheet').count()).toBe(0); // not in the page on screen
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({ media: 'print' });
    const sheet = page.getByTestId('print-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('svg')).toHaveCount(1);
    await expect(sheet).toContainText('Top event probability: 0.19.');
    await expect(sheet.locator('table.sheet-table tbody tr')).toHaveCount(2);
    await expect(sheet.locator('table.sheet-table')).toContainText('E1');
    // nothing of the editor is printed
    await expect(page.getByTestId('canvas')).toBeHidden();
    await expect(page.getByTestId('run')).toBeHidden();
    const pdf = await page.pdf({ format: 'A4' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(3000);
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.emulateMedia({ media: 'screen' });
    expect(await page.getByTestId('print-sheet').count()).toBe(0);
    await expect(page.getByTestId('canvas')).toBeVisible();
  });

  test('the export buttons are reachable by keyboard and have names', async ({ app, page }) => {
    await app.open();
    for (const a of ['export-svg', 'export-png', 'print']) {
      const b = app.action(a);
      await expect(b).toBeVisible();
      expect(await b.getAttribute('aria-label')).toMatch(/\S/);
      await b.focus();
      await expect(b).toBeFocused();
    }
  });
});

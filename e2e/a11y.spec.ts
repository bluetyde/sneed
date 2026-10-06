import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

// Automated accessibility audit with axe-core (WCAG 2.0 / 2.1 A and AA plus best practices) over every distinct state of the editor.
// Automated checks find some problems, not all: keyboard operation is tested separately and a screen-reader pass is still a human task.

const axePath = createRequire(import.meta.url).resolve('axe-core');

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: unknown[]; failureSummary?: string }[];
}

async function audit(page: Page, label: string): Promise<void> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: Violation[] }> } }).axe;
    return axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } });
  });
  const summary = result.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n   ` + v.nodes.slice(0, 3).map((n) => JSON.stringify(n.target) + ' ' + (n.failureSummary ?? '').split('\n').slice(0, 2).join(' ')).join('\n   '));
  expect(summary, `axe violations in: ${label}`).toEqual([]);
}

// axe is injected as an inline script, which the app's strict content security policy (correctly) refuses. The policy does not
// change the page's structure, so the audit runs with it bypassed; the policy itself is checked in editor.spec.ts.
test.use({ bypassCSP: true });

test.describe('accessibility', () => {
  test('the first screen, with a node selected, and each side panel have no axe violations', async ({ app, page }) => {
    await app.open();
    await audit(page, 'first screen');
    await app.select('E1');
    await audit(page, 'a basic event selected (properties)');
    await app.select('G1');
    await audit(page, 'a gate selected (properties)');
    await page.keyboard.press('Escape');
    await audit(page, 'nothing selected (model form)');
    await app.tab('problems');
    await audit(page, 'problems tab, no problems');
  });

  test('a model with problems, repeated references and a stale result have no axe violations', async ({ app, page }) => {
    await app.open();
    await app.select('G1');
    await app.action('add-and').click();
    await app.field('add-input').selectOption('G1'); // a cycle
    await page.getByRole('button', { name: 'Add input' }).click();
    await app.field('add-input').selectOption('E1');
    await page.getByRole('button', { name: 'Add input' }).click(); // a repeated reference too
    await app.tab('problems');
    await expect(page.locator('li.problem[data-code="E_CYCLE"]')).toBeVisible();
    await audit(page, 'problems listed');
    await page.locator('g.node[data-kind="reference"]').first().click();
    await audit(page, 'a repeated reference selected');
  });

  test('results, a cut set explained, a stale banner and a labelled caveat have no axe violations', async ({ app, page }) => {
    await app.open();
    await app.run();
    await audit(page, 'results');
    await page.locator('[data-testid="cut-set"]').first().click();
    await audit(page, 'a cut set explained');
    await app.setProbability('E1', '0.5');
    await app.tab('results');
    await expect(page.getByTestId('stale')).toBeVisible();
    await audit(page, 'stale result');
    await app.select('G1');
    await app.action('add-event').click();
    for (const k of ['E1', 'E2', 'E3']) await app.setProbability(k, '0.9');
    await page.getByTestId('method').selectOption('rare-event');
    await app.run();
    await expect(page.getByTestId('caveat')).toBeVisible();
    await audit(page, 'rare-event caveat');
  });

  test('the Open and Save as dialogs have no axe violations', async ({ app, page }) => {
    await app.open();
    await app.action('saveas').click();
    await expect(page.locator('dialog[open]')).toBeVisible();
    await audit(page, 'save as dialog');
    await page.locator('#save-name').fill('axe-model');
    await page.getByTestId('save-confirm').click();
    await app.action('open').click();
    await expect(page.locator('button[data-model="axe-model"]')).toBeVisible();
    await audit(page, 'open dialog with a model listed');
  });

  test('every control has an accessible name and every node says what it is', async ({ app, page }) => {
    await app.open();
    const unnamed = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll('button, input, select, textarea, [role="button"], [role="tab"]')) {
        const e = el as HTMLElement;
        if (e.hidden || e.closest('[hidden]')) continue;
        const name = e.getAttribute('aria-label') || e.getAttribute('title') || (e as HTMLInputElement).labels?.[0]?.textContent || e.textContent?.trim();
        if (!name) bad.push(e.outerHTML.slice(0, 80));
      }
      return bad;
    });
    expect(unnamed).toEqual([]);
    const labels = await app.nodes().evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(labels).toEqual(['OR gate G1, 2 inputs, top event', 'Basic event E1, probability 0.1', 'Basic event E2, probability 0.1']);
    await expect(page.getByRole('group', { name: 'Fault tree drawing' })).toBeVisible();
    await expect(page.getByRole('toolbar', { name: 'Editor tools' })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Side panels' })).toBeVisible();
    expect(await page.locator('html').getAttribute('lang')).toBe('en');
  });

  test('colour is never the only signal: a node with a problem also has a badge, an aria-label and an outline mark', async ({ app, page }) => {
    await app.open();
    await app.select('G1');
    await page.getByRole('button', { name: 'Remove input E2 from G1' }).click(); // an OR with one input
    await expect(app.node('G1')).toHaveAttribute('aria-label', /has a problem to fix/);
    await expect(app.node('G1').locator('.badge-err')).toHaveCount(1);
    await expect(app.node('G1').locator('text.t-badge')).toHaveText('!');
    await expect(page.getByTestId('outline').locator('button[data-key="G1"]')).toHaveAttribute('aria-label', /has a problem/);
    // the run pill says it in words, not only red
    await expect(page.getByTestId('run-pill')).toContainText('problem');
  });

  test('at 200% zoom (a 700 px wide window) the page does not scroll sideways and the main controls stay reachable', async ({ app, page }) => {
    await page.setViewportSize({ width: 700, height: 430 });
    await app.open();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await expect(page.getByTestId('run')).toBeVisible();
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.locator('[data-tab="results"]')).toBeVisible();
    await app.run();
    await expect(page.getByTestId('top-probability')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });

  test('reduced motion and forced dark scheme do not break the page', async ({ app, page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await app.open();
    await expect(app.win).toHaveAttribute('data-valid', 'true');
  });

  test('the lesson tab (list, an active lesson with a mistake, a completed lesson with the hand calculation) has no axe violations', async ({ app, page }) => {
    await app.open();
    await app.tab('lesson');
    await audit(page, 'lesson list');
    await page.locator('[data-lesson="02-redundant-pumps"]').click();
    await audit(page, 'lesson started, nothing built');
    await app.action('add-or').click();
    await app.setName('E1', 'P1');
    await app.setName('E2', 'P2');
    await app.setProbability('E1', '0.5'); // a wrong probability
    await app.tab('lesson');
    await audit(page, 'lesson in progress');
    await app.setProbability('E1', '0.1');
    await app.run();
    await app.tab('lesson');
    await expect(page.getByTestId('lesson-complete')).toBeVisible();
    await page.getByTestId('show-calc').click();
    await audit(page, 'lesson complete with hand calculation');
  });

  test('the compare tab (choosing runs, a comparison with model and cut-set changes) has no axe violations', async ({ app, page }) => {
    await app.open();
    await app.run();
    await app.select('G1');
    await app.tab('properties');
    await app.field('type').selectOption('and');
    await app.run();
    await app.tab('compare');
    await audit(page, 'compare, runs to choose');
    await page.getByTestId('compare-go').click();
    await expect(page.getByTestId('compare-probability')).toBeVisible();
    await audit(page, 'compare, a comparison shown');
  });

  test('the engine choice and the cross-check card (agree, and no second opinion) have no axe violations', async ({ app, page }) => {
    await app.open();
    await audit(page, 'engine select on the first screen');
    await page.getByTestId('engine').selectOption('both');
    await app.run();
    await expect(page.getByTestId('cross-check')).toHaveAttribute('data-agree', 'true');
    await audit(page, 'cross-check: the engines agree');
  });

  test('the import dialog (empty, with a refusal listed) has no axe violations', async ({ app, page }) => {
    await app.open();
    await app.action('import').click();
    await audit(page, 'import dialog, nothing chosen');
    const bad = '<opsa-mef><define-fault-tree name="F"><define-house-event name="H"/><define-basic-event name="A"><float value="3"/></define-basic-event></define-fault-tree></opsa-mef>';
    await page.locator('#imp-file').setInputFiles({ name: 'bad.xml', mimeType: 'text/xml', buffer: Buffer.from(bad) });
    await page.locator('#imp-name').fill('a11y-bad');
    await page.getByTestId('import-confirm').click();
    await expect(page.getByTestId('import-results')).toContainText('Not imported');
    await audit(page, 'import dialog, a refusal listed');
  });

  test('the offer of a saved identical run, and a reused result, have no axe violations', async ({ app, page }) => {
    await app.open();
    await app.run();
    await app.runOffer();
    await audit(page, 'a saved identical run is offered');
    await page.getByTestId('use-saved').click();
    await expect(page.getByTestId('reused')).toBeVisible();
    await audit(page, 'a reused saved result is shown');
  });

  test('the importance table and its definitions have no axe violations', async ({ app, page }) => {
    await app.open();
    await app.run();
    await page.getByTestId('compute-importance').click();
    await expect(page.getByTestId('importance-table')).toBeVisible();
    await audit(page, 'importance table');
    await page.getByText('What these measures mean').click();
    await audit(page, 'importance definitions open');
  });
});

import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

// Common-cause groups in the real editor (plan 15, stage C4): make a group from an event's properties, see it drawn and listed, edit beta,
// run, and read the answer against the independent one. Uses the built-in engine, so it needs no SCRAM.

const axePath = createRequire(import.meta.url).resolve('axe-core');
async function audit(page: Page, label: string): Promise<void> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: { id: string; help: string; nodes: { target: unknown[] }[] }[] }> } }).axe;
    return axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } });
  });
  const summary = result.violations.map((v) => `${v.id}: ${v.help} ${JSON.stringify(v.nodes.slice(0, 3).map((n) => n.target))}`);
  expect(summary, `axe violations in: ${label}`).toEqual([]);
}
test.use({ bypassCSP: true });

test.describe('common-cause groups', () => {
  test('make a group, see it drawn, set beta, run, and read the result against the independent one', async ({ app, page }) => {
    await app.open(); // the first model: G1 = E1 OR E2, both 0.1
    await app.select('E1');
    await app.tab('properties');
    await expect(page.getByTestId('group-block')).toBeVisible();
    await expect(page.locator('.ccgroup')).toHaveCount(0);
    await app.action('make-group').click();

    // the group is selected and drawn: a box with its name and beta, and a tag on each member
    await expect(page.locator('[data-field="beta"]')).toHaveValue('0.1');
    await expect(page.locator('.ccgroup[data-group="CC1"]')).toBeVisible();
    await expect(page.locator('.ccgroup[data-group="CC1"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('g.node .badge-cc')).toHaveCount(2);
    await expect(page.locator('g.node[data-key="E1"]')).toHaveAttribute('aria-label', /in common-cause group CC1/);
    await expect(page.getByTestId('outline-groups').locator('[data-group="CC1"]')).toBeVisible();
    await expect(page.getByTestId('group-numbers')).toContainText('0.09'); // fails alone: (1 - 0.1) x 0.1
    await expect(page.getByTestId('group-numbers')).toContainText('0.01'); // common cause: 0.1 x 0.1
    await expect(app.win).toHaveAttribute('data-valid', 'true');

    // beta: a number outside 0 to 1 is refused at the field, a good one is taken
    await page.locator('[data-field="beta"]').fill('1.5');
    await page.locator('[data-field="beta"]').press('Enter');
    await expect(page.locator('#err-beta')).toBeVisible();
    await expect(page.locator('[data-field="beta"]')).toHaveAttribute('aria-invalid', 'true');
    await page.locator('[data-field="beta"]').fill('0.3');
    await page.locator('[data-field="beta"]').press('Enter');
    await expect(page.getByTestId('group-numbers')).toContainText('0.07'); // (1 - 0.3) x 0.1
    await page.locator('[data-field="name"]').fill('Pumps');
    await page.locator('[data-field="name"]').press('Enter');
    await expect(page.locator('.ccgroup[data-group="CC1"]')).toContainText('Pumps · beta 0.3');

    // the members share one probability: changing one changes both
    await app.setProbability('E1', '0.2');
    await app.select('E2');
    await expect(app.field('probability')).toHaveValue('0.2');
    await app.setProbability('E2', '0.1');

    // run: OR of two events with Q = 0.1 and beta = 0.3 is 1 - (1 - 0.07)^2 x (1 - 0.03) = 0.161047; independent it is 0.19
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.161047, 6);
    const cc = page.getByTestId('common-cause-result');
    await expect(cc).toBeVisible();
    await expect(cc).toContainText('different kind of result');
    await expect(cc).toContainText('Pumps: E1, E2; beta 0.3');
    await expect(page.getByTestId('common-cause-compare')).toContainText('0.19');
    await expect(page.getByTestId('common-cause-compare')).toContainText('lower');
    await expect(page.getByTestId('cc-names')).toBeVisible();
    expect(await app.cutSets()).toEqual(['CC1.CCF', 'E1.independent', 'E2.independent']);

    // a cut set of the group is explained in words, and the group event lights up its members on the drawing
    await page.locator('[data-testid="cut-set"][data-events="CC1.CCF"]').click();
    await expect(page.getByTestId('explain')).toContainText('the common cause of group Pumps');

    await audit(page, 'a model with a group and its result');
  });

  test('taking a member out removes a group of two; deleting the group keeps the events; undo brings it back', async ({ app, page }) => {
    await app.open();
    await app.select('E1');
    await app.action('make-group').click();
    await expect(page.locator('.ccgroup')).toHaveCount(1);
    await app.select('E1');
    await app.action('leave-group').click();
    await expect(page.locator('.ccgroup')).toHaveCount(0);
    await expect(app.nodes()).toHaveCount(3);
    await page.keyboard.press('Control+z');
    await expect(page.locator('.ccgroup')).toHaveCount(1);
    await page.locator('.ccgroup[data-group="CC1"]').locator('.bar').click();
    await app.action('delete-group').click();
    await expect(page.locator('.ccgroup')).toHaveCount(0);
    await expect(app.nodes()).toHaveCount(3);
    await expect(app.win).toHaveAttribute('data-valid', 'true');
  });

  test('keyboard only: the group is reached from the outline and edited from the properties', async ({ app, page }) => {
    await app.open();
    await app.select('E1');
    await app.action('make-group').click();
    await page.keyboard.press('Escape');
    await app.select('G1'); // leave the group
    const item = page.getByTestId('outline-groups').locator('[data-group="CC1"]');
    await app.tabTo(item);
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-field="beta"]')).toBeVisible();
    await app.tabTo(page.locator('[data-field="beta"]'));
    await page.keyboard.type('0.25');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('group-numbers')).toContainText('0.075'); // (1 - 0.25) x 0.1
  });

  test('lesson 5, in the browser: a group makes AND worse and OR a little better, and the lesson completes on the OR result', async ({ app, page }) => {
    const step = (id: string) => page.locator(`[data-testid="lesson-step"][data-step="${id}"]`);
    await app.open();
    await app.tab('lesson');
    await page.locator('[data-lesson="05-common-cause"]').click();
    await expect(page.getByTestId('lesson-title')).toHaveText('Pumps that fail together');
    await expect(page.getByTestId('lesson-blank')).toBeVisible();
    await app.action('add-and').click();
    await app.setName('E1', 'A');
    await app.setName('E2', 'B');
    await app.tab('lesson');
    await expect(step('two-pumps')).toHaveAttribute('data-done', 'true');
    await expect(step('and-top')).toHaveAttribute('data-done', 'true');
    await expect(step('group')).toHaveAttribute('data-done', 'false');

    // independent pumps first: 0.01
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.01, 12);

    // the group, named G, beta 0.1 (the default)
    await app.select('E1');
    await app.tab('properties');
    await app.action('make-group').click();
    await page.locator('[data-field="name"]').fill('G');
    await page.locator('[data-field="name"]').press('Enter');
    await app.tab('lesson');
    await expect(step('group')).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('lesson-complete')).toHaveCount(0);
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.018019, 12); // higher than 0.01
    await expect(page.getByTestId('common-cause-compare')).toContainText('higher');
    await app.tab('lesson');
    await expect(step('switch-to-or')).toContainText('Next');
    await expect(page.getByTestId('lesson-complete')).toHaveCount(0); // the last step is still to do

    await app.select('G1');
    await app.tab('properties');
    await app.field('type').selectOption('or');
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.180181, 12); // lower than 0.19
    await expect(page.getByTestId('common-cause-compare')).toContainText('lower');
    await app.tab('lesson');
    await expect(page.getByTestId('lesson-complete')).toContainText('common cause');
    await audit(page, 'lesson 5 complete');
  });

  test('importance measures of a model with a group are for the events the group is made of', async ({ app, page }) => {
    await app.open();
    await app.select('E1');
    await app.action('make-group').click();
    await app.tab('results');
    await page.getByTestId('compute-importance').click();
    const table = page.getByTestId('importance-table');
    await expect(table).toBeVisible({ timeout: 30_000 });
    const ids = await table.locator('tbody tr').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.event!).sort());
    expect(ids).toEqual(['CC1.CCF', 'E1.independent', 'E2.independent']); // a member is not an event of its own any more
    await expect(table.locator('tr[data-event="CC1.CCF"]')).toContainText('common cause of group CC1');
    await expect(table.locator('tr[data-event="E1.independent"]')).toContainText('E1 on its own');
    await expect(page.getByTestId('results')).toContainText('common-cause groups (beta-factor)');
    await audit(page, 'importance table of a model with a group');
  });
});

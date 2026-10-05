import { expect, test } from './fixtures.js';

// Real browser, real server, real SCRAM. Every number below is a hand-derived oracle (tests/oracles.json), not engine output.

test.describe('the editor in a real browser', () => {
  test('opens on a valid two-event OR with the runtime found and nothing to fix', async ({ app, page }) => {
    const problems: string[] = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(e.message));
    await app.open();
    // the strict content security policy is in force and nothing the page does violates it
    const csp = (await page.request.get('/')).headers()['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    await expect(page).toHaveTitle(/Untitled model/);
    await expect(app.win).toHaveAttribute('data-valid', 'true');
    await expect(page.getByTestId('runtime-state')).toContainText('SCRAM 0.16.2');
    await expect(page.getByTestId('model-hash')).toHaveAttribute('data-hash', /^[0-9a-f]{64}$/);
    await expect(app.nodes()).toHaveCount(3);
    await expect(page.getByTestId('outline').locator('button.tree-item')).toHaveCount(3);
    await expect(page.getByTestId('run')).toBeEnabled();
    await expect(page.getByTestId('run-pill')).toHaveText('Ready to run');
    await app.run(); // a whole run under the policy produces no console error and no script error
    expect(problems).toEqual([]);
  });

  test('lesson 3a: a shared power supply. OR of the supply and two pumps in AND = 0.0595', async ({ app, page }) => {
    await app.open();
    await app.select('G1');
    await app.action('add-and').click(); // G2 = AND(E3, E4) under G1
    await app.select('E2');
    await app.action('delete').click(); // G1 = OR(E1, G2)
    await app.setName('E1', 'Power supply');
    await app.setProbability('E1', '0.05');
    await app.setProbability('E3', '0.1');
    await app.setProbability('E4', '0.1');
    await app.run();
    await expect(page.getByTestId('result-status')).toContainText('completed / complete');
    expect(await app.topProbability()).toBeCloseTo(0.0595, 9);
    expect(await app.cutSets()).toEqual(['E1', 'E3,E4']);
    await expect(page.getByTestId('run-pill')).toHaveText('Result is current');
  });

  test('lesson 3b: separate supplies. (P1 or S1) and (P2 or S2) = 0.021025, four cut sets', async ({ app, page }) => {
    await app.open();
    await app.select('G1');
    await app.field('type').selectOption('and');
    await app.select('G1');
    await app.action('add-or').click(); // G2 = OR(E3, E4)
    await app.select('G1');
    await app.action('add-or').click(); // G3 = OR(E5, E6)
    for (const k of ['E1', 'E2']) {
      await app.select(k);
      await app.action('delete').click(); // G1 = AND(G2, G3)
    }
    for (const [k, p] of [['E3', '0.1'], ['E4', '0.05'], ['E5', '0.1'], ['E6', '0.05']] as const) await app.setProbability(k, p);
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.021025, 9);
    expect(await app.cutSets()).toEqual(['E3,E5', 'E3,E6', 'E4,E5', 'E4,E6']);
  });

  test('a repeated reference is one event: A OR A is 0.1, not 0.19, and the drawing shows one event and one marker', async ({ app, page }) => {
    await app.open();
    await app.select('G1');
    await page.getByRole('button', { name: 'Remove input E2 from G1' }).click(); // G1 = OR(E1)
    await expect(page.getByTestId('problem-count')).toHaveText('1'); // an OR with one input is named
    await app.field('add-input').selectOption('E1');
    await page.getByRole('button', { name: 'Add input' }).click(); // G1 = OR(E1, E1)
    await expect(app.win).toHaveAttribute('data-valid', 'true');
    await expect(page.locator('g.node[data-kind="event"][data-id="E1"]')).toHaveCount(1);
    await expect(page.locator('g.node[data-kind="reference"][data-id="E1"]')).toHaveCount(1);
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.1, 12);
    expect(await app.cutSets()).toEqual(['E1']);
    // selecting the marker explains it and highlights the event it points at
    await page.locator('g.node[data-kind="reference"]').click();
    await expect(page.getByTestId('properties')).toContainText('Repeated reference to E1');
    await expect(page.getByTestId('properties')).toContainText('not two copies');
    await expect(page.locator('g.node[data-kind="event"][data-id="E1"]')).toHaveClass(/sibling/);
  });

  test('problems are named, selectable, block Run, and clear when fixed', async ({ app, page }) => {
    await app.open();
    await app.select('G1');
    await app.action('add-and').click(); // G2 under G1
    await app.field('add-input').selectOption('G1'); // G2 gets G1 as an input: a cycle
    await page.getByRole('button', { name: 'Add input' }).click();
    await expect(app.win).toHaveAttribute('data-valid', 'false');
    await expect(page.getByTestId('problem-count')).toHaveText('1');
    await expect(page.getByTestId('run')).toBeDisabled();
    await expect(page.getByTestId('run-pill')).toContainText('Run blocked: 1 problem to fix first');
    await expect(page.locator('g.node.err').first()).toBeVisible();
    await app.tab('problems');
    const cycle = page.locator('li.problem[data-code="E_CYCLE"]');
    await expect(cycle).toBeVisible();
    await expect(cycle).toContainText('cannot depend on itself');
    await app.select('E3');
    await cycle.getByRole('button', { name: /Select/ }).click();
    await expect(page.locator('g.node[aria-pressed="true"]')).toHaveAttribute('data-id', /^G[12]$/);
    // fix it: remove the input that closes the loop
    await app.select('G2');
    await app.tab('properties');
    await page.getByRole('button', { name: 'Remove input G1 from G2' }).click();
    await expect(app.win).toHaveAttribute('data-valid', 'true');
    await expect(page.getByTestId('run')).toBeEnabled();
    await app.tab('problems');
    await expect(page.getByTestId('no-problems')).toBeVisible();
  });

  test('an out-of-range probability is refused with the reason and changes nothing', async ({ app, page }) => {
    await app.open();
    const before = await app.modelHash();
    await app.select('E1');
    await app.field('probability').fill('1.5');
    await app.field('probability').press('Enter');
    await expect(page.locator('#err-probability')).toContainText('outside 0 to 1');
    await expect(app.field('probability')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('dirty')).toHaveCount(0);
    expect(await app.modelHash()).toBe(before);
    await app.field('probability').fill('abc').catch(() => undefined); // a number field takes no letters; empty is refused too
    await app.field('probability').fill('');
    await app.field('probability').press('Enter');
    await expect(page.locator('#err-probability')).toContainText('Enter a number');
    await app.field('probability').fill('0.3');
    await app.field('probability').press('Enter');
    await expect(page.locator('#err-probability')).toBeHidden();
    await app.hashChangedFrom(before);
  });

  test('a result goes stale when the model changes, and current again when the change is undone', async ({ app, page }) => {
    await app.open();
    await app.setProbability('E1', '0.3');
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.37, 12); // 1 - 0.7 * 0.9
    await app.setProbability('E2', '0.2');
    await expect(page.getByTestId('run-pill')).toHaveText('Result out of date');
    await app.tab('results');
    await expect(page.getByTestId('stale')).toBeVisible();
    await page.keyboard.press('Control+z'); // focus is on the canvas, not a text field
    await expect(page.getByTestId('run-pill')).toHaveText('Result is current');
    await expect(page.getByTestId('stale')).toHaveCount(0);
    await page.keyboard.press('Control+y');
    await expect(page.getByTestId('run-pill')).toHaveText('Result out of date');
  });

  test('changing the method makes the result stale; the exact value is unchanged by a layout move', async ({ app, page }) => {
    await app.open();
    await app.run();
    await page.getByTestId('method').selectOption('mcub');
    await expect(page.getByTestId('run-pill')).toHaveText('Result out of date');
    await page.getByTestId('method').selectOption('exact');
    await expect(page.getByTestId('run-pill')).toHaveText('Result is current');
  });

  test('moving a node changes the layout, not the model hash, and the result stays current', async ({ app, page }) => {
    await app.open();
    await app.run();
    const hash = await app.modelHash();
    const box = (await app.node('E1').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 45, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByTestId('dirty')).toBeVisible(); // the file has changed
    const after = (await app.node('E1').boundingBox())!;
    expect(Math.abs(after.x - box.x)).toBeGreaterThan(30);
    expect(await app.modelHash()).toBe(hash); // the model has not
    await expect(page.getByTestId('run-pill')).toHaveText('Result is current');
    // undo restores the position and the clean state
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('dirty')).toHaveCount(0);
    // auto layout forgets a moved position
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByTestId('dirty')).toBeVisible();
    await app.action('reset-layout').click();
    await expect(page.getByTestId('dirty')).toHaveCount(0);
  });

  test('dragging from a gate to a node connects them (a repeated reference when the node is used already)', async ({ app, page }) => {
    await app.open();
    await app.select('G1');
    await app.action('add-and').click(); // G2 = AND(E3, E4) under G1
    const port = page.locator('g.node[data-key="G2"] .port');
    const target = (await app.node('E1').boundingBox())!;
    const from = (await port.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
    await page.mouse.up();
    await app.select('G2');
    await expect(page.getByRole('list', { name: 'Inputs of G2' }).locator('li')).toHaveCount(3);
    await expect(page.locator('g.node[data-kind="reference"][data-id="E1"]')).toHaveCount(1); // E1 now has two uses
    await expect(app.win).toHaveAttribute('data-valid', 'true');
  });

  test('save, reload, open: the same model hash; unsaved work is guarded', async ({ app, page }) => {
    await app.open();
    const initial = await app.modelHash();
    await app.setProbability('E1', '0.3');
    const edited = await app.hashChangedFrom(initial);
    await app.action('saveas').click();
    await page.locator('#save-name').fill('lesson-one');
    await page.getByTestId('save-confirm').click();
    await expect(page.getByTestId('doc-name')).toContainText('lesson-one');
    await expect(page.getByTestId('dirty')).toHaveCount(0);

    await page.reload();
    await app.ready();
    await expect(page.getByTestId('doc-name')).toContainText('not saved yet'); // a reload starts a fresh model
    await app.action('open').click();
    await page.locator('button[data-model="lesson-one"]').click();
    await expect(page.getByTestId('doc-name')).toContainText('lesson-one');
    await expect.poll(() => app.modelHash()).toBe(edited);
    await expect(page.getByTestId('dirty')).toHaveCount(0);

    // unsaved work: New asks first, and declining keeps the model
    await app.setProbability('E2', '0.4');
    await expect(page.getByTestId('dirty')).toBeVisible();
    page.once('dialog', (d) => void d.dismiss());
    await app.action('new').click();
    await expect(page.getByTestId('doc-name')).toContainText('lesson-one');
    await expect(page.getByTestId('dirty')).toBeVisible();
    // and the browser's own leave-the-page guard is armed while the model is dirty
    expect(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true);
    page.once('dialog', (d) => void d.accept());
    await app.action('new').click();
    await expect(page.getByTestId('doc-name')).toContainText('not saved yet');
    await expect(page.getByTestId('dirty')).toHaveCount(0);
    expect(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(false); // clean: no guard
  });

  test('Save needs a valid name and offers Replace for an existing one', async ({ app, page }) => {
    await app.open();
    await app.action('saveas').click();
    await page.locator('#save-name').fill('bad name/../x');
    await expect(page.locator('#save-err')).toBeVisible();
    await expect(page.getByTestId('save-confirm')).toBeDisabled();
    await page.locator('#save-name').fill('twice');
    await page.getByTestId('save-confirm').click();
    await expect(page.getByTestId('doc-name')).toContainText('twice');
    await app.action('saveas').click();
    await page.locator('#save-name').fill('twice');
    await expect(page.getByTestId('save-confirm')).toHaveText('Replace');
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
  });

  test('choosing a cut set shows it on the drawing in plain words; Escape clears it', async ({ app, page }) => {
    await app.open();
    await app.setName('E1', 'Pump 1');
    await app.run();
    await page.locator('[data-testid="cut-set"][data-events="E1"]').click();
    await expect(page.locator('g.node.hl[data-id="E1"]')).toHaveCount(1);
    await expect(page.locator('g.node.hl[data-id="E2"]')).toHaveCount(0);
    await expect(page.getByTestId('explain')).toHaveText('The top event occurs if Pump 1 fails.');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('explain')).toHaveCount(0);
    await expect(page.locator('g.node.hl')).toHaveCount(0);
  });

  test('a rare-event sum above 1 is shown labelled, with the real value and the bound as the probability', async ({ app, page }) => {
    await app.open();
    await app.select('G1');
    await app.action('add-event').click(); // E3 under G1
    for (const k of ['E1', 'E2', 'E3']) await app.setProbability(k, '0.9');
    await page.getByTestId('method').selectOption('rare-event');
    await app.run();
    await expect(page.getByTestId('result-status')).toContainText('completed / complete');
    await expect(page.getByTestId('caveat')).toContainText('not a probability here');
    await expect(page.getByTestId('caveat')).toContainText('2.7');
    expect(await app.topProbability()).toBe(1);
  });

  test('K-of-N: 2 of 3 at p = 0.1 is 0.028; K outside 2 <= K < N is named as a problem', async ({ app, page }) => {
    await app.open();
    await app.select('G1');
    await app.action('add-vote').click(); // G2 = 2 of 3 under G1
    await app.select('G2');
    await page.getByRole('button', { name: 'Make top event' }).click();
    for (const k of ['E3', 'E4', 'E5']) await app.setProbability(k, '0.1');
    await app.select('G2');
    await app.field('threshold').fill('3');
    await app.field('threshold').press('Enter');
    await expect(page.getByTestId('problem-count')).toHaveText('1');
    await app.tab('problems');
    await expect(page.locator('li.problem[data-code="E_VOTE_RANGE"]')).toContainText('2 <= K < N');
    await app.tab('properties');
    await app.field('threshold').fill('2');
    await app.field('threshold').press('Enter');
    await expect(app.win).toHaveAttribute('data-valid', 'true');
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.028, 12);
    expect(await app.cutSets()).toEqual(['E3,E4', 'E3,E5', 'E4,E5']);
  });

  test('the outline and the drawing share one selection', async ({ app, page }) => {
    await app.open();
    await page.getByTestId('outline').locator('button.tree-item[data-key="E2"]').click();
    await expect(app.node('E2')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('properties')).toContainText('Basic event E2');
    await app.node('G1').click();
    await expect(page.getByTestId('outline').locator('button.tree-item[data-key="G1"]')).toHaveAttribute('aria-current', 'true');
  });

  test('the top event can be changed, and the model name edited', async ({ app, page }) => {
    await app.open();
    await app.select('G1');
    await page.keyboard.press('Escape'); // nothing selected: the model form
    await app.field('model-name').fill('Pump lesson');
    await app.field('model-name').press('Enter');
    await expect(page.getByTestId('doc-name')).toContainText('Pump lesson');
    await app.field('top').selectOption('E1');
    await expect(page.locator('g.node[data-key="E1"] .badge-top')).toHaveCount(1);
    await expect(page.locator('g.node[data-key="G1"] .badge-top')).toHaveCount(0);
    await app.run();
    expect(await app.topProbability()).toBeCloseTo(0.1, 12);
  });
});

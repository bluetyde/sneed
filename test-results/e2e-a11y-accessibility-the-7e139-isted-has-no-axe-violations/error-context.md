# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e\a11y.spec.ts >> accessibility >> the import dialog (empty, with a refusal listed) has no axe violations
- Location: e2e\a11y.spec.ts:185:3

# Error details

```
Error: axe violations in: import dialog, a refusal listed

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 4

- Array []
+ Array [
+   "color-contrast (serious): Elements must meet minimum color contrast ratio thresholds
+    [\".primary\"] Fix any of the following:   Element has insufficient color contrast of 1.64 (foreground color: #04121d, background color: #343a42, font size: 9.8pt (13px), font weight: normal). Expected contrast ratio of 4.5:1",
+ ]
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e3]:
    - banner [ref=e4]:
      - generic [ref=e5]:
        - heading "SNEED fault-tree editor" [level=1] [ref=e6]:
          - text: SNEED
          - generic [ref=e7]: fault-tree editor
        - generic [ref=e8]:
          - generic [ref=e9]: Untitled model
          - text: · not saved yet
        - generic [ref=e10]:
          - generic [ref=e11]: Engine
          - combobox "Engine" [ref=e12]:
            - option "Built-in" [selected]
            - option "SCRAM"
            - option "Both"
          - generic [ref=e13]: Method
          - combobox "Method" [ref=e14]:
            - option "Exact" [selected]
            - option "Rare-event approximation"
            - option "Min-cut upper bound"
          - button "Run" [ref=e15] [cursor=pointer]
          - status [ref=e18]: Ready to run
      - toolbar "Editor tools" [ref=e19]:
        - group "File" [ref=e20]:
          - generic [ref=e21]:
            - button "New model (starts from a two-event OR)" [ref=e22] [cursor=pointer]: New
            - button "Open a saved model" [ref=e27] [cursor=pointer]: Open
            - button "Import an Open-PSA XML file as a new model" [ref=e30] [cursor=pointer]: Import
            - button "Save the model (Ctrl+S)" [ref=e34] [cursor=pointer]: Save
            - button "Save under a new name" [ref=e39] [cursor=pointer]: Save as
        - group "Edit" [ref=e46]:
          - generic [ref=e47]:
            - button "Undo (Ctrl+Z)" [disabled] [ref=e48]: Undo
            - button "Redo (Ctrl+Y)" [disabled] [ref=e52]: Redo
            - button "Delete the selected node (Delete)" [disabled] [ref=e56]: Delete
        - group "Add" [ref=e62]:
          - generic [ref=e63]:
            - button "Add a basic event (attaches to the selected gate)" [ref=e64] [cursor=pointer]: Basic event
            - button "Add an AND gate with two new events" [ref=e67] [cursor=pointer]: AND gate
            - button "Add an OR gate with two new events" [ref=e70] [cursor=pointer]: OR gate
            - button "Add a K-of-N gate (starts as 2 of 3)" [ref=e73] [cursor=pointer]: K-of-N gate
        - group "View" [ref=e78]:
          - generic [ref=e79]:
            - button "Fit the whole tree in view (0)" [ref=e80] [cursor=pointer]: Fit
            - button "Zoom in (+)" [ref=e83] [cursor=pointer]: Zoom in
            - button "Zoom out (-)" [ref=e88] [cursor=pointer]: Zoom out
            - button "Forget moved positions and lay the tree out automatically" [ref=e92] [cursor=pointer]: Auto layout
    - generic [ref=e96]:
      - navigation "Outline of the fault tree" [ref=e97]:
        - generic [ref=e98]: Outline
        - list [ref=e100]:
          - listitem [ref=e101]:
            - button "OR G1" [ref=e102] [cursor=pointer]:
              - generic [ref=e103]: G1
              - generic [ref=e104]: OR
          - listitem [ref=e105]:
            - button "event E1" [ref=e106] [cursor=pointer]:
              - generic [ref=e107]: E1
              - generic [ref=e108]: event
          - listitem [ref=e109]:
            - button "event E2" [ref=e110] [cursor=pointer]:
              - generic [ref=e111]: E2
              - generic [ref=e112]: event
      - main "Drawing area" [ref=e113]:
        - generic [ref=e114]: Drag a node to move it. Drag from the dot under a gate to connect it. Arrow keys move between nodes; Enter edits.
        - group "Fault tree drawing" [ref=e117]:
          - generic [ref=e122]:
            - button "OR gate G1, 2 inputs, top event" [ref=e123] [cursor=pointer]:
              - generic: G1 · OR
              - generic: 2 inputs
              - generic: TOP
            - button "Basic event E1, probability 0.1" [ref=e127] [cursor=pointer]:
              - generic: E1
              - generic: p = 0.1
            - button "Basic event E2, probability 0.1" [ref=e129] [cursor=pointer]:
              - generic: E2
              - generic: p = 0.1
      - complementary "Details" [ref=e131]:
        - tablist "Side panels" [ref=e132]:
          - tab "Properties" [selected] [ref=e133] [cursor=pointer]
          - tab "Problems, 0 to fix, 0 warnings" [ref=e134] [cursor=pointer]: Problems
          - tab "Results" [ref=e135] [cursor=pointer]
          - tab "Compare" [ref=e136] [cursor=pointer]
          - tab "Lesson" [ref=e137] [cursor=pointer]
        - tabpanel "Properties" [ref=e138]:
          - heading "Model" [level=2] [ref=e139]
          - generic [ref=e140]:
            - generic [ref=e141]: Model name
            - textbox "Model name" [ref=e142]: Untitled model
          - generic [ref=e143]:
            - generic [ref=e144]: Top event
            - combobox "Top event" [ref=e145]:
              - option "(none)"
              - option "G1" [selected]
              - option "E1"
              - option "E2"
            - generic [ref=e146]: The event the whole tree is about. Results are the probability that it occurs.
          - heading "Assumptions behind every result" [level=2] [ref=e147]
          - generic [ref=e148]:
            - term [ref=e149]: Probabilities
            - definition [ref=e150]: constant (fixed numbers, no time)
            - term [ref=e151]: Independence
            - definition [ref=e152]: "declared-independent: distinct basic events do not influence each other"
            - term [ref=e153]: Logic
            - definition [ref=e154]: "coherent: more failures never repair the system"
            - term [ref=e155]: Time
            - definition [ref=e156]: none
          - paragraph [ref=e157]: Select a node in the drawing or in the outline to edit it.
    - contentinfo [ref=e158]:
      - generic [ref=e159]:
        - text: Model hash
        - code [ref=e160]: 39afe2806770
      - generic [ref=e161]: valid
      - generic [ref=e162]: SCRAM 0.16.2 · install 20261005T124508Z-4ef2d4
      - generic [ref=e163]: Nothing selected
      - generic [ref=e165]: 3 drawn · 2 events · 1 gates
  - dialog [ref=e166]:
    - generic [ref=e167]:
      - heading "Import an Open-PSA file" [level=2] [ref=e168]
      - paragraph [ref=e169]: "Reads the fault trees SNEED can analyse: basic events with a fixed probability, AND, OR and K-of-N gates. Anything else is refused, with the line it is on. The original file is kept beside the model, unchanged."
      - generic [ref=e170]:
        - generic [ref=e171]: Open-PSA file (.xml)
        - button "Open-PSA file (.xml)" [ref=e172]
      - generic [ref=e173]:
        - generic [ref=e174]: Save the imported model as
        - textbox "Save the imported model as" [ref=e175]: a11y-bad
      - generic [ref=e176]:
        - alert [ref=e177]: "Not imported: 2 problems in the file. Nothing was saved and your model is unchanged."
        - list "Problems in the file" [ref=e178]:
          - listitem [ref=e179]:
            - generic [ref=e180]: E_UNSUPPORTED · line 1
            - generic [ref=e181]: "<define-house-event> is outside the supported subset: it has no meaning in a V1 static fault tree"
          - listitem [ref=e182]:
            - generic [ref=e183]: E_PROB_RANGE · line 1
            - generic [ref=e184]: the probability 3 is outside 0 to 1
      - generic [ref=e185]:
        - button "Import" [ref=e186] [cursor=pointer]
        - button "Cancel" [ref=e187] [cursor=pointer]
```

# Test source

```ts
  1   | import { createRequire } from 'node:module';
  2   | import type { Page } from '@playwright/test';
  3   | import { expect, test } from './fixtures.js';
  4   | 
  5   | // Automated accessibility audit with axe-core (WCAG 2.0 / 2.1 A and AA plus best practices) over every distinct state of the editor.
  6   | // Automated checks find some problems, not all: keyboard operation is tested separately and a screen-reader pass is still a human task.
  7   | 
  8   | const axePath = createRequire(import.meta.url).resolve('axe-core');
  9   | 
  10  | interface Violation {
  11  |   id: string;
  12  |   impact: string | null;
  13  |   help: string;
  14  |   nodes: { target: unknown[]; failureSummary?: string }[];
  15  | }
  16  | 
  17  | async function audit(page: Page, label: string): Promise<void> {
  18  |   if (!(await page.evaluate(() => 'axe' in window))) await page.addScriptTag({ path: axePath });
  19  |   const result = await page.evaluate(async () => {
  20  |     const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: Violation[] }> } }).axe;
  21  |     return axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } });
  22  |   });
  23  |   const summary = result.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n   ` + v.nodes.slice(0, 3).map((n) => JSON.stringify(n.target) + ' ' + (n.failureSummary ?? '').split('\n').slice(0, 2).join(' ')).join('\n   '));
> 24  |   expect(summary, `axe violations in: ${label}`).toEqual([]);
      |                                                  ^ Error: axe violations in: import dialog, a refusal listed
  25  | }
  26  | 
  27  | // axe is injected as an inline script, which the app's strict content security policy (correctly) refuses. The policy does not
  28  | // change the page's structure, so the audit runs with it bypassed; the policy itself is checked in editor.spec.ts.
  29  | test.use({ bypassCSP: true });
  30  | 
  31  | test.describe('accessibility', () => {
  32  |   test('the first screen, with a node selected, and each side panel have no axe violations', async ({ app, page }) => {
  33  |     await app.open();
  34  |     await audit(page, 'first screen');
  35  |     await app.select('E1');
  36  |     await audit(page, 'a basic event selected (properties)');
  37  |     await app.select('G1');
  38  |     await audit(page, 'a gate selected (properties)');
  39  |     await page.keyboard.press('Escape');
  40  |     await audit(page, 'nothing selected (model form)');
  41  |     await app.tab('problems');
  42  |     await audit(page, 'problems tab, no problems');
  43  |   });
  44  | 
  45  |   test('a model with problems, repeated references and a stale result have no axe violations', async ({ app, page }) => {
  46  |     await app.open();
  47  |     await app.select('G1');
  48  |     await app.action('add-and').click();
  49  |     await app.field('add-input').selectOption('G1'); // a cycle
  50  |     await page.getByRole('button', { name: 'Add input' }).click();
  51  |     await app.field('add-input').selectOption('E1');
  52  |     await page.getByRole('button', { name: 'Add input' }).click(); // a repeated reference too
  53  |     await app.tab('problems');
  54  |     await expect(page.locator('li.problem[data-code="E_CYCLE"]')).toBeVisible();
  55  |     await audit(page, 'problems listed');
  56  |     await page.locator('g.node[data-kind="reference"]').first().click();
  57  |     await audit(page, 'a repeated reference selected');
  58  |   });
  59  | 
  60  |   test('results, a cut set explained, a stale banner and a labelled caveat have no axe violations', async ({ app, page }) => {
  61  |     await app.open();
  62  |     await app.run();
  63  |     await audit(page, 'results');
  64  |     await page.locator('[data-testid="cut-set"]').first().click();
  65  |     await audit(page, 'a cut set explained');
  66  |     await app.setProbability('E1', '0.5');
  67  |     await app.tab('results');
  68  |     await expect(page.getByTestId('stale')).toBeVisible();
  69  |     await audit(page, 'stale result');
  70  |     await app.select('G1');
  71  |     await app.action('add-event').click();
  72  |     for (const k of ['E1', 'E2', 'E3']) await app.setProbability(k, '0.9');
  73  |     await page.getByTestId('method').selectOption('rare-event');
  74  |     await app.run();
  75  |     await expect(page.getByTestId('caveat')).toBeVisible();
  76  |     await audit(page, 'rare-event caveat');
  77  |   });
  78  | 
  79  |   test('the Open and Save as dialogs have no axe violations', async ({ app, page }) => {
  80  |     await app.open();
  81  |     await app.action('saveas').click();
  82  |     await expect(page.locator('dialog[open]')).toBeVisible();
  83  |     await audit(page, 'save as dialog');
  84  |     await page.locator('#save-name').fill('axe-model');
  85  |     await page.getByTestId('save-confirm').click();
  86  |     await app.action('open').click();
  87  |     await expect(page.locator('button[data-model="axe-model"]')).toBeVisible();
  88  |     await audit(page, 'open dialog with a model listed');
  89  |   });
  90  | 
  91  |   test('every control has an accessible name and every node says what it is', async ({ app, page }) => {
  92  |     await app.open();
  93  |     const unnamed = await page.evaluate(() => {
  94  |       const bad: string[] = [];
  95  |       for (const el of document.querySelectorAll('button, input, select, textarea, [role="button"], [role="tab"]')) {
  96  |         const e = el as HTMLElement;
  97  |         if (e.hidden || e.closest('[hidden]')) continue;
  98  |         const name = e.getAttribute('aria-label') || e.getAttribute('title') || (e as HTMLInputElement).labels?.[0]?.textContent || e.textContent?.trim();
  99  |         if (!name) bad.push(e.outerHTML.slice(0, 80));
  100 |       }
  101 |       return bad;
  102 |     });
  103 |     expect(unnamed).toEqual([]);
  104 |     const labels = await app.nodes().evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  105 |     expect(labels).toEqual(['OR gate G1, 2 inputs, top event', 'Basic event E1, probability 0.1', 'Basic event E2, probability 0.1']);
  106 |     await expect(page.getByRole('group', { name: 'Fault tree drawing' })).toBeVisible();
  107 |     await expect(page.getByRole('toolbar', { name: 'Editor tools' })).toBeVisible();
  108 |     await expect(page.getByRole('tablist', { name: 'Side panels' })).toBeVisible();
  109 |     expect(await page.locator('html').getAttribute('lang')).toBe('en');
  110 |   });
  111 | 
  112 |   test('colour is never the only signal: a node with a problem also has a badge, an aria-label and an outline mark', async ({ app, page }) => {
  113 |     await app.open();
  114 |     await app.select('G1');
  115 |     await page.getByRole('button', { name: 'Remove input E2 from G1' }).click(); // an OR with one input
  116 |     await expect(app.node('G1')).toHaveAttribute('aria-label', /has a problem to fix/);
  117 |     await expect(app.node('G1').locator('.badge-err')).toHaveCount(1);
  118 |     await expect(app.node('G1').locator('text.t-badge')).toHaveText('!');
  119 |     await expect(page.getByTestId('outline').locator('button[data-key="G1"]')).toHaveAttribute('aria-label', /has a problem/);
  120 |     // the run pill says it in words, not only red
  121 |     await expect(page.getByTestId('run-pill')).toContainText('problem');
  122 |   });
  123 | 
  124 |   test('at 200% zoom (a 700 px wide window) the page does not scroll sideways and the main controls stay reachable', async ({ app, page }) => {
```
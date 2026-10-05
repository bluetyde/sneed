import { test as base, expect, type Page, type Locator } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AnalyzeOptions, AnalyzeOutcome } from '../src/core/analyze.js';
import { startServer, type RunningServer } from '../src/server/app.js';
import { defaultRuntimeEnv } from '../src/runtime/resolve.js';
import type { RuntimeEnv } from '../src/runtime/install.js';

export { expect };

const ROOT = path.resolve(import.meta.dirname, '..');

export interface ServerOpts {
  runtimeEnv?: RuntimeEnv;
  analyzeFn?: (text: string, opts: AnalyzeOptions) => Promise<AnalyzeOutcome>;
}

export async function newServer(opts: ServerOpts = {}): Promise<{ server: RunningServer; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sneed-e2e-'));
  const server = await startServer(
    { projectDir: path.join(dir, 'models'), runsDir: path.join(dir, 'runs'), staticDir: path.join(ROOT, 'dist', 'web'), runtimeEnv: opts.runtimeEnv ?? defaultRuntimeEnv(), lessonsDir: path.join(ROOT, 'lessons'), oraclesFile: path.join(ROOT, 'tests', 'oracles.json'), ...(opts.analyzeFn ? { analyzeFn: opts.analyzeFn } : {}) },
    0,
  );
  return { server, dir };
}

/** What a student does, as methods. Everything goes through the real page. */
export class App {
  constructor(readonly page: Page) {}
  get win(): Locator {
    return this.page.getByTestId('win');
  }
  node(key: string): Locator {
    return this.page.locator(`g.node[data-key="${key}"]`);
  }
  nodes(): Locator {
    return this.page.locator('g.node');
  }
  action(name: string): Locator {
    return this.page.locator(`[data-action="${name}"]`);
  }
  field(name: string): Locator {
    return this.page.locator(`[data-field="${name}"]`);
  }
  async open(): Promise<void> {
    await this.page.goto('/');
    await this.ready();
  }
  /** The page has loaded, the model has been checked and the runtime state is known. */
  async ready(): Promise<void> {
    await expect(this.win).toHaveAttribute('data-valid', /true|false/);
    await expect(this.page.getByTestId('runtime-state')).not.toHaveText(/checking/);
  }
  async modelHash(): Promise<string> {
    return (await this.page.getByTestId('model-hash').getAttribute('data-hash')) ?? '';
  }
  /** Waits for the status bar to show a model hash different from `previous`. */
  async hashChangedFrom(previous: string): Promise<string> {
    await expect.poll(() => this.modelHash()).not.toBe(previous);
    return this.modelHash();
  }
  async select(key: string): Promise<void> {
    await this.node(key).click();
    await expect(this.node(key)).toHaveAttribute('aria-pressed', 'true');
  }
  async setProbability(key: string, value: string): Promise<void> {
    await this.select(key);
    await this.tab('properties');
    await this.field('probability').fill(value);
    await this.field('probability').press('Enter');
  }
  async setName(key: string, name: string): Promise<void> {
    await this.select(key);
    await this.tab('properties');
    await this.field('name').fill(name);
    await this.field('name').press('Enter');
  }
  async tab(name: 'properties' | 'problems' | 'results' | 'lesson'): Promise<void> {
    await this.page.locator(`[data-tab="${name}"]`).click();
  }
  async run(): Promise<void> {
    await this.page.getByTestId('run').click();
    await expect(this.page.getByTestId('result-status')).toBeVisible({ timeout: 90_000 });
  }
  async topProbability(): Promise<number> {
    return Number(await this.page.getByTestId('top-probability').getAttribute('data-value'));
  }
  async cutSets(): Promise<string[]> {
    return this.page.getByTestId('cut-set').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.events!).sort());
  }
  /** Keyboard-only switch of side tab: Tab to the selected tab (tabs are one roving Tab stop), then Right Arrow to the wanted one. */
  async keyTab(name: 'properties' | 'problems' | 'results' | 'lesson'): Promise<void> {
    const order = ['properties', 'problems', 'results', 'lesson'];
    const cur = (await this.page.locator('[role=tab][aria-selected=true]').getAttribute('data-tab')) ?? 'properties';
    await this.tabTo(this.page.locator(`[data-tab="${cur}"]`));
    const n = (order.indexOf(name) - order.indexOf(cur) + order.length) % order.length;
    for (let i = 0; i < n; i++) await this.page.keyboard.press('ArrowRight');
    await expect(this.page.locator(`[data-tab="${name}"]`)).toHaveAttribute('aria-selected', 'true');
  }
  /** Presses Tab until the locator has focus (keyboard-only reach), failing after `max` presses. */
  async tabTo(target: Locator, max = 80): Promise<void> {
    for (let i = 0; i < max; i++) {
      if (await target.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false)) return;
      await this.page.keyboard.press('Tab');
    }
    throw new Error(`could not reach ${target} by keyboard in ${max} Tab presses`);
  }
}

export const test = base.extend<{ app: App }, { srv: { server: RunningServer; dir: string } }>({
  srv: [
    async ({}, use) => {
      const s = await newServer();
      await use(s);
      await s.server.close();
      rmSync(s.dir, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ srv }, use) => use(srv.server.url),
  app: async ({ page }, use) => use(new App(page)),
});

import { afterAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { loadRecipe, type LoadedRecipe } from '../../src/runtime/recipe.js';
import { runSmoke } from '../../src/runtime/smoke.js';
import { ENGINE } from './engine.js';

// The native checks that gate activation of a new build, run against the engine under test. A checker that
// cannot fail would let a broken build be activated, so the negative cases matter as much as the positive one.
const ROOT = path.resolve(import.meta.dirname, '../..');
const RUNS = path.join(ROOT, 'runs', 'test-smoke');
const loaded = loadRecipe(path.join(ROOT, 'runtime'));
afterAll(() => rmSync(RUNS, { recursive: true, force: true }));

const withCases = (edit: (cases: LoadedRecipe['smokeCases']) => LoadedRecipe['smokeCases']): LoadedRecipe => ({ ...loaded, smokeCases: edit(structuredClone(loaded.smokeCases)) });

describe('smoke checks', () => {
  it('all pass on the engine under test, including the voting shape the engine itself gets wrong', async () => {
    const r = await runSmoke(loaded, ENGINE, RUNS);
    expect(r.map((x) => [x.id, x.passed, x.reason])).toEqual(loaded.smokeCases.map((c) => [c.id, true, null]));
    expect(r.find((x) => x.id === 'vote-over-gate-input')!.probability).toBe(0.37);
  }, 600000);

  it('a wrong expected probability is reported, not accepted', async () => {
    const r = await runSmoke(withCases((c) => c.map((x) => (x.id === 'pra-and' ? { ...x, expected_probability: 0.03 } : x))), ENGINE, RUNS);
    const bad = r.find((x) => x.id === 'pra-and')!;
    expect(bad).toMatchObject({ passed: false, reason: 'probability-differs', status: 'completed' });
    expect(r.filter((x) => !x.passed)).toHaveLength(1);
  }, 600000);

  it('wrong expected cut sets are reported', async () => {
    const r = await runSmoke(withCases((c) => c.map((x) => (x.id === 'pra-pump3-shared' ? { ...x, expected_cut_sets: [['S'], ['P1', 'P3']] } : x))), ENGINE, RUNS);
    expect(r.find((x) => x.id === 'pra-pump3-shared')).toMatchObject({ passed: false, reason: 'cut-sets-differ' });
  }, 600000);

  it('a model the pipeline refuses is a failed check, not an exception', async () => {
    const r = await runSmoke(withCases((c) => c.map((x) => (x.id === 'pra-and' ? { ...x, events: { A: 1.5, B: 0.2 } } : x))), ENGINE, RUNS);
    expect(r.find((x) => x.id === 'pra-and')).toMatchObject({ passed: false, reason: 'refused:E_PROB_RANGE', status: 'refused', probability: null });
  }, 600000);

  it('an engine that is not the pinned build fails every check instead of passing quietly', async () => {
    const r = await runSmoke(loaded, { ...ENGINE, expectedSha256: '0'.repeat(64) }, RUNS);
    expect(r.every((x) => !x.passed)).toBe(true);
    expect(r[0]!.reason).toContain('engine-build-mismatch');
  }, 600000);
});

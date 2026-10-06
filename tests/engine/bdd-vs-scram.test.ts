import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyze } from '../../src/core/analyze.js';
import { analyzeBuiltin } from '../../src/engines/bdd/analyze.js';
import { ORACLE_MODELS, randomDoc } from '../oracle/models.js';

// Two engines that share no code, on the same models: the built-in decision diagram and SCRAM through the installed runtime.
// Any difference is a finding (docs/plans/10-builtin-solver.md, verification 3). SCRAM prints about six significant digits,
// so probabilities are compared to that precision; cut sets are compared exactly.
const tmp = mkdtempSync(path.join(tmpdir(), 'sneed-bdd-scram-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const id = (p: string): string => `${p}-${String(++n).padStart(6, '0')}`;
const sortSets = (sets: string[][]): string[][] => sets.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));
const close = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(1e-12, 5e-5 * Math.max(Math.abs(a), Math.abs(b)));

async function both(doc: unknown, method: 'exact' | 'rare-event' | 'mcub' = 'exact'): Promise<{ s: Awaited<ReturnType<typeof analyze>>; b: Awaited<ReturnType<typeof analyzeBuiltin>> }> {
  const text = JSON.stringify(doc);
  const s = await analyze(text, { runsDir: tmp, runId: id('scram'), settings: { method }, timeoutMs: 60_000 });
  const b = await analyzeBuiltin(text, { runsDir: tmp, runId: id('bdd'), settings: { method } });
  return { s, b };
}

describe('the built-in engine and SCRAM agree', () => {
  for (const key of ['pra-and', 'pra-or', 'pra-shared', 'pra-pump3-shared', 'pra-pump3-separate', 'pra-vote-exact']) {
    it(`hand oracle ${key}`, async () => {
      const { s, b } = await both(ORACLE_MODELS[key]);
      if (s.kind !== 'ran' || b.kind !== 'ran') throw new Error('refused');
      expect(s.record.status).toBe('completed');
      expect(b.record.status).toBe('completed');
      expect(close(s.record.top_event_probability!, b.record.top_event_probability!), `${s.record.top_event_probability} vs ${b.record.top_event_probability}`).toBe(true);
      expect(sortSets(b.record.minimal_cut_sets.map((c) => c.events))).toEqual(sortSets(s.record.minimal_cut_sets.map((c) => c.events)));
    }, 120_000);
  }

  it('a product-order limit below the longest cut set: both engines say truncated, and neither calls it complete', async () => {
    const text = JSON.stringify(ORACLE_MODELS['pra-and']);
    const s = await analyze(text, { runsDir: tmp, runId: id('scram'), settings: { limitOrder: 1 } });
    const b = await analyzeBuiltin(text, { runsDir: tmp, runId: id('bdd'), settings: { limitOrder: 1 } });
    if (s.kind !== 'ran' || b.kind !== 'ran') throw new Error('refused');
    expect(s.record.status).toBe('truncated');
    expect(b.record.status).toBe('truncated');
  }, 120_000);

  it.each(['rare-event', 'mcub'] as const)('the %s approximation on the 2-of-3 model', async (method) => {
    const { s, b } = await both(ORACLE_MODELS['pra-vote-exact'], method);
    if (s.kind !== 'ran' || b.kind !== 'ran') throw new Error('refused');
    expect(close(s.record.top_event_probability!, b.record.top_event_probability!)).toBe(true);
    expect(close(s.record.approximation_value!, b.record.approximation_value!)).toBe(true);
  }, 120_000);

  it('40 random trees (repeated references, K-of-N, probabilities including 0 and 1): same probability, same cut sets', async () => {
    let compared = 0;
    const differences: string[] = [];
    for (let seed = 9001; seed <= 9040; seed++) {
      const { s, b } = await both(randomDoc(seed));
      if (s.kind !== 'ran' || b.kind !== 'ran') continue;
      // SCRAM can legitimately end truncated or failed on a hard shape; only a pair of completed results is compared
      if (s.record.status !== 'completed' || b.record.status !== 'completed') {
        if (b.record.status !== 'completed') differences.push(`seed ${seed}: built-in ${b.record.status} ${b.record.reasons}`);
        continue;
      }
      compared++;
      if (!close(s.record.top_event_probability!, b.record.top_event_probability!)) differences.push(`seed ${seed}: probability ${s.record.top_event_probability} vs ${b.record.top_event_probability}`);
      const a = JSON.stringify(sortSets(s.record.minimal_cut_sets.map((c) => c.events)));
      const c = JSON.stringify(sortSets(b.record.minimal_cut_sets.map((x) => x.events)));
      if (a !== c) differences.push(`seed ${seed}: cut sets differ`);
    }
    expect(differences).toEqual([]);
    expect(compared).toBeGreaterThan(25); // the comparison really happened for most trees
  }, 600_000);
});

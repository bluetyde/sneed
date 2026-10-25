import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { analyze, type AnalyzeOutcome } from '../../src/core/analyze.js';
import { ENGINE } from './engine.js';
import type { ResultRecord } from '../../src/core/result.js';
import { enumerateGroups, frozenCaseDoc, randomGroupDoc, type FrozenCase } from '../oracle/groups.js';

// Common-cause groups (plan 15, stage C3) through the real SCRAM: native model with groups -> its expansion written as Open-PSA XML
// (`G.CCF` written as `G__CCF`) -> SCRAM -> report read back in the model's names -> compared with the frozen cases and with the
// exact evaluation of the group definition. Needs the pinned SCRAM build in WSL, like the other tests in this folder.
// NOTE: written 2026-10-25 in a session without WSL or SCRAM, so this file has NOT been run yet. Run `npm run test:engine` on the
// Windows machine and report the result; the unit tests (tests/unit/ccf-export.test.ts) cover the XML and the name translation without SCRAM.
const ROOT = path.resolve(import.meta.dirname, '../..');
const RUNS = path.join(ROOT, 'runs', 'test-engine-ccf');
const frozen = JSON.parse(readFileSync(path.join(ROOT, 'tests/oracles-common-cause.json'), 'utf8')) as FrozenCase[];

const ran = (o: AnalyzeOutcome): { runDir: string; record: ResultRecord } => {
  if (o.kind !== 'ran') throw new Error('expected a run, got a refusal: ' + o.errors.map((e) => e.code).join(','));
  return o;
};
const sorted = (sets: string[][]): string[][] => sets.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));
const REL = 1e-5; // the engine prints about 6 significant digits
const near = (got: number, want: number): boolean => Math.abs(got - want) <= Math.max(1e-12, REL * Math.abs(want));

beforeAll(() => {
  rmSync(RUNS, { recursive: true, force: true });
  mkdirSync(RUNS, { recursive: true });
});

describe('common-cause groups through SCRAM', () => {
  for (const e of frozen) {
    it(`${e.id}: complete, the frozen probability, the frozen cut sets in the model's names`, async () => {
      const { record } = ran(await analyze(JSON.stringify(frozenCaseDoc(e)), { runsDir: RUNS, engine: ENGINE }));
      expect(record.reasons).toEqual([]);
      expect(record).toMatchObject({ status: 'completed', completeness: 'complete', method: 'exact', common_cause: { method: 'beta-factor' } });
      expect(near(record.top_event_probability!, e.expected_probability)).toBe(true);
      if (e.expected_cut_sets) expect(sorted(record.minimal_cut_sets.map((c) => c.events))).toEqual(sorted(e.expected_cut_sets));
    }, 120000);
  }

  it('random trees with groups: the exact probability and the cut sets of the group definition', async () => {
    for (let seed = 3000; seed < 3015; seed++) {
      const doc = randomGroupDoc(seed);
      const want = enumerateGroups(doc);
      const { record } = ran(await analyze(JSON.stringify(doc), { runsDir: RUNS, engine: ENGINE }));
      expect(record, `seed ${seed}`).toMatchObject({ status: 'completed', completeness: 'complete' });
      expect(near(record.top_event_probability!, want.probability.toNumber()), `seed ${seed} probability`).toBe(true);
      expect(sorted(record.minimal_cut_sets.map((c) => c.events)), `seed ${seed} cut sets`).toEqual(want.cutSets);
    }
  }, 600000);
});

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeBuiltin } from '../../src/engines/bdd/analyze.js';
import { expandGroups, groupEventId, independentPartId } from '../../src/core/ccf.js';
import { modelHash } from '../../src/core/canonical.js';
import type { NativeModel } from '../../src/core/model.js';
import { enumerateGroups, frozenCaseDoc, randomGroupDoc, type FrozenCase, type GroupDoc } from '../oracle/groups.js';
import { AND, OR, VOTE, mkDoc } from '../oracle/models.js';
import { enumerate } from '../oracle/enumerate.js';

// Plan 15, stage C2: the built-in engine analyses a model with common-cause groups by expanding them. The oracles are the six frozen
// cases (tests/oracles-common-cause.json) and an exact evaluation of the group definition on random trees (tests/oracle/groups.ts).

type Frozen = FrozenCase;
const frozen = JSON.parse(readFileSync(path.join(import.meta.dirname, '../oracles-common-cause.json'), 'utf8')) as Frozen[];
const sortSets = (sets: string[][]): string[][] => sets.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));

/** The same tree with the groups taken away and the events independent: the textbook model. */
function plainOf(doc: GroupDoc): GroupDoc {
  const { common_cause_groups: _g, ...rest } = doc as GroupDoc & { assumptions: Record<string, unknown> };
  void _g;
  return { ...rest, assumptions: { ...rest.assumptions, independence: 'declared-independent' } } as GroupDoc;
}

const dirs: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'sneed-ccf-engine-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
let counter = 0;
const runId = (): string => `ccf-run-${String(++counter).padStart(6, '0')}`;

const modelOf = frozenCaseDoc;

describe('expandGroups', () => {
  const pair = { id: 'G', members: ['A', 'B'], beta: 0.1 };
  const doc = (): NativeModel => ({ ...mkDoc('TOP', { A: 0.1, B: 0.1, D: 0.2 }, [AND('G1', ['A', 'B']), OR('TOP', ['G1', 'D'])]), common_cause_groups: [pair] }) as unknown as NativeModel;

  it('a model without groups comes back as it is', () => {
    const plain = mkDoc('TOP', { A: 0.1, B: 0.2 }, [AND('TOP', ['A', 'B'])]) as unknown as NativeModel;
    expect(expandGroups(plain)).toBe(plain);
    expect(expandGroups({ ...plain, common_cause_groups: [] })).toEqual({ ...plain, common_cause_groups: [] });
  });

  it('each member becomes an OR of its independent part and the one group event; the other events are untouched', () => {
    const x = expandGroups(doc());
    expect(x.common_cause_groups).toBeUndefined();
    const ev = new Map(x.events.map((e) => [e.id, e.probability]));
    expect([...ev.keys()].sort()).toEqual(['A.independent', 'B.independent', 'D', 'G.CCF']);
    expect(ev.get('A.independent')).toBe(0.09);
    expect(ev.get('B.independent')).toBe(0.09);
    expect(ev.get('G.CCF')).toBe(0.01);
    expect(ev.get('D')).toBe(0.2);
    expect(x.gates.find((g) => g.id === 'A')).toEqual({ id: 'A', type: 'or', inputs: ['A.independent', 'G.CCF'] });
    expect(x.gates.find((g) => g.id === 'B')).toEqual({ id: 'B', type: 'or', inputs: ['B.independent', 'G.CCF'] });
    expect(x.gates.find((g) => g.id === 'G1')).toEqual({ id: 'G1', type: 'and', inputs: ['A', 'B'] }); // the users of a member are not changed
    expect(x.top).toBe('TOP');
    expect(groupEventId('G')).toBe('G.CCF');
    expect(independentPartId('A')).toBe('A.independent');
  });

  it('refuses members that are not events or do not share a probability (the validator refuses them first)', () => {
    const bad = { ...doc(), events: [{ id: 'A', probability: 0.1 }, { id: 'B', probability: 0.2 }, { id: 'D', probability: 0.2 }] } as NativeModel;
    expect(() => expandGroups(bad)).toThrow(RangeError);
    const missing = { ...doc(), common_cause_groups: [{ id: 'G', method: 'beta-factor' as const, members: ['A', 'ZZ'], beta: 0.1 }] } as NativeModel;
    expect(() => expandGroups(missing)).toThrow(RangeError);
  });

  it('does not change the document it is given', () => {
    const d = doc();
    const before = JSON.stringify(d);
    expandGroups(d);
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe('the frozen common-cause oracles (tests/oracles-common-cause.json) through the whole built-in analysis', () => {
  for (const e of frozen) {
    it(`${e.id}: completed and complete, the frozen probability, the frozen cut sets`, async () => {
      const text = JSON.stringify(modelOf(e));
      const out = await analyzeBuiltin(text, { runsDir: temp(), runId: runId() });
      expect(out.kind).toBe('ran');
      if (out.kind !== 'ran') return;
      const r = out.record;
      expect(r).toMatchObject({ status: 'completed', completeness: 'complete', reasons: [], method: 'exact' });
      expect(Math.abs(r.top_event_probability! - e.expected_probability)).toBeLessThanOrEqual(e.tolerance.absolute);
      if (e.expected_cut_sets) expect(sortSets(r.minimal_cut_sets.map((c) => c.events))).toEqual(sortSets(e.expected_cut_sets));
      // the record says whose result this is
      expect(r.assumptions).toMatchObject({ independence: 'beta-factor-groups' });
      expect(r.common_cause).toMatchObject({ method: 'beta-factor', groups: [{ id: e.group.id, members: e.group.members, beta: e.group.beta }] });
      expect(Math.abs(r.common_cause!.independent_value! - e.independent_value)).toBeLessThanOrEqual(1e-12); // what the same events give without the group
      expect(r.input_hashes.model_hash).toBe(modelHash(JSON.parse(text)));
      expect(r.input_hashes.exported_input_hash).not.toBe(r.input_hashes.model_hash); // what the engine read is the expansion
      // the files of a run are the same as for any run, and the native model is the one that was submitted
      expect(readFileSync(path.join(out.runDir, 'native', 'model.json'), 'utf8')).toBe(text);
      expect(existsSync(path.join(out.runDir, 'results.json'))).toBe(true);
    });
  }

  it('the group value differs from the independent value as the plan says: an AND gets worse, an OR gets better', async () => {
    const value = async (id: string): Promise<number> => {
      const e = frozen.find((x) => x.id === id)!;
      const out = await analyzeBuiltin(JSON.stringify(modelOf(e)), { runsDir: temp(), runId: runId() });
      if (out.kind !== 'ran') throw new Error('refused');
      return out.record.top_event_probability!;
    };
    expect(await value('cc-and')).toBeGreaterThan(frozen.find((x) => x.id === 'cc-and')!.independent_value);
    expect(await value('cc-or')).toBeLessThan(frozen.find((x) => x.id === 'cc-or')!.independent_value);
  });

  it('the zero check through the engine: beta = 0 gives exactly the independent result', async () => {
    for (const e of frozen.filter((x) => x.group.beta === 0)) {
      const out = await analyzeBuiltin(JSON.stringify(modelOf(e)), { runsDir: temp(), runId: runId() });
      if (out.kind !== 'ran') throw new Error('refused');
      expect(Math.abs(out.record.top_event_probability! - e.independent_value)).toBeLessThanOrEqual(1e-15);
    }
  });
});

describe('random trees with groups: the engine against an exact evaluation of the group definition', () => {
  const seeds = Array.from({ length: 80 }, (_, i) => 1000 + i);
  for (const seed of seeds) {
    it(`seed ${seed}`, async () => {
      const doc = randomGroupDoc(seed);
      const want = enumerateGroups(doc);
      const out = await analyzeBuiltin(JSON.stringify(doc), { runsDir: temp(), runId: runId() });
      expect(out.kind).toBe('ran');
      if (out.kind !== 'ran') return;
      const r = out.record;
      expect(r).toMatchObject({ status: 'completed', completeness: 'complete' });
      expect(Math.abs(r.top_event_probability! - want.probability.toNumber())).toBeLessThanOrEqual(1e-12);
      expect(sortSets(r.minimal_cut_sets.map((c) => c.events))).toEqual(want.cutSets);
    });
  }

  it('the generator makes valid models that really have groups, and the oracle is not trivially equal to the plain tree', () => {
    let different = 0;
    for (const seed of seeds) {
      const doc = randomGroupDoc(seed);
      expect(doc.common_cause_groups!.length).toBeGreaterThan(0);
      const plain = enumerate(plainOf(doc));
      if (Math.abs(plain.probability.toNumber() - enumerateGroups(doc).probability.toNumber()) > 1e-9) different++;
    }
    expect(different).toBeGreaterThan(seeds.length / 4); // the groups change the answer in many trees, so the comparison above has teeth
  });

  it('with beta = 0 everywhere the engine gives the plain tree\'s answer', async () => {
    for (const seed of seeds.slice(0, 25)) {
      const doc = randomGroupDoc(seed);
      const zero = { ...doc, common_cause_groups: doc.common_cause_groups!.map((g) => ({ ...g, beta: 0 })) };
      const plain = enumerate(plainOf(doc)).probability.toNumber();
      const out = await analyzeBuiltin(JSON.stringify(zero), { runsDir: temp(), runId: runId() });
      if (out.kind !== 'ran') throw new Error('refused');
      expect(Math.abs(out.record.top_event_probability! - plain)).toBeLessThanOrEqual(1e-12);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { computeEventTree, PARTITION_TOLERANCE, stableSum, type EventTreeInput } from '../../src/engines/bdd/event-tree.js';
import { Bdd } from '../../src/engines/bdd/bdd.js';
import { SolveAborted } from '../../src/engines/bdd/solve.js';
import { pathKey, skeletonSequences, type PathStep } from '../../src/core/event-tree.js';
import type { NativeModel } from '../../src/core/model.js';
import { enumerateEventTree, type EtOracleInput } from '../oracle/event-tree.js';
import { AND, mkDoc, OR, randomDoc, rng, VOTE } from '../oracle/models.js';

type Model = ReturnType<typeof mkDoc>;
const asModel = (m: Model): NativeModel => m as unknown as NativeModel;

// the models of plan 13
const SHARED = mkDoc('TOP', { S: 0.1, a: 0.2, b: 0.3 }, [OR('TOP', ['X', 'Y']), OR('X', ['S', 'a']), OR('Y', ['S', 'b'])]);
const INDEPENDENT = mkDoc('TOP', { A_FAILS: 0.01, B_FAILS: 0.1 }, [OR('TOP', ['A_FAILS', 'B_FAILS'])]);

interface Head {
  id: string;
  event: string;
  asked_only_if?: { heading: string; branch: 'works' | 'fails' };
}
const END = [{ id: 'SAFE', name: 'Safe', synthetic: true }, { id: 'DEGRADED', name: 'Degraded', synthetic: true }, { id: 'LOSS', name: 'Loss', synthetic: true }];
const byFailures = (p: PathStep[]): string => (p.filter((s) => s.branch === 'fails').length === 0 ? 'SAFE' : p.filter((s) => s.branch === 'fails').length === 1 ? 'DEGRADED' : 'LOSS');
const treeOf = (headings: Head[], frequency: number, endOf: (p: PathStep[]) => string = byFailures): EventTreeInput & EtOracleInput => ({
  initiating_event: { frequency },
  headings,
  end_states: END,
  sequences: skeletonSequences(headings).map((s) => ({ path: s.path, end_state: endOf(s.path) })),
});

const run = (m: Model, t: EventTreeInput, approximation = false) => computeEventTree(asModel(m), t, { approximation });
const prob = (r: ReturnType<typeof run>, key: string): number => r.sequences.find((s) => s.key === key)!.probability;
const freq = (r: ReturnType<typeof run>, key: string): number => r.sequences.find((s) => s.key === key)!.frequency;

describe('the reference cases of plan 13, by the engine', () => {
  it('6.1 independent headings: 0.0891, 0.0099, 0.0009, 0.0001 per year at 0.1 per year; end states 0.0891, 0.0108, 0.0001', () => {
    const t = treeOf([{ id: 'A', event: 'A_FAILS' }, { id: 'B', event: 'B_FAILS' }], 0.1);
    const r = run(INDEPENDENT, t);
    expect(freq(r, 'A:works,B:works')).toBeCloseTo(0.0891, 14);
    expect(freq(r, 'A:works,B:fails')).toBeCloseTo(0.0099, 14);
    expect(freq(r, 'A:fails,B:works')).toBeCloseTo(0.0009, 14);
    expect(freq(r, 'A:fails,B:fails')).toBeCloseTo(0.0001, 14);
    const end = Object.fromEntries(r.endStates.map((e) => [e.id, e.frequency]));
    expect(end.SAFE).toBeCloseTo(0.0891, 14);
    expect(end.DEGRADED).toBeCloseTo(0.0108, 14);
    expect(end.LOSS).toBeCloseTo(0.0001, 14);
    expect(r.total.frequency).toBeCloseTo(0.1, 14);
    expect(r.total.partitionError).toBeLessThan(1e-15);
  });

  it('6.2 a shared event: both fail 0.154 (0.077 per year), not the product 0.1036; the four paths add up to 1', () => {
    const r = run(SHARED, treeOf([{ id: 'A', event: 'X' }, { id: 'B', event: 'Y' }], 0.5));
    expect(prob(r, 'A:fails,B:fails')).toBeCloseTo(0.154, 14);
    expect(prob(r, 'A:fails,B:works')).toBeCloseTo(0.126, 14);
    expect(prob(r, 'A:works,B:fails')).toBeCloseTo(0.216, 14);
    expect(prob(r, 'A:works,B:works')).toBeCloseTo(0.504, 14);
    expect(freq(r, 'A:fails,B:fails')).toBeCloseTo(0.077, 14);
    expect(r.total.probabilitySum).toBeCloseTo(1, 15);
    // the naive product of the two heading probabilities would be a third too low
    const naive = (1 - 0.9 * 0.8) * (1 - 0.9 * 0.7);
    expect(naive).toBeCloseTo(0.1036, 14);
    expect(prob(r, 'A:fails,B:fails') / naive).toBeCloseTo(1.4864864864864864, 12);
  });

  it('6.3 success branches ignored: "A fails, B works" counts as 0.14 per year against the exact 0.063; the approximations do not add up to lambda', () => {
    const r = run(SHARED, treeOf([{ id: 'A', event: 'X' }, { id: 'B', event: 'Y' }], 0.5), true);
    const row = r.sequences.find((s) => s.key === 'A:fails,B:works')!;
    expect(row.approximation!.frequency).toBeCloseTo(0.14, 14);
    expect(row.frequency).toBeCloseTo(0.063, 14);
    expect(row.approximation!.frequency / row.frequency).toBeCloseTo(2.2222222222222223, 12);
    // the failures-only values of the four paths: 1, P(B), P(A), P(A and B) of the headings: 1 + 0.37 + 0.28 + 0.154 = 1.804 times lambda
    expect(r.approximationFrequencySum).toBeCloseTo(0.5 * 1.804, 13);
    expect(r.approximationFrequencySum).not.toBeCloseTo(0.5, 3);
    expect(run(SHARED, treeOf([{ id: 'A', event: 'X' }, { id: 'B', event: 'Y' }], 0.5)).approximationFrequencySum).toBeNull(); // only when asked
  });

  it('6.4 bypass: B asked only if A works: 0.504, 0.216 and 0.28 (0.252, 0.108 and 0.14 per year)', () => {
    const r = run(SHARED, treeOf([{ id: 'A', event: 'X' }, { id: 'B', event: 'Y', asked_only_if: { heading: 'A', branch: 'works' } }], 0.5));
    expect(r.sequences.map((s) => s.key)).toEqual(['A:works,B:works', 'A:works,B:fails', 'A:fails']);
    expect(prob(r, 'A:works,B:works')).toBeCloseTo(0.504, 14);
    expect(prob(r, 'A:works,B:fails')).toBeCloseTo(0.216, 14);
    expect(prob(r, 'A:fails')).toBeCloseTo(0.28, 14);
    expect(r.total.frequency).toBeCloseTo(0.5, 15);
  });

  it('a heading can be a basic event, and a K-of-N gate, and one heading under another', () => {
    const m = mkDoc('TOP', { A: 0.1, B: 0.2, C: 0.3, D: 0.4 }, [OR('TOP', ['V', 'W']), VOTE('V', ['A', 'B', 'C'], 2), AND('W', ['V', 'D'])]);
    const t = treeOf([{ id: 'ONE', event: 'A' }, { id: 'TWO', event: 'V' }, { id: 'THREE', event: 'W' }], 2);
    const r = run(m, t);
    const o = enumerateEventTree(m, t);
    for (const s of r.sequences) expect(s.probability).toBeCloseTo(o.probability.get(s.key)!.toNumber(), 14);
    // W implies V, so "V works, W fails" has probability 0 for the sequence where V works and W fails is impossible: W fails means W occurs
    expect(prob(r, 'ONE:works,TWO:works,THREE:fails')).toBe(0);
    expect(r.total.probabilitySum).toBeCloseTo(1, 14);
  });
});

describe('agreement with the independent enumeration oracle (exact rationals)', () => {
  const relClose = (a: number, b: number, ctx: string): void => {
    expect(Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)) || Math.abs(a - b) < 1e-17, `${ctx}: ${a} vs ${b}`).toBe(true);
  };

  const randomCase = (seed: number): { model: Model; tree: EventTreeInput & EtOracleInput } => {
    const r = rng(seed * 7919);
    const model = randomDoc(seed, { events: 2 + Math.floor(r() * 6), gates: 1 + Math.floor(r() * 5) });
    const nodes = [...model.events.map((e) => e.id), ...model.gates.map((g) => g.id)];
    const n = 1 + Math.floor(r() * 5);
    const headings: Head[] = [];
    for (let i = 0; i < n; i++) {
      const h: Head = { id: `H${i}`, event: nodes[Math.floor(r() * nodes.length)]! };
      if (i > 0 && r() < 0.4) h.asked_only_if = { heading: `H${Math.floor(r() * i)}`, branch: r() < 0.5 ? 'works' : 'fails' };
      headings.push(h);
    }
    const lambdas = [0.5, 1, 3.7, 0.001, 1e-6, 12];
    return { model, tree: treeOf(headings, lambdas[Math.floor(r() * lambdas.length)]!, () => END[Math.floor(r() * 3)]!.id) };
  };

  it('1000 random models and trees (shared events, repeated heading events, bypass, probabilities 0 and 1): every sequence, every end state, the approximation', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const { model, tree } = randomCase(seed);
      const o = enumerateEventTree(model, tree);
      const e = run(model, tree, true);
      expect(e.sequences.length, `seed ${seed}`).toBe(tree.sequences.length);
      for (const s of e.sequences) {
        relClose(s.probability, o.probability.get(s.key)!.toNumber(), `seed ${seed} ${s.key} probability`);
        relClose(s.frequency, o.frequency.get(s.key)!.toNumber(), `seed ${seed} ${s.key} frequency`);
        relClose(s.approximation!.probability, o.approxProbability.get(s.key)!.toNumber(), `seed ${seed} ${s.key} approximation`);
      }
      for (const es of e.endStates) relClose(es.frequency, o.endFrequency.get(es.id)!.toNumber(), `seed ${seed} end state ${es.id}`);
      expect(o.partitionSum.eq(Q1()), `seed ${seed}: the oracle's own partition sum is exactly 1`).toBe(true);
      expect(Math.abs(e.total.probabilitySum - 1), `seed ${seed}`).toBeLessThan(PARTITION_TOLERANCE);
    }
  });

  it('a path that cannot happen has probability 0, never an error: a certain event cannot also work, a heading cannot fail and work at once', () => {
    const m = mkDoc('TOP', { SURE: 1, NEVER: 0, C: 0.5 }, [OR('TOP', ['G', 'NEVER']), OR('G', ['SURE', 'C'])]);
    const t = treeOf([{ id: 'A', event: 'G' }, { id: 'B', event: 'NEVER' }, { id: 'C2', event: 'G' }], 1);
    const r = run(m, t);
    expect(prob(r, 'A:works,B:works,C2:works')).toBe(0); // G is certain
    expect(prob(r, 'A:fails,B:fails,C2:fails')).toBe(0); // NEVER never fails
    expect(prob(r, 'A:fails,B:works,C2:works')).toBe(0); // the same event twice cannot differ
    expect(prob(r, 'A:fails,B:works,C2:fails')).toBe(1);
    expect(r.total.probabilitySum).toBe(1);
  });

  it('is not changed by the variable order, and does not change the model or the tree it is given', () => {
    const t = treeOf([{ id: 'A', event: 'X' }, { id: 'B', event: 'Y' }], 0.5);
    const before = JSON.stringify([SHARED, t]);
    const a = computeEventTree(asModel(SHARED), t);
    const b = computeEventTree(asModel(SHARED), t, { order: ['b', 'S', 'a'] });
    for (const s of a.sequences) expect(b.sequences.find((x) => x.key === s.key)!.probability).toBeCloseTo(s.probability, 14);
    expect(JSON.stringify([SHARED, t])).toBe(before);
  });
});

const Q1 = () => enumerateEventTree(mkDoc('T', { A: 0.5 }, [OR('T', ['A', 'A'])]) as never, { initiating_event: { frequency: 1 }, headings: [{ id: 'H', event: 'A' }], end_states: [{ id: 'E' }], sequences: [{ path: [{ heading: 'H', branch: 'works' }], end_state: 'E' }, { path: [{ heading: 'H', branch: 'fails' }], end_state: 'E' }] }).partitionSum;

describe('failures are named, never a table with wrong numbers', () => {
  const why = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(SolveAborted);
      return (e as SolveAborted).why;
    }
    return 'no error';
  };

  it('a sequence probability below what a double holds is numeric-range', () => {
    const events: Record<string, number> = {};
    for (let i = 0; i < 200; i++) events[`E${i}`] = 0.001;
    const m = mkDoc('TOP', { ...events, Z: 0.5 }, [OR('TOP', ['BIG', 'Z']), AND('BIG', Object.keys(events))]);
    const t = treeOf([{ id: 'A', event: 'BIG' }, { id: 'B', event: 'Z' }], 1);
    expect(why(() => run(m, t))).toBe('numeric-range'); // "A fails, B fails" is 1e-600 x 0.5: it can happen, but it cannot be represented
  });

  it('a frequency that overflows with the probability is numeric-range', () => {
    const t = treeOf([{ id: 'A', event: 'X' }], 1e308);
    expect(why(() => run(SHARED, { ...t, initiating_event: { frequency: 1e308 } }))).toBe('no error'); // 1e308 x 0.28 is finite
    const huge = JSON.parse('{"x":1e999}').x as number; // Infinity
    expect(why(() => run(SHARED, { ...t, initiating_event: { frequency: huge } }))).toBe('numeric-range');
  });

  it('sequences that do not cover the possible outcomes are refused: they do not partition', () => {
    const t = treeOf([{ id: 'A', event: 'X' }, { id: 'B', event: 'Y' }], 1);
    expect(why(() => run(SHARED, { ...t, sequences: t.sequences.slice(1) }))).toBe('sequences-do-not-partition'); // one path missing
    expect(why(() => run(SHARED, { ...t, sequences: [...t.sequences, t.sequences[0]!] }))).toBe('sequences-do-not-partition'); // one listed twice
  });

  it('a path naming a heading that does not exist is a programming error, not a result', () => {
    const t = treeOf([{ id: 'A', event: 'X' }], 1);
    expect(() => run(SHARED, { ...t, sequences: [{ path: [{ heading: 'Z', branch: 'works' }], end_state: 'SAFE' }] })).toThrow(/not a heading/);
  });
});

describe('Bdd.not', () => {
  it('is the exact complement: probability(not f) = 1 - probability(f), double negation returns the same node, constants swap', () => {
    const bdd = new Bdd({ maxNodes: 100000, maxCutSets: 1000, maxCached: 100000 });
    const p = [0.1, 0.25, 0.5, 0.9];
    const v = p.map((_, i) => bdd.variable(i));
    const f = bdd.or(bdd.and(v[0]!, v[1]!), bdd.and(v[2]!, v[3]!));
    const nf = bdd.not(f);
    expect(bdd.probability(f, p) + bdd.probability(nf, p)).toBeCloseTo(1, 15);
    expect(bdd.not(nf)).toBe(f);
    expect(bdd.not(0)).toBe(1);
    expect(bdd.not(1)).toBe(0);
    expect(bdd.and(f, nf)).toBe(0);
    expect(bdd.or(f, nf)).toBe(1);
    // De Morgan: not (a and b) = (not a) or (not b)
    expect(bdd.not(bdd.and(v[0]!, v[1]!))).toBe(bdd.or(bdd.not(v[0]!), bdd.not(v[1]!)));
  });
});

describe('stableSum', () => {
  it('does not depend on the order, keeps small terms next to a large one, and sums nothing to zero', () => {
    expect(stableSum([])).toBe(0);
    expect(stableSum([1e16, 1, -1e16])).toBe(1); // a plain left-to-right sum gives 0
    const xs = Array.from({ length: 1000 }, (_, i) => 0.001 * (i % 7) + 1e-9);
    expect(stableSum(xs)).toBe(stableSum([...xs].reverse()));
    expect(stableSum(Array.from({ length: 10 }, () => 0.1))).toBeCloseTo(1, 16);
  });
});

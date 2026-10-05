import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enumerate, inclusionExclusion, topOccurs, MAX_EVENTS, type NativeDoc } from '../oracle/enumerate.js';
import { Q, parseDecimal, qFromNumber } from '../oracle/rational.js';
import { AND, OR, NATIVE_VOTE, ORACLE_MODELS, mkDoc, randomDoc } from '../oracle/models.js';
import { validateModel } from '../../src/core/validate.js';

interface Entry {
  id: string;
  type: string;
  expected_probability?: number;
  expected_cut_sets?: string[][];
  method?: string;
  tolerance?: { absolute: number; relative: number };
}
const entries = JSON.parse(readFileSync(join(import.meta.dirname, '../oracles.json'), 'utf8')) as Entry[];
const numerical = entries.filter((e) => e.type === 'numerical');
const sortSets = (sets: string[][]): string[][] => sets.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));

describe('frozen hand oracles (tests/oracles.json), reproduced by exhaustive enumeration', () => {
  it('every numerical oracle entry has a native model and nothing else does', () => {
    expect(Object.keys(ORACLE_MODELS).sort()).toEqual(numerical.map((e) => e.id).sort());
  });

  for (const e of numerical) {
    it(`${e.id} (${e.method})`, () => {
      const r = enumerate(ORACLE_MODELS[e.id]!);
      const got = e.method === 'rare-event' ? r.rareEvent : e.method === 'mcub' ? r.mcub : r.probability;
      expect(Math.abs(got.toNumber() - e.expected_probability!)).toBeLessThanOrEqual(e.tolerance!.absolute);
      expect(r.cutSets).toEqual(sortSets(e.expected_cut_sets!));
    });
  }

  it('values are exactly the hand-derived decimals, not merely within tolerance', () => {
    const exact = (id: string): boolean => enumerate(ORACLE_MODELS[id]!).probability.eq(qFromNumber(entries.find((e) => e.id === id)!.expected_probability!));
    for (const id of ['pra-and', 'pra-or', 'pra-aa', 'pra-oa', 'pra-shared', 'pra-pump1', 'pra-pump2-and', 'pra-pump2-or', 'pra-pump3-shared', 'pra-pump3-separate', 'pra-vote-exact']) {
      expect(exact(id), id).toBe(true);
    }
    expect(enumerate(ORACLE_MODELS['pra-vote-rare']!).rareEvent.eq(qFromNumber(0.03))).toBe(true);
    expect(enumerate(ORACLE_MODELS['pra-vote-mcub']!).mcub.eq(qFromNumber(0.029701))).toBe(true);
  });

  it('the native voting gate equals the AND/OR expansion exactly', () => {
    const a = enumerate(NATIVE_VOTE);
    const b = enumerate(ORACLE_MODELS['pra-vote-exact']!);
    expect(a.cutSets).toEqual(b.cutSets);
    expect(a.probability.eq(b.probability)).toBe(true);
    expect(a.rareEvent.eq(b.rareEvent)).toBe(true);
    expect(a.mcub.eq(b.mcub)).toBe(true);
  });
});

describe('oracle behaviour and limits', () => {
  it('a repeated event is one event: A AND A is A, not A squared', () => {
    const r = enumerate(ORACLE_MODELS['pra-aa']!);
    expect(r.probability.eq(qFromNumber(0.1))).toBe(true);
    expect(r.cutSets).toEqual([['A']]);
  });

  it('unreachable definitions do not change the result', () => {
    const base = ORACLE_MODELS['pra-pump3-shared']!;
    const padded = mkDoc('TOP', { P1: 0.1, P2: 0.1, S: 0.05, UNUSED: 0.9 }, [...base.gates, OR('ORPHAN', ['UNUSED', 'S'])]);
    const a = enumerate(base);
    const b = enumerate(padded);
    expect(b.events).toEqual(a.events);
    expect(b.cutSets).toEqual(a.cutSets);
    expect(b.probability.eq(a.probability)).toBe(true);
  });

  it('keeps structural cut sets when a probability is 0 or 1', () => {
    const zero = enumerate(mkDoc('TOP', { A: 0, B: 0.5 }, [AND('TOP', ['A', 'B'])]));
    expect(zero.cutSets).toEqual([['A', 'B']]);
    expect(zero.probability.eq(qFromNumber(0))).toBe(true);
    const one = enumerate(mkDoc('TOP', { A: 1, B: 0.5 }, [OR('TOP', ['A', 'B'])]));
    expect(one.cutSets).toEqual([['A'], ['B']]);
    expect(one.probability.eq(qFromNumber(1))).toBe(true);
  });

  it('handles exactly 16 reachable events and refuses 17 (literal numbers: plan 05 fixes the limit at 16)', () => {
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `E${i}`);
    const events = (n: number): Record<string, number> => Object.fromEntries(ids(n).map((id) => [id, 0.5]));
    expect(MAX_EVENTS).toBe(16);
    const all = enumerate(mkDoc('TOP', events(16), [AND('TOP', ids(16))]));
    expect(all.cutSets).toHaveLength(1);
    expect(all.cutSets[0]).toHaveLength(16);
    expect(all.probability.eq(qFromNumber(0.5 ** 16))).toBe(true);
    const any = enumerate(mkDoc('TOP', events(16), [OR('TOP', ids(16))]));
    expect(any.cutSets).toHaveLength(16);
    expect(() => enumerate(mkDoc('TOP', events(17), [AND('TOP', ids(17))]))).toThrow(/limit/);
  });

  it('refuses an invalid model instead of guessing', () => {
    const cyc = mkDoc('TOP', { A: 0.1 }, [OR('TOP', ['G2', 'A']), AND('G2', ['TOP', 'A'])]);
    expect(() => enumerate(cyc)).toThrow(/E_CYCLE/);
    expect(() => enumerate(mkDoc('TOP', { A: 1.5, B: 0.1 }, [AND('TOP', ['A', 'B'])]))).toThrow(/E_PROB_RANGE/);
  });
});

describe('exact arithmetic helpers', () => {
  it('parses doubles to the exact decimal they print as, including exponent forms', () => {
    expect(parseDecimal(0)).toEqual({ a: 0n, s: 0 });
    expect(parseDecimal(1)).toEqual({ a: 1n, s: 0 });
    expect(parseDecimal(0.021025)).toEqual({ a: 21025n, s: 6 });
    expect(parseDecimal(1e-7)).toEqual({ a: 1n, s: 7 });
    expect(parseDecimal(4.76837e-7)).toEqual({ a: 476837n, s: 12 });
    expect(parseDecimal(0.5 ** 21).s).toBeGreaterThan(20);
  });

  it('rational arithmetic and decimal printing', () => {
    const a = Q.make(1n, 3n);
    const b = Q.make(1n, 6n);
    expect(a.add(b).eq(Q.make(1n, 2n))).toBe(true);
    expect(a.sub(b).eq(b)).toBe(true);
    expect(a.mul(b).eq(Q.make(1n, 18n))).toBe(true);
    expect(a.cmp(b)).toBe(1);
    expect(Q.make(1n, 3n).toDecimal(5)).toBe('0.33333');
    expect(Q.make(7n, 1n).toDecimal(2)).toBe('7.00');
    expect(qFromNumber(1e-7).toDecimal(10)).toBe('0.0000001000');
  });
});

describe('seeded random coherent trees', () => {
  const stats = { docs: 0, ie: 0, maxEvents: 0, withZeroOrOne: 0, withVote: 0, withSharing: 0, maxCutSets: 0 };

  /** All properties that must hold for any coherent tree, using only independent checks. */
  function checkTree(doc: ReturnType<typeof randomDoc>, ctx: string): void {
    expect(validateModel(doc).errors, ctx).toEqual([]);
    const r = enumerate(doc);
    stats.docs++;
    stats.maxEvents = Math.max(stats.maxEvents, r.events.length);
    stats.maxCutSets = Math.max(stats.maxCutSets, r.cutSets.length);
    if (doc.events.some((e) => e.probability === 0 || e.probability === 1)) stats.withZeroOrOne++;
    if (doc.gates.some((g) => g.type === 'atleast')) stats.withVote++;
    const uses = new Map<string, number>();
    for (const g of doc.gates) for (const i of new Set(g.inputs)) uses.set(i, (uses.get(i) ?? 0) + 1);
    if ([...uses.values()].some((c) => c > 1)) stats.withSharing++;

    // Sperner: an antichain over n events has at most C(n, floor(n/2)) members; fails fast if minimality breaks
    const n0 = r.events.length;
    let sperner = 1;
    for (let i = 1; i <= Math.floor(n0 / 2); i++) sperner = (sperner * (n0 - i + 1)) / i;
    expect(r.cutSets.length, `${ctx} Sperner bound`).toBeLessThanOrEqual(Math.max(1, Math.round(sperner)));

    // cut sets: non-empty, an antichain, each failing, each minimal by the independent evaluator
    for (const c of r.cutSets) {
      expect(c.length, ctx).toBeGreaterThan(0);
      expect(topOccurs(doc, new Set(c)), ctx).toBe(true);
      for (const drop of c) expect(topOccurs(doc, new Set(c.filter((x) => x !== drop))), `${ctx} minimal`).toBe(false);
    }
    for (const a of r.cutSets) for (const b of r.cutSets) if (a !== b) expect(a.every((x) => b.includes(x)), `${ctx} antichain`).toBe(false);

    // the independent evaluator agrees with the cut sets on every subset of the reachable events
    const n = r.events.length;
    for (let mask = 0; mask < 1 << n; mask++) {
      const failed = new Set(r.events.filter((_, i) => (mask >> i) & 1));
      const covers = r.cutSets.some((c) => c.every((x) => failed.has(x)));
      expect(topOccurs(doc, failed), `${ctx} mask ${mask}`).toBe(covers);
    }

    // probability by inclusion-exclusion over the cut sets equals the state-sum, exactly
    const ie = inclusionExclusion(r.cutSets, doc as NativeDoc, 10);
    if (ie) {
      stats.ie++;
      expect(ie.eq(r.probability), `${ctx} inclusion-exclusion`).toBe(true);
    }

    // bounds: 0 <= exact <= min-cut upper bound <= rare-event sum
    expect(r.probability.cmp(qFromNumber(0)), ctx).toBeGreaterThanOrEqual(0);
    expect(r.probability.cmp(qFromNumber(1)), ctx).toBeLessThanOrEqual(0);
    expect(r.probability.cmp(r.mcub), `${ctx} exact<=mcub`).toBeLessThanOrEqual(0);
    expect(r.mcub.cmp(r.rareEvent), `${ctx} mcub<=rare`).toBeLessThanOrEqual(0);
  }

  const SMALL = 300;
  const LARGE = 25;
  it(`${SMALL} small trees agree across independent methods`, () => {
    for (let seed = 1; seed <= SMALL; seed++) checkTree(randomDoc(seed), `small seed ${seed}`);
  });

  it(`${LARGE} larger trees (11 to 14 events) agree across independent methods`, () => {
    for (let seed = 1001; seed < 1001 + LARGE; seed++) {
      checkTree(randomDoc(seed, { events: 11 + (seed % 4), gates: 10 + (seed % 7) }), `large seed ${seed}`);
    }
  });

  it('the generator exercises what the properties are meant to cover', () => {
    expect(stats.docs).toBe(SMALL + LARGE);
    expect(stats.ie).toBeGreaterThanOrEqual(150);
    expect(stats.maxEvents).toBeGreaterThanOrEqual(11);
    expect(stats.maxCutSets).toBeGreaterThanOrEqual(10);
    expect(stats.withZeroOrOne).toBeGreaterThanOrEqual(30);
    expect(stats.withVote).toBeGreaterThanOrEqual(20);
    expect(stats.withSharing).toBeGreaterThanOrEqual(100);
  });

  it('the same seed gives the same tree and the same answer', () => {
    expect(randomDoc(42)).toEqual(randomDoc(42));
    expect(enumerate(randomDoc(42)).probability.eq(enumerate(randomDoc(42)).probability)).toBe(true);
    expect(randomDoc(42)).not.toEqual(randomDoc(43));
  });
});

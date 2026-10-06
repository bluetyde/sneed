import { describe, expect, it } from 'vitest';
import { importance, MAX_IMPORTANCE_EVENTS } from '../../src/engines/bdd/importance.js';
import { SolveAborted } from '../../src/engines/bdd/solve.js';
import type { NativeModel } from '../../src/core/model.js';
import { enumerate } from '../oracle/enumerate.js';
import { AND, mkDoc, OR, ORACLE_MODELS, randomDoc, VOTE, type Doc } from '../oracle/models.js';

const imp = (d: Doc, opts: Record<string, unknown> = {}) => importance(d as unknown as NativeModel, opts);
const byId = (d: Doc) => Object.fromEntries(imp(d).rows.map((r) => [r.id, r]));

describe('hand oracles (docs/plans/12-importance.md)', () => {
  it('A AND B (0.1, 0.2): Birnbaum 0.2 and 0.1, RAW 10 and 5, every cut set holds both so RRW is unbounded and FV is 1', () => {
    const d = mkDoc('T', { A: 0.1, B: 0.2 }, [AND('T', ['A', 'B'])]);
    const r = imp(d);
    expect(r.top).toBeCloseTo(0.02, 15);
    const m = byId(d);
    expect(m.A!.birnbaum).toBeCloseTo(0.2, 15);
    expect(m.B!.birnbaum).toBeCloseTo(0.1, 15);
    expect(m.A!.raw).toBeCloseTo(10, 12);
    expect(m.B!.raw).toBeCloseTo(5, 12);
    expect(m.A!.rrw).toBeNull();
    expect(m.A!.rrwInfinite).toBe(true);
    expect(m.A!.fv).toBeCloseTo(1, 15);
    expect(m.B!.fv).toBeCloseTo(1, 15);
  });

  it('A OR B (0.1, 0.2): Birnbaum 0.8 and 0.9, RAW 1/0.28, RRW 1.4 and 2.8, FV 0.08/0.28 and 0.18/0.28', () => {
    const d = mkDoc('T', { A: 0.1, B: 0.2 }, [OR('T', ['A', 'B'])]);
    expect(imp(d).top).toBeCloseTo(0.28, 15);
    const m = byId(d);
    expect(m.A!.birnbaum).toBeCloseTo(0.8, 15);
    expect(m.B!.birnbaum).toBeCloseTo(0.9, 15);
    expect(m.A!.raw).toBeCloseTo(1 / 0.28, 12);
    expect(m.B!.raw).toBeCloseTo(1 / 0.28, 12);
    expect(m.A!.rrw).toBeCloseTo(1.4, 12);
    expect(m.B!.rrw).toBeCloseTo(2.8, 12);
    expect(m.A!.fv).toBeCloseTo(0.08 / 0.28, 12);
    expect(m.B!.fv).toBeCloseTo(0.18 / 0.28, 12);
    expect(m.A!.rrwInfinite).toBe(false);
  });

  it('a repeated event: (A AND B) OR (A AND C) has IB_A = P(B OR C) and IB_B = p_A (1 - p_C)', () => {
    const d = mkDoc('T', { A: 0.1, B: 0.2, C: 0.3 }, [OR('T', ['X', 'Y']), AND('X', ['A', 'B']), AND('Y', ['A', 'C'])]);
    const m = byId(d);
    expect(m.A!.birnbaum).toBeCloseTo(1 - 0.8 * 0.7, 14);
    expect(m.B!.birnbaum).toBeCloseTo(0.1 * (1 - 0.3), 14);
    expect(m.C!.birnbaum).toBeCloseTo(0.1 * (1 - 0.2), 14);
    expect(imp(d).rows).toHaveLength(3); // A is one event, listed once
  });

  it('a 2-of-3 gate: every event has the same Birnbaum importance, 2p(1-p) with equal p', () => {
    const d = mkDoc('V', { A: 0.1, B: 0.1, C: 0.1 }, [VOTE('V', ['A', 'B', 'C'], 2)]);
    for (const r of imp(d).rows) expect(r.birnbaum).toBeCloseTo(2 * 0.1 * 0.9, 14);
  });
});

describe('agreement with the independent enumeration oracle (exact rationals)', () => {
  const close = (a: number | null, b: number | null, ctx: string): void => {
    if (a === null || b === null) return void expect(a, ctx).toBe(b);
    expect(Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)) || Math.abs(a - b) < 1e-15, `${ctx}: ${a} vs ${b}`).toBe(true);
  };
  const check = (doc: Doc, ctx: string): void => {
    const set = (id: string, p: number): Doc => ({ ...doc, events: doc.events.map((e) => (e.id === id ? { ...e, probability: p } : e)) });
    const P = enumerate(doc).probability.toNumber();
    const r = imp(doc);
    close(r.top, P, `${ctx} top`);
    const reachable = enumerate(doc).events;
    expect(r.rows.map((x) => x.id).sort(), ctx).toEqual(reachable);
    for (const row of r.rows) {
      const failed = enumerate(set(row.id, 1)).probability.toNumber();
      const works = enumerate(set(row.id, 0)).probability.toNumber();
      close(row.birnbaum, failed - works, `${ctx} ${row.id} IB`);
      close(row.raw, P > 0 ? failed / P : null, `${ctx} ${row.id} RAW`);
      close(row.rrw, P > 0 && works > 0 ? P / works : null, `${ctx} ${row.id} RRW`);
      expect(row.rrwInfinite, `${ctx} ${row.id} inf`).toBe(P > 0 && works === 0);
      close(row.fv, P > 0 ? (P - works) / P : null, `${ctx} ${row.id} FV`);
    }
  };

  it('every frozen oracle model', () => {
    for (const [id, doc] of Object.entries(ORACLE_MODELS)) check(doc, id);
  });

  it('1000 random trees (repeated events, K-of-N, probabilities 0 and 1)', () => {
    for (let seed = 1; seed <= 1000; seed++) check(randomDoc(seed), `seed ${seed}`);
  });

  it('Birnbaum importance is the derivative: a finite difference of the exact probability agrees', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const doc = randomDoc(seed);
      for (const row of imp(doc).rows) {
        if (row.probability <= 0.01 || row.probability >= 0.99) continue;
        const h = 1e-4;
        const at = (p: number): number => enumerate({ ...doc, events: doc.events.map((e) => (e.id === row.id ? { ...e, probability: p } : e)) }).probability.toNumber();
        // P is linear in each p_i, so the difference quotient is exact, not an approximation
        expect(Math.abs((at(row.probability + h) - at(row.probability - h)) / (2 * h) - row.birnbaum), `seed ${seed} ${row.id}`).toBeLessThan(1e-7);
      }
    }
  });

  it('identities: FV = 1 - 1/RRW, and P = p_i IB_i + P(T | i works)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const doc = randomDoc(seed);
      const r = imp(doc);
      for (const row of r.rows) {
        if (row.rrw !== null && row.fv !== null) expect(Math.abs(row.fv - (1 - 1 / row.rrw)), `seed ${seed} ${row.id}`).toBeLessThan(1e-9);
        if (row.fv !== null && r.top > 0) {
          const works = r.top - row.fv * r.top;
          expect(Math.abs(r.top - (row.probability * row.birnbaum + works)), `seed ${seed} ${row.id}`).toBeLessThan(1e-12);
        }
      }
    }
  });
});

describe('edge cases and limits', () => {
  it('a model whose top probability is 0 has no ratios, not NaN or Infinity', () => {
    const d = mkDoc('T', { A: 0, B: 0.2 }, [AND('T', ['A', 'B'])]);
    const r = imp(d);
    expect(r.top).toBe(0);
    for (const row of r.rows) {
      expect(row.raw).toBeNull();
      expect(row.rrw).toBeNull();
      expect(row.fv).toBeNull();
      expect(row.rrwInfinite).toBe(false);
      expect(Number.isFinite(row.birnbaum)).toBe(true);
    }
    expect(byId(d).A!.birnbaum).toBeCloseTo(0.2, 15); // still meaningful: the top moves 0.2 per unit of p_A
  });

  it('events that cannot reach the top are not listed', () => {
    const d = mkDoc('T', { A: 0.1, B: 0.2, UNUSED: 0.5 }, [OR('T', ['A', 'B'])]);
    expect(imp(d).rows.map((r) => r.id).sort()).toEqual(['A', 'B']);
  });

  it('is sorted by Birnbaum importance, largest first, ties by id', () => {
    const d = mkDoc('T', { C: 0.1, A: 0.1, B: 0.5 }, [OR('T', ['C', 'A', 'B'])]); // C is met before A, so only the id breaks the tie
    // IB_A = IB_C = 0.45, IB_B = 0.81
    expect(imp(d).rows.map((r) => r.id)).toEqual(['B', 'A', 'C']);
  });

  it('refuses more than the event limit with the solver reason, never a partial table', () => {
    const n = MAX_IMPORTANCE_EVENTS + 1;
    const events = Object.fromEntries(Array.from({ length: n }, (_, i) => [`E${i}`, 0.01]));
    const d = mkDoc('T', events, [OR('T', Object.keys(events))]);
    let why = '';
    try {
      imp(d);
    } catch (e) {
      expect(e).toBeInstanceOf(SolveAborted);
      why = (e as SolveAborted).why;
    }
    expect(why).toBe('too-many-events');
    const ok = Object.fromEntries(Array.from({ length: MAX_IMPORTANCE_EVENTS }, (_, i) => [`E${i}`, 0.01]));
    expect(imp(mkDoc('T', ok, [OR('T', Object.keys(ok))])).rows).toHaveLength(MAX_IMPORTANCE_EVENTS); // exactly the limit is fine
  });

  it('refuses when the work (events x diagram nodes) is over the budget', () => {
    const d = mkDoc('T', { A: 0.1, B: 0.2 }, [AND('T', ['A', 'B'])]);
    expect(() => imp(d, { maxWork: 1 })).toThrowError(SolveAborted);
    expect(imp(d, { maxWork: 1e9 }).rows).toHaveLength(2);
    // the budget is events x diagram nodes: exactly that much is allowed, one less is not
    const r = imp(d, { maxWork: 1e9 });
    const work = r.rows.length * r.nodes;
    expect(work).toBeGreaterThan(r.rows.length);
    expect(imp(d, { maxWork: work }).rows).toHaveLength(2);
    expect(() => imp(d, { maxWork: work - 1 })).toThrowError(SolveAborted);
  });

  it('the variable order never changes the answer', () => {
    const doc = ORACLE_MODELS['pra-shared'] as Doc;
    const a = imp(doc);
    const b = imp(doc, { order: [...a.rows.map((r) => r.id)].reverse() });
    const first = Object.fromEntries(a.rows.map((r) => [r.id, r.birnbaum]));
    expect(b.rows).toHaveLength(a.rows.length);
    for (const r of b.rows) expect(r.birnbaum).toBeCloseTo(first[r.id]!, 14); // floating point sums in another order differ in the last digits only
  });

  it('does not change the model it is given', () => {
    const doc = JSON.parse(JSON.stringify(ORACLE_MODELS['pra-shared']));
    const before = JSON.stringify(doc);
    importance(doc as NativeModel);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('floating point is watched (Codex review)', () => {
  const why = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(SolveAborted);
      return (e as SolveAborted).why;
    }
    return 'no error';
  };

  it('an almost certain top event keeps its importance: an OR of 16 events near 0.9 is not reported as zero or tied', () => {
    const ps = Array.from({ length: 16 }, (_, i) => 0.9 + i / 200); // 0.900 ... 0.975, all different
    const events = Object.fromEntries(ps.map((p, i) => [`E${i}`, p]));
    const d = mkDoc('T', events, [OR('T', Object.keys(events))]);
    const r = imp(d);
    const falseAll = ps.reduce((a, p) => a * (1 - p), 1);
    for (const row of r.rows) {
      const i = Number(row.id.slice(1));
      const expected = falseAll / (1 - ps[i]!); // product of the other events' (1 - p)
      expect(row.birnbaum, row.id).toBeGreaterThan(0);
      expect(Math.abs(row.birnbaum - expected) / expected, row.id).toBeLessThan(1e-9);
      expect(row.fv!, row.id).toBeCloseTo(ps[i]! * expected, 25);
      expect(row.fv!, row.id).toBeGreaterThan(0);
    }
    expect(new Set(r.rows.map((x) => x.birnbaum)).size).toBe(16); // no artificial ties
    expect(r.rows[0]!.id).toBe('E15'); // Birnbaum is the product of the OTHERS' (1 - p): largest when this event's own (1 - p) is smallest
  });

  it('a top probability below what a double can hold is a numeric-range failure, never a table with zeros', () => {
    const events = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`E${i}`, 0.001]));
    const d = mkDoc('T', events, [AND('T', Object.keys(events))]);
    expect(why(() => imp(d))).toBe('numeric-range');
  });

  it('a conditional probability that underflows although the event can matter is a failure; a structural zero is not', () => {
    const events: Record<string, number> = { Y: 0.5 };
    for (let i = 0; i < 200; i++) events[`E${i}`] = 0.001;
    const d = mkDoc('T', events, [OR('T', ['Y', 'X']), AND('X', Object.keys(events).filter((k) => k !== 'Y'))]);
    expect(why(() => imp(d))).toBe('numeric-range'); // with Y working the top probability is 1e-600: not zero, only too small
    const impossible = mkDoc('T', { A: 0.5, B: 0.2, C: 0 }, [OR('T', ['A', 'X']), AND('X', ['B', 'C'])]);
    const m = byId(impossible);
    expect(m.B!.rrwInfinite).toBe(false); // B can fail, and A keeps the top possible with B working
    expect(Number.isFinite(m.B!.birnbaum)).toBe(true);
    const onlyPath = mkDoc('T', { A: 0.5, B: 0.2 }, [AND('T', ['A', 'B'])]);
    expect(byId(onlyPath).A!.rrwInfinite).toBe(true); // structurally impossible with A working: infinite, not an error
  });

  it('a measure that overflows (a tiny top probability) is a failure, not Infinity inside a table', () => {
    const d = mkDoc('T', { A: 1e-320, B: 0 }, [OR('T', ['A', 'B'])]);
    expect(why(() => imp(d))).toBe('numeric-range');
  });
});


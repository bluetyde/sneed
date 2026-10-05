import { describe, expect, it } from 'vitest';
import { assess, AssessAborted, hasNonMinimal, MAX_CUT_SETS, MINIMALITY_BUDGET, type AssessInput, type Outcome } from '../../src/core/result.js';
import { maxCutSetOrderBound, reachableEvents } from '../../src/core/bounds.js';
import { makeReport, type FakeReport } from '../oracle/reportgen.js';
import { AND, OR, VOTE, mkDoc, ORACLE_MODELS } from '../oracle/models.js';
import type { NativeModel, Settings } from '../../src/core/model.js';

const asModel = (d: ReturnType<typeof mkDoc>): NativeModel => d as unknown as NativeModel;
const ENGINE = { name: 'SCRAM', version: '0.16.2', sha256: 'abc' };
const HASHES = { model_hash: 'm', document_hash: 'd', exported_input_hash: 'x' };
const OK: Outcome = { exit: 0, timedOut: false, cancelled: false, stderr: '' };

function run(model: NativeModel, report: FakeReport | string | null, over: Partial<AssessInput> = {}, settings: Partial<Settings> = {}) {
  const events = reachableEvents(model);
  return assess({
    model,
    settings: { method: 'exact', limitOrder: Math.max(1, events.length), ...settings },
    engine: ENGINE,
    expectedVersion: '0.16.2',
    outcome: OK,
    reportText: report === null ? null : typeof report === 'string' ? report : makeReport(report),
    hashes: HASHES,
    exportedEvents: events,
    ...over,
  });
}

const and = asModel(ORACLE_MODELS['pra-and']!);
const goodAnd: FakeReport = { probability: '0.02', limit: 2, products: [{ events: ['A', 'B'], probability: '0.02' }] };

describe('a clean result', () => {
  it('is completed and complete, with the numbers and provenance attached', () => {
    const r = run(and, goodAnd);
    expect(r).toMatchObject({ status: 'completed', completeness: 'complete', reasons: [], top_event_probability: 0.02, method: 'exact', unit: 'dimensionless' });
    expect(r.minimal_cut_sets).toEqual([{ events: ['A', 'B'], probability: 0.02 }]);
    expect(r.input_hashes).toEqual(HASHES);
    expect(r.engine.version).toBe('0.16.2');
    expect(r.assumptions).toMatchObject({ independence: 'declared-independent' });
    expect(r.exporter_version).toMatch(/^sneed-export/);
    expect(r.parser_version).toMatch(/^sneed-report/);
  });

  it('a limit below the event count is fine when the structure cannot make a longer cut set', () => {
    const or5 = asModel(mkDoc('TOP', { A: 0.1, B: 0.1, C: 0.1, D: 0.1, E: 0.1 }, [OR('TOP', ['A', 'B', 'C', 'D', 'E'])]));
    expect(maxCutSetOrderBound(or5)).toBe(1);
    const products = ['A', 'B', 'C', 'D', 'E'].map((e) => ({ events: [e], probability: '0.1' }));
    expect(run(or5, { probability: '0.40951', limit: 1, products }).status).toBe('completed');
  });

  it('approximation methods are accepted when the report names them', () => {
    const vote = asModel(ORACLE_MODELS['pra-vote-rare']!);
    const products = [['A', 'B'], ['A', 'C'], ['B', 'C']].map((e) => ({ events: e, probability: '0.01' }));
    const r = run(vote, { probability: '0.03', approximation: 'rare-event', limit: 3, products }, {}, { method: 'rare-event' });
    expect(r.status).toBe('completed');
    expect(r.method).toBe('rare-event');
  });
});

describe('outcomes that are never a success', () => {
  const notSuccess = (r: ReturnType<typeof run>): void => {
    expect(r.status === 'completed' && r.completeness === 'complete').toBe(false);
  };

  it('cancellation wins even if the engine exited zero with a good report', () => {
    const r = run(and, goodAnd, { outcome: { ...OK, cancelled: true } });
    expect(r).toMatchObject({ status: 'cancelled', completeness: 'unknown', reasons: ['cancelled'], top_event_probability: null });
  });

  it('a timeout is a failure with unknown completeness', () => {
    const r = run(and, goodAnd, { outcome: { ...OK, timedOut: true } });
    expect(r).toMatchObject({ status: 'failed', completeness: 'unknown', reasons: ['timeout'] });
  });

  it('a nonzero exit is a failure and names the engine error class', () => {
    const r = run(and, goodAnd, { outcome: { exit: 1, timedOut: false, cancelled: false, stderr: 'scram::mef::CycleError Detected a cycle' } });
    expect(r).toMatchObject({ status: 'failed', completeness: 'unknown', top_event_probability: null });
    expect(r.reasons).toEqual(['engine-exit-1', 'engine-error:scram::mef::CycleError']);
  });

  it('a nonzero exit with a perfect-looking report is still a failure', () => {
    expect(run(and, goodAnd, { outcome: { ...OK, exit: 3 } }).status).toBe('failed');
    expect(run(and, goodAnd, { outcome: { ...OK, exit: null } }).status).toBe('failed');
  });

  it('a missing, empty or malformed report', () => {
    expect(run(and, null).reasons).toEqual(['no-report']);
    expect(run(and, '').reasons).toEqual(['report-R_MISSING']);
    expect(run(and, '<report><oops').reasons).toEqual(['report-R_MALFORMED']);
    expect(run(and, makeReport(goodAnd).replace('<report>', '<!DOCTYPE r><report>')).reasons).toEqual(['report-R_UNSAFE']);
  });

  const cases: [string, FakeReport, string][] = [
    ['engine version differs', { ...goodAnd, version: '0.16.1' }, 'engine-version-mismatch'],
    ['a different engine', { ...goodAnd, name: 'XFTA' }, 'engine-version-mismatch'],
    ['method differs from the request', { ...goodAnd, approximation: 'rare-event' }, 'method-mismatch'],
    ['method not reported', { ...goodAnd, approximation: null }, 'method-mismatch'],
    ['probability above 1', { ...goodAnd, probability: '1.5' }, 'probability-out-of-range'],
    ['negative probability', { ...goodAnd, probability: '-0.1' }, 'probability-out-of-range'],
    ['cut set names an event that is not in the model', { ...goodAnd, products: [{ events: ['A', 'ZZ'], probability: '0.02' }] }, 'unknown-event-in-cut-set'],
    ['cut-set probability disagrees with the model', { ...goodAnd, products: [{ events: ['A', 'B'], probability: '0.03' }] }, 'cut-set-probability-mismatch'],
    ['cut-set order disagrees with its events', { ...goodAnd, products: [{ events: ['A', 'B'], probability: '0.02', order: 3 }] }, 'malformed-cut-set'],
    ['cut set repeats an event', { ...goodAnd, products: [{ events: ['A', 'A'], probability: '0.01' }] }, 'malformed-cut-set'],
    ['cut set is empty', { ...goodAnd, products: [{ events: [], probability: '1' }] }, 'malformed-cut-set'],
    ['the same cut set twice', { ...goodAnd, products: [{ events: ['A', 'B'], probability: '0.02' }, { events: ['B', 'A'], probability: '0.02' }] }, 'duplicate-cut-set'],
    ['limit not reported', { ...goodAnd, limit: null }, 'limit-not-reported'],
    ['no cut sets although the limit was ample', { probability: '0.02', limit: 2, products: [] }, 'empty-result-inconsistent'],
  ];
  for (const [name, report, reason] of cases) {
    it(`${name} -> failed (${reason})`, () => {
      const r = run(and, report);
      notSuccess(r);
      expect(r).toMatchObject({ status: 'failed', completeness: 'unknown', top_event_probability: null });
      expect(r.reasons).toContain(reason);
    });
  }

  describe('an approximation whose own value exceeds 1', () => {
    // rare-event sum of three events at 0.9 is 2.7; SCRAM prints 1 and only warns (seen in a real run)
    const or3 = asModel(mkDoc('TOP', { A: 0.9, B: 0.9, C: 0.9 }, [OR('TOP', ['A', 'B', 'C'])]));
    const products = ['A', 'B', 'C'].map((e) => ({ events: [e], probability: '0.9' }));
    const warning = 'Probability may have been adjusted to 1.';
    const rare = (probability: string, w: string | undefined = warning) => run(or3, { probability, approximation: 'rare-event', limit: 3, ...(w ? { warning: w } : {}), products }, {}, { method: 'rare-event' });

    it('is a completed result that keeps the bound as the probability and shows the real value, labelled', () => {
      const r = rare('1');
      expect(r).toMatchObject({ status: 'completed', completeness: 'complete', reasons: [], top_event_probability: 1, caveats: ['approximation-exceeds-1'] });
      expect(r.approximation_value).toBeCloseTo(2.7, 12);
      expect(r.warnings).toEqual([warning]); // the engine's own words are kept too
    });

    it('is still labelled when the engine gave no warning but printed the clamp', () => {
      expect(rare('1', '').caveats).toEqual(['approximation-exceeds-1']);
    });

    it('is a failure when the engine printed anything other than the clamp', () => {
      const expected: Record<string, string> = { '0.5': 'probability-inconsistent-with-cut-sets', '0.9': 'probability-inconsistent-with-cut-sets', '2.7': 'probability-out-of-range' };
      for (const [printed, reason] of Object.entries(expected)) {
        const r = rare(printed);
        expect(r.status, printed).toBe('failed');
        expect(r.reasons, printed).toEqual([reason]);
        expect(r.top_event_probability).toBeNull();
        expect(r.approximation_value).toBeNull();
      }
    });
  });

  it('approximation values are recorded for rare-event and MCUB, and absent for the exact method', () => {
    const or2 = asModel(ORACLE_MODELS['pra-or']!);
    const products = [{ events: ['A'], probability: '0.1' }, { events: ['B'], probability: '0.2' }];
    const r = run(or2, { probability: '0.3', approximation: 'rare-event', limit: 2, products }, {}, { method: 'rare-event' });
    expect(r).toMatchObject({ status: 'completed', caveats: [] });
    expect(r.approximation_value).toBeCloseTo(0.3, 12);
    const m = run(or2, { probability: '0.28', approximation: 'mcub', limit: 2, products }, {}, { method: 'mcub' });
    expect(m.approximation_value).toBeCloseTo(0.28, 12);
    expect(run(or2, { probability: '0.28', limit: 2, products }).approximation_value).toBeNull();
  });

  it('an engine clamp warning is harmless when the true value is exactly 1 (an event with probability 1)', () => {
    const m = asModel(mkDoc('TOP', { A: 1, B: 0.2 }, [OR('TOP', ['A', 'B'])]));
    const products = [{ events: ['A'], probability: '1' }, { events: ['B'], probability: '0.2' }];
    const r = run(m, { probability: '1', approximation: 'mcub', limit: 2, warning: 'Probability may have been adjusted to 1.', products }, {}, { method: 'mcub' });
    expect(r).toMatchObject({ status: 'completed', completeness: 'complete', top_event_probability: 1, caveats: [] });
    expect(r.approximation_value).toBe(1); // exactly 1 is the method's value, not an overflow
    expect(r.warnings).toEqual(['Probability may have been adjusted to 1.']);
  });

  it('rare-event and MCUB values must match what the reported cut sets imply', () => {
    const or2 = asModel(ORACLE_MODELS['pra-or']!);
    const products = [{ events: ['A'], probability: '0.1' }, { events: ['B'], probability: '0.2' }];
    const rare = (probability: string) => run(or2, { probability, approximation: 'rare-event', limit: 2, products }, {}, { method: 'rare-event' });
    const mcub = (probability: string) => run(or2, { probability, approximation: 'mcub', limit: 2, products }, {}, { method: 'mcub' });
    expect(rare('0.3').status).toBe('completed'); // 0.1 + 0.2
    expect(rare('0.28').reasons).toEqual(['probability-inconsistent-with-cut-sets']); // the exact value is not the rare-event value
    expect(mcub('0.28').status).toBe('completed'); // 1 - 0.9 * 0.8
    expect(mcub('0.3').reasons).toEqual(['probability-inconsistent-with-cut-sets']);
  });

  it('an engine clamp warning on an exact result: harmless at 1, a failure at any other value', () => {
    const one = asModel(mkDoc('TOP', { A: 1, B: 0.2 }, [OR('TOP', ['A', 'B'])]));
    const products = [{ events: ['A'], probability: '1' }, { events: ['B'], probability: '0.2' }];
    const warning = 'Probability may have been adjusted to 1.';
    expect(run(one, { probability: '1', limit: 2, warning, products }).status).toBe('completed');
    const or2 = asModel(ORACLE_MODELS['pra-or']!);
    const r = run(or2, { probability: '0.28', limit: 2, warning, products: [{ events: ['A'], probability: '0.1' }, { events: ['B'], probability: '0.2' }] });
    expect(r.status).toBe('failed');
    expect(r.reasons).toEqual(['probability-adjusted-by-engine']);
  });

  it('a non-minimal cut-set family is refused', () => {
    const or2 = asModel(ORACLE_MODELS['pra-or']!);
    const r = run(or2, { probability: '0.28', limit: 2, products: [{ events: ['A'], probability: '0.1' }, { events: ['A', 'B'], probability: '0.02' }, { events: ['B'], probability: '0.2' }] });
    expect(r.reasons).toContain('non-minimal-cut-sets');
    expect(r.status).toBe('failed');
  });

  it('the limit-reported field can never be satisfied by an unrelated number in the report', () => {
    // a report whose only product-order text is in another element must not be read as the limit
    const text = makeReport({ ...goodAnd, limit: null }).replace('<mission-time>8760</mission-time>', '<product-order>99</product-order>');
    expect(run(and, text).reasons).toContain('limit-not-reported');
  });
});

describe('truncation and completeness', () => {
  const and3 = asModel(mkDoc('TOP', { A: 0.1, B: 0.2, C: 0.3 }, [AND('TOP', ['A', 'B', 'C'])]));

  it('structural bound: AND adds, OR takes the maximum, K-of-N adds the K largest', () => {
    expect(maxCutSetOrderBound(and3)).toBe(3);
    expect(maxCutSetOrderBound(asModel(ORACLE_MODELS['pra-pump3-separate']!))).toBe(2);
    expect(maxCutSetOrderBound(asModel(ORACLE_MODELS['pra-pump3-shared']!))).toBe(2);
    expect(maxCutSetOrderBound(asModel(mkDoc('V', { A: 0.1, B: 0.1, C: 0.1 }, [VOTE('V', ['A', 'B', 'C'], 2)])))).toBe(2);
    expect(maxCutSetOrderBound(asModel(ORACLE_MODELS['pra-aa']!))).toBe(1);
  });

  it('all cut sets dropped but a positive probability reported proves truncation', () => {
    const r = run(and3, { probability: '0.006', limit: 2, products: [], warning: 'The set is NULL/Empty.' }, {}, { limitOrder: 2 });
    expect(r).toMatchObject({ status: 'truncated', completeness: 'truncated', reasons: ['product-order-limit-effective'], top_event_probability: 0.006 });
  });

  it('some cut sets dropped is proven by the exact probability exceeding what the kept sets explain', () => {
    // (A AND B) OR (C AND D AND E) with limit 2 keeps only {A,B}; the exact probability still includes the long set
    const m = asModel(mkDoc('TOP', { A: 0.1, B: 0.2, C: 0.5, D: 0.5, E: 0.5 }, [OR('TOP', ['L', 'S']), AND('L', ['C', 'D', 'E']), AND('S', ['A', 'B'])]));
    const exact = 1 - (1 - 0.02) * (1 - 0.125);
    const r = run(m, { probability: String(exact), limit: 2, products: [{ events: ['A', 'B'], probability: '0.02' }] }, {}, { limitOrder: 2 });
    expect(r).toMatchObject({ status: 'truncated', completeness: 'truncated' });
  });

  it('a low limit with no evidence of omission is NOT called complete or truncated: it fails as unknown', () => {
    // C has probability 0, so the dropped cut set {A,B,C} is invisible in the reported probability
    const zeroC = asModel(mkDoc('TOP', { A: 0.1, B: 0.2, C: 0 }, [AND('TOP', ['A', 'B', 'C'])]));
    const r = run(zeroC, { probability: '0', limit: 2, products: [] }, {}, { limitOrder: 2 });
    expect(r.status).toBe('failed');
    expect(r.completeness).toBe('unknown');
    expect(r.reasons).toEqual(['limit-below-bound-completeness-unknown']);
  });

  it('kept cut sets that explain MORE than the reported total make the report inconsistent, not truncated', () => {
    const r = run(and3, { probability: '0.006', limit: 2, products: [{ events: ['A', 'B'], probability: '0.02' }] }, {}, { limitOrder: 2 });
    expect(r.status).toBe('failed');
    expect(r.reasons).toEqual(['probability-inconsistent-with-cut-sets']);
  });

  it('even with an ample limit, a probability the cut sets do not explain is not complete', () => {
    const or2 = asModel(ORACLE_MODELS['pra-or']!);
    const products = [{ events: ['A'], probability: '0.1' }, { events: ['B'], probability: '0.2' }];
    expect(run(or2, { probability: '0.28', limit: 2, products }).status).toBe('completed');
    expect(run(or2, { probability: '0.35', limit: 2, products }).reasons).toEqual(['probability-inconsistent-with-cut-sets']);
    expect(run(or2, { probability: '0.2', limit: 2, products }).reasons).toEqual(['probability-inconsistent-with-cut-sets']);
  });

  it('a truncated result keeps its numbers for diagnosis but is not a successful analysis', () => {
    const r = run(and3, { probability: '0.006', limit: 2, products: [] }, {}, { limitOrder: 2 });
    expect(r.status === 'completed' && r.completeness === 'complete').toBe(false);
  });

  it('approximation methods cannot prove omission, so a low limit is unknown', () => {
    const r = run(and3, { probability: '0.006', limit: 2, approximation: 'rare-event', products: [{ events: ['A', 'B'], probability: '0.02' }] }, {}, { method: 'rare-event', limitOrder: 2 });
    expect(r.status).toBe('failed');
  });

  it('the default limit (event count) on the engine default of 20 cannot hide a 21-event cut set', () => {
    const ids = Array.from({ length: 21 }, (_, i) => `E${i}`);
    const big = asModel(mkDoc('TOP', Object.fromEntries(ids.map((i) => [i, 0.5])), [AND('TOP', ids)]));
    const r = run(big, { probability: '4.76837e-07', limit: 20, products: [] });
    expect(r.status).toBe('truncated');
  });
});

describe('the checks on a large report are bounded (found by SEED: --timeout-seconds was not enforced)', () => {
  it('hasNonMinimal finds a proper subset, whatever the order of the sets and of the events', () => {
    expect(hasNonMinimal([['A', 'B'], ['C']])).toBe(false);
    expect(hasNonMinimal([['A', 'B', 'C'], ['B', 'A']])).toBe(true);
    expect(hasNonMinimal([['C', 'B', 'A'], ['X'], ['A']])).toBe(true);
    expect(hasNonMinimal([['A'], ['B'], ['A', 'B']])).toBe(true);
    expect(hasNonMinimal([['A', 'B'], ['A', 'C'], ['B', 'C']])).toBe(false);
    expect(hasNonMinimal([['A', 'B'], ['A', 'B', 'C', 'D'], ['E', 'F']])).toBe(true);
    expect(hasNonMinimal([])).toBe(false);
    expect(hasNonMinimal([['A']])).toBe(false);
  });

  it('agrees with the plain quadratic definition on many random families', () => {
    let seed = 7;
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const plain = (sets: string[][]): boolean => sets.some((a, i) => sets.some((b, j) => i !== j && a.length < b.length && a.every((e) => b.includes(e))));
    for (let t = 0; t < 400; t++) {
      const events = 'ABCDEFGH'.split('');
      const sets = Array.from({ length: 1 + rnd(8) }, () => {
        const k = 1 + rnd(4);
        const chosen = new Set<string>();
        while (chosen.size < k) chosen.add(events[rnd(events.length)]!);
        return [...chosen];
      });
      expect(hasNonMinimal(sets), JSON.stringify(sets)).toBe(plain(sets));
    }
  });

  it('a family of equal-size sets costs almost nothing, however many (no comparison is needed)', () => {
    const n = 20000; // 15 pairs would be 32768 sets of size 15
    const sets = Array.from({ length: n }, (_, i) => Array.from({ length: 15 }, (_, k) => `${(i >> k) & 1 ? 'B' : 'A'}${k}`));
    const t0 = Date.now();
    expect(hasNonMinimal(sets)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('work beyond the budget stops with too-large instead of running on', () => {
    // every larger set meets a posting list as long as the number of smaller sets: about 4e8 steps without a budget
    const small = Array.from({ length: 20000 }, (_, i) => ['X', `F${i}`]);
    const large = Array.from({ length: 20000 }, (_, i) => ['X', `G${i}`, `H${i}`]);
    const t0 = Date.now();
    let thrown: unknown = null;
    try {
      hasNonMinimal([...small, ...large]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AssessAborted);
    expect((thrown as AssessAborted).why).toBe('too-large');
    expect(Date.now() - t0).toBeLessThan(20000);
    expect(MINIMALITY_BUDGET).toBe(40_000_000);
  });

  it('hasNonMinimal polls the check callback while it works, and its abort stops it', () => {
    const small = Array.from({ length: 3000 }, (_, i) => ['X', `F${i}`]);
    const large = Array.from({ length: 3000 }, (_, i) => ['X', `G${i}`, `H${i}`]); // millions of steps, far under the budget
    let polls = 0;
    expect(() =>
      hasNonMinimal([...small, ...large], () => {
        polls++;
        throw new AssessAborted('timeout');
      }),
    ).toThrow(AssessAborted);
    expect(polls).toBe(1); // stopped at the first poll, which came long before the end
  });

  it('the check callback is polled during a long check, and its abort ends the assessment as a timeout, a cancel or too large', () => {
    const products = Array.from({ length: 9000 }, (_, i) => ({ events: [`A${i}`], probability: '0.1' }));
    const events = Array.from({ length: 9000 }, (_, i) => `A${i}`);
    const doc = mkDoc('TOP', Object.fromEntries(events.map((e) => [e, 0.1])), [OR('TOP', events)]);
    const model = asModel(doc);
    let polls = 0;
    const base = { probability: '1', limit: 1, products };
    const go = (why: 'timeout' | 'cancelled' | 'too-large') =>
      run(model, base, {
        check: () => {
          polls++;
          throw new AssessAborted(why);
        },
      });
    const t = go('timeout');
    expect(t).toMatchObject({ status: 'failed', reasons: ['timeout'] });
    expect(polls).toBeGreaterThan(0);
    expect(go('cancelled')).toMatchObject({ status: 'cancelled', reasons: ['cancelled'] });
    expect(go('too-large')).toMatchObject({ status: 'failed', reasons: ['result-too-large-to-verify'] });
  });

  it('a report with more cut sets than the cap is refused before any check, never completed', () => {
    const n = MAX_CUT_SETS + 1;
    const events = Array.from({ length: n }, (_, i) => `A${i}`);
    const doc = mkDoc('TOP', Object.fromEntries(events.map((e) => [e, 0.1])), [OR('TOP', events)]);
    const r = run(asModel(doc), { probability: '1', limit: 1, products: events.map((e) => ({ events: [e], probability: '0.1' })) });
    expect(r.status).toBe('failed');
    expect(r.reasons).toEqual(['too-many-cut-sets']);
    expect(r.minimal_cut_sets).toEqual([]);
  });
});

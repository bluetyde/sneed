import { describe, expect, it } from 'vitest';
import { crossCheck } from '../../src/engines/crosscheck.js';
import type { ResultRecord } from '../../src/core/result.js';

const rec = (over: Partial<ResultRecord> = {}, engine = 'sneed-bdd'): ResultRecord =>
  ({
    status: 'completed',
    completeness: 'complete',
    reasons: [],
    method: 'exact',
    engine: { name: engine, version: '1', sha256: null, runtime: null },
    top_event_probability: 0.19,
    approximation_value: null,
    minimal_cut_sets: [
      { events: ['P1'], probability: 0.1 },
      { events: ['P2'], probability: 0.1 },
    ],
    ...over,
  }) as ResultRecord;

describe('crossCheck', () => {
  it('two complete results with the same probability and cut sets agree, whatever the order of events and sets', () => {
    const b = rec({ minimal_cut_sets: [{ events: ['P2'], probability: 0.1 }, { events: ['P1'], probability: 0.1 }] }, 'SCRAM');
    expect(crossCheck(rec(), b)).toEqual({ engine: { name: 'SCRAM', version: '1' }, status: 'completed', agree: true, differences: [] });
    const c = crossCheck(rec({ minimal_cut_sets: [{ events: ['A', 'B'], probability: 0.01 }] }), rec({ minimal_cut_sets: [{ events: ['B', 'A'], probability: 0.01 }] }, 'SCRAM'));
    expect(c.agree).toBe(true);
  });

  it('SCRAM prints six digits: a difference below that is not a difference, one above it is', () => {
    expect(crossCheck(rec({ top_event_probability: 0.1900001 }), rec({ top_event_probability: 0.19 }, 'SCRAM')).agree).toBe(true);
    const c = crossCheck(rec({ top_event_probability: 0.19 }), rec({ top_event_probability: 0.1901 }, 'SCRAM'));
    expect(c.agree).toBe(false);
    expect(c.differences[0]).toMatch(/probability: sneed-bdd 0.19, SCRAM 0.1901/);
  });

  it('a cut set in only one engine is named', () => {
    const c = crossCheck(rec(), rec({ minimal_cut_sets: [{ events: ['P1'], probability: 0.1 }, { events: ['P3'], probability: 0.1 }] }, 'SCRAM'));
    expect(c.agree).toBe(false);
    expect(c.differences.join(' ')).toMatch(/only in sneed-bdd: \{P2\}/);
    expect(c.differences.join(' ')).toMatch(/only in SCRAM: \{P3\}/);
  });

  it('a result that is not complete on either side is never "agreement"', () => {
    const truncated = rec({ status: 'truncated', completeness: 'truncated', reasons: ['product-order-limit-effective'] }, 'SCRAM');
    const c = crossCheck(rec(), truncated);
    expect(c.agree).toBe(false);
    expect(c.status).toBe('truncated');
    expect(c.differences[0]).toMatch(/SCRAM did not produce a complete result \(truncated: product-order-limit-effective\)/);
    expect(crossCheck(rec({ status: 'failed', completeness: 'unknown' }), rec({}, 'SCRAM')).agree).toBe(false);
  });

  it('different methods are called out rather than compared', () => {
    const c = crossCheck(rec(), rec({ method: 'mcub', top_event_probability: 0.5 }, 'SCRAM'));
    expect(c.agree).toBe(false);
    expect(c.differences[0]).toMatch(/different methods/);
    expect(c.differences.length).toBe(1);
  });

  it('approximation values are compared when both have one', () => {
    const a = rec({ method: 'rare-event', approximation_value: 0.03 });
    expect(crossCheck(a, rec({ method: 'rare-event', approximation_value: 0.03 }, 'SCRAM')).agree).toBe(true);
    expect(crossCheck(a, rec({ method: 'rare-event', approximation_value: 0.04 }, 'SCRAM')).differences.join(' ')).toMatch(/rare-event value/);
  });

  it('a long list of differing cut sets is shortened, not dumped', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ events: [`X${i}`], probability: 0.1 }));
    const c = crossCheck(rec({ minimal_cut_sets: many }), rec({ minimal_cut_sets: [] }, 'SCRAM'));
    expect(c.differences.join(' ')).toMatch(/and 15 more/);
  });
});

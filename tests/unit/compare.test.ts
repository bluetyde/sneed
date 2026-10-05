import { describe, expect, it } from 'vitest';
import { diffModels, diffResults, readDoc } from '../../src/core/compare.js';
import { enumerate } from '../oracle/enumerate.js';
import { OR, mkDoc, ORACLE_MODELS, type Doc } from '../oracle/models.js';

/** A results record shaped like the real one, with numbers from the independent enumerator (not from the engine). */
function record(doc: Doc, over: Record<string, unknown> = {}): Record<string, unknown> {
  const r = enumerate(doc);
  return {
    schema_version: 1,
    status: 'completed',
    completeness: 'complete',
    method: 'exact',
    assumptions: { independence: 'declared-independent' },
    engine: { name: 'SCRAM', version: '0.16.2' },
    input_hashes: { model_hash: JSON.stringify(doc.events) + JSON.stringify(doc.gates) },
    top_event_probability: r.probability.toNumber(),
    minimal_cut_sets: r.cutSets.map((c) => ({ events: c, probability: c.reduce((p, id) => p * doc.events.find((e) => e.id === id)!.probability, 1) })),
    ...over,
  };
}

describe('diffModels', () => {
  const AND2 = ORACLE_MODELS['pra-pump2-and']!;
  const OR2 = ORACLE_MODELS['pra-pump2-or']!;

  it('names the gate type that changed and nothing else (AND to OR on the same events)', () => {
    const d = diffModels(AND2, OR2)!;
    expect(d.identical).toBe(false);
    expect(d.top).toBeNull();
    expect(d.events).toEqual({ added: [], removed: [], changed: [] });
    expect(d.gates.changed).toEqual([{ id: 'TOP', type: { from: 'and', to: 'or' }, threshold: null, inputs: null }]);
  });

  it('a model compared with itself is identical', () => {
    for (const doc of Object.values(ORACLE_MODELS)) expect(diffModels(doc, JSON.parse(JSON.stringify(doc)))!.identical).toBe(true);
  });

  it('shared versus separate supply: events and gates added and removed are listed by id', () => {
    const d = diffModels(ORACLE_MODELS['pra-pump3-shared']!, ORACLE_MODELS['pra-pump3-separate']!)!;
    expect(d.events.added).toEqual(['S1', 'S2']);
    expect(d.events.removed).toEqual(['S']);
    expect(d.gates.added.sort()).toEqual(['L', 'R']);
    expect(d.gates.removed).toEqual(['PUMPS']);
    expect(d.top).toBeNull();
    expect(d.identical).toBe(false);
  });

  it('a probability change is reported with both values', () => {
    const b = JSON.parse(JSON.stringify(AND2)) as Doc;
    b.events[0]!.probability = 0.5;
    const d = diffModels(AND2, b)!;
    expect(d.events.changed).toEqual([{ id: 'P1', probability: { from: 0.1, to: 0.5 }, name: null }]);
    expect(d.identical).toBe(false);
  });

  it('a name-only change is listed but does not make the models differ in logic', () => {
    const b = JSON.parse(JSON.stringify(AND2)) as Doc;
    (b.events[0] as Record<string, unknown>).name = 'Pump one';
    const d = diffModels(AND2, b)!;
    expect(d.events.changed).toEqual([{ id: 'P1', probability: null, name: { from: null, to: 'Pump one' } }]);
    expect(d.identical).toBe(true);
  });

  it('input order is not a difference, but a repeated input is', () => {
    const a = mkDoc('T', { A: 0.1, B: 0.1 }, [OR('T', ['A', 'B'])]);
    const reordered = mkDoc('T', { A: 0.1, B: 0.1 }, [OR('T', ['B', 'A'])]);
    const repeated = mkDoc('T', { A: 0.1, B: 0.1 }, [OR('T', ['A', 'B', 'A'])]);
    expect(diffModels(a, reordered)!.identical).toBe(true);
    expect(diffModels(a, repeated)!.gates.changed[0]!.inputs).toEqual({ from: ['A', 'B'], to: ['A', 'B', 'A'] });
  });

  it('a changed top event and a changed vote threshold are reported', () => {
    const a = mkDoc('T', { A: 0.1, B: 0.1, C: 0.1 }, [{ id: 'T', type: 'atleast', inputs: ['A', 'B', 'C'], threshold: 2 }]);
    const b = mkDoc('T', { A: 0.1, B: 0.1, C: 0.1 }, [{ id: 'T', type: 'atleast', inputs: ['A', 'B', 'C'], threshold: 3 }]);
    expect(diffModels(a, b)!.gates.changed[0]!.threshold).toEqual({ from: 2, to: 3 });
    const c = { ...a, top: 'A' };
    expect(diffModels(a, c)!.top).toEqual({ from: 'T', to: 'A' });
  });

  it('refuses data that is not a model, and never throws on hostile shapes', () => {
    for (const bad of [null, 7, 'x', [], {}, { events: 1, gates: [] }, { events: [null], gates: [] }, { events: [], gates: [{ id: 'G', type: 'or', inputs: [{ toString: 0 }] }] }, { events: [{ id: 5 }], gates: [] }]) {
      expect(readDoc(bad)).toBeNull();
      expect(diffModels(bad, AND2)).toBeNull();
      expect(diffModels(AND2, bad)).toBeNull();
    }
  });

  it('ids that look like object keys are plain data', () => {
    const a = { events: [{ id: '__proto__', probability: 0.1 }], gates: [], top: '__proto__' };
    const b = { events: [{ id: 'constructor', probability: 0.1 }], gates: [], top: 'constructor' };
    const d = diffModels(a, b)!;
    expect(d.events.added).toEqual(['constructor']);
    expect(d.events.removed).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });
});

describe('diffResults', () => {
  const AND2 = ORACLE_MODELS['pra-pump2-and']!;
  const OR2 = ORACLE_MODELS['pra-pump2-or']!;

  it('AND then OR: 0.01 then 0.19, cut sets replaced, and no judgement in the data', () => {
    const d = diffResults(record(AND2), record(OR2))!;
    expect(d.probability.from).toBeCloseTo(0.01, 12);
    expect(d.probability.to).toBeCloseTo(0.19, 12);
    expect(d.probability.delta).toBeCloseTo(0.18, 12);
    expect(d.probability.ratio).toBeCloseTo(19, 9);
    expect(d.cutSets.removed.map((c) => c.events)).toEqual([['P1', 'P2']]);
    expect(d.cutSets.added.map((c) => c.events)).toEqual([['P1'], ['P2']]);
    expect(d.cutSets.changed).toEqual([]);
    expect(d.sameModel).toBe(false);
    expect(Object.keys(d).join()).not.toMatch(/better|worse|improv|safe/i);
  });

  it('the same record twice: nothing differs, every cut set is unchanged', () => {
    const d = diffResults(record(OR2), record(OR2))!;
    expect(d.probability.delta).toBe(0);
    expect(d.cutSets).toMatchObject({ added: [], removed: [], changed: [], unchanged: 2 });
    expect(d.status).toBeNull();
    expect(d.sameInputs).toBe(true);
  });

  it('same cut sets with a different probability are "changed", not removed and added', () => {
    const b = JSON.parse(JSON.stringify(AND2)) as Doc;
    b.events[0]!.probability = 0.5;
    const d = diffResults(record(AND2, { input_hashes: { model_hash: 'x' } }), record(b, { input_hashes: { model_hash: 'y' } }))!;
    expect(d.cutSets.changed).toHaveLength(1);
    expect(d.cutSets.changed[0]!.probability.from).toBeCloseTo(0.01, 12);
    expect(d.cutSets.changed[0]!.probability.to).toBeCloseTo(0.05, 12);
    expect(d.cutSets.added).toEqual([]);
    expect(d.cutSets.removed).toEqual([]);
  });

  it('cut-set identity ignores the order of events inside a set', () => {
    const a = { ...record(AND2), minimal_cut_sets: [{ events: ['P1', 'P2'], probability: 0.01 }] };
    const b = { ...record(AND2), minimal_cut_sets: [{ events: ['P2', 'P1'], probability: 0.01 }] };
    expect(diffResults(a, b)!.cutSets.unchanged).toBe(1);
  });

  it('flags a difference between runs that had the same model, method and engine', () => {
    const a = record(OR2);
    const b = record(OR2, { top_event_probability: 0.2 });
    const d = diffResults(a, b)!;
    expect(d.sameModel).toBe(true);
    expect(d.sameInputs).toBe(true);
    expect(d.probability.delta).toBeCloseTo(0.01, 12);
  });

  it('a different method or engine means the inputs are not the same', () => {
    expect(diffResults(record(OR2), record(OR2, { method: 'mcub' }))!.sameInputs).toBe(false);
    expect(diffResults(record(OR2), record(OR2, { engine: { name: 'SCRAM', version: '0.17.0' } }))!.engine).toEqual({ from: 'SCRAM 0.16.2', to: 'SCRAM 0.17.0' });
  });

  it('status, completeness and assumptions that differ are listed', () => {
    const d = diffResults(record(OR2), record(OR2, { status: 'truncated', completeness: 'partial', assumptions: { independence: 'x', time: 'none' } }))!;
    expect(d.status).toEqual({ from: 'completed', to: 'truncated' });
    expect(d.completeness).toEqual({ from: 'complete', to: 'partial' });
    expect(d.assumptions).toEqual([
      { key: 'independence', from: 'declared-independent', to: 'x' },
      { key: 'time', from: null, to: 'none' },
    ]);
  });

  it('a missing probability gives no delta, a zero earlier value gives no ratio', () => {
    expect(diffResults(record(OR2), record(OR2, { top_event_probability: null }))!.probability).toEqual({ from: expect.any(Number), to: null, delta: null, ratio: null });
    const z = diffResults(record(OR2, { top_event_probability: 0 }), record(OR2))!;
    expect(z.probability.ratio).toBeNull();
    expect(z.probability.delta).toBeCloseTo(0.19, 12);
  });

  it('refuses non-objects and survives hostile content', () => {
    expect(diffResults(null, record(OR2))).toBeNull();
    expect(diffResults(record(OR2), [])).toBeNull();
    const hostile = { minimal_cut_sets: [null, 3, { events: 'x', probability: 1 }, { events: [1], probability: 1 }, { events: ['A'], probability: Number.NaN }], assumptions: 5, engine: 7, input_hashes: [], top_event_probability: 'x' };
    const d = diffResults(hostile, hostile)!;
    expect(d.cutSets.unchanged).toBe(0);
    expect(d.probability.delta).toBeNull();
    expect(d.sameModel).toBe(false);
  });
});

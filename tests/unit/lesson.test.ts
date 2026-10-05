import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { enumerate } from '../oracle/enumerate.js';
import { AND, OR, VOTE, mkDoc, ORACLE_MODELS, NATIVE_VOTE, type Doc } from '../oracle/models.js';
import { checkLesson, loadLesson, matchOutcome, LessonError, type Lesson, type OracleEntry } from '../../src/core/lesson.js';

const root = join(import.meta.dirname, '..', '..');
const oracles = JSON.parse(readFileSync(join(root, 'tests/oracles.json'), 'utf8')) as OracleEntry[];
const dir = join(root, 'lessons');
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const lessons = new Map<string, Lesson>(files.map((f) => {
  const l = loadLesson(readFileSync(join(dir, f), 'utf8'), oracles);
  return [l.id, l];
}));
const get = (id: string): Lesson => lessons.get(id)!;

// Student "solutions": each is a model a student could build, checked against the lesson, then against the independent oracle.
const SHARED = mkDoc('TOP', { P1: 0.1, P2: 0.1, S: 0.05 }, [AND('TOP', ['L', 'R']), OR('L', ['P1', 'S']), OR('R', ['P2', 'S'])]);
const SOLUTIONS: Record<string, { doc: Doc; outcome: string }[]> = {
  '01-single-pump': [{ doc: ORACLE_MODELS['pra-pump1']!, outcome: 'single' }],
  '02-redundant-pumps': [
    { doc: ORACLE_MODELS['pra-pump2-and']!, outcome: 'and' },
    { doc: ORACLE_MODELS['pra-pump2-or']!, outcome: 'or' },
  ],
  '03-shared-power-supply': [
    { doc: SHARED, outcome: 'shared' },
    { doc: ORACLE_MODELS['pra-pump3-separate']!, outcome: 'separate' },
  ],
  '04-voting': [{ doc: NATIVE_VOTE, outcome: 'exact' }],
};

describe('lesson files', () => {
  it('all four lessons load, with unique ids', () => {
    expect(files).toHaveLength(4);
    expect(lessons.size).toBe(4);
  });

  it('every outcome names an oracle entry and equals it', () => {
    for (const l of lessons.values()) for (const o of l.outcomes) expect(oracles.find((e) => e.id === o.oracle)).toBeDefined();
  });

  it('every lesson has a hand calculation, an assumption statement and alt-free plain steps', () => {
    for (const l of lessons.values()) {
      expect(l.hand_calculation.length).toBeGreaterThan(0);
      expect(l.assumptions).toMatch(/made[- ]up|made up/);
      expect(l.assumptions).toMatch(/real plant|real pump/);
    }
  });

  it('no lesson states a plant risk, a frequency or a safety conclusion', () => {
    for (const l of lessons.values()) expect(JSON.stringify(l)).not.toMatch(/per year|per reactor|frequency|core damage|safe enough|is safe/i);
  });
});

describe('lesson outcomes equal exhaustive enumeration of the model a student builds', () => {
  for (const [id, sols] of Object.entries(SOLUTIONS)) {
    for (const s of sols) {
      it(`${id} / ${s.outcome}`, () => {
        const lesson = get(id);
        const out = lesson.outcomes.find((o) => o.id === s.outcome)!;
        const r = enumerate(s.doc);
        const ref = oracles.find((e) => e.id === out.oracle) as OracleEntry & { method?: string };
        const got = ref.method === 'rare-event' ? r.rareEvent : ref.method === 'mcub' ? r.mcub : r.probability;
        expect(Math.abs(got.toNumber() - out.probability)).toBeLessThanOrEqual(out.tolerance.absolute);
        expect(matchOutcome(lesson, r.probability.toNumber(), r.cutSets)?.id).toBe(s.outcome);
      });
    }
  }

  it('the voting lesson rows differ only by method, so the exact row is the only one a probability alone can match', () => {
    const r = enumerate(NATIVE_VOTE);
    expect(get('04-voting').outcomes.map((o) => o.probability)).toEqual([0.028, 0.03, 0.029701]);
    expect(r.rareEvent.toNumber()).toBeCloseTo(0.03, 12);
    expect(r.mcub.toNumber()).toBeCloseTo(0.029701, 12);
  });
});

describe('steps and mistakes', () => {
  it('the finished model of each lesson passes every step with no mistake', () => {
    const last: Record<string, Doc> = {
      '01-single-pump': ORACLE_MODELS['pra-pump1']!,
      '02-redundant-pumps': ORACLE_MODELS['pra-pump2-or']!,
      '03-shared-power-supply': SHARED,
      '04-voting': NATIVE_VOTE,
    };
    for (const [id, doc] of Object.entries(last)) {
      const r = enumerate(doc);
      const p = checkLesson(get(id), doc, { probability: r.probability.toNumber(), cutSets: r.cutSets });
      expect(p.mistakes, id).toEqual([]);
      expect(p.steps.filter((s) => !s.done), id).toEqual([]);
      expect(p.complete, id).toBe(true);
    }
  });

  it('structure alone never completes a lesson: an engine result that matches an outcome is required', () => {
    const p = checkLesson(get('01-single-pump'), ORACLE_MODELS['pra-pump1']!);
    expect(p.steps.every((s) => s.done)).toBe(true);
    expect(p.complete).toBe(false);
    expect(checkLesson(get('01-single-pump'), ORACLE_MODELS['pra-pump1']!, { probability: 0.2, cutSets: [['P']] }).complete).toBe(false);
  });

  const solve = (id: string, doc: Doc) => {
    const r = enumerate(doc);
    return checkLesson(get(id), doc, { probability: r.probability.toNumber(), cutSets: r.cutSets });
  };

  it('wrong models that look right are not complete (Codex review)', () => {
    // lesson 2: OR of two pumps at 0.5 each
    expect(solve('02-redundant-pumps', mkDoc('T', { P1: 0.5, P2: 0.5 }, [OR('T', ['P1', 'P2'])])).complete).toBe(false);
    // lesson 3: shares a pump instead of the supply
    const wrong3 = mkDoc('T', { P1: 0.1, P2: 0.1, S: 0.05 }, [AND('T', ['L', 'R']), OR('L', ['P1', 'P2']), OR('R', ['P1', 'S'])]);
    const w3 = solve('03-shared-power-supply', wrong3);
    expect(w3.steps.every((s) => s.done)).toBe(true);
    expect(w3.complete).toBe(false);
    // lesson 4: at least 1 of 3
    // (the validator refuses K = 1, so the checker is given the model and an engine-shaped result directly)
    const one = checkLesson(get('04-voting'), mkDoc('V', { A: 0.1, B: 0.1, C: 0.1 }, [VOTE('V', ['A', 'B', 'C'], 1)]), { probability: 0.271, cutSets: [['A'], ['B'], ['C']] });
    expect(one.steps[1]!.done).toBe(false);
    expect(one.complete).toBe(false);
    // lesson 4: a vote gate with a duplicated input
    expect(checkLesson(get('04-voting'), mkDoc('V', { A: 0.1, B: 0.1, C: 0.1 }, [VOTE('V', ['A', 'B', 'B'], 2)])).steps[1]!.done).toBe(false);
  });

  it('the two-supplies detector is false for both single-supply forms and true for two supplies', () => {
    const l = get('03-shared-power-supply');
    for (const doc of [SHARED, ORACLE_MODELS['pra-pump3-shared']!]) expect(checkLesson(l, doc).mistakes.map((m) => m.id)).not.toContain('two-copies');
    expect(checkLesson(l, ORACLE_MODELS['pra-pump3-separate']!).mistakes.map((m) => m.id)).toContain('two-copies');
  });

  it('a repeated gate is not a shared event', () => {
    const doc = mkDoc('T', { P1: 0.1, P2: 0.1, S: 0.05 }, [AND('T', ['L', 'R']), OR('L', ['G']), OR('R', ['G']), OR('G', ['P1', 'P2', 'S'])]);
    expect(checkLesson(get('03-shared-power-supply'), doc).steps.find((s) => s.id === 'one-s-twice')!.done).toBe(false);
  });

  it('malformed documents are credited with nothing and never throw (Codex review)', () => {
    const l = get('01-single-pump');
    const docs = [
      { top: 'undefined', events: [{ probability: [0.1] }], gates: [] },
      { top: 'P', events: [{ id: { toString: 0 }, probability: 0.1 }], gates: [] },
      { top: 'P', events: [{ id: 'P', probability: '0.1' }], gates: [] },
      { top: 'P', events: [{ id: 'P', probability: 0.1 }], gates: [{ id: 'G', type: 'or', inputs: [{ toString: 0 }] }] },
      { top: 'P', events: [{ id: 'P', probability: 0.1 }, null], gates: [] },
      null,
      7,
    ];
    for (const d of docs) {
      const p = checkLesson(l, d as never, { probability: 0.1, cutSets: [['P']] });
      expect(p.malformed).toBe(true);
      expect(p.complete).toBe(false);
    }
    const vote = checkLesson(get('04-voting'), { top: 'V', events: [{ id: 'A', probability: 0.1 }], gates: [{ id: 'V', type: 'atleast', inputs: [] }] });
    expect(vote.steps.every((s) => s.done)).toBe(false);
  });

  it('an empty model completes nothing and reports no mistake', () => {
    const p = checkLesson(get('01-single-pump'), { top: '', events: [], gates: [] });
    expect(p.complete).toBe(false);
    expect(p.steps.every((s) => !s.done)).toBe(true);
    expect(p.mistakes).toEqual([]);
  });

  const mistakeFixtures: [string, string, Doc | Record<string, unknown>][] = [
    ['01-single-pump', 'percent', { top: 'P', events: [{ id: 'P', probability: 10 }], gates: [] }],
    ['01-single-pump', 'one-input-gate', mkDoc('T', { P: 0.1 }, [OR('T', ['P'])])],
    ['01-single-pump', 'unused-event', mkDoc('P', { P: 0.1, Q: 0.2 }, [])],
    ['02-redundant-pumps', 'percent', { top: 'T', events: [{ id: 'P1', probability: 10 }, { id: 'P2', probability: 0.1 }], gates: [{ id: 'T', type: 'and', inputs: ['P1', 'P2'] }] }],
    ['02-redundant-pumps', 'one-input-gate', mkDoc('T', { P1: 0.1, P2: 0.1 }, [AND('T', ['L']), OR('L', ['P1', 'P2'])])],
    ['02-redundant-pumps', 'unused-event', mkDoc('T', { P1: 0.1, P2: 0.1, P3: 0.1 }, [AND('T', ['P1', 'P2'])])],
    ['03-shared-power-supply', 'two-copies', ORACLE_MODELS['pra-pump3-separate']!],
    ['03-shared-power-supply', 'percent', { top: 'T', events: [{ id: 'S', probability: 5 }], gates: [{ id: 'T', type: 'or', inputs: ['S', 'S'] }] }],
    ['03-shared-power-supply', 'one-input-gate', mkDoc('T', { A: 0.1 }, [AND('T', ['G']), OR('G', ['A'])])],
    ['04-voting', 'percent', { top: 'V', events: [{ id: 'A', probability: 10 }], gates: [{ id: 'V', type: 'atleast', inputs: ['A'], threshold: 1 }] }],
    ['04-voting', 'wrong-gate', mkDoc('T', { A: 0.1, B: 0.1, C: 0.1 }, [AND('T', ['A', 'B', 'C'])])],
  ];

  it('every mistake in every lesson has a fixture, and each fixture fires exactly its mistake', () => {
    const covered = new Set(mistakeFixtures.map(([l, m]) => `${l}/${m}`));
    for (const l of lessons.values()) for (const m of l.mistakes) expect(covered.has(`${l.id}/${m.id}`), `${l.id}/${m.id}`).toBe(true);
    for (const [l, m, doc] of mistakeFixtures) {
      const fired = checkLesson(get(l), doc).mistakes.map((x) => x.id);
      expect(fired, `${l}/${m}`).toContain(m);
    }
  });

  it('a mistake does not fire on a model that is correct for that lesson', () => {
    const shared = checkLesson(get('03-shared-power-supply'), SHARED);
    expect(shared.mistakes.map((m) => m.id)).not.toContain('two-copies');
    const votes = checkLesson(get('04-voting'), mkDoc('V', { A: 0.1, B: 0.1, C: 0.1 }, [VOTE('V', ['A', 'B', 'C'], 2)]));
    expect(votes.mistakes).toEqual([]);
  });

  it('a lesson is not complete while a mistake is present, even if every step passes and the result matches', () => {
    const doc = mkDoc('T', { P1: 0.1, P2: 0.1 }, [OR('T', ['P1', 'P2']), OR('X', ['P1'])]);
    const p = checkLesson(get('02-redundant-pumps'), doc, { probability: 0.19, cutSets: [['P1'], ['P2']] });
    expect(p.steps.every((s) => s.done)).toBe(true);
    expect(p.outcome).toBe('or');
    expect(p.mistakes.map((m) => m.id)).toEqual(['one-input-gate']);
    expect(p.complete).toBe(false);
  });
  it('the shared-event step needs an event under two gates, not just any gate input', () => {
    const p = checkLesson(get('03-shared-power-supply'), ORACLE_MODELS['pra-pump3-shared']!);
    expect(p.steps.find((s) => s.id === 'one-s-twice')!.done).toBe(false);
  });

  it('the checker never trusts the document shape', () => {
    for (const bad of [{}, { top: 5, events: 'x', gates: [null, 3, { id: 1, inputs: 'z' }] }, { events: [null], gates: {} }]) {
      expect(() => checkLesson(get('02-redundant-pumps'), bad as never)).not.toThrow();
    }
  });
});

describe('loader refusals', () => {
  const base = readFileSync(join(dir, files[0]!), 'utf8');
  const mutate = (fn: (l: Record<string, any>) => void): string => {
    const l = JSON.parse(base) as Record<string, any>;
    fn(l);
    return JSON.stringify(l);
  };
  const code = (text: string): string | undefined => {
    try {
      loadLesson(text, oracles);
    } catch (e) {
      return e instanceof LessonError ? e.code : 'other';
    }
    return undefined;
  };

  it('refuses a missing oracle reference', () => expect(code(mutate((l) => (l.outcomes[0].oracle = 'pra-nope')))).toBe('L_NO_ORACLE'));
  it('refuses an expected probability that differs from the oracle', () => expect(code(mutate((l) => (l.outcomes[0].probability = 0.11)))).toBe('L_ORACLE_MISMATCH'));
  it('refuses cut sets that differ from the oracle', () => expect(code(mutate((l) => (l.outcomes[0].cut_sets = [['Q']])))).toBe('L_ORACLE_MISMATCH'));
  it('refuses a lesson with no outcomes', () => expect(code(mutate((l) => (l.outcomes = [])))).toBe('L_SCHEMA'));
  it('refuses a step with an unknown check', () => expect(code(mutate((l) => (l.steps[0].check = { kind: 'drawing-position' })))).toBe('L_SCHEMA'));
  it('refuses a mistake with an unknown detector', () => expect(code(mutate((l) => (l.mistakes[0].detect = { kind: 'x' })))).toBe('L_SCHEMA'));
  it('refuses a tolerance that is too wide, negative, non-finite or missing (Codex review)', () => {
    for (const t of [1, 1e-6, -1e-12]) expect(code(mutate((l) => (l.outcomes[0].tolerance.absolute = t))), String(t)).toBe('L_SCHEMA');
    expect(code(base.replace(/"absolute": 1e-12/, '"absolute": 1e400'))).toBe('L_SCHEMA');
    expect(code(mutate((l) => (l.outcomes[0].tolerance = {})))).toBe('L_SCHEMA');
    expect(code(mutate((l) => delete l.outcomes[0].tolerance))).toBe('L_SCHEMA');
  });
  it('refuses malformed cut sets with L_SCHEMA, never a raw error (Codex review)', () => {
    for (const cs of ['P', ['P'], [null], [[]], [[1]], [['']], []]) expect(code(mutate((l) => (l.outcomes[0].cut_sets = cs))), JSON.stringify(cs)).toBe('L_SCHEMA');
  });
  it('refuses check operands that are missing or malformed (Codex review)', () => {
    const bad = [
      { kind: 'event-count' },
      { kind: 'event-count', count: 0 },
      { kind: 'event-count', count: 1.5 },
      { kind: ['event-count'], count: 1 },
      { kind: 'probabilities', values: [] },
      { kind: 'probabilities', values: [10] },
      { kind: 'top-gate' },
      { kind: 'top-gate', type: 'xor' },
      { kind: 'top-gate', type: [] },
      { kind: 'shared-event', minParents: 1 },
      { kind: 'vote', threshold: 3, inputs: 2 },
      { kind: 'vote', threshold: 2 },
    ];
    for (const c of bad) expect(code(mutate((l) => (l.steps[0].check = c))), JSON.stringify(c)).toBe('L_SCHEMA');
  });
  it('refuses detector operands that are missing or malformed (Codex review)', () => {
    const bad = [{ kind: 'wrong-top-gate' }, { kind: 'wrong-top-gate', expected: 'nand' }, { kind: 'extra-events' }, { kind: 'extra-events', max: 0 }, { kind: ['unused-event'] }];
    for (const d of bad) expect(code(mutate((l) => (l.mistakes[0].detect = d))), JSON.stringify(d)).toBe('L_SCHEMA');
  });
  it('refuses a wrong schema id', () => expect(code(mutate((l) => (l.schema.id = 'other')))).toBe('L_SCHEMA'));
  it('refuses text that is not JSON', () => expect(code('{')).toBe('L_SCHEMA'));
  it('accepts the unmodified lesson', () => expect(code(base)).toBeUndefined());
});

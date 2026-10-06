import { describe, expect, it } from 'vitest';
import { enumeratePaths, eventTreeHash, MAX_HEADINGS, MAX_SEQUENCES, pathKey, skeletonSequences, validateEventTree, validateEventTreeText, type EtContext, type ModelRef, type PathStep } from '../../src/core/event-tree.js';
import { modelHash } from '../../src/core/canonical.js';
import { AND, mkDoc, OR, rng } from '../oracle/models.js';
import type { NativeModel } from '../../src/core/model.js';

type Doc = Record<string, any>;

// ---------------------------------------------------------------- fixtures: the reference cases of plan 13

/** Plan 13, 6.2: S 0.1, a 0.2, b 0.3; X = S OR a, Y = S OR b; a top gate over both so that every gate is attached. */
const SHARED = mkDoc('TOP', { S: 0.1, a: 0.2, b: 0.3 }, [OR('TOP', ['X', 'Y']), OR('X', ['S', 'a']), OR('Y', ['S', 'b'])]);
/** Plan 13, 6.1: two independent headings, each a basic event. */
const INDEPENDENT = mkDoc('TOP', { A_FAILS: 0.01, B_FAILS: 0.1 }, [OR('TOP', ['A_FAILS', 'B_FAILS'])]);

const ref = (m: ReturnType<typeof mkDoc>): ModelRef => ({ hash: modelHash(m as unknown as NativeModel), events: new Set(m.events.map((e) => e.id)), gates: new Set(m.gates.map((g) => g.id)) });
const ctxFor = (models: Record<string, ReturnType<typeof mkDoc>>): EtContext => ({ resolveModel: (n) => (models[n] ? ref(models[n]!) : null) });
const CTX = ctxFor({ shared: SHARED, independent: INDEPENDENT });

const ASSUMPTIONS = { frequency_unit: 'per-year', probability_basis: 'per-demand', independence: 'declared-independent', ie_independent_of_events: true, success_branches: 'exact' };
const END = [
  { id: 'SAFE', name: 'Safe (example)', description: 'Both functions worked (example).', synthetic: true },
  { id: 'DEGRADED', name: 'Degraded (example)', description: 'One function failed (example).', synthetic: true },
  { id: 'LOSS', name: 'Loss of cooling (example)', description: 'Both functions failed (example).', synthetic: true },
];

function tree(model: 'shared' | 'independent', headings: Doc[], endOf: (path: PathStep[]) => string, frequency = 0.5): Doc {
  const m = model === 'shared' ? SHARED : INDEPENDENT;
  return {
    schema: { id: 'sneed.event-tree', version: 1 },
    tree: { id: 'et1', name: 'Test tree', created: '2026-10-06T00:00:00Z', updated: '2026-10-06T00:00:00Z' },
    fault_tree_model: { name: model, model_hash: ref(m).hash },
    initiating_event: { name: 'Transient (example)', description: 'An example initiating event.', frequency, unit: 'per-year' },
    headings,
    end_states: END.map((e) => ({ ...e })),
    sequences: skeletonSequences(headings as never).map((s) => ({ path: s.path, end_state: endOf(s.path) })),
    assumptions: { ...ASSUMPTIONS },
  };
}
const failures = (p: PathStep[]): number => p.filter((s) => s.branch === 'fails').length;
const endByFailures = (p: PathStep[]): string => (failures(p) === 0 ? 'SAFE' : failures(p) === 1 ? 'DEGRADED' : 'LOSS');

/** 6.2: two headings on the shared model. */
const sharedDoc = (): Doc => tree('shared', [{ id: 'A', name: 'Function A', event: 'X' }, { id: 'B', name: 'Function B', event: 'Y' }], endByFailures);
/** 6.1: independent headings. */
const independentDoc = (): Doc => tree('independent', [{ id: 'A', name: 'Injection', event: 'A_FAILS' }, { id: 'B', name: 'Cooling', event: 'B_FAILS' }], endByFailures, 0.1);
/** 6.4: B is asked only if A works. */
const bypassDoc = (): Doc => tree('shared', [{ id: 'A', name: 'Function A', event: 'X' }, { id: 'B', name: 'Function B', event: 'Y', asked_only_if: { heading: 'A', branch: 'works' } }], endByFailures);

const codes = (d: unknown, ctx: EtContext = CTX): string[] => validateEventTree(d, ctx).errors.map((e) => e.code);
const clone = (d: Doc): Doc => JSON.parse(JSON.stringify(d));

describe('the reference cases of plan 13 are valid documents with the sequences the plan lists', () => {
  it('6.1 independent headings: four sequences, 0.1 per year', () => {
    const d = independentDoc();
    expect(validateEventTree(d, CTX)).toMatchObject({ valid: true, errors: [], modelChecked: true });
    expect(d.sequences.map((s: Doc) => pathKey(s.path))).toEqual(['A:works,B:works', 'A:works,B:fails', 'A:fails,B:works', 'A:fails,B:fails']);
    expect(d.sequences.map((s: Doc) => s.end_state)).toEqual(['SAFE', 'DEGRADED', 'DEGRADED', 'LOSS']);
  });

  it('6.2 a shared event: the same four paths on the shared model', () => {
    expect(validateEventTree(sharedDoc(), CTX).valid).toBe(true);
  });

  it('6.4 bypass: B is not asked after A fails, so three sequences', () => {
    const d = bypassDoc();
    expect(validateEventTree(d, CTX).valid).toBe(true);
    expect(d.sequences.map((s: Doc) => pathKey(s.path))).toEqual(['A:works,B:works', 'A:works,B:fails', 'A:fails']);
  });

  it('is checked on its own when no model resolver is given (modelChecked says so), with no model errors', () => {
    const r = validateEventTree(sharedDoc());
    expect(r).toMatchObject({ valid: true, modelChecked: false });
  });
});

describe('the paths the headings allow', () => {
  const H = (id: string, cond?: [string, 'works' | 'fails']): { id: string; asked_only_if?: { heading: string; branch: 'works' | 'fails' } } => ({ id, ...(cond ? { asked_only_if: { heading: cond[0], branch: cond[1] } } : {}) });

  it('n unconditional headings give 2^n paths in order', () => {
    for (let n = 1; n <= 8; n++) {
      const heads = Array.from({ length: n }, (_, i) => H(`H${i}`));
      const paths = enumeratePaths(heads);
      expect(paths).toHaveLength(2 ** n);
      expect(new Set(paths.map(pathKey)).size).toBe(2 ** n);
    }
    expect(enumeratePaths([H('A'), H('B')]).map(pathKey)).toEqual(['A:works,B:works', 'A:works,B:fails', 'A:fails,B:works', 'A:fails,B:fails']);
  });

  it('a chain "asked only if the previous works" gives n + 1 paths', () => {
    for (let n = 1; n <= 8; n++) {
      const heads = Array.from({ length: n }, (_, i) => (i === 0 ? H('H0') : H(`H${i}`, [`H${i - 1}`, 'works'])));
      expect(enumeratePaths(heads)).toHaveLength(n + 1);
    }
  });

  it('a heading that depends on a heading that was not asked is not asked either', () => {
    // B only if A fails, C only if B fails: A works (1) | A fails, B works (1) | A fails, B fails, C works/fails (2)
    const paths = enumeratePaths([H('A'), H('B', ['A', 'fails']), H('C', ['B', 'fails'])]);
    expect(paths.map(pathKey)).toEqual(['A:works', 'A:fails,B:works', 'A:fails,B:fails,C:works', 'A:fails,B:fails,C:fails']);
  });

  it('every path partitions: the paths are distinct and each is a prefix-free choice (no path extends another)', () => {
    const paths = enumeratePaths([H('A'), H('B', ['A', 'works']), H('C', ['A', 'fails']), H('D')]).map(pathKey);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) for (const o of paths) if (p !== o) expect(o.startsWith(p + ','), `${p} prefixes ${o}`).toBe(false);
  });

  it('a condition on an unknown or later heading is never satisfied, and more than the heading limit gives nothing', () => {
    expect(enumeratePaths([H('A', ['Z', 'works']), H('B')]).map(pathKey)).toEqual(['B:works', 'B:fails']);
    expect(enumeratePaths([H('A', ['B', 'works']), H('B')]).map(pathKey)).toEqual(['B:works', 'B:fails']);
    expect(enumeratePaths(Array.from({ length: MAX_HEADINGS + 1 }, (_, i) => H(`H${i}`)))).toEqual([]);
    expect(enumeratePaths(Array.from({ length: MAX_HEADINGS }, (_, i) => H(`H${i}`)))).toHaveLength(MAX_SEQUENCES);
  });
});

describe('each rule, broken on its own, is refused with its code and its place', () => {
  const cases: [string, (d: Doc) => void, string, string?][] = [
    ['no frequency', (d) => delete d.initiating_event.frequency, 'E_NO_FREQUENCY', '/initiating_event/frequency'],
    ['a negative frequency', (d) => (d.initiating_event.frequency = -1), 'E_FREQUENCY_RANGE', '/initiating_event/frequency'],
    ['a frequency that is text', (d) => (d.initiating_event.frequency = '0.5'), 'E_FREQUENCY_RANGE'],
    ['no unit', (d) => delete d.initiating_event.unit, 'E_NO_UNIT', '/initiating_event/unit'],
    ['an unknown unit', (d) => (d.initiating_event.unit = 'per-hour'), 'E_NO_UNIT', '/initiating_event/unit'],
    ['no model reference', (d) => delete d.fault_tree_model, 'E_NO_MODEL', '/fault_tree_model'],
    ['a model reference without a hash', (d) => delete d.fault_tree_model.model_hash, 'E_NO_MODEL', '/fault_tree_model/model_hash'],
    ['a model that does not exist', (d) => (d.fault_tree_model.name = 'missing'), 'E_MODEL_NOT_FOUND', '/fault_tree_model/name'],
    ['a model that changed since', (d) => (d.fault_tree_model.model_hash = 'f'.repeat(64)), 'E_STALE_MODEL', '/fault_tree_model/model_hash'],
    ['a heading event the model does not have', (d) => (d.headings[1].event = 'NOPE'), 'E_UNKNOWN_EVENT', '/headings/1/event'],
    ['a bad heading id', (d) => (d.headings[0].id = '1bad'), 'E_ID_FORMAT', '/headings/0/id'],
    ['a bad end state id', (d) => (d.end_states[0].id = 'bad id'), 'E_ID_FORMAT', '/end_states/0/id'],
    ['a repeated heading id', (d) => (d.headings[1].id = 'A'), 'E_DUP_HEADING', '/headings/1/id'],
    ['a repeated end state id', (d) => (d.end_states[1].id = 'SAFE'), 'E_DUP_ID', '/end_states/1/id'],
    ['a condition on an unknown heading', (d) => (d.headings[1].asked_only_if = { heading: 'Z', branch: 'works' }), 'E_BYPASS_ORDER', '/headings/1/asked_only_if/heading'],
    ['a condition on itself', (d) => (d.headings[1].asked_only_if = { heading: 'B', branch: 'works' }), 'E_BYPASS_ORDER'],
    ['a condition on a later heading', (d) => (d.headings[0].asked_only_if = { heading: 'B', branch: 'works' }), 'E_BYPASS_ORDER', '/headings/0/asked_only_if/heading'],
    ['a sequence leaving out a heading', (d) => d.sequences[0].path.pop(), 'E_PATH_INCOMPLETE', '/sequences/0/path'],
    ['a sequence with its steps in the wrong order', (d) => d.sequences[1].path.reverse(), 'E_PATH_INCOMPLETE', '/sequences/1/path'],
    ['a sequence naming a heading that does not exist', (d) => (d.sequences[0].path[0].heading = 'Z'), 'E_PATH_INCOMPLETE', '/sequences/0/path'],
    ['a sequence listed twice', (d) => (d.sequences[1] = clone(d.sequences[0])), 'E_SEQUENCE_DUP', '/sequences/1/path'],
    ['a missing sequence', (d) => d.sequences.pop(), 'E_SEQUENCES_MISSING', '/sequences'],
    ['a sequence with no end state', (d) => (d.sequences[2].end_state = ''), 'E_NO_END_STATE', '/sequences/2/end_state'],
    ['a sequence with an end state that is not defined', (d) => (d.sequences[2].end_state = 'NOWHERE'), 'E_END_STATE_UNKNOWN', '/sequences/2/end_state'],
    ['a different assumption set', (d) => (d.assumptions.success_branches = 'ignored'), 'E_SCHEMA', '/assumptions/success_branches'],
    ['a wrong schema id', (d) => (d.schema.id = 'sneed.fault-tree'), 'E_SCHEMA'],
    ['no end states', (d) => (d.end_states = []), 'E_SCHEMA'],
    ['no headings', (d) => (d.headings = []), 'E_SCHEMA'],
  ];
  for (const [name, mutate, code, at] of cases) {
    it(name, () => {
      const d = sharedDoc();
      mutate(d);
      const r = validateEventTree(d, CTX);
      expect(r.valid, name).toBe(false);
      expect(r.errors.map((e) => e.code), name).toContain(code);
      if (at) expect(r.errors.find((e) => e.code === code)!.path, name).toBe(at);
    });
  }

  it('a path that names a heading that does not exist, and one with its steps in the wrong order, each say which', () => {
    const a = sharedDoc();
    a.sequences[0].path[0].heading = 'Z';
    expect(validateEventTree(a, CTX).errors.find((e) => e.code === 'E_PATH_INCOMPLETE')!.message).toContain('"Z", which is not a heading');
    const b = sharedDoc();
    b.sequences[1].path.reverse();
    expect(validateEventTree(b, CTX).errors.find((e) => e.code === 'E_PATH_INCOMPLETE')!.message).toContain('not in the order of the headings');
  });

  it('a document with a bad structure gets its structural errors only: the rules that read its fields do not run on it', () => {
    const d = sharedDoc();
    delete d.initiating_event.frequency;
    d.headings[1].id = 'A'; // a repeated heading id would be a second error if the rules ran
    expect(codes(d)).toEqual(['E_NO_FREQUENCY']);
  });

  it('the missing-sequences message counts them and shows examples', () => {
    const d = sharedDoc();
    d.sequences = d.sequences.slice(0, 1);
    const e = validateEventTree(d, CTX).errors.find((x) => x.code === 'E_SEQUENCES_MISSING')!;
    expect(e.message).toContain('3 of the 4 possible paths are not listed');
    expect(e.message).toContain('"A:works,B:fails"');
  });

  it('a path that lists a heading which is not asked says so', () => {
    const d = bypassDoc();
    d.sequences[2].path = [{ heading: 'A', branch: 'fails' }, { heading: 'B', branch: 'works' }]; // B is not asked after A fails
    const e = validateEventTree(d, CTX).errors.find((x) => x.code === 'E_PATH_INCOMPLETE')!;
    expect(e.message).toContain('asked only if');
  });

  it('too many headings, and too many sequences, are refused at once', () => {
    const d = sharedDoc();
    d.headings = Array.from({ length: MAX_HEADINGS + 1 }, (_, i) => ({ id: `H${i}`, name: 'h', event: 'X' }));
    expect(codes(d)).toContain('E_TOO_MANY_HEADINGS');
    const e = sharedDoc();
    e.sequences = Array.from({ length: MAX_SEQUENCES + 1 }, () => clone(e.sequences[0]));
    expect(validateEventTree(e, CTX).valid).toBe(false);
  });

  it('a model rule problem and a path problem are both reported in one go', () => {
    const d = sharedDoc();
    d.headings[0].event = 'NOPE';
    d.sequences.pop();
    expect(codes(d)).toEqual(expect.arrayContaining(['E_UNKNOWN_EVENT', 'E_SEQUENCES_MISSING']));
  });

  it('an invalid condition does not also report every path as wrong (one cause, one error)', () => {
    const d = sharedDoc();
    d.headings[1].asked_only_if = { heading: 'Z', branch: 'works' };
    expect(codes(d)).toEqual(['E_BYPASS_ORDER']);
  });
});

describe('warnings never make a document invalid', () => {
  it('an unused end state, a zero frequency and an unknown field', () => {
    const d = sharedDoc();
    d.end_states.push({ id: 'EXTRA', name: 'Unused', description: 'nothing ends here', synthetic: true });
    d.initiating_event.frequency = 0;
    d.extra_field = 1;
    const r = validateEventTree(d, CTX);
    expect(r.valid).toBe(true);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(['W_UNKNOWN_FIELD', 'W_UNUSED_END_STATE', 'W_ZERO_FREQUENCY']);
  });
});

describe('documents that are not documents', () => {
  it('are refused as E_SCHEMA and never throw', () => {
    for (const v of [null, undefined, 5, 'x', true, [], [[]], {}, { schema: null }, { headings: 'x' }, JSON.parse('{"__proto__": {"a": 1}}')]) {
      const r = validateEventTree(v as unknown, CTX);
      expect(r.valid, JSON.stringify(v)).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it('text that is not JSON is E_SCHEMA with the parser message', () => {
    expect(validateEventTreeText('{nope')).toMatchObject({ valid: false, errors: [{ code: 'E_SCHEMA' }] });
    expect(validateEventTreeText(JSON.stringify(sharedDoc()), CTX).valid).toBe(true);
  });

  it('survives 2000 random corruptions of a valid document: valid or a list of errors, never an exception, and "valid" means the invariants hold', () => {
    const base = bypassDoc();
    const rand = rng(7);
    const walk = (v: any, depth: number, pick: () => number): any[] => {
      const out: any[] = [];
      if (v && typeof v === 'object' && depth < 6) for (const k of Object.keys(v)) out.push({ parent: v, key: k }, ...walk(v[k], depth + 1, pick));
      return out;
    };
    for (let i = 0; i < 2000; i++) {
      const d = clone(base);
      const slots = walk(d, 0, rand);
      const n = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) {
        const slot = slots[Math.floor(rand() * slots.length)]!;
        const r = rand();
        slot.parent[slot.key] = r < 0.15 ? null : r < 0.3 ? 'x' : r < 0.45 ? -1 : r < 0.6 ? [] : r < 0.75 ? {} : r < 0.9 ? 1e308 : undefined;
      }
      const r = validateEventTree(d, CTX);
      if (r.valid) {
        // a document that passes has sequences that are exactly the allowed paths, each once, each with a defined end state
        const complete = enumeratePaths(d.headings).map(pathKey).sort();
        expect(d.sequences.map((s: Doc) => pathKey(s.path)).sort(), `seed ${i}`).toEqual(complete);
        for (const s of d.sequences) expect(d.end_states.some((e: Doc) => e.id === s.end_state), `seed ${i}`).toBe(true);
      } else expect(r.errors.length).toBeGreaterThan(0);
    }
  });
});

describe('random valid trees and what breaks them', () => {
  const randomTree = (seed: number): Doc => {
    const r = rng(seed);
    const n = 1 + Math.floor(r() * 6);
    const heads: Doc[] = [];
    for (let i = 0; i < n; i++) {
      const h: Doc = { id: `H${i}`, name: `Heading ${i}`, event: i % 2 ? 'X' : 'Y' };
      if (i > 0 && r() < 0.5) h.asked_only_if = { heading: `H${Math.floor(r() * i)}`, branch: r() < 0.5 ? 'works' : 'fails' };
      heads.push(h);
    }
    const d = tree('shared', heads, () => ['SAFE', 'DEGRADED', 'LOSS'][Math.floor(r() * 3)]!);
    // the author may list the sequences in any order
    for (let i = d.sequences.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [d.sequences[i], d.sequences[j]] = [d.sequences[j], d.sequences[i]];
    }
    return d;
  };

  it('500 random trees (with random bypass conditions, sequences in random order) are valid', () => {
    for (let s = 1; s <= 500; s++) {
      const d = randomTree(s);
      const r = validateEventTree(d, CTX);
      expect(r.errors, `seed ${s}`).toEqual([]);
    }
  });

  it('dropping any one sequence is E_SEQUENCES_MISSING, repeating one is E_SEQUENCE_DUP, changing one step is a path error', () => {
    for (let s = 1; s <= 200; s++) {
      const d = randomTree(s);
      const k = s % d.sequences.length;
      const dropped = clone(d);
      dropped.sequences.splice(k, 1);
      expect(codes(dropped), `drop ${s}`).toEqual(['E_SEQUENCES_MISSING']);
      const dup = clone(d);
      dup.sequences.push(clone(dup.sequences[k]));
      expect(codes(dup), `dup ${s}`).toEqual(['E_SEQUENCE_DUP']);
      const bent = clone(d);
      const step = bent.sequences[k].path[0];
      step.branch = step.branch === 'works' ? 'fails' : 'works';
      const c = codes(bent);
      expect(c.length, `bend ${s}`).toBeGreaterThan(0);
      expect(c.every((x) => x === 'E_SEQUENCE_DUP' || x === 'E_SEQUENCES_MISSING' || x === 'E_PATH_INCOMPLETE'), `bend ${s}: ${c}`).toBe(true);
    }
  });
});

describe('the hash of what a document means', () => {
  const h = (d: Doc): string => eventTreeHash(d as never);
  it('is a sha-256, the same for the same document, and not changed by names, descriptions, times or the order of the sequence list', () => {
    const d = bypassDoc();
    expect(h(d)).toMatch(/^[0-9a-f]{64}$/);
    expect(h(clone(d))).toBe(h(d));
    const e = clone(d);
    e.tree.name = 'Renamed';
    e.tree.updated = '2030-01-01T00:00:00Z';
    e.initiating_event.name = 'Another name';
    e.initiating_event.description = 'Another description';
    e.headings[0].name = 'Another heading name';
    e.end_states[0].name = 'Another end state name';
    e.end_states[0].description = 'Another description';
    e.sequences.reverse();
    expect(h(e)).toBe(h(d));
  });

  it('changes with the frequency, a heading event, a condition, an end state mapping, the model it points at, or the headings order', () => {
    const d = bypassDoc();
    const base = h(d);
    const variants: Record<string, (x: Doc) => void> = {
      frequency: (x) => (x.initiating_event.frequency = 0.51),
      'heading event': (x) => (x.headings[1].event = 'X'),
      condition: (x) => (x.headings[1].asked_only_if.branch = 'fails'),
      'end state mapping': (x) => (x.sequences[0].end_state = 'LOSS'),
      'model hash': (x) => (x.fault_tree_model.model_hash = 'a'.repeat(64)),
      'model name': (x) => (x.fault_tree_model.name = 'other'),
      'heading id': (x) => (x.headings[0].id = 'AA'),
      'an end state added': (x) => x.end_states.push({ id: 'MORE', name: 'm', description: 'd', synthetic: true }),
      'assumptions': (x) => (x.assumptions.success_branches = 'ignored'),
    };
    for (const [name, mutate] of Object.entries(variants)) {
      const x = clone(d);
      mutate(x);
      expect(h(x), name).not.toBe(base);
    }
  });
});

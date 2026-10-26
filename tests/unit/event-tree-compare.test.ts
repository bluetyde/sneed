import { describe, expect, it } from 'vitest';
import { diffEventTreeResults, readEventTreeRecord } from '../../src/core/event-tree-compare.js';

type Rec = Record<string, any>;
/** Two headings (Injection, Cooling), four sequences, one end state. */
function rec(freqs: number[] = [0.252, 0.108, 0.063, 0.077], over: Rec = {}): Rec {
  const keys = ['H1:works,H2:works', 'H1:works,H2:fails', 'H1:fails,H2:works', 'H1:fails,H2:fails'];
  const paths = [['works', 'works'], ['works', 'fails'], ['fails', 'works'], ['fails', 'fails']];
  const total = freqs.reduce((x, y) => x + y, 0);
  return {
    schema: { id: 'sneed.event-tree-result', version: 1 },
    status: 'completed',
    completeness: 'complete',
    engine: { name: 'sneed-bdd', version: '0.1.0', sha256: 'e'.repeat(64) },
    input_hashes: { tree_hash: 't1', model_hash: 'm1', document_hash: 'd1' },
    initiating_event: { name: 'Loss of supply', frequency: 0.5 },
    headings: [{ id: 'H1', name: 'Injection', event: 'X' }, { id: 'H2', name: 'Cooling', event: 'Y' }],
    sequences: keys.map((key, i) => ({ key, path: [{ heading: 'H1', branch: paths[i]![0] }, { heading: 'H2', branch: paths[i]![1] }], end_state: i === 3 ? 'BAD' : 'OK', probability: freqs[i]! * 2, frequency: freqs[i]! })),
    end_states: [{ id: 'OK', name: 'Fine (example)', frequency: freqs[0]! + freqs[1]! + freqs[2]! }, { id: 'BAD', name: 'Bad (example)', frequency: freqs[3]! }],
    total: { frequency: total },
    assumptions: { frequency_unit: 'per-year', success_branches: 'exact' },
    ...over,
  };
}

describe('comparing two saved event-tree analyses', () => {
  it('identical analyses: nothing changed, and the inputs are the same', () => {
    const d = diffEventTreeResults(rec(), rec())!;
    expect(d.numbersCompared).toBe(true);
    expect(d.sequences).toEqual({ added: [], removed: [], changed: [], unchanged: 4 });
    expect(d.endStates).toEqual({ added: [], removed: [], changed: [], unchanged: 2 });
    expect(d.total).toBeNull();
    expect(d.initiating).toEqual({ name: null, frequency: null });
    expect(d.headings).toEqual({ added: [], removed: [], changed: [] });
    expect(d.assumptions).toEqual([]);
    expect(d.engine).toBeNull();
    expect(d.sameTree && d.sameModel && d.sameInputs).toBe(true);
  });

  it('a changed frequency is reported with from, to, delta and ratio, in the path\'s words', () => {
    const d = diffEventTreeResults(rec(), rec([0.252, 0.108, 0.063, 0.154]))!;
    expect(d.sequences.unchanged).toBe(3);
    expect(d.sequences.changed).toHaveLength(1);
    const c = d.sequences.changed[0]!;
    expect(c.key).toBe('H1:fails,H2:fails');
    expect(c.words).toBe('Injection fails, Cooling fails');
    expect(c.frequency!.from).toBe(0.077);
    expect(c.frequency!.to).toBe(0.154);
    expect(c.frequency!.delta).toBeCloseTo(0.077, 12);
    expect(c.frequency!.ratio).toBeCloseTo(2, 12);
    expect(c.end_state).toBeNull();
    expect(d.endStates.changed.map((x) => x.id)).toEqual(['BAD']);
    expect(d.total!.delta).toBeCloseTo(0.077, 12);
  });

  it('a ratio from zero is not a number, never infinity', () => {
    const d = diffEventTreeResults(rec([0, 0.1, 0.2, 0.3]), rec([0.05, 0.1, 0.2, 0.3]))!;
    const c = d.sequences.changed[0]!;
    expect(c.frequency).toEqual({ from: 0, to: 0.05, delta: 0.05, ratio: null });
  });

  it('a sequence only in one analysis is added or removed, and an end state that moved is named', () => {
    const later = rec();
    later.sequences = later.sequences.slice(0, 3);
    later.end_states = [later.end_states[0]];
    const d = diffEventTreeResults(rec(), later)!;
    expect(d.sequences.removed.map((x) => x.key)).toEqual(['H1:fails,H2:fails']);
    expect(d.sequences.removed[0]!.frequency).toBe(0.077);
    expect(d.endStates.removed.map((x) => x.id)).toEqual(['BAD']);
    const back = diffEventTreeResults(later, rec())!;
    expect(back.sequences.added.map((x) => x.key)).toEqual(['H1:fails,H2:fails']);
    expect(back.endStates.added.map((x) => x.id)).toEqual(['BAD']);
  });

  it('a sequence whose end state changed is reported even when its frequency did not', () => {
    const later = rec();
    later.sequences[1].end_state = 'BAD';
    const d = diffEventTreeResults(rec(), later)!;
    expect(d.sequences.changed).toHaveLength(1);
    expect(d.sequences.changed[0]!.frequency).toBeNull();
    expect(d.sequences.changed[0]!.end_state).toEqual({ from: 'OK', to: 'BAD' });
  });

  it('what the analyses were made from: tree, model, engine, initiating event, headings, assumptions', () => {
    const later = rec([0.1, 0.1, 0.1, 0.1], {
      input_hashes: { tree_hash: 't2', model_hash: 'm2', document_hash: 'd2' },
      engine: { name: 'sneed-bdd', version: '0.2.0', sha256: 'f'.repeat(64) },
      initiating_event: { name: 'Loss of all supply', frequency: 0.25 },
      headings: [{ id: 'H1', name: 'Safety injection', event: 'X2' }, { id: 'H2', name: 'Cooling', event: 'Y' }, { id: 'H3', name: 'New', event: 'Z' }],
      assumptions: { frequency_unit: 'per-year', success_branches: 'ignored', extra: 'yes' },
    });
    const d = diffEventTreeResults(rec(), later)!;
    expect(d.sameTree).toBe(false);
    expect(d.sameModel).toBe(false);
    expect(d.sameInputs).toBe(false);
    expect(d.engine).toEqual({ from: `sneed-bdd 0.1.0 build ${'e'.repeat(12)}`, to: `sneed-bdd 0.2.0 build ${'f'.repeat(12)}` });
    expect(d.initiating.name).toEqual({ from: 'Loss of supply', to: 'Loss of all supply' });
    expect(d.initiating.frequency!.ratio).toBe(0.5);
    expect(d.headings.added).toEqual(['H3']);
    expect(d.headings.changed).toEqual([{ id: 'H1', name: { from: 'Injection', to: 'Safety injection' }, event: { from: 'X', to: 'X2' } }]);
    expect(d.assumptions).toEqual([{ key: 'extra', from: null, to: 'yes' }, { key: 'success_branches', from: 'exact', to: 'ignored' }]);
  });

  it('the same inputs need all three to be the same and stated: a missing engine build is not "the same engine"', () => {
    const noBuild = (): Rec => rec([0.252, 0.108, 0.063, 0.077], { engine: { name: 'sneed-bdd', version: '0.1.0' } });
    const nb = diffEventTreeResults(noBuild(), noBuild())!;
    expect(nb.sameInputs).toBe(false); // the same name and version without a build hash is not evidence of the same build
    expect(nb.engineKnown).toBe(false);
    expect(diffEventTreeResults(rec(), rec())!.engineKnown).toBe(true);
    const missing = rec([0.252, 0.108, 0.063, 0.077], { engine: undefined });
    expect(diffEventTreeResults(missing, missing)!.sameInputs).toBe(false);
    expect(diffEventTreeResults(rec(), rec([0.252, 0.108, 0.063, 0.077], { input_hashes: { tree_hash: 't1', model_hash: 'other', document_hash: 'd' } }))!.sameInputs).toBe(false);
    const noHash = rec([0.252, 0.108, 0.063, 0.077], { input_hashes: {} });
    expect(diffEventTreeResults(noHash, noHash)!.sameTree).toBe(false);
    expect(diffEventTreeResults(noHash, noHash)!.sameModel).toBe(false);
  });

  it('numbers are compared only when both analyses are complete; a failed one says so and removes nothing', () => {
    const failed = rec([], { status: 'failed', completeness: 'unknown', sequences: [], end_states: [], total: null });
    for (const [x, y] of [[rec(), failed], [failed, rec()], [failed, failed]] as const) {
      const d = diffEventTreeResults(x, y)!;
      expect(d.numbersCompared).toBe(false);
      expect(d.sequences).toEqual({ added: [], removed: [], changed: [], unchanged: 0 });
      expect(d.endStates).toEqual({ added: [], removed: [], changed: [], unchanged: 0 });
      expect(d.total).toBeNull();
    }
    const d = diffEventTreeResults(rec(), failed)!;
    expect(d.runs.b).toEqual({ status: 'failed', completeness: 'unknown' });
    const partial = rec([0.2, 0.2, 0.2, 0.2], { completeness: 'unknown' }); // a total that differs, so a comparison of it would show
    const dp = diffEventTreeResults(rec(), partial)!;
    expect(dp.numbersCompared).toBe(false);
    expect(dp.total).toBeNull();
  });

  it('a heading unknown to the later analysis is named from the earlier one, else by its id', () => {
    const later = rec();
    later.headings = [];
    const d = diffEventTreeResults(rec([0.1, 0.1, 0.1, 0.1]), later)!;
    expect(d.sequences.changed.length).toBeGreaterThan(0);
    expect(d.sequences.changed[0]!.words).toContain('Injection');
    const none = rec();
    none.headings = [];
    const bare = rec([0.1, 0.1, 0.1, 0.1]);
    bare.headings = [];
    expect(diffEventTreeResults(none, bare)!.sequences.changed[0]!.words).toBe('H1 works, H2 works');
  });

  it('a record that is not an event-tree result is not compared', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}, { schema: { id: 'sneed.fault-tree' } }, { schema: 'sneed.event-tree-result' }]) {
      expect(diffEventTreeResults(bad, rec())).toBeNull();
      expect(diffEventTreeResults(rec(), bad)).toBeNull();
    }
  });

  it('tolerates a hand-edited record: wrong types are skipped, never thrown on or shown as numbers', () => {
    const hostile = rec(undefined, {
      headings: [null, 3, { id: 7 }, { id: 'H1' }, { id: 'H2', name: ['x'], event: {} }],
      sequences: [null, { key: 5 }, { key: 'K', frequency: 'high' }, { key: 'K2', frequency: Number.NaN }, { key: 'K3', frequency: Number.POSITIVE_INFINITY }, { key: 'H1:works,H2:works', frequency: 0.2, path: 'x', end_state: 4 }],
      end_states: [null, { id: 1 }, { id: 'OK', frequency: '1' }, { id: 'OK2', name: 'ok', frequency: 0.5 }],
      assumptions: { a: { b: 1 }, c: undefined, d: 5 },
      engine: 'x',
      input_hashes: 4,
      initiating_event: 'x',
      total: 'x',
    });
    const r = readEventTreeRecord(hostile)!;
    expect([...r.sequences.keys()]).toEqual(['H1:works,H2:works']);
    expect([...r.endStates.keys()]).toEqual(['OK2']);
    expect(r.headings.get('H1')).toEqual({ id: 'H1', name: 'H1', event: '' });
    const d = diffEventTreeResults(hostile, rec())!;
    expect(d).not.toBeNull();
    expect(JSON.stringify(d)).not.toContain('NaN');
    expect(d.engine).toBeNull();
  });

  it('never calls one analysis better: nothing in a difference carries a verdict', () => {
    const d = diffEventTreeResults(rec(), rec([0.01, 0.01, 0.01, 0.01]))!;
    expect(JSON.stringify(d)).not.toMatch(/better|worse|safer|improv|degrad|regress/i);
  });

  it('builds that share the first twelve characters of their hash are still different builds', () => {
    const a = rec(undefined, { engine: { name: 'sneed-bdd', version: '0.1.0', sha256: 'ab12cd34ef56' + '0'.repeat(52) } });
    const b = rec(undefined, { engine: { name: 'sneed-bdd', version: '0.1.0', sha256: 'ab12cd34ef56' + '1'.repeat(52) } });
    const d = diffEventTreeResults(a, b)!;
    expect(d.sameInputs).toBe(false);
    expect(d.engine).not.toBeNull(); // reported as a difference even though the shown labels read the same
    expect(diffEventTreeResults(a, a)!.sameInputs).toBe(true);
  });

  it('a record that claims to be complete but has a damaged row or no total is not trusted: no numbers are compared, and it is named', () => {
    const damagedRow = rec();
    damagedRow.sequences[2].frequency = 'a lot';
    const noTotal = rec(undefined, { total: undefined });
    const noRows = rec(undefined, { sequences: undefined });
    const noEnds = rec(undefined, { end_states: 'x' });
    const brokenEnd = rec();
    brokenEnd.end_states[0].frequency = null;
    for (const bad of [damagedRow, noTotal, noRows, noEnds, brokenEnd]) {
      const d = diffEventTreeResults(rec(), bad)!;
      expect(d.numbersCompared).toBe(false);
      expect(d.malformed).toEqual({ a: false, b: true });
      expect(d.sequences).toEqual({ added: [], removed: [], changed: [], unchanged: 0 });
      expect(d.total).toBeNull();
      expect(diffEventTreeResults(bad, rec())!.malformed).toEqual({ a: true, b: false });
    }
    // an analysis that failed has no numbers and is not "damaged"
    const failed = rec([], { status: 'failed', completeness: 'unknown', sequences: [], end_states: [], total: null });
    expect(diffEventTreeResults(rec(), failed)!.malformed).toEqual({ a: false, b: false });
    expect(diffEventTreeResults(rec(), rec())!.malformed).toEqual({ a: false, b: false });
  });
});

describe('common-cause groups in the comparison of two analyses', () => {
  const groups = (over: Rec[] = [{ id: 'G', members: ['B', 'A'], beta: 0.1 }]): Rec => ({ common_cause: { method: 'beta-factor', groups: over, note: 'n' } });

  it('two analyses without groups: not used, nothing listed', () => {
    const d = diffEventTreeResults(rec(), rec())!;
    expect(d.groups).toEqual({ used: { a: false, b: false }, added: [], removed: [], changed: [] });
  });

  it('a group in the later analysis only is added; in the earlier only is removed; both say which side used groups', () => {
    const added = diffEventTreeResults(rec(), rec(undefined, groups()))!;
    expect(added.groups.used).toEqual({ a: false, b: true });
    expect(added.groups.added).toEqual([{ id: 'G', members: ['A', 'B'], beta: 0.1 }]); // members sorted
    expect(added.groups.removed).toEqual([]);
    const removed = diffEventTreeResults(rec(undefined, groups()), rec())!;
    expect(removed.groups.used).toEqual({ a: true, b: false });
    expect(removed.groups.removed).toEqual([{ id: 'G', members: ['A', 'B'], beta: 0.1 }]);
    expect(removed.groups.added).toEqual([]);
  });

  it('a changed beta or members is listed; the same groups with members in another order are not a change', () => {
    const beta = diffEventTreeResults(rec(undefined, groups()), rec(undefined, groups([{ id: 'G', members: ['A', 'B'], beta: 0.2 }])))!;
    expect(beta.groups.changed).toEqual([{ id: 'G', members: null, beta: { from: 0.1, to: 0.2 } }]);
    const members = diffEventTreeResults(rec(undefined, groups()), rec(undefined, groups([{ id: 'G', members: ['A', 'C'], beta: 0.1 }])))!;
    expect(members.groups.changed).toEqual([{ id: 'G', members: { from: ['A', 'B'], to: ['A', 'C'] }, beta: null }]);
    const reordered = diffEventTreeResults(rec(undefined, groups()), rec(undefined, groups([{ id: 'G', members: ['A', 'B'], beta: 0.1 }])))!;
    expect(reordered.groups).toEqual({ used: { a: true, b: true }, added: [], removed: [], changed: [] });
  });

  it('a common_cause block that is present but damaged is damage: a complete record is then malformed and its numbers are not compared', () => {
    for (const bad of ['oops', 5, null, { groups: 'x' }, { groups: [{ id: 'G' }] }, { groups: [{ id: 'G', members: [1] }] }]) {
      const d = diffEventTreeResults(rec(), rec(undefined, { common_cause: bad }))!;
      expect(d.malformed.b, JSON.stringify(bad)).toBe(true);
      expect(d.numbersCompared, JSON.stringify(bad)).toBe(false);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { checkCriterionMutation, currentMutationHash, MUTATION_NOT_CURRENT, mutationHash, validateMutation, type ThMutation } from '../../src/core/th-mutation.js';
import { criterionHash, judge, validateCriterion, type ThAnswer, type ThCriterion, type ThCurrent } from '../../src/core/th-criterion.js';

const A = 'a'.repeat(64);
const M = 'e'.repeat(64);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const good = (): ThMutation => ({
  schema: { id: 'sneed.th-mutation', version: 1 },
  mutation: { id: 'pump1-off', name: 'Pump 1 stopped (example)', description: 'Example: pump1 runs at speed ratio 0 from the start of the run.', synthetic: true, created: '2026-10-07T00:00:00Z', updated: '2026-10-07T00:00:00Z' },
  base_model: { name: 'pumped-loop', hash: A },
  mutated_model: { name: 'pumped-loop-pump1-off', hash: M },
  edits: [{ component: 'pump1', field: 'head.speedRatio', from: 1, to: 0 }],
  applies: 'from-start',
});
const codes = (d: unknown, ctx?: Parameters<typeof validateMutation>[1]): string[] => validateMutation(d, ctx).errors.map((e) => e.code);
const models = (t: Record<string, string>) => ({ resolveModel: (n: string) => (n in t ? { hash: t[n]! } : null) });

describe('a plant-model mutation record (plan 14, stage T1)', () => {
  it('a sound record is valid; unknown fields are allowed and kept', () => {
    expect(validateMutation(good()).errors).toEqual([]);
    expect(validateMutation({ ...good(), future: 1 }).valid).toBe(true);
  });

  it('refuses what is not an object', () => {
    for (const v of [null, 5, 'x', [], undefined]) expect(codes(v)).toEqual(['E_SCHEMA']);
  });

  it('refuses each missing section, and an empty list of edits', () => {
    for (const key of ['schema', 'mutation', 'base_model', 'mutated_model', 'edits', 'applies']) {
      const d = good() as unknown as Record<string, unknown>;
      delete d[key];
      const v = validateMutation(d);
      expect(v.valid, key).toBe(false);
      expect(v.errors.some((e) => e.path === `/${key}`), key).toBe(true);
    }
    expect(validateMutation({ ...good(), edits: [] }).valid).toBe(false);
  });

  it('accepts a number, text or true/false as a value, and refuses anything else, and text that is too long', () => {
    for (const v of [0, -2.5, 'open', true, false]) {
      const d = good();
      d.edits[0]!.to = v;
      d.edits[0]!.from = typeof v === 'number' ? v + 1 : typeof v === 'string' ? 'closed' : !v;
      expect(validateMutation(d).errors, String(v)).toEqual([]);
    }
    for (const bad of [null, [1], { a: 1 }, 'x'.repeat(201)]) {
      const d = good() as unknown as { edits: Record<string, unknown>[] };
      d.edits[0]!.to = bad;
      expect(validateMutation(d).valid, JSON.stringify(bad)?.slice(0, 20)).toBe(false);
    }
    const inf = JSON.parse(JSON.stringify(good()).replace('"to":0', '"to":1e999')) as unknown;
    expect(validateMutation(inf).valid).toBe(false);
  });

  it('refuses a record that applies at any time but the start (the only form of this version)', () => {
    expect(validateMutation({ ...good(), applies: 'at-60-s' }).valid).toBe(false);
  });

  it('refuses more than 50 edits', () => {
    const d = good();
    d.edits = Array.from({ length: 51 }, (_, i) => ({ component: `c${i}`, field: 'f', from: 1, to: 2 }));
    expect(validateMutation(d).valid).toBe(false);
    d.edits.pop();
    d.edits.pop();
    expect(validateMutation(d).errors).toEqual([]);
  });

  it('refuses an edit that changes nothing, and says where; 0 and the same text are the same value', () => {
    for (const [from, to] of [[1, 1], ['open', 'open'], [true, true], [0, -0]] as [number | string | boolean, number | string | boolean][]) {
      const d = good();
      d.edits[0]!.from = from;
      d.edits[0]!.to = to;
      expect(codes(d), `${String(from)}->${String(to)}`).toEqual(['E_EDIT_NOOP']);
    }
    const d = good();
    d.edits[0]!.from = 0;
    expect(validateMutation(d).errors[0]!.path).toBe('/edits/0/to');
    // a number and a text that look alike are different values
    const e = good();
    e.edits[0]!.from = '0';
    expect(codes(e)).toEqual([]);
  });

  it('refuses the same field of the same component edited twice, but not the same field of another component or another field of the same one', () => {
    const d = good();
    d.edits.push({ component: 'pump1', field: 'head.speedRatio', from: 0, to: 2 });
    expect(codes(d)).toEqual(['E_EDIT_DUP']);
    const e = good();
    e.edits.push({ component: 'pump2', field: 'head.speedRatio', from: 1, to: 0 }, { component: 'pump1', field: 'ratedSpeed', from: 100, to: 90 });
    expect(codes(e)).toEqual([]);
    // names that only look alike when joined are not the same field
    const f = good();
    f.edits = [{ component: 'a', field: 'b.c', from: 1, to: 2 }, { component: 'a.b', field: 'c', from: 1, to: 2 }];
    expect(codes(f)).toEqual([]);
  });

  it('refuses two models that are the same by hash or by name', () => {
    const same = good();
    same.mutated_model.hash = A;
    expect(codes(same)).toEqual(['E_MODELS_IDENTICAL']);
    const name = good();
    name.mutated_model.name = 'pumped-loop';
    expect(codes(name)).toEqual(['E_SAME_MODEL_NAME']);
  });

  it('checks the two models against the saved ones only when given them: not found, base changed, mutated changed', () => {
    const t = { 'pumped-loop': A, 'pumped-loop-pump1-off': M };
    expect(codes(good(), models(t))).toEqual([]);
    expect(codes(good())).toEqual([]);
    expect(codes(good(), models({ 'pumped-loop-pump1-off': M }))).toEqual(['E_MODEL_NOT_FOUND']);
    expect(codes(good(), models({ 'pumped-loop': A }))).toEqual(['E_MODEL_NOT_FOUND']);
    expect(codes(good(), models({ ...t, 'pumped-loop': 'd'.repeat(64) }))).toEqual(['E_STALE_BASE']);
    expect(codes(good(), models({ ...t, 'pumped-loop-pump1-off': 'd'.repeat(64) }))).toEqual(['E_STALE_MUTATED']);
    expect(codes(good(), models({})).sort()).toEqual(['E_MODEL_NOT_FOUND', 'E_MODEL_NOT_FOUND']);
    const v = validateMutation(good(), models({ ...t, 'pumped-loop': 'd'.repeat(64) }));
    expect(v.errors[0]!.path).toBe('/base_model/hash');
    expect(validateMutation(good(), models({ 'pumped-loop': A })).errors[0]!.path).toBe('/mutated_model/name');
  });

  it('quotes the names it prints', () => {
    const d = good();
    d.base_model.name = 'a "quoted" loop';
    const v = validateMutation(d, models({}));
    expect(v.errors[0]!.message).toContain('"a \\"quoted\\" loop"');
  });
});

describe('the mutation hash', () => {
  it('is the SHA-256 of the canonical text of what the record means, worked out here independently', () => {
    const text =
      '{"applies":"from-start",' +
      '"base_model":{"hash":"' + A + '","name":"pumped-loop"},' +
      '"edits":[{"component":"pump1","field":"head.speedRatio","from":1,"to":0}],' +
      '"mutated_model":{"hash":"' + M + '","name":"pumped-loop-pump1-off"},' +
      '"schema":{"id":"sneed.th-mutation","version":1}}';
    expect(mutationHash(good())).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  });

  it('does not change with the name, description, example label, time stamps, an extra field or the order of the edits', () => {
    const d = good();
    d.edits.push({ component: 'pump2', field: 'head.speedRatio', from: 1, to: 0 }, { component: 'pump1', field: 'ratedSpeed', from: 100, to: 90 });
    const h = mutationHash(d);
    const e = clone(d) as ThMutation & { extra?: unknown };
    e.mutation = { id: 'other', name: 'other', description: 'other', synthetic: false, created: 'x', updated: 'y' };
    e.extra = 1;
    e.edits.reverse();
    expect(mutationHash(e)).toBe(h);
  });

  it('changes with every field that carries meaning', () => {
    const base = mutationHash(good());
    const edits: ((d: ThMutation) => void)[] = [
      (d) => (d.base_model.name = 'other'),
      (d) => (d.base_model.hash = 'd'.repeat(64)),
      (d) => (d.mutated_model.name = 'other'),
      (d) => (d.mutated_model.hash = 'd'.repeat(64)),
      (d) => (d.edits[0]!.component = 'pump2'),
      (d) => (d.edits[0]!.field = 'head.other'),
      (d) => (d.edits[0]!.from = 2),
      (d) => (d.edits[0]!.to = 0.5),
      (d) => d.edits.push({ component: 'pump2', field: 'x', from: 1, to: 2 }),
    ];
    const seen = new Set([base]);
    edits.forEach((edit, i) => {
      const d = good();
      edit(d);
      const h = mutationHash(d);
      expect(h, String(i)).not.toBe(base);
      seen.add(h);
    });
    expect(seen.size).toBe(edits.length + 1);
  });
});

describe('the record tied to a criterion, and what a change does to an answer', () => {
  const tree = 'c'.repeat(64);
  const criterionFor = (m: ThMutation): ThCriterion => ({
    schema: { id: 'sneed.th-criterion', version: 1 },
    criterion: { id: 'flow-kept', name: 'Forced flow is kept (example)', description: 'Example: pump1 stopped from the start of the run.', synthetic: true, created: 't', updated: 't' },
    applies_to: { event_tree: { name: 'tree-a', tree_hash: tree }, heading: 'H1' },
    plant: { model_name: m.mutated_model.name, model_hash: m.mutated_model.hash, mutation_list_hash: mutationHash(m) },
    condition: { quantity: 'w_loop', comparison: 'above', limit: 10, unit: 'kg/s', window: { from: 0, to: 8, unit: 's' }, holds: 'throughout' },
  });
  const answerFor = (c: ThCriterion, min: number): ThAnswer => ({
    schema: { id: 'sneed.th-answer', version: 1 },
    answer: { id: 'run-1', entered_by: 'hand', entered: 't', note: '' },
    criterion_hash: criterionHash(c),
    plant: { model_hash: c.plant.model_hash, mutation_list_hash: c.plant.mutation_list_hash },
    engine: { name: 'hand', version: '1', build: 'b1' },
    run: { status: 'completed' },
    observed: { quantity: 'w_loop', unit: 'kg/s', window: { from: 0, to: 8, unit: 's' }, min, max: 30 },
  });
  const cur = (m: ThMutation, listHash: string | null): ThCurrent => ({
    treeHash: tree,
    plantModelHash: m.mutated_model.hash,
    mutationListHash: listHash,
    engine: { name: 'hand', version: '1', build: 'b1' },
    treeHeadings: new Set(['H1']),
  });
  const ctxNow = (t: Record<string, string>) => models(t) as Required<ReturnType<typeof models>>;
  const nowModels = { 'pumped-loop': A, 'pumped-loop-pump1-off': M };

  it('the criterion built from the record is valid, and the link check passes', () => {
    const m = good();
    const c = criterionFor(m);
    expect(validateCriterion(c).errors).toEqual([]);
    expect(checkCriterionMutation(c, m)).toEqual({ valid: true, errors: [] });
  });

  it('refuses a link whose criterion pins another record, none, or another model; and an invalid record', () => {
    const m = good();
    const c = criterionFor(m);
    const other = clone(c);
    other.plant.mutation_list_hash = 'd'.repeat(64);
    expect(checkCriterionMutation(other, m).errors.map((e) => e.code)).toEqual(['E_LINK_HASH']);
    const none = clone(c);
    none.plant.mutation_list_hash = null;
    expect(checkCriterionMutation(none, m).errors.map((e) => e.code)).toEqual(['E_LINK_HASH']);
    const hash = clone(c);
    hash.plant.model_hash = A; // runs the BASE model, not the mutated one
    expect(checkCriterionMutation(hash, m).errors.map((e) => e.code)).toEqual(['E_LINK_MODEL']);
    const name = clone(c);
    name.plant.model_name = 'pumped-loop';
    expect(checkCriterionMutation(name, m).errors.map((e) => e.code)).toEqual(['E_LINK_MODEL']);
    const both = clone(c);
    both.plant.model_name = 'x';
    both.plant.mutation_list_hash = null;
    expect(checkCriterionMutation(both, m).errors.map((e) => e.code).sort()).toEqual(['E_LINK_HASH', 'E_LINK_MODEL']);
    const bad = good();
    bad.edits = [];
    expect(checkCriterionMutation(c, bad).errors.map((e) => e.code)).toEqual(['E_LINK_INVALID']);
    expect(checkCriterionMutation(c, null).errors.map((e) => e.code)).toEqual(['E_LINK_INVALID']);
  });

  it('while the record is sound the answer is read: held and did not hold', () => {
    const m = good();
    const c = criterionFor(m);
    const now = currentMutationHash(m, ctxNow(nowModels));
    expect(now).toBe(mutationHash(m));
    expect(judge(c, answerFor(c, 12), cur(m, now)).status).toBe('held');
    expect(judge(c, answerFor(c, 6.7), cur(m, now)).status).toBe('did-not-hold');
  });

  it('when the base model changes, the record is no longer sound and the answer is stale', () => {
    const m = good();
    const c = criterionFor(m);
    const now = currentMutationHash(m, ctxNow({ ...nowModels, 'pumped-loop': 'd'.repeat(64) }));
    expect(now).toBe(MUTATION_NOT_CURRENT);
    const j = judge(c, answerFor(c, 12), cur(m, now));
    expect(j.status).toBe('stale');
    expect(j.reasons).toEqual(['mutations-changed']);
  });

  it('when the mutated model changes, the plant is changed and the record is not sound either', () => {
    const m = good();
    const c = criterionFor(m);
    const changed = 'd'.repeat(64);
    const now = currentMutationHash(m, ctxNow({ ...nowModels, 'pumped-loop-pump1-off': changed }));
    expect(now).toBe(MUTATION_NOT_CURRENT);
    const cu = cur(m, now);
    cu.plantModelHash = changed;
    const j = judge(c, answerFor(c, 12), cu);
    expect(j.status).toBe('stale');
    expect(j.reasons).toEqual(['plant-changed', 'mutations-changed']);
  });

  it('when a model is missing, the record is not sound', () => {
    expect(currentMutationHash(good(), ctxNow({ 'pumped-loop': A }))).toBe(MUTATION_NOT_CURRENT);
    expect(currentMutationHash(good(), ctxNow({}))).toBe(MUTATION_NOT_CURRENT);
  });

  it('an invalid record is never current, and never throws', () => {
    for (const bad of [null, 5, {}, { ...good(), edits: [] }]) expect(currentMutationHash(bad, ctxNow(nowModels))).toBe(MUTATION_NOT_CURRENT);
  });

  it('an edited record (an edit changed) is another record: the criterion and answer made for the old one are stale', () => {
    const old = good();
    const c = criterionFor(old);
    const a = answerFor(c, 12);
    const edited = good();
    edited.edits[0]!.to = 0.5;
    const now = currentMutationHash(edited, ctxNow(nowModels));
    expect(now).not.toBe(mutationHash(old));
    const j = judge(c, a, cur(old, now));
    expect(j.status).toBe('stale');
    expect(j.reasons).toEqual(['mutations-changed']);
  });

  it('a renamed record is not an edit', () => {
    const old = good();
    const c = criterionFor(old);
    const renamed = good();
    renamed.mutation.name = 'Another title';
    renamed.mutation.description = 'Other words';
    const now = currentMutationHash(renamed, ctxNow(nowModels));
    expect(judge(c, answerFor(c, 12), cur(old, now)).status).toBe('held');
  });
});

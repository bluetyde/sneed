import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { criterionForHeading, criterionHash, judge, TH_NOTE, validateAnswer, validateCriterion, type ThCriterion, type ThCurrent } from '../../src/core/th-criterion.js';

const oracles = JSON.parse(readFileSync(fileURLToPath(new URL('../th-criterion-oracles.json', import.meta.url)), 'utf8')) as {
  base: { criterion: ThCriterion; answer: Record<string, unknown>; current: ThCurrent };
  cases: { name: string; patch: Record<string, unknown>; expect: { status: string; reasons: string[] } }[];
  headings: { cases: { name: string; tree: string; heading: string; others: string[]; dropBase?: boolean; expect: string; messageHas?: string }[] };
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function setPath(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let at = root;
  for (const p of parts.slice(0, -1)) at = at[p] as Record<string, unknown>;
  at[parts.at(-1)!] = value;
}
const HASH = (c: ThCriterion): string => criterionHash(c);

function build(patch: Record<string, unknown>) {
  const base = clone(oracles.base) as unknown as { criterion: ThCriterion; answer: Record<string, unknown>; current: ThCurrent };
  const baseHash = HASH(oracles.base.criterion);
  const root = base as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) setPath(root, k, v);
  const own = HASH(base.criterion);
  if ((base.answer as { criterion_hash: string }).criterion_hash === '$CRITERION_HASH') (base.answer as { criterion_hash: string }).criterion_hash = own;
  if ((base.answer as { criterion_hash: string }).criterion_hash === '$BASE_CRITERION_HASH') (base.answer as { criterion_hash: string }).criterion_hash = baseHash;
  return base;
}

describe('the hand oracles for the thermal-hydraulic criterion (plan 14, stage T0)', () => {
  it('the base criterion and answer are themselves valid, so each case differs only by its patch', () => {
    const b = build({});
    expect(validateCriterion(b.criterion).errors).toEqual([]);
    expect(validateAnswer(b.answer).errors).toEqual([]);
  });

  for (const c of oracles.cases) {
    it(c.name, () => {
      const b = build(c.patch);
      const j = judge(b.criterion, b.answer, b.current);
      expect(j.status).toBe(c.expect.status);
      expect(j.reasons).toEqual(c.expect.reasons);
    });
  }

  it('every judgement says it is a fact about one run and not a probability, and the four statuses read differently', () => {
    const texts = new Set<string>();
    for (const c of oracles.cases) {
      const b = build(c.patch);
      const j = judge(b.criterion, b.answer, b.current);
      expect(j.text.endsWith(TH_NOTE)).toBe(true);
      expect(TH_NOTE).toContain('not a probability');
      texts.add(`${j.status}|${j.text}`);
    }
    expect(new Set([...texts].map((t) => t.split('|')[0])).size).toBe(4);
    expect(new Set([...texts].map((t) => t.split('|')[1])).size).toBe(4);
  });

  describe('which criterion belongs to a heading', () => {
    for (const h of oracles.headings.cases) {
      it(h.name, () => {
        const variants: Record<string, (c: ThCriterion) => unknown> = {
          'second-for-h1': (c) => ({ ...c, criterion: { ...c.criterion, id: 'second' } }),
          'for-h2': (c) => ({ ...c, criterion: { ...c.criterion, id: 'h2' }, applies_to: { ...c.applies_to, heading: 'H2' } }),
          'broken-for-h1': (c) => ({ ...c, condition: { ...c.condition, limit: 'five' } }),
        };
        const list: unknown[] = h.dropBase ? [] : [clone(oracles.base.criterion)];
        for (const o of h.others) list.push(variants[o]!(clone(oracles.base.criterion)));
        const f = criterionForHeading(list, h.tree, h.heading);
        if (h.expect === 'ok') {
          expect(f.ok).toBe(true);
        } else {
          expect(f.ok).toBe(false);
          if (!f.ok) {
            expect(f.code).toBe(h.expect);
            if (h.messageHas) expect(f.message).toContain(h.messageHas);
          }
        }
      });
    }

    it('a refusal names the heading and the tree it is about, quoted', () => {
      const f = criterionForHeading([], 'tree "x"', 'H9');
      expect(f.ok).toBe(false);
      if (!f.ok) expect(f.message).toContain('the heading "H9" of the event tree "tree \\"x\\""');
    });
  });
});

describe('the criterion hash', () => {
  it('is the SHA-256 of the canonical text of what the criterion means, worked out here independently', () => {
    const c = oracles.base.criterion;
    // keys in sorted order, as the canonical form requires; written out by hand from the base criterion
    const text =
      '{"applies_to":{"event_tree":{"name":"tree-a","tree_hash":"' + 'c'.repeat(64) + '"},"heading":"H1"},' +
      '"condition":{"comparison":"above","holds":"throughout","limit":5,"quantity":"core inlet flow","unit":"kg/s","window":{"from":0,"to":600,"unit":"s"}},' +
      '"plant":{"model_hash":"' + 'a'.repeat(64) + '","model_name":"loop-a","mutation_list_hash":"' + 'b'.repeat(64) + '"},' +
      '"schema":{"id":"sneed.th-criterion","version":1}}';
    expect(criterionHash(c)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  });

  it('does not change with the name, the description, the example label or the time stamps, nor with an extra field', () => {
    const c = clone(oracles.base.criterion) as ThCriterion & { extra?: unknown };
    const h = HASH(c);
    c.criterion.name = 'other';
    c.criterion.description = 'other';
    c.criterion.synthetic = false;
    c.criterion.created = 'x';
    c.criterion.updated = 'y';
    c.extra = { a: 1 };
    expect(HASH(c)).toBe(h);
  });

  it('changes with every field that carries meaning', () => {
    const base = HASH(oracles.base.criterion);
    const edits: [string, unknown][] = [
      ['applies_to.event_tree.name', 'tree-b'],
      ['applies_to.event_tree.tree_hash', 'd'.repeat(64)],
      ['applies_to.heading', 'H2'],
      ['plant.model_name', 'loop-b'],
      ['plant.model_hash', 'd'.repeat(64)],
      ['plant.mutation_list_hash', null],
      ['plant.mutation_list_hash', 'd'.repeat(64)],
      ['condition.quantity', 'core outlet flow'],
      ['condition.comparison', 'at-least'],
      ['condition.limit', 5.0001],
      ['condition.unit', 'lb/s'],
      ['condition.window.from', 1],
      ['condition.window.to', 601],
      ['condition.holds', 'at-some-time'],
    ];
    const seen = new Set<string>([base]);
    for (const [path, v] of edits) {
      const c = clone(oracles.base.criterion);
      setPath(c as unknown as Record<string, unknown>, path, v);
      const h = HASH(c);
      expect(h, path).not.toBe(base);
      seen.add(h);
    }
    expect(seen.size).toBe(edits.length + 1);
  });
});

describe('what a criterion must contain', () => {
  const ok = (): Record<string, unknown> => clone(oracles.base.criterion) as unknown as Record<string, unknown>;
  const codes = (d: unknown, ctx?: Parameters<typeof validateCriterion>[1]): string[] => validateCriterion(d, ctx).errors.map((e) => e.code);

  it('the base criterion is valid; unknown fields are allowed and kept', () => {
    expect(validateCriterion(ok()).valid).toBe(true);
    expect(validateCriterion({ ...ok(), future: 1 }).valid).toBe(true);
  });

  it('refuses what is not an object, with a named code', () => {
    for (const v of [null, 5, 'x', [], undefined]) expect(codes(v)).toEqual(['E_SCHEMA']);
  });

  it('refuses each missing section, naming where', () => {
    for (const key of ['schema', 'criterion', 'applies_to', 'plant', 'condition']) {
      const d = ok();
      delete d[key];
      const v = validateCriterion(d);
      expect(v.valid, key).toBe(false);
      expect(v.errors.some((e) => e.path === `/${key}`), key).toBe(true);
    }
  });

  it('refuses a missing mutation_list_hash (it must say null, not be silent), a bad comparison, a bad holds, a text limit, a window in minutes', () => {
    const cases: [string, unknown][] = [
      ['plant.mutation_list_hash', undefined],
      ['condition.comparison', 'equal'],
      ['condition.holds', 'sometimes'],
      ['condition.limit', 'five'],
      ['condition.window.unit', 'min'],
      ['condition.window.from', -1],
      ['plant.model_hash', 'abc'],
      ['applies_to.heading', 'not an id'],
      ['schema.version', 2],
      ['criterion.synthetic', 'yes'],
    ];
    for (const [p, v] of cases) {
      const d = ok();
      const parts = p.split('.');
      let at = d;
      for (const k of parts.slice(0, -1)) at = at[k] as Record<string, unknown>;
      if (v === undefined) delete at[parts.at(-1)!];
      else at[parts.at(-1)!] = v;
      expect(validateCriterion(d).valid, p).toBe(false);
    }
  });

  it('refuses an infinite number that JSON text can carry (1e999), in the limit and in the window, and never lets it decide anything', () => {
    for (const [field, from, to] of [['limit', '"limit":5', '"limit":1e999'], ['to', '"to":600', '"to":1e999'], ['limit', '"limit":5', '"limit":-1e999']] as const) {
      const text = JSON.stringify(oracles.base.criterion).replace(from, to);
      expect(text, field).toContain(to);
      expect(validateCriterion(JSON.parse(text)).valid, field).toBe(false);
    }
  });

  it('refuses a window that does not end after it starts (equal is refused too)', () => {
    for (const [from, to] of [[10, 10], [10, 5]] as [number, number][]) {
      const d = ok() as { condition: { window: { from: number | undefined; to: number | undefined } } };
      d.condition.window.from = from;
      d.condition.window.to = to;
      expect(codes(d), `${from}-${to}`).toEqual(['E_WINDOW_ORDER']);
    }
  });

  it('checks the tree only when it is given one: unknown tree, changed tree, unknown heading', () => {
    const tree = { hash: 'c'.repeat(64), headings: new Set(['H1', 'H3']) };
    expect(codes(ok(), { resolveTree: () => tree })).toEqual([]);
    expect(codes(ok(), { resolveTree: () => null })).toEqual(['E_NO_TREE']);
    expect(codes(ok(), { resolveTree: () => ({ ...tree, hash: 'd'.repeat(64) }) })).toEqual(['E_STALE_TREE']);
    expect(codes(ok(), { resolveTree: () => ({ ...tree, headings: new Set(['H3']) }) })).toEqual(['E_UNKNOWN_HEADING']);
    expect(codes(ok(), { resolveTree: () => ({ hash: 'd'.repeat(64), headings: new Set<string>() }) }).sort()).toEqual(['E_STALE_TREE', 'E_UNKNOWN_HEADING']);
    expect(codes(ok())).toEqual([]); // no resolver: the document alone
  });

  it('looks the tree up by the name in the document, and quotes names it prints', () => {
    const asked: string[] = [];
    const d = ok() as { applies_to: { event_tree: { name: string } } };
    d.applies_to.event_tree.name = 'a "quoted" tree';
    const v = validateCriterion(d, { resolveTree: (n) => (asked.push(n), null) });
    expect(asked).toEqual(['a "quoted" tree']);
    expect(v.errors[0]!.message).toContain('"a \\"quoted\\" tree"');
  });
});

describe('what an answer record must contain', () => {
  const ok = (): Record<string, unknown> => clone(build({}).answer);
  const codes = (d: unknown): string[] => validateAnswer(d).errors.map((e) => e.code);

  it('the base answer is valid; a failed run may observe nothing; unknown fields are allowed', () => {
    expect(validateAnswer(ok()).valid).toBe(true);
    expect(validateAnswer({ ...ok(), run: { status: 'failed' }, observed: null }).valid).toBe(true);
    expect(validateAnswer({ ...ok(), future: 1 }).valid).toBe(true);
  });

  it('refuses a completed run that observed nothing', () => {
    expect(codes({ ...ok(), observed: null })).toEqual(['E_NO_OBSERVED']);
  });

  it('refuses a smallest value above the largest, and equal values are fine (a flat line)', () => {
    const d = ok() as { observed: { min: number; max: number } };
    d.observed.min = 6;
    d.observed.max = 5;
    expect(codes(d)).toEqual(['E_OBSERVED_ORDER']);
    d.observed.max = 6;
    expect(codes(d)).toEqual([]);
  });

  it('refuses infinity in the values, and a window that does not end after it starts', () => {
    const inf = JSON.parse(JSON.stringify(ok()).replace('"max":9', '"max":1e999')) as unknown;
    expect(validateAnswer(inf).valid).toBe(false);
    const d = ok() as { observed: { window: { from: number; to: number } } };
    d.observed.window.to = 0;
    expect(codes(d)).toEqual(['E_WINDOW_ORDER']);
  });

  it('refuses a record that leaves out any required part (a missing "observed" must say null, not be silent)', () => {
    for (const key of ['schema', 'answer', 'criterion_hash', 'plant', 'engine', 'run', 'observed']) {
      const d = ok();
      delete d[key];
      expect(validateAnswer(d).valid, key).toBe(false);
    }
  });

  it('refuses a record that says it was not entered by hand (this stage has no other source), a bad status and a missing hash', () => {
    for (const edit of [(d: Record<string, any>) => (d.answer.entered_by = 'engine'), (d: Record<string, any>) => (d.run.status = 'ok'), (d: Record<string, any>) => delete d.criterion_hash, (d: Record<string, any>) => (d.criterion_hash = 'abc')]) {
      const d = ok() as Record<string, any>;
      edit(d);
      expect(validateAnswer(d).valid).toBe(false);
    }
  });
});

describe('judge on hostile input', () => {
  const cur = oracles.base.current;
  it('never throws and never claims a result for something that is not a record', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}, { schema: 1 }]) {
      const j = judge(bad, bad, cur);
      expect(j.status).toBe('not-determined');
      expect(j.reasons).toEqual(['criterion-invalid', 'answer-invalid']);
    }
    const b = build({});
    expect(judge(b.criterion, null, cur).reasons).toEqual(['answer-invalid']);
    expect(judge(null, b.answer, cur).reasons).toEqual(['criterion-invalid']);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateModel, validateModelText, type Issue } from '../../src/core/validate.js';

const vecDir = join(import.meta.dirname, '../../schema/vectors');
const expected = JSON.parse(readFileSync(join(vecDir, 'expected.json'), 'utf8')) as Record<string, { errors: string[]; warnings: string[] }>;
const codes = (list: Issue[]): string[] => list.map((i) => i.code).sort();
const load = (rel: string): string => readFileSync(join(vecDir, rel), 'utf8');

const ERROR_CODES = ['E_SCHEMA', 'E_ID_FORMAT', 'E_DUP_ID', 'E_PROB_RANGE', 'E_NO_TOP', 'E_MISSING_REF', 'E_CYCLE', 'E_GATE_ARITY', 'E_VOTE_RANGE', 'E_VOTE_DUP'];

describe('fixtures', () => {
  for (const [rel, want] of Object.entries(expected)) {
    it(`${rel} gives exactly the expected issues`, () => {
      const r = validateModelText(load(rel));
      expect(codes(r.errors)).toEqual(want.errors);
      expect(codes(r.warnings)).toEqual(want.warnings);
      expect(r.valid).toBe(want.errors.length === 0);
    });
  }

  it('every fixture file on disk has an expectation and vice versa', () => {
    const onDisk = ['good', 'bad'].flatMap((k) => readdirSync(join(vecDir, k)).map((f) => `${k}/${f}`)).sort();
    expect(onDisk).toEqual(Object.keys(expected).sort());
  });

  it('every error code has at least one bad fixture that fires it', () => {
    const fired = new Set(Object.entries(expected).filter(([k]) => k.startsWith('bad/')).flatMap(([, v]) => v.errors));
    for (const c of ERROR_CODES) expect(fired.has(c), c).toBe(true);
  });

  it('bad fixture names match the code they fire', () => {
    for (const [rel, want] of Object.entries(expected)) {
      if (!rel.startsWith('bad/')) continue;
      const code = rel.slice(4).split('__')[0]!;
      expect(want.errors, rel).toContain(code);
    }
  });

  it.todo('E_UNSUPPORTED: raised by the Open-PSA importer, which does not exist yet (docs/OPEN-PSA-SUBSET.md)');
});

describe('behaviour beyond the fixtures', () => {
  it('reports every problem, not only the first', () => {
    const d = JSON.parse(load('good/pump3-shared.json'));
    d.events[0].probability = 2; // E_PROB_RANGE
    d.gates[1].inputs = ['P1']; // E_GATE_ARITY
    d.gates[0].inputs = ['S', 'GONE']; // E_MISSING_REF
    const r = validateModel(d);
    expect(codes(r.errors)).toEqual(['E_GATE_ARITY', 'E_MISSING_REF', 'E_PROB_RANGE']);
  });

  it('names the offending IDs so the editor can select them', () => {
    const cyc = validateModelText(load('bad/E_CYCLE__two-gates.json')).errors[0]!;
    expect([...(cyc.ids ?? [])].sort()).toEqual(['G2', 'TOP']);
    expect(cyc.message).toContain('"TOP"');
    const miss = validateModelText(load('bad/E_MISSING_REF__gate-input.json')).errors[0]!;
    expect(miss.ids).toEqual(['TOP', 'ZZ']);
    expect(miss.path).toBe('/gates/0/inputs/2');
    const dup = validateModelText(load('bad/E_DUP_ID__two-events.json')).errors[0]!;
    expect(dup.ids).toEqual(['A']);
  });

  it('keeps the same result for parsed and text input', () => {
    for (const rel of Object.keys(expected)) {
      const text = load(rel);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      expect(validateModel(parsed)).toEqual(validateModelText(text));
    }
  });

  it('reports a cycle once, however many gates enter it', () => {
    const d = JSON.parse(load('good/pump3-shared.json'));
    d.gates.push({ id: 'X', type: 'or', inputs: ['TOP', 'P1'] }, { id: 'Y', type: 'or', inputs: ['TOP', 'P2'] });
    d.gates[1].inputs = ['P1', 'X']; // PUMPS -> X -> TOP -> PUMPS
    const r = validateModel(d);
    expect(r.errors.filter((e) => e.code === 'E_CYCLE')).toHaveLength(1);
  });

  it('does not throw on mutated documents and keeps valid consistent with errors (seeded)', () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const base = JSON.parse(load('good/pump3-shared.json'));
    const junk = [null, 0, -1, 1e9, '', 'x', true, [], {}, [null], { id: 1 }];
    for (let n = 0; n < 400; n++) {
      const d = structuredClone(base);
      for (let m = 0; m < 1 + rnd(3); m++) {
        const paths: (string | number)[][] = [];
        const walk = (v: unknown, p: (string | number)[]): void => {
          paths.push(p);
          if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...p, i]));
          else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], [...p, k]);
        };
        walk(d, []);
        const p = paths[rnd(paths.length)]!;
        if (p.length === 0) continue;
        let t: any = d;
        for (const k of p.slice(0, -1)) t = t[k];
        const last = p[p.length - 1]!;
        if (rnd(4) === 0) {
          if (Array.isArray(t)) t.splice(last as number, 1);
          else delete t[last];
        } else t[last] = junk[rnd(junk.length)];
      }
      const r = validateModel(d);
      expect(r.valid).toBe(r.errors.length === 0);
      for (const i of [...r.errors, ...r.warnings]) {
        expect(typeof i.message).toBe('string');
        expect(i.path.startsWith('/')).toBe(true);
      }
    }
  });
});

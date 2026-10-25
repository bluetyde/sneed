import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canon, modelHash, documentHash } from '../../src/core/canonical.js';

// Third implementation (after Python and Node CJS) of the canonical hash; must reproduce the frozen vectors.
const vec = JSON.parse(readFileSync(join(import.meta.dirname, '../canonical/vectors.json'), 'utf8'));

describe('canonical vectors (tests/canonical/vectors.json)', () => {
  for (const c of vec.number_cases as { value: unknown; canonical: string }[]) {
    it(`number ${String(c.value)} -> ${c.canonical}`, () => {
      expect(canon(c.value === 'neg-zero' ? -0 : c.value)).toBe(c.canonical);
    });
  }
  for (const m of vec.model_cases as { id: string; document_json: string; model_hash: string; document_hash: string }[]) {
    it(`model ${m.id}`, () => {
      expect(modelHash(JSON.parse(m.document_json))).toBe(m.model_hash);
      expect(documentHash(Buffer.from(m.document_json, 'utf8'))).toBe(m.document_hash);
    });
  }
  it('same/differs relations hold against the base model', () => {
    const base = vec.model_cases.find((m: { id: string }) => m.id === 'base').model_hash;
    for (const m of vec.model_cases) {
      if (m.relation_to_base === 'same') expect(m.model_hash, m.id).toBe(base);
      if (m.relation_to_base === 'differs') expect(m.model_hash, m.id).not.toBe(base);
    }
  });
  it('same_as / differs_from relations hold between the cases that name each other', () => {
    const hashOf = (id: string): string => vec.model_cases.find((m: { id: string }) => m.id === id).model_hash;
    for (const m of vec.model_cases) {
      if (m.same_as) expect(m.model_hash, m.id).toBe(hashOf(m.same_as));
      if (m.differs_from) expect(m.model_hash, m.id).not.toBe(hashOf(m.differs_from));
    }
  });
  for (const c of vec.refusal_cases as { id: string; document_json: string; error: string }[]) {
    it(`refuses ${c.id}`, () => {
      expect(() => modelHash(JSON.parse(c.document_json))).toThrow(c.error);
    });
  }
  it('refuses non-finite numbers', () => {
    for (const v of [NaN, Infinity, -Infinity]) expect(() => canon(v)).toThrow();
  });
});

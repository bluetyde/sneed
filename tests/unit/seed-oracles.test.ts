import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSeedOracles } from '../../scripts/lib/seed-oracles.js';
import { validateModelText } from '../../src/core/validate.js';
import { enumerate } from '../oracle/enumerate.js';
import { ORACLE_MODELS } from '../oracle/models.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BASE = path.join(ROOT, 'oracles', 'seed');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
/** Independent of src/core/canonical.ts: the contract's canonical JSON (sorted keys at every depth, no whitespace). */
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v !== null && typeof v === 'object'
      ? '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}'
      : JSON.stringify(v);

const entries = readdirSync(path.join(BASE, 'entries'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({ file: f, doc: JSON.parse(readFileSync(path.join(BASE, 'entries', f), 'utf8')) as any }));

describe('generated files', () => {
  it('equal what the generator would write now (no hand edits, no drift from the sources)', () => {
    const expected = buildSeedOracles();
    for (const g of expected) expect(readFileSync(path.join(BASE, g.path), 'utf8'), g.path).toBe(g.text);
    const onDisk = ['entries', 'models'].flatMap((d) => readdirSync(path.join(BASE, d)).map((f) => `${d}/${f}`)).sort();
    expect(onDisk).toEqual(expected.map((g) => g.path).sort());
  });

  it('there are 11 good entries and 3 bad-input entries, and no approximation or limit row', () => {
    expect(entries.filter((e) => e.doc.tag === 'good')).toHaveLength(11);
    expect(entries.filter((e) => e.doc.tag === 'bad-input')).toHaveLength(3);
    for (const e of entries) expect(e.doc.oracleId).not.toMatch(/rare|mcub|trunc|unsupported/);
  });
});

describe('each entry is self-consistent', () => {
  for (const { file, doc } of entries) {
    it(file, () => {
      expect(doc.oracleId + '.json').toBe(file);
      expect(doc.adapter).toBe('pra');
      expect(doc.inputs).toHaveLength(1);
      const bytes = readFileSync(path.join(BASE, doc.inputs[0].path));
      expect(doc.inputs[0].sha256).toBe(sha(bytes)); // the pinned input is the file on disk, byte for byte
      expect(doc.toleranceHash).toBe(sha(canonical({ expected: doc.expected, tolerance: doc.tolerance ?? null })));
      expect(doc.coverage.domain).toMatch(/\S/);
      expect(doc.source.text).toMatch(/\S/);
    });
  }
});

describe('expected values are independently right', () => {
  it('every good entry equals exhaustive enumeration of its model within its own tolerance', () => {
    for (const { doc } of entries.filter((e) => e.doc.tag === 'good')) {
      const model = JSON.parse(readFileSync(path.join(BASE, doc.inputs[0].path), 'utf8'));
      expect(model).toEqual(ORACLE_MODELS[doc.oracleId]);
      const got = enumerate(model).probability.toNumber();
      expect(Math.abs(got - doc.expected.value), doc.oracleId).toBeLessThanOrEqual(doc.tolerance.abs);
      expect(doc.expected).toMatchObject({ quantity: 'top_event_probability', unit: '1' });
      expect(doc.tolerance).toEqual({ abs: 1e-12, rel: 0 });
    }
  });

  it('every bad-input entry names a code that our validator really reports for its model', () => {
    for (const { doc } of entries.filter((e) => e.doc.tag === 'bad-input')) {
      const v = validateModelText(readFileSync(path.join(BASE, doc.inputs[0].path), 'utf8'));
      expect(v.valid, doc.oracleId).toBe(false);
      expect(v.errors.map((i) => i.code), doc.oracleId).toContain(doc.expected.refusalCode);
    }
  });

  it('every good entry model is accepted by our validator', () => {
    for (const { doc } of entries.filter((e) => e.doc.tag === 'good')) {
      expect(validateModelText(readFileSync(path.join(BASE, doc.inputs[0].path), 'utf8')).valid, doc.oracleId).toBe(true);
    }
  });
});

// SEED's own schema, read from the sibling checkout. Nothing is imported from SEED and nothing there is written.
const SEED = process.env.SEED_REPO ?? path.join(ROOT, '..', 'experiment-studio');
const seedSchemas = path.join(SEED, 'schema');
describe.skipIf(!existsSync(path.join(seedSchemas, 'oracle.schema.json')))("against SEED's seed.oracle/0.1 schema (read-only)", () => {
  const Ajv2020 = createRequire(import.meta.url)('ajv/dist/2020.js') as { default?: new (o: object) => any } & (new (o: object) => any);
  const make = (): any => {
    const Ctor = Ajv2020.default ?? Ajv2020;
    const ajv = new Ctor({ allErrors: true, strict: false });
    ajv.addSchema(JSON.parse(readFileSync(path.join(seedSchemas, 'common.schema.json'), 'utf8')));
    return ajv.compile(JSON.parse(readFileSync(path.join(seedSchemas, 'oracle.schema.json'), 'utf8')));
  };
  it('every entry validates', () => {
    const validate = make();
    for (const { file, doc } of entries) expect(validate(doc), `${file}: ${JSON.stringify(validate.errors)}`).toBe(true);
  });
  it('the schema really rejects a broken entry (the check is not vacuous)', () => {
    const validate = make();
    const broken = { ...entries[0]!.doc, schema: 'seed.oracle/9.9' };
    expect(validate(broken)).toBe(false);
    const noPin = { ...entries[0]!.doc };
    delete noPin.toleranceHash;
    expect(validate(noPin)).toBe(false);
  });
});

// Builds the SEED-format oracle entries (seed.oracle/0.1) and their model files from tests/oracles.json, the hand-oracle builders
// in tests/oracle/models.ts and the bad-model vectors in schema/vectors/bad. The files under oracles/seed/ are generated output:
// edit the sources and run `npm run gen:seed-oracles`, never the files (a test fails if they drift).
//
// What is NOT exported, and why: seed.oracle/0.1 carries no run settings, so SEED runs every entry with the default method
// (exact). The rare-event and min-cut-upper-bound rows, and the product-order-limit row (pra-trunc), need a method or a limit
// and stay in tests/oracles.json only. Cut sets are checked by our own tests; a SEED entry holds one number.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canon } from '../../src/core/canonical.js';
import { ORACLE_MODELS } from '../../tests/oracle/models.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const sha256 = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

interface Source {
  id: string;
  type: string;
  model: string;
  expected_probability?: number;
  method?: string;
  derivation?: string;
  tolerance?: { absolute: number; relative: number };
  expected_error?: string;
}

/** The refusal rows and the existing bad-model vector that reproduces each (the model must trigger exactly this code). */
const REFUSAL_VECTORS: Record<string, string> = {
  'pra-bad-prob': 'E_PROB_RANGE__above-one.json',
  'pra-cycle': 'E_CYCLE__two-gates.json',
  'pra-missing': 'E_MISSING_REF__gate-input.json',
};

const CHECK =
  'Second method: exhaustive enumeration over every failure state of the reachable basic events with exact rational arithmetic (tests/oracle/enumerate.ts), which agrees with the hand derivation exactly; and the same model run through SCRAM in the engine tests.';

export interface Generated {
  /** Path relative to oracles/seed. */
  path: string;
  text: string;
}

export function buildSeedOracles(): Generated[] {
  const sources = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'oracles.json'), 'utf8')) as Source[];
  const out: Generated[] = [];
  const model = (id: string, text: string): string => {
    out.push({ path: `models/${id}.json`, text });
    return sha256(text);
  };

  for (const s of sources.filter((x) => x.type === 'numerical' && x.method === 'exact')) {
    const doc = ORACLE_MODELS[s.id];
    if (!doc) throw new Error(`no model builder for ${s.id}`);
    const modelHash = model(s.id, JSON.stringify(doc, null, 2) + '\n');
    const expected = { quantity: 'top_event_probability', value: s.expected_probability!, unit: '1' };
    const tolerance = { abs: s.tolerance!.absolute, rel: s.tolerance!.relative };
    const entry = {
      schema: 'seed.oracle/0.1',
      oracleId: s.id,
      entryVersion: 1,
      adapter: 'pra',
      adapterVersions: ['*'],
      tag: 'good',
      inputs: [{ path: `models/${s.id}.json`, sha256: modelHash }],
      expected,
      tolerance,
      source: { kind: 'hand', text: `${s.model}. Exact top-event probability by hand: ${s.derivation}.`, check: CHECK },
      coverage: { quantities: ['top_event_probability'], domain: `static fault tree with constant, independent basic-event probabilities, exact method: ${s.model}` },
      toleranceHash: sha256(canon({ expected, tolerance })),
    };
    out.push({ path: `entries/${s.id}.json`, text: JSON.stringify(entry, null, 2) + '\n' });
  }

  for (const s of sources.filter((x) => x.type === 'refusal' && x.id in REFUSAL_VECTORS)) {
    const bytes = readFileSync(path.join(ROOT, 'schema', 'vectors', 'bad', REFUSAL_VECTORS[s.id]!), 'utf8');
    const modelHash = model(s.id, bytes);
    const expected = { refusalCode: s.expected_error! };
    const entry = {
      schema: 'seed.oracle/0.1',
      oracleId: s.id,
      entryVersion: 1,
      adapter: 'pra',
      adapterVersions: ['*'],
      tag: 'bad-input',
      inputs: [{ path: `models/${s.id}.json`, sha256: modelHash }],
      expected,
      source: { kind: 'analytic', text: `${s.model}: a model the schema and the cross-reference checks must refuse with ${s.expected_error}, because the document itself breaks the rule (the vector is schema/vectors/bad/${REFUSAL_VECTORS[s.id]}).` },
      coverage: { quantities: ['top_event_probability'], domain: `refusal of an invalid model: ${s.model}` },
      toleranceHash: sha256(canon({ expected, tolerance: null })),
    };
    out.push({ path: `entries/${s.id}.json`, text: JSON.stringify(entry, null, 2) + '\n' });
  }
  return out;
}

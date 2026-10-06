import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeEventTreeBuiltin, type EventTreeOutcome } from '../../src/engines/bdd/event-tree-analyze.js';
import { BDD_SOURCE_SHA256 } from '../../src/engines/bdd/build-id.js';
import { modelHash } from '../../src/core/canonical.js';
import { skeletonSequences, type PathStep } from '../../src/core/event-tree.js';
import { eventTreeFailureText, type EventTreeResult } from '../../src/core/event-tree-result.js';
import type { NativeModel } from '../../src/core/model.js';
import { AND, mkDoc, OR } from '../oracle/models.js';

const SHARED = mkDoc('TOP', { S: 0.1, a: 0.2, b: 0.3 }, [OR('TOP', ['X', 'Y']), OR('X', ['S', 'a']), OR('Y', ['S', 'b'])]);
const ASSUME = { frequency_unit: 'per-year', probability_basis: 'per-demand', independence: 'declared-independent', ie_independent_of_events: true, success_branches: 'exact' };
const END = [
  { id: 'SAFE', name: 'Safe (example)', description: 'Nothing lost (example).', synthetic: true },
  { id: 'DEGRADED', name: 'Degraded (example)', description: 'One function lost (example).', synthetic: true },
  { id: 'LOSS', name: 'Loss of cooling (example)', description: 'Both lost (example).', synthetic: true },
];
const byFailures = (p: PathStep[]): string => (p.filter((s) => s.branch === 'fails').length === 0 ? 'SAFE' : p.filter((s) => s.branch === 'fails').length === 1 ? 'DEGRADED' : 'LOSS');

function treeDoc(model: ReturnType<typeof mkDoc>, name: string, headings: Record<string, unknown>[], frequency = 0.5): Record<string, any> {
  return {
    schema: { id: 'sneed.event-tree', version: 1 },
    tree: { id: 'et', name: 'Test', created: '2026-10-06T00:00:00Z', updated: '2026-10-06T00:00:00Z' },
    fault_tree_model: { name, model_hash: modelHash(model as unknown as NativeModel) },
    initiating_event: { name: 'Transient (example)', description: 'An example.', frequency, unit: 'per-year' },
    headings,
    end_states: END,
    sequences: skeletonSequences(headings as never).map((s) => ({ path: s.path, end_state: byFailures(s.path) })),
    assumptions: ASSUME,
  };
}
const SHARED_HEADS = [{ id: 'A', name: 'Function A', event: 'X' }, { id: 'B', name: 'Function B', event: 'Y' }];

/** n pairs (Ai, Bi): F = OR of the ANDs, with two earlier headings that put all the A variables before all the B variables: an exponential diagram. */
function heavyModel(n: number): ReturnType<typeof mkDoc> {
  const events: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    events[`A${i}`] = 0.1;
    events[`B${i}`] = 0.1;
  }
  const pairs = Array.from({ length: n }, (_, i) => AND(`P${i}`, [`A${i}`, `B${i}`]));
  return mkDoc('TOP', events, [OR('TOP', ['PA', 'PB', 'F']), OR('PA', Array.from({ length: n }, (_, i) => `A${i}`)), OR('PB', Array.from({ length: n }, (_, i) => `B${i}`)), OR('F', pairs.map((g) => g.id)), ...pairs]);
}
const HEAVY_HEADS = [{ id: 'H1', name: 'A side', event: 'PA' }, { id: 'H2', name: 'B side', event: 'PB' }, { id: 'H3', name: 'Pairs', event: 'F' }];

const dirs: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'sneed-etrun-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const ran = (o: EventTreeOutcome): { runDir: string; record: EventTreeResult } => {
  if (o.kind !== 'ran') throw new Error('refused: ' + JSON.stringify(o.errors));
  return o;
};
const model = (m: ReturnType<typeof mkDoc>): string => JSON.stringify(m);

describe('analysing an event tree', () => {
  it('writes a complete record of its own kind with the numbers of plan 13, 6.2, the engine build and the hashes', async () => {
    const runsDir = temp();
    const tree = JSON.stringify(treeDoc(SHARED, 'shared', SHARED_HEADS), null, 2) + '\n';
    const { runDir, record } = ran(await analyzeEventTreeBuiltin(tree, model(SHARED), { runsDir }));
    expect(record).toMatchObject({ schema: { id: 'sneed.event-tree-result', version: 1 }, status: 'completed', completeness: 'complete', reasons: [], quantity: 'sequence_frequency', unit: 'per-year', method: 'exact-joint', approximation: null });
    expect(record.engine).toEqual({ name: 'sneed-bdd', version: '0.1.0', sha256: BDD_SOURCE_SHA256, runtime: null });
    expect(record.input_hashes.model_hash).toBe(modelHash(SHARED as unknown as NativeModel));
    expect(record.input_hashes.tree_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.input_hashes.document_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.assumptions).toEqual(ASSUME);
    const f = (key: string): number => record.sequences.find((s) => s.key === key)!.frequency;
    expect(f('A:fails,B:fails')).toBeCloseTo(0.077, 14);
    expect(f('A:fails,B:works')).toBeCloseTo(0.063, 14);
    expect(f('A:works,B:fails')).toBeCloseTo(0.108, 14);
    expect(f('A:works,B:works')).toBeCloseTo(0.252, 14);
    expect(record.sequences.every((s) => s.share === s.probability && s.frequency === 0.5 * s.probability || Math.abs(s.frequency - 0.5 * s.probability) < 1e-16)).toBe(true);
    expect(record.total!.frequency).toBeCloseTo(0.5, 15);
    expect(record.total!.partition_error).toBeLessThan(1e-15);
    const degraded = record.end_states.find((e) => e.id === 'DEGRADED')!;
    expect(degraded).toMatchObject({ name: 'Degraded (example)', synthetic: true, sequences: ['A:works,B:fails', 'A:fails,B:works'] });
    expect(degraded.frequency).toBeCloseTo(0.171, 14);
    expect(record.caveats.join(' ')).toContain('not a plant figure');
    expect(record.caveats.join(' ')).toContain('synthetic');
    // the folder: the inputs exactly as submitted, and the record as written
    expect(readFileSync(path.join(runDir, 'native', 'event-tree.json'), 'utf8')).toBe(tree);
    expect(readFileSync(path.join(runDir, 'native', 'model.json'), 'utf8')).toBe(model(SHARED));
    expect(JSON.parse(readFileSync(path.join(runDir, 'event-tree-results.json'), 'utf8'))).toEqual(record);
    expect(readdirSync(runDir).sort()).toEqual(['event-tree-results.json', 'native']);
  }, 30000);

  it('the labelled approximation is there only when asked, and says what it is', async () => {
    const tree = JSON.stringify(treeDoc(SHARED, 'shared', SHARED_HEADS));
    const plain = ran(await analyzeEventTreeBuiltin(tree, model(SHARED), { runsDir: temp() })).record;
    expect(plain.approximation).toBeNull();
    expect(plain.sequences.every((s) => s.approximation === undefined)).toBe(true);
    const asked = ran(await analyzeEventTreeBuiltin(tree, model(SHARED), { runsDir: temp(), approximation: true })).record;
    expect(asked.approximation).toMatchObject({ method: 'success-branches-ignored' });
    expect(asked.approximation!.note).toContain('different kind of number');
    expect(asked.approximation!.frequency_sum).toBeCloseTo(0.5 * 1.804, 13);
    const row = asked.sequences.find((s) => s.key === 'A:fails,B:works')!;
    expect(row.approximation!.frequency).toBeCloseTo(0.14, 14);
    expect(row.approximation!.ratio_to_exact).toBeCloseTo(2.2222222222222223, 12);
    expect(asked.sequences.map((s) => s.frequency)).toEqual(plain.sequences.map((s) => s.frequency)); // the exact numbers are the same either way
  }, 30000);

  it('a path with probability 0 has no ratio to the approximation (not a division by zero)', async () => {
    const m = mkDoc('TOP', { SURE: 1, C: 0.5 }, [OR('TOP', ['G', 'C']), OR('G', ['SURE', 'C'])]);
    const tree = JSON.stringify(treeDoc(m, 'm', [{ id: 'A', name: 'A', event: 'G' }]));
    const { record } = ran(await analyzeEventTreeBuiltin(tree, model(m), { runsDir: temp(), approximation: true }));
    const worksRow = record.sequences.find((s) => s.key === 'A:works')!;
    expect(worksRow.probability).toBe(0);
    expect(worksRow.approximation!.ratio_to_exact).toBeNull();
  }, 30000);
});

describe('refusals write nothing', () => {
  const refused = async (tree: unknown, m: ReturnType<typeof mkDoc> | string = SHARED): Promise<string[]> => {
    const runsDir = temp();
    const o = await analyzeEventTreeBuiltin(typeof tree === 'string' ? tree : JSON.stringify(tree), typeof m === 'string' ? m : model(m), { runsDir });
    expect(o.kind).toBe('refused');
    expect(readdirSync(runsDir)).toEqual([]);
    return o.kind === 'refused' ? o.errors.map((e) => e.code) : [];
  };

  it('an invalid tree, a stale tree (the model changed), an invalid model and text that is not JSON', async () => {
    const good = treeDoc(SHARED, 'shared', SHARED_HEADS);
    expect(await refused({ ...good, sequences: good.sequences.slice(1) })).toEqual(['E_SEQUENCES_MISSING']);
    expect(await refused({ ...good, headings: [{ ...SHARED_HEADS[0], event: 'NOPE' }, SHARED_HEADS[1]] })).toContain('E_UNKNOWN_EVENT');
    const other = mkDoc('TOP', { S: 0.5, a: 0.2, b: 0.3 }, [OR('TOP', ['X', 'Y']), OR('X', ['S', 'a']), OR('Y', ['S', 'b'])]);
    expect(await refused(good, other)).toEqual(['E_STALE_MODEL']); // the model changed: its hash differs
    expect(await refused('{"top":"X"}')).toEqual(expect.arrayContaining(['E_SCHEMA']));
    expect(await refused('{nope')).toEqual(['E_SCHEMA']);
    expect(await refused(good, '{"top":"X"}')).toEqual(['E_MODEL_NOT_FOUND']);
  });
});

describe('failures are records with a reason and no numbers', () => {
  it('a sequence below the arithmetic range: failed, numeric-range, in words', async () => {
    const events: Record<string, number> = {};
    for (let i = 0; i < 200; i++) events[`E${i}`] = 0.001;
    const m = mkDoc('TOP', { ...events, Z: 0.5 }, [OR('TOP', ['BIG', 'Z']), AND('BIG', Object.keys(events))]);
    const tree = JSON.stringify(treeDoc(m, 'big', [{ id: 'A', name: 'A', event: 'BIG' }, { id: 'B', name: 'B', event: 'Z' }]));
    const runsDir = temp();
    const { runDir, record } = ran(await analyzeEventTreeBuiltin(tree, model(m), { runsDir }));
    expect(record).toMatchObject({ status: 'failed', completeness: 'unknown', reasons: ['numeric-range'], sequences: [], end_states: [], total: null, approximation: null });
    expect(JSON.parse(readFileSync(path.join(runDir, 'event-tree-results.json'), 'utf8')).status).toBe('failed');
    expect(eventTreeFailureText('numeric-range')).toContain('1e-300');
  }, 30000);

  it('already cancelled, out of time before it starts, and a result that arrives after the deadline are never accepted', async () => {
    const tree = JSON.stringify(treeDoc(SHARED, 'shared', SHARED_HEADS));
    const ctl = new AbortController();
    ctl.abort();
    expect(ran(await analyzeEventTreeBuiltin(tree, model(SHARED), { runsDir: temp(), signal: ctl.signal })).record).toMatchObject({ status: 'cancelled', reasons: ['cancelled'], sequences: [] });
    expect(ran(await analyzeEventTreeBuiltin(tree, model(SHARED), { runsDir: temp(), timeoutMs: 0 })).record).toMatchObject({ status: 'failed', reasons: ['timeout'] });
    let t = 0;
    const late = await analyzeEventTreeBuiltin(tree, model(SHARED), { runsDir: temp(), timeoutMs: 1000, now: () => (t += 600) }); // 600 at the start, 1200 after the engine: past the deadline
    expect(ran(late).record).toMatchObject({ status: 'failed', reasons: ['timeout'], sequences: [] });
  }, 30000);

  it('a cancel while a slow model is being evaluated stops it: a cancelled record, long before the model would have finished', async () => {
    const m = heavyModel(20); // the headings put the pair variables in a bad order: about 2 million nodes, seconds of work
    const tree = JSON.stringify(treeDoc(m, 'heavy', HEAVY_HEADS));
    const ctl = new AbortController();
    const started = Date.now();
    const p = analyzeEventTreeBuiltin(tree, model(m), { runsDir: temp(), signal: ctl.signal });
    setTimeout(() => ctl.abort(), 300);
    const o = ran(await p);
    expect(o.record).toMatchObject({ status: 'cancelled', completeness: 'unknown', reasons: ['cancelled'], sequences: [] });
    expect(Date.now() - started).toBeLessThan(3000);
  }, 30000);

  it('a cancel while the worker computes is heard', async () => {
    const events: Record<string, number> = {};
    for (let i = 0; i < 400; i++) events[`E${i}`] = 0.5;
    const ids = Object.keys(events);
    const gates = [OR('TOP', ['P', 'Q']), AND('P', ids.slice(0, 200)), AND('Q', ids.slice(200))];
    const m = mkDoc('TOP', events, gates);
    const tree = JSON.stringify(treeDoc(m, 'wide', [{ id: 'A', name: 'A', event: 'P' }, { id: 'B', name: 'B', event: 'Q' }]));
    const ctl = new AbortController();
    const started = Date.now();
    const p = analyzeEventTreeBuiltin(tree, model(m), { runsDir: temp(), signal: ctl.signal });
    setTimeout(() => ctl.abort(), 5);
    const o = ran(await p);
    expect(['cancelled', 'completed']).toContain(o.record.status); // a fast machine may finish first; it must never hang or mix
    expect(Date.now() - started).toBeLessThan(20000);
  }, 30000);

  it('refuses to reuse a run folder and a weak run id', async () => {
    const tree = JSON.stringify(treeDoc(SHARED, 'shared', SHARED_HEADS));
    const runsDir = temp();
    ran(await analyzeEventTreeBuiltin(tree, model(SHARED), { runsDir, runId: 'et-first-run' }));
    await expect(analyzeEventTreeBuiltin(tree, model(SHARED), { runsDir, runId: 'et-first-run' })).rejects.toThrow(/already exists/);
    await expect(analyzeEventTreeBuiltin(tree, model(SHARED), { runsDir, runId: 'short' })).rejects.toThrow(/at least 8/);
  }, 30000);
});

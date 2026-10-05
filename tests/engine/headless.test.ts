import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { analyze, type AnalyzeOptions, type AnalyzeOutcome } from '../../src/core/analyze.js';
import { documentHash, modelHash } from '../../src/core/canonical.js';
import { engineIdentity } from '../../src/core/engine.js';
import { ENGINE, FROM_RUNTIME } from './engine.js';
import type { ResultRecord } from '../../src/core/result.js';
import { enumerate } from '../oracle/enumerate.js';
import { qFromNumber } from '../oracle/rational.js';
import { AND, NATIVE_VOTE, OR, ORACLE_MODELS, VOTE, mkDoc, randomDoc, type Doc } from '../oracle/models.js';

// Headless acceptance: native document -> validated snapshot -> Open-PSA XML -> SCRAM -> parsed, checked record,
// compared with the frozen hand oracles and the independent enumeration oracle. Needs the pinned SCRAM build in WSL.
const ROOT = path.resolve(import.meta.dirname, '../..');
const RUNS = path.join(ROOT, 'runs', 'test-engine');
const oracles = JSON.parse(readFileSync(path.join(ROOT, 'tests/oracles.json'), 'utf8')) as {
  id: string;
  type: string;
  method?: string;
  expected_probability?: number;
  expected_cut_sets?: string[][];
  tolerance?: { absolute: number };
}[];

const text = (d: unknown): string => JSON.stringify(d);
const ran = (o: AnalyzeOutcome): { runDir: string; record: ResultRecord } => {
  if (o.kind !== 'ran') throw new Error('expected a run, got a refusal: ' + o.errors.map((e) => e.code).join(','));
  return o;
};
const run = async (d: unknown, opts: Partial<AnalyzeOptions> = {}): Promise<{ runDir: string; record: ResultRecord }> => ran(await analyze(text(d), { runsDir: RUNS, engine: ENGINE, ...opts }));
const sorted = (sets: string[][]): string[][] => sets.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));
const cutSets = (r: ResultRecord): string[][] => sorted(r.minimal_cut_sets.map((c) => c.events));
const REL = 1e-5; // the engine prints about 6 significant digits
const near = (got: number, want: number): boolean => Math.abs(got - want) <= Math.max(1e-12, REL * Math.abs(want));
const dirCount = (): number => (existsSync(RUNS) ? readdirSync(RUNS).length : 0);

beforeAll(() => {
  rmSync(RUNS, { recursive: true, force: true });
  mkdirSync(RUNS, { recursive: true });
});

describe('the pinned engine', () => {
  it(FROM_RUNTIME ? 'is exactly the build the installer recorded' : 'is exactly the build the spike recorded', async () => {
    const id = await engineIdentity(ENGINE);
    expect(id).toEqual({ name: 'SCRAM', version: '0.16.2', sha256: ENGINE.expectedSha256 });
  }, 60000);
});

describe('frozen hand oracles through the whole pipeline', () => {
  for (const e of oracles.filter((o) => o.type === 'numerical')) {
    it(`${e.id} (${e.method})`, async () => {
      const method = e.method === 'rare-event' ? 'rare-event' : e.method === 'mcub' ? 'mcub' : 'exact';
      const { record } = await run(ORACLE_MODELS[e.id], { settings: { method } });
      expect(record.reasons).toEqual([]);
      expect(record).toMatchObject({ status: 'completed', completeness: 'complete', method });
      expect(Math.abs(record.top_event_probability! - e.expected_probability!)).toBeLessThanOrEqual(e.tolerance!.absolute);
      expect(cutSets(record)).toEqual(sorted(e.expected_cut_sets!));
    }, 120000);
  }

  it('the native voting gate (atleast) gives the same answer as the AND/OR expansion', async () => {
    const { record } = await run(NATIVE_VOTE);
    expect(record.status).toBe('completed');
    expect(record.top_event_probability).toBe(0.028);
    expect(cutSets(record)).toEqual([['A', 'B'], ['A', 'C'], ['B', 'C']]);
  }, 120000);

  it('a voting gate with two inputs that are the same event is rewritten and still right', async () => {
    // G1 = A AND A is A, so V is "2 of [A, A, B]": true when A fails, which is the single cut set {A}
    const d = mkDoc('V', { A: 0.1, B: 0.2 }, [VOTE('V', ['G1', 'A', 'B'], 2), AND('G1', ['A', 'A'])]);
    const { record, runDir } = await run(d);
    expect(record).toMatchObject({ status: 'completed', completeness: 'complete', top_event_probability: 0.1 });
    expect(cutSets(record)).toEqual([['A']]);
    expect(JSON.parse(readFileSync(path.join(runDir, 'inputs/settings.json'), 'utf8')).export_mapping.expandedVotes).toEqual(['V']);
  }, 120000);

  it('SCRAM 0.16.2 mishandles atleast over [C, A, G0 = A or C, B]: the default export avoids it (engine bug, pinned)', async () => {
    // Oracle (hand-checkable): A alone fails the gate (A and G0 are both true), so does C alone; B needs a partner that is already a cut set.
    const d = mkDoc('TOP', { A: 0.1, B: 0.2, C: 0.3 }, [VOTE('TOP', ['C', 'A', 'G0', 'B'], 2), OR('G0', ['A', 'C'])]);
    const want = enumerate(d);
    expect(want.cutSets).toEqual([['A'], ['C']]);
    expect(want.probability.eq(qFromNumber(0.37))).toBe(true);

    const safe = (await run(d)).record; // default 'auto': a gate input forces the AND/OR rewrite
    expect(safe).toMatchObject({ status: 'completed', top_event_probability: 0.37 });
    expect(cutSets(safe)).toEqual([['A'], ['C']]);
    expect((await run(d, { voting: 'expand' })).record.top_event_probability).toBe(0.37);

    // The engine's own atleast gives a different answer and the record cannot tell (status is completed). If SCRAM is
    // ever upgraded and this assertion starts failing, the bug is fixed: re-run the spike and revisit the export rule.
    const raw = (await run(d, { voting: 'native' })).record;
    expect(raw.status).toBe('completed');
    expect(cutSets(raw)).not.toEqual([['A'], ['C']]);
    expect(raw.top_event_probability).not.toBe(0.37);
  }, 180000);

  it('a voting gate that would expand past the term limit is refused before any run', async () => {
    const ev = Array.from({ length: 13 }, (_, i) => `E${i}`);
    const d = mkDoc('V', Object.fromEntries(ev.map((e) => [e, 0.1])), [VOTE('V', [...ev, 'G'], 7), OR('G', ['E0', 'E1'])]);
    const before = dirCount();
    const out = await analyze(text(d), { runsDir: RUNS });
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.errors.map((e) => e.code)).toEqual(['E_EXPORT_LIMIT']);
    expect(dirCount()).toBe(before);
  }, 60000);

  it('probabilities of exactly 0 and 1 keep their structural cut sets', async () => {
    const zero = (await run(mkDoc('TOP', { A: 0, B: 0.5 }, [AND('TOP', ['A', 'B'])]))).record;
    expect(zero).toMatchObject({ status: 'completed', top_event_probability: 0 });
    expect(cutSets(zero)).toEqual([['A', 'B']]);
    const one = (await run(mkDoc('TOP', { A: 1, B: 0.5 }, [OR('TOP', ['A', 'B'])]))).record;
    expect(one).toMatchObject({ status: 'completed', top_event_probability: 1 });
    expect(cutSets(one)).toEqual([['A'], ['B']]);
  }, 120000);

  it('very small probabilities survive the XML round trip', async () => {
    const { record } = await run(mkDoc('TOP', { A: 1e-7, B: 1e-7 }, [AND('TOP', ['A', 'B'])]));
    expect(record.status).toBe('completed');
    expect(near(record.top_event_probability!, 1e-14)).toBe(true);
  }, 120000);

  it('event names that look like the engine\'s own tree name or reserved words are fine', async () => {
    const { record } = await run(mkDoc('TOP', { SNEED: 0.1, and: 0.2, FT: 0.5 }, [AND('TOP', ['SNEED', 'and', 'FT'])]));
    expect(record).toMatchObject({ status: 'completed', top_event_probability: 0.01 });
  }, 120000);
});

describe('refusals happen before any run exists', () => {
  const bad = readdirSync(path.join(ROOT, 'schema/vectors/bad')).filter((f) => f.endsWith('.json'));
  it('every bad fixture is refused with typed errors and creates no run directory', async () => {
    expect(bad.length).toBeGreaterThanOrEqual(30);
    const before = dirCount();
    for (const f of bad) {
      const out = await analyze(readFileSync(path.join(ROOT, 'schema/vectors/bad', f), 'utf8'), { runsDir: RUNS, engine: ENGINE });
      expect(out.kind, f).toBe('refused');
      if (out.kind === 'refused') {
        const code = f.split('__')[0]!;
        expect(out.errors.map((e) => e.code), f).toContain(code);
      }
    }
    expect(dirCount()).toBe(before);
  }, 120000);
});

describe('engine-side failures are never a success', () => {
  const doc = ORACLE_MODELS['pra-and']!;

  it('an input the engine refuses (probability out of range) fails with the engine error class and keeps the evidence', async () => {
    const { record, runDir } = await run(doc, { transformXml: (x) => x.replace('<float value="0.1"/>', '<float value="1.2"/>') });
    expect(record).toMatchObject({ status: 'failed', completeness: 'unknown', top_event_probability: null });
    expect(record.reasons).toEqual(['engine-exit-1', 'engine-error:scram::mef::DomainError']);
    expect(readFileSync(path.join(runDir, 'log/stderr.txt'), 'utf8')).toContain('DomainError');
    expect(existsSync(path.join(runDir, 'native/report.xml'))).toBe(false);
  }, 120000);

  it('malformed XML fails', async () => {
    const { record } = await run(doc, { transformXml: (x) => x.slice(0, x.length - 30) });
    expect(record.status).toBe('failed');
    expect(record.reasons).toContain('engine-error:scram::xml::ParseError');
  }, 120000);

  it('a reference to an undefined event fails', async () => {
    const { record } = await run(doc, { transformXml: (x) => x.replace('<basic-event name="B"/>', '<basic-event name="ZZ"/>') });
    expect(record.status).toBe('failed');
    expect(record.reasons).toContain('engine-error:scram::mef::ValidityError');
  }, 120000);

  it('a different engine version is a failure, not a silently accepted result', async () => {
    const { record } = await run(doc, { engine: { ...ENGINE, expectedVersion: '9.9.9' } });
    expect(record.status).toBe('failed');
    expect(record.reasons).toEqual(['engine-version-mismatch']);
  }, 120000);

  it('a binary that is not the pinned build is refused before it runs', async () => {
    const { record, runDir } = await run(doc, { engine: { ...ENGINE, expectedSha256: '0'.repeat(64) } });
    expect(record).toMatchObject({ status: 'failed', reasons: ['engine-build-mismatch'] });
    expect(existsSync(path.join(runDir, 'log/stdout.txt'))).toBe(false);
    expect(existsSync(path.join(runDir, 'native/report.xml'))).toBe(false);
  }, 120000);

  it('a timeout is a failure with unknown completeness', async () => {
    const { record } = await run(doc, { timeoutMs: 1 });
    expect(['failed']).toContain(record.status);
    expect(record.reasons).toEqual(['timeout']);
  }, 120000);

  it('cancellation before the engine finishes is recorded as cancelled', async () => {
    const abort = new AbortController();
    abort.abort();
    const { record } = await run(doc, { signal: abort.signal });
    expect(record).toMatchObject({ status: 'cancelled', completeness: 'unknown', reasons: ['cancelled'], top_event_probability: null });
  }, 120000);
});

describe('truncation is detected, not trusted', () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `E${i}`);

  it('an explicit low product-order limit that drops every cut set is truncated, with the diagnostic probability kept', async () => {
    const d = mkDoc('TOP', { A: 0.1, B: 0.2, C: 0.3 }, [AND('TOP', ['A', 'B', 'C'])]);
    const { record } = await run(d, { settings: { limitOrder: 2 } });
    expect(record).toMatchObject({ status: 'truncated', completeness: 'truncated', reasons: ['product-order-limit-effective'] });
    expect(record.top_event_probability).toBeCloseTo(0.006, 9);
    expect(record.minimal_cut_sets).toEqual([]);
    expect(record.warnings).toEqual(['The set is NULL/Empty.']);
  }, 120000);

  it('a partial drop (a short cut set kept, a long one lost) is detected from the probability', async () => {
    const d = mkDoc('TOP', { A: 0.1, B: 0.2, C: 0.5, D: 0.5, E: 0.5 }, [OR('TOP', ['L', 'S']), AND('L', ['C', 'D', 'E']), AND('S', ['A', 'B'])]);
    const cut = await run(d, { settings: { limitOrder: 2 } });
    expect(cut.record).toMatchObject({ status: 'truncated', completeness: 'truncated' });
    expect(cutSets(cut.record)).toEqual([['A', 'B']]); // what was kept: proves the report alone looked plausible
    const full = await run(d);
    expect(full.record).toMatchObject({ status: 'completed', completeness: 'complete' });
    expect(cutSets(full.record)).toEqual([['A', 'B'], ['C', 'D', 'E']]);
  }, 120000);

  it('a dropped cut set with no effect on the probability cannot be proven and is not called complete', async () => {
    const d = mkDoc('TOP', { A: 0.1, B: 0.2, C: 0 }, [AND('TOP', ['A', 'B', 'C'])]);
    const { record } = await run(d, { settings: { limitOrder: 2 } });
    expect(record.status).toBe('failed');
    expect(record.completeness).toBe('unknown');
    expect(record.reasons).toEqual(['limit-below-bound-completeness-unknown']);
  }, 120000);

  it('the default limit follows the event count, so a 21-event cut set (the engine default is 20) is kept', async () => {
    const n = ids(21);
    const d = mkDoc('TOP', Object.fromEntries(n.map((i) => [i, 0.5])), [AND('TOP', n)]);
    const { record } = await run(d);
    expect(record).toMatchObject({ status: 'completed', completeness: 'complete', settings: { limitOrder: 21 } });
    expect(record.minimal_cut_sets).toHaveLength(1);
    expect(record.minimal_cut_sets[0]!.events).toHaveLength(21);
    expect(near(record.top_event_probability!, 0.5 ** 21)).toBe(true);
    // the same model at the engine's own default limit loses it silently: the reason for the rule above
    const low = await run(d, { settings: { limitOrder: 20 } });
    expect(low.record.status).toBe('truncated');
  }, 120000);

  it('a rare-event sum above 1 (clamped to 1 by the engine) is shown labelled: the bound as the probability, the real sum beside it', async () => {
    const d = mkDoc('TOP', { A: 0.9, B: 0.9, C: 0.9 }, [OR('TOP', ['A', 'B', 'C'])]);
    const { record } = await run(d, { settings: { method: 'rare-event' } });
    expect(record).toMatchObject({ status: 'completed', completeness: 'complete', reasons: [], top_event_probability: 1, caveats: ['approximation-exceeds-1'] });
    expect(record.approximation_value).toBeCloseTo(2.7, 12);
    expect(record.warnings).toEqual(['Probability may have been adjusted to 1.']);
    const exact = (await run(d)).record;
    expect(exact).toMatchObject({ status: 'completed', caveats: [], approximation_value: null }); // the exact method is unaffected
    expect(near(exact.top_event_probability!, 1 - 0.1 ** 3)).toBe(true);
  }, 120000);
});

describe('the run directory is a faithful record', () => {
  it('keeps the exact input bytes, the exported XML, settings, logs, the raw report and a results file that matches', async () => {
    const original = JSON.stringify(ORACLE_MODELS['pra-pump3-shared'], null, 4) + '\n';
    const out = ran(await analyze(original, { runsDir: RUNS, runId: 'faithful-record-test', engine: ENGINE }));
    const { runDir, record } = out;
    expect(path.basename(runDir)).toBe('faithful-record-test');
    // an installed runtime is named in the record; an unmanaged development build says so with null
    expect(record.engine.runtime ?? null).toEqual(ENGINE.runtime ?? null);
    if (FROM_RUNTIME) expect(record.engine.runtime).toMatchObject({ recipe_revision: 1 });
    expect(readFileSync(path.join(runDir, 'native/model.json'), 'utf8')).toBe(original);
    const xmlBytes = readFileSync(path.join(runDir, 'inputs/model.xml'));
    expect(createHash('sha256').update(xmlBytes).digest('hex')).toBe(record.input_hashes.exported_input_hash);
    expect(documentHash(Buffer.from(original, 'utf8'))).toBe(record.input_hashes.document_hash);
    expect(modelHash(JSON.parse(original))).toBe(record.input_hashes.model_hash);
    expect(JSON.parse(readFileSync(path.join(runDir, 'results.json'), 'utf8'))).toEqual(record);
    const settings = JSON.parse(readFileSync(path.join(runDir, 'inputs/settings.json'), 'utf8'));
    expect(settings.argv).toContain('--bdd');
    expect(settings.argv).toContain('-l');
    expect(settings.argv.join(' ')).not.toContain('--cut-off');
    for (const f of ['native/report.xml', 'log/stdout.txt', 'log/stderr.txt']) expect(existsSync(path.join(runDir, f)), f).toBe(true);
    expect(readFileSync(path.join(runDir, 'native/report.xml'), 'utf8')).toContain('<software name="SCRAM" version="0.16.2"');
  }, 120000);

  it('refuses to reuse a run directory and rejects a weak run id', async () => {
    await expect(analyze(text(ORACLE_MODELS['pra-and']), { runsDir: RUNS, runId: 'faithful-record-test' })).rejects.toThrow(/already exists/);
    await expect(analyze(text(ORACLE_MODELS['pra-and']), { runsDir: RUNS, runId: '../escape' })).rejects.toThrow(/runId/);
  }, 120000);

  it('a layout-only edit changes the document hash but not the model hash or the answer', async () => {
    const base = ORACLE_MODELS['pra-pump3-shared'] as Doc;
    const withLayout = { ...base, layout: { nodes: [{ id: 'TOP', x: 5, y: 5 }] }, 'x-note': 'edited' };
    const a = (await run(base)).record;
    const b = (await run(withLayout)).record;
    expect(b.input_hashes.model_hash).toBe(a.input_hashes.model_hash);
    expect(b.input_hashes.document_hash).not.toBe(a.input_hashes.document_hash);
    expect(b.input_hashes.exported_input_hash).toBe(a.input_hashes.exported_input_hash);
    expect(b.top_event_probability).toBe(a.top_event_probability);
  }, 120000);

  it('works from a path with spaces and brackets', async () => {
    const odd = path.join(RUNS, 'odd (path) [1] x+y');
    mkdirSync(odd, { recursive: true });
    const { record } = ran(await analyze(text(ORACLE_MODELS['pra-and']), { runsDir: odd, engine: ENGINE }));
    expect(record.status).toBe('completed');
  }, 120000);
});

describe('seeded random trees: engine versus the independent enumeration oracle', () => {
  const check = (doc: Doc, record: ResultRecord, ctx: string): void => {
    const oracle = enumerate(doc);
    expect(record.reasons, ctx).toEqual([]);
    expect(record, ctx).toMatchObject({ status: 'completed', completeness: 'complete' });
    expect(cutSets(record), `${ctx} cut sets`).toEqual(oracle.cutSets);
    expect(near(record.top_event_probability!, oracle.probability.toNumber()), `${ctx} probability ${record.top_event_probability} vs ${oracle.probability.toDecimal(12)}`).toBe(true);
    for (const c of record.minimal_cut_sets) {
      const p = c.events.reduce((acc, id) => acc * doc.events.find((e) => e.id === id)!.probability, 1);
      expect(near(c.probability, p), `${ctx} cut set ${c.events.join('+')}`).toBe(true);
    }
  };

  it('60 small trees, exact method: probabilities and every cut set agree', async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const doc = randomDoc(seed);
      check(doc, (await run(doc)).record, `exact seed ${seed}`);
    }
  }, 600000);

  it('8 larger trees (11 to 14 events), exact method', async () => {
    for (let seed = 1001; seed < 1009; seed++) {
      const doc = randomDoc(seed, { events: 11 + (seed % 4), gates: 10 + (seed % 7) });
      check(doc, (await run(doc)).record, `large seed ${seed}`);
    }
  }, 600000);

  it('rare-event and min-cut-upper-bound methods agree with the oracle, and a sum above 1 is labelled with its real value', async () => {
    let compared = 0;
    let labelled = 0;
    for (let seed = 101; seed <= 130; seed++) {
      const doc = randomDoc(seed);
      const oracle = enumerate(doc);
      for (const method of ['rare-event', 'mcub'] as const) {
        const want = method === 'rare-event' ? oracle.rareEvent : oracle.mcub;
        const { record } = await run(doc, { settings: { method } });
        const ctx = `${method} seed ${seed}`;
        expect(record, ctx).toMatchObject({ status: 'completed', completeness: 'complete', reasons: [] });
        // the method's own value is always the oracle's, however large; the probability is that value capped at 1
        expect(near(record.approximation_value!, want.toNumber()), `${ctx}: ${record.approximation_value} vs ${want.toDecimal(12)}`).toBe(true);
        if (want.cmp(qFromNumber(1)) > 0) {
          labelled++;
          expect(record.caveats, ctx).toEqual(['approximation-exceeds-1']);
          expect(record.top_event_probability, ctx).toBe(1);
        } else {
          compared++;
          expect(record.caveats, ctx).toEqual([]);
          expect(near(record.top_event_probability!, want.toNumber()), `${ctx}: ${record.top_event_probability} vs ${want.toDecimal(12)}`).toBe(true);
        }
      }
    }
    expect(compared).toBeGreaterThanOrEqual(30);
    expect(labelled).toBeGreaterThanOrEqual(1);
    expect(compared + labelled).toBe(60);
  }, 900000);
});

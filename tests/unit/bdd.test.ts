import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeBuiltin } from '../../src/engines/bdd/analyze.js';
import { Bdd, SolveAborted, FALSE, TRUE } from '../../src/engines/bdd/bdd.js';
import { MAX_EVENTS, defaultOrder, solve } from '../../src/engines/bdd/solve.js';
import type { NativeModel } from '../../src/core/model.js';
import { enumerate } from '../oracle/enumerate.js';
import { AND, NATIVE_VOTE, OR, ORACLE_MODELS, VOTE, mkDoc, randomDoc, rng, type Doc } from '../oracle/models.js';

// The built-in engine against everything that can check it without sharing its code: the frozen hand oracles, exhaustive
// enumeration with exact rationals, the engine's own variable-order freedom, and the shared result checks (assess).

const ROOT = path.resolve(import.meta.dirname, '../..');
const oracles = JSON.parse(readFileSync(path.join(ROOT, 'tests/oracles.json'), 'utf8')) as {
  id: string;
  type: string;
  method?: string;
  expected_probability?: number;
  expected_cut_sets?: string[][];
  tolerance?: { absolute: number };
}[];
const tmp = mkdtempSync(path.join(tmpdir(), 'sneed-bdd-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const model = (d: Doc): NativeModel => d as unknown as NativeModel;
const sortSets = (sets: string[][]): string[][] => sets.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));
let runNo = 0;
const runId = (): string => `bdd-run-${String(++runNo).padStart(6, '0')}`;

describe('frozen hand oracles (tests/oracles.json) through the whole built-in analysis', () => {
  for (const e of oracles.filter((x) => x.type === 'numerical')) {
    it(`${e.id} (${e.method})`, async () => {
      const method = (e.method ?? 'exact') as 'exact' | 'rare-event' | 'mcub';
      const out = await analyzeBuiltin(JSON.stringify(ORACLE_MODELS[e.id]), { runsDir: tmp, runId: runId(), settings: { method } });
      expect(out.kind).toBe('ran');
      if (out.kind !== 'ran') return;
      const r = out.record;
      expect(r).toMatchObject({ status: 'completed', completeness: 'complete', reasons: [], method });
      expect(Math.abs(r.top_event_probability! - e.expected_probability!)).toBeLessThanOrEqual(e.tolerance!.absolute);
      expect(sortSets(r.minimal_cut_sets.map((c) => c.events))).toEqual(sortSets(e.expected_cut_sets!));
      expect(r.engine).toMatchObject({ name: 'sneed-bdd', runtime: null });
    });
  }

  it('native 2-of-3 voting equals the AND/OR expansion (no engine-specific workaround is needed)', () => {
    const a = solve(model(NATIVE_VOTE));
    const b = solve(model(ORACLE_MODELS['pra-vote-exact']!));
    expect(a.probability).toBeCloseTo(0.028, 12);
    expect(sortSets(a.cutSets.map((c) => c.events))).toEqual(sortSets(b.cutSets.map((c) => c.events)));
  });
});

describe('agreement with exhaustive enumeration (exact rationals) on random trees', () => {
  const agree = (doc: Doc, ctx: string): void => {
    const o = enumerate(doc);
    const s = solve(model(doc));
    expect(Math.abs(s.probability - o.probability.toNumber()), `${ctx} probability`).toBeLessThanOrEqual(1e-12);
    expect(sortSets(s.cutSets.map((c) => c.events)), `${ctx} cut sets`).toEqual(sortSets(o.cutSets));
  };

  it('2000 small trees (probabilities include 0 and 1, repeated references, K-of-N)', () => {
    for (let seed = 1; seed <= 2000; seed++) agree(randomDoc(seed), `seed ${seed}`);
  });

  it('300 larger trees', () => {
    for (let seed = 5001; seed <= 5300; seed++) agree(randomDoc(seed, { events: 11 + (seed % 4), gates: 10 + (seed % 7) }), `large seed ${seed}`);
  });

  it('the shapes the SCRAM K-of-N operator gets wrong are right here (a gate that repeats an input of the vote)', () => {
    // at least 2 of [C, A, G0 = A or C, B]: SCRAM 0.16.2 returns a wrong answer for this shape (docs/spike/README.md)
    const doc = mkDoc('V', { A: 0.1, B: 0.2, C: 0.3 }, [OR('G0', ['A', 'C']), VOTE('V', ['C', 'A', 'G0', 'B'], 2)]);
    const o = enumerate(doc);
    const s = solve(model(doc));
    expect(s.probability).toBeCloseTo(o.probability.toNumber(), 12);
    expect(sortSets(s.cutSets.map((c) => c.events))).toEqual(sortSets(o.cutSets));
  });

  it('repeated references: A AND A is A, and A OR A is A (one failure, not two)', () => {
    expect(solve(model(ORACLE_MODELS['pra-aa']!)).probability).toBeCloseTo(0.1, 15);
    expect(solve(model(ORACLE_MODELS['pra-oa']!)).probability).toBeCloseTo(0.1, 15);
    expect(solve(model(ORACLE_MODELS['pra-aa']!)).cutSets.map((c) => c.events)).toEqual([['A']]);
  });

  it('a basic event as the top event', () => {
    const s = solve(model(ORACLE_MODELS['pra-pump1']!));
    expect(s).toMatchObject({ probability: 0.1, cutSets: [{ events: ['P'], probability: 0.1 }] });
  });
});

describe('the answer never depends on the variable order', () => {
  it('300 trees, each solved under four different orders, agree to 1e-12 and give identical cut sets', () => {
    const rnd = rng(99);
    for (let seed = 7001; seed <= 7300; seed++) {
      const m = model(randomDoc(seed, { events: 6 + (seed % 5), gates: 5 + (seed % 6) }));
      const base = solve(m);
      const events = defaultOrder(m);
      for (let k = 0; k < 4; k++) {
        const order = [...events];
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
        const s = solve(m, { order });
        expect(Math.abs(s.probability - base.probability), `seed ${seed} order ${order}`).toBeLessThanOrEqual(1e-12);
        expect(s.cutSets.map((c) => c.events)).toEqual(base.cutSets.map((c) => c.events));
      }
    }
  });

  it('an order that is not a permutation of the reachable events is refused', () => {
    const m = model(ORACLE_MODELS['pra-pump2-and']!);
    for (const order of [['P1'], ['P1', 'P1'], ['P1', 'P3'], ['P1', 'P2', 'P2']]) expect(() => solve(m, { order })).toThrow(RangeError);
  });

  it('the diagram is smaller under a good order (a diagram property, not a result property)', () => {
    // AND of 10 pairs OR: interleaved order is linear, separated order is exponential
    const events: Record<string, number> = {};
    const gates = [AND('TOP', Array.from({ length: 10 }, (_, i) => `G${i}`))];
    for (let i = 0; i < 10; i++) {
      events[`A${i}`] = 0.1;
      events[`B${i}`] = 0.1;
      gates.push(OR(`G${i}`, [`A${i}`, `B${i}`]));
    }
    const m = model(mkDoc('TOP', events, gates));
    const good = solve(m);
    const bad = solve(m, { order: [...Array.from({ length: 10 }, (_, i) => `A${i}`), ...Array.from({ length: 10 }, (_, i) => `B${i}`)] });
    expect(bad.nodes).toBeGreaterThan(good.nodes * 5);
    expect(Math.abs(good.probability - bad.probability)).toBeLessThan(1e-12);
  });
});

describe('the decision diagram itself', () => {
  it('is reduced and shared: the same function is the same node', () => {
    const b = new Bdd({ maxNodes: 1000, maxCutSets: 1000, maxCached: 1e6 });
    const x = b.variable(0);
    const y = b.variable(1);
    expect(b.and(x, y)).toBe(b.and(y, x));
    expect(b.or(x, FALSE)).toBe(x);
    expect(b.and(x, TRUE)).toBe(x);
    expect(b.or(x, TRUE)).toBe(TRUE);
    expect(b.and(x, FALSE)).toBe(FALSE);
    expect(b.or(x, b.and(x, y))).toBe(x); // absorption
    expect(b.mk(0, y, y)).toBe(y); // a node whose branches agree does not exist
  });

  it('atLeast: all, any, and the middle, against counting', () => {
    const b = new Bdd({ maxNodes: 10_000, maxCutSets: 1000, maxCached: 1e6 });
    const vars = [0, 1, 2, 3].map((i) => b.variable(i));
    const p = [0.5, 0.5, 0.5, 0.5];
    expect(b.probability(b.atLeast(4, vars), p)).toBeCloseTo(1 / 16, 15);
    expect(b.probability(b.atLeast(1, vars), p)).toBeCloseTo(15 / 16, 15);
    expect(b.probability(b.atLeast(2, vars), p)).toBeCloseTo(11 / 16, 15);
    expect(b.atLeast(0, vars)).toBe(TRUE);
    expect(b.atLeast(5, vars)).toBe(FALSE);
  });

  it('sets of different sizes across the branches: the low branch keeps its short sets, the high branch adds longer ones (found by the mutation run: no subset test is needed)', () => {
    const b = new Bdd({ maxNodes: 10_000, maxCutSets: 1000, maxCached: 1e6 });
    const [x, y, z, w, u] = [0, 1, 2, 3, 4].map((i) => b.variable(i)) as [number, number, number, number, number];
    const f = b.or(b.or(u, b.and(x, b.and(y, z))), b.and(x, w)); // u | x.y.z | x.w
    expect(b.minimalCutSets(f).map((s) => s.join(',')).sort()).toEqual(['0,1,2', '0,3', '4']);
  });

  it('minimal cut sets are minimal and complete on a family with absorption', () => {
    const b = new Bdd({ maxNodes: 10_000, maxCutSets: 1000, maxCached: 1e6 });
    const [a, c, d] = [0, 1, 2].map((i) => b.variable(i)) as [number, number, number];
    const f = b.or(a, b.and(a, b.or(c, d))); // equals a
    expect(b.minimalCutSets(f)).toEqual([[0]]);
    const g = b.or(b.and(a, c), b.and(c, d));
    expect(b.minimalCutSets(g).map((s) => s.join(',')).sort()).toEqual(['0,1', '1,2']);
  });
});

describe('limits end as a named failure, never as a result', () => {
  const hard = (pairs: number): Doc => {
    const events: Record<string, number> = {};
    const gates = [AND('TOP', Array.from({ length: pairs }, (_, i) => `G${i}`))];
    for (let i = 0; i < pairs; i++) {
      events[`A${i}`] = 0.1;
      events[`B${i}`] = 0.1;
      gates.push(OR(`G${i}`, [`A${i}`, `B${i}`]));
    }
    return mkDoc('TOP', events, gates);
  };
  const run = (doc: Doc, over: Parameters<typeof analyzeBuiltin>[1] extends infer T ? Partial<T> : never = {}) => analyzeBuiltin(JSON.stringify(doc), { runsDir: tmp, runId: runId(), ...over });

  it.each([
    [{ limits: { maxNodes: 12 } }, 'too-many-nodes'],
    [{ limits: { maxCutSets: 100 } }, 'too-many-cut-sets'],
  ] as const)('%j fails with %s and carries no numbers', async (over, reason) => {
    const out = await run(hard(8), over);
    expect(out.kind).toBe('ran');
    if (out.kind !== 'ran') return;
    expect(out.record).toMatchObject({ status: 'failed', reasons: [reason], top_event_probability: null, minimal_cut_sets: [] });
    expect(existsSync(path.join(out.runDir, 'results.json'))).toBe(true);
  });

  it('more events than the stack allows is refused before any work', async () => {
    const events: Record<string, number> = {};
    const ids = Array.from({ length: MAX_EVENTS + 1 }, (_, i) => `E${i}`);
    for (const id of ids) events[id] = 0.01;
    const out = await run(mkDoc('TOP', events, [OR('TOP', ids)]));
    expect(out.kind === 'ran' && out.record).toMatchObject({ status: 'failed', reasons: ['too-many-events'] });
  });

  it('a cancel stops the work and the record says cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    const out = await run(hard(14), { signal: ac.signal });
    expect(out.kind === 'ran' && out.record).toMatchObject({ status: 'cancelled', reasons: ['cancelled'], top_event_probability: null });
  });

  it('a time limit that has passed stops the work: failed, reason timeout', async () => {
    let calls = 0;
    const now = (): number => (calls++ > 0 ? 1e12 : 0);
    const out = await run(hard(14), { now, timeoutMs: 1000 });
    expect(out.kind === 'ran' && out.record).toMatchObject({ status: 'failed', reasons: ['timeout'] });
  });

  it('a deep chain of gates (1500 levels) does not overflow the stack', () => {
    const events: Record<string, number> = { E0: 0.5 };
    const gates = [];
    for (let i = 1; i <= 1500; i++) {
      events[`E${i}`] = 0.001;
      gates.push(OR(`G${i}`, [`E${i}`, i === 1 ? 'E0' : `G${i - 1}`]));
    }
    const s = solve(model(mkDoc('G1500', events, gates)));
    expect(s.cutSets).toHaveLength(1501);
    expect(s.probability).toBeCloseTo(1 - 0.5 * 0.999 ** 1500, 12);
  });

  it('a gate with thousands of inputs and a K-of-N over thousands of gates that all use one event do not overflow the stack (found by Codex)', () => {
    const gates = Array.from({ length: 12000 }, (_, i) => OR(`G${i}`, ['E', 'E']));
    const doc = mkDoc('TOP', { E: 0.1 }, [VOTE('TOP', gates.map((g) => g.id), 2), ...gates]);
    const s = solve(model(doc));
    expect(s.probability).toBeCloseTo(0.1, 12); // every gate is "E fails", so 2-of-12000 is "E fails"
    expect(s.cutSets.map((c) => c.events)).toEqual([['E']]);
  });

  it('the same kind of chain, 200 levels, goes through the whole analysis and completes', async () => {
    const events: Record<string, number> = { E0: 0.5 };
    const gates = [];
    for (let i = 1; i <= 200; i++) {
      events[`E${i}`] = 0.5;
      gates.push(i % 2 ? OR(`G${i}`, [`E${i}`, i === 1 ? 'E0' : `G${i - 1}`]) : AND(`G${i}`, [`E${i}`, `G${i - 1}`]));
    }
    const out = await run(mkDoc('G200', events, gates));
    expect(out.kind === 'ran' && out.record.status).toBe('completed');
  });

  it('a hard but allowed model (14 pairs, 16384 cut sets) completes quickly', async () => {
    const t0 = Date.now();
    const out = await run(hard(14));
    expect(out.kind === 'ran' && out.record).toMatchObject({ status: 'completed', completeness: 'complete' });
    expect(Date.now() - t0).toBeLessThan(30_000);
    if (out.kind === 'ran') expect(out.record.top_event_probability).toBeCloseTo((1 - 0.81) ** 14, 12);
  }, 60_000);
});

describe('the record', () => {
  it('names the engine, carries the assumptions and hashes, and leaves the same files as a SCRAM run keeps', async () => {
    const out = await analyzeBuiltin(JSON.stringify(ORACLE_MODELS['pra-pump3-shared']), { runsDir: tmp, runId: runId() });
    expect(out.kind).toBe('ran');
    if (out.kind !== 'ran') return;
    const r = out.record;
    expect(r.engine).toEqual({ name: 'sneed-bdd', version: '0.1.0', sha256: null, runtime: null });
    expect(r.assumptions).toMatchObject({ independence: 'declared-independent' });
    expect(r.input_hashes.model_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.exporter_version).toMatch(/native model/);
    expect(readdirSync(out.runDir).sort()).toEqual(['inputs', 'log', 'native', 'results.json']);
    expect(readFileSync(path.join(out.runDir, 'native', 'model.json'), 'utf8')).toBe(JSON.stringify(ORACLE_MODELS['pra-pump3-shared']));
    expect(JSON.parse(readFileSync(path.join(out.runDir, 'results.json'), 'utf8')).top_event_probability).toBeCloseTo(0.0595, 12);
  });

  it('an invalid model is refused with the validator codes and creates no run folder', async () => {
    const before = readdirSync(tmp).length;
    const out = await analyzeBuiltin(JSON.stringify(mkDoc('T', { A: 0.1 }, [{ id: 'T', type: 'or', inputs: ['T', 'A'] }])), { runsDir: tmp, runId: runId() });
    expect(out.kind).toBe('refused');
    expect(readdirSync(tmp).length).toBe(before);
  });

  it('an approximation above 1 is labelled, like the SCRAM path does', async () => {
    // 12 events each with probability 0.5 in an OR: the rare-event sum is 6
    const ids = Array.from({ length: 12 }, (_, i) => `E${i}`);
    const doc = mkDoc('TOP', Object.fromEntries(ids.map((e) => [e, 0.5])), [OR('TOP', ids)]);
    const out = await analyzeBuiltin(JSON.stringify(doc), { runsDir: tmp, runId: runId(), settings: { method: 'rare-event' } });
    expect(out.kind === 'ran' && out.record).toMatchObject({ status: 'completed', top_event_probability: 1, caveats: ['approximation-exceeds-1'], approximation_value: 6 });
  });

  it('a wrong method name is refused up front', async () => {
    await expect(analyzeBuiltin(JSON.stringify(ORACLE_MODELS['pra-and']), { runsDir: tmp, runId: runId(), settings: { method: 'fancy' as never } })).rejects.toThrow(RangeError);
  });
});

describe('the engine refuses what it cannot be right about', () => {
  it('SolveAborted carries its reason', () => {
    expect(new SolveAborted('timeout').why).toBe('timeout');
  });
});

describe('second review of the engine (Codex)', () => {
  const hard = (pairs: number): Doc => {
    const events: Record<string, number> = {};
    const gates = [AND('TOP', Array.from({ length: pairs }, (_, i) => `G${i}`))];
    for (let i = 0; i < pairs; i++) {
      events[`A${i}`] = 0.1;
      events[`B${i}`] = 0.1;
      gates.push(OR(`G${i}`, [`A${i}`, `B${i}`]));
    }
    return mkDoc('TOP', events, gates);
  };
  const run = (doc: Doc, over: Partial<Parameters<typeof analyzeBuiltin>[1]> = {}) => analyzeBuiltin(JSON.stringify(doc), { runsDir: tmp, runId: runId(), ...over });

  it('MCUB keeps a tiny probability: 1e-20 is not rounded to zero by cancellation', async () => {
    const doc = mkDoc('A', { A: 1e-20 }, []);
    const out = await run(doc, { settings: { method: 'mcub' } });
    expect(out.kind === 'ran' && out.record).toMatchObject({ status: 'completed', completeness: 'complete' });
    if (out.kind === 'ran') {
      expect(out.record.top_event_probability).toBeCloseTo(1e-20, 30);
      expect(out.record.top_event_probability).toBeGreaterThan(9e-21);
      expect(out.record.approximation_value!).toBeGreaterThan(9e-21);
    }
  });

  it('MCUB of several tiny cut sets, and an endpoint of probability 1', async () => {
    const doc = mkDoc('T', { A: 1e-15, B: 2e-15 }, [OR('T', ['A', 'B'])]);
    const out = await run(doc, { settings: { method: 'mcub' } });
    expect(out.kind === 'ran' && out.record.top_event_probability).toBeCloseTo(3e-15, 25);
    const one = await run(mkDoc('T', { A: 1, B: 0.5 }, [OR('T', ['A', 'B'])]), { settings: { method: 'mcub' } });
    expect(one.kind === 'ran' && one.record.top_event_probability).toBe(1);
  });

  it('a time limit that passes while the result is being checked is a recorded timeout, not a thrown error', async () => {
    let calls = 0;
    const now = (): number => (calls++ > 1 ? 1e12 : 0); // readings 1 and 2: deadline and before the solver; later ones are past it
    const out = await run(mkDoc('A', { A: 0.1 }, []), { now, timeoutMs: 1000 });
    expect(out.kind).toBe('ran');
    if (out.kind === 'ran') {
      expect(out.record).toMatchObject({ status: 'failed', reasons: ['timeout'], top_event_probability: null });
      expect(existsSync(path.join(out.runDir, 'results.json'))).toBe(true);
    }
  });

  // 1000 mandatory events times 12 pairs: allowed by every size limit, so the solver is busy for seconds before the cache budget stops it
  it('a cancel is heard while the solver is computing (its own thread): cancelled in well under the time the model needs', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const t0 = Date.now();
    const out = await run(prefixed(), { signal: ac.signal });
    // if the cancel were only noticed after the solver finished, the record would be the solver's own failure (too-much-memory)
    expect(out.kind === 'ran' && out.record).toMatchObject({ status: 'cancelled', reasons: ['cancelled'], top_event_probability: null });
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 60_000);

  it('a cancel that arrives while the result is being checked is also heard (the checks poll the signal)', async () => {
    let reads = 0;
    const signal = { get aborted() { return ++reads > 2; }, addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal; // false for the solver, true from the checks on
    const out = await run(mkDoc('A', { A: 0.1 }, []), { signal });
    expect(out.kind === 'ran' && out.record).toMatchObject({ status: 'cancelled', reasons: ['cancelled'], top_event_probability: null });
  });

  it('a time limit ends a run that is still computing, with no numbers', async () => {
    const t0 = Date.now();
    const out = await run(hard(15), { timeoutMs: 100 });
    expect(out.kind === 'ran' && out.record).toMatchObject({ status: 'failed', reasons: ['timeout'], minimal_cut_sets: [] });
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 30_000);

  // 1000 mandatory events times 12 pairs: 4096 cut sets, but each node's cached copy is a longer array than the last
  const prefixed = (): Doc => {
    const events: Record<string, number> = {};
    const ps = Array.from({ length: 1000 }, (_, i) => `P${i}`);
    for (const p of ps) events[p] = 0.99;
    const gates = [];
    const pairs = [];
    for (let i = 0; i < 12; i++) {
      events[`E${2 * i}`] = 0.1;
      events[`E${2 * i + 1}`] = 0.1;
      gates.push(OR(`G${i}`, [`E${2 * i}`, `E${2 * i + 1}`]));
      pairs.push(`G${i}`);
    }
    return mkDoc('TOP', events, [AND('TOP', [...ps, ...pairs]), ...gates]);
  };

  it('a model that would cache billions of numbers is stopped by the cache budget, quickly, with a named reason (found by Codex)', async () => {
    const t0 = Date.now();
    const out = await run(prefixed());
    expect(out.kind === 'ran' && out.record).toMatchObject({ status: 'failed', reasons: ['too-much-memory'], top_event_probability: null });
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 90_000);

  it('the worker heap limit is a second line: with the cache budget off, a small heap ends the same model as too-much-memory, and the server process lives', async () => {
    const t0 = Date.now();
    const out = await run(prefixed(), { memoryMb: 64, limits: { maxCached: 1e12 } });
    expect(out.kind === 'ran' && out.record).toMatchObject({ status: 'failed', reasons: ['too-much-memory'], top_event_probability: null });
    expect(Date.now() - t0).toBeLessThan(30_000); // the small heap, not the machine's default, ended it
  }, 90_000);

  it('the cache budget itself (the first line): a tiny budget stops even a small model, naming the reason', () => {
    expect(() => solve(model(hard(6)), { limits: { maxCached: 100 } })).toThrow(SolveAborted);
    try {
      solve(model(hard(6)), { limits: { maxCached: 100 } });
    } catch (e) {
      expect((e as SolveAborted).why).toBe('too-much-memory');
    }
    expect(solve(model(hard(6)), { limits: { maxCached: 1e9 } }).cutSets).toHaveLength(64); // and an ample one does not
  });
});


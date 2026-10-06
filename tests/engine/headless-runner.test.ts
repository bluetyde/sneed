import { beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ORACLE_MODELS, mkDoc, AND, OR } from '../oracle/models.js';
import { enumerate } from '../oracle/enumerate.js';

// (tests/engine/headless.test.ts is the older native-model-to-SCRAM acceptance test; this file tests the CLI runner in src/cli.)
// The headless runner as SEED's adapter will start it: the built JavaScript, as a separate process, against the installed
// SCRAM runtime. Needs `npm run runtime -- install` once. The expected numbers come from the independent enumeration oracle.

const ROOT = path.resolve(import.meta.dirname, '../..');
const ENTRY = path.join(ROOT, 'dist', 'node', 'cli', 'headless.js');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

beforeAll(() => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-cli.mjs')], { cwd: ROOT, encoding: 'utf8' });
  expect(r.status, r.stderr + r.stdout).toBe(0);
}, 120_000);

function cli(args: string[]): { code: number | null; json: any; raw: string } {
  const r = spawnSync(process.execPath, [ENTRY, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 110_000 });
  const raw = r.stdout;
  expect(raw.trim().split('\n')).toHaveLength(1); // one JSON object, nothing else
  return { code: r.status, json: JSON.parse(raw), raw };
}

function fixture(): { dir: string; model: string; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sneed-headless-real-'));
  const out = path.join(dir, 'run');
  mkdirSync(out);
  return { dir, model: path.join(dir, 'model.json'), out };
}

describe('built headless runner against the installed SCRAM runtime', () => {
  it('describe reports the installed runtime', () => {
    const r = cli(['describe']);
    expect(r.code).toBe(0);
    expect(r.json.scram).toMatchObject({ installed: true, version: '0.16.2' });
    expect(r.json.engine.name).toBe('sneed-headless');
  }, 120_000);

  it('validate: a good model passes, a cycle is refused with exit 2', () => {
    const f = fixture();
    try {
      writeFileSync(f.model, JSON.stringify(ORACLE_MODELS['pra-pump2-or']));
      expect(cli(['validate', f.model])).toMatchObject({ code: 0, json: { ok: true } });
      writeFileSync(f.model, JSON.stringify(mkDoc('T', { A: 0.1 }, [{ id: 'T', type: 'or', inputs: ['T', 'A'] }])));
      const bad = cli(['validate', f.model]);
      expect(bad.code).toBe(2);
      expect(bad.json.errors[0]).toMatchObject({ code: 'E_CYCLE', source: 'app-content' });
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('run: the result equals the independent oracle, and the manifest verifies every file', () => {
    const f = fixture();
    try {
      const doc = ORACLE_MODELS['pra-pump3-shared']!;
      writeFileSync(f.model, JSON.stringify(doc, null, 2) + '\n');
      const r = cli(['run', f.model, '--out', f.out, '--engine', 'scram']);
      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ ok: true, status: 'completed', runId: 'pra' });
      const dir = path.join(f.out, 'pra');
      const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      for (const file of manifest.files) expect(file.sha256).toBe(sha(readFileSync(path.join(dir, file.path))));
      expect(manifest.modelSha256).toBe(sha(readFileSync(f.model)));
      expect(manifest.engine).toMatchObject({ name: 'SCRAM', version: '0.16.2' });
      const rec = JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8'));
      const o = enumerate(doc);
      expect(Math.abs(rec.top_event_probability - o.probability.toNumber())).toBeLessThanOrEqual(1e-12);
      expect(rec.minimal_cut_sets.map((c: { events: string[] }) => [...c.events].sort()).sort()).toEqual(o.cutSets.map((c) => [...c].sort()).sort());
      expect(rec.top_event_probability).toBeCloseTo(0.0595, 12);
      expect(existsSync(path.join(f.out, 'work', manifest.workId, 'native', 'report.xml'))).toBe(true); // the engine's own files stay under work/
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('run: a product-order limit that would drop a cut set is not a result', () => {
    const f = fixture();
    try {
      writeFileSync(f.model, JSON.stringify(mkDoc('T', { A: 0.1, B: 0.1 }, [AND('T', ['A', 'B'])])));
      const r = cli(['run', f.model, '--out', f.out, '--engine', 'scram', '--limit-order', '1']);
      expect(r.code).toBe(0);
      expect(r.json.ok).toBe(true);
      expect(r.json.status).not.toBe('completed');
      expect(existsSync(path.join(f.out, 'pra'))).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('run: a refused model starts no engine and creates no work folder', () => {
    const f = fixture();
    try {
      writeFileSync(f.model, JSON.stringify(mkDoc('T', { A: 7 }, [AND('T', ['A', 'A'])])));
      const r = cli(['run', f.model, '--out', f.out, '--engine', 'scram']);
      expect(r.code).toBe(2);
      expect(existsSync(path.join(f.out, 'work'))).toBe(false);
      expect(existsSync(path.join(f.out, 'active-run.json'))).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('cancel with nothing running says so and kills nothing', () => {
    const f = fixture();
    try {
      expect(cli(['cancel', '--out', f.out]).json).toMatchObject({ ok: true, cancelled: false });
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('cancel while a run is in flight: the run ends cancelled, no result is written, no engine process is left', async () => {
    const f = fixture();
    try {
      writeFileSync(f.model, JSON.stringify(ORACLE_MODELS['pra-pump3-shared']));
      const child = spawn(process.execPath, [ENTRY, 'run', f.model, '--out', f.out, '--engine', 'scram'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      const done = new Promise<number | null>((resolve) => child.on('close', resolve));
      // the record the cancel verb relies on exists before the engine is started
      for (let i = 0; i < 100 && !existsSync(path.join(f.out, 'active-run.json')); i++) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(path.join(f.out, 'active-run.json'))).toBe(true);
      const c = cli(['cancel', '--out', f.out]);
      expect(c.json).toMatchObject({ ok: true, cancelled: true });
      expect(await done).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, status: 'cancelled' });
      expect(existsSync(path.join(f.out, 'pra'))).toBe(false);
      expect(c.json.nativeStopped).toBe(true);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// What SEED will do with oracles/seed: for every entry, run the pinned input through the runner and judge the answer.
describe('every SEED oracle entry, through the built runner and SCRAM', () => {
  const base = path.join(ROOT, 'oracles', 'seed');
  const entries = readdirSync(path.join(base, 'entries'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(base, 'entries', f), 'utf8')) as any);

  for (const e of entries.filter((x) => x.tag === 'good')) {
    it(`${e.oracleId}: the engine's probability is within the pinned tolerance of the expected value`, () => {
      const f = fixture();
      try {
        const input = path.join(base, e.inputs[0].path);
        expect(sha(readFileSync(input))).toBe(e.inputs[0].sha256);
        const r = cli(['run', input, '--out', f.out, '--engine', 'scram']);
        expect(r.json).toMatchObject({ ok: true, status: 'completed' });
        const rec = JSON.parse(readFileSync(path.join(f.out, 'pra', 'results.json'), 'utf8'));
        expect(Math.abs(rec.top_event_probability - e.expected.value)).toBeLessThanOrEqual(e.tolerance.abs + e.tolerance.rel * Math.abs(e.expected.value));
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    }, 120_000);
  }

  for (const e of entries.filter((x) => x.tag === 'bad-input')) {
    it(`${e.oracleId}: run is refused with ${e.expected.refusalCode} and no engine is started`, () => {
      const f = fixture();
      try {
        const r = cli(['run', path.join(base, e.inputs[0].path), '--out', f.out, '--engine', 'scram']);
        expect(r.code).toBe(2);
        expect(r.json.errors.map((x: { code: string }) => x.code)).toContain(e.expected.refusalCode);
        expect(existsSync(path.join(f.out, 'work'))).toBe(false);
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    }, 120_000);
  }
});

describe('a model too hard to verify (found by SEED: the time limit was not enforced)', () => {
  it('17 pairs (131072 cut sets) ends in a bounded time with a named refusal, not a hang and not a result', () => {
    const f = fixture();
    try {
      const events: Record<string, number> = {};
      const gates = [AND('TOP', Array.from({ length: 17 }, (_, i) => `G${i}`))];
      for (let i = 0; i < 17; i++) {
        events[`A${i}`] = 0.1;
        events[`B${i}`] = 0.1;
        gates.push(OR(`G${i}`, [`A${i}`, `B${i}`]));
      }
      writeFileSync(f.model, JSON.stringify(mkDoc('TOP', events, gates)));
      const t0 = Date.now();
      const r = cli(['run', f.model, '--out', f.out, '--engine', 'scram', '--timeout-seconds', '60']);
      expect(Date.now() - t0).toBeLessThan(110_000);
      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ ok: true, status: 'failed' });
      expect(r.json.reason).toMatch(/too-many-cut-sets|timeout|result-too-large-to-verify/);
      expect(existsSync(path.join(f.out, 'pra'))).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 130_000);
});

describe('the built runner with --engine builtin (plan 10)', () => {
  // 1000 mandatory events times 12 pairs: allowed by every size limit, but it keeps the solver busy for many seconds before the cache budget stops it
  const hardDoc = () => {
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

  it('runs without SCRAM, names the built-in engine, and equals the independent oracle', () => {
    const f = fixture();
    try {
      const doc = ORACLE_MODELS['pra-pump3-shared']!;
      writeFileSync(f.model, JSON.stringify(doc));
      const r = cli(['run', f.model, '--out', f.out, '--engine', 'builtin']);
      expect(r.json).toMatchObject({ ok: true, status: 'completed' });
      const dir = path.join(f.out, 'pra');
      const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      expect(manifest.engine).toMatchObject({ name: 'sneed-bdd', runtime: null });
      for (const file of manifest.files) expect(file.sha256).toBe(sha(readFileSync(path.join(dir, file.path))));
      const rec = JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8'));
      const o = enumerate(doc);
      expect(Math.abs(rec.top_event_probability - o.probability.toNumber())).toBeLessThanOrEqual(1e-12);
      expect(rec.minimal_cut_sets.map((c: { events: string[] }) => [...c.events].sort()).sort()).toEqual(o.cutSets.map((c) => [...c].sort()).sort());
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('every SEED oracle entry also passes through the built-in engine', () => {
    const base = path.join(ROOT, 'oracles', 'seed');
    for (const name of readdirSync(path.join(base, 'entries')).sort()) {
      const e = JSON.parse(readFileSync(path.join(base, 'entries', name), 'utf8')) as any;
      if (e.tag !== 'good') continue;
      const f = fixture();
      try {
        const r = cli(['run', path.join(base, e.inputs[0].path), '--out', f.out, '--engine', 'builtin']);
        expect(r.json, e.oracleId).toMatchObject({ ok: true, status: 'completed' });
        const rec = JSON.parse(readFileSync(path.join(f.out, 'pra', 'results.json'), 'utf8'));
        expect(Math.abs(rec.top_event_probability - e.expected.value), e.oracleId).toBeLessThanOrEqual(e.tolerance.abs);
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    }
  }, 300_000);

  it('cancel while the built-in engine is computing: the run ends cancelled with no result, quickly', async () => {
    const f = fixture();
    try {
      writeFileSync(f.model, JSON.stringify(hardDoc()));
      const child = spawn(process.execPath, [ENTRY, 'run', f.model, '--out', f.out, '--engine', 'builtin'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      const done = new Promise<number | null>((resolve) => child.on('close', resolve));
      for (let i = 0; i < 100 && !existsSync(path.join(f.out, 'active-run.json')); i++) await new Promise((r) => setTimeout(r, 50));
      const t0 = Date.now();
      expect(cli(['cancel', '--out', f.out]).json).toMatchObject({ ok: true, cancelled: true });
      expect(await done).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, status: 'cancelled' });
      expect(existsSync(path.join(f.out, 'pra'))).toBe(false);
      expect(Date.now() - t0).toBeLessThan(15_000);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('the default engine of the built runner (flipped to the built-in engine on 2026-10-06)', () => {
  it('a run with no --engine uses the built-in engine and needs no SCRAM runtime', () => {
    const f = fixture();
    try {
      writeFileSync(f.model, JSON.stringify(ORACLE_MODELS['pra-pump2-or']));
      const r = cli(['run', f.model, '--out', f.out]);
      expect(r.json).toMatchObject({ ok: true, status: 'completed' });
      expect(JSON.parse(readFileSync(path.join(f.out, 'pra', 'manifest.json'), 'utf8')).engine).toMatchObject({ name: 'sneed-bdd', runtime: null });
      expect(cli(['describe']).json.engines.default).toBe('builtin');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('SNEED_ENGINE=scram restores the old default for a caller that has not been updated; --engine still wins', () => {
    const f = fixture();
    const f2 = fixture();
    try {
      writeFileSync(f.model, JSON.stringify(ORACLE_MODELS['pra-pump2-or']));
      const env = { ...process.env, SNEED_ENGINE: 'scram' };
      const run = (args: string[]) => JSON.parse(spawnSync(process.execPath, [ENTRY, ...args], { cwd: ROOT, encoding: 'utf8', env, timeout: 110_000 }).stdout);
      expect(run(['describe']).engines.default).toBe('scram');
      expect(run(['run', f.model, '--out', f.out])).toMatchObject({ ok: true, status: 'completed' });
      expect(JSON.parse(readFileSync(path.join(f.out, 'pra', 'manifest.json'), 'utf8')).engine.name).toBe('SCRAM');
      expect(run(['run', f.model, '--out', f2.out, '--engine', 'builtin'])).toMatchObject({ ok: true, status: 'completed' });
      expect(JSON.parse(readFileSync(path.join(f2.out, 'pra', 'manifest.json'), 'utf8')).engine.name).toBe('sneed-bdd');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(f2.dir, { recursive: true, force: true });
    }
  }, 180_000);
});


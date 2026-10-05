import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { analyze } from '../../src/core/analyze.js';
import { execInWsl } from '../../src/core/engine.js';
import { install, recover, resolveEngine, rollback, status, verifyActive, type InstallRecord, type RuntimeEnv } from '../../src/runtime/install.js';
import { loadRecipe } from '../../src/runtime/recipe.js';
import { ORACLE_MODELS } from '../oracle/models.js';

// REAL installs of the recipe into a scratch root in WSL: downloads from conda-forge (served from the local package
// cache when warm) and github.com, compiles SCRAM, runs the native smoke checks. Slow: a few minutes.
const ROOT = path.resolve(import.meta.dirname, '../..');
const env: RuntimeEnv = { distro: 'Ubuntu', linuxRoot: '/root/sneed-runtime-itest', stateDir: path.join(ROOT, 'runs', 'runtime-itest', 'state') };
const loaded = loadRecipe(path.join(ROOT, 'runtime'));

async function linuxProcessCount(needle: string): Promise<number> {
  const r = await execInWsl(env.distro, ['sh', '-c', 'ps -eo args | grep -F -- "$1" | grep -v grep | wc -l', 'sh', needle], { timeoutMs: 30000, ownerTag: '/tmp/sneed-itest-probe-aaaaaaaa' });
  return Number(r.stdout.trim());
}
const dirExists = async (dir: string): Promise<boolean> => (await execInWsl(env.distro, ['/usr/bin/test', '-d', dir], { timeoutMs: 30000, ownerTag: '/tmp/sneed-itest-test-aaaaaaaa' })).exit === 0;

async function scrub(): Promise<void> {
  // only this test's own scratch root and state directory
  if (env.linuxRoot !== '/root/sneed-runtime-itest') throw new Error('scrub refuses an unexpected root');
  await execInWsl(env.distro, ['/usr/bin/rm', '-rf', '--', env.linuxRoot], { timeoutMs: 300000, ownerTag: env.linuxRoot });
  rmSync(path.join(ROOT, 'runs', 'runtime-itest'), { recursive: true, force: true });
}

beforeAll(scrub, 600000);
afterAll(scrub, 600000);

const analyzeWith = async (engine: ReturnType<typeof resolveEngine>, id: string): Promise<{ p: number | null; status: string; runtime: unknown }> => {
  const out = await analyze(JSON.stringify(ORACLE_MODELS[id]), { runsDir: path.join(ROOT, 'runs', 'runtime-itest', 'analysis'), engine });
  if (out.kind !== 'ran') throw new Error('refused');
  return { p: out.record.top_event_probability, status: out.record.status, runtime: out.record.engine.runtime };
};

describe('real install from the recipe', () => {
  let first: InstallRecord;

  it('installs, passes every native check, and activates', async () => {
    const seen: string[] = [];
    const r = await install(env, loaded, { onState: (s) => seen.push(s.state) });
    first = r.record;
    expect(r.record.state, r.record.reasons.join(',')).toBe('ready');
    expect(seen.filter((s, i) => s !== seen[i - 1])).toEqual(['queued', 'preflight', 'staging', 'building', 'verifying', 'smoke', 'activating', 'ready']);
    const m = r.manifest!;
    expect(m.smoke.passed).toBe(true);
    expect(m.smoke.cases.map((c) => c.id)).toContain('vote-over-gate-input');
    expect(m.smoke.cases.every((c) => c.passed)).toBe(true);
    expect(m.binary.version_text).toMatch(/^SCRAM 0\.16\.2/);
    expect(m.binary.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.source_commit).toBe('9c9a75ca0c5c2fbb5b4a7d32e29fd25bf90f7bab');
    expect(m.expanded_bytes!).toBeGreaterThan(5e8);
    expect(await verifyActive(env)).toEqual([]);
    expect(status(env).active!.install_id).toBe(first.id);
  }, 1500000);

  it('the installed engine runs a real analysis and the record names the runtime that produced it', async () => {
    const engine = resolveEngine(env);
    const r = await analyzeWith(engine, 'pra-pump3-shared');
    expect(r).toMatchObject({ p: 0.0595, status: 'completed' });
    expect(r.runtime).toMatchObject({ install_id: first.id, recipe_revision: 1 });
  }, 300000);

  it('a swapped binary is refused: analysis against a wrong pinned hash fails before it runs', async () => {
    const wrong = { ...resolveEngine(env), expectedSha256: '0'.repeat(64) };
    const out = await analyze(JSON.stringify(ORACLE_MODELS['pra-and']), { runsDir: path.join(ROOT, 'runs', 'runtime-itest', 'analysis'), engine: wrong });
    expect(out.kind === 'ran' && out.record.reasons).toEqual(['engine-build-mismatch']);
  }, 300000);

  it('a second install keeps the first usable, and rollback returns to it', async () => {
    const second = await install(env, loaded);
    expect(second.record.state, second.record.reasons.join(',')).toBe('ready');
    expect(second.manifest!.binary.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(status(env).active!.previous).toBe(first.prefix);
    expect((await analyzeWith(resolveEngine(env), 'pra-and')).p).toBe(0.02);

    const back = await rollback(env);
    expect(back).toMatchObject({ install_id: first.id, previous: second.record.prefix });
    expect(await verifyActive(env)).toEqual([]);
    const r = await analyzeWith(resolveEngine(env), 'pra-and');
    expect(r).toMatchObject({ p: 0.02, status: 'completed' });
    expect(r.runtime).toMatchObject({ install_id: first.id });
  }, 1800000);

  it('cancelling in the middle of a real compile stops the build, removes the partial prefix and leaves the active runtime alone', async () => {
    const pointerBefore = readFileSync(path.join(env.stateDir, 'scram', 'active.json'), 'utf8');
    const abort = new AbortController();
    let prefix = '';
    const states: string[] = [];
    const done = install(env, loaded, {
      signal: abort.signal,
      onState: (s) => {
        prefix = s.prefix;
        states.push(`${s.state}/${s.step}`);
        if (s.state === 'building' && s.step === 'compile') setTimeout(() => abort.abort(), 10000);
      },
    });
    const r = await done;
    expect(r.record).toMatchObject({ state: 'cancelled', reasons: ['cancelled'] });
    expect(states).toContain('building/compile');
    expect(await linuxProcessCount(prefix), 'no cmake, ninja or compiler process of this install survives').toBe(0);
    expect(await dirExists(prefix), 'the partial prefix is gone').toBe(false);
    expect(readFileSync(path.join(env.stateDir, 'scram', 'active.json'), 'utf8')).toBe(pointerBefore);
    expect(existsSync(path.join(env.stateDir, 'scram', 'lock.json'))).toBe(false);
    expect(await verifyActive(env)).toEqual([]);
  }, 600000);

  it('recovery on a clean state does nothing', async () => {
    expect(await recover(env)).toEqual([]);
  }, 60000);
});

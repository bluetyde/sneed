import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ExecResult } from '../../src/core/engine.js';
import {
  RuntimeBusyError,
  STALE_AFTER_MS,
  assertLinuxRoot,
  assertManagedPrefix,
  expand,
  install,
  recover,
  resolveEngine,
  rollback,
  status,
  verifyActive,
  type InstallRecord,
  type InstallState,
  type RuntimeEnv,
  type StepRunOptions,
  type StepRunner,
} from '../../src/runtime/install.js';
import { loadRecipe } from '../../src/runtime/recipe.js';

const loaded = loadRecipe(path.resolve(import.meta.dirname, '../../runtime'));
const COMMIT = loaded.recipe.trust.source_commit;
const BIN_SHA = 'b'.repeat(64);
const LINUX_ROOT = '/root/sneed-test';
const OK_SMOKE = async (): Promise<{ id: string; passed: boolean; reason: null; probability: number; status: string }[]> => [{ id: 'fake', passed: true, reason: null, probability: 0.02, status: 'completed' }];

interface Call {
  argv: string[];
  opts: StepRunOptions;
}
interface Fake {
  runner: StepRunner;
  calls: Call[];
  joined: () => string[];
}
type Handler = (argv: string[], opts: StepRunOptions) => ExecResult | undefined | Promise<ExecResult | undefined>;
const result = (over: Partial<ExecResult> = {}): ExecResult => ({ exit: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, durationMs: 1, ...over });

/** An in-memory stand-in for the Linux side. Unknown commands succeed quietly. */
function fakeLinux(handle?: Handler, config: { free?: number; missing?: string[]; lockSha?: string; binSha?: string } = {}): Fake {
  const calls: Call[] = [];
  const runner: StepRunner = async (argv, opts) => {
    calls.push({ argv, opts });
    const custom = await handle?.(argv, opts);
    if (custom) return custom;
    const cmd = argv[0]!;
    const text = argv.join(' ');
    if ((cmd.endsWith('/conda') || cmd.endsWith('/git')) && argv[1] === '--version') {
      return config.missing?.some((m) => cmd.endsWith(m)) ? result({ exit: 127 }) : result({ stdout: 'tool 1.0\n' });
    }
    if (cmd === '/usr/bin/df') return result({ stdout: `Avail\n${config.free ?? 500_000_000_000}\n` });
    if (cmd === '/usr/bin/nproc') return result({ stdout: '16\n' });
    if (cmd === '/usr/bin/sha256sum') return result({ stdout: `${argv[1]!.endsWith('toolchain.lock') ? (config.lockSha ?? loaded.lockSha256) : (config.binSha ?? BIN_SHA)}  ${argv[1]}\n` });
    if (argv.includes('rev-parse')) return result({ stdout: COMMIT + '\n' });
    if (text.includes('--version') && text.includes('/build/bin/scram')) return result({ stdout: 'SCRAM 0.16.2 ()\n\nDependencies:\n' });
    if (cmd === '/usr/bin/du') return result({ stdout: `1234567\t${argv[2]}\n` });
    return result();
  };
  return { runner, calls, joined: () => calls.map((c) => c.argv.join(' ')) };
}

let tmp: string;
let env: RuntimeEnv;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sneed-install-'));
  env = { distro: 'Ubuntu', linuxRoot: LINUX_ROOT, stateDir: path.join(tmp, 'state') };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const recordFiles = (): string[] => (existsSync(path.join(env.stateDir, 'scram/installs')) ? readdirSync(path.join(env.stateDir, 'scram/installs')).filter((f) => f.endsWith('.json')) : []);
const activeFile = (): string => path.join(env.stateDir, 'scram/active.json');
const lockFile = (): string => path.join(env.stateDir, 'scram/lock.json');
const rmCalls = (f: Fake): string[][] => f.calls.map((c) => c.argv).filter((a) => a[0] === '/usr/bin/rm' && a.includes('-rf'));

describe('a successful install', () => {
  it('goes through the transaction states in order and ends ready', async () => {
    const f = fakeLinux();
    const seen: InstallState[] = [];
    const { record, manifest } = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE, onState: (r) => seen.push(r.state) });
    const order = seen.filter((s, i) => s !== seen[i - 1]);
    expect(order).toEqual(['queued', 'preflight', 'staging', 'building', 'verifying', 'smoke', 'activating', 'ready']);
    expect(record).toMatchObject({ state: 'ready', reasons: [], step: null });
    expect(manifest).not.toBeNull();
  });

  it('records what was built and points the active pointer at it, atomically after the checks', async () => {
    const f = fakeLinux();
    const { record, manifest } = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE });
    const m = manifest!;
    expect(m).toMatchObject({ install_id: record.id, source_commit: COMMIT, recipe_sha256: loaded.recipeSha256, toolchain_lock_sha256: loaded.lockSha256, distro: 'Ubuntu' });
    expect(m.binary).toMatchObject({ sha256: BIN_SHA, version_text: expect.stringMatching(/^SCRAM 0\.16\.2/) as unknown as string });
    expect(m.binary.path).toBe(`${record.prefix}/build/bin/scram`);
    expect(m.library_dirs).toEqual([`${record.prefix}/build/lib/scram`, `${record.prefix}/env/lib`]);
    expect(m.expanded_bytes).toBe(1234567);
    expect(m.smoke.passed).toBe(true);
    const active = JSON.parse(readFileSync(activeFile(), 'utf8'));
    expect(active).toMatchObject({ install_id: record.id, prefix: record.prefix, previous: null });
    const manifestBytes = readFileSync(path.join(env.stateDir, 'scram/installed', `${record.id}.json`));
    expect(active.manifest_sha256).toBe(createHash('sha256').update(manifestBytes).digest('hex'));
    expect(f.joined().some((c) => c.includes('.sneed-ready'))).toBe(true);
  });

  it('expands every placeholder, runs steps in recipe order and never invokes a shell', async () => {
    const f = fakeLinux();
    const { record } = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE });
    for (const c of f.calls) for (const a of c.argv) expect(a, c.argv.join(' ')).not.toContain('${');
    for (const c of f.calls) expect(c.argv[0]).not.toMatch(/(^|\/)(ba|da|z)?sh$/);
    const stepCalls = f.joined();
    const idx = (needle: string): number => stepCalls.findIndex((c) => c.includes(needle));
    expect(idx('create --yes')).toBeLessThan(idx('fetch --quiet'));
    expect(idx('fetch --quiet')).toBeLessThan(idx('rev-parse HEAD'));
    expect(idx('rev-parse HEAD')).toBeLessThan(idx('-G Ninja'));
    expect(idx('-G Ninja')).toBeLessThan(idx('--target scram-cli'));
    expect(f.joined().find((c) => c.includes('create --yes'))).toContain(`--prefix ${record.prefix}/env --file ${record.prefix}/toolchain.lock`);
    expect(f.joined().find((c) => c.includes('--parallel'))).toContain('--parallel 8'); // 16 cores, capped at 8
    expect(f.joined().find((c) => c.includes('-G Ninja'))).toContain(`PATH=${record.prefix}/env/bin:/usr/bin:/bin`);
  });

  it('every build step names the prefix in its arguments, so cancel can find exactly its processes', async () => {
    const f = fakeLinux();
    const { record } = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE });
    const steps = f.calls.filter((c) => c.opts.ownerTag === record.prefix);
    expect(steps.length).toBeGreaterThanOrEqual(loaded.recipe.steps.length);
    for (const c of steps) expect(c.argv.join(' '), c.argv.join(' ')).toContain(record.prefix);
  });

  it('writes a record for every transition and releases the lock', async () => {
    const f = fakeLinux();
    let last: InstallRecord | null = null;
    const { record } = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE, onState: (r) => (last = r) });
    expect(recordFiles()).toEqual([`${record.id}.json`]);
    expect(JSON.parse(readFileSync(path.join(env.stateDir, 'scram/installs', `${record.id}.json`), 'utf8'))).toEqual(last);
    expect(existsSync(lockFile())).toBe(false);
    expect(existsSync(path.join(env.stateDir, 'scram/lock.heartbeat'))).toBe(false);
  });

  it('a second install keeps the first on disk and records it as previous', async () => {
    const f = fakeLinux();
    const a = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE });
    const b = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE });
    expect(b.record.id).not.toBe(a.record.id);
    expect(JSON.parse(readFileSync(activeFile(), 'utf8'))).toMatchObject({ install_id: b.record.id, previous: a.record.prefix });
    expect(rmCalls(f)).toEqual([]); // nothing was deleted
    expect(status(env).installs.map((r) => r.state)).toEqual(['ready', 'ready']);
  });
});

describe('failures never disturb the active version', () => {
  async function withActive(): Promise<{ prefix: string; pointer: string }> {
    const first = await install(env, loaded, { runner: fakeLinux().runner, smoke: OK_SMOKE });
    return { prefix: first.record.prefix, pointer: readFileSync(activeFile(), 'utf8') };
  }

  const stepIs = (needle: string): ((argv: string[]) => boolean) => (argv) => argv.join(' ').includes(needle);

  it('a build step that fails: failed, reasons name the step and exit code, prefix removed, active unchanged', async () => {
    const before = await withActive();
    const f = fakeLinux((argv) => (stepIs('--target scram-cli')(argv) ? result({ exit: 2, stderr: 'error' }) : undefined));
    const { record, manifest } = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE });
    expect(record).toMatchObject({ state: 'failed', reasons: ['step-failed:compile', 'exit-2'] });
    expect(manifest).toBeNull();
    expect(readFileSync(activeFile(), 'utf8')).toBe(before.pointer);
    expect(rmCalls(f).map((a) => a[a.length - 1])).toEqual([record.prefix]);
    expect(existsSync(lockFile())).toBe(false);
    expect(readFileSync(path.join(env.stateDir, 'scram/installs', record.id, 'compile.stderr.txt'), 'utf8')).toBe('error');
  });

  it('a step that times out', async () => {
    const f = fakeLinux((argv) => (stepIs('--target scram-cli')(argv) ? result({ exit: null, timedOut: true }) : undefined));
    const { record } = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE });
    expect(record).toMatchObject({ state: 'failed', reasons: ['step-timeout:compile'] });
  });

  it('a checkout that is not the pinned commit stops the install before anything is built', async () => {
    const f = fakeLinux((argv) => (argv.includes('rev-parse') ? result({ stdout: 'f'.repeat(40) + '\n' }) : undefined));
    const { record } = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE });
    expect(record).toMatchObject({ state: 'failed', reasons: ['step-expectation:source-verify'] });
    expect(f.joined().some((c) => c.includes('-G Ninja'))).toBe(false);
  });

  it('a lock copy that does not match the recipe hash stops the install before the toolchain step', async () => {
    const f = fakeLinux(undefined, { lockSha: 'c'.repeat(64) });
    const { record } = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE });
    expect(record).toMatchObject({ state: 'failed', reasons: ['toolchain-lock-mismatch'] });
    expect(f.joined().some((c) => c.includes('create --yes'))).toBe(false);
  });

  it('a missing prerequisite is reported by name and nothing is created', async () => {
    const f = fakeLinux(undefined, { missing: ['/conda'] });
    const { record } = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE });
    expect(record).toMatchObject({ state: 'failed', reasons: ['prerequisite-missing:conda'] });
    expect(f.joined().some((c) => c.startsWith('/usr/bin/mkdir'))).toBe(false);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('too little disk space is a failure before any download', async () => {
    const f = fakeLinux(undefined, { free: 1_000_000_000 });
    const { record } = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE });
    expect(record.state).toBe('failed');
    expect(record.reasons[0]).toMatch(/^not-enough-disk:1000000000</);
    expect(f.joined().some((c) => c.includes('create --yes'))).toBe(false);
  });

  it('a binary that reports another version is refused', async () => {
    const f = fakeLinux((argv) => (argv.join(' ').includes('/build/bin/scram') && argv.includes('--version') && argv[0] === '/usr/bin/env' && !argv.join(' ').includes('PATH=') ? undefined : undefined));
    const bad = fakeLinux((argv) => (argv.join(' ').includes('/build/bin/scram') && argv.includes('--version') ? result({ stdout: 'SCRAM 0.15.0 ()\n' }) : undefined));
    const { record } = await install(env, loaded, { runner: bad.runner, smoke: OK_SMOKE });
    expect(record.state).toBe('failed');
    expect(record.reasons.some((r) => r.startsWith('step-expectation:') || r === 'binary-version-mismatch')).toBe(true);
    void f;
  });

  it('a failing smoke check means the build is never activated, and previous stays', async () => {
    const before = await withActive();
    const f = fakeLinux();
    const bad = async (): Promise<never[] | { id: string; passed: boolean; reason: string; probability: number; status: string }[]> => [
      { id: 'pra-and', passed: true, reason: null as never, probability: 0.02, status: 'completed' },
      { id: 'vote-over-gate-input', passed: false, reason: 'probability-differs', probability: 0.44, status: 'completed' },
    ];
    const { record } = await install(env, loaded, { runner: f.runner, smoke: bad as never });
    expect(record).toMatchObject({ state: 'failed', reasons: ['smoke-failed:vote-over-gate-input'] });
    expect(readFileSync(activeFile(), 'utf8')).toBe(before.pointer);
    expect(rmCalls(f)).toHaveLength(1);
  });

  it('keepFailed leaves the partial prefix for diagnosis', async () => {
    const f = fakeLinux((argv) => (argv.join(' ').includes('--target scram-cli') ? result({ exit: 1 }) : undefined));
    await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE, keepFailed: true });
    expect(rmCalls(f)).toEqual([]);
  });

  it('an unexpected exception becomes a failed record, releases the lock and leaves the active pointer', async () => {
    const before = await withActive();
    const f = fakeLinux();
    const boom = (): never => {
      throw new Error('smoke exploded');
    };
    const { record } = await install(env, loaded, { runner: f.runner, smoke: boom as never });
    expect(record.state).toBe('failed');
    expect(record.reasons[0]).toContain('internal-error:smoke exploded');
    expect(existsSync(lockFile())).toBe(false);
    expect(readFileSync(activeFile(), 'utf8')).toBe(before.pointer);
  });
});

describe('cancellation', () => {
  it('cancelling during the build ends as cancelled, removes the partial prefix and keeps the active pointer', async () => {
    const first = await install(env, loaded, { runner: fakeLinux().runner, smoke: OK_SMOKE });
    const pointer = readFileSync(activeFile(), 'utf8');
    const abort = new AbortController();
    const f = fakeLinux((argv, opts) => {
      if (argv.join(' ').includes('--target scram-cli')) {
        return new Promise<ExecResult>((resolve) => {
          opts.signal?.addEventListener('abort', () => resolve(result({ exit: null, cancelled: true })), { once: true });
          setTimeout(() => abort.abort(), 20);
        });
      }
      return undefined;
    });
    const { record } = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE, signal: abort.signal });
    expect(record).toMatchObject({ state: 'cancelled', reasons: ['cancelled'] });
    expect(readFileSync(activeFile(), 'utf8')).toBe(pointer);
    expect(JSON.parse(pointer).install_id).toBe(first.record.id);
    expect(rmCalls(f)).toHaveLength(1);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('cancelling before anything runs starts nothing', async () => {
    const abort = new AbortController();
    abort.abort();
    const f = fakeLinux();
    const { record } = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE, signal: abort.signal });
    expect(record.state).toBe('cancelled');
    expect(f.joined().some((c) => c.includes('create --yes'))).toBe(false);
  });

  it('cancelling after the smoke checks still wins over activation', async () => {
    const abort = new AbortController();
    const f = fakeLinux();
    const { record } = await install(env, loaded, {
      runner: f.runner,
      signal: abort.signal,
      smoke: async () => {
        abort.abort();
        return OK_SMOKE();
      },
    });
    expect(record.state).toBe('cancelled');
    expect(existsSync(activeFile())).toBe(false);
  });
});

describe('one install at a time, and recovery after a crash', () => {
  it('a second install while one is running is refused as busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = fakeLinux(async (argv) => {
      if (argv.join(' ').includes('--target scram-cli')) await gate;
      return undefined;
    });
    const first = install(env, loaded, { runner: slow.runner, smoke: OK_SMOKE });
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(lockFile())).toBe(true);
    await expect(install(env, loaded, { runner: fakeLinux().runner, smoke: OK_SMOKE })).rejects.toBeInstanceOf(RuntimeBusyError);
    expect(status(env).lockHeld).toBe(true);
    expect(status(env).lockStale).toBe(false);
    release();
    expect((await first).record.state).toBe('ready');
    expect(existsSync(lockFile())).toBe(false);
  });

  /** A crashed install: a non-terminal record, a lock, and a heartbeat that stopped. */
  function crash(id: string, ageMs: number, prefix = `${LINUX_ROOT}/scram/0.16.2-r1-20261005T120000Z-abcdef`): void {
    const dir = path.join(env.stateDir, 'scram');
    mkdirSync(path.join(dir, 'installs'), { recursive: true });
    const rec: InstallRecord = { schema_version: 1, id, artifact: { id: 'scram', version: '0.16.2', recipe_revision: 1 }, recipe_sha256: 'x', prefix, state: 'building', step: 'compile', started_at: 'a', updated_at: 'a', reasons: [], previous_active: null };
    writeFileSync(path.join(dir, 'installs', `${id}.json`), JSON.stringify(rec));
    writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({ id, pid: 999999, token: 't', created: 'a' }));
    const hb = path.join(dir, 'lock.heartbeat');
    writeFileSync(hb, 'x');
    const t = new Date(Date.now() - ageMs);
    utimesSync(hb, t, t);
  }

  it('recover marks the abandoned install interrupted, removes its partial prefix and frees the lock', async () => {
    crash('dead1', STALE_AFTER_MS + 5000);
    const f = fakeLinux();
    const touched = await recover(env, { runner: f.runner });
    expect(touched.map((r) => [r.id, r.state, r.reasons])).toEqual([['dead1', 'interrupted', ['owner-lost']]]);
    expect(rmCalls(f).map((a) => a[a.length - 1])).toEqual([`${LINUX_ROOT}/scram/0.16.2-r1-20261005T120000Z-abcdef`]);
    expect(existsSync(lockFile())).toBe(false);
    expect(status(env).installs[0]!.state).toBe('interrupted');
    // owned processes are stopped before the directory is deleted, and only those carrying the prefix
    const order = f.calls.map((c) => c.argv[0]);
    expect(order.indexOf('/usr/bin/pkill')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('/usr/bin/pkill')).toBeLessThan(order.indexOf('/usr/bin/rm'));
    expect(f.calls.find((c) => c.argv[0] === '/usr/bin/pkill')!.argv.at(-1)).toBe('/root/sneed-test/scram/0\\.16\\.2-r1-20261005T120000Z-abcdef');
  });

  it('recover leaves a live install alone', async () => {
    crash('alive', 1000);
    const f = fakeLinux();
    expect(await recover(env, { runner: f.runner })).toEqual([]);
    expect(rmCalls(f)).toEqual([]);
    expect(existsSync(lockFile())).toBe(true);
    expect(status(env).installs[0]!.state).toBe('building');
  });

  it('recover never touches the active pointer or finished installs', async () => {
    const ok = await install(env, loaded, { runner: fakeLinux().runner, smoke: OK_SMOKE });
    const pointer = readFileSync(activeFile(), 'utf8');
    crash('dead2', STALE_AFTER_MS + 5000);
    await recover(env, { runner: fakeLinux().runner });
    expect(readFileSync(activeFile(), 'utf8')).toBe(pointer);
    expect(status(env).installs.find((r) => r.id === ok.record.id)!.state).toBe('ready');
  });

  it('a new install after a crash recovers first, then proceeds', async () => {
    crash('dead3', STALE_AFTER_MS + 5000);
    const f = fakeLinux();
    const { record } = await install(env, loaded, { runner: f.runner, smoke: OK_SMOKE });
    expect(record.state).toBe('ready');
    expect(status(env).installs.find((r) => r.id === 'dead3')!.state).toBe('interrupted');
  });

  it('a forged record pointing outside the managed area is never deleted', async () => {
    for (const prefix of ['/', '/root', '/etc', `${LINUX_ROOT}/scram/../../etc`, `${LINUX_ROOT}/scram/not-a-version-dir`, `${LINUX_ROOT}/other/0.16.2-r1-20261005T120000Z-abcdef`]) {
      crash('forged', STALE_AFTER_MS + 5000, prefix);
      const f = fakeLinux();
      await recover(env, { runner: f.runner });
      expect(rmCalls(f), prefix).toEqual([]);
      rmSync(path.join(env.stateDir, 'scram'), { recursive: true, force: true });
    }
  });
});

describe('the Linux root is validated before anything happens', () => {
  it('accepts plain absolute paths', () => {
    for (const ok of ['/root/sneed-runtime', '/home/student/sneed.runtime/v1', '/opt/sneed_runtime']) expect(() => assertLinuxRoot(ok), ok).not.toThrow();
  });

  it('refuses relative, Windows-looking, spaced, traversing and root-level values', () => {
    // the first value is what Git Bash turned /root/sneed-runtime-test into during development
    for (const bad of ['C:/Program Files/Git/root/sneed-runtime-test', 'root/sneed', './x', '', '/', '//', '/root//x', '/root/../etc', '/root/./x', '/root/with space', '/root/x/', '~/sneed', '$HOME/x', '/root/a;b']) {
      expect(() => assertLinuxRoot(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });

  it('install refuses a bad root before it creates any state, lock or process', async () => {
    const f = fakeLinux();
    await expect(install({ ...env, linuxRoot: 'C:/Program Files/Git/root/sneed-runtime-test' }, loaded, { runner: f.runner, smoke: OK_SMOKE })).rejects.toThrow(RangeError);
    expect(f.calls).toEqual([]);
    expect(existsSync(env.stateDir)).toBe(false);
  });

  it('nothing is ever deleted under a bad root, even for a forged record', () => {
    expect(() => assertManagedPrefix({ ...env, linuxRoot: 'C:/Program Files/Git/root/x' }, 'C:/Program Files/Git/root/x/scram/0.16.2-r1-20261005T120000Z-abcdef')).toThrow(RangeError);
  });
});

describe('only managed prefixes are ever deleted', () => {
  const good = `${LINUX_ROOT}/scram/0.16.2-r1-20261005T120000Z-abcdef`;
  it('accepts exactly the names this runner creates', () => {
    expect(() => assertManagedPrefix(env, good)).not.toThrow();
  });
  it('refuses everything else', () => {
    for (const bad of ['', '/', '/root', LINUX_ROOT, `${LINUX_ROOT}/scram`, `${LINUX_ROOT}/scram/`, `${good}/x`, `${good}/..`, `${LINUX_ROOT}/scram/0.16.2-r1-20261005T120000Z-ABCDEF`, `${LINUX_ROOT}/scram/..`, `/tmp${good}`]) {
      expect(() => assertManagedPrefix(env, bad), JSON.stringify(bad)).toThrow(/did not create/);
    }
  });
});

describe('verifying and resolving the active runtime', () => {
  async function installed(): Promise<{ id: string; prefix: string }> {
    const { record } = await install(env, loaded, { runner: fakeLinux().runner, smoke: OK_SMOKE });
    return { id: record.id, prefix: record.prefix };
  }

  it('reports no runtime before the first install', async () => {
    expect((await verifyActive(env, { runner: fakeLinux().runner })).map((i) => i.code)).toEqual(['no-active-runtime']);
    expect(() => resolveEngine(env)).toThrow(/no active SCRAM runtime/);
  });

  it('a healthy runtime verifies clean', async () => {
    await installed();
    expect(await verifyActive(env, { runner: fakeLinux().runner })).toEqual([]);
  });

  it('detects a swapped binary, a changed version, a missing ready marker and a missing binary', async () => {
    await installed();
    expect((await verifyActive(env, { runner: fakeLinux(undefined, { binSha: 'd'.repeat(64) }).runner })).map((i) => i.code)).toEqual(['binary-changed']);
    const wrongVersion = fakeLinux((argv) => (argv.includes('--version') && argv.join(' ').includes('/build/bin/scram') ? result({ stdout: 'SCRAM 0.16.3 ()\n' }) : undefined));
    expect((await verifyActive(env, { runner: wrongVersion.runner })).map((i) => i.code)).toEqual(['version-mismatch']);
    const notReady = fakeLinux((argv) => (argv[0] === '/usr/bin/test' ? result({ exit: 1 }) : undefined));
    expect((await verifyActive(env, { runner: notReady.runner })).map((i) => i.code)).toEqual(['not-ready']);
    const gone = fakeLinux((argv) => (argv[0] === '/usr/bin/sha256sum' ? result({ exit: 1 }) : undefined));
    expect((await verifyActive(env, { runner: gone.runner })).map((i) => i.code)).toEqual(['binary-missing']);
  });

  it('detects a manifest that was edited or deleted after activation', async () => {
    const { id } = await installed();
    const file = path.join(env.stateDir, 'scram/installed', `${id}.json`);
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace('"smoke"', '"smoke_"'));
    expect((await verifyActive(env, { runner: fakeLinux().runner })).map((i) => i.code)).toEqual(['manifest-changed']);
    expect(() => resolveEngine(env)).toThrow(/missing or changed/);
    rmSync(file);
    expect((await verifyActive(env, { runner: fakeLinux().runner })).map((i) => i.code)).toEqual(['manifest-missing']);
  });

  it('resolveEngine gives the analysis layer the installed binary, its pinned hash and its runtime identity', async () => {
    const { id, prefix } = await installed();
    const cfg = resolveEngine(env);
    expect(cfg).toMatchObject({ distro: 'Ubuntu', binary: `${prefix}/build/bin/scram`, expectedVersion: '0.16.2', expectedSha256: BIN_SHA });
    expect(cfg.libs).toBe(`${prefix}/build/lib/scram:${prefix}/env/lib`);
    expect(cfg.runtime).toMatchObject({ install_id: id, recipe_revision: 1 });
    expect(cfg.runtime!.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('rollback', () => {
  const twice = async (): Promise<{ first: InstallRecord; second: InstallRecord }> => {
    const first = await install(env, loaded, { runner: fakeLinux().runner, smoke: OK_SMOKE });
    const second = await install(env, loaded, { runner: fakeLinux().runner, smoke: OK_SMOKE });
    return { first: first.record, second: second.record };
  };

  it('switches back to the previous runtime and records the one it left as previous', async () => {
    const { first, second } = await twice();
    expect(JSON.parse(readFileSync(activeFile(), 'utf8')).install_id).toBe(second.id);
    const p = await rollback(env, { runner: fakeLinux().runner });
    expect(p).toMatchObject({ install_id: first.id, prefix: first.prefix, previous: second.prefix });
    expect(JSON.parse(readFileSync(activeFile(), 'utf8'))).toEqual(p);
    expect(resolveEngine(env).binary).toBe(`${first.prefix}/build/bin/scram`);
    expect(await verifyActive(env, { runner: fakeLinux().runner })).toEqual([]);
  });

  it('rolling back twice returns to the newer runtime (history is never rewritten)', async () => {
    const { first, second } = await twice();
    await rollback(env, { runner: fakeLinux().runner });
    const again = await rollback(env, { runner: fakeLinux().runner });
    expect(again).toMatchObject({ install_id: second.id, previous: first.prefix });
  });

  it('is refused when there is nothing to go back to', async () => {
    await expect(rollback(env, { runner: fakeLinux().runner })).rejects.toThrow(/no active runtime/);
    await install(env, loaded, { runner: fakeLinux().runner, smoke: OK_SMOKE });
    await expect(rollback(env, { runner: fakeLinux().runner })).rejects.toThrow(/no previous runtime/);
  });

  it('is refused when the previous runtime no longer verifies, and the pointer is left alone', async () => {
    await twice();
    const pointer = readFileSync(activeFile(), 'utf8');
    await expect(rollback(env, { runner: fakeLinux(undefined, { binSha: 'e'.repeat(64) }).runner })).rejects.toThrow(/does not verify: binary-changed/);
    expect(readFileSync(activeFile(), 'utf8')).toBe(pointer);
  });

  it('is refused while an install holds the lock', async () => {
    await twice();
    writeFileSync(lockFile(), JSON.stringify({ id: 'busy', pid: 1, token: 't', created: 'a' }));
    await expect(rollback(env, { runner: fakeLinux().runner })).rejects.toBeInstanceOf(RuntimeBusyError);
  });

  it('is refused when the previous manifest is gone', async () => {
    const { first } = await twice();
    rmSync(path.join(env.stateDir, 'scram/installed', `${first.id}.json`));
    await expect(rollback(env, { runner: fakeLinux().runner })).rejects.toThrow(/no installed manifest/);
  });
});

describe('expand', () => {
  it('substitutes known names and refuses unknown ones', () => {
    expect(expand('${A}/x/${B}', { A: '1', B: '2' })).toBe('1/x/2');
    expect(expand('no placeholders', {})).toBe('no placeholders');
    expect(() => expand('${MISSING}', { A: '1' })).toThrow(/no value for \$\{MISSING\}/);
  });
});

describe('state directory hygiene', () => {
  it('nothing is written outside the state directory on the Windows side', async () => {
    expect(readdirSync(tmp)).toEqual([]);
    await install(env, loaded, { runner: fakeLinux().runner, smoke: OK_SMOKE });
    expect(readdirSync(tmp)).toEqual(['state']);
    expect(statSync(env.stateDir).isDirectory()).toBe(true);
    expect(readdirSync(path.join(env.stateDir, 'scram')).sort()).toEqual(['active.json', 'installed', 'installs']);
  });
});

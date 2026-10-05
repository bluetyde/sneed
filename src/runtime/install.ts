import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { execInWsl, regexEscape, toWslPath, type EngineConfig, type ExecResult } from '../core/engine.js';
import type { LoadedRecipe, RecipeStep } from './recipe.js';
import { runSmoke, type SmokeResult } from './smoke.js';

export type InstallState = 'queued' | 'preflight' | 'staging' | 'building' | 'verifying' | 'smoke' | 'activating' | 'ready' | 'failed' | 'cancelled' | 'interrupted';
const TERMINAL: InstallState[] = ['ready', 'failed', 'cancelled', 'interrupted'];

export interface RuntimeEnv {
  /** WSL distribution that holds the runtime. */
  distro: string;
  /** Linux directory under which versioned prefixes are created, e.g. /root/sneed-runtime. */
  linuxRoot: string;
  /** Windows directory for state: active pointer, install records, logs, installed manifests. */
  stateDir: string;
}

export interface StepRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  ownerTag: string;
}
/** Runs one argument list in the Linux side. Injectable so the transaction logic can be tested without WSL. */
export type StepRunner = (argv: string[], opts: StepRunOptions) => Promise<ExecResult>;

export const wslRunner = (distro: string): StepRunner => (argv, opts) => execInWsl(distro, argv, opts);

export interface InstallRecord {
  schema_version: 1;
  id: string;
  artifact: { id: string; version: string; recipe_revision: number };
  recipe_sha256: string;
  prefix: string;
  state: InstallState;
  step: string | null;
  started_at: string;
  updated_at: string;
  reasons: string[];
  previous_active: string | null;
}

export interface InstalledManifest {
  schema: { id: 'sneed.runtime-installed'; version: 1 };
  install_id: string;
  artifact: { id: string; version: string; recipe_revision: number };
  recipe_sha256: string;
  toolchain_lock_sha256: string;
  source_commit: string;
  prefix: string;
  distro: string;
  binary: { path: string; sha256: string; version_text: string };
  library_dirs: string[];
  built_at: string;
  expanded_bytes: number | null;
  steps: { id: string; seconds: number }[];
  smoke: { passed: boolean; cases: SmokeResult[] };
}

export interface ActivePointer {
  schema_version: 1;
  install_id: string;
  prefix: string;
  manifest_sha256: string;
  activated_at: string;
  previous: string | null;
}

export class RuntimeBusyError extends Error {
  constructor(readonly holder: string) {
    super(`another install is in progress (${holder})`);
  }
}

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const now = (): string => new Date().toISOString();
const dirOf = (env: RuntimeEnv): string => path.join(env.stateDir, 'scram');
const PREFIX_NAME = /^[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;
const HEARTBEAT_MS = 5000;
export const STALE_AFTER_MS = 60000;

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}
const readJson = <T>(file: string): T | null => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null);

/** Substitutes ${NAME}. Throws for a name with no value, so an unresolved variable never reaches a command. */
export function expand(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{([^}]*)\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`no value for \${${name}}`);
    return v;
  });
}

/**
 * The Linux root must be a plain absolute path. A relative or Windows-looking value (for example one rewritten by
 * a Windows shell, "C:/Program Files/Git/root/...") would make every command act on the wrong directory.
 */
export function assertLinuxRoot(root: string): void {
  if (!/^\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(root)) {
    throw new RangeError(`the Linux runtime root must be a plain absolute path such as /root/sneed-runtime, got ${JSON.stringify(root)}`);
  }
}

/** Only a prefix this runner created may be deleted. */
export function assertManagedPrefix(env: RuntimeEnv, prefix: string): void {
  assertLinuxRoot(env.linuxRoot);
  const parent = path.posix.join(env.linuxRoot, 'scram');
  const name = prefix.startsWith(parent + '/') ? prefix.slice(parent.length + 1) : '';
  if (!PREFIX_NAME.test(name) || prefix.includes('..')) throw new Error(`refusing to touch a path this runner did not create: ${prefix}`);
}

export function isStaleLock(env: RuntimeEnv, nowMs = Date.now()): boolean {
  const lock = path.join(dirOf(env), 'lock.json');
  if (!existsSync(lock)) return false;
  const heartbeat = path.join(dirOf(env), 'lock.heartbeat');
  const ref = existsSync(heartbeat) ? statSync(heartbeat).mtimeMs : statSync(lock).mtimeMs;
  return nowMs - ref > STALE_AFTER_MS;
}

export interface InstallOptions {
  signal?: AbortSignal;
  runner?: StepRunner;
  /** Called for every state change (the UI progress feed). */
  onState?: (r: InstallRecord) => void;
  /** Leave a failed prefix in place for diagnosis. The default removes it. */
  keepFailed?: boolean;
  /** Smoke implementation; the default runs the recipe's native checks through the real pipeline. */
  smoke?: (loaded: LoadedRecipe, engine: EngineConfig, runsDir: string) => Promise<SmokeResult[]>;
  /** Replaced in tests to avoid waiting on wall-clock heartbeats. */
  heartbeatMs?: number;
}

export interface InstallResult {
  record: InstallRecord;
  manifest: InstalledManifest | null;
}

/** Installs the recipe into a new versioned prefix and activates it only after every check passes. */
export async function install(env: RuntimeEnv, loaded: LoadedRecipe, opts: InstallOptions = {}): Promise<InstallResult> {
  assertLinuxRoot(env.linuxRoot); // before any file or process is created
  const runner = opts.runner ?? wslRunner(env.distro);
  const dir = dirOf(env);
  mkdirSync(path.join(dir, 'installs'), { recursive: true });

  // serialise installs: one lock, with a heartbeat so a dead holder is detectable (a pid alone is not)
  const lockFile = path.join(dir, 'lock.json');
  const heartbeatFile = path.join(dir, 'lock.heartbeat');
  const id = `${now().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(3).toString('hex')}`;
  const tryLock = (): boolean => {
    try {
      const fd = openSync(lockFile, 'wx');
      writeFileSync(fd, JSON.stringify({ id, pid: process.pid, token: randomBytes(8).toString('hex'), created: now() }) + '\n');
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  };
  if (!tryLock()) {
    if (!isStaleLock(env)) throw new RuntimeBusyError(readJson<{ id: string }>(lockFile)?.id ?? 'unknown');
    await recover(env, opts.runner ? { runner: opts.runner } : {});
    if (!tryLock()) throw new RuntimeBusyError('lock could not be taken after recovery');
  }
  writeFileSync(heartbeatFile, now());
  const beat = setInterval(() => {
    try {
      utimesSync(heartbeatFile, new Date(), new Date());
    } catch {
      /* the lock directory may be gone during teardown */
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  beat.unref();
  const release = (): void => {
    clearInterval(beat);
    for (const f of [lockFile, heartbeatFile]) {
      try {
        unlinkSync(f);
      } catch {
        /* already gone */
      }
    }
  };

  const { recipe } = loaded;
  const name = `${recipe.artifact.version}-r${recipe.artifact.recipe_revision}-${id}`;
  const prefix = path.posix.join(env.linuxRoot, 'scram', name);
  const previousActive = readJson<ActivePointer>(path.join(dir, 'active.json'))?.prefix ?? null;
  const record: InstallRecord = {
    schema_version: 1,
    id,
    artifact: { id: recipe.artifact.id, version: recipe.artifact.version, recipe_revision: recipe.artifact.recipe_revision },
    recipe_sha256: loaded.recipeSha256,
    prefix,
    state: 'queued',
    step: null,
    started_at: now(),
    updated_at: now(),
    reasons: [],
    previous_active: previousActive,
  };
  const recordFile = path.join(dir, 'installs', `${id}.json`);
  const logDir = path.join(dir, 'installs', id);
  mkdirSync(logDir, { recursive: true });
  const set = (state: InstallState, step: string | null = record.step, reasons: string[] = record.reasons): void => {
    record.state = state;
    record.step = step;
    record.reasons = reasons;
    record.updated_at = now();
    writeJson(recordFile, record);
    opts.onState?.({ ...record });
  };
  const cleanup = async (): Promise<void> => {
    if (opts.keepFailed && record.state === 'failed') return;
    try {
      assertManagedPrefix(env, prefix);
      await runner(['/usr/bin/rm', '-rf', '--', prefix], { timeoutMs: 120000, ownerTag: prefix });
    } catch {
      /* nothing was created, or the path was not ours */
    }
  };
  const finish = async (state: 'failed' | 'cancelled', reasons: string[]): Promise<InstallResult> => {
    set(state, record.step, reasons);
    await cleanup();
    release();
    return { record, manifest: null };
  };
  const cancelled = (): boolean => opts.signal?.aborted === true;

  try {
    set('queued');
    if (cancelled()) return await finish('cancelled', ['cancelled']);

    // preflight: prerequisites, free space, job count
    set('preflight');
    const vars: Record<string, string> = { PREFIX: prefix, LOCK: path.posix.join(prefix, 'toolchain.lock'), SOURCE_URL: recipe.trust.source_url, SOURCE_COMMIT: recipe.trust.source_commit, JOBS: '4' };
    for (const p of recipe.prerequisites) {
      if (!p.var) continue;
      let found: string | null = null;
      for (const c of p.candidates ?? []) {
        const r = await runner([c, ...(p.probe_args ?? [])], { timeoutMs: 30000, ownerTag: `${prefix}/probe-${p.id}` });
        if (r.exit === 0) {
          found = c;
          break;
        }
      }
      if (!found) return await finish('failed', [`prerequisite-missing:${p.id}`]);
      vars[p.var] = found;
    }
    let probe = env.linuxRoot;
    let free: number | null = null;
    for (let i = 0; i < 6 && free === null; i++) {
      const r = await runner(['/usr/bin/df', '-B1', '--output=avail', probe], { timeoutMs: 30000, ownerTag: `${prefix}/df` });
      const n = Number(r.stdout.trim().split('\n').pop());
      if (r.exit === 0 && Number.isFinite(n)) free = n;
      else probe = path.posix.dirname(probe);
    }
    if (free === null) return await finish('failed', ['free-space-unknown']);
    if (free < recipe.sizes.required_free_bytes) return await finish('failed', [`not-enough-disk:${free}<${recipe.sizes.required_free_bytes}`]);
    const jobs = await runner(['/usr/bin/nproc'], { timeoutMs: 30000, ownerTag: `${prefix}/nproc` });
    const n = Number(jobs.stdout.trim());
    if (jobs.exit === 0 && Number.isInteger(n) && n > 0) vars.JOBS = String(Math.min(8, n));
    if (cancelled()) return await finish('cancelled', ['cancelled']);

    // create the prefix; a marker says it is not usable yet
    const made = await runner(['/usr/bin/mkdir', '-p', prefix], { timeoutMs: 60000, ownerTag: prefix });
    if (made.exit !== 0) return await finish('failed', ['cannot-create-prefix']);
    await runner(['/usr/bin/touch', path.posix.join(prefix, '.sneed-partial')], { timeoutMs: 30000, ownerTag: prefix });
    // copy the reviewed lock into the prefix and check the copy: what conda reads is what the recipe pinned
    const lockSource = toWslPath(path.join(loaded.dir, recipe.trust.toolchain_lock));
    const copied = await runner(['/usr/bin/cp', lockSource, vars.LOCK!], { timeoutMs: 60000, ownerTag: prefix });
    const copySum = await runner(['/usr/bin/sha256sum', vars.LOCK!], { timeoutMs: 60000, ownerTag: prefix });
    if (copied.exit !== 0 || !copySum.stdout.startsWith(loaded.lockSha256 + ' ')) return await finish('failed', ['toolchain-lock-mismatch']);

    const phaseState: Record<RecipeStep['phase'], InstallState> = { toolchain: 'staging', source: 'staging', build: 'building', verify: 'verifying' };
    const timings: { id: string; seconds: number }[] = [];
    for (const step of recipe.steps) {
      if (cancelled()) return await finish('cancelled', ['cancelled']);
      set(phaseState[step.phase], step.id);
      const argv = step.argv.map((a) => expand(a, vars));
      const envPairs = Object.entries(step.env ?? {}).map(([k, v]) => `${k}=${expand(v, vars)}`);
      const full = envPairs.length ? ['/usr/bin/env', ...envPairs, ...argv] : argv;
      const started = Date.now();
      const r = await runner(full, { timeoutMs: step.timeout_s * 1000, ...(opts.signal ? { signal: opts.signal } : {}), ownerTag: prefix });
      timings.push({ id: step.id, seconds: Math.round((Date.now() - started) / 100) / 10 });
      writeFileSync(path.join(logDir, `${step.id}.stdout.txt`), r.stdout, 'utf8');
      writeFileSync(path.join(logDir, `${step.id}.stderr.txt`), r.stderr, 'utf8');
      if (r.cancelled) return await finish('cancelled', ['cancelled']);
      if (r.timedOut) return await finish('failed', [`step-timeout:${step.id}`]);
      if (r.exit !== 0) return await finish('failed', [`step-failed:${step.id}`, `exit-${r.exit}`]);
      const out = r.stdout.trim();
      if (step.expect_stdout_equals !== undefined && out !== expand(step.expect_stdout_equals, vars)) return await finish('failed', [`step-expectation:${step.id}`]);
      if (step.expect_stdout_regex !== undefined && !new RegExp(step.expect_stdout_regex).test(out)) return await finish('failed', [`step-expectation:${step.id}`]);
    }

    // identity of what was built
    set('verifying', 'binary-identity');
    const binary = path.posix.join(prefix, recipe.outputs.binary);
    const libs = recipe.outputs.library_dirs.map((d) => path.posix.join(prefix, d));
    const sum = await runner(['/usr/bin/sha256sum', binary], { timeoutMs: 60000, ownerTag: prefix });
    const binSha = /^([0-9a-f]{64})\s/.exec(sum.stdout)?.[1];
    if (sum.exit !== 0 || !binSha) return await finish('failed', ['binary-missing']);
    const ver = await runner(['/usr/bin/env', `LD_LIBRARY_PATH=${libs.join(':')}`, binary, ...recipe.outputs.version_argv], { timeoutMs: 60000, ownerTag: prefix });
    if (ver.exit !== 0 || !new RegExp(recipe.compatibility.engine_version_regex).test(ver.stdout.trim())) return await finish('failed', ['binary-version-mismatch']);
    const du = await runner(['/usr/bin/du', '-sb', prefix], { timeoutMs: 120000, ownerTag: prefix });
    const expanded = du.exit === 0 ? Number(du.stdout.split(/\s/)[0]) : null;

    // native checks on the fresh build; a failing build is never activated
    set('smoke');
    const engine: EngineConfig = { distro: env.distro, binary, libs: libs.join(':'), expectedVersion: recipe.artifact.version, expectedSha256: binSha };
    const smokeRuns = path.join(logDir, 'smoke-runs');
    const results = await (opts.smoke ?? runSmoke)(loaded, engine, smokeRuns);
    if (cancelled()) return await finish('cancelled', ['cancelled']);
    if (!results.every((s) => s.passed)) return await finish('failed', results.filter((s) => !s.passed).map((s) => `smoke-failed:${s.id}`));

    // activation: one atomic pointer switch; the previous version stays on disk
    set('activating');
    const manifest: InstalledManifest = {
      schema: { id: 'sneed.runtime-installed', version: 1 },
      install_id: id,
      artifact: record.artifact,
      recipe_sha256: loaded.recipeSha256,
      toolchain_lock_sha256: loaded.lockSha256,
      source_commit: recipe.trust.source_commit,
      prefix,
      distro: env.distro,
      binary: { path: binary, sha256: binSha, version_text: ver.stdout.trim() },
      library_dirs: libs,
      built_at: now(),
      expanded_bytes: expanded,
      steps: timings,
      smoke: { passed: true, cases: results },
    };
    writeJson(path.join(dir, 'installed', `${id}.json`), manifest);
    await runner(['/usr/bin/touch', path.posix.join(prefix, '.sneed-ready')], { timeoutMs: 30000, ownerTag: prefix });
    await runner(['/usr/bin/rm', '-f', '--', path.posix.join(prefix, '.sneed-partial')], { timeoutMs: 30000, ownerTag: prefix });
    const active: ActivePointer = { schema_version: 1, install_id: id, prefix, manifest_sha256: sha256(readFileSync(path.join(dir, 'installed', `${id}.json`))), activated_at: now(), previous: previousActive };
    writeJson(path.join(dir, 'active.json'), active);
    set('ready', null, []);
    release();
    return { record, manifest };
  } catch (e) {
    // an unexpected error must not leave a live lock or a half-built prefix behind
    record.reasons = [`internal-error:${(e as Error).message}`.slice(0, 200)];
    try {
      return await finish('failed', record.reasons);
    } catch {
      release();
      throw e;
    }
  }
}

export interface RecoverOptions {
  runner?: StepRunner;
}

/**
 * Restart recovery. Any install record still in a non-terminal state whose lock is stale becomes `interrupted`
 * and its partial prefix is removed; the lock is released. It never reads a half-built prefix as a success and
 * never touches the active pointer, so the previously active version stays usable.
 */
export async function recover(env: RuntimeEnv, opts: RecoverOptions = {}): Promise<InstallRecord[]> {
  const runner = opts.runner ?? wslRunner(env.distro);
  const dir = dirOf(env);
  const touched: InstallRecord[] = [];
  const lockFile = path.join(dir, 'lock.json');
  if (existsSync(lockFile) && !isStaleLock(env)) return touched; // a live install owns it
  const installs = path.join(dir, 'installs');
  if (existsSync(installs)) {
    for (const f of readdirSync(installs)) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(installs, f);
      const rec = readJson<InstallRecord>(file);
      if (!rec || TERMINAL.includes(rec.state)) continue;
      rec.state = 'interrupted';
      rec.reasons = ['owner-lost'];
      rec.updated_at = now();
      writeJson(file, rec);
      try {
        assertManagedPrefix(env, rec.prefix);
        // a crashed host may have left owned Linux processes running: stop exactly those (by the prefix in their arguments), then delete
        await runner(['/usr/bin/pkill', '-KILL', '-f', '--', regexEscape(rec.prefix)], { timeoutMs: 60000, ownerTag: rec.prefix });
        await runner(['/usr/bin/rm', '-rf', '--', rec.prefix], { timeoutMs: 120000, ownerTag: rec.prefix });
      } catch {
        /* the prefix never existed or was not ours */
      }
      touched.push(rec);
    }
  }
  for (const f of [lockFile, path.join(dir, 'lock.heartbeat')]) {
    try {
      unlinkSync(f);
    } catch {
      /* not there */
    }
  }
  return touched;
}

export interface RuntimeStatus {
  active: (ActivePointer & { manifest: InstalledManifest | null }) | null;
  installs: InstallRecord[];
  lockHeld: boolean;
  lockStale: boolean;
}

export function status(env: RuntimeEnv): RuntimeStatus {
  const dir = dirOf(env);
  const active = readJson<ActivePointer>(path.join(dir, 'active.json'));
  const installsDir = path.join(dir, 'installs');
  const installs = existsSync(installsDir)
    ? readdirSync(installsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson<InstallRecord>(path.join(installsDir, f))!)
        .sort((a, b) => a.started_at.localeCompare(b.started_at))
    : [];
  return {
    active: active ? { ...active, manifest: readJson<InstalledManifest>(path.join(dir, 'installed', `${active.install_id}.json`)) } : null,
    installs,
    lockHeld: existsSync(path.join(dir, 'lock.json')),
    lockStale: isStaleLock(env),
  };
}

export interface VerifyIssue {
  code: 'no-active-runtime' | 'manifest-missing' | 'manifest-changed' | 'binary-missing' | 'binary-changed' | 'version-mismatch' | 'not-ready';
  message: string;
}

/** Checks that the active runtime is still exactly what was installed: manifest unchanged, binary present, hash and version equal. */
export async function verifyActive(env: RuntimeEnv, opts: RecoverOptions = {}): Promise<VerifyIssue[]> {
  const runner = opts.runner ?? wslRunner(env.distro);
  const dir = dirOf(env);
  const active = readJson<ActivePointer>(path.join(dir, 'active.json'));
  if (!active) return [{ code: 'no-active-runtime', message: 'no runtime has been activated' }];
  const manifestFile = path.join(dir, 'installed', `${active.install_id}.json`);
  if (!existsSync(manifestFile)) return [{ code: 'manifest-missing', message: 'the installed manifest is missing' }];
  if (sha256(readFileSync(manifestFile)) !== active.manifest_sha256) return [{ code: 'manifest-changed', message: 'the installed manifest changed after activation' }];
  return verifyManifest(readJson<InstalledManifest>(manifestFile)!, runner);
}

/** Checks one installed manifest against what is on disk: ready marker, binary hash, reported version. */
export async function verifyManifest(m: InstalledManifest, runner: StepRunner): Promise<VerifyIssue[]> {
  const issues: VerifyIssue[] = [];
  const ready = await runner(['/usr/bin/test', '-f', path.posix.join(m.prefix, '.sneed-ready')], { timeoutMs: 30000, ownerTag: m.prefix });
  if (ready.exit !== 0) issues.push({ code: 'not-ready', message: 'the prefix has no ready marker' });
  const sum = await runner(['/usr/bin/sha256sum', m.binary.path], { timeoutMs: 60000, ownerTag: m.prefix });
  if (sum.exit !== 0) return [...issues, { code: 'binary-missing', message: `cannot read ${m.binary.path}` }];
  if (!sum.stdout.startsWith(m.binary.sha256 + ' ')) issues.push({ code: 'binary-changed', message: 'the binary differs from the one that was installed' });
  const ver = await runner(['/usr/bin/env', `LD_LIBRARY_PATH=${m.library_dirs.join(':')}`, m.binary.path, '--version'], { timeoutMs: 60000, ownerTag: m.prefix });
  if (ver.exit !== 0 || ver.stdout.trim() !== m.binary.version_text) issues.push({ code: 'version-mismatch', message: 'the binary reports a different version than at install time' });
  return issues;
}

/**
 * Makes the previous runtime active again. This is a new activation, not an edit of history: the previous version
 * must still verify, the pointer is switched atomically, and the version being left becomes `previous`.
 * Refused while an install holds the lock.
 */
export async function rollback(env: RuntimeEnv, opts: RecoverOptions = {}): Promise<ActivePointer> {
  const runner = opts.runner ?? wslRunner(env.distro);
  const dir = dirOf(env);
  if (existsSync(path.join(dir, 'lock.json'))) throw new RuntimeBusyError(readJson<{ id: string }>(path.join(dir, 'lock.json'))?.id ?? 'unknown');
  const active = readJson<ActivePointer>(path.join(dir, 'active.json'));
  if (!active) throw new Error('no active runtime to roll back from');
  if (!active.previous) throw new Error('there is no previous runtime to roll back to');
  const installed = path.join(dir, 'installed');
  const target = existsSync(installed)
    ? readdirSync(installed)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ file: path.join(installed, f), m: readJson<InstalledManifest>(path.join(installed, f))! }))
        .find((x) => x.m.prefix === active.previous)
    : undefined;
  if (!target) throw new Error('the previous runtime has no installed manifest');
  const issues = await verifyManifest(target.m, runner);
  if (issues.length) throw new Error(`the previous runtime does not verify: ${issues.map((i) => i.code).join(', ')}`);
  const pointer: ActivePointer = { schema_version: 1, install_id: target.m.install_id, prefix: target.m.prefix, manifest_sha256: sha256(readFileSync(target.file)), activated_at: now(), previous: active.prefix };
  writeJson(path.join(dir, 'active.json'), pointer);
  return pointer;
}

export { resolveEngine, defaultRuntimeEnv, RuntimeNotInstalledError } from './resolve.js';

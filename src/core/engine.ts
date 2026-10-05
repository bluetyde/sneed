import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

export interface EngineConfig {
  /** WSL distribution that holds the engine. */
  distro: string;
  /** Absolute Linux path of the SCRAM executable. */
  binary: string;
  /** LD_LIBRARY_PATH for the engine's own shared library and its pinned dependencies. */
  libs: string;
  /** The engine version this build is pinned to (docs/spike/README.md). */
  expectedVersion: string;
  /** sha256 of the pinned binary. When set, a different binary is refused before any run. */
  expectedSha256: string | null;
  /** Set when the engine comes from an installed runtime: which install, recipe revision and manifest it is. */
  runtime?: RuntimeIdentity;
}

export interface RuntimeIdentity {
  install_id: string;
  recipe_revision: number;
  manifest_sha256: string;
}

/**
 * The developer's own build from the P0 spike, kept only for comparing against the managed runtime
 * (tests use it when SNEED_DEV_ENGINE=1). Nothing falls back to it: analysis uses the installed runtime.
 */
export const DEV_ENGINE: EngineConfig = {
  distro: 'Ubuntu',
  binary: '/root/pra-scram/build/bin/scram',
  libs: '/root/pra-scram/build/lib/scram:/root/pra-scram/env-old/lib',
  expectedVersion: '0.16.2',
  expectedSha256: 'eaa41f5ae3bfef0f445f302f65079189b13a545e575ec2e1b65c77dfa0b78ed8',
};

/** C:\a b\c -> /mnt/c/a b/c. Throws for anything that is not an absolute drive path. */
export function toWslPath(winPath: string): string {
  const abs = path.resolve(winPath);
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(abs);
  if (!m) throw new Error(`not a Windows drive path: ${winPath}`);
  return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}`;
}

export interface ExecResult {
  exit: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface ExecOptions {
  /** Hard limit; the owned process is killed when it passes. */
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * A string that appears in the command line of the processes this call starts and in no one else's
   * (the unique run-directory path). Cancel and timeout kill only processes whose command line contains it.
   */
  ownerTag: string;
}

/** Escapes a string for use as a literal inside an extended regular expression (pkill -f takes one). */
export function regexEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Kills the Linux processes that carry the owner tag. Never matches by name alone. */
export function killOwned(distro: string, ownerTag: string): void {
  if (ownerTag.length < 12) throw new Error('owner tag is too short to be unique');
  // pkill -f takes an extended regular expression: escape the tag so a path with ( [ . + never breaks or over-matches
  const pattern = regexEscape(ownerTag);
  spawnSync('wsl.exe', ['-d', distro, '--exec', 'pkill', '-KILL', '-f', '--', pattern], { windowsHide: true });
}

/** True when a Linux process that carries the owner tag is still alive. Used to confirm a cancel. Throws when the query itself fails. */
export function hasOwned(distro: string, ownerTag: string): boolean {
  if (ownerTag.length < 12) throw new Error('owner tag is too short to be unique');
  const r = spawnSync('wsl.exe', ['-d', distro, '--exec', 'pgrep', '-f', '--', regexEscape(ownerTag)], { windowsHide: true });
  // pgrep: 0 = at least one match, 1 = none. Anything else (a launch failure, a signal, an error) means the answer is unknown,
  // which must never be read as "no process".
  if (r.error || r.status === null || (r.status !== 0 && r.status !== 1)) throw new Error('the process query failed');
  return r.status === 0;
}

/**
 * Runs a command in WSL with an explicit argument list (never a shell string) and returns when it ends.
 * A Linux-side `timeout` is a backstop in case the Windows side is lost.
 */
export function execInWsl(distro: string, argv: string[], opts: ExecOptions): Promise<ExecResult> {
  const backstop = Math.ceil(opts.timeoutMs / 1000) + 15;
  const args = ['-d', distro, '--exec', 'timeout', '--signal=KILL', String(backstop), ...argv];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));

    // cancellation and timeout serialise with exit: whichever is recorded first wins
    const stop = (why: 'timeout' | 'cancel'): void => {
      if (settled) return;
      settled = true;
      if (why === 'timeout') timedOut = true;
      else cancelled = true;
      killOwned(distro, opts.ownerTag);
      if (child.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
    };
    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs);
    const onAbort = (): void => stop('cancel');
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exit: number | null, extra = ''): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      settled = true;
      resolve({ exit, stdout, stderr: stderr + extra, timedOut, cancelled, durationMs: Date.now() - started });
    };
    child.on('error', (e) => finish(null, `launch failed: ${e.message}`));
    child.on('close', (code) => finish(code));
  });
}

export interface EngineIdentityInfo {
  name: string;
  version: string;
  sha256: string | null;
}

const cache = new Map<string, Promise<EngineIdentityInfo>>();

/** Reads the engine's reported version and the sha256 of its binary (once per process and config). */
export function engineIdentity(cfg: EngineConfig): Promise<EngineIdentityInfo> {
  const key = JSON.stringify([cfg.distro, cfg.binary, cfg.libs]);
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const tag = `engine-identity-${process.pid}-${Date.now()}`;
      const ver = await execInWsl(cfg.distro, ['env', `LD_LIBRARY_PATH=${cfg.libs}`, cfg.binary, '--version'], { timeoutMs: 20000, ownerTag: tag + '-version' });
      const m = /^(\S+)\s+(\d+\.\d+\.\d+\S*)/.exec(ver.stdout.trim());
      const sum = await execInWsl(cfg.distro, ['sha256sum', cfg.binary], { timeoutMs: 20000, ownerTag: tag + '-sha256' });
      const sha = /^([0-9a-f]{64})\s/.exec(sum.stdout)?.[1] ?? null;
      return { name: m?.[1] ?? 'unknown', version: m?.[2] ?? 'unknown', sha256: sha };
    })();
    cache.set(key, p);
  }
  return p;
}

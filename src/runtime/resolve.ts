import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { EngineConfig } from '../core/engine.js';
import type { ActivePointer, InstalledManifest, RuntimeEnv } from './install.js';

/** The installed runtime is missing, so nothing can be analysed until it is set up. SEED's code for this is E_SETUP_REQUIRED. */
export class RuntimeNotInstalledError extends Error {
  readonly code = 'E_SETUP_REQUIRED';
  constructor(where: string) {
    super(`no active SCRAM runtime in ${where}: run \`npm run runtime -- install\` first`);
  }
}

/** Where the managed runtime lives, from the environment with the same defaults the installer uses. */
export function defaultRuntimeEnv(vars: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  return {
    distro: vars.SNEED_WSL_DISTRO ?? 'Ubuntu',
    linuxRoot: vars.SNEED_RUNTIME_ROOT ?? '/root/sneed-runtime',
    stateDir: vars.SNEED_RUNTIME_STATE ?? path.join(homedir(), '.sneed', 'runtime'),
  };
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const readJson = <T>(file: string): T | null => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null);

/**
 * The engine configuration for the active runtime, carrying the installed identity so a swapped binary is refused.
 * There is no fallback to any other binary: a missing runtime is an error with the command that fixes it.
 */
export function resolveEngine(env: RuntimeEnv): EngineConfig {
  const dir = path.join(env.stateDir, 'scram');
  const active = readJson<ActivePointer>(path.join(dir, 'active.json'));
  if (!active) throw new RuntimeNotInstalledError(env.stateDir);
  const manifestFile = path.join(dir, 'installed', `${active.install_id}.json`);
  if (!existsSync(manifestFile) || sha256(readFileSync(manifestFile)) !== active.manifest_sha256) throw new Error('the active runtime manifest is missing or changed');
  const m = readJson<InstalledManifest>(manifestFile)!;
  return {
    distro: m.distro,
    binary: m.binary.path,
    libs: m.library_dirs.join(':'),
    expectedVersion: m.artifact.version,
    expectedSha256: m.binary.sha256,
    runtime: { install_id: m.install_id, recipe_revision: m.artifact.recipe_revision, manifest_sha256: active.manifest_sha256 },
  };
}

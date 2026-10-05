import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { analyze } from '../../src/core/analyze.js';
import { RuntimeNotInstalledError, defaultRuntimeEnv, resolveEngine } from '../../src/runtime/resolve.js';
import { ORACLE_MODELS } from '../oracle/models.js';

let tmp: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['SNEED_RUNTIME_STATE', 'SNEED_RUNTIME_ROOT', 'SNEED_WSL_DISTRO'];
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sneed-default-'));
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('defaultRuntimeEnv', () => {
  it('uses the installer defaults when nothing is set', () => {
    expect(defaultRuntimeEnv({})).toEqual({ distro: 'Ubuntu', linuxRoot: '/root/sneed-runtime', stateDir: path.join(homedir(), '.sneed', 'runtime') });
  });

  it('takes each value from the environment when it is set', () => {
    expect(defaultRuntimeEnv({ SNEED_WSL_DISTRO: 'Debian', SNEED_RUNTIME_ROOT: '/opt/sneed', SNEED_RUNTIME_STATE: 'D:\state' })).toEqual({ distro: 'Debian', linuxRoot: '/opt/sneed', stateDir: 'D:\state' });
  });
});

describe('with no installed runtime', () => {
  it('resolveEngine fails with a typed setup error that names the fix', () => {
    const env = { distro: 'Ubuntu', linuxRoot: '/root/x', stateDir: tmp };
    expect(() => resolveEngine(env)).toThrow(RuntimeNotInstalledError);
    try {
      resolveEngine(env);
    } catch (e) {
      expect((e as RuntimeNotInstalledError).code).toBe('E_SETUP_REQUIRED');
      expect((e as Error).message).toContain('npm run runtime -- install');
      expect((e as Error).message).toContain(tmp);
    }
  });

  it('analyze with no engine option does not fall back to any other binary: it fails before creating a run', async () => {
    process.env.SNEED_RUNTIME_STATE = tmp;
    const runs = path.join(tmp, 'runs');
    await expect(analyze(JSON.stringify(ORACLE_MODELS['pra-and']), { runsDir: runs })).rejects.toMatchObject({ code: 'E_SETUP_REQUIRED' });
    expect(existsSync(runs)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('a model that fails validation is still refused with its own errors, not a setup error', async () => {
    process.env.SNEED_RUNTIME_STATE = tmp;
    const bad = { ...ORACLE_MODELS['pra-and'], top: 'NOPE' };
    const out = await analyze(JSON.stringify(bad), { runsDir: path.join(tmp, 'runs') });
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.errors.map((e) => e.code)).toEqual(['E_NO_TOP']);
  });
});

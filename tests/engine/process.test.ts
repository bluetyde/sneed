import { afterAll, describe, expect, it } from 'vitest';
import { execInWsl, killOwned, toWslPath, type ExecResult } from '../../src/core/engine.js';
import { defaultRuntimeEnv } from '../../src/runtime/resolve.js';

// Real process handling in WSL. Needs the Ubuntu distro with python3 (used only as a harmless long-running stand-in).
const DISTRO = defaultRuntimeEnv().distro;
const unique = (label: string): string => `/tmp/sneed-test/${label} (${process.pid}) [${Date.now()}]+x.y-${Math.random().toString(36).slice(2)}`;
const sleeperArgv = (tag: string): string[] => ['python3', '-c', 'import time; time.sleep(120)', tag];

/**
 * Number of Linux processes whose command line contains the tag, excluding the counting pipeline itself
 * (every line of that pipeline contains the word "grep", the sleepers' lines do not).
 */
async function count(tag: string): Promise<number> {
  const probe = unique('probe') + '-counter';
  const script = 'ps -eo args | grep -F -- "$1" | grep -v grep | wc -l';
  const r = await execInWsl(DISTRO, ['sh', '-c', script, 'sh', tag], { timeoutMs: 20000, ownerTag: probe });
  return Number(r.stdout.trim());
}

const leftovers: string[] = [];
afterAll(async () => {
  for (const tag of leftovers) await execInWsl(DISTRO, ['pkill', '-KILL', '-f', '--', tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], { timeoutMs: 10000, ownerTag: unique('cleanup') });
});

describe('toWslPath', () => {
  it('keeps spaces and converts drive letters and separators', () => {
    expect(toWslPath('C:\\Users\\jwncr\\Claude Code Test\\runs\\a')).toBe('/mnt/c/Users/jwncr/Claude Code Test/runs/a');
    expect(toWslPath('D:/OpenMC/x')).toBe('/mnt/d/OpenMC/x');
  });
  it('refuses anything that is not a drive path', () => {
    expect(() => toWslPath('\\\\wsl$\\Ubuntu\\root')).toThrow();
  });
});

describe('owned processes in WSL', () => {
  it('a normal command returns its exit code and output', async () => {
    const tag = unique('normal');
    const r = await execInWsl(DISTRO, ['sh', '-c', 'echo out; echo err 1>&2; exit 3', tag], { timeoutMs: 20000, ownerTag: tag });
    expect(r).toMatchObject({ exit: 3, timedOut: false, cancelled: false });
    expect(r.stdout.trim()).toBe('out');
    expect(r.stderr.trim()).toBe('err');
  }, 60000);

  it('arguments with spaces and shell characters arrive unchanged (no shell string)', async () => {
    const tag = unique('args');
    const nasty = 'a b; echo hacked $(whoami) `id` "q" \'s\' *';
    const r = await execInWsl(DISTRO, ['printf', '%s', nasty, tag], { timeoutMs: 20000, ownerTag: tag });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe(nasty + tag); // printf reuses '%s' for each argument, so the tag follows; the nasty one is unchanged
  }, 60000);

  it('cancel kills the owned process and leaves an unrelated one running', async () => {
    const mine = unique('mine');
    const other = unique('other');
    leftovers.push(mine, other);
    const abort = new AbortController();
    const otherAbort = new AbortController();
    const unrelated = execInWsl(DISTRO, sleeperArgv(other), { timeoutMs: 100000, signal: otherAbort.signal, ownerTag: other });
    const owned = execInWsl(DISTRO, sleeperArgv(mine), { timeoutMs: 100000, signal: abort.signal, ownerTag: mine });
    await new Promise((r) => setTimeout(r, 3000));
    expect(await count(mine), 'owned process is running before cancel').toBeGreaterThan(0);
    expect(await count(other), 'unrelated process is running before cancel').toBeGreaterThan(0);

    abort.abort();
    const res: ExecResult = await owned;
    expect(res.cancelled).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(await count(mine), 'owned process is gone after cancel').toBe(0);
    expect(await count(other), 'unrelated process survived').toBeGreaterThan(0);

    otherAbort.abort();
    expect((await unrelated).cancelled).toBe(true);
    expect(await count(other), 'unrelated process stopped only by its own cancel').toBe(0);
  }, 120000);

  it('killOwned alone ends the owned process (no Windows-side kill) and spares an unrelated one', async () => {
    // Killing wsl.exe may also end its Linux child, so cancel/timeout tests cannot tell whether the pkill step works.
    // Here nothing else kills the process: only the escaped-regex pkill on a tag full of ( ) [ ] + . characters can.
    const mine = unique('direct');
    const other = unique('direct-other');
    leftovers.push(mine, other);
    const otherAbort = new AbortController();
    const owned = execInWsl(DISTRO, sleeperArgv(mine), { timeoutMs: 100000, ownerTag: mine });
    const unrelated = execInWsl(DISTRO, sleeperArgv(other), { timeoutMs: 100000, signal: otherAbort.signal, ownerTag: other });
    await new Promise((r) => setTimeout(r, 3000));
    expect(await count(mine)).toBeGreaterThan(0);
    killOwned(DISTRO, mine);
    const res = await owned;
    expect(res.exit).not.toBe(0);
    expect(res.cancelled || res.timedOut).toBe(false);
    expect(await count(mine), 'owned process killed by pkill alone').toBe(0);
    expect(await count(other), 'unrelated process untouched').toBeGreaterThan(0);
    otherAbort.abort();
    await unrelated;
  }, 120000);

  it('cancel and timeout firing together report only the first cause', async () => {
    const tag = unique('both');
    const abort = new AbortController();
    abort.abort(); // recorded first, synchronously; the 1 ms timer fires while the kill is still running
    const r = await execInWsl(DISTRO, ['true', tag], { timeoutMs: 1, signal: abort.signal, ownerTag: tag });
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBe(false);
  }, 60000);

  it('a timeout kills the owned process and says so', async () => {
    const tag = unique('timeout');
    leftovers.push(tag);
    const r = await execInWsl(DISTRO, sleeperArgv(tag), { timeoutMs: 2500, ownerTag: tag });
    expect(r.timedOut).toBe(true);
    expect(r.cancelled).toBe(false);
    expect(r.durationMs).toBeLessThan(20000);
    expect(await count(tag)).toBe(0);
  }, 120000);

  it('cancellation accepted first wins even if the command would have exited zero', async () => {
    const tag = unique('prerace');
    const abort = new AbortController();
    abort.abort();
    const r = await execInWsl(DISTRO, ['true', tag], { timeoutMs: 20000, signal: abort.signal, ownerTag: tag });
    expect(r.cancelled).toBe(true);
  }, 60000);

  it('cancelling after the command finished changes nothing', async () => {
    const tag = unique('late');
    const abort = new AbortController();
    const r = await execInWsl(DISTRO, ['true', tag], { timeoutMs: 20000, signal: abort.signal, ownerTag: tag });
    abort.abort();
    expect(r).toMatchObject({ exit: 0, cancelled: false, timedOut: false });
  }, 60000);

  it('refuses an owner tag too short to be unique', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(execInWsl(DISTRO, ['true'], { timeoutMs: 5000, signal: abort.signal, ownerTag: 'short' })).rejects.toThrow(/too short/);
  }, 30000);
});

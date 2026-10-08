import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The temporary file of a save is created exclusively (Codex security review, 2026-10-08): a file already at its name is never written
// through. The random suffix is made predictable here, so the name can be occupied in advance.
const rnd = vi.hoisted(() => ({ next: [] as string[], used: 0 }));
vi.mock('node:crypto', async (orig) => {
  const real = await orig<typeof import('node:crypto')>();
  return {
    ...real,
    randomBytes: (n: number) => {
      const hex = rnd.next[rnd.used++];
      return hex === undefined ? real.randomBytes(n) : Buffer.from(hex, 'hex');
    },
  };
});
const { writeModel, readModel } = await import('../../src/server/storage.js');

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sneed-tmpname-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('the temporary file of a save', () => {
  it('is never written through when something already has its name: that file is left as it was, and the save uses another name', () => {
    const dir = path.join(tmp, 'a');
    mkdirSync(dir);
    const occupied = path.join(dir, 'x.json.11223344.tmp');
    writeFileSync(occupied, 'keep');
    rnd.next = ['11223344', '55667788'];
    rnd.used = 0;
    writeModel(dir, 'x', '{"saved":true}');
    expect(readFileSync(occupied, 'utf8')).toBe('keep');
    expect(readModel(dir, 'x')).toBe('{"saved":true}');
    expect(readdirSync(dir).sort()).toEqual(['x.json', 'x.json.11223344.tmp']);
  });

  it('gives up with an error, leaving what is there, when the name is taken every time (five tries)', () => {
    const dir = path.join(tmp, 'b');
    mkdirSync(dir);
    const occupied = path.join(dir, 'y.json.aabbccdd.tmp');
    writeFileSync(occupied, 'keep');
    rnd.next = Array.from({ length: 5 }, () => 'aabbccdd');
    rnd.used = 0;
    expect(() => writeModel(dir, 'y', '{}')).toThrow(/EEXIST/);
    expect(rnd.used).toBe(5);
    expect(readFileSync(occupied, 'utf8')).toBe('keep');
    expect(existsSync(path.join(dir, 'y.json'))).toBe(false);
  });

  it('is not even created when the name is a folder: the save is refused first', () => {
    const dir = path.join(tmp, 'c');
    mkdirSync(dir);
    mkdirSync(path.join(dir, 'z.json')); // a folder where the model should go
    rnd.next = ['01020304'];
    rnd.used = 0;
    expect(() => writeModel(dir, 'z', '{}')).toThrow();
    expect(readdirSync(dir)).toEqual(['z.json']);
  });
});

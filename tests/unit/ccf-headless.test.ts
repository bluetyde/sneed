import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, realDeps, type Deps } from '../../src/cli/headless.js';
import { modelHash } from '../../src/core/canonical.js';
import { frozenCaseDoc, type FrozenCase } from '../oracle/groups.js';

// Plan 15, stage C3: the headless runner (the interface SEED uses) validates and runs a model with common-cause groups, with the built-in
// engine, and says in `describe` that it can. Real analysis, a fake terminal: one JSON line per verb.

const frozen = JSON.parse(readFileSync(path.join(import.meta.dirname, '../oracles-common-cause.json'), 'utf8')) as FrozenCase[];
const dirs: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'sneed-ccf-headless-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function terminal(): { d: Deps; lines: string[] } {
  const lines: string[] = [];
  let n = 0;
  return { lines, d: { ...realDeps(), defaultEngine: () => 'builtin', write: (l) => void lines.push(l), newWorkId: () => `pra-${(++n).toString(16).padStart(12, '0')}` } };
}
const only = (lines: string[]): any => {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!);
};
const write = (dir: string, doc: unknown): string => {
  const f = path.join(dir, 'model.json');
  writeFileSync(f, JSON.stringify(doc));
  return f;
};

describe('the headless runner with common-cause groups', () => {
  it('describe says it handles beta-factor groups, and the meaning of a result names them', async () => {
    const t = terminal();
    expect(await main(['describe'], t.d)).toBe(0);
    const r = only(t.lines);
    expect(r.capabilities).toContain('common-cause-beta-factor');
    expect(r.capabilities).toEqual(expect.arrayContaining(['exact', 'rare-event', 'mcub', 'k-of-n', 'minimal-cut-sets']));
    expect(r.meaning).toMatch(/common-cause group/);
  });

  it('validate accepts a model with groups, and names a bad group with its code', async () => {
    const dir = temp();
    const good = terminal();
    expect(await main(['validate', write(dir, frozenCaseDoc(frozen[0]!))], good.d)).toBe(0);
    expect(only(good.lines)).toMatchObject({ ok: true });
    const bad = { ...frozenCaseDoc(frozen[0]!), common_cause_groups: [{ id: 'G', method: 'beta-factor', members: ['A', 'B'], beta: 2 }] };
    const t = terminal();
    expect(await main(['validate', write(dir, bad)], t.d)).toBe(2);
    expect(only(t.lines).errors.map((e: { code: string }) => e.code)).toEqual(['E_CCF_BETA_RANGE']);
  });

  for (const e of frozen) {
    it(`run ${e.id}: the result folder holds the frozen probability, the groups and the model's hash`, async () => {
      const dir = temp();
      const doc = frozenCaseDoc(e);
      const out = path.join(dir, 'out');
      const t = terminal();
      expect(await main(['run', write(dir, doc), '--out', out, '--run-id', 'ccf'], t.d)).toBe(0);
      expect(only(t.lines)).toMatchObject({ ok: true, status: 'completed' });
      const results = JSON.parse(readFileSync(path.join(out, 'ccf', 'results.json'), 'utf8'));
      expect(Math.abs(results.top_event_probability - e.expected_probability)).toBeLessThanOrEqual(e.tolerance.absolute);
      expect(results.common_cause).toMatchObject({ method: 'beta-factor', groups: [{ id: e.group.id, beta: e.group.beta }] });
      expect(results.input_hashes.model_hash).toBe(modelHash(doc as never));
      expect(readdirSync(path.join(out, 'ccf')).sort()).toEqual(expect.arrayContaining(['results.json', 'manifest.json']));
    });
  }
});

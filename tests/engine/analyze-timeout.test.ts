import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyze } from '../../src/core/analyze.js';
import { ORACLE_MODELS } from '../oracle/models.js';

// The time limit covers the whole analysis, not only the engine: after SCRAM has answered, the checks on its report poll the
// clock and stop. A fake clock that jumps past the deadline right after the run starts makes that deterministic.
describe('the time limit covers the checks after the engine (found by SEED)', () => {
  it('a budget that is spent before the engine would start means the engine is never started (found by Codex)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sneed-timeout-pre-'));
    try {
      let calls = 0;
      const now = (): number => (calls++ > 0 ? 1e12 : 0); // the first reading sets the deadline, the next one is long past it
      const out = await analyze(JSON.stringify(ORACLE_MODELS['pra-pump2-or']), { runsDir: dir, timeoutMs: 60_000, now });
      expect(out.kind).toBe('ran');
      if (out.kind === 'ran') {
        expect(out.record).toMatchObject({ status: 'failed', reasons: ['timeout'] });
        expect(existsSync(path.join(out.runDir, 'native', 'report.xml'))).toBe(false); // no engine output: it was not run
        expect(existsSync(path.join(out.runDir, 'log', 'stdout.txt'))).toBe(false); // and it was never launched (a launch always leaves its logs)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a run whose time is up when the engine returns ends failed with reason timeout, never completed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sneed-timeout-'));
    try {
      let calls = 0;
      const now = (): number => (calls++ > 1 ? 1e12 : 0); // readings 1 and 2 (deadline, before the engine) are fine; the checks after the engine see the time up
      const out = await analyze(JSON.stringify(ORACLE_MODELS['pra-pump2-or']), { runsDir: dir, timeoutMs: 60_000, now });
      expect(out.kind).toBe('ran');
      if (out.kind === 'ran') {
        expect(out.record.status).toBe('failed');
        expect(out.record.reasons).toEqual(['timeout']);
        expect(out.record.minimal_cut_sets).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('with a normal clock the same model completes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sneed-timeout-ok-'));
    try {
      const out = await analyze(JSON.stringify(ORACLE_MODELS['pra-pump2-or']), { runsDir: dir, timeoutMs: 60_000 });
      expect(out.kind === 'ran' && out.record.status).toBe('completed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

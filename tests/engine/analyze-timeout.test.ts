import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyze } from '../../src/core/analyze.js';
import { ORACLE_MODELS } from '../oracle/models.js';

// The time limit covers the whole analysis, not only the engine: after SCRAM has answered, the checks on its report poll the
// clock and stop. A fake clock that jumps past the deadline right after the run starts makes that deterministic.
describe('the time limit covers the checks after the engine (found by SEED)', () => {
  it('a run whose time is up when the engine returns ends failed with reason timeout, never completed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sneed-timeout-'));
    try {
      let calls = 0;
      const now = (): number => Date.now() + (calls++ > 0 ? 3_600_000 : 0); // the first reading sets the deadline, later ones are an hour on
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

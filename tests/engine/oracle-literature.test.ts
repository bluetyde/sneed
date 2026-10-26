import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/analyze.js';
import { enumerate, type NativeDoc } from '../oracle/enumerate.js';
import { AND, OR, mkDoc } from '../oracle/models.js';

// The literature oracles (tests/oracles-literature.json, NUREG-0492 examples) through the exporter and the real SCRAM: a third program that shares
// nothing with the built-in solver. SCRAM prints about six significant digits, so a probability is compared to 5e-5 of its value.

interface Entry {
  id: string;
  model: { top: string; events: Record<string, number>; gates: { id: string; type: 'and' | 'or'; inputs: string[] }[] };
  published: { minimal_cut_sets: string[][] };
}
const file = JSON.parse(readFileSync(new URL('../oracles-literature.json', import.meta.url), 'utf8')) as { entries: Entry[] };
const tmp = mkdtempSync(path.join(tmpdir(), 'sneed-literature-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sorted = (sets: string[][]): string[][] => sets.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));

describe('the published NUREG-0492 examples through the real SCRAM', () => {
  for (const e of file.entries) {
    it(`${e.id}: SCRAM finds the minimal cut sets the handbook prints, and the probability the exact enumeration gives`, async () => {
      const doc = mkDoc(e.model.top, e.model.events, e.model.gates.map((g) => (g.type === 'and' ? AND(g.id, g.inputs) : OR(g.id, g.inputs))));
      const out = await analyze(JSON.stringify(doc), { runsDir: tmp, runId: `literature-${String(file.entries.indexOf(e) + 1).padStart(6, '0')}`, timeoutMs: 60_000 });
      if (out.kind !== 'ran') throw new Error(`refused: ${JSON.stringify(out.errors)}`);
      expect(out.record.status).toBe('completed');
      expect(sorted(out.record.minimal_cut_sets.map((c) => c.events))).toEqual(sorted(e.published.minimal_cut_sets));
      const exact = enumerate(doc as NativeDoc).probability.toNumber();
      expect(Math.abs(out.record.top_event_probability! - exact)).toBeLessThanOrEqual(Math.max(1e-12, 5e-5 * exact));
    }, 120_000);
  }
});

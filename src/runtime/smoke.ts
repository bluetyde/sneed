import { mkdirSync } from 'node:fs';
import { analyze } from '../core/analyze.js';
import type { EngineConfig } from '../core/engine.js';
import type { LoadedRecipe, SmokeCase } from './recipe.js';

export interface SmokeResult {
  id: string;
  passed: boolean;
  /** Short machine-readable reason when it did not pass. */
  reason: string | null;
  probability: number | null;
  status: string;
}

const sorted = (sets: string[][]): string[][] => sets.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));

function nativeDocument(c: SmokeCase, assumptions: Record<string, unknown>): unknown {
  const stamp = '2026-10-05T00:00:00Z';
  return {
    schema: { id: 'sneed.fault-tree', version: 1 },
    model: { id: `smoke-${c.id}`, name: `Smoke check ${c.id}`, created: stamp, updated: stamp },
    assumptions,
    top: c.top,
    events: Object.entries(c.events).map(([id, probability]) => ({ id, probability })),
    gates: c.gates,
  };
}

/**
 * Runs the recipe's native checks through the real pipeline (export, engine, report parsing, result checking)
 * against one engine build. The expected numbers come from the recipe, never from the engine under test.
 */
export async function runSmoke(loaded: LoadedRecipe, engine: EngineConfig, runsDir: string): Promise<SmokeResult[]> {
  mkdirSync(runsDir, { recursive: true });
  const out: SmokeResult[] = [];
  for (const c of loaded.smokeCases) {
    const outcome = await analyze(JSON.stringify(nativeDocument(c, loaded.smokeAssumptions)), { runsDir, engine, settings: { method: c.method }, timeoutMs: 120000 });
    if (outcome.kind !== 'ran') {
      out.push({ id: c.id, passed: false, reason: `refused:${outcome.errors.map((e) => e.code).join('|')}`, probability: null, status: 'refused' });
      continue;
    }
    const r = outcome.record;
    let reason: string | null = null;
    if (r.status !== 'completed' || r.completeness !== 'complete') reason = `status:${r.status}:${r.reasons.join('|')}`;
    else if (Math.abs((r.top_event_probability ?? Number.NaN) - c.expected_probability) > Math.max(1e-12, 1e-5 * c.expected_probability)) reason = 'probability-differs';
    else if (JSON.stringify(sorted(r.minimal_cut_sets.map((x) => x.events))) !== JSON.stringify(sorted(c.expected_cut_sets))) reason = 'cut-sets-differ';
    out.push({ id: c.id, passed: reason === null, reason, probability: r.top_event_probability, status: r.status });
  }
  return out;
}

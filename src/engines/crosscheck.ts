// Two engines, one model: do they agree? Used by "run both and compare". A difference is reported as a difference; it is a finding
// about one of the engines, never something to average away or to settle by picking the nicer number.
import type { ResultRecord } from '../core/result.js';

/** SCRAM prints about six significant digits, so probabilities are compared to that precision. */
const REL_TOL = 5e-5;
const close = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(1e-12, REL_TOL * Math.max(Math.abs(a), Math.abs(b)));
const key = (sets: { events: string[] }[]): string[] => sets.map((s) => [...s.events].sort().join(',')).sort();

export interface CrossCheck {
  /** The other engine's name and version, as its record states them. */
  engine: { name: string; version: string };
  /** The other engine's own status. */
  status: ResultRecord['status'];
  /** True only when both finished completed and complete and every compared quantity matches. */
  agree: boolean;
  /** What differs, in words a reader can act on. Empty when they agree. */
  differences: string[];
}

export interface CrossCheckUnavailable {
  unavailable: true;
  /** Why the second engine could not be run (for example the SCRAM runtime is not installed). */
  reason: string;
}

export function crossCheck(a: ResultRecord, b: ResultRecord): CrossCheck {
  const differences: string[] = [];
  const solid = (r: ResultRecord): boolean => r.status === 'completed' && r.completeness === 'complete';
  if (!solid(a)) differences.push(`${a.engine.name} did not produce a complete result (${a.status}${a.reasons.length ? ': ' + a.reasons.join(', ') : ''})`);
  if (!solid(b)) differences.push(`${b.engine.name} did not produce a complete result (${b.status}${b.reasons.length ? ': ' + b.reasons.join(', ') : ''})`);
  if (solid(a) && solid(b) && a.method !== b.method) differences.push(`the two runs used different methods (${a.method} and ${b.method}), so their numbers are not compared`);
  else if (solid(a) && solid(b)) {
    const pa = a.top_event_probability!;
    const pb = b.top_event_probability!;
    if (!close(pa, pb)) differences.push(`probability: ${a.engine.name} ${pa}, ${b.engine.name} ${pb}`);
    const ka = key(a.minimal_cut_sets);
    const kb = key(b.minimal_cut_sets);
    const onlyA = ka.filter((k) => !kb.includes(k));
    const onlyB = kb.filter((k) => !ka.includes(k));
    if (onlyA.length) differences.push(`cut sets only in ${a.engine.name}: ${onlyA.slice(0, 5).map((k) => `{${k}}`).join(' ')}${onlyA.length > 5 ? ` and ${onlyA.length - 5} more` : ''}`);
    if (onlyB.length) differences.push(`cut sets only in ${b.engine.name}: ${onlyB.slice(0, 5).map((k) => `{${k}}`).join(' ')}${onlyB.length > 5 ? ` and ${onlyB.length - 5} more` : ''}`);
    if (a.approximation_value !== null && b.approximation_value !== null && !close(a.approximation_value, b.approximation_value)) {
      differences.push(`${a.method} value: ${a.engine.name} ${a.approximation_value}, ${b.engine.name} ${b.approximation_value}`);
    }
  }
  return { engine: { name: b.engine.name, version: b.engine.version }, status: b.status, agree: differences.length === 0, differences };
}

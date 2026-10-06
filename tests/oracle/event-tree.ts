// Test-only brute-force oracle for event trees (plan 13, stage S2). Never imported from src/ and shares no code with the engine: it enumerates every
// failure state of every basic event that any heading depends on, evaluates each heading event in each state with its own small evaluator, and
// adds up exact rational state probabilities for each path condition. A branch "works" is simply "the heading event is false in this state".
import { Q, parseDecimal } from './rational.js';
import type { NativeDoc } from './enumerate.js';

export const ET_MAX_EVENTS = 16;

export interface EtOracleInput {
  initiating_event: { frequency: number };
  headings: { id: string; event: string }[];
  end_states: { id: string }[];
  sequences: { path: { heading: string; branch: 'works' | 'fails' }[]; end_state: string }[];
}

export interface EtOracleResult {
  events: string[];
  /** path key -> exact probability of the path condition */
  probability: Map<string, Q>;
  frequency: Map<string, Q>;
  /** "success branches ignored": the probability that every FAILED heading's event occurs (success conditions dropped) */
  approxProbability: Map<string, Q>;
  endFrequency: Map<string, Q>;
  partitionSum: Q;
}

const key = (path: { heading: string; branch: string }[]): string => path.map((s) => `${s.heading}:${s.branch}`).join(',');

export function enumerateEventTree(model: NativeDoc, tree: EtOracleInput): EtOracleResult {
  const gateById = new Map(model.gates.map((g) => [g.id, g]));
  const probById = new Map(model.events.map((e) => [e.id, e.probability]));

  // every basic event any heading event depends on, sorted
  const used = new Set<string>();
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const g = gateById.get(id);
    if (!g) used.add(id);
    else g.inputs.forEach(walk);
  };
  tree.headings.forEach((h) => walk(h.event));
  const events = [...used].sort();
  const n = events.length;
  if (n > ET_MAX_EVENTS) throw new Error(`oracle limit is ${ET_MAX_EVENTS} events, the headings depend on ${n}`);
  const bit = new Map(events.map((id, i) => [id, i]));

  const evalAt = (id: string, mask: number, memo: Map<string, boolean>): boolean => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const g = gateById.get(id);
    let v: boolean;
    if (!g) v = ((mask >> bit.get(id)!) & 1) === 1;
    else {
      const count = g.inputs.filter((x) => evalAt(x, mask, memo)).length;
      v = g.type === 'and' ? count === g.inputs.length : g.type === 'or' ? count > 0 : count >= (g.threshold ?? 0);
    }
    memo.set(id, v);
    return v;
  };

  const size = 1 << n;
  const fails = new Map<string, Uint8Array>();
  for (const h of tree.headings) fails.set(h.id, new Uint8Array(size));
  for (let mask = 0; mask < size; mask++) {
    const memo = new Map<string, boolean>();
    for (const h of tree.headings) fails.get(h.id)![mask] = evalAt(h.event, mask, memo) ? 1 : 0;
  }

  const pa = events.map((id) => parseDecimal(probById.get(id)!));
  const den = pa.map((p) => 10n ** BigInt(p.s));
  const total = den.reduce((x, y) => x * y, 1n);
  const stateNumerator = (mask: number): bigint => {
    let term = 1n;
    for (let i = 0; i < n; i++) term *= (mask >> i) & 1 ? pa[i]!.a : den[i]! - pa[i]!.a;
    return term;
  };
  const weights = Array.from({ length: size }, (_, m) => stateNumerator(m));

  const lam = parseDecimal(tree.initiating_event.frequency);
  const lambda = Q.make(lam.a, 10n ** BigInt(lam.s));

  const probability = new Map<string, Q>();
  const frequency = new Map<string, Q>();
  const approxProbability = new Map<string, Q>();
  const endFrequency = new Map<string, Q>(tree.end_states.map((e) => [e.id, Q.ZERO]));
  let partitionSum = Q.ZERO;
  for (const s of tree.sequences) {
    let exact = 0n;
    let approx = 0n;
    for (let mask = 0; mask < size; mask++) {
      let holds = true;
      let failuresOnly = true;
      for (const step of s.path) {
        const f = fails.get(step.heading)![mask] === 1;
        if (step.branch === 'fails') {
          if (!f) {
            holds = false;
            failuresOnly = false;
          }
        } else if (f) holds = false;
      }
      if (holds) exact += weights[mask]!;
      if (failuresOnly) approx += weights[mask]!;
    }
    const k = key(s.path);
    const pr = Q.make(exact, total);
    probability.set(k, pr);
    frequency.set(k, lambda.mul(pr));
    approxProbability.set(k, Q.make(approx, total));
    partitionSum = partitionSum.add(pr);
    endFrequency.set(s.end_state, endFrequency.get(s.end_state)!.add(lambda.mul(pr)));
  }
  return { events, probability, frequency, approxProbability, endFrequency, partitionSum };
}

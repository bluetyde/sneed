// Test-only brute-force oracle (plan 05). Never imported from src/ and never a production fallback solver.
//
// It shares no code with the SCRAM path or with src/core except the validator, which it uses only to
// refuse invalid models. Probability is the exact sum over every failure state of the reachable basic
// events (each identity evaluated once per state); cut sets are the minimal failing sets found by
// testing every subset. Arithmetic is exact (BigInt rationals), so there is no rounding to hide a mismatch.
import { validateModel } from '../../src/core/validate.js';
import { Q, parseDecimal } from './rational.js';

export interface NativeDoc {
  top: string;
  events: { id: string; probability: number }[];
  gates: { id: string; type: 'and' | 'or' | 'atleast'; inputs: string[]; threshold?: number }[];
}

export const MAX_EVENTS = 16;

export interface OracleResult {
  /** Reachable basic events, sorted. Unreachable definitions do not affect the result. */
  events: string[];
  probability: Q;
  /** Minimal cut sets, each sorted; the list is sorted by size then lexicographically. */
  cutSets: string[][];
  /** Sum of cut-set probabilities (rare-event approximation). */
  rareEvent: Q;
  /** 1 - product(1 - P(cut set)) (min-cut upper bound). */
  mcub: Q;
}

const byLength = (a: string[], b: string[]): number => a.length - b.length || a.join(',').localeCompare(b.join(','));

export function enumerate(doc: NativeDoc): OracleResult {
  const check = validateModel(doc);
  if (!check.valid) throw new Error('oracle refuses an invalid model: ' + check.errors.map((e) => e.code).join(', '));

  const gateById = new Map(doc.gates.map((g) => [g.id, g]));
  const probById = new Map(doc.events.map((e) => [e.id, e.probability]));

  // reachable events and a topological order of reachable gates (inputs before users)
  const reachableEvents = new Set<string>();
  const order: string[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (!gateById.has(id)) {
      reachableEvents.add(id);
      return;
    }
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error('cycle in a validated model');
    visiting.add(id);
    for (const inp of gateById.get(id)!.inputs) visit(inp);
    visiting.delete(id);
    done.add(id);
    order.push(id);
  };
  visit(doc.top);

  const events = [...reachableEvents].sort();
  const n = events.length;
  if (n > MAX_EVENTS) throw new Error(`oracle limit is ${MAX_EVENTS} reachable basic events, model has ${n}`);
  const evIdx = new Map(events.map((id, i) => [id, i]));
  const gIdx = new Map(order.map((id, i) => [id, i]));
  const compiled = order.map((id) => {
    const g = gateById.get(id)!;
    return {
      type: g.type,
      k: g.threshold ?? 0,
      ins: g.inputs.map((x) => (gIdx.has(x) ? { gate: true, i: gIdx.get(x)! } : { gate: false, i: evIdx.get(x)! })),
    };
  });
  const topIsGate = gIdx.has(doc.top);
  const topIndex = topIsGate ? gIdx.get(doc.top)! : evIdx.get(doc.top)!;

  // top value for every failure state; bit i set means events[i] has failed
  const size = 1 << n;
  const topTrue = new Uint8Array(size);
  const vals = new Uint8Array(compiled.length);
  for (let mask = 0; mask < size; mask++) {
    for (let gi = 0; gi < compiled.length; gi++) {
      const g = compiled[gi]!;
      let count = 0;
      for (const inp of g.ins) count += inp.gate ? vals[inp.i]! : (mask >> inp.i) & 1;
      vals[gi] = g.type === 'and' ? (count === g.ins.length ? 1 : 0) : g.type === 'or' ? (count > 0 ? 1 : 0) : count >= g.k ? 1 : 0;
    }
    topTrue[mask] = topIsGate ? vals[topIndex]! : (mask >> topIndex) & 1;
  }

  // the model must be coherent: more failures never repair the system
  for (let mask = 0; mask < size; mask++) {
    if (!topTrue[mask]) continue;
    for (let b = 0; b < n; b++) {
      if (!topTrue[mask | (1 << b)]) throw new Error('model is not monotone: oracle assumes coherent logic');
    }
  }

  // exact probability: sum of state probabilities where the top occurs
  const pa = events.map((id) => parseDecimal(probById.get(id)!));
  const den = pa.map((p) => 10n ** BigInt(p.s));
  const total = den.reduce((x, y) => x * y, 1n);
  let numerator = 0n;
  for (let mask = 0; mask < size; mask++) {
    if (!topTrue[mask]) continue;
    let term = 1n;
    for (let i = 0; i < n; i++) term *= (mask >> i) & 1 ? pa[i]!.a : den[i]! - pa[i]!.a;
    numerator += term;
  }
  const probability = Q.make(numerator, total);

  // minimal cut sets: failing states with no failing proper subset (one removal suffices when monotone)
  const cutMasks: number[] = [];
  for (let mask = 1; mask < size; mask++) {
    if (!topTrue[mask]) continue;
    let minimal = true;
    for (let b = 0; b < n && minimal; b++) if ((mask >> b) & 1 && topTrue[mask & ~(1 << b)]) minimal = false;
    if (minimal) cutMasks.push(mask);
  }
  // Sperner: an antichain over n events has at most C(n, floor(n/2)) members. Fail fast if minimality is broken,
  // before the probability loops run on a huge bogus family.
  let sperner = 1;
  for (let i = 1; i <= Math.floor(n / 2); i++) sperner = (sperner * (n - i + 1)) / i;
  if (cutMasks.length > Math.max(1, Math.round(sperner))) throw new Error(`${cutMasks.length} cut sets exceed the antichain bound for ${n} events`);
  const cutSets = cutMasks.map((m) => events.filter((_, i) => (m >> i) & 1).sort()).sort(byLength);

  const pOf = (id: string): Q => {
    const p = parseDecimal(probById.get(id)!);
    return Q.make(p.a, 10n ** BigInt(p.s));
  };
  const cutProb = (set: string[]): Q => set.reduce((acc, id) => acc.mul(pOf(id)), Q.ONE);
  let rare = Q.ZERO;
  let survive = Q.ONE;
  for (const c of cutSets) {
    const p = cutProb(c);
    rare = rare.add(p);
    survive = survive.mul(Q.ONE.sub(p));
  }
  return { events, probability, cutSets, rareEvent: rare, mcub: Q.ONE.sub(survive) };
}

/** Independent evaluator (recursive, memoised by id) used to cross-check the bitmask loop above. */
export function topOccurs(doc: NativeDoc, failed: ReadonlySet<string>): boolean {
  const gates = new Map(doc.gates.map((g) => [g.id, g]));
  const memo = new Map<string, boolean>();
  const value = (id: string): boolean => {
    const g = gates.get(id);
    if (!g) return failed.has(id);
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const bits = g.inputs.map(value);
    const t = bits.filter(Boolean).length;
    const v = g.type === 'and' ? bits.every(Boolean) : g.type === 'or' ? bits.some(Boolean) : t >= (g.threshold ?? Infinity);
    memo.set(id, v);
    return v;
  };
  return value(doc.top);
}

/** Second probability method: inclusion-exclusion over minimal cut sets (needs at most `maxSets` of them). */
export function inclusionExclusion(cutSets: string[][], doc: NativeDoc, maxSets = 12): Q | null {
  const m = cutSets.length;
  if (m > maxSets) return null;
  const probs = new Map(doc.events.map((e) => [e.id, e.probability]));
  const p = (id: string): Q => {
    const d = parseDecimal(probs.get(id)!);
    return Q.make(d.a, 10n ** BigInt(d.s));
  };
  let sum = Q.ZERO;
  for (let sub = 1; sub < 1 << m; sub++) {
    const union = new Set<string>();
    let bits = 0;
    for (let j = 0; j < m; j++) {
      if ((sub >> j) & 1) {
        bits++;
        for (const id of cutSets[j]!) union.add(id);
      }
    }
    let term = Q.ONE;
    for (const id of union) term = term.mul(p(id));
    sum = bits % 2 ? sum.add(term) : sum.sub(term);
  }
  return sum;
}

// Test-only oracle for common-cause groups (plan 15, section 5). Never imported from src/.
//
// It evaluates the GROUP DEFINITION, not the expansion that src/core/ccf.ts makes: the variables are the independent parts I_i of the
// group members, one common-cause event C per group, and the basic events outside any group. Member i has failed when I_i or C has.
// The top event is evaluated on the original document (topOccurs), and every probability is exact (BigInt rationals).
import { validateModel } from '../../src/core/validate.js';
import { topOccurs, MAX_EVENTS, type NativeDoc } from './enumerate.js';
import { Q, parseDecimal } from './rational.js';
import { mkDoc, rng, randomDoc, type Doc } from './models.js';

export interface GroupDef {
  id: string;
  method?: 'beta-factor';
  members: string[];
  beta: number;
}
export type GroupDoc = NativeDoc & { common_cause_groups?: GroupDef[] };

export interface GroupOracleResult {
  /** The variables, in order: names as the engine reports them (`G.CCF`, `A.independent`, or the event id). */
  variables: string[];
  probability: Q;
  /** Minimal cut sets over the variables, each sorted; the list is sorted by size then lexicographically. */
  cutSets: string[][];
}

const exact = (x: number): Q => {
  const d = parseDecimal(x);
  return Q.make(d.a, 10n ** BigInt(d.s));
};
const byLength = (a: string[], b: string[]): number => a.length - b.length || a.join(',').localeCompare(b.join(','));

export function enumerateGroups(doc: GroupDoc): GroupOracleResult {
  const check = validateModel(doc);
  if (!check.valid) throw new Error('oracle refuses an invalid model: ' + check.errors.map((e) => e.code).join(', '));
  const gates = new Map(doc.gates.map((g) => [g.id, g]));
  const prob = new Map(doc.events.map((e) => [e.id, e.probability]));
  const groups = doc.common_cause_groups ?? [];
  const groupOf = new Map<string, GroupDef>();
  for (const g of groups) for (const m of g.members) groupOf.set(m, g);

  // reachable basic events
  const reach = new Set<string>();
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const g = gates.get(id);
    if (g) g.inputs.forEach(walk);
    else reach.add(id);
  };
  walk(doc.top);

  type V = { name: string; p: Q; kind: 'event' | 'indep' | 'common'; ref: string };
  const vars: V[] = [];
  for (const id of [...reach].sort()) {
    const g = groupOf.get(id);
    if (!g) vars.push({ name: id, p: exact(prob.get(id)!), kind: 'event', ref: id });
    else vars.push({ name: id + '.independent', p: Q.ONE.sub(exact(g.beta)).mul(exact(prob.get(id)!)), kind: 'indep', ref: id });
  }
  for (const g of groups) {
    const reached = g.members.filter((m) => reach.has(m));
    if (reached.length === 0) continue;
    vars.push({ name: g.id + '.CCF', p: exact(g.beta).mul(exact(prob.get(g.members[0]!)!)), kind: 'common', ref: g.id });
  }
  const n = vars.length;
  if (n > MAX_EVENTS) throw new Error(`oracle limit is ${MAX_EVENTS} variables, the model has ${n}`);
  const names = vars.map((v) => v.name);
  const cIndex = new Map(vars.map((v, i) => [v, i] as const).filter(([v]) => v.kind === 'common').map(([v, i]) => [v.ref, i]));

  const failedSet = (mask: number): Set<string> => {
    const failed = new Set<string>();
    vars.forEach((v, i) => {
      const bit = ((mask >> i) & 1) === 1;
      if (v.kind === 'event' && bit) failed.add(v.ref);
      if (v.kind === 'indep') {
        const c = cIndex.get(groupOf.get(v.ref)!.id);
        if (bit || (c !== undefined && ((mask >> c) & 1) === 1)) failed.add(v.ref);
      }
    });
    return failed;
  };

  const size = 1 << n;
  const topTrue = new Uint8Array(size);
  let probability = Q.ZERO;
  for (let mask = 0; mask < size; mask++) {
    if (!topOccurs(doc, failedSet(mask))) continue;
    topTrue[mask] = 1;
    let term = Q.ONE;
    for (let i = 0; i < n; i++) term = term.mul(((mask >> i) & 1) === 1 ? vars[i]!.p : Q.ONE.sub(vars[i]!.p));
    probability = probability.add(term);
  }
  const cutSets: string[][] = [];
  for (let mask = 1; mask < size; mask++) {
    if (!topTrue[mask]) continue;
    let minimal = true;
    for (let b = 0; b < n && minimal; b++) if (((mask >> b) & 1) === 1 && topTrue[mask & ~(1 << b)]) minimal = false;
    if (minimal) cutSets.push(names.filter((_, i) => ((mask >> i) & 1) === 1).sort());
  }
  return { variables: names, probability, cutSets: cutSets.sort(byLength) };
}

/** A random tree (the seeded generator of models.ts) with one or two disjoint groups of 2 or 3 events that share one probability. */
export function randomGroupDoc(seed: number): GroupDoc & Doc {
  const base = randomDoc(seed, { events: 4 + (seed % 5) });
  const rnd = rng(seed * 7919 + 13);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const ids = base.events.map((e) => e.id);
  const betas = [0, 1, 0.1, 0.25, 0.5, int(1, 999) / 1000];
  const qs = [0.1, 0.2, 0.05, 0.3, 0.5];
  const groups: GroupDef[] = [];
  const free = [...ids];
  for (let gi = 0; gi < int(1, 2) && free.length >= 2; gi++) {
    const size = Math.min(free.length, int(2, 3));
    const members = free.splice(0, size);
    groups.push({ id: `CC${gi}`, method: 'beta-factor', members, beta: betas[int(0, betas.length - 1)]! });
  }
  const events = base.events.map((e) => {
    const g = groups.find((x) => x.members.includes(e.id));
    return g ? { ...e, probability: qs[(g.members.length + seed) % qs.length]! } : e;
  });
  // members of one group share one probability: take the first member's
  const fixed = events.map((e) => {
    const g = groups.find((x) => x.members.includes(e.id));
    return g ? { ...e, probability: events.find((x) => x.id === g.members[0])!.probability } : e;
  });
  const doc = mkDoc(base.top, Object.fromEntries(fixed.map((e) => [e.id, e.probability])), base.gates);
  return { ...doc, assumptions: { ...(doc.assumptions as Record<string, unknown>), independence: 'beta-factor-groups' }, common_cause_groups: groups } as GroupDoc & Doc;
}

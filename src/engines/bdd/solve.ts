// Native model -> decision diagram -> exact top-event probability and minimal cut sets.
// Independent of the SCRAM path: it reads the native model directly (never the Open-PSA export) and shares no code with it.
import type { NativeModel } from '../../core/model.js';
import { Bdd, FALSE, SolveAborted, TRUE, type BddLimits } from './bdd.js';

export { SolveAborted } from './bdd.js';

export const BDD_ENGINE_NAME = 'sneed-bdd';
export const BDD_ENGINE_VERSION = '0.1.0';

export const DEFAULT_LIMITS: BddLimits = { maxNodes: 2_000_000, maxCutSets: 50_000, maxCached: 20_000_000 };
/** Deeper than this and the recursive diagram operations could exhaust the stack. */
export const MAX_EVENTS = 2000;

export interface SolveOptions {
  /** The variable order, as basic-event ids. Default: first appearance in a depth-first walk from the top. The answer never depends on it. */
  order?: string[];
  limits?: Partial<BddLimits>;
  /** Called now and then during long work; throws SolveAborted to stop it (a time limit or a cancel). */
  tick?: () => void;
}

export interface Solution {
  /** Basic events in variable order. */
  events: string[];
  /** Exact probability that the top event occurs (floating point, error far below 1e-12 on hand-checkable trees). */
  probability: number;
  /** Minimal cut sets, each with its events sorted, listed by size then by event names. */
  cutSets: { events: string[]; probability: number }[];
  /** Diagram nodes created, a measure of how hard the model was. */
  nodes: number;
}

type Gate = NativeModel['gates'][number];

/** Basic events in the order a depth-first walk from the top first meets them. */
export function defaultOrder(model: NativeModel): string[] {
  const gates = new Map(model.gates.map((g) => [g.id, g]));
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [model.top];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const g = gates.get(id);
    if (g) for (let i = g.inputs.length - 1; i >= 0; i--) stack.push(g.inputs[i]!); // reversed so the first input is walked first
    else order.push(id);
  }
  return order;
}

export function solve(model: NativeModel, opts: SolveOptions = {}): Solution {
  const limits: BddLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const gates = new Map<string, Gate>(model.gates.map((g) => [g.id, g]));
  const probability = new Map(model.events.map((e) => [e.id, e.probability]));

  const reachable = defaultOrder(model);
  if (reachable.length > MAX_EVENTS) throw new SolveAborted('too-many-events');
  let order = reachable;
  if (opts.order) {
    if (opts.order.length !== reachable.length || new Set(opts.order).size !== reachable.length || !opts.order.every((e) => reachable.includes(e))) {
      throw new RangeError('order must list every reachable basic event exactly once');
    }
    order = opts.order;
  }
  const index = new Map(order.map((e, i) => [e, i]));
  const bdd = new Bdd(limits, opts.tick);

  // post-order over gates (inputs before users), iteratively, so a deep chain of gates cannot overflow the stack
  const built = new Map<string, number>();
  const ordered: string[] = [];
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [model.top];
  while (stack.length) {
    const id = stack[stack.length - 1]!;
    const g = gates.get(id);
    if (!g) {
      stack.pop();
      continue;
    }
    if (state.get(id) === 2) {
      stack.pop();
      continue;
    }
    if (state.get(id) === 1) {
      state.set(id, 2);
      ordered.push(id);
      stack.pop();
      continue;
    }
    state.set(id, 1);
    for (const i of g.inputs) if (gates.has(i) && !state.has(i)) stack.push(i);
  }
  const fn = (id: string): number => {
    const g = gates.get(id);
    if (!g) return bdd.variable(index.get(id)!);
    return built.get(id)!;
  };
  for (const id of ordered) {
    const g = gates.get(id)!;
    const ins = g.inputs.map(fn);
    let node: number;
    if (g.type === 'and') node = ins.reduce((a, b) => bdd.and(a, b), TRUE);
    else if (g.type === 'or') node = ins.reduce((a, b) => bdd.or(a, b), FALSE);
    else node = bdd.atLeast(g.threshold ?? ins.length, ins);
    built.set(id, node);
  }
  const root = fn(model.top);
  if (root === FALSE || root === TRUE) throw new RangeError('the top event is always or never true; a valid model cannot do that');

  const p = order.map((e) => probability.get(e)!);
  const top = bdd.probability(root, p);
  const sets = bdd.minimalCutSets(root).map((s) => {
    const ids = s.map((i) => order[i]!).sort();
    return { events: ids, probability: ids.reduce((acc, id) => acc * probability.get(id)!, 1) };
  });
  sets.sort((a, b) => a.events.length - b.events.length || (a.events.join('\u0000') < b.events.join('\u0000') ? -1 : 1));
  return { events: order, probability: top, cutSets: sets, nodes: bdd.nodeCount };
}

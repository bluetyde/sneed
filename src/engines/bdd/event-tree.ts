// Event-tree sequences on the built-in solver (docs/plans/13-event-trees.md, stage S2). Every heading is an event of ONE fault-tree model, so
// the events of all headings live in ONE decision diagram: a basic event under several headings is one variable, and the joint probability
// of a path condition (failure events and the NEGATION of failure events) is exact. Nothing is multiplied branch by branch.
//
// Floating point is watched as in the importance measures: a probability that underflowed to zero although the path can happen, or any
// non-finite number, is a failure ('numeric-range'); the sequence probabilities must add up to 1 ('sequences-do-not-partition').
import { SolveAborted, TRUE } from './bdd.js';
import { buildNodes, MAX_EVENTS, type SolveOptions } from './solve.js';
import type { NativeModel } from '../../core/model.js';
import type { PathStep } from '../../core/event-tree.js';
import { pathKey } from '../../core/event-tree.js';

/** The part of an event-tree document the computation reads. */
export interface EventTreeInput {
  initiating_event: { frequency: number };
  headings: { id: string; event: string }[];
  end_states: { id: string; name: string; synthetic: boolean }[];
  sequences: { path: PathStep[]; end_state: string }[];
}

export interface SequenceComputation {
  key: string;
  path: PathStep[];
  end_state: string;
  probability: number;
  frequency: number;
  /** Only when asked: failure events only, success branches ignored. */
  approximation?: { probability: number; frequency: number };
}

export interface EventTreeComputation {
  sequences: SequenceComputation[];
  endStates: { id: string; frequency: number; probability: number; sequences: string[] }[];
  total: { frequency: number; probabilitySum: number; partitionError: number };
  approximationFrequencySum: number | null;
  nodes: number;
}

/** How far the sequence probabilities may be from 1 in total. Each is exact to about 1e-16; 4096 of them add up to far less than this. */
export const PARTITION_TOLERANCE = 1e-9;

/** Neumaier's compensated sum, smallest first: the order of the list does not change the answer, and many small terms are not lost. */
export function stableSum(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  let sum = 0;
  let c = 0;
  for (const x of sorted) {
    const t = sum + x;
    c += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;
    sum = t;
  }
  return sum + c;
}

export function computeEventTree(model: NativeModel, tree: EventTreeInput, opts: SolveOptions & { approximation?: boolean } = {}): EventTreeComputation {
  const roots = tree.headings.map((h) => h.event);
  const d = buildNodes(model, roots, opts);
  const { bdd, order, p } = d;
  if (order.length > MAX_EVENTS) throw new SolveAborted('too-many-events');
  const range = (): never => {
    throw new SolveAborted('numeric-range');
  };

  const failNode = new Map<string, number>();
  const workNode = new Map<string, number>();
  for (const h of tree.headings) {
    const f = d.nodeOf(h.event);
    failNode.set(h.id, f);
    workNode.set(h.id, bdd.not(f));
  }

  /** Can this condition happen at all, with the events as the model states them? Zero-probability events cannot fail, certain ones always do, the
   *  others are free at probability 0.5 (never below 2^-n for n events), so 0 means "impossible", never "too small to represent". */
  const possible = (node: number): boolean => bdd.probability(node, p.map((q) => (q === 0 ? 0 : q === 1 ? 1 : 0.5))) > 0;

  const lambda = tree.initiating_event.frequency;
  const sequences: SequenceComputation[] = [];
  for (const s of tree.sequences) {
    let cond = TRUE;
    let failures = TRUE;
    for (const step of s.path) {
      const f = failNode.get(step.heading);
      if (f === undefined) throw new RangeError(`the path names ${step.heading}, which is not a heading`);
      cond = bdd.and(cond, step.branch === 'fails' ? f : workNode.get(step.heading)!);
      if (step.branch === 'fails') failures = bdd.and(failures, f);
    }
    const probability = bdd.probability(cond, p);
    if (!Number.isFinite(probability)) return range();
    if (probability === 0 && possible(cond)) return range();
    const frequency = lambda * probability;
    if (!Number.isFinite(frequency) || (frequency === 0 && probability > 0 && lambda > 0)) return range();
    const row: SequenceComputation = { key: pathKey(s.path), path: s.path, end_state: s.end_state, probability, frequency };
    if (opts.approximation) {
      const ap = bdd.probability(failures, p);
      if (!Number.isFinite(ap)) return range();
      if (ap === 0 && possible(failures)) return range();
      const af = lambda * ap;
      if (!Number.isFinite(af) || (af === 0 && ap > 0 && lambda > 0)) return range();
      row.approximation = { probability: ap, frequency: af };
    }
    sequences.push(row);
  }

  const probabilitySum = stableSum(sequences.map((x) => x.probability));
  const partitionError = Math.abs(probabilitySum - 1);
  if (!(partitionError <= PARTITION_TOLERANCE)) throw new SolveAborted('sequences-do-not-partition');

  const byEnd = new Map<string, SequenceComputation[]>();
  for (const s of sequences) byEnd.set(s.end_state, [...(byEnd.get(s.end_state) ?? []), s]);
  const endStates = tree.end_states.map((e) => {
    const list = byEnd.get(e.id) ?? [];
    return { id: e.id, frequency: stableSum(list.map((x) => x.frequency)), probability: stableSum(list.map((x) => x.probability)), sequences: list.map((x) => x.key) };
  });
  return {
    sequences,
    endStates,
    total: { frequency: lambda * probabilitySum, probabilitySum, partitionError },
    approximationFrequencySum: opts.approximation ? stableSum(sequences.map((x) => x.approximation!.frequency)) : null,
    nodes: bdd.nodeCount,
  };
}

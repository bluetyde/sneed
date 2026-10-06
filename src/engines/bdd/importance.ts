// Importance measures of the basic events of a static coherent tree, exact (docs/plans/12-importance.md).
// Each measure is computed from two conditional probabilities of the same decision diagram as the top probability:
// P(T | i fails) with p_i set to 1 and P(T | i works) with p_i set to 0. Nothing here approximates through cut sets.
import { SolveAborted } from './bdd.js';
import { buildDiagram, type SolveOptions } from './solve.js';
import type { NativeModel } from '../../core/model.js';

/** More reachable events than this and the table is refused (each event costs two passes over the diagram). */
export const MAX_IMPORTANCE_EVENTS = 300;
/** events x diagram nodes: the work the measures need, in node visits (about 2e8 is a few seconds). */
export const MAX_IMPORTANCE_WORK = 100_000_000;

export interface ImportanceRow {
  id: string;
  /** The event's own probability in the model. */
  probability: number;
  /** P(T | i fails) - P(T | i works): the change of the top probability per unit change of this probability. */
  birnbaum: number;
  /** P(T | i fails) / P. Null when P is 0. */
  raw: number | null;
  /** P / P(T | i works). Null when that is undefined (see `rrwInfinite`) or P is 0. */
  rrw: number | null;
  /** True when P(T | i works) = 0: the event is in every cut set, and the reduction is unbounded. */
  rrwInfinite: boolean;
  /** (P - P(T | i works)) / P, the exact fraction of the top probability that is due to this event. Null when P is 0. */
  fv: number | null;
}

export interface ImportanceResult {
  /** The exact top-event probability the measures are relative to. */
  top: number;
  rows: ImportanceRow[];
  /** Diagram nodes, a measure of how hard the model was. */
  nodes: number;
}

/** Sorted by Birnbaum importance, largest first, ties by id. Throws SolveAborted past the limits. */
export function importance(model: NativeModel, opts: SolveOptions & { maxWork?: number } = {}): ImportanceResult {
  const { bdd, root, order, p } = buildDiagram(model, opts);
  const n = order.length;
  if (n > MAX_IMPORTANCE_EVENTS) throw new SolveAborted('too-many-events');
  if (n * bdd.nodeCount > (opts.maxWork ?? MAX_IMPORTANCE_WORK)) throw new SolveAborted('too-many-nodes');
  const top = bdd.probability(root, p);
  const rows: ImportanceRow[] = [];
  for (let i = 0; i < n; i++) {
    const q = p[i]!;
    p[i] = 1;
    const failed = bdd.probability(root, p);
    p[i] = 0;
    const works = bdd.probability(root, p);
    p[i] = q;
    rows.push({
      id: order[i]!,
      probability: q,
      birnbaum: failed - works,
      raw: top > 0 ? failed / top : null,
      rrw: top > 0 && works > 0 ? top / works : null,
      rrwInfinite: top > 0 && works === 0,
      fv: top > 0 ? (top - works) / top : null,
    });
  }
  rows.sort((a, b) => b.birnbaum - a.birnbaum || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { top, rows, nodes: bdd.nodeCount };
}

// Importance measures of the basic events of a static coherent tree, exact (docs/plans/12-importance.md).
// Each measure is computed from conditional probabilities of the same decision diagram as the top probability:
// P(T | i fails) with p_i set to 1 and P(T | i works) with p_i set to 0. Nothing here approximates through cut sets.
//
// Floating point is watched, not trusted: the Birnbaum difference is taken on the side where it does not cancel (the "false" side when the
// top event is almost certain), Fussell-Vesely is p_i * Birnbaum / P (an exact identity, with no second subtraction), and a result that
// underflowed to zero, or that is not a finite number, is a failure ('numeric-range'), never a table with a wrong zero in it.
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
  /** True when P(T | i works) = 0: with this event's probability at zero the top event cannot happen, and the reduction is unbounded. */
  rrwInfinite: boolean;
  /** p_i * Birnbaum / P = (P - P(T | i works)) / P, the exact fraction of the top probability due to this event. Null when P is 0. */
  fv: number | null;
}

export interface ImportanceResult {
  /** The exact top-event probability the measures are relative to. */
  top: number;
  rows: ImportanceRow[];
  /** Diagram nodes, a measure of how hard the model was. */
  nodes: number;
}

/** Sorted by Birnbaum importance, largest first, ties by id. Throws SolveAborted past the limits or when the numbers leave floating point's range. */
export function importance(model: NativeModel, opts: SolveOptions & { maxWork?: number } = {}): ImportanceResult {
  const { bdd, root, order, p } = buildDiagram(model, opts);
  const n = order.length;
  if (n > MAX_IMPORTANCE_EVENTS) throw new SolveAborted('too-many-events');
  if (n * bdd.nodeCount > (opts.maxWork ?? MAX_IMPORTANCE_WORK)) throw new SolveAborted('too-many-nodes');
  const range = (): never => {
    throw new SolveAborted('numeric-range');
  };

  /** Can the top event happen at all, with this event state? Zero-probability events cannot fail, certain ones always do, the others are free:
   *  decided on the structure of the diagram (no products of probabilities, which can underflow), so "impossible" is never "too small to represent". */
  const possible = (fixed?: { index: number; value: 0 | 1 }): boolean => bdd.satisfiable(root, (v) => (fixed && fixed.index === v ? fixed.value : p[v] === 0 ? 0 : p[v] === 1 ? 1 : undefined));

  const top = bdd.probability(root, p);
  if (!Number.isFinite(top)) return range();
  if (top === 0 && possible()) return range(); // it can happen, but the probability is below what a double can hold
  const rows: ImportanceRow[] = [];
  for (let i = 0; i < n; i++) {
    const q = p[i]!;
    p[i] = 1;
    const failed = bdd.probability(root, p);
    const failedFalse = bdd.complement(root, p);
    p[i] = 0;
    const works = bdd.probability(root, p);
    const worksFalse = bdd.complement(root, p);
    p[i] = q;
    // when the top event is almost certain, failed and works are both next to 1 and their difference is lost: use the false side
    const birnbaum = failed >= 0.5 ? worksFalse - failedFalse : failed - works;
    if (works === 0 && possible({ index: i, value: 0 })) return range(); // not impossible, only too small to represent
    const row: ImportanceRow = {
      id: order[i]!,
      probability: q,
      birnbaum,
      raw: top > 0 ? failed / top : null,
      rrw: top > 0 && works > 0 ? top / works : null,
      rrwInfinite: top > 0 && works === 0,
      fv: top > 0 ? (q * birnbaum) / top : null,
    };
    for (const x of [row.birnbaum, row.raw, row.rrw, row.fv]) if (x !== null && !Number.isFinite(x)) return range();
    rows.push(row);
  }
  rows.sort((a, b) => b.birnbaum - a.birnbaum || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { top, rows, nodes: bdd.nodeCount };
}

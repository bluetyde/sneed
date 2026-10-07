// The result of analysing an event tree (docs/plans/13-event-trees.md, stage S2): a record of a DIFFERENT KIND from the fault-tree result
// record (that one is read by SEED and is untouched). It says what it is: a frequency per sequence and per end state under a stated set
// of assumptions, the engine and hashes it came from, and either a complete answer or a named failure, never a partial table.
import type { PathStep } from './event-tree.js';

export const EVENT_TREE_RESULT_SCHEMA = { id: 'sneed.event-tree-result', version: 1 } as const;

export interface EtSequenceRow {
  /** "A:works,B:fails": the path, as one string. */
  key: string;
  path: PathStep[];
  end_state: string;
  /** Exact joint probability of the path condition (failure events and complements of failure events, shared basic events counted once). */
  probability: number;
  /** probability x the initiating-event frequency, per year. */
  frequency: number;
  /** probability, as a share of the initiating-event frequency (they are equal: kept so a reader need not divide). */
  share: number;
  /** Only when asked for: the traditional hand method that ignores the success branches (a different kind of number, labelled as such). */
  approximation?: { probability: number; frequency: number; ratio_to_exact: number | null };
}

export interface EtEndStateRow {
  id: string;
  name: string;
  synthetic: boolean;
  frequency: number;
  probability: number;
  sequences: string[];
}

export interface EventTreeResult {
  schema: typeof EVENT_TREE_RESULT_SCHEMA;
  /** completed: the numbers below are the answer. failed or cancelled: there are no numbers and `reasons` says why. */
  status: 'completed' | 'failed' | 'cancelled';
  completeness: 'complete' | 'unknown';
  reasons: string[];
  quantity: 'sequence_frequency';
  unit: 'per-year';
  method: 'exact-joint';
  /** The assumptions block of the document, copied: a result under other assumptions is a different kind of result. */
  assumptions: Record<string, unknown>;
  engine: { name: string; version: string; sha256: string | null; runtime: null };
  input_hashes: { tree_hash: string; model_hash: string; document_hash: string };
  initiating_event: { name: string; frequency: number; unit: string };
  headings: { id: string; name: string; event: string }[];
  sequences: EtSequenceRow[];
  end_states: EtEndStateRow[];
  /** The partition check: the sequence probabilities must add up to 1 (and the frequencies to the initiating-event frequency). */
  total: { frequency: number; probability_sum: number; partition_error: number } | null;
  /** Present only when the approximation was asked for. */
  approximation: { method: 'success-branches-ignored'; note: string; frequency_sum: number } | null;
  warnings: string[];
  caveats: string[];
}

/** The assumptions in words: printed with every result, in the editor and on every figure, because the numbers say nothing without them. */
export const EVENT_TREE_ASSUMPTIONS_TEXT =
  'Static, coherent fault trees with independent basic events of constant probability per demand; one initiating event with a constant frequency that does not depend on any basic event; each heading either works or fails, and "works" is exactly "its event does not occur"; sequence frequencies are exact joint probabilities (events shared by headings count once); no recovery and no change with time. A frequency here is a model result under these assumptions, not a plant figure.';

/** An end state's name with "(example)" after it when it is marked as an example, unless the name already says so. */
export const endStateLabel = (name: string, synthetic: boolean): string => (synthetic && !/\(example\)\s*$/i.test(name) ? `${name} (example)` : name);

/** Why a failure happened, in words (the codes are the solver's, plus this stage's two). */
export function eventTreeFailureText(code: string): string {
  switch (code) {
    case 'too-many-events':
      return 'The model has more basic events than the solver handles.';
    case 'too-many-nodes':
      return 'The model is too large for the sequences to be evaluated.';
    case 'timeout':
      return 'The analysis took too long and was stopped.';
    case 'cancelled':
      return 'The analysis was cancelled.';
    case 'too-much-memory':
      return 'The analysis needed too much memory and was stopped.';
    case 'numeric-range':
      return 'Some sequence has a probability below what the arithmetic can hold (about 1e-300). Nothing is shown rather than a table with wrong zeros.';
    case 'sequences-do-not-partition':
      return 'The sequence probabilities do not add up to 1, so the sequence list does not cover the possible outcomes. No result is given.';
    default:
      return 'The analysis failed (an internal error). Nothing is shown rather than a wrong table.';
  }
}

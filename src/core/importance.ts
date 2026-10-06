// What the importance tables say about themselves (docs/plans/12-importance.md). Plain data shared by the server and the editor, so the
// words next to the numbers are the same wherever they are shown, and no engine code reaches the browser bundle.

export const IMPORTANCE_ASSUMPTIONS =
  'Static coherent fault tree; basic events independent with constant probabilities, as stated in the model. The measures are exact for that model (not cut-set approximations). They describe this model, not a plant: a ranking is a teaching aid, not a design or licensing finding.';

export const IMPORTANCE_DEFINITIONS: { key: 'birnbaum' | 'raw' | 'rrw' | 'fv'; name: string; meaning: string }[] = [
  { key: 'birnbaum', name: 'Birnbaum', meaning: 'The change of the top probability per unit change of this event\'s probability: P(top | event fails) minus P(top | event works).' },
  { key: 'raw', name: 'Risk achievement worth (RAW)', meaning: 'How many times more likely the top event is if this event is certain to fail: P(top | event fails) / P(top).' },
  { key: 'rrw', name: 'Risk reduction worth (RRW)', meaning: 'How many times less likely the top event would be if this event could never fail: P(top) / P(top | event works). Unbounded (shown as "infinite") when the event is in every cut set.' },
  { key: 'fv', name: 'Fussell-Vesely (exact form)', meaning: 'The fraction of the top probability that goes away if this event never fails: (P(top) - P(top | event works)) / P(top). Textbooks also give a cut-set form that differs slightly when probabilities are not small.' },
];

export interface ImportanceEventRow {
  id: string;
  name?: string;
  probability: number;
  birnbaum: number;
  raw: number | null;
  rrw: number | null;
  rrwInfinite: boolean;
  fv: number | null;
}

export type ImportanceResponse =
  | { kind: 'ok'; model_hash: string; engine: { name: string; version: string }; top: number; events: ImportanceEventRow[]; assumptions: string }
  | { kind: 'refused'; errors: { code: string; message: string; ids?: string[] }[] }
  | { kind: 'failed'; why: string; message: string }
  | { kind: 'dequeued' };

/** Why the table could not be made, in words (the reason codes are the solver's). */
export function importanceFailureText(why: string): string {
  switch (why) {
    case 'too-many-events':
      return 'The model has more basic events than the importance table handles (300). The analysis itself is not affected.';
    case 'too-many-nodes':
      return 'The model is too large for the importance table to be computed in reasonable time. The analysis itself is not affected.';
    case 'timeout':
      return 'The importance table took too long and was stopped.';
    case 'cancelled':
      return 'The importance table was cancelled.';
    case 'too-much-memory':
      return 'The importance table needed too much memory and was stopped.';
    default:
      return 'The importance table could not be computed (an internal error). Nothing is shown rather than a wrong table.';
  }
}

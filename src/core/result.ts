import { maxCutSetOrderBound } from './bounds.js';
import type { NativeModel, Settings } from './model.js';
import { ReportError, parseReport, PARSER_VERSION, type ParsedReport } from './report.js';
import { EXPORTER_VERSION } from './export.js';

export type Status = 'completed' | 'truncated' | 'failed' | 'cancelled';
export type Completeness = 'complete' | 'truncated' | 'unknown';

export interface EngineIdentity {
  name: string;
  version: string;
  /** sha256 of the engine binary, when it could be read. */
  sha256: string | null;
  /** The managed runtime install this engine came from; null for an unmanaged development build. */
  runtime?: { install_id: string; recipe_revision: number; manifest_sha256: string } | null;
}

export interface ResultRecord {
  schema_version: 1;
  status: Status;
  completeness: Completeness;
  /** Why the status is not completed/complete, in machine-readable form. Empty for a clean success. */
  reasons: string[];
  quantity: 'top_event_probability';
  unit: 'dimensionless';
  method: Settings['method'];
  assumptions: Record<string, unknown>;
  engine: EngineIdentity;
  warnings: string[];
  settings: Settings;
  input_hashes: { model_hash: string; document_hash: string; exported_input_hash: string };
  exporter_version: string;
  parser_version: string;
  /**
   * A probability, so never above 1. Only set for completed, and for truncated (diagnostic only, never indexed as
   * an analysis). For an approximation whose own value exceeds 1 this is the bound 1 and `approximation_value` has the rest.
   */
  top_event_probability: number | null;
  /**
   * The approximation method's own value, recomputed from the cut sets (rare-event: their sum; MCUB: 1 - prod(1 - p)).
   * Null for the exact method. The rare-event sum can exceed 1; it is then not a probability, and `caveats` says so.
   */
  approximation_value: number | null;
  /** Labels on a successful result that a reader must not miss. Empty means nothing to add. */
  caveats: string[];
  minimal_cut_sets: { events: string[]; probability: number }[];
}

export interface Outcome {
  exit: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stderr: string;
}

export interface AssessInput {
  model: NativeModel;
  settings: Settings;
  engine: EngineIdentity;
  /** The engine version this build is pinned to (docs/spike/README.md). */
  expectedVersion: string;
  outcome: Outcome;
  reportText: string | null;
  hashes: ResultRecord['input_hashes'];
  /** Basic events written to the exported XML. */
  exportedEvents: string[];
}

const APPROXIMATION: Record<Settings['method'], string> = { exact: 'none', 'rare-event': 'rare-event', mcub: 'mcub' };
const REL_TOL = 5e-5; // the engine prints about 6 significant digits
const close = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(1e-12, REL_TOL * Math.max(Math.abs(a), Math.abs(b)));

/** Probability that at least one of the cut sets occurs, by inclusion-exclusion (independent events). Small inputs only. */
function unionProbability(sets: string[][], p: Map<string, number>): number {
  let sum = 0;
  for (let sub = 1; sub < 1 << sets.length; sub++) {
    const union = new Set<string>();
    let bits = 0;
    for (let j = 0; j < sets.length; j++) if ((sub >> j) & 1) (bits++, sets[j]!.forEach((e) => union.add(e)));
    let term = 1;
    for (const e of union) term *= p.get(e)!;
    sum += bits % 2 ? term : -term;
  }
  return sum;
}

/**
 * Turns an engine outcome into a result record. "completed" is awarded only when every check passes and no
 * cut set can have been dropped (docs/plans/02: zero exit and no warning are not enough).
 */
export function assess(input: AssessInput): ResultRecord {
  const { model, settings } = input;
  const base: ResultRecord = {
    schema_version: 1,
    status: 'failed',
    completeness: 'unknown',
    reasons: [],
    quantity: 'top_event_probability',
    unit: 'dimensionless',
    method: settings.method,
    assumptions: model.assumptions,
    engine: input.engine,
    warnings: [],
    settings,
    input_hashes: input.hashes,
    exporter_version: EXPORTER_VERSION,
    parser_version: PARSER_VERSION,
    top_event_probability: null,
    approximation_value: null,
    caveats: [],
    minimal_cut_sets: [],
  };
  const fail = (...reasons: string[]): ResultRecord => ({ ...base, reasons });

  if (input.outcome.cancelled) return { ...base, status: 'cancelled', reasons: ['cancelled'] };
  if (input.outcome.timedOut) return fail('timeout');
  if (input.outcome.exit !== 0) {
    const cls = /scram::[A-Za-z:]+/.exec(input.outcome.stderr)?.[0];
    return fail(`engine-exit-${input.outcome.exit}`, ...(cls ? [`engine-error:${cls}`] : []));
  }
  if (input.reportText === null) return fail('no-report');

  let report: ParsedReport;
  try {
    report = parseReport(input.reportText);
  } catch (e) {
    if (e instanceof ReportError) return fail(`report-${e.code}`);
    throw e;
  }

  const reasons: string[] = [];
  if (report.software.name !== 'SCRAM' || report.software.version !== input.expectedVersion) reasons.push('engine-version-mismatch');
  if (report.approximation !== APPROXIMATION[settings.method]) reasons.push('method-mismatch');
  if (!(report.probability >= 0 && report.probability <= 1)) reasons.push('probability-out-of-range');
  const adjusted = report.warning !== null && /adjusted/i.test(report.warning);
  // an exact probability is never above 1; a clamp warning with a printed value of 1 is only rounding, anything else is not
  if (adjusted && settings.method === 'exact' && !close(report.probability, 1)) reasons.push('probability-adjusted-by-engine');

  const known = new Set(input.exportedEvents);
  const p = new Map(model.events.map((e) => [e.id, e.probability]));
  const keys = new Set<string>();
  for (const prod of report.products) {
    const ev = prod.events;
    if (ev.length === 0 || new Set(ev).size !== ev.length || prod.order !== ev.length) reasons.push('malformed-cut-set');
    else if (ev.some((e) => !known.has(e))) reasons.push('unknown-event-in-cut-set');
    else {
      const expected = ev.reduce((acc, e) => acc * p.get(e)!, 1);
      if (!(prod.probability >= 0 && prod.probability <= 1) || !close(prod.probability, expected)) reasons.push('cut-set-probability-mismatch');
    }
    const key = [...ev].sort().join('\u0000');
    if (keys.has(key)) reasons.push('duplicate-cut-set');
    keys.add(key);
  }
  const sets = report.products.map((x) => x.events);
  outer: for (let i = 0; i < sets.length; i++) {
    for (let j = 0; j < sets.length; j++) {
      if (i !== j && sets[i]!.every((e) => sets[j]!.includes(e)) && sets[i]!.length < sets[j]!.length) {
        reasons.push('non-minimal-cut-sets');
        break outer;
      }
    }
  }
  // rare-event and MCUB values are pure functions of the cut sets: recompute them. SCRAM clamps a value above 1 to 1 and
  // only warns. That is not a failure: the record keeps the bound (1) as the probability, carries the method's own value
  // and labels it. The printed value must still be exactly that clamp, anything else is inconsistent.
  let approximationValue: number | null = null;
  const caveats: string[] = [];
  if (reasons.length === 0 && settings.method !== 'exact') {
    const pc = report.products.map((prod) => prod.events.reduce((acc, e) => acc * p.get(e)!, 1));
    const raw = settings.method === 'rare-event' ? pc.reduce((a, x) => a + x, 0) : 1 - pc.reduce((a, x) => a * (1 - x), 1);
    if (raw > 1 + 1e-9) {
      if (close(report.probability, 1)) caveats.push('approximation-exceeds-1');
      else reasons.push('probability-inconsistent-with-cut-sets');
    } else if (!close(report.probability, raw)) reasons.push('probability-inconsistent-with-cut-sets');
    approximationValue = raw;
  }
  const warnings = report.warning ? [report.warning] : [];
  const parsed: Partial<ResultRecord> = {
    warnings,
    top_event_probability: report.probability,
    approximation_value: approximationValue,
    caveats,
    minimal_cut_sets: report.products.map((x) => ({ events: [...x.events].sort(), probability: x.probability })),
  };
  if (reasons.length) return { ...fail(...new Set(reasons)), warnings };

  // consistency (exact method): the kept cut sets can never explain more probability than the total
  const small = settings.method === 'exact' && report.products.length > 0 && report.products.length <= 12;
  const union = small ? unionProbability(sets, p) : null;
  if (union !== null && union > report.probability && !close(union, report.probability)) {
    return { ...fail('probability-inconsistent-with-cut-sets'), warnings };
  }

  // completeness: can the engine's product-order limit have dropped a cut set?
  const limit = report.productOrderLimit;
  if (limit === null) return { ...fail('limit-not-reported'), warnings };
  const needed = Math.min(maxCutSetOrderBound(model), input.exportedEvents.length);
  if (limit >= needed) {
    if (report.products.length === 0) return { ...fail('empty-result-inconsistent'), warnings };
    // with an ample limit nothing may be missing: the cut sets must explain the whole probability
    if (union !== null && !close(union, report.probability)) return { ...fail('probability-inconsistent-with-cut-sets'), warnings };
    return { ...base, ...parsed, status: 'completed', completeness: 'complete' } as ResultRecord;
  }
  // limit below the structural bound: omission must be demonstrated, otherwise completeness is unknown
  const emptyButPossible = report.products.length === 0 && report.probability > 0;
  const explainsLess = union !== null && union < report.probability && !close(union, report.probability);
  if (emptyButPossible || explainsLess) {
    return { ...base, ...parsed, status: 'truncated', completeness: 'truncated', reasons: ['product-order-limit-effective'] } as ResultRecord;
  }
  return { ...fail('limit-below-bound-completeness-unknown'), warnings };
}

// The built-in engine as an analysis: validated native document -> decision diagram -> the same result record the SCRAM path
// produces, through the same checks (`assess`). No child process, no WSL2, no Open-PSA export.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AnalyzeOutcome } from '../../core/analyze.js';
import { documentHash, modelHash } from '../../core/canonical.js';
import type { Method, NativeModel, Settings } from '../../core/model.js';
import type { ParsedReport } from '../../core/report.js';
import { assess, AssessAborted, type ResultRecord } from '../../core/result.js';
import { reachableEvents } from '../../core/bounds.js';
import { unanalysedGroups, validateModelText } from '../../core/validate.js';
import { solveIsolated } from './isolate.js';
import { BDD_ENGINE_NAME, BDD_ENGINE_VERSION, type Solution } from './solve.js';
import { BDD_SOURCE_SHA256 } from './build-id.js';
import type { BddLimits } from './bdd.js';

export interface BuiltinOptions {
  runsDir: string;
  settings?: Partial<Settings>;
  /** Whole-analysis time limit in milliseconds (default 60000). */
  timeoutMs?: number;
  signal?: AbortSignal;
  runId?: string;
  /** Test seam: the monotonic clock in milliseconds. */
  now?: () => number;
  order?: string[];
  limits?: Partial<BddLimits>;
  /** Old-generation heap limit of the solver thread in megabytes (default 1024). */
  memoryMb?: number;
}

const METHODS: Method[] = ['exact', 'rare-event', 'mcub'];
const APPROX: Record<Method, string> = { exact: 'none', 'rare-event': 'rare-event', mcub: 'mcub' };

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8' });
  renameSync(tmp, file);
}

/**
 * The solution in the form the shared result checks read. The approximations are recomputed here from the cut sets.
 * A product-order limit below the order of some cut set is honoured the way SCRAM honours it: only cut sets up to the limit are
 * reported, the probability stays the exact one, and the shared checks then see that the sets explain less than the whole
 * (a truncated result), never a complete one.
 */
function asReport(sol: Solution, method: Method, limitOrder: number): ParsedReport {
  const kept = sol.cutSets.filter((c) => c.events.length <= limitOrder);
  const pc = kept.map((c) => c.probability);
  const raw = method === 'exact' ? sol.probability : method === 'rare-event' ? pc.reduce((a, x) => a + x, 0) : -Math.expm1(pc.reduce((a, x) => a + Math.log1p(-x), 0)); // 1 - prod(1 - p), without the cancellation that loses a small p
  return {
    software: { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION },
    probability: Math.min(1, raw),
    warning: null,
    products: kept.map((c) => ({ order: c.events.length, probability: c.probability, events: c.events })),
    approximation: APPROX[method],
    productOrderLimit: limitOrder,
    cutSetMethod: 'bdd-minimal-solutions',
  };
}

export async function analyzeBuiltin(documentText: string, opts: BuiltinOptions): Promise<AnalyzeOutcome> {
  const now = opts.now ?? ((): number => performance.now());
  const deadline = now() + (opts.timeoutMs ?? 60000);

  const validation = validateModelText(documentText);
  if (!validation.valid) return { kind: 'refused', errors: validation.errors, warnings: validation.warnings };
  const groups = unanalysedGroups(JSON.parse(documentText));
  if (groups) return { kind: 'refused', errors: [groups], warnings: validation.warnings };
  const model = JSON.parse(documentText) as NativeModel;
  const events = reachableEvents(model);
  const settings: Settings = { method: 'exact', limitOrder: Math.max(1, events.length), ...opts.settings };
  if (!(METHODS as string[]).includes(settings.method)) throw new RangeError(`unknown method ${String(settings.method)}`);
  if (!Number.isInteger(settings.limitOrder) || settings.limitOrder < 1) throw new RangeError('limitOrder must be an integer >= 1');

  const hashes = { model_hash: modelHash(model), document_hash: documentHash(Buffer.from(documentText, 'utf8')), exported_input_hash: '' };
  hashes.exported_input_hash = hashes.model_hash; // this engine reads the semantic model itself: there is no export
  const runId = opts.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${hashes.model_hash.slice(0, 8)}-${randomBytes(3).toString('hex')}`;
  if (!/^[A-Za-z0-9_-]{8,}$/.test(runId)) throw new RangeError('runId must be at least 8 characters of [A-Za-z0-9_-]');
  const runDir = path.resolve(opts.runsDir, runId);
  if (existsSync(runDir)) throw new Error(`run directory already exists: ${runDir}`);
  for (const d of ['inputs', 'native', 'log']) mkdirSync(path.join(runDir, d), { recursive: true });
  writeFileSync(path.join(runDir, 'native', 'model.json'), documentText, { encoding: 'utf8' }); // byte for byte as submitted

  // the checks after the solver (assess) poll this; it throws what assess understands
  const check = (): void => {
    if (opts.signal?.aborted) throw new AssessAborted('cancelled');
    if (now() > deadline) throw new AssessAborted('timeout');
  };
  // the identity of this engine is the hash of its source files (build-id.ts, generated and checked by a test): the same field SCRAM fills with its binary's hash
  const engine = { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION, sha256: BDD_SOURCE_SHA256, runtime: null };
  const base = { model, settings, engine, expectedVersion: BDD_ENGINE_VERSION, expectedName: BDD_ENGINE_NAME, hashes, exportedEvents: events, check };
  const idle = { exit: 0, timedOut: false, cancelled: false, stderr: '' };
  const finish = (record: ResultRecord, extra: Record<string, unknown> = {}): AnalyzeOutcome => {
    const final: ResultRecord = { ...record, exporter_version: 'none (the built-in engine reads the native model)' };
    writeAtomic(path.join(runDir, 'inputs', 'settings.json'), JSON.stringify({ settings, engine: { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION }, ...extra }, null, 2) + '\n');
    writeAtomic(path.join(runDir, 'results.json'), JSON.stringify(final, null, 2) + '\n');
    return { kind: 'ran', runDir, record: final };
  };

  // the solver runs in its own thread: the time limit, the memory limit and a cancel all work while it computes
  const remaining = Math.floor(deadline - now());
  let sol: Solution;
  if (opts.signal?.aborted) return finish(assess({ ...base, outcome: { ...idle, cancelled: true }, reportText: null }));
  if (remaining <= 0) return finish(assess({ ...base, outcome: { ...idle, timedOut: true }, reportText: null }));
  const answer = await solveIsolated(model, { timeoutMs: remaining, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.order ? { order: opts.order } : {}), ...(opts.limits ? { limits: opts.limits } : {}), ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}) });
  if (!answer.ok) {
    if (answer.why === 'cancelled') return finish(assess({ ...base, outcome: { ...idle, cancelled: true }, reportText: null }));
    if (answer.why === 'timeout') return finish(assess({ ...base, outcome: { ...idle, timedOut: true }, reportText: null }));
    return finish(assess({ ...base, outcome: idle, reportText: null, forceFail: [answer.why === 'internal' ? 'engine-error' : answer.why] }));
  }
  sol = answer.solution;
  const record = assess({ ...base, outcome: idle, reportText: null, parsed: asReport(sol, settings.method, settings.limitOrder) });
  return finish(record, { order: sol.events, nodes: sol.nodes, cut_sets: sol.cutSets.length });
}

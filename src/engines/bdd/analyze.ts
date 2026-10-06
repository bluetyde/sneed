// The built-in engine as an analysis: validated native document -> decision diagram -> the same result record the SCRAM path
// produces, through the same checks (`assess`). No child process, no WSL2, no Open-PSA export.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AnalyzeOutcome } from '../../core/analyze.js';
import { documentHash, modelHash } from '../../core/canonical.js';
import type { Method, NativeModel, Settings } from '../../core/model.js';
import type { ParsedReport } from '../../core/report.js';
import { assess, type ResultRecord } from '../../core/result.js';
import { reachableEvents } from '../../core/bounds.js';
import { validateModelText } from '../../core/validate.js';
import { BDD_ENGINE_NAME, BDD_ENGINE_VERSION, SolveAborted, solve, type Solution } from './solve.js';
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
}

const METHODS: Method[] = ['exact', 'rare-event', 'mcub'];
const APPROX: Record<Method, string> = { exact: 'none', 'rare-event': 'rare-event', mcub: 'mcub' };

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8' });
  renameSync(tmp, file);
}

/** The solution in the form the shared result checks read. The approximations are recomputed here from the cut sets. */
function asReport(sol: Solution, method: Method): ParsedReport {
  const pc = sol.cutSets.map((c) => c.probability);
  const raw = method === 'exact' ? sol.probability : method === 'rare-event' ? pc.reduce((a, x) => a + x, 0) : 1 - pc.reduce((a, x) => a * (1 - x), 1);
  return {
    software: { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION },
    probability: Math.min(1, raw),
    warning: null,
    products: sol.cutSets.map((c) => ({ order: c.events.length, probability: c.probability, events: c.events })),
    approximation: APPROX[method],
    // this engine never drops a cut set by order: it reports "limit" as the number of events, which can never be exceeded
    productOrderLimit: sol.events.length,
    cutSetMethod: 'bdd-minimal-solutions',
  };
}

export async function analyzeBuiltin(documentText: string, opts: BuiltinOptions): Promise<AnalyzeOutcome> {
  const now = opts.now ?? ((): number => performance.now());
  const deadline = now() + (opts.timeoutMs ?? 60000);

  const validation = validateModelText(documentText);
  if (!validation.valid) return { kind: 'refused', errors: validation.errors, warnings: validation.warnings };
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

  const check = (): void => {
    if (opts.signal?.aborted) throw new SolveAborted('cancelled');
    if (now() > deadline) throw new SolveAborted('timeout');
  };
  const engine = { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION, sha256: null, runtime: null };
  const base = { model, settings, engine, expectedVersion: BDD_ENGINE_VERSION, expectedName: BDD_ENGINE_NAME, hashes, exportedEvents: events, check };
  const idle = { exit: 0, timedOut: false, cancelled: false, stderr: '' };
  const finish = (record: ResultRecord, extra: Record<string, unknown> = {}): AnalyzeOutcome => {
    const final: ResultRecord = { ...record, exporter_version: 'none (the built-in engine reads the native model)' };
    writeAtomic(path.join(runDir, 'inputs', 'settings.json'), JSON.stringify({ settings, engine: { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION }, ...extra }, null, 2) + '\n');
    writeAtomic(path.join(runDir, 'results.json'), JSON.stringify(final, null, 2) + '\n');
    return { kind: 'ran', runDir, record: final };
  };

  let sol: Solution;
  try {
    check();
    sol = solve(model, { ...(opts.order ? { order: opts.order } : {}), ...(opts.limits ? { limits: opts.limits } : {}), tick: check });
  } catch (e) {
    if (!(e instanceof SolveAborted)) throw e;
    if (e.why === 'cancelled') return finish(assess({ ...base, outcome: { ...idle, cancelled: true }, reportText: null }));
    if (e.why === 'timeout') return finish(assess({ ...base, outcome: { ...idle, timedOut: true }, reportText: null }));
    return finish(assess({ ...base, outcome: idle, reportText: null, forceFail: [e.why] }));
  }
  const record = assess({ ...base, outcome: idle, reportText: null, parsed: asReport(sol, settings.method) });
  return finish(record, { order: sol.events, nodes: sol.nodes, cut_sets: sol.cutSets.length });
}

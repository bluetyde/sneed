import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { accountNames, scrubText } from './scrub.js';
import { reachableEvents } from './bounds.js';
import { documentHash, modelHash } from './canonical.js';
import { engineIdentity, execInWsl, toWslPath, type EngineConfig } from './engine.js';
import { defaultRuntimeEnv, resolveEngine } from '../runtime/resolve.js';
import { ExportError, exportOpenPsa, type VotingMode } from './export.js';
import type { Method, NativeModel, Settings } from './model.js';
import { assess, AssessAborted, MAX_REPORT_BYTES, type EngineIdentity, type ResultRecord } from './result.js';
import { validateModelText, type Issue } from './validate.js';

export interface AnalyzeOptions {
  /** Directory that holds one sub-directory per run (runs/<id>/{inputs,native,log,results.json}). */
  runsDir: string;
  settings?: Partial<Settings>;
  /** Defaults to the installed runtime (see src/runtime/resolve.ts). */
  engine?: EngineConfig;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** How K-of-N gates are written for the engine; the default is chosen from evidence (docs/spike/README.md). */
  voting?: VotingMode;
  runId?: string;
  /** Test seam: the clock the time limit is measured with (milliseconds). */
  now?: () => number;
  /** Test seam: rewrites the exported XML before it is written, to provoke engine-side failures. */
  transformXml?: (xml: string) => string;
}

/** A reason an analysis was refused before a run was created. Validation issues are assignable to this. */
export interface Refusal {
  code: string;
  path: string;
  message: string;
  ids?: string[];
}

export type AnalyzeOutcome =
  | { kind: 'refused'; errors: Refusal[]; warnings: Issue[] }
  | { kind: 'ran'; runDir: string; record: ResultRecord };

const METHOD_ARGS: Record<Method, string[]> = {
  exact: ['--bdd', '--probability', 'true'],
  'rare-event': ['--bdd', '--probability', 'true', '--rare-event'],
  mcub: ['--bdd', '--probability', 'true', '--mcub'],
};

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8' });
  renameSync(tmp, file);
}

/**
 * Document text -> validated snapshot -> Open-PSA XML -> SCRAM -> parsed, checked result record.
 * A document that fails validation returns typed errors and creates no run directory.
 * Everything the engine saw and said is kept in the run directory, whatever the outcome.
 */
export async function analyze(documentText: string, opts: AnalyzeOptions): Promise<AnalyzeOutcome> {
  // one monotonic clock for the whole analysis, started on entry: validation, export, the engine and the checks on its report
  const now = opts.now ?? ((): number => performance.now());
  const deadline = now() + (opts.timeoutMs ?? 60000);
  const validation = validateModelText(documentText);
  if (!validation.valid) return { kind: 'refused', errors: validation.errors, warnings: validation.warnings };

  const model = JSON.parse(documentText) as NativeModel;
  const events = reachableEvents(model);
  const settings: Settings = { method: 'exact', limitOrder: Math.max(1, events.length), ...opts.settings };
  if (!Number.isInteger(settings.limitOrder) || settings.limitOrder < 1) throw new RangeError('limitOrder must be an integer >= 1');
  if (!(settings.method in METHOD_ARGS)) throw new RangeError(`unknown method ${String(settings.method)}`);

  let exported: ReturnType<typeof exportOpenPsa>;
  try {
    exported = exportOpenPsa(model, opts.voting ? { voting: opts.voting } : {});
  } catch (e) {
    if (e instanceof ExportError) return { kind: 'refused', errors: [{ code: e.code, path: '/', message: e.message, ...(e.ids.length ? { ids: e.ids } : {}) }], warnings: validation.warnings };
    throw e;
  }
  const xml = opts.transformXml ? opts.transformXml(exported.xml) : exported.xml;
  const hashes = { model_hash: modelHash(model), document_hash: documentHash(Buffer.from(documentText, 'utf8')), exported_input_hash: sha256(xml) };

  // no explicit engine: the installed runtime, or a typed E_SETUP_REQUIRED error; never an unmanaged binary
  const engineCfg = opts.engine ?? resolveEngine(defaultRuntimeEnv());
  const runId = opts.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${hashes.model_hash.slice(0, 8)}-${randomBytes(3).toString('hex')}`;
  if (!/^[A-Za-z0-9_-]{8,}$/.test(runId)) throw new RangeError('runId must be at least 8 characters of [A-Za-z0-9_-]');
  const runDir = path.resolve(opts.runsDir, runId);
  if (existsSync(runDir)) throw new Error(`run directory already exists: ${runDir}`);
  for (const d of ['inputs', 'native', 'log']) mkdirSync(path.join(runDir, d), { recursive: true });

  writeFileSync(path.join(runDir, 'native', 'model.json'), documentText, { encoding: 'utf8' }); // byte for byte as submitted
  writeFileSync(path.join(runDir, 'inputs', 'model.xml'), xml, { encoding: 'utf8' });
  const inputPath = path.join(runDir, 'inputs', 'model.xml');
  const reportPath = path.join(runDir, 'native', 'report.xml');
  const argv = ['env', `LD_LIBRARY_PATH=${engineCfg.libs}`, engineCfg.binary, ...METHOD_ARGS[settings.method], '-l', String(settings.limitOrder), toWslPath(inputPath), '-o', toWslPath(reportPath)];
  // what is written into the run folder never names this machine's folders or account (publication scrub, src/core/scrub.ts); the engine still gets the real argv
  const scrub = (t: string): string => scrubText(t, { prefixes: [[toWslPath(runDir), '<run>'], [runDir, '<run>'], [path.resolve(opts.runsDir), '<runs>'], [process.cwd(), '<repo>'], [homedir(), '<home>']], usernames: accountNames() });
  writeAtomic(path.join(runDir, 'inputs', 'settings.json'), JSON.stringify({ settings, argv: argv.map(scrub), export_mapping: exported.mapping }, null, 2) + '\n');

  const finish = (record: ResultRecord): AnalyzeOutcome => {
    writeAtomic(path.join(runDir, 'results.json'), JSON.stringify(record, null, 2) + '\n');
    return { kind: 'ran', runDir, record };
  };
  // the checks on a large report poll this and stop
  const check = (): void => {
    if (opts.signal?.aborted) throw new AssessAborted('cancelled');
    if (now() > deadline) throw new AssessAborted('timeout');
  };
  const assessWith = (engine: EngineIdentity, outcome: Parameters<typeof assess>[0]['outcome'], reportText: string | null): AnalyzeOutcome =>
    finish(assess({ model, settings, engine, expectedVersion: engineCfg.expectedVersion, outcome, reportText, hashes, exportedEvents: exported.mapping.events, check }));

  let identity: EngineIdentity;
  try {
    identity = { ...(await engineIdentity(engineCfg)), runtime: engineCfg.runtime ?? null };
  } catch (e) {
    identity = { name: 'unknown', version: 'unknown', sha256: null };
    writeFileSync(path.join(runDir, 'log', 'stderr.txt'), scrub(`identity check failed: ${(e as Error).message}\n`));
    return assessWith(identity, { exit: null, timedOut: false, cancelled: false, stderr: 'engine identity unavailable' }, null);
  }
  if (engineCfg.expectedSha256 && identity.sha256 !== engineCfg.expectedSha256) {
    // refuse to run an engine that is not the pinned build; keep the reason in the record
    const rec = assess({ model, settings, engine: identity, expectedVersion: engineCfg.expectedVersion, outcome: { exit: 0, timedOut: false, cancelled: false, stderr: '' }, reportText: null, hashes, exportedEvents: exported.mapping.events });
    return finish({ ...rec, reasons: ['engine-build-mismatch'] });
  }

  // the engine gets what is left of the budget, and is not started at all when nothing is left
  const remaining = Math.floor(deadline - now());
  if (remaining <= 0 || opts.signal?.aborted) {
    return assessWith(identity, { exit: null, timedOut: !opts.signal?.aborted, cancelled: opts.signal?.aborted === true, stderr: '' }, null);
  }
  const result = await execInWsl(engineCfg.distro, argv, { timeoutMs: remaining, ...(opts.signal ? { signal: opts.signal } : {}), ownerTag: toWslPath(runDir) });
  writeFileSync(path.join(runDir, 'log', 'stdout.txt'), scrub(result.stdout), 'utf8');
  writeFileSync(path.join(runDir, 'log', 'stderr.txt'), scrub(result.stderr), 'utf8');
  const reportTooLarge = existsSync(reportPath) && statSync(reportPath).size > MAX_REPORT_BYTES; // never read into memory
  const reportText = existsSync(reportPath) && !reportTooLarge ? readFileSync(reportPath, 'utf8') : null;
  return finish(assess({ model, settings, engine: identity, expectedVersion: engineCfg.expectedVersion, outcome: { exit: result.exit, timedOut: result.timedOut, cancelled: result.cancelled, stderr: result.stderr }, reportText, reportTooLarge, hashes, exportedEvents: exported.mapping.events, check }));
}

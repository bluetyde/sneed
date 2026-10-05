// SNEED headless runner: the entry point other programs (the SEED adapter, docs/plans/11-seed-adapter.md) use.
// One JSON object on stdout, nothing else.
//
//   node dist/node/cli/headless.js describe
//   node dist/node/cli/headless.js validate <model.json>
//   node dist/node/cli/headless.js run <model.json> --out <absDir> [--run-id pra] [--method exact|rare-event|mcub]
//                                      [--limit-order N] [--timeout-seconds 60]
//   node dist/node/cli/headless.js cancel --out <absDir>
//
// Exit codes: 0 a reply was produced (a run that ended truncated, failed or cancelled is exit 0 with that status and a
// reason, and writes no result), 2 the model or an argument was refused (ok:false with typed errors), 1 the runner
// itself failed (ok:false). A completed `run` writes <out>/<run-id>/{model.json, results.json, manifest.json}; the
// engine's own run folder (inputs, report, logs) stays under <out>/work/. The result is a probability under stated
// assumptions: not a frequency and not a plant risk figure.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyze as realAnalyze, type AnalyzeOptions, type AnalyzeOutcome } from '../core/analyze.js';
import { hasOwned as realHasOwned, killOwned as realKillOwned, toWslPath, type EngineConfig } from '../core/engine.js';
import type { Method } from '../core/model.js';
import { validateModelText, type Issue } from '../core/validate.js';
import { defaultRuntimeEnv, resolveEngine as realResolveEngine, RuntimeNotInstalledError } from '../runtime/resolve.js';

export const HEADLESS_VERSION = '0.1.0';
export const MEANING = 'A probability that the top event occurs under the stated assumptions (constant probabilities, independent basic events). Not a frequency and not a plant risk figure.';
const METHODS: Method[] = ['exact', 'rare-event', 'mcub'];
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** analyze() wants at least 8 characters of [A-Za-z0-9_-] for its own run folder name. */
const WORK_ID = /^pra-[0-9a-f]{12}$/;

/** What the runner needs from the outside, replaceable in tests. */
export interface Deps {
  analyze: (text: string, opts: AnalyzeOptions) => Promise<AnalyzeOutcome>;
  resolveEngine: () => EngineConfig;
  distro: () => string;
  killOwned: (distro: string, tag: string) => void;
  hasOwned: (distro: string, tag: string) => boolean;
  /** Write one line to stdout. */
  write: (line: string) => void;
  newWorkId: () => string;
  pollMs: number;
  /** How long cancel keeps killing and checking before it reports an engine process as still alive. */
  settleMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const realDeps = (): Deps => ({
  analyze: realAnalyze,
  resolveEngine: () => realResolveEngine(defaultRuntimeEnv()),
  distro: () => defaultRuntimeEnv().distro,
  killOwned: realKillOwned,
  hasOwned: realHasOwned,
  write: (line) => void process.stdout.write(line),
  newWorkId: () => `pra-${createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 12)}`,
  pollMs: 250,
  settleMs: 5000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** Thrown by reply() so nothing after a reply runs; main() turns it into the exit code. */
class Reply extends Error {
  constructor(readonly code: number) {
    super('reply written');
  }
}

interface Typed {
  code: string;
  field: string;
  message: string;
  source?: 'app-content';
  ids?: string[];
}
/**
 * A validation issue as a typed error. Messages quote ids taken from the model, so they are app content and
 * SEED treats them as untrusted data. The codes are ours (E_CYCLE, E_PROB_RANGE, ...), except the two that
 * mean the same as SEED's own.
 */
const typed = (i: { code: string; path: string; message: string; ids?: string[] }): Typed => ({
  code: i.code === 'E_SCHEMA' ? 'E_SCHEMA_INVALID' : i.code,
  field: i.path === '/' ? '' : i.path,
  message: i.message,
  source: 'app-content',
  ...(i.ids?.length ? { ids: i.ids } : {}),
});
const warnTyped = (w: Issue): Typed => ({ ...typed(w) });

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(argv: string[], deps: Deps = realDeps()): Promise<number> {
  const reply = (obj: unknown, code: number): never => {
    deps.write(JSON.stringify(obj) + '\n');
    throw new Reply(code);
  };
  const fail = (code: string, message: string, field = '', exit = 1): never => reply({ ok: false, errors: [{ code, field, message }] }, exit);

  const readModel = (file: string | undefined): { text: string; bytes: Buffer } => {
    if (!file) return fail('E_SCHEMA_INVALID', 'give the model file path', '', 2);
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      return fail('E_NOT_FOUND', 'the model file cannot be read', '', 2);
    }
    return { text: bytes.toString('utf8'), bytes };
  };

  const runtimeState = (): Record<string, unknown> => {
    try {
      const e = deps.resolveEngine();
      return { installed: true, version: e.expectedVersion, installId: e.runtime?.install_id ?? null };
    } catch (err) {
      return { installed: false, code: err instanceof RuntimeNotInstalledError ? err.code : 'E_RUNTIME', message: (err as Error).message };
    }
  };

  const describe = (): never =>
    reply(
      {
        ok: true,
        engine: { name: 'sneed-headless', version: HEADLESS_VERSION, backend: 'SCRAM' },
        scram: runtimeState(),
        modelFormat: { format: 'sneed.fault-tree', version: '1' },
        methods: METHODS,
        capabilities: ['exact', 'rare-event', 'mcub', 'k-of-n', 'minimal-cut-sets'],
        parameters: [{ id: 'event.probability', type: 'number', unit: '1', min: 0, max: 1 }],
        quantities: [
          { name: 'top_event_probability', unit: '1', normalization: 'none' },
          { name: 'minimal_cut_sets', unit: '1', normalization: 'none' },
          { name: 'approximation_value', unit: '1', normalization: 'none' },
        ],
        meaning: MEANING,
      },
      0,
    );

  const validate = (args: string[]): never => {
    const { text } = readModel(args[0]);
    const v = validateModelText(text);
    if (!v.valid) return reply({ ok: false, errors: v.errors.map(typed), warnings: v.warnings.map(warnTyped) }, 2);
    return reply({ ok: true, warnings: v.warnings.map(warnTyped) }, 0);
  };

  const run = async (args: string[]): Promise<never> => {
    const { text, bytes } = readModel(args[0]);
    const outDir = option(args, '--out');
    if (!outDir || !path.isAbsolute(outDir)) return fail('E_PATH_INVALID', '--out must be an absolute folder', '', 2);
    const runId = option(args, '--run-id') ?? 'pra';
    if (!RUN_ID.test(runId)) return fail('E_PATH_INVALID', '--run-id is not a plain id', '', 2);
    const method = (option(args, '--method') ?? 'exact') as Method;
    if (!METHODS.includes(method)) return fail('E_UNSUPPORTED', `--method must be one of ${METHODS.join(', ')}`, '', 2);
    const limitRaw = option(args, '--limit-order');
    const limitOrder = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limitOrder !== undefined && (!Number.isInteger(limitOrder) || limitOrder < 1 || limitOrder > 1000)) return fail('E_BOUNDS_EXCEEDED', '--limit-order must be an integer from 1 to 1000', '', 2);
    const timeoutSeconds = Number(option(args, '--timeout-seconds') ?? '60');
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 86400) return fail('E_BOUNDS_EXCEEDED', '--timeout-seconds must be 10 to 86400', '', 2);

    const v = validateModelText(text);
    if (!v.valid) return reply({ ok: false, errors: v.errors.map(typed), warnings: v.warnings.map(warnTyped) }, 2);
    let engine: EngineConfig;
    try {
      engine = deps.resolveEngine();
    } catch (e) {
      return fail(e instanceof RuntimeNotInstalledError ? e.code : 'E_SETUP_REQUIRED', (e as Error).message);
    }
    const finalDir = path.join(outDir, runId);
    if (existsSync(finalDir)) return fail('E_EXISTS', 'the output folder already exists');
    const workRoot = path.join(outDir, 'work');
    mkdirSync(workRoot, { recursive: true });

    // a separate process (cancel) finds the engine run through this file. Keep this write synchronous and directly before
    // analyze(): the engine is only started after validation, export and the identity check, all after this record exists,
    // so no engine process can exist without a record the cancel verb can find.
    const workId = deps.newWorkId();
    const workDir = path.join(workRoot, workId);
    writeFileSync(path.join(outDir, 'active-run.json'), JSON.stringify({ workId, workDir }, null, 2) + '\n');

    const abort = new AbortController();
    const flag = path.join(outDir, 'cancel.requested');
    const timer = setInterval(() => {
      if (existsSync(flag)) abort.abort();
    }, deps.pollMs);
    let outcome: AnalyzeOutcome;
    try {
      outcome = await deps.analyze(text, { runsDir: workRoot, runId: workId, settings: { method, ...(limitOrder !== undefined ? { limitOrder } : {}) }, timeoutMs: timeoutSeconds * 1000, signal: abort.signal, engine });
    } catch (e) {
      if (e instanceof RangeError) return fail('E_BOUNDS_EXCEEDED', e.message, '', 2);
      return fail('E_APP_FAILED', `the analysis failed: ${(e as Error).message}`);
    } finally {
      clearInterval(timer);
    }
    if (outcome.kind === 'refused') return reply({ ok: false, errors: outcome.errors.map(typed), warnings: outcome.warnings.map(warnTyped) }, 2);

    const rec = outcome.record;
    if (rec.status !== 'completed' || rec.completeness !== 'complete') {
      // never a result: nothing is written into the run folder, the reason travels in the reply
      return reply({ ok: true, status: rec.status, completeness: rec.completeness, reason: rec.reasons.join(', ') || `the run ended ${rec.status}`, workId }, 0);
    }
    mkdirSync(finalDir, { recursive: true });
    const files: Record<string, string | Buffer> = { 'model.json': bytes, 'results.json': JSON.stringify(rec, null, 2) + '\n' };
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(finalDir, name), content);
    const manifest = {
      format: 'sneed-headless-run',
      version: 1,
      status: 'completed',
      workId,
      engine: { name: rec.engine.name, version: rec.engine.version, sha256: rec.engine.sha256, runtime: rec.engine.runtime },
      method: rec.method,
      modelSha256: sha256(bytes),
      modelHash: rec.input_hashes.model_hash,
      files: Object.keys(files).map((p) => ({ path: p, sha256: sha256(readFileSync(path.join(finalDir, p))) })),
    };
    writeFileSync(path.join(finalDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return reply({ ok: true, status: 'completed', runId, workId }, 0);
  };

  const cancel = async (args: string[]): Promise<never> => {
    const outDir = option(args, '--out');
    if (!outDir || !path.isAbsolute(outDir)) return fail('E_PATH_INVALID', '--out must be an absolute folder', '', 2);
    let active: { workId?: unknown; workDir?: unknown };
    try {
      active = JSON.parse(readFileSync(path.join(outDir, 'active-run.json'), 'utf8')) as typeof active;
    } catch {
      return reply({ ok: true, cancelled: false, detail: 'no active run is recorded in this folder' }, 0);
    }
    const expected = typeof active.workId === 'string' ? path.join(outDir, 'work', active.workId) : '';
    if (typeof active.workId !== 'string' || !WORK_ID.test(active.workId) || active.workDir !== expected) return fail('E_NOT_OWNED', 'active-run.json does not describe a run of this folder');
    // Ask the running process to stop itself (it records a cancelled run), then make sure no engine process of this run is left.
    writeFileSync(path.join(outDir, 'cancel.requested'), 'cancel\n');
    const tag = toWslPath(expected);
    const distro = deps.distro();
    // The run process may start its engine just after this kill (it stops itself within one poll of the flag), so kill and
    // look again until nothing is left or the settle time is up; only then is an engine reported as still alive.
    let alive = true;
    for (let waited = 0; ; waited += 300) {
      deps.killOwned(distro, tag);
      alive = deps.hasOwned(distro, tag);
      if (!alive || waited >= deps.settleMs) break;
      await deps.sleep(300);
    }
    return reply({ ok: true, cancelled: true, nativeStopped: !alive, detail: alive ? 'an engine process of this run is still alive' : 'no engine process of this run remains' }, 0);
  };

  try {
    const [verb, ...args] = argv;
    if (verb === 'describe') describe();
    else if (verb === 'validate') validate(args);
    else if (verb === 'run') await run(args);
    else if (verb === 'cancel') await cancel(args);
    else fail('E_VERB_UNKNOWN', 'verbs: describe, validate, run, cancel', '', 2);
    return 1; // unreachable: every branch replies
  } catch (e) {
    if (e instanceof Reply) return e.code;
    deps.write(JSON.stringify({ ok: false, errors: [{ code: 'E_INTERNAL', field: '', message: 'the runner failed unexpectedly' }] }) + '\n');
    return 1;
  }
}

// run as a program (not when imported by a test)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

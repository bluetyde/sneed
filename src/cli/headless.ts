// SNEED headless runner: the entry point other programs (the SEED adapter, docs/plans/11-seed-adapter.md) use.
// One JSON object on stdout, nothing else.
//
//   node dist/node/cli/headless.js describe
//   node dist/node/cli/headless.js validate <model.json>
//   node dist/node/cli/headless.js run <model.json> --out <absDir> [--run-id pra] [--method exact|rare-event|mcub]
//                                      [--engine builtin|scram] [--limit-order N] [--timeout-seconds 60]
//   The default engine is the built-in one; the environment variable SNEED_ENGINE=scram makes SCRAM the default for a caller that
//   has not been updated (an explicit --engine always wins).
//   node dist/node/cli/headless.js cancel --out <absDir>
//
// Event trees (plan 13), additive: the verbs above, their outputs and the fields of `describe` are unchanged.
//   node dist/node/cli/headless.js describe-event-trees
//   node dist/node/cli/headless.js validate-event-tree <tree.json> --model <model.json>
//   node dist/node/cli/headless.js run-event-tree <tree.json> --model <model.json> --out <absDir> [--run-id et]
//                                                 [--approximation] [--timeout-seconds 60]
//   `cancel` stops a run-event-tree the same way it stops a run (same record, same flag).
//
// Exit codes: 0 a reply was produced (a run that ended truncated, failed or cancelled is exit 0 with that status and a
// reason, and writes no result), 2 the model or an argument was refused (ok:false with typed errors), 1 the runner
// itself failed (ok:false). A completed `run` writes <out>/<run-id>/{model.json, results.json, manifest.json}; the
// engine's own run folder (inputs, report, logs) stays under <out>/work/. The result is a probability under stated
// assumptions: not a frequency and not a plant risk figure.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { modelHash } from '../core/canonical.js';
import { eventTreeHash, validateEventTreeText } from '../core/event-tree.js';
import { MAX_HEADINGS, MAX_SEQUENCES } from '../core/event-tree-paths.js';
import type { NativeModel } from '../core/model.js';
import { analyzeEventTreeBuiltin as realEventTree, type EventTreeOutcome, type EventTreeRunOptions } from '../engines/bdd/event-tree-analyze.js';
import { analyze as realAnalyze, type AnalyzeOptions, type AnalyzeOutcome } from '../core/analyze.js';
import { analyzeBuiltin as realBuiltin, type BuiltinOptions } from '../engines/bdd/analyze.js';
import { BDD_ENGINE_NAME, BDD_ENGINE_VERSION } from '../engines/bdd/solve.js';
import { BDD_SOURCE_SHA256 } from '../engines/bdd/build-id.js';
import { hasOwned as realHasOwned, killOwned as realKillOwned, toWslPath, type EngineConfig } from '../core/engine.js';
import type { Method } from '../core/model.js';
import { validateModelText, type Issue } from '../core/validate.js';
import { defaultRuntimeEnv, resolveEngine as realResolveEngine, RuntimeNotInstalledError } from '../runtime/resolve.js';

export const HEADLESS_VERSION = '0.1.0';
/** The largest event-tree or model file the event-tree verbs read. */
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const ET_MEANING = 'A frequency per year for each sequence and each end state of an event tree, under the stated assumptions (one initiating event of constant frequency, independent basic events of constant probability per demand, binary headings). Not a probability of failure and not a plant risk figure; end states are named by the author.';
export const MEANING = 'A probability that the top event occurs under the stated assumptions (constant probabilities, independent basic events). Not a frequency and not a plant risk figure.';
const METHODS: Method[] = ['exact', 'rare-event', 'mcub'];
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ACTIVE = 'active-run.json';
const CANCEL_FLAG = 'cancel.requested';
/** analyze() wants at least 8 characters of [A-Za-z0-9_-] for its own run folder name. */
const WORK_ID = /^pra-[0-9a-f]{12}$/;

/** What the runner needs from the outside, replaceable in tests. */
export interface Deps {
  analyze: (text: string, opts: AnalyzeOptions) => Promise<AnalyzeOutcome>;
  /** The engine used when --engine is not given: the built-in one, unless SNEED_ENGINE=scram. */
  defaultEngine: () => 'builtin' | 'scram';
  /** The built-in decision-diagram engine (`--engine builtin`). */
  analyzeBuiltin: (text: string, opts: BuiltinOptions) => Promise<AnalyzeOutcome>;
  /** The built-in event-tree analysis (`run-event-tree`). */
  analyzeEventTree: (treeText: string, modelText: string, opts: EventTreeRunOptions) => Promise<EventTreeOutcome>;
  resolveEngine: () => EngineConfig;
  distro: () => string;
  killOwned: (distro: string, tag: string) => void;
  hasOwned: (distro: string, tag: string) => boolean;
  /** Write one line to stdout. */
  write: (line: string) => void;
  newWorkId: () => string;
  pollMs: number;
  /** Is a process with this id alive (the run process that wrote the record). */
  pidAlive: (pid: number) => boolean;
  /** Test seam: called with the staging folder after its files are written and before it is checked and published. */
  afterStage?: (staging: string) => void;
  /** How long cancel keeps killing and checking before it reports an engine process as still alive. */
  settleMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const realDeps = (): Deps => ({
  analyze: realAnalyze,
  analyzeBuiltin: realBuiltin,
  analyzeEventTree: realEventTree,
  defaultEngine: () => (process.env.SNEED_ENGINE === 'scram' ? 'scram' : 'builtin'),
  resolveEngine: () => realResolveEngine(defaultRuntimeEnv()),
  distro: () => defaultRuntimeEnv().distro,
  killOwned: realKillOwned,
  hasOwned: realHasOwned,
  write: (line) => void process.stdout.write(line),
  newWorkId: () => `pra-${createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 12)}`,
  pollMs: 250,
  pidAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, not ours
    }
  },
  settleMs: 5000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

/** 'none' when nothing is there; a link is its own kind because it must never be followed. Does not follow links. */
function entryKind(p: string): 'none' | 'link' | 'other' {
  try {
    return lstatSync(p).isSymbolicLink() ? 'link' : 'other';
  } catch {
    return 'none';
  }
}
const isLink = (p: string): boolean => entryKind(p) === 'link';
/** The real location of `child` lies inside the real location of `root` (a junction or symlink pointing elsewhere fails). */
function isInside(root: string, child: string): boolean {
  try {
    const r = realpathSync(root);
    const c = realpathSync(child);
    return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  } catch {
    return false;
  }
}
const readFlag = (file: string): string | null => {
  try {
    if (isLink(file)) return null;
    return readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
};
const activeText = (o: Record<string, unknown>): string => JSON.stringify(o, null, 2) + '\n';
/** Write beside the target and rename over it: a link in the target's place is replaced, never written through. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, text, { flag: 'wx' });
  renameSync(tmp, file);
}

/** Thrown when what is about to be published is no longer the plain folder this run made. Never cleaned up: it is not ours. */
class Unsafe extends Error {}

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

  /** `--out` and `--run-id` of a run that owns its output folder. */
  const ownedTarget = (args: string[], defaultId: string): { outDir: string; runId: string } => {
    const outDir = option(args, '--out');
    if (!outDir || !path.isAbsolute(outDir)) return fail('E_PATH_INVALID', '--out must be an absolute folder', '', 2);
    const runId = option(args, '--run-id') ?? defaultId;
    if (!RUN_ID.test(runId)) return fail('E_PATH_INVALID', '--run-id is not a plain id', '', 2);
    return { outDir, runId };
  };
  const timeoutOption = (args: string[]): number => {
    const timeoutSeconds = Number(option(args, '--timeout-seconds') ?? '60');
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 86400) return fail('E_BOUNDS_EXCEEDED', '--timeout-seconds must be 10 to 86400', '', 2);
    return timeoutSeconds;
  };

  /** A file argument of the event-tree verbs: refused (exit 2) when missing, unreadable or larger than the limit. */
  const readInput = (file: string | undefined, what: string): { text: string; bytes: Buffer } => {
    if (!file) return fail('E_SCHEMA_INVALID', `give the ${what} path`, '', 2);
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      return fail('E_NOT_FOUND', `the ${what} cannot be read`, '', 2);
    }
    if (bytes.length > MAX_INPUT_BYTES) return fail('E_BOUNDS_EXCEEDED', `the ${what} is larger than ${MAX_INPUT_BYTES} bytes`, '', 2);
    return { text: bytes.toString('utf8'), bytes };
  };

  /** Checks an event tree against the fault-tree model file it is given: exit 2 with typed errors unless both are valid and the tree names this model. */
  const checkEventTree = (treeText: string, modelText: string): { tree_hash: string; warnings: Typed[] } => {
    const mv = validateModelText(modelText);
    if (!mv.valid) return reply({ ok: false, errors: mv.errors.map((e) => typed({ ...e, path: `model${e.path === '/' ? '' : e.path}` })), warnings: [] }, 2);
    const model = JSON.parse(modelText) as NativeModel;
    let named = '';
    try {
      named = String((JSON.parse(treeText) as { fault_tree_model?: { name?: unknown } }).fault_tree_model?.name ?? '');
    } catch {
      /* not JSON: the validator says so */
    }
    const ref = { hash: modelHash(model), events: new Set(model.events.map((e) => e.id)), gates: new Set(model.gates.map((g) => g.id)) };
    const v = validateEventTreeText(treeText, { resolveModel: (n) => (n === named ? ref : null) });
    if (!v.valid) return reply({ ok: false, errors: v.errors.map(typed), warnings: v.warnings.map(typed) }, 2);
    let tree_hash: string;
    try {
      tree_hash = eventTreeHash(JSON.parse(treeText));
    } catch {
      return reply({ ok: false, errors: [{ code: 'E_SCHEMA_INVALID', field: '', message: 'the event tree could not be reduced to what it means', source: 'app-content' }], warnings: [] }, 2);
    }
    return { tree_hash, warnings: v.warnings.map(typed) };
  };

  const describeEventTrees = (): never =>
    reply(
      {
        ok: true,
        documentFormat: { format: 'sneed.event-tree', version: '1' },
        modelFormat: { format: 'sneed.fault-tree', version: '1' },
        resultFormat: { format: 'sneed.event-tree-result', version: '1' },
        engine: { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION, sha256: BDD_SOURCE_SHA256, runtime: null },
        limits: { headings: MAX_HEADINGS, sequences: MAX_SEQUENCES },
        options: ['--approximation'],
        quantities: [
          { name: 'sequence_frequency', unit: 'per-year', normalization: 'none' },
          { name: 'end_state_frequency', unit: 'per-year', normalization: 'none' },
        ],
        meaning: ET_MEANING,
      },
      0,
    );

  const validateEventTreeVerb = (args: string[]): never => {
    const tree = readInput(args[0], 'event-tree file');
    const model = readInput(option(args, '--model'), 'fault-tree model file');
    const c = checkEventTree(tree.text, model.text);
    return reply({ ok: true, treeHash: c.tree_hash, warnings: c.warnings }, 0);
  };

  const describe = (): never =>
    reply(
      {
        ok: true,
        engine: { name: 'sneed-headless', version: HEADLESS_VERSION, backend: 'SCRAM' },
        // `--engine builtin` (the default) needs nothing; `--engine scram` needs the installed runtime. SNEED_ENGINE=scram changes the default.
        engines: { default: deps.defaultEngine(), scram: runtimeState(), builtin: { available: true, name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION, sha256: BDD_SOURCE_SHA256 } },
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

  /** What an analysis hands back to the owned run: refused with typed errors, or finished with a status and the files to publish. */
  type Outcome =
    | { kind: 'refused'; errors: Typed[]; warnings: Typed[] }
    | { kind: 'ran'; status: string; completeness: string; reasons: string[]; files: Record<string, string | Buffer>; manifest: (hashes: { path: string; sha256: string }[]) => Record<string, unknown> };

  /**
   * What `run` and `run-event-tree` share: the output folder belongs to ONE run (a record created exclusively before the analysis can start, a
   * cancel flag only this run obeys, nothing existing reused, followed or replaced, a result published atomically and only when complete).
   * `start` is the analysis itself.
   */
  const runOwned = async (outDir: string, runId: string, timeoutSeconds: number, start: (workRoot: string, workId: string, signal: AbortSignal) => Promise<Outcome>): Promise<never> => {
    // The folder belongs to this one run. Nothing already in it is reused, followed or replaced: a result folder, a cancel
    // request or a work folder that is already there (or is a link) refuses the run before anything is written.
    const finalDir = path.join(outDir, runId);
    const workRoot = path.join(outDir, 'work');
    const activeFile = path.join(outDir, ACTIVE);
    const flag = path.join(outDir, CANCEL_FLAG);
    for (const p of [finalDir, workRoot, flag]) {
      if (entryKind(p) !== 'none') return fail(isLink(p) ? 'E_PATH_TRAVERSAL' : 'E_EXISTS', `${path.basename(p)} already exists in the output folder`);
    }
    // a separate process (cancel) finds the engine run through this record. It is created exclusively (a second run in the same
    // folder, or a link in its place, is refused) and before the engine can start: the engine is only launched after validation,
    // export and the identity check, all after this record exists, so no engine process can exist without a record cancel can find.
    const workId = deps.newWorkId();
    const workDir = path.join(workRoot, workId);
    try {
      mkdirSync(outDir, { recursive: true });
    } catch {
      return fail('E_APP_FAILED', 'the output folder cannot be created');
    }
    try {
      writeFileSync(activeFile, activeText({ workId, workDir, pid: process.pid, state: 'running' }), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return fail(isLink(activeFile) ? 'E_PATH_TRAVERSAL' : 'E_EXISTS', 'this output folder already holds a run record');
      return fail('E_APP_FAILED', 'the run record could not be created');
    }
    let ended = 'failed';
    try {
      try {
        mkdirSync(workRoot);
      } catch {
        return fail('E_EXISTS', 'the work folder already exists');
      }
      if (isLink(workRoot) || !isInside(outDir, workRoot)) return fail('E_PATH_TRAVERSAL', 'the work folder resolves outside the output folder');

      const abort = new AbortController();
      const timer = setInterval(() => {
        if (readFlag(flag) === workId) abort.abort(); // only a request made for THIS run counts
      }, deps.pollMs);
      let outcome: Outcome;
      try {
        outcome = await start(workRoot, workId, abort.signal);
      } catch (e) {
        if (e instanceof RangeError) return fail('E_BOUNDS_EXCEEDED', e.message, '', 2);
        return fail('E_APP_FAILED', `the analysis failed: ${(e as Error).message}`);
      } finally {
        clearInterval(timer);
      }
      if (outcome.kind === 'refused') {
        ended = 'refused';
        return reply({ ok: false, errors: outcome.errors, warnings: outcome.warnings }, 2);
      }

      ended = outcome.status;
      if (outcome.status !== 'completed' || outcome.completeness !== 'complete') {
        // never a result: nothing is written into the run folder, the reason travels in the reply
        return reply({ ok: true, status: outcome.status, completeness: outcome.completeness, reason: outcome.reasons.join(', ') || `the run ended ${outcome.status}`, workId }, 0);
      }
      // publish atomically: build the result folder beside the destination, then rename it into place (never a half-written result)
      const staging = path.join(outDir, `.${runId}.tmp-${workId.slice(4)}`);
      let stagingOwned = false; // only a folder this invocation created is ever deleted
      try {
        mkdirSync(staging);
        stagingOwned = true;
        const files = outcome.files;
        for (const [name, content] of Object.entries(files)) writeFileSync(path.join(staging, name), content, { flag: 'wx' });
        const manifest = outcome.manifest(Object.keys(files).map((p) => ({ path: p, sha256: sha256(readFileSync(path.join(staging, p))) })));
        writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
        deps.afterStage?.(staging);
        // what is about to be published must still be the folder made above: not a link, inside the output folder, and every
        // file really inside it. (A concurrent replacement between this check and the rename is a documented limit.)
        if (isLink(staging) || !isInside(outDir, staging) || [...Object.keys(outcome.files), 'manifest.json'].some((f) => !isInside(staging, path.join(staging, f)))) throw new Unsafe();
        if (entryKind(finalDir) !== 'none') throw new Error('exists');
        renameSync(staging, finalDir);
      } catch (e) {
        ended = 'failed'; // decided before any cleanup, so a cleanup error cannot leave the record saying "completed"
        if (stagingOwned && !(e instanceof Unsafe)) {
          try {
            rmSync(staging, { recursive: true, force: true });
          } catch {
            /* the folder stays; the reply below still says the result was not written */
          }
        }
        if (e instanceof Unsafe) return fail('E_PATH_TRAVERSAL', 'the result folder was replaced while it was being written, so nothing was published');
        const taken = entryKind(finalDir) !== 'none';
        return fail(taken ? 'E_EXISTS' : 'E_APP_FAILED', taken ? 'the output folder already exists' : 'the result could not be written');
      }
      return reply({ ok: true, status: 'completed', runId, workId }, 0);
    } finally {
      // retire the record so a later cancel knows this run is over (best effort: a run that dies leaves it as "running")
      try {
        writeAtomic(activeFile, activeText({ workId, workDir, pid: process.pid, state: 'ended', status: ended }));
      } catch {
        /* the reply is already decided */
      }
    }
  };

  const run = async (args: string[]): Promise<never> => {
    const { text, bytes } = readModel(args[0]);
    const { outDir, runId } = ownedTarget(args, 'pra');
    const method = (option(args, '--method') ?? 'exact') as Method;
    if (!METHODS.includes(method)) return fail('E_UNSUPPORTED', `--method must be one of ${METHODS.join(', ')}`, '', 2);
    const engineChoice = option(args, '--engine') ?? deps.defaultEngine();
    if (engineChoice !== 'scram' && engineChoice !== 'builtin') return fail('E_UNSUPPORTED', '--engine must be scram or builtin', '', 2);
    const limitRaw = option(args, '--limit-order');
    const limitOrder = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limitOrder !== undefined && (!Number.isInteger(limitOrder) || limitOrder < 1 || limitOrder > 1000)) return fail('E_BOUNDS_EXCEEDED', '--limit-order must be an integer from 1 to 1000', '', 2);
    const timeoutSeconds = timeoutOption(args);

    const v = validateModelText(text);
    if (!v.valid) return reply({ ok: false, errors: v.errors.map(typed), warnings: v.warnings.map(warnTyped) }, 2);
    let engine: EngineConfig | null = null;
    if (engineChoice === 'scram') {
      try {
        engine = deps.resolveEngine();
      } catch (e) {
        return fail(e instanceof RuntimeNotInstalledError ? e.code : 'E_SETUP_REQUIRED', (e as Error).message);
      }
    }

    return runOwned(outDir, runId, timeoutSeconds, async (workRoot, workId, signal) => {
      const common = { runsDir: workRoot, runId: workId, settings: { method, ...(limitOrder !== undefined ? { limitOrder } : {}) }, timeoutMs: timeoutSeconds * 1000, signal };
      const outcome = engine === null ? await deps.analyzeBuiltin(text, common) : await deps.analyze(text, { ...common, engine });
      if (outcome.kind === 'refused') return { kind: 'refused', errors: outcome.errors.map(typed), warnings: outcome.warnings.map(warnTyped) };
      const rec = outcome.record;
      return {
        kind: 'ran',
        status: rec.status,
        completeness: rec.completeness,
        reasons: rec.reasons,
        files: { 'model.json': bytes, 'results.json': JSON.stringify(rec, null, 2) + '\n' },
        manifest: (hashes) => ({
          format: 'sneed-headless-run',
          version: 1,
          status: 'completed',
          workId,
          engine: { name: rec.engine.name, version: rec.engine.version, sha256: rec.engine.sha256, runtime: rec.engine.runtime },
          method: rec.method,
          modelSha256: sha256(bytes),
          modelHash: rec.input_hashes.model_hash,
          files: hashes,
        }),
      };
    });
  };

  const runEventTree = async (args: string[]): Promise<never> => {
    const tree = readInput(args[0], 'event-tree file');
    const model = readInput(option(args, '--model'), 'fault-tree model file');
    const { outDir, runId } = ownedTarget(args, 'et');
    const timeoutSeconds = timeoutOption(args);
    const approximation = args.includes('--approximation');
    checkEventTree(tree.text, model.text); // refused (exit 2) before any folder or record exists

    return runOwned(outDir, runId, timeoutSeconds, async (workRoot, workId, signal) => {
      const outcome = await deps.analyzeEventTree(tree.text, model.text, { runsDir: workRoot, runId: workId, timeoutMs: timeoutSeconds * 1000, signal, approximation });
      if (outcome.kind === 'refused') return { kind: 'refused', errors: outcome.errors.map(typed), warnings: outcome.warnings.map(typed) };
      const rec = outcome.record;
      return {
        kind: 'ran',
        status: rec.status,
        completeness: rec.completeness,
        reasons: rec.reasons,
        files: { 'event-tree.json': tree.bytes, 'model.json': model.bytes, 'event-tree-results.json': JSON.stringify(rec, null, 2) + '\n' },
        manifest: (hashes) => ({
          format: 'sneed-headless-event-tree-run',
          version: 1,
          status: 'completed',
          workId,
          engine: { name: rec.engine.name, version: rec.engine.version, sha256: rec.engine.sha256, runtime: rec.engine.runtime },
          quantity: rec.quantity,
          unit: rec.unit,
          approximation: rec.approximation !== null,
          treeSha256: sha256(tree.bytes),
          modelSha256: sha256(model.bytes),
          treeHash: rec.input_hashes.tree_hash,
          modelHash: rec.input_hashes.model_hash,
          files: hashes,
        }),
      };
    });
  };

  const cancel = async (args: string[]): Promise<never> => {
    const outDir = option(args, '--out');
    if (!outDir || !path.isAbsolute(outDir)) return fail('E_PATH_INVALID', '--out must be an absolute folder', '', 2);
    const activeFile = path.join(outDir, ACTIVE);
    const read = (): { workId: string; workDir: string; pid: number; state: string; status?: string } => {
      if (isLink(activeFile)) return fail('E_NOT_OWNED', 'active-run.json is a link');
      let raw: string;
      try {
        raw = readFileSync(activeFile, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return reply({ ok: true, cancelled: false, detail: 'no active run is recorded in this folder' }, 0);
        return fail('E_NOT_OWNED', 'active-run.json cannot be read, so nothing was stopped');
      }
      let a: Record<string, unknown>;
      try {
        a = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return fail('E_NOT_OWNED', 'active-run.json is not valid JSON, so nothing was stopped');
      }
      const expected = typeof a.workId === 'string' ? path.join(outDir, 'work', a.workId) : '';
      if (typeof a.workId !== 'string' || !WORK_ID.test(a.workId) || a.workDir !== expected || !Number.isInteger(a.pid) || (a.pid as number) < 1 || (a.state !== 'running' && a.state !== 'ended')) {
        return fail('E_NOT_OWNED', 'active-run.json does not describe a run of this folder');
      }
      return { workId: a.workId, workDir: expected, pid: a.pid as number, state: a.state, ...(typeof a.status === 'string' ? { status: a.status } : {}) };
    };
    const rec = read();
    if (rec.state === 'ended') return reply({ ok: true, cancelled: false, detail: `the run already ended (${rec.status ?? 'unknown'})` }, 0);

    // Ask the running process to stop itself (it records a cancelled run), then make sure no engine process of this run is left.
    writeAtomic(path.join(outDir, CANCEL_FLAG), rec.workId);
    const tag = toWslPath(rec.workDir);
    const distro = deps.distro();
    // The run process may start its engine just after a kill (it stops itself within one poll of the flag), so kill and look
    // again until the engine is gone AND the run process has ended or retired its record; only then is a stop confirmed.
    let confirmed = false;
    let probeFailed = false;
    for (let waited = 0; ; waited += 300) {
      deps.killOwned(distro, tag);
      let owned = true;
      try {
        owned = deps.hasOwned(distro, tag);
        probeFailed = false;
      } catch {
        probeFailed = true; // the state of the engine is not known
      }
      const retired = (() => {
        try {
          if (isLink(activeFile)) return false;
          const r = JSON.parse(readFileSync(activeFile, 'utf8')) as Record<string, unknown>;
          // only this run's own record, retired by this run, counts (another record in its place confirms nothing)
          return r.state === 'ended' && r.workId === rec.workId && r.workDir === rec.workDir && r.pid === rec.pid;
        } catch {
          return false;
        }
      })();
      confirmed = !probeFailed && !owned && (retired || !deps.pidAlive(rec.pid));
      if (confirmed || waited >= deps.settleMs) break;
      await deps.sleep(300);
    }
    return reply({ ok: true, cancelled: true, nativeStopped: confirmed, detail: confirmed ? 'no engine process of this run remains and the run has ended' : probeFailed ? 'the engine state could not be checked' : 'the engine or the run process of this run is still alive' }, 0);
  };

  try {
    const [verb, ...args] = argv;
    if (verb === 'describe') describe();
    else if (verb === 'validate') validate(args);
    else if (verb === 'run') await run(args);
    else if (verb === 'cancel') await cancel(args);
    else if (verb === 'describe-event-trees') describeEventTrees();
    else if (verb === 'validate-event-tree') validateEventTreeVerb(args);
    else if (verb === 'run-event-tree') await runEventTree(args);
    else fail('E_VERB_UNKNOWN', 'verbs: describe, validate, run, cancel, describe-event-trees, validate-event-tree, run-event-tree', '', 2);
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

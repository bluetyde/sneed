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
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const ACTIVE = 'active-run.json';
const CANCEL_FLAG = 'cancel.requested';
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
  /** Is a process with this id alive (the run process that wrote the record). */
  pidAlive: (pid: number) => boolean;
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
      writeFileSync(activeFile, activeText({ workId, workDir, pid: process.pid, state: 'running' }), { flag: 'wx' });
    } catch {
      return fail(isLink(activeFile) ? 'E_PATH_TRAVERSAL' : 'E_EXISTS', 'this output folder already holds a run record');
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
      let outcome: AnalyzeOutcome;
      try {
        outcome = await deps.analyze(text, { runsDir: workRoot, runId: workId, settings: { method, ...(limitOrder !== undefined ? { limitOrder } : {}) }, timeoutMs: timeoutSeconds * 1000, signal: abort.signal, engine });
      } catch (e) {
        if (e instanceof RangeError) return fail('E_BOUNDS_EXCEEDED', e.message, '', 2);
        return fail('E_APP_FAILED', `the analysis failed: ${(e as Error).message}`);
      } finally {
        clearInterval(timer);
      }
      if (outcome.kind === 'refused') {
        ended = 'refused';
        return reply({ ok: false, errors: outcome.errors.map(typed), warnings: outcome.warnings.map(warnTyped) }, 2);
      }

      const rec = outcome.record;
      ended = rec.status;
      if (rec.status !== 'completed' || rec.completeness !== 'complete') {
        // never a result: nothing is written into the run folder, the reason travels in the reply
        return reply({ ok: true, status: rec.status, completeness: rec.completeness, reason: rec.reasons.join(', ') || `the run ended ${rec.status}`, workId }, 0);
      }
      // publish atomically: build the result folder beside the destination, then rename it into place (never a half-written result)
      const staging = path.join(outDir, `.${runId}.tmp-${workId.slice(4)}`);
      try {
        mkdirSync(staging);
        const files: Record<string, string | Buffer> = { 'model.json': bytes, 'results.json': JSON.stringify(rec, null, 2) + '\n' };
        for (const [name, content] of Object.entries(files)) writeFileSync(path.join(staging, name), content, { flag: 'wx' });
        const manifest = {
          format: 'sneed-headless-run',
          version: 1,
          status: 'completed',
          workId,
          engine: { name: rec.engine.name, version: rec.engine.version, sha256: rec.engine.sha256, runtime: rec.engine.runtime },
          method: rec.method,
          modelSha256: sha256(bytes),
          modelHash: rec.input_hashes.model_hash,
          files: Object.keys(files).map((p) => ({ path: p, sha256: sha256(readFileSync(path.join(staging, p))) })),
        };
        writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
        if (entryKind(finalDir) !== 'none') throw new Error('exists');
        renameSync(staging, finalDir);
      } catch {
        rmSync(staging, { recursive: true, force: true });
        ended = 'failed';
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
          return (JSON.parse(readFileSync(activeFile, 'utf8')) as { state?: unknown }).state === 'ended';
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

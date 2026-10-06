// Runs the solver in a worker thread with a hard time limit, a memory limit and a cancel that works while it computes.
// The parent's event loop is never blocked: an HTTP cancel, a disconnect or the headless runner's cancel poll are all heard.
import { Worker } from 'node:worker_threads';
import type { NativeModel } from '../../core/model.js';
import type { BddLimits } from './bdd.js';
import type { WorkerInput, WorkerMessage } from './worker.js';

export type IsolatedResult = WorkerMessage;

export interface IsolatedOptions {
  order?: string[];
  limits?: Partial<BddLimits>;
  /** Milliseconds the solver may take. The thread is terminated shortly after, whatever it is doing. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Old-generation heap limit of the worker in megabytes (default 1024). A model that needs more ends as too-much-memory. */
  memoryMb?: number;
}

const GRACE_MS = 500;

/** Under tsx or a test runner the worker is the .ts file and needs the loader; built (dist) it is plain JavaScript. */
function workerTarget(): { url: URL; execArgv: string[] } {
  const ts = import.meta.url.endsWith('.ts');
  return { url: new URL(ts ? './worker.ts' : './worker.js', import.meta.url), execArgv: ts ? ['--import', 'tsx'] : [] };
}

export function solveIsolated(model: NativeModel, opts: IsolatedOptions): Promise<IsolatedResult> {
  const { url, execArgv } = workerTarget();
  const data: WorkerInput = { model, ...(opts.order ? { order: opts.order } : {}), ...(opts.limits ? { limits: opts.limits } : {}), timeoutMs: opts.timeoutMs };
  return new Promise((resolve) => {
    if (opts.signal?.aborted) return resolve({ ok: false, why: 'cancelled' });
    let done = false;
    const w = new Worker(url, { workerData: data, execArgv, resourceLimits: { maxOldGenerationSizeMb: opts.memoryMb ?? 1024, stackSizeMb: 8 } });
    const finish = (r: IsolatedResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      void w.terminate();
      resolve(r);
    };
    const onAbort = (): void => finish({ ok: false, why: 'cancelled' });
    const timer = setTimeout(() => finish({ ok: false, why: 'timeout' }), opts.timeoutMs + GRACE_MS);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    w.once('message', (m: WorkerMessage) => finish(m));
    w.once('error', (e: Error & { code?: string }) => finish({ ok: false, why: e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'too-much-memory' : 'internal' }));
    w.once('exit', () => finish({ ok: false, why: 'internal' })); // the thread ended without an answer
  });
}

// The solver's thread. The analysis runs here so that the caller's event loop stays free to hear a cancel, and so that a hostile or
// huge model can be stopped by a time limit and a memory limit that the operating system enforces (a worker is terminated, not asked).
import { parentPort, workerData } from 'node:worker_threads';
import type { NativeModel } from '../../core/model.js';
import type { BddLimits } from './bdd.js';
import { SolveAborted, solve, type Solution } from './solve.js';

export interface WorkerInput {
  model: NativeModel;
  order?: string[];
  limits?: Partial<BddLimits>;
  /** The solver's own cooperative time limit in milliseconds; the parent also terminates the thread, so this is a courtesy. */
  timeoutMs: number;
}
export type WorkerMessage = { ok: true; solution: Solution } | { ok: false; why: SolveAborted['why'] | 'internal' };

const input = workerData as WorkerInput;
const start = performance.now();
let message: WorkerMessage;
try {
  const solution = solve(input.model, {
    ...(input.order ? { order: input.order } : {}),
    ...(input.limits ? { limits: input.limits } : {}),
    tick: () => {
      if (performance.now() - start > input.timeoutMs) throw new SolveAborted('timeout');
    },
  });
  message = { ok: true, solution };
} catch (e) {
  message = { ok: false, why: e instanceof SolveAborted ? e.why : 'internal' }; // a stack overflow or a bug is "internal", never a number
}
parentPort!.postMessage(message);

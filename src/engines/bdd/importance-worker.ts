// The importance measures' thread: same reasons as worker.ts (a hostile model can be stopped by a time and a memory limit, and the
// caller's event loop stays free to hear a cancel).
import { parentPort, workerData } from 'node:worker_threads';
import type { NativeModel } from '../../core/model.js';
import type { BddLimits } from './bdd.js';
import { importance, type ImportanceResult } from './importance.js';
import { SolveAborted } from './solve.js';

export interface ImportanceWorkerInput {
  model: NativeModel;
  limits?: Partial<BddLimits>;
  timeoutMs: number;
}
export type ImportanceMessage = { ok: true; result: ImportanceResult } | { ok: false; why: SolveAborted['why'] | 'internal' };

const input = workerData as ImportanceWorkerInput;
const start = performance.now();
let message: ImportanceMessage;
try {
  message = {
    ok: true,
    result: importance(input.model, {
      ...(input.limits ? { limits: input.limits } : {}),
      tick: () => {
        if (performance.now() - start > input.timeoutMs) throw new SolveAborted('timeout');
      },
    }),
  };
} catch (e) {
  message = { ok: false, why: e instanceof SolveAborted ? e.why : 'internal' };
}
parentPort!.postMessage(message);

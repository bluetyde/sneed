// The event-tree analysis in its own thread: the same time limit, memory limit and cancel as the solver and the importance measures.
import { parentPort, workerData } from 'node:worker_threads';
import type { NativeModel } from '../../core/model.js';
import type { BddLimits } from './bdd.js';
import { computeEventTree, type EventTreeComputation, type EventTreeInput } from './event-tree.js';
import { SolveAborted } from './solve.js';

export interface EventTreeWorkerInput {
  model: NativeModel;
  tree: EventTreeInput;
  approximation: boolean;
  limits?: Partial<BddLimits>;
  timeoutMs: number;
}
export type EventTreeMessage = { ok: true; result: EventTreeComputation } | { ok: false; why: SolveAborted['why'] | 'internal' };

const input = workerData as EventTreeWorkerInput;
const start = performance.now();
let message: EventTreeMessage;
try {
  message = {
    ok: true,
    result: computeEventTree(input.model, input.tree, {
      approximation: input.approximation,
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

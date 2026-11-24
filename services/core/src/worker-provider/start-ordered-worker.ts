import type { JobRunId, WorkerHandle } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { abortableWait } from '@makaio/utils';
import { dispatchWinner, observeDispatch } from './dispatch-supervision.js';
import { decideStart, lockDispatch, ownsOrder } from './start-claim.js';
import type { StartOrderedWorker, StartWorkerResult, WorkerStartOptions } from './start-order.js';

/** Start and observation share local control of process-bound allocations. */
export interface WorkerDispatchService {
  readonly startOrderedWorker: StartOrderedWorker;
  /**
   * Revisit a claimed dispatch, including an outstanding duty after run end.
   * @param call - Authenticated run owner.
   * @param jobRunId - Durable dispatch to revisit.
   * @param signal - Cancels the caller's wait.
   */
  superviseOrderedWorker(call: CallContext, jobRunId: JobRunId, signal: AbortSignal): Promise<StartWorkerResult>;
}

/**
 * Compose ordered dispatch against the host source and provider registry.
 * @param host - Host database, sources and provider lifecycle.
 * @returns The in-process start port and observation-only supervision.
 */
export function createWorkerDispatch(host: WorkerStartOptions): WorkerDispatchService {
  const handles = new Map<JobRunId, WorkerHandle>();
  return {
    startOrderedWorker(call, order, signal) {
      signal.throwIfAborted();
      const work = decideStart(host, call, structuredClone(order)).then((decision) => {
        if (decision.kind === 'refused') return decision;
        if (decision.kind === 'observe') return observeDispatch(host, handles, call, decision);
        return dispatchWinner(host, handles, call, decision);
      });
      return abortableWait(work, signal);
    },
    superviseOrderedWorker(call, jobRunId, signal) {
      signal.throwIfAborted();
      const work = host.database
        .transaction((tx) => lockDispatch(tx, host, jobRunId))
        .then((current) => {
          if (current === undefined) return { kind: 'refused', reason: 'not-committed' } as const;
          if (!ownsOrder(call, current.order)) return { kind: 'refused', reason: 'binding-mismatch' } as const;
          return observeDispatch(host, handles, call, { ...current, kind: 'observe' });
        });
      return abortableWait(work, signal);
    },
  };
}

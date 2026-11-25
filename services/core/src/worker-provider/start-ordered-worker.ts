import type { WorkerDispatchCapability } from '@makaio/contracts/capabilities';
import { abortableWait, boundedWait } from '@makaio/utils';
import { AllocationObservationSignal } from './allocation-observation-signal.js';
import { dispatchWinner, observeDispatch, unresolved } from './dispatch-supervision.js';
import { prepareAllocationBinding } from './redemption-binding.js';
import { decideStart, lockDispatch, ownsOrder } from './start-claim.js';
import type { WorkerStartOptions } from './start-order.js';

/**
 * Compose ordered dispatch against the host source and provider registry.
 * @param host - Host database, sources and provider lifecycle.
 * @returns The in-process start port and observation-only supervision.
 */
export function createWorkerDispatch(host: WorkerStartOptions): WorkerDispatchCapability {
  if (!(host.allocationObservation instanceof AllocationObservationSignal)) {
    throw new TypeError('Worker dispatch requires a shared AllocationObservationSignal');
  }
  return Object.freeze<WorkerDispatchCapability>({
    prepareAllocationBinding(call, jobRunId, visibility) {
      host.operationSignal.throwIfAborted();
      return prepareAllocationBinding(host, call, jobRunId, visibility);
    },
    startOrderedWorker(call, order, signal) {
      signal.throwIfAborted();
      const drain = host.provisionDrain;
      if (drain !== undefined) {
        host.operationSignal.throwIfAborted();
        drain.closed.throwIfAborted();
      }
      const handoff = decideStart(host, call, structuredClone(order)).then((decision) => {
        if (decision.kind === 'refused') return decision;
        if (decision.kind === 'observe')
          return { outcome: observeDispatch(host, call, decision), remaining: undefined };
        return dispatchWinner(host, call, decision);
      });
      const work = handoff.then((result) => ('outcome' in result ? result.outcome : result));
      drain?.track(handoff, work);
      const caller = handoff.then(async (result) => {
        if (!('outcome' in result)) return result;
        if (result.remaining === undefined) return result.outcome;
        const timed = await boundedWait(result.outcome, result.remaining);
        return timed.settled ? timed.value : unresolved;
      });
      void work.catch(() => undefined);
      return abortableWait(caller, signal);
    },
    superviseOrderedWorker(call, jobRunId, signal) {
      signal.throwIfAborted();
      host.provisionDrain?.closed.throwIfAborted();
      const work = host.database
        .transaction((tx) => lockDispatch(tx, host, jobRunId))
        .then((current) => {
          if (current === undefined) return { kind: 'refused', reason: 'not-committed' } as const;
          if (!ownsOrder(call, current.order)) return { kind: 'refused', reason: 'binding-mismatch' } as const;
          return observeDispatch(host, call, { ...current, kind: 'observe' });
        });
      return abortableWait(work, signal);
    },
  });
}

import { randomUUID } from 'node:crypto';
import type { HostDatabase } from '@makaio/contracts';
import type { StartWorkerResult, WorkerDispatchCapability } from '@makaio/contracts/capabilities';
import type { BoundedShutdownStep, ContributionProcessor } from '@makaio/kernel';
import { boundedWait, outerBoundMs } from '@makaio/utils';
import {
  createWorkerDispatch,
  createWorkerProviderContributionProcessor,
  finishLocalAllocation,
  WorkerProviderRegistry,
  type WorkerStartOptions,
} from '@makaio/services-core/internal/worker-provider-host-binding';
import type { WorkerDispatchHostOptions } from './boot-types.js';
import { resourceStep, resourceStepStopBudgetMs } from './runtime-stop-budget.js';

interface BoundWorkerDispatch {
  readonly capability: WorkerDispatchCapability;
  readonly contributionProcessor: ContributionProcessor;
}

/**
 * Give all extension contexts and the redemption preparer one host-owned dispatch.
 * @param options - Committed order and allocation configuration.
 * @param database - Shared host database.
 * @param shutdownSteps - Host teardown sequence, including boot rollback.
 * @param closeDatabase - Releases storage after any unsent claims are resolved.
 * @returns The capability and provider processor when ordered dispatch is configured.
 */
export function bindWorkerDispatch(
  options: WorkerDispatchHostOptions | undefined,
  database: HostDatabase,
  shutdownSteps: BoundedShutdownStep[],
  closeDatabase: () => void | Promise<void>,
): BoundWorkerDispatch | undefined {
  const provisions = new Map<Promise<StartWorkerResult>, Promise<unknown>>();
  shutdownSteps.push(
    resourceStep('database', async () => {
      // Wait for outstanding claim handoffs before closing storage. A handoff that never settles
      // leaves this step pending after its shutdown window expires. Closing would itself wait
      // behind an active transaction.
      await Promise.allSettled(provisions.values());
      await closeDatabase();
    }),
  );
  if (options === undefined) return undefined;
  const providers = new WorkerProviderRegistry();
  const operations = new AbortController();
  const drained = new AbortController();
  const localCleanup = new AbortController();
  const host: WorkerStartOptions = {
    ...options,
    providers,
    database,
    operationSignal: operations.signal,
    provisionDrain: {
      closed: drained.signal,
      track(handoff, work) {
        provisions.set(work, handoff);
        const remove = () => void provisions.delete(work);
        void work.then(remove, remove);
      },
    },
    localCleanupSignal: localCleanup.signal,
    processIncarnation: randomUUID(),
    handles: new Map(),
  };
  shutdownSteps.push(
    {
      name: 'worker dispatch allocations',
      budgetMs: () => outerBoundMs(resourceStepStopBudgetMs()),
      run: () => stopAllocations(host).finally(() => localCleanup.abort()),
    },
    {
      name: 'worker dispatch provisioning',
      budgetMs: () => outerBoundMs(resourceStepStopBudgetMs()),
      async run() {
        operations.abort();
        try {
          const result = await boundedWait(Promise.allSettled(provisions.keys()), resourceStepStopBudgetMs());
          if (!result.settled) throw new Error('Worker provisioning exceeded its shutdown window');
        } finally {
          drained.abort();
        }
      },
    },
  );
  return {
    capability: createWorkerDispatch(host),
    contributionProcessor: createWorkerProviderContributionProcessor(providers),
  };
}

/**
 * Attempt every held cleanup before the host closes its database.
 * @param host - Owner of the local allocation controls.
 */
async function stopAllocations(host: WorkerStartOptions): Promise<void> {
  const work = [...host.handles.keys()].map(async (jobRunId) => {
    if (!(await finishLocalAllocation(host, jobRunId))) {
      throw new Error(`Unable to record local worker teardown for ${jobRunId}`);
    }
  });
  const result = await boundedWait(Promise.allSettled(work), resourceStepStopBudgetMs());
  if (!result.settled) throw new Error('Local worker teardown exceeded its shutdown window');
  const failures = result.value.filter((entry) => entry.status === 'rejected').map((entry) => entry.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'Local worker teardown failed');
}

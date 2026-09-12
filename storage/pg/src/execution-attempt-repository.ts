/** Transactional PostgreSQL realization of the execution-attempt repository. */
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { ExecutionAttemptRepository, OutcomeCodec } from '@makaio/subsystem-workflow-engine';
import { createExecutionAttemptControlOperations } from './execution-attempt-control.js';
import { createExecutionAttemptCore } from './execution-attempt-core.js';
import { createProviderMethods } from './execution-attempt-provider.js';
import { createExecutionAttemptRows } from './execution-attempt-rows.js';
import { createRuntimeMethods } from './execution-attempt-runtime.js';
import { createExecutionAttemptTransaction, decideByWrite } from './execution-attempt-transaction.js';

/**
 * Create a full, owner-fenced PostgreSQL execution-attempt repository.
 *
 * The constructor accepts the branded database supplied by the storage layer;
 * it never creates a pool or permits an unpinned transaction connection.
 * @param db - Branded PostgreSQL database handle.
 * @param codec - Owner-supplied canonical outcome codec.
 * @returns The complete execution-attempt repository port.
 */
export async function createPostgresExecutionAttemptRepository<TOutcome>(
  db: MakaioDatabase,
  codec: OutcomeCodec<TOutcome>,
): Promise<Required<ExecutionAttemptRepository<TOutcome>>> {
  const transaction = createExecutionAttemptTransaction(db);
  const rows = createExecutionAttemptRows({ lockOwner: transaction.lockOwner });
  const core = createExecutionAttemptCore({ codec, transaction, rows });
  const provider = createProviderMethods({
    transaction,
    rows,
    applyAllocation: core.applyAllocation,
    settleAttempt: core.settleAttempt,
    settleAndCompletePreallocationOperation: core.settleAndCompletePreallocationOperation,
  });
  const runtime = createRuntimeMethods({
    transact: transaction.transact,
    decideByWrite,
    readAttemptRow: rows.readAttemptRow,
    readActiveAttemptId: rows.readActiveAttemptId,
    allocationTerminated: rows.allocationTerminated,
    runtimeReachability: rows.runtimeReachability,
  });
  const control = createExecutionAttemptControlOperations({
    codec,
    transaction,
    rows,
    settleAttempt: core.settleAttempt,
  });
  return { ...core.methods, ...provider, ...runtime, ...control, recovery: core.recovery };
}

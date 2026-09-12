/** Cancellation read operations for PostgreSQL execution attempts. */
import type {
  AttemptCancellationControlState,
  ExecutionAttemptCancellationIntent,
  ExecutionAttemptRepository,
  ReadAttemptCancellationControlInput,
} from '@makaio/subsystem-workflow-engine';
import { decodeAttemptControlState } from './execution-attempt-types.js';
import type { ExecutionAttemptRows } from './execution-attempt-rows.js';
import type { ExecutionAttemptTransaction } from './execution-attempt-transaction.js';

type CancellationReadOperations = Pick<
  Required<ExecutionAttemptRepository<never>>,
  'readCancellation' | 'readAttemptCancellationControl'
>;

/**
 * Create cancellation state read operations.
 * @param rows - Attempt and control-state row accessors.
 * @param transact - Transaction boundary for consistent cancellation reads.
 * @returns Cancellation state read methods.
 */
export function createCancellationReadOperations(
  rows: Pick<ExecutionAttemptRows, 'readAttemptRow' | 'readCancellationInSession' | 'readControlEvidenceInSession'>,
  transact: ExecutionAttemptTransaction['transact'],
): CancellationReadOperations {
  return {
    async readCancellation(executionAttemptId: string): Promise<ExecutionAttemptCancellationIntent | null> {
      return transact((session) => rows.readCancellationInSession(session, executionAttemptId));
    },
    async readAttemptCancellationControl(
      input: ReadAttemptCancellationControlInput,
    ): Promise<AttemptCancellationControlState | null> {
      return transact(async (session) => {
        const row = await rows.readAttemptRow(session, input.executionAttemptId);
        if (row === undefined || row.execution_id !== input.executionId) return null;
        return {
          control: decodeAttemptControlState(row),
          cancellation: await rows.readCancellationInSession(session, input.executionAttemptId),
          evidence: await rows.readControlEvidenceInSession(session, input.executionAttemptId),
        };
      });
    },
  };
}

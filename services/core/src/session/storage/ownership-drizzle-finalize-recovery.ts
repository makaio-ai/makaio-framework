import { and, eq } from 'drizzle-orm';
import { didAffectRows, executeTransaction, resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { SessionOwnershipFinalizeRecoveryRequest } from '@makaio/contracts';
import { sessionStorageSchema } from './schema.variants.js';
import { lockAgentAllocation, type OwnershipTables } from './ownership-drizzle-rows.js';

type RecoveryTerminalValues = Partial<
  Pick<
    OwnershipTables['agents']['$inferInsert'],
    'adapterId' | 'ownerMachineId' | 'ownerInstanceId' | 'recoveryAttemptId' | 'status'
  >
>;

/**
 * Apply one terminal recovery transition only for its exact persisted attempt.
 * @param db - Database containing the ownership aggregate.
 * @param payload - Attempt-fenced terminal transition request.
 * @returns Whether the exact attempt owned the row and its terminal transition applied.
 */
export async function runFinalizeRecovery(
  db: MakaioDatabase,
  payload: SessionOwnershipFinalizeRecoveryRequest,
): Promise<{ applied: boolean }> {
  const tables = resolveSchema(db, sessionStorageSchema);
  return executeTransaction(db, async (tx) => {
    await lockAgentAllocation(tx, tables, payload.agentId);
    const terminal: RecoveryTerminalValues =
      payload.action.kind === 'rollback'
        ? {
            status: payload.action.preimage.status,
            adapterId: payload.action.preimage.adapterId,
            ownerMachineId: payload.action.preimage.binding?.ownerMachineId ?? null,
            ownerInstanceId: payload.action.preimage.binding?.ownerInstanceId ?? null,
            recoveryAttemptId: payload.action.preimage.recoveryAttemptId ?? null,
          }
        : { status: payload.action.kind === 'succeeded' ? 'idle' : 'dead', recoveryAttemptId: null };
    const result = await tx
      .update(tables.agents)
      .set({ ...terminal, lastActivityAt: Date.now() })
      .where(
        and(
          eq(tables.agents.agentId, payload.agentId),
          eq(tables.agents.status, 'starting'),
          eq(tables.agents.recoveryAttemptId, payload.attemptId),
          eq(tables.agents.adapterId, payload.binding.adapterId),
          eq(tables.agents.ownerMachineId, payload.binding.ownerMachineId),
          eq(tables.agents.ownerInstanceId, payload.binding.ownerInstanceId),
        ),
      );
    return { applied: didAffectRows(result) };
  });
}

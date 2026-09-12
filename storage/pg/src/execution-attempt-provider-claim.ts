/** Provider-operation claim transitions for PostgreSQL execution attempts. */
import { sql } from 'drizzle-orm';
import { BoundedRecoveryEvidenceSchema } from '@makaio/contracts';
import {
  isProviderOperationResolved,
  type ExecutionAttemptRepository,
  type HandoffProviderOperationInput,
  type ProviderOperationClaim,
  type ProviderOperationClaimDecision,
  type ProviderOperationMutationDecision,
  type RecordProviderOperationUncertaintyInput,
  type TakeOverProviderOperationInput,
} from '@makaio/subsystem-workflow-engine';
import { instantOf, normalizeInstant, toAttemptRecord, toOperationRecord } from './execution-attempt-types.js';
import type { ExecutionAttemptRows } from './execution-attempt-rows.js';
import { claimAuthorizes, decideByWrite, operationIsUnresolved } from './execution-attempt-transaction.js';
import type { ExecutionAttemptTransaction } from './execution-attempt-transaction.js';

type ProviderClaimOperations = Pick<
  Required<ExecutionAttemptRepository<never>>,
  'takeOverProviderOperation' | 'handoffProviderOperation' | 'recordProviderOperationUncertainty'
>;

interface ProviderClaimContext {
  readonly transaction: Pick<ExecutionAttemptTransaction, 'transact'>;
  readonly rows: Pick<ExecutionAttemptRows, 'readAttemptRow' | 'readOperationRow' | 'refuseUnauthorized'>;
}

/**
 * Create the claim transition members of the provider-operation repository surface.
 * @param context - Transaction and row access dependencies for claim-fenced changes.
 * @returns Claim takeover, handoff, and uncertainty methods.
 */
export function createProviderClaimOperations(context: ProviderClaimContext): ProviderClaimOperations {
  return { ...createTakeoverOperation(context), ...createClaimEvidenceOperations(context) };
}

/**
 * Create the operation that acquires an expired provider-operation claim.
 * @param context - Transaction and row access dependencies for claim acquisition.
 * @returns The provider-operation takeover method.
 */
function createTakeoverOperation(
  context: ProviderClaimContext,
): Pick<ProviderClaimOperations, 'takeOverProviderOperation'> {
  const { transact } = context.transaction;
  const { readAttemptRow, readOperationRow } = context.rows;
  return {
    async takeOverProviderOperation(input: TakeOverProviderOperationInput): Promise<ProviderOperationClaimDecision> {
      return transact(async (session) => {
        const attemptRow = await readAttemptRow(session, input.executionAttemptId);
        const operation = await readOperationRow(session, input.executionAttemptId);
        if (attemptRow === undefined || operation === undefined) return { kind: 'not-found' };
        const attempt = toAttemptRecord(attemptRow);
        if (isProviderOperationResolved(attempt, toOperationRecord(operation))) return { kind: 'resolved' };
        const observedAt = normalizeInstant(input.observedAt);
        if (
          operation.owner_id !== null &&
          operation.lease_expires_at !== null &&
          instantOf(operation.lease_expires_at) > instantOf(observedAt)
        )
          return { kind: 'stale' };
        const claim: ProviderOperationClaim = {
          executionAttemptId: input.executionAttemptId,
          generation: operation.generation + 1,
          ownerId: input.ownerId,
          token: crypto.randomUUID(),
          leaseExpiresAt: normalizeInstant(input.leaseExpiresAt),
        };
        const { rowsAffected } = await session.run(sql`UPDATE provider_operation
          SET generation = ${claim.generation}, owner_id = ${claim.ownerId}, token = ${claim.token}, lease_expires_at = ${claim.leaseExpiresAt}
          WHERE execution_attempt_id = ${input.executionAttemptId} AND generation = ${operation.generation}
            AND ${operationIsUnresolved(input.executionAttemptId)}`);
        if (rowsAffected > 0) return { kind: 'claimed', claim };
        const latestAttempt = await readAttemptRow(session, input.executionAttemptId);
        const latestOperation = await readOperationRow(session, input.executionAttemptId);
        return latestAttempt !== undefined &&
          latestOperation !== undefined &&
          isProviderOperationResolved(toAttemptRecord(latestAttempt), toOperationRecord(latestOperation))
          ? { kind: 'resolved' }
          : { kind: 'stale' };
      });
    },
  };
}

/**
 * Create the operations that mutate evidence held by the current provider-operation claim.
 * @param context - Transaction and row access dependencies for claim-authorized evidence writes.
 * @returns Provider-operation handoff and uncertainty methods.
 */
function createClaimEvidenceOperations(
  context: ProviderClaimContext,
): Pick<ProviderClaimOperations, 'handoffProviderOperation' | 'recordProviderOperationUncertainty'> {
  const { transact } = context.transaction;
  const { refuseUnauthorized } = context.rows;
  return {
    async handoffProviderOperation(input: HandoffProviderOperationInput): Promise<ProviderOperationMutationDecision> {
      const evidence = input.evidence === undefined ? null : BoundedRecoveryEvidenceSchema.parse(input.evidence);
      return transact((session) =>
        decideByWrite<ProviderOperationMutationDecision>(
          async () =>
            (await refuseUnauthorized(session, input.claim)) ??
            (() =>
              session.run(
                evidence === null
                  ? sql`UPDATE provider_operation SET owner_id = NULL, token = NULL, lease_expires_at = NULL WHERE execution_attempt_id = ${input.claim.executionAttemptId} AND ${claimAuthorizes(input.claim)}`
                  : sql`UPDATE provider_operation SET owner_id = NULL, token = NULL, lease_expires_at = NULL, last_failure = ${JSON.stringify(evidence)} WHERE execution_attempt_id = ${input.claim.executionAttemptId} AND ${claimAuthorizes(input.claim)}`,
              )),
          { kind: 'recorded' },
        ),
      );
    },
    async recordProviderOperationUncertainty(
      input: RecordProviderOperationUncertaintyInput,
    ): Promise<ProviderOperationMutationDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.evidence);
      return transact((session) =>
        decideByWrite<ProviderOperationMutationDecision>(
          async () =>
            (await refuseUnauthorized(session, input.claim)) ??
            (() =>
              session.run(
                sql`UPDATE provider_operation SET failure_count = failure_count + 1, last_failure = ${JSON.stringify(evidence)} WHERE execution_attempt_id = ${input.claim.executionAttemptId} AND ${claimAuthorizes(input.claim)}`,
              )),
          { kind: 'recorded' },
        ),
      );
    },
  };
}

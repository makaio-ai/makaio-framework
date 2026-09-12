/** Provider provisioning and allocation transitions for PostgreSQL attempts. */
import { sql, type SQL } from 'drizzle-orm';
import { BoundedRecoveryEvidenceSchema, type BoundedRecoveryEvidence } from '@makaio/contracts';
import {
  PROVIDER_OPERATION_OBLIGATIONS,
  evaluateProvisionerIncarnationLoss,
  isProviderOperationResolved,
  type AllocationRecordingDecision,
  type AllocationTerminationDecision,
  type BeginProvisioningInput,
  type CompleteProviderOperationInput,
  type ExecutionAttemptRepository,
  type InfrastructureFailureDecision,
  type ProviderOperationClaim,
  type ProviderOperationClaimDecision,
  type ProviderOperationCompletionDecision,
  type ProviderOperationOwnershipRecord,
  type ProvisionerIncarnationLossDecision,
  type ProvisioningAbsenceDecision,
  type ProvisioningClaimDecision,
  type RecordAllocationInput,
  type RecordAllocationTerminatedInput,
  type RecordInfrastructureFailureInput,
  type RecordProvisionerIncarnationLostInput,
  type RecordProvisioningAbsentInput,
  type RenewProviderOperationClaimInput,
} from '@makaio/subsystem-workflow-engine';
import type { RawSqlSession } from '@makaio/storage-drizzle';
import {
  normalizeInstant,
  parseAllocationLifetime,
  parseMember,
  toAttemptRecord,
  toOperationRecord,
} from './execution-attempt-types.js';
import type { ExecutionAttemptRows } from './execution-attempt-rows.js';
import {
  claimAuthorizes,
  claimHolds,
  decideByWrite,
  isActiveAttemptRow,
  operationOwesTerminalConvergence,
} from './execution-attempt-transaction.js';
import type { ExecutionAttemptTransaction } from './execution-attempt-transaction.js';
import { createProviderClaimOperations } from './execution-attempt-provider-claim.js';

/** Concrete dependencies shared by the provider-operation method group. */
export interface ProviderMethodContext {
  readonly transaction: Pick<ExecutionAttemptTransaction, 'transact'>;
  readonly rows: Pick<
    ExecutionAttemptRows,
    'authorize' | 'readActiveAttemptId' | 'readAttemptRow' | 'readOperationRow' | 'refuseUnauthorized'
  >;
  readonly applyAllocation: (
    input: RecordAllocationInput,
    bootstrapClaimable: boolean,
  ) => Promise<AllocationRecordingDecision>;
  readonly settleAttempt: (
    session: RawSqlSession,
    executionAttemptId: string,
    settlementKind: 'abandoned' | 'infrastructure-failure',
    guard: SQL,
  ) => Promise<{ readonly rowsAffected: number }>;
  readonly settleAndCompletePreallocationOperation: (
    session: RawSqlSession,
    executionAttemptId: string,
    claim: ProviderOperationClaim,
    guard: SQL,
    evidence: BoundedRecoveryEvidence,
    alreadySettled: boolean,
  ) => Promise<{ readonly rowsAffected: number }>;
}

type ProviderMethods = Pick<
  Required<ExecutionAttemptRepository<never>>,
  | 'beginProvisioning'
  | 'getProviderOperation'
  | 'renewProviderOperationClaim'
  | 'takeOverProviderOperation'
  | 'handoffProviderOperation'
  | 'recordProviderOperationUncertainty'
  | 'completeProviderOperation'
  | 'recordAllocation'
  | 'recordProvisioningAbsent'
  | 'recordProvisionerIncarnationLost'
  | 'recordAllocationTerminated'
  | 'recordInfrastructureFailure'
>;

type ProviderProvisioningContext = Pick<ProviderMethodContext, 'transaction' | 'rows'>;
type ProviderSettlementContext = Pick<
  ProviderMethodContext,
  'transaction' | 'rows' | 'applyAllocation' | 'settleAndCompletePreallocationOperation'
>;
type ProviderTerminationContext = Pick<ProviderMethodContext, 'transaction' | 'rows' | 'settleAttempt'>;
/**
 * Create the provider-operation methods of an execution-attempt repository.
 * @param context - Transaction, row, allocation, and settlement dependencies.
 * @returns Provider-operation members of the complete repository port.
 */
export function createProviderMethods(context: ProviderMethodContext): ProviderMethods {
  return {
    ...createProvisioningOperations(context),
    ...createProviderClaimOperations(context),
    ...createProviderCompletionOperations(context),
    ...createProviderSettlementOperations(context),
    ...createProviderTerminationOperations(context),
  };
}

/**
 * Create provisioning and initial claim operations.
 * @param context - Transaction and row dependencies for provisioning state changes.
 * @returns Provisioning start, read, and renewal methods.
 */
function createProvisioningOperations(
  context: ProviderProvisioningContext,
): Pick<ProviderMethods, 'beginProvisioning' | 'getProviderOperation' | 'renewProviderOperationClaim'> {
  const { transact } = context.transaction;
  const { readActiveAttemptId, readAttemptRow, readOperationRow, refuseUnauthorized } = context.rows;

  return {
    async beginProvisioning(input: BeginProvisioningInput): Promise<ProvisioningClaimDecision> {
      const allocationLifetime = parseAllocationLifetime(input.allocationLifetime);
      const claim: ProviderOperationClaim = {
        executionAttemptId: input.executionAttemptId,
        generation: 1,
        ownerId: input.ownerId,
        token: crypto.randomUUID(),
        leaseExpiresAt: normalizeInstant(input.leaseExpiresAt),
      };
      return transact((session) =>
        decideByWrite<ProvisioningClaimDecision>(
          async () => {
            const attemptRow = await readAttemptRow(session, input.executionAttemptId);
            if (attemptRow === undefined || attemptRow.execution_id !== input.executionId) return { kind: 'not-found' };
            const attempt = toAttemptRecord(attemptRow);
            if ((await readActiveAttemptId(session, input.executionId)) !== input.executionAttemptId)
              return { kind: 'fenced' };
            if (attempt.settlementKind != null) return { kind: 'resolved', allocationRef: attempt.allocationRef };
            if (attempt.allocationRef !== null) return { kind: 'allocated', allocationRef: attempt.allocationRef };
            if (attempt.operationStartGate === 'closed') return { kind: 'fenced' };
            if (attempt.status !== 'pending') return { kind: 'already-provisioning' };
            return async () => {
              const applied = await session.run(
                sql`UPDATE execution_attempt
                  SET status = ${'provisioning'}, provider_id = ${input.providerId},
                      allocation_lifetime = ${allocationLifetime}, provisioner_incarnation_id = ${input.provisionerIncarnationId}
                  WHERE execution_attempt_id = ${input.executionAttemptId}
                    AND execution_id = ${input.executionId} AND status = ${'pending'}
                    AND operation_start_gate = 'open' AND allocation_ref IS NULL AND settlement_kind IS NULL
                    AND ${isActiveAttemptRow()}`,
              );
              if (applied.rowsAffected === 0) return applied;
              await session.run(
                sql`INSERT INTO provider_operation
                    (execution_attempt_id, generation, owner_id, token, lease_expires_at, obligation, failure_count)
                  VALUES (${input.executionAttemptId}, ${claim.generation}, ${claim.ownerId}, ${claim.token},
                    ${claim.leaseExpiresAt}, ${'provisioning-resolution'}, ${0})`,
              );
              return applied;
            };
          },
          { kind: 'started', claim },
        ),
      );
    },
    async getProviderOperation(executionAttemptId: string): Promise<ProviderOperationOwnershipRecord | null> {
      return transact(async (session) => {
        const row = await readOperationRow(session, executionAttemptId);
        return row === undefined ? null : toOperationRecord(row);
      });
    },
    async renewProviderOperationClaim(
      input: RenewProviderOperationClaimInput,
    ): Promise<ProviderOperationClaimDecision> {
      const leaseExpiresAt = normalizeInstant(input.leaseExpiresAt);
      return transact((session) =>
        decideByWrite<ProviderOperationClaimDecision>(
          async () =>
            (await refuseUnauthorized(session, input.claim)) ??
            (() =>
              session.run(
                sql`UPDATE provider_operation SET lease_expires_at = ${leaseExpiresAt}
                    WHERE execution_attempt_id = ${input.claim.executionAttemptId} AND ${claimAuthorizes(input.claim)}`,
              )),
          { kind: 'claimed', claim: { ...input.claim, leaseExpiresAt } },
        ),
      );
    },
  };
}

/**
 * Create the provider-operation completion operation.
 * @param context - Transaction and row dependencies for completion evidence writes.
 * @returns The provider-operation completion method.
 */
function createProviderCompletionOperations(
  context: ProviderProvisioningContext,
): Pick<ProviderMethods, 'completeProviderOperation'> {
  const { transact } = context.transaction;
  const { readAttemptRow, readOperationRow } = context.rows;

  return {
    async completeProviderOperation(
      input: CompleteProviderOperationInput,
    ): Promise<ProviderOperationCompletionDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.evidence);
      return transact(async (session) => {
        const attemptRow = await readAttemptRow(session, input.claim.executionAttemptId);
        const operation = await readOperationRow(session, input.claim.executionAttemptId);
        if (attemptRow === undefined || operation === undefined) return { kind: 'not-found' };
        const matches =
          operation.generation === input.claim.generation &&
          operation.owner_id === input.claim.ownerId &&
          operation.token === input.claim.token;
        if (!matches) return { kind: 'stale' };
        const attempt = toAttemptRecord(attemptRow);
        if (isProviderOperationResolved(attempt, toOperationRecord(operation))) return { kind: 'already-completed' };
        if (operation.completion_evidence !== null) return { kind: 'evidence-recorded' };
        const recorded = await session.run(
          sql`UPDATE provider_operation SET completion_evidence = ${JSON.stringify(evidence)}
                WHERE execution_attempt_id = ${input.claim.executionAttemptId}
                  AND ${claimHolds(input.claim)} AND completion_evidence IS NULL`,
        );
        if (recorded.rowsAffected > 0) {
          const latestAttempt = await readAttemptRow(session, input.claim.executionAttemptId);
          if (latestAttempt === undefined) return { kind: 'not-found' };
          return latestAttempt.settlement_kind === null ? { kind: 'evidence-recorded' } : { kind: 'completed' };
        }
        const latestAttempt = await readAttemptRow(session, input.claim.executionAttemptId);
        const latestOperation = await readOperationRow(session, input.claim.executionAttemptId);
        if (latestAttempt === undefined || latestOperation === undefined) return { kind: 'not-found' };
        const latestMatches =
          latestOperation.generation === input.claim.generation &&
          latestOperation.owner_id === input.claim.ownerId &&
          latestOperation.token === input.claim.token;
        if (!latestMatches) return { kind: 'stale' };
        if (isProviderOperationResolved(toAttemptRecord(latestAttempt), toOperationRecord(latestOperation))) {
          return { kind: 'already-completed' };
        }
        return latestOperation.completion_evidence !== null ? { kind: 'evidence-recorded' } : { kind: 'stale' };
      });
    },
  };
}

/**
 * Create allocation and preallocation settlement operations.
 * @param context - Transaction, row, allocation, and settlement dependencies.
 * @returns Allocation recording and provisioning recovery methods.
 */
function createProviderSettlementOperations(
  context: ProviderSettlementContext,
): Pick<ProviderMethods, 'recordAllocation' | 'recordProvisioningAbsent' | 'recordProvisionerIncarnationLost'> {
  const { transact } = context.transaction;
  const { authorize } = context.rows;

  return {
    async recordAllocation(input: RecordAllocationInput): Promise<AllocationRecordingDecision> {
      return context.applyAllocation(input, true);
    },
    async recordProvisioningAbsent(input: RecordProvisioningAbsentInput): Promise<ProvisioningAbsenceDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.evidence);
      let preservedSettlement = false;
      return transact((session) =>
        decideByWrite<ProvisioningAbsenceDecision>(
          async () => {
            const authorization = await authorize(session, input.claim);
            if (authorization.kind !== 'authorized') return { kind: authorization.kind };
            const { attempt } = authorization;
            if (attempt.executionId !== input.executionId) return { kind: 'not-found' };
            if (attempt.allocationRef !== null) return { kind: 'allocated', allocationRef: attempt.allocationRef };
            preservedSettlement = attempt.settlementKind !== null;
            return () =>
              context.settleAndCompletePreallocationOperation(
                session,
                attempt.executionAttemptId,
                input.claim,
                sql`execution_id = ${input.executionId} AND allocation_ref IS NULL AND ${claimHolds(input.claim)}`,
                evidence,
                preservedSettlement,
              );
          },
          () => (preservedSettlement ? { kind: 'completed' } : { kind: 'recorded' }),
        ),
      );
    },
    async recordProvisionerIncarnationLost(
      input: RecordProvisionerIncarnationLostInput,
    ): Promise<ProvisionerIncarnationLossDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.proof.evidence);
      let preservedSettlement = false;
      return transact((session) =>
        decideByWrite<ProvisionerIncarnationLossDecision>(
          async () => {
            const authorization = await authorize(session, input.claim);
            if (authorization.kind !== 'authorized') return { kind: authorization.kind };
            const { attempt } = authorization;
            if (attempt.executionId !== input.executionId) return { kind: 'not-found' };
            if (attempt.allocationRef !== null) return { kind: 'allocated', allocationRef: attempt.allocationRef };
            const refusal = evaluateProvisionerIncarnationLoss(attempt, input);
            if (refusal !== null) return refusal;
            preservedSettlement = attempt.settlementKind !== null;
            return () =>
              context.settleAndCompletePreallocationOperation(
                session,
                attempt.executionAttemptId,
                input.claim,
                sql`execution_id = ${input.executionId} AND allocation_ref IS NULL
                AND allocation_lifetime = ${'provisioner-process-bound'}
                AND provisioner_incarnation_id = ${input.proof.provisionerIncarnationId} AND ${claimHolds(input.claim)}`,
                evidence,
                preservedSettlement,
              );
          },
          () => (preservedSettlement ? { kind: 'completed' } : { kind: 'recorded' }),
        ),
      );
    },
  };
}

/**
 * Create termination and infrastructure-failure operations.
 * @param context - Transaction, row, and terminal settlement dependencies.
 * @returns Allocation termination and infrastructure-failure methods.
 */
function createProviderTerminationOperations(
  context: ProviderTerminationContext,
): Pick<ProviderMethods, 'recordAllocationTerminated' | 'recordInfrastructureFailure'> {
  const { transact } = context.transaction;
  const { authorize } = context.rows;

  return {
    async recordAllocationTerminated(input: RecordAllocationTerminatedInput): Promise<AllocationTerminationDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.evidence);
      return transact((session) =>
        decideByWrite<AllocationTerminationDecision>(
          async () => {
            const authorization = await authorize(session, input.claim);
            if (authorization.kind !== 'authorized') return { kind: authorization.kind };
            if (authorization.attempt.allocationRef === null) return { kind: 'not-allocated' };
            return () =>
              session.run(
                sql`UPDATE provider_operation SET obligation = ${'terminal-convergence'}, last_failure = ${JSON.stringify(evidence)}
                  WHERE execution_attempt_id = ${authorization.attempt.executionAttemptId}
                    AND ${claimAuthorizes(input.claim)}
                    AND EXISTS (SELECT 1 FROM execution_attempt
                      WHERE execution_attempt_id = ${authorization.attempt.executionAttemptId} AND allocation_ref IS NOT NULL)`,
              );
          },
          { kind: 'recorded' },
        ),
      );
    },
    async recordInfrastructureFailure(input: RecordInfrastructureFailureInput): Promise<InfrastructureFailureDecision> {
      return transact((session) =>
        decideByWrite<InfrastructureFailureDecision>(
          async () => {
            const authorization = await authorize(session, input.claim);
            if (authorization.kind !== 'authorized') return { kind: authorization.kind };
            const { attempt, operation } = authorization;
            if (attempt.executionId !== input.executionId) return { kind: 'not-found' };
            if (attempt.settlementKind !== null) return { kind: 'resolved' };
            if (attempt.allocationRef === null) return { kind: 'not-allocated' };
            if (
              parseMember(PROVIDER_OPERATION_OBLIGATIONS, operation.obligation, 'obligation') !== 'terminal-convergence'
            ) {
              return { kind: 'not-terminated' };
            }
            return () =>
              context.settleAttempt(
                session,
                attempt.executionAttemptId,
                'infrastructure-failure',
                sql`execution_id = ${input.executionId} AND allocation_ref IS NOT NULL
                AND ${operationOwesTerminalConvergence(attempt.executionAttemptId)} AND ${claimHolds(input.claim)}`,
              );
          },
          { kind: 'recorded' },
        ),
      );
    },
  };
}

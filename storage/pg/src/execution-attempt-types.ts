/**
 * Shared PostgreSQL execution-attempt row decoding and input snapshots.
 *
 * This module is deliberately private to the PostgreSQL adapter. It depends
 * only on published workspace contracts so the adapter bundle keeps its public
 * package boundary.
 */
import { z } from 'zod';
import type { ExecutionAttemptInstruction, ProviderAllocationRef } from '@makaio/contracts';
import {
  BoundedRecoveryEvidenceSchema,
  ExecutionAttemptOperationKindSchema,
  ExecutionAttemptInstructionSchema,
  ExecutionAttemptPreparationResultSchema,
  ProviderAllocationRefSchema,
  WorkerAllocationLifetimeSchema,
  type BoundedRecoveryEvidence,
} from '@makaio/contracts';
import {
  ATTEMPT_OPERATION_START_GATES,
  EXECUTION_ATTEMPT_SETTLEMENT_KINDS,
  EXECUTION_ATTEMPT_STATUSES,
  PROVIDER_OPERATION_OBLIGATIONS,
  type AllocationRefEvolution,
  type AttemptControlState,
  type AttemptOutcomeControlObservation,
  type ExecutionAttemptRecord,
  type ProviderOperationOwnershipRecord,
  type RecoverableAttemptRecord,
} from '@makaio/subsystem-workflow-engine';

export const INITIAL_ATTEMPT_CONTROL_STATE: AttemptControlState = {
  runtimeGeneration: 0,
  runtimeIncarnationId: null,
  runtimeReadyAt: null,
  operationStartGate: 'open',
  activeOperationId: null,
  activeOperationKind: null,
  activeOperationKey: null,
  activeOperationGeneration: null,
  activeOperationAdmittedAt: null,
  lastCompletedOperationId: null,
};

export const instantOf = (value: string): number => {
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) throw new Error(`Expected an ISO-8601 timestamp, received '${value}'`);
  return instant;
};

export const normalizeInstant = (value: string): string => new Date(instantOf(value)).toISOString();

export const createAttemptTiming = (bootstrapTimeoutMs: number) => {
  if (!Number.isSafeInteger(bootstrapTimeoutMs) || bootstrapTimeoutMs <= 0) {
    throw new RangeError('bootstrapTimeoutMs must be a positive safe integer');
  }
  const now = Date.now();
  const deadline = now + bootstrapTimeoutMs;
  if (!Number.isSafeInteger(deadline) || !Number.isFinite(new Date(deadline).getTime())) {
    throw new RangeError('bootstrapTimeoutMs produces an unrepresentable bootstrap deadline');
  }
  return { createdAt: new Date(now).toISOString(), bootstrapDeadlineAt: new Date(deadline).toISOString() };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const freezeDeep = (value: unknown): void => {
  if (!isRecord(value) || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const member of Object.values(value)) freezeDeep(member);
};

const snapshot = <T>(value: unknown, parse: (candidate: unknown) => T): T => {
  const parsed = parse(structuredClone(value));
  freezeDeep(parsed);
  return parsed;
};

export const parseInstruction = (value: ExecutionAttemptInstruction) =>
  snapshot(value, (candidate) => ExecutionAttemptInstructionSchema.parse(candidate));

export const parsePreparationResult = (value: unknown) =>
  snapshot(value, (candidate) => ExecutionAttemptPreparationResultSchema.parse(candidate));

const preparationReceiptsSchema = z.array(
  z
    .object({
      operationId: z.string().min(1),
      runtimeGeneration: z.number().int().positive(),
      result: ExecutionAttemptPreparationResultSchema,
    })
    .strict(),
);

export const parsePreparationReceipts = (value: unknown) =>
  snapshot(value, (candidate) => preparationReceiptsSchema.parse(candidate));

export const parseAllocationRef = (value: ProviderAllocationRef) =>
  snapshot(value, (candidate) => ProviderAllocationRefSchema.parse(candidate));

export const parseAllocationLifetime = (value: unknown) => WorkerAllocationLifetimeSchema.parse(value);

export const parseAllocationRefEvolution = (input: AllocationRefEvolution) => {
  const currentRef = ProviderAllocationRefSchema.parse(input.currentRef);
  const nextRef = parseAllocationRef(input.nextRef);
  if (currentRef.providerId !== nextRef.providerId) {
    throw new Error(
      `Allocation reference evolution must keep one provider, received '${currentRef.providerId}' and '${nextRef.providerId}'`,
    );
  }
  return { currentRef, nextRef };
};

export const requireAllocationRefProvider = (
  attempt: ExecutionAttemptRecord,
  allocationRef: ProviderAllocationRef,
): void => {
  if (attempt.providerId !== allocationRef.providerId) {
    throw new Error(
      `Allocation reference for attempt '${attempt.executionAttemptId}' names provider '${allocationRef.providerId}' but the attempt is bound to '${attempt.providerId ?? 'no provider'}'`,
    );
  }
};

export const toRecoverableAttempt = (record: ExecutionAttemptRecord): RecoverableAttemptRecord => {
  if (
    record.status !== 'allocated' ||
    !record.claimable ||
    record.settlementKind !== null ||
    record.allocationRef === null ||
    record.providerId === null ||
    record.allocationLifetime === null ||
    record.provisionerIncarnationId === null
  ) {
    throw new Error(`Attempt '${record.executionAttemptId}' was selected as recoverable but is not recoverable`);
  }
  return record as RecoverableAttemptRecord;
};

export interface AttemptRow extends Record<string, unknown> {
  readonly execution_attempt_id: string;
  readonly execution_id: string;
  readonly instruction: string;
  readonly preparation_receipts: string;
  readonly status: string;
  readonly provider_id: string | null;
  readonly allocation_lifetime: string | null;
  readonly provisioner_incarnation_id: string | null;
  readonly allocation_ref: string | null;
  readonly settlement_kind: string | null;
  readonly outcome_text: string | null;
  readonly outcome_control_observation: string | null;
  readonly claimable: number;
  readonly claim_expires_at: string | null;
  readonly created_at: string;
  readonly bootstrap_deadline_at: string | null;
  readonly runtime_generation: number;
  readonly runtime_incarnation_id: string | null;
  readonly runtime_ready_at: string | null;
  readonly operation_start_gate: string;
  readonly active_operation_id: string | null;
  readonly active_operation_kind: string | null;
  readonly active_operation_key: string | null;
  readonly active_operation_generation: number | null;
  readonly active_operation_admitted_at: string | null;
  readonly last_completed_operation_id: string | null;
}

export interface OperationRow extends Record<string, unknown> {
  readonly execution_attempt_id: string;
  readonly generation: number;
  readonly owner_id: string | null;
  readonly token: string | null;
  readonly lease_expires_at: string | null;
  readonly obligation: string;
  readonly failure_count: number;
  readonly last_failure: string | null;
  readonly completion_evidence: string | null;
}

export interface ActiveAttemptRow extends Record<string, unknown> {
  readonly execution_attempt_id: string;
}

/**
 * Parse a stored enum member against the port-owned vocabulary.
 * @param members - Allowed members in the port vocabulary.
 * @param value - Stored database value to validate.
 * @param column - Database column reported for an invalid value.
 * @returns The validated vocabulary member.
 */
export function parseMember<TMember extends string>(
  members: readonly TMember[],
  value: string,
  column: string,
): TMember {
  const member = members.find((candidate) => candidate === value);
  if (member === undefined) {
    throw new Error(`Stored '${column}' value '${value}' is not part of the port's vocabulary`);
  }
  return member;
}

/**
 * Decode an optional JSON column through its value schema.
 * @param json - Serialized column value, or null when absent.
 * @param parse - Schema parser for the decoded JSON value.
 * @returns The parsed value, or null when the column is null.
 */
export function parseJsonColumn<TValue>(json: string | null, parse: (value: unknown) => TValue): TValue | null {
  return json === null ? null : parse(JSON.parse(json));
}

const cancellationReceiptSchema = z.object({
  requestKey: z.string().min(1),
  controlRevision: z.number().int().positive(),
  requestedAt: z.string().datetime(),
  reason: z.string().optional(),
});

const outcomeControlSchema = z.object({
  controlRevision: z.number().int().nonnegative(),
  cancellation: cancellationReceiptSchema.nullable(),
});

/**
 * Decode the immutable cancellation observation stored with an outcome.
 * @param json - Serialized control observation, or null when no outcome was committed.
 * @returns The validated control observation, or null when absent.
 */
export function decodeOutcomeControl(json: string | null): AttemptOutcomeControlObservation | null {
  if (json === null) return null;
  const observation = outcomeControlSchema.parse(JSON.parse(json));
  if (observation.controlRevision !== (observation.cancellation?.controlRevision ?? 0)) {
    throw new Error('Stored outcome control revision does not match its cancellation receipt');
  }
  return observation;
}

/**
 * Decode the runtime and active-operation columns of an attempt row.
 * @param row - Database attempt row to decode.
 * @returns The port control-state projection.
 */
export function decodeAttemptControlState(row: AttemptRow): AttemptControlState {
  return {
    runtimeGeneration: row.runtime_generation,
    runtimeIncarnationId: row.runtime_incarnation_id,
    runtimeReadyAt: row.runtime_ready_at,
    operationStartGate: parseMember(ATTEMPT_OPERATION_START_GATES, row.operation_start_gate, 'operation_start_gate'),
    activeOperationId: row.active_operation_id,
    activeOperationKind:
      row.active_operation_kind === null ? null : ExecutionAttemptOperationKindSchema.parse(row.active_operation_kind),
    activeOperationKey: row.active_operation_key,
    activeOperationGeneration: row.active_operation_generation,
    activeOperationAdmittedAt: row.active_operation_admitted_at,
    lastCompletedOperationId: row.last_completed_operation_id,
  };
}

/**
 * Decode a database attempt row into its public repository record.
 * @param row - Database attempt row to decode.
 * @returns Validated immutable execution-attempt record.
 */
export function toAttemptRecord(row: AttemptRow): ExecutionAttemptRecord {
  return {
    ...decodeAttemptControlState(row),
    executionAttemptId: row.execution_attempt_id,
    executionId: row.execution_id,
    instruction: parseInstruction(JSON.parse(row.instruction)),
    preparationReceipts: parsePreparationReceipts(JSON.parse(row.preparation_receipts)),
    status: parseMember(EXECUTION_ATTEMPT_STATUSES, row.status, 'status'),
    allocationRef: parseJsonColumn<ProviderAllocationRef>(row.allocation_ref, (value) =>
      ProviderAllocationRefSchema.parse(value),
    ),
    createdAt: row.created_at,
    bootstrapDeadlineAt: row.bootstrap_deadline_at,
    providerId: row.provider_id,
    allocationLifetime:
      row.allocation_lifetime === null ? null : WorkerAllocationLifetimeSchema.parse(row.allocation_lifetime),
    provisionerIncarnationId: row.provisioner_incarnation_id,
    settlementKind:
      row.settlement_kind === null
        ? null
        : parseMember(EXECUTION_ATTEMPT_SETTLEMENT_KINDS, row.settlement_kind, 'settlement_kind'),
    claimable: row.claimable !== 0,
    claimExpiresAt: row.claim_expires_at,
  };
}

/**
 * Decode a database provider-operation row into its public ownership record.
 * @param row - Database operation row to decode.
 * @returns Validated provider-operation ownership record.
 */
export function toOperationRecord(row: OperationRow): ProviderOperationOwnershipRecord {
  return {
    executionAttemptId: row.execution_attempt_id,
    generation: row.generation,
    ownerId: row.owner_id,
    token: row.token,
    leaseExpiresAt: row.lease_expires_at,
    obligation: parseMember(PROVIDER_OPERATION_OBLIGATIONS, row.obligation, 'obligation'),
    failureCount: row.failure_count,
    lastFailure: parseJsonColumn<BoundedRecoveryEvidence>(row.last_failure, (value) =>
      BoundedRecoveryEvidenceSchema.parse(value),
    ),
    completionEvidence: parseJsonColumn<BoundedRecoveryEvidence>(row.completion_evidence, (value) =>
      BoundedRecoveryEvidenceSchema.parse(value),
    ),
  };
}

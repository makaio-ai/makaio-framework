import { index, primaryKey } from 'drizzle-orm/sqlite-core';
import { index as pgIndex, primaryKey as pgPrimaryKey } from 'drizzle-orm/pg-core';
import { defineDualTable } from '@makaio/storage-drizzle';

/**
 * Durable execution-attempt facts.
 *
 * These tables are owner-agnostic. `execution_id` is a caller-supplied owner
 * key, so it intentionally has no foreign key to owner-specific storage.
 * JSON payloads and ISO-8601 instants remain text to preserve their exact
 * durable representations across both dialects.
 */
export const executionAttemptsDual = defineDualTable(
  'execution_attempt',
  (c) => ({
    executionAttemptId: c.text('execution_attempt_id').primaryKey(),
    executionId: c.text('execution_id').notNull(),
    instruction: c.text('instruction').notNull(),
    preparationReceipts: c.text('preparation_receipts').notNull().default('[]'),
    status: c.text('status').notNull(),
    providerId: c.text('provider_id'),
    allocationLifetime: c.text('allocation_lifetime'),
    provisionerIncarnationId: c.text('provisioner_incarnation_id'),
    allocationRef: c.text('allocation_ref'),
    settlementKind: c.text('settlement_kind'),
    outcomeText: c.text('outcome_text'),
    outcomeControlObservation: c.text('outcome_control_observation'),
    claimable: c.int4('claimable').notNull().default(0),
    claimExpiresAt: c.text('claim_expires_at'),
    createdAt: c.text('created_at').notNull(),
    bootstrapDeadlineAt: c.text('bootstrap_deadline_at'),
    runtimeGeneration: c.int4('runtime_generation').notNull().default(0),
    runtimeIncarnationId: c.text('runtime_incarnation_id'),
    runtimeReadyAt: c.text('runtime_ready_at'),
    operationStartGate: c.text('operation_start_gate').notNull().default('open'),
    activeOperationId: c.text('active_operation_id'),
    activeOperationKind: c.text('active_operation_kind'),
    activeOperationKey: c.text('active_operation_key'),
    activeOperationGeneration: c.int4('active_operation_generation'),
    activeOperationAdmittedAt: c.text('active_operation_admitted_at'),
    lastCompletedOperationId: c.text('last_completed_operation_id'),
  }),
  {
    sqlite: (t) => [index('idx_execution_attempt_recovery').on(t.executionId, t.createdAt, t.executionAttemptId)],
    postgres: (t) => [pgIndex('idx_execution_attempt_recovery').on(t.executionId, t.createdAt, t.executionAttemptId)],
  },
);

/** Active attempt pointer for each generic execution owner. */
export const activeExecutionAttemptsDual = defineDualTable('active_execution_attempt', (c) => ({
  executionId: c.text('execution_id').primaryKey(),
  executionAttemptId: c
    .text('execution_attempt_id')
    .notNull()
    .references(() => executionAttemptsDual.columnPair('executionAttemptId')),
}));

/** Idempotency binding from an owner request to its execution attempt. */
export const executionAttemptRequestsDual = defineDualTable(
  'execution_attempt_request',
  (c) => ({
    executionId: c.text('execution_id').notNull(),
    requestKey: c.text('request_key').notNull(),
    executionAttemptId: c
      .text('execution_attempt_id')
      .notNull()
      .references(() => executionAttemptsDual.columnPair('executionAttemptId')),
  }),
  {
    sqlite: (t) => [primaryKey({ columns: [t.executionId, t.requestKey] })],
    postgres: (t) => [pgPrimaryKey({ columns: [t.executionId, t.requestKey] })],
  },
);

/** Provider operation claim and completion fact for one execution attempt. */
export const providerOperationsDual = defineDualTable('provider_operation', (c) => ({
  executionAttemptId: c
    .text('execution_attempt_id')
    .primaryKey()
    .references(() => executionAttemptsDual.columnPair('executionAttemptId')),
  generation: c.int4('generation').notNull(),
  ownerId: c.text('owner_id'),
  token: c.text('token'),
  leaseExpiresAt: c.text('lease_expires_at'),
  obligation: c.text('obligation').notNull(),
  failureCount: c.int4('failure_count').notNull().default(0),
  lastFailure: c.text('last_failure'),
  completionEvidence: c.text('completion_evidence'),
}));

/** Cancellation intent recorded for one execution attempt. */
export const executionAttemptCancellationsDual = defineDualTable('execution_attempt_cancellation', (c) => ({
  executionAttemptId: c.text('execution_attempt_id').primaryKey(),
  requestKey: c.text('request_key').notNull(),
  controlRevision: c.int4('control_revision').notNull(),
  requestedAt: c.text('requested_at').notNull(),
  reason: c.text('reason'),
}));

/** Runtime-scoped receipts and reports for a cancellation control revision. */
export const executionAttemptControlEvidenceDual = defineDualTable(
  'execution_attempt_control_evidence',
  (c) => ({
    executionAttemptId: c.text('execution_attempt_id').notNull(),
    controlRevision: c.int4('control_revision').notNull(),
    runtimeGeneration: c.int4('runtime_generation').notNull(),
    receiptJson: c.text('receipt_json'),
    reportJson: c.text('report_json'),
  }),
  {
    sqlite: (t) => [primaryKey({ columns: [t.executionAttemptId, t.controlRevision, t.runtimeGeneration] })],
    postgres: (t) => [pgPrimaryKey({ columns: [t.executionAttemptId, t.controlRevision, t.runtimeGeneration] })],
  },
);

/** SQLite face of the `execution_attempt` table. */
export const executionAttempts = executionAttemptsDual.sqlite;
/** SQLite face of the `active_execution_attempt` table. */
export const activeExecutionAttempts = activeExecutionAttemptsDual.sqlite;
/** SQLite face of the `execution_attempt_request` table. */
export const executionAttemptRequests = executionAttemptRequestsDual.sqlite;
/** SQLite face of the `provider_operation` table. */
export const providerOperations = providerOperationsDual.sqlite;
/** SQLite face of the `execution_attempt_cancellation` table. */
export const executionAttemptCancellations = executionAttemptCancellationsDual.sqlite;
/** SQLite face of the `execution_attempt_control_evidence` table. */
export const executionAttemptControlEvidence = executionAttemptControlEvidenceDual.sqlite;

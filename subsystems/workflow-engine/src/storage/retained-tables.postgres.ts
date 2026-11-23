/**
 * Postgres faces of the tables declared in `./retained-tables.ts` for the same migration generator exception.
 */
import {
  workflowGateInstancesDual,
  worklogGateEventsDual,
  executionAttemptsDual,
  activeExecutionAttemptsDual,
  executionAttemptRequestsDual,
  providerOperationsDual,
  executionAttemptCancellationsDual,
  executionAttemptControlEvidenceDual,
} from './retained-tables.js';

/** Postgres face of the `workflow_gate_instances` table. */
export const workflowGateInstances = workflowGateInstancesDual.postgres;

/** Postgres face of the `worklog_gate_events` table. */
export const worklogGateEvents = worklogGateEventsDual.postgres;

/** Postgres face of the `execution_attempt` table. */
export const executionAttempts = executionAttemptsDual.postgres;
/** Postgres face of the `active_execution_attempt` table. */
export const activeExecutionAttempts = activeExecutionAttemptsDual.postgres;
/** Postgres face of the `execution_attempt_request` table. */
export const executionAttemptRequests = executionAttemptRequestsDual.postgres;
/** Postgres face of the `provider_operation` table. */
export const providerOperations = providerOperationsDual.postgres;
/** Postgres face of the `execution_attempt_cancellation` table. */
export const executionAttemptCancellations = executionAttemptCancellationsDual.postgres;
/** Postgres face of the `execution_attempt_control_evidence` table. */
export const executionAttemptControlEvidence = executionAttemptControlEvidenceDual.postgres;

/**
 * Workflow execution engine for Makaio.
 *
 * Provides:
 * - Persisted execution frames for static workflow primitive topology
 * - Workflow-level execution delegation through the IWorkflowRunner runtime seam
 * - Workflow expression context from inputs, trigger payloads, node outputs, and iteration item/index overlays
 * - OTel-style span records for node duration and usage ingestion
 * - Durable gate state through workflow execution checkpoints
 * @packageDocumentation
 */

export { WorkflowExecutor } from './workflow-executor.js';
export { WorkflowEngineService } from './workflow-engine-service.js';
export type { WorkflowEngineServiceOptions } from './workflow-engine-service.js';
export type {
  WorkflowMaterializationSpecResolution,
  WorkflowMaterializationSpecResolver,
  WorkflowWorkspaceRootResolver,
} from './types.js';
export type { WorkflowSuccessFinalizer } from './workflow-execution-finalizer.js';
export { ExecutionAttemptAuthority } from './execution-attempt-authority.js';
export { runAuthorityDispatchedAttempt } from './authority-dispatch-runner.js';
export type { AuthorityDispatchRunnerOptions } from './authority-dispatch-runner.js';
export {
  DuplicateExecutionAttemptError,
  EXECUTION_ATTEMPT_STATUSES,
  EXECUTION_ATTEMPT_SETTLEMENT_KINDS,
  sameAllocationRef,
  sameWorkflowResult,
} from './execution-attempt-repository.js';
export type {
  ExecutionAttemptRecoveryOperations,
  ExecutionAttemptRepository,
  ExecutionAttemptRecord,
  RecoverableAttemptRecord,
  ExecutionAttemptCreate,
  ExecutionAttemptOutcomeCommit,
  ExecutionAttemptOutcomeDecision,
  ExecutionAttemptStatus,
  ExecutionAttemptSettlementKind,
  AllocationRefEvolution,
  AllocationRefEvolutionDecision,
  AllocationRecordingDecision,
  AllocationTerminationDecision,
  BeginProvisioningInput,
  DiscoveredAllocationDecision,
  HandoffProviderOperationInput,
  InfrastructureFailureDecision,
  PendingAttemptAbandonmentDecision,
  ProvisionerIncarnationLossDecision,
  ProvisioningAbsenceDecision,
  ProvisioningClaimDecision,
  RecordAllocationInput,
  RecordAllocationTerminatedInput,
  RecordInfrastructureFailureInput,
  RecordProviderOperationUncertaintyInput,
  RecordProvisionerIncarnationLostInput,
  RecordProvisioningAbsentInput,
  RenewProviderOperationClaimInput,
  TakeOverProviderOperationInput,
} from './execution-attempt-repository.js';
export { PROVIDER_OPERATION_OBLIGATIONS } from './provider-operation.js';
export type {
  InitialProviderOperationClaimContext,
  InitialProviderOperationClaimContextSource,
  ProcessBoundProvisionerLossProof,
  ProviderOperationClaim,
  ProviderOperationClaimDecision,
  ProviderOperationMutationDecision,
  ProviderOperationObligation,
  ProviderOperationOwnershipRecord,
} from './provider-operation.js';
export { WorkflowEngineToken, workflowEnginePackage, createWorkflowEnginePackage } from './package.js';
export { WorkflowStorageNamespace, WorkflowStorageSubjects } from './storage/namespace.js';
export { registerDrizzleWorkflowStorage } from './storage/handler.js';
export { runShellStep } from './executor-helpers.js';
export { buildWorkflowExpressionContextFromResolvedInputs } from './workflow-expression-context.js';
export {
  workflowDefinitionsDual,
  workflowExecutionsDual,
  workflowFinalizationsDual,
  workflowStepSpansDual,
  worklogSummariesDual,
  worklogFrameEntriesDual,
  workflowExecutionStateDual,
  workflowExecutionStateEventsDual,
} from './storage/schema.js';
export { initializeWorkflowState, getWorkflowState, patchWorkflowState } from './storage/state-handler.js';

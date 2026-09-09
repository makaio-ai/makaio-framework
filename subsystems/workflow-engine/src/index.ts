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
export { WorkflowTriggerReconciler } from './workflow-trigger-reconciler.js';
export {
  compileWorkflowTriggerBindingFilter,
  assertWorkflowTriggerPayload,
} from './workflow-trigger-binding-consumer.js';
export type { WorkflowTriggerPayloadPredicate } from './workflow-trigger-binding-consumer.js';
export { WorkflowEngineService } from './workflow-engine-service.js';
export type { WorkflowEngineServiceOptions } from './workflow-engine-service.js';
export type {
  WorkflowMaterializationSpecResolution,
  WorkflowMaterializationSpecResolver,
  WorkflowWorkspaceRootResolver,
} from './types.js';
export type { WorkflowSuccessFinalizer } from './workflow-execution-finalizer.js';
export { ExecutionAttemptAuthority } from './execution-attempt-authority.js';
export { resolveExecutionAttemptPeer } from './execution-bound-access.js';
export type { ExecutionAttemptPeerIdentity } from './execution-bound-access.js';
export { registerExecutionAttemptHandlers } from './execution-attempt-handlers.js';
export type { AttemptOutcomeDecodingInput, ExecutionAttemptHandlersDeps } from './execution-attempt-handlers.js';
export {
  WORKFLOW_WORKLOAD_KIND,
  WORKFLOW_WORKLOAD_VERSION,
  WorkflowInvocationInputSchema,
  buildWorkflowAttemptInstruction,
  parseWorkflowAttemptInstruction,
} from './workflow-attempt-instruction.js';
export type {
  BuildWorkflowAttemptInstructionOptions,
  WorkflowInvocationInput,
} from './workflow-attempt-instruction.js';
export {
  WorkflowAttemptOutcomeSchema,
  workflowAttemptOutcomeCodec,
  decodeWorkflowAttemptOutcome,
  toCommittedWorkflowRunnerResult,
  toCommittedWorkflowRunnerCompletion,
} from './workflow-attempt-outcome.js';
export type {
  WorkflowAttemptOutcome,
  WorkflowAttemptTechnicalFailure,
  WorkflowAttemptCancellation,
  CommittedWorkflowOutcomeIdentity,
} from './workflow-attempt-outcome.js';
export {
  registerRuntimeRegistrationHandler,
  RUNTIME_PROBE_DELIVERY_TIMEOUT_MS,
} from './runtime-registration.js';
export type { RuntimeRegistrationDeps } from './runtime-registration.js';
export { registerOperationAdmissionHandler } from './operation-admission.js';
export { registerBootstrapStartHandler } from './bootstrap-start-handler.js';
export type { OperationAdmissionDeps } from './operation-admission.js';
export { runAuthorityDispatchedAttempt } from './authority-dispatch-runner.js';
export type { AuthorityDispatchRunnerOptions } from './authority-dispatch-runner.js';
export { submitAttemptOutcome } from './outcome-convergence.js';
export type {
  AcceptedAttemptOutcome,
  OutcomeAcceptance,
  AttemptOutcomeSubmission,
  AttemptOutcomeSubmissionDeps,
  OutcomeConvergence,
  OutcomeConvergenceInput,
  OutcomePreCommitValidation,
} from './outcome-convergence.js';
export {
  ATTEMPT_OPERATION_START_GATES,
  DuplicateExecutionAttemptError,
  RuntimeOutcomeFenceMismatchError,
  assertRuntimeOutcomeFence,
  EXECUTION_ATTEMPT_STATUSES,
  EXECUTION_ATTEMPT_SETTLEMENT_KINDS,
  decodeDurableOutcome,
  durableOutcome,
  sameAllocationRef,
  sameDurableOutcome,
  evaluateAttemptReachability,
  evaluateProvisionerIncarnationLoss,
  evaluateRuntimeRegistration,
  evaluateOperationAdmission,
  evaluateOperationCompletion,
  evaluateRuntimeReadiness,
  evaluateAttemptCancellation,
  snapshotAttemptOutcomeControl,
  snapshotRequestAttemptCancellationInput,
  snapshotRequestExecutionCancellationInput,
} from './execution-attempt-repository.js';
export {
  snapshotEnsureExecutionAttemptInput,
  snapshotEnsureExecutionAttemptPersistenceInput,
  snapshotReadAttemptSettlementInput,
  replayEnsuredAttempt,
  readAttemptSettlementSnapshot,
} from './execution-attempt-owner-recovery.js';
export type {
  AttemptReachability,
  AttemptReachabilityDecision,
  AdmitOperationInput,
  AttemptControlState,
  BootstrapStartState,
  ReadBootstrapStartStateInput,
  AttemptOperationStartGate,
  CompleteOperationInput,
  DurableOutcome,
  ExecutionOwnerId,
  MarkRuntimeReadyInput,
  OperationAdmissionDecision,
  OperationCompletionDecision,
  OutcomeCodec,
  RegisterRuntimeInput,
  RuntimeReadinessDecision,
  RuntimeOutcomeFence,
  RuntimeRegistrationDecision,
  ExecutionAttemptRecoveryOperations,
  ExecutionAttemptRepository,
  ExecutionAttemptCancellationIntent,
  ExecutionAttemptCancellationDecision,
  RequestAttemptCancellationInput,
  RequestExecutionCancellationInput,
  AttemptOutcomeControlObservation,
  ExecutionAttemptRecord,
  RecoverableAttemptRecord,
  ExecutionAttemptCreate,
  EnsureExecutionAttemptInput,
  EnsureExecutionAttemptPersistenceInput,
  EnsureExecutionAttemptDecision,
  ReadAttemptSettlementInput,
  AttemptSettlementRead,
  AttemptSettlementSnapshot,
  ExecutionAttemptOutcomeCommit,
  ExecutionAttemptOutcomeDecision,
  ExecutionAttemptStatus,
  ExecutionAttemptSettlementKind,
  AllocationRefEvolution,
  AllocationRefEvolutionDecision,
  AllocationRecordingDecision,
  AllocationTerminationDecision,
  BeginProvisioningInput,
  CompleteProviderOperationInput,
  DiscoveredAllocationDecision,
  HandoffProviderOperationInput,
  InfrastructureFailureDecision,
  ListOpenProviderOperationsInput,
  OpenProviderOperationRecord,
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
export { isProviderOperationResolved, PROVIDER_OPERATION_OBLIGATIONS } from './provider-operation.js';
export type {
  InitialProviderOperationClaimContext,
  InitialProviderOperationClaimContextSource,
  ProviderOperationLeasePolicy,
  ProviderOperationLeaseRenewal,
  ProcessBoundProvisionerLossProof,
  ProviderOperationClaim,
  ProviderOperationClaimDecision,
  ProviderOperationCompletionDecision,
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
export type { BootstrapStartAuthority, BootstrapStartOptions } from './bootstrap-start.js';

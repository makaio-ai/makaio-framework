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
export type { WorkflowSuccessFinalizer } from './workflow-execution-finalizer.js';
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
export {
  initializeWorkflowState,
  getWorkflowState,
  patchWorkflowState,
} from './storage/state-handler.js';

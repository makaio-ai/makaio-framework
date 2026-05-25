/**
 * Workflow execution engine for Makaio.
 *
 * Provides:
 * - Mutable DAG scheduler with persisted runtime for-each expansion snapshots
 * - Workflow-level execution delegation through the IWorkflowRunner runtime seam
 * - Workflow expression context from inputs, trigger payloads, step results, and for-each item/index overlays
 * - OTel-style span records for step duration and future usage ingestion
 * - Durable gate state through workflow execution checkpoints
 * @packageDocumentation
 */

export { WorkflowExecutor } from './workflow-executor.js';
export { WorkflowEngineService } from './workflow-engine-service.js';
export { WorkflowEngineToken, workflowEnginePackage, createWorkflowEnginePackage } from './package.js';
export { WorkflowStorageNamespace, WorkflowStorageSubjects } from './storage/namespace.js';
export { registerDrizzleWorkflowStorage } from './storage/handler.js';
export { runShellStep } from './executor-helpers.js';
export { buildWorkflowExpressionContextFromResolvedInputs } from './workflow-expression-context.js';

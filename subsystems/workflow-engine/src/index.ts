/**
 * Workflow execution engine for Makaio.
 *
 * Provides:
 * - Mutable DAG scheduler with persisted runtime for-each expansion snapshots
 * - Pluggable in-process step execution through the IStepRunner seam
 * - Workflow expression context from inputs, trigger payloads, step results, and for-each item/index overlays
 * - OTel-style span records for step duration and future usage ingestion
 * - Durable gate state through workflow execution checkpoints
 * @packageDocumentation
 */

export { WorkflowNamespace, WorkflowSchemas, WorkflowSubjects } from './namespace.js';
export { WorkflowExecutor } from './workflow-executor.js';
export { WorkflowEngineService } from './workflow-engine-service.js';
export { WorkflowEngineToken, workflowEnginePackage, createWorkflowEnginePackage } from './package.js';
export type { WorkflowEngineServiceOptions } from './workflow-engine-service.js';
export { WorkflowStorageNamespace, WorkflowStorageSubjects } from './storage/namespace.js';
export { registerDrizzleWorkflowStorage } from './storage/handler.js';
export { runShellStep, spawnProcess } from './executor-helpers.js';
export type { RunShellStepOptions, SpawnProcessOptions, ShellStepOutcome } from './executor-helpers.js';
export type { ActiveExecution, ActiveRunnerStep, ExecutorConfig } from './types.js';
export type {
  ContextBundle,
  ContextPublishTarget,
  ContextSource,
  ExecutionLink,
  ExecutionLinkType,
  IStepRunner,
  SpanRecord,
  StepRunConfig,
  StepRunResult,
  StepTelemetry,
  WorkflowStepType,
} from '@makaio/contracts';

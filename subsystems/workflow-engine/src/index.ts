/**
 * Workflow execution engine for Makaio.
 *
 * Provides:
 * - DAG interpreter with checkpoint-based crash recovery
 * - Pluggable StepRunners (Piscina, Docker, Lambda)
 * - Context resolution (pull) and publication (push) pipelines
 * - OTel-style span tracing for cost and performance tracking
 * - Durable gates via DB-backed bus listeners
 * @packageDocumentation
 */

export { WorkflowNamespace, WorkflowSchemas, WorkflowSubjects } from './namespace.js';
export { WorkflowExecutor } from './workflow-executor.js';
export { WorkflowEngineService } from './workflow-engine-service.js';
export { WorkflowEngineToken, workflowEnginePackage } from './package.js';
export { WorkflowStorageNamespace, WorkflowStorageSubjects } from './storage/namespace.js';
export { registerDrizzleWorkflowStorage } from './storage/handler.js';
export type { ActiveExecution, ExecutorConfig } from './types.js';
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

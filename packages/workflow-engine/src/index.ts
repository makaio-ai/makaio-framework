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

// Re-export contract types for convenience
export type {
  IStepRunner,
  StepRunConfig,
  StepRunResult,
  StepTelemetry,
  WorkflowStepType,
  SpanRecord,
  ExecutionLink,
  ExecutionLinkType,
  ContextSource,
  ContextPublishTarget,
  ContextBundle,
} from '@makaio/contracts';

import type { CompositeStepState, JsonValue, StepStatus } from '@makaio/contracts';

/** Generic variable map exposed to jexl expression evaluation and template interpolation. */
export type ExpressionContext = Record<string, unknown>;

/** Step statuses exposed to workflow expressions. */
export type ExpressionStepStatus = StepStatus | CompositeStepState['status'];

/** Workflow evaluation context for jexl expressions and \{\{ \}\} template interpolation. */
export interface WorkflowExpressionContext extends ExpressionContext {
  /** Trigger payload that started the workflow. */
  trigger: Record<string, unknown>;
  /**
   * All steps that have started (running/completed/failed/skipped).
   * Pending steps are excluded.
   * `result` is undefined for non-completed steps. For completed steps,
   * it holds the JSON-serializable value produced by the step.
   */
  steps: Record<string, { result?: JsonValue; status: ExpressionStepStatus }>;
  /** Workflow input values. */
  inputs: Record<string, unknown>;
  /** Current item in a for-each iteration. Only present inside for-each scope. */
  item?: unknown;
  /** Current index in a for-each iteration. Only present inside for-each scope. */
  index?: number;
}

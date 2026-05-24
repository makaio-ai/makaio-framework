import type { CompositeStepState, StepStatus } from '@makaio/contracts';

/** Step statuses exposed to workflow expressions. */
export type ExpressionStepStatus = StepStatus | CompositeStepState['status'];

/** Evaluation context for jexl expressions and \{\{ \}\} template interpolation. */
export interface ExpressionContext {
  /** Trigger payload that started the workflow. */
  trigger: Record<string, unknown>;
  /**
   * All steps that have started (running/completed/failed/skipped).
   * Pending steps are excluded.
   * `result` is undefined for non-completed steps.
   */
  steps: Record<string, { result?: string; status: ExpressionStepStatus }>;
  /** Workflow input values. */
  inputs: Record<string, unknown>;
  /** Current item in a for-each iteration. Only present inside for-each scope. */
  item?: unknown;
  /** Current index in a for-each iteration. Only present inside for-each scope. */
  index?: number;
}

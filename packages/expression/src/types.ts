import type { JsonValue, WorkflowFrameState } from '@makaio/contracts';

/** Generic variable map exposed to jexl expression evaluation and template interpolation. */
export type ExpressionContext = Record<string, unknown>;

/**
 * Frame execution status exposed to workflow expressions.
 *
 * Mirrors `WorkflowFrameState['status']` so expression conditions can reference
 * the full frame status set without coupling to the runtime types.
 */
export type ExpressionStepStatus = WorkflowFrameState['status'];

/** Workflow evaluation context for jexl expressions and \{\{ \}\} template interpolation. */
export interface WorkflowExpressionContext extends ExpressionContext {
  /** Trigger payload that started the workflow. */
  trigger: Record<string, unknown>;
  /**
   * All frames that have started (running/completed/failed/skipped/etc).
   * Pending frames are excluded.
   * `result` is undefined for non-completed frames. For completed frames,
   * it holds the JSON-serializable value produced by the node.
   */
  steps: Record<string, { result?: JsonValue; status: ExpressionStepStatus }>;
  /** Workflow input value. */
  inputs: JsonValue;
  /** Current item in a for-each iteration. Only present inside for-each scope. */
  item?: unknown;
  /** Current index in a for-each iteration. Only present inside for-each scope. */
  index?: number;
}

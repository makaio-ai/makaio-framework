import { JsonValueSchema, WorkflowFrameStateSchema } from '@makaio/contracts';
import type { JsonValue } from '@makaio/contracts';
import type { WorkflowExpressionContext } from '@makaio/expression';

/**
 * All valid frame execution statuses that may appear in expression contexts.
 * Derived from `WorkflowFrameStateSchema` to stay in sync with the schema.
 */
const WORKFLOW_EXPRESSION_STEP_STATUSES = new Set<string>([...WorkflowFrameStateSchema.shape.status.options]);

/**
 * Check whether a value is a non-array object record.
 * @param value - Value to test.
 * @returns True when the value can be indexed safely.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check whether a value matches the workflow expression `steps` map.
 * @param value - Candidate `steps` field from serialized runner inputs.
 * @returns True when every entry has a string status and optional JSON-safe result.
 */
function isWorkflowExpressionSteps(value: unknown): value is WorkflowExpressionContext['steps'] {
  if (!isRecord(value)) return false;

  for (const stepState of Object.values(value)) {
    if (
      !isRecord(stepState) ||
      typeof stepState['status'] !== 'string' ||
      !WORKFLOW_EXPRESSION_STEP_STATUSES.has(stepState['status'])
    ) {
      return false;
    }
    if (
      'result' in stepState &&
      stepState['result'] !== undefined &&
      !JsonValueSchema.safeParse(stepState['result']).success
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Rehydrate a workflow expression context from serialized runner inputs.
 * @param resolvedInputs - Serializable runner inputs produced from a workflow expression context.
 * @returns Workflow expression context with required root maps present.
 */
export function buildWorkflowExpressionContextFromResolvedInputs(
  resolvedInputs: Record<string, unknown>,
): WorkflowExpressionContext {
  const context: WorkflowExpressionContext = {
    trigger: isRecord(resolvedInputs['trigger']) ? resolvedInputs['trigger'] : {},
    steps: isWorkflowExpressionSteps(resolvedInputs['steps']) ? resolvedInputs['steps'] : {},
    inputs: JsonValueSchema.safeParse(resolvedInputs['inputs']).success ? (resolvedInputs['inputs'] as JsonValue) : {},
  };

  if ('item' in resolvedInputs) {
    context.item = resolvedInputs['item'];
  }
  if (typeof resolvedInputs['index'] === 'number') {
    context.index = resolvedInputs['index'];
  }

  return context;
}

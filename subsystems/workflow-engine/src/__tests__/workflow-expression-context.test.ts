import { describe, expect, it } from 'vitest';
import { buildWorkflowExpressionContextFromResolvedInputs } from '../workflow-expression-context.js';

describe('buildWorkflowExpressionContextFromResolvedInputs', () => {
  it('preserves executable and composite step statuses from serialized inputs', () => {
    const context = buildWorkflowExpressionContextFromResolvedInputs({
      trigger: {},
      inputs: {},
      steps: {
        lint: { status: 'completed', result: 'ok' },
        fanout: { status: 'expanding' },
        cleanup: { status: 'cancelled' },
      },
    });

    expect(context.steps).toEqual({
      lint: { status: 'completed', result: 'ok' },
      fanout: { status: 'expanding' },
      cleanup: { status: 'cancelled' },
    });
  });

  it('drops the serialized steps map when a step status is outside the workflow status domain', () => {
    const context = buildWorkflowExpressionContextFromResolvedInputs({
      trigger: {},
      inputs: {},
      steps: {
        lint: { status: 'complete', result: 'ok' },
      },
    });

    expect(context.steps).toEqual({});
  });
});

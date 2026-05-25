import { describe, expect, expectTypeOf, it } from 'vitest';
import type { JsonValue } from '../../shared/index.js';
import type { WorkflowRunResult } from '../worker.js';

describe('WorkflowRunResult', () => {
  it('types output as JSON-safe data', () => {
    expectTypeOf<WorkflowRunResult['output']>().toEqualTypeOf<JsonValue | undefined>();

    const result: WorkflowRunResult = {
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      status: 'completed',
      output: { approved: true },
    };

    expect(result.output).toEqual({ approved: true });
  });
});

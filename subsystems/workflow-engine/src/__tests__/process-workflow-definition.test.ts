import { describe, expect, it } from 'vitest';
import { defineWorkflow, WorkflowAgentStepNodeSchema, WorkflowErrorCode, type JsonValue } from '@makaio/contracts';
import { assertProcessWorkflowSupported } from '../runtime/process-workflow-definition.js';
import { resolveStepOutputValidator } from '../runtime/step-output-validation.js';

describe('process workflow admission', () => {
  it('rejects an agent step whose omitted completion mode defaults to tool completion', () => {
    const workflow = defineWorkflow('review').agentStep('review', 'reviewer', {
      prompt: 'Review the draft',
      outputSchema: { type: 'object' },
    });

    expect(() => assertProcessWorkflowSupported(workflow.definition)).toThrow(
      expect.objectContaining({ code: WorkflowErrorCode.AGENT_STEP_UNSUPPORTED }),
    );
  });

  it.each<Record<string, JsonValue>>([
    { $schema: 'https://example.invalid/unknown-schema', type: 'object' },
    { $schema: false, type: 'object' },
    { type: 'unknown-type' },
    { $async: true, type: 'object' },
  ])('rejects invalid structured output schemas at admission (%j)', (outputSchema) => {
    const workflow = defineWorkflow('review').agentStep('review', 'reviewer', {
      prompt: 'Review the draft',
      outputSchema,
      completion: 'turn',
    });

    expect(() => assertProcessWorkflowSupported(workflow.definition)).toThrow(
      expect.objectContaining({
        code: WorkflowErrorCode.STEP_OUTPUT_SCHEMA_INVALID,
        message: expect.stringContaining('review'),
      }),
    );
  });

  it('rejects tool offers until they have runtime behavior', () => {
    const result = WorkflowAgentStepNodeSchema.safeParse({
      id: 'review',
      type: 'agent-step',
      role: 'reviewer',
      prompt: 'Review the draft',
      offers: ['inspect'],
    });
    expect(result.success).toBe(false);
  });
});

describe('workflow step result schema validation', () => {
  it.each([
    'https://json-schema.org/draft/2019-09/schema',
    'https://json-schema.org/draft/2019-09/schema#',
    'https://json-schema.org/draft/2020-12/schema#',
  ])('validates output against the declared JSON Schema dialect %s', ($schema) => {
    const step = WorkflowAgentStepNodeSchema.parse({
      id: 'review',
      type: 'agent-step',
      role: 'reviewer',
      prompt: 'Review the draft',
      completion: 'turn',
      outputSchema: {
        $schema,
        type: 'object',
        properties: { approved: { type: 'boolean' } },
        required: ['approved'],
        unevaluatedProperties: false,
      },
    });
    const validate = resolveStepOutputValidator(step);
    expect(validate?.({ approved: true })).toBe(true);
    expect(validate?.({ approved: false, extra: 'unknown' })).toBe(false);
  });
});

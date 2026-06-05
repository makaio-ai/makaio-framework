import { describe, expect, it } from 'vitest';
import { WorkflowBlocksSchemas } from '../schemas.js';

const StepMetadata = {
  name: 'review.step',
  label: 'Review Step',
  description: 'Runs a review step.',
  extensionName: 'review',
};

describe('WorkflowBlocksSchemas', () => {
  it('includes step block runs metadata in list responses', () => {
    const response = WorkflowBlocksSchemas.list.response.parse({
      triggers: [],
      steps: [
        {
          metadata: StepMetadata,
          configSchema: { type: 'object' },
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          runs: {
            type: 'station',
            prompt: 'Review {{ input.target }}',
            timeoutMs: 1,
          },
        },
      ],
    });

    expect(response.steps[0]?.runs).toEqual({
      type: 'station',
      prompt: 'Review {{ input.target }}',
      timeoutMs: 1,
    });
  });

  it('rejects zero timeout values that primitive nodes cannot execute', () => {
    expect(() =>
      WorkflowBlocksSchemas.list.response.parse({
        triggers: [],
        steps: [
          {
            metadata: StepMetadata,
            configSchema: { type: 'object' },
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
            runs: {
              type: 'delegate-role',
              role: 'reviewer',
              prompt: 'Review',
              timeoutMs: 0,
            },
          },
        ],
      }),
    ).toThrow();
  });
});

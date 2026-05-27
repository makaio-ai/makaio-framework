import { describe, expect, it } from 'vitest';
import type { WorkflowWorkerConfig } from '@makaio/contracts';
import { loadWorkflowFromConfig } from '../workflow-loader.js';

/**
 * Build a minimal {@link WorkflowWorkerConfig} for loader integration tests.
 * @param overrides - Optional config overrides.
 * @returns Valid worker config stub.
 */
function makeConfig(overrides: Partial<WorkflowWorkerConfig> = {}): WorkflowWorkerConfig {
  return {
    source: { kind: 'definition', workflowId: 'wf-loader-001' },
    executionId: 'exec-loader-001',
    workflowId: 'wf-loader-001',
    triggerPayload: {},
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    context: {
      repoPath: '/repo',
      makaioHome: '/home/.makaio',
      os: 'linux',
      arch: 'x64',
    },
    env: {},
    coordinatorSessionId: 'session-loader-001',
    cancelSubject: 'workflow.cancel.wf-loader-001',
    ...overrides,
  };
}

describe('loadWorkflowFromConfig integration', () => {
  it('loads source-backed workflow modules through the real file loader', async () => {
    const source = `
const definition = {
  id: 'wf-source-001',
  name: 'Source Workflow',
  steps: [],
  triggers: [],
  scope: { type: 'global' },
};

export default {
  definition,
  runtimeSteps: new Map(),
};
`;

    const loaded = await loadWorkflowFromConfig(
      makeConfig({
        source: { kind: 'source', filename: 'source-workflow.mjs', source },
      }),
    );

    expect(loaded.definition).toEqual({
      id: 'wf-source-001',
      name: 'Source Workflow',
      steps: [],
      triggers: [],
      scope: { type: 'global' },
    });
    expect(loaded.runtimeSteps).toBeInstanceOf(Map);
    expect(loaded.runtimeSteps.size).toBe(0);
  });
});

import type { WorkflowWorkerConfig } from '@makaio/contracts';

/**
 * Create a minimal {@link WorkflowWorkerConfig} for testing.
 *
 * Provides sensible defaults for all required fields. Pass `overrides` to
 * specialise individual properties without repeating the full fixture.
 * @param overrides - Partial config fields merged on top of defaults.
 * @returns A valid WorkflowWorkerConfig stub.
 */
export function makeWorkerConfig(overrides?: Partial<WorkflowWorkerConfig>): WorkflowWorkerConfig {
  return {
    source: { kind: 'definition', workflowId: 'workflow-1' },
    executionId: 'wfx-1',
    workflowId: 'workflow-1',
    triggerPayload: {},
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    context: { repoPath: '/repo', makaioHome: '/home/.makaio', os: 'linux', arch: 'x64' },
    env: {},
    coordinatorSessionId: 'session-1',
    cancelSubject: 'workflow.wfx-1.cancel',
    suspensionStrategy: 'wait-in-process',
    ...overrides,
  };
}

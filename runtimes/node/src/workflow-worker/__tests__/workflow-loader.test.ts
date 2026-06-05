import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  WorkflowDefinition,
  WorkflowGateNode,
  WorkflowStationNode,
  WorkflowWorkerConfig,
} from '@makaio/contracts';

// ---------------------------------------------------------------------------
// Mocks — declared before dynamic imports
// ---------------------------------------------------------------------------

const mockLoadWorkflowModule = vi.fn();

vi.mock('../workflow-file-loader.js', () => ({
  loadWorkflowModule: mockLoadWorkflowModule,
}));

// Import after mocking
const { loadWorkflowFromConfig } = await import('../workflow-loader.js');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal {@link WorkflowDefinition} for testing.
 * @param overrides - Partial overrides merged on top of defaults.
 * @returns A valid WorkflowDefinition stub.
 */
function makeDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-001',
    name: 'Test Workflow',
    root: { id: 'wf-001__root', type: 'sequence', nodes: [] },
    scope: { type: 'global' as const },
    ...overrides,
  };
}

/**
 * Build a minimal {@link WorkflowWorkerConfig} for testing.
 * @param overrides - Partial overrides merged on top of defaults.
 * @returns A valid WorkflowWorkerConfig stub.
 */
function makeConfig(overrides: Partial<WorkflowWorkerConfig> = {}): WorkflowWorkerConfig {
  return {
    source: { kind: 'definition', workflowId: 'wf-001' },
    executionId: 'exec-001',
    workflowId: 'wf-001',
    triggerPayload: {},
    inputs: {},
    scope: { type: 'global' as const },
    busAuth: { kind: 'none' },
    context: {
      repoPath: '/repo',
      makaioHome: '/home/.makaio',
      os: 'linux',
      arch: 'x64',
    },
    env: {},
    coordinatorSessionId: 'session-001',
    cancelSubject: 'workflow.cancel.wf-001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadWorkflowFromConfig — definition kind
// ---------------------------------------------------------------------------

describe('loadWorkflowFromConfig — definition source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a LoadedWorkflow in-place from the definition without calling the file loader', async () => {
    const definition = makeDefinition();
    const config = makeConfig({ definition });

    const loaded = await loadWorkflowFromConfig(config);

    expect(loaded.definition).toBe(definition);
    expect(loaded.runtimeHandlers).toBeInstanceOf(Map);
    expect(loaded.runtimeHandlers.size).toBe(0);
    expect(mockLoadWorkflowModule).not.toHaveBeenCalled();
  });

  it('throws when definition is absent for a definition-sourced config', async () => {
    const config = makeConfig({ source: { kind: 'definition', workflowId: 'missing-def' } });
    // definition intentionally omitted

    await expect(loadWorkflowFromConfig(config)).rejects.toThrow(
      `Definition-sourced worker config for workflowId "missing-def" is missing the required 'definition' field.`,
    );
    expect(mockLoadWorkflowModule).not.toHaveBeenCalled();
  });

  it('returns an empty runtimeHandlers map for pipeline-primitive definitions', async () => {
    const definition = makeDefinition({
      root: {
        id: 'root',
        type: 'sequence',
        nodes: [
          { id: 'analyze', type: 'station' as const, prompt: 'Analyze' } as WorkflowStationNode,
          {
            id: 'gate-1',
            type: 'gate' as const,
            prompt: 'Approve?',
            autoAction: 'reject' as const,
            timeoutMs: null,
          } as WorkflowGateNode,
        ],
      },
    });
    const config = makeConfig({ definition });

    const loaded = await loadWorkflowFromConfig(config);

    // Pipeline-primitive definitions are fully serializable — no runtime functions needed.
    expect(loaded.runtimeHandlers.size).toBe(0);
    expect(loaded.definition).toBe(definition);
    expect(mockLoadWorkflowModule).not.toHaveBeenCalled();
  });
});

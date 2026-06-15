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
    suspensionStrategy: 'wait-in-process',
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

  it('preserves the state field on definition-sourced configs', async () => {
    const definition = makeDefinition({
      state: {
        schema: {
          type: 'object',
          properties: {
            counter: { type: 'number' },
            label: { type: 'string' },
          },
          required: ['counter'],
        },
        initial: { counter: 0, label: 'default' },
      },
    });
    const config = makeConfig({ definition });

    const loaded = await loadWorkflowFromConfig(config);

    expect(loaded.definition.state).toBeDefined();
    expect(loaded.definition.state!.schema).toEqual({
      type: 'object',
      properties: {
        counter: { type: 'number' },
        label: { type: 'string' },
      },
      required: ['counter'],
    });
    expect(loaded.definition.state!.initial).toEqual({ counter: 0, label: 'default' });
    expect(loaded.definition).toBe(definition);
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

// ---------------------------------------------------------------------------
// loadWorkflowFromConfig — path/source source
// ---------------------------------------------------------------------------

describe('loadWorkflowFromConfig — path/source source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects source-loaded workflow ID mismatches for definition-backed source overrides', async () => {
    mockLoadWorkflowModule.mockResolvedValueOnce({
      definition: makeDefinition({ id: 'loaded-workflow-id' }),
      runtimeHandlers: new Map(),
    });

    const config = makeConfig({
      executionId: 'wfx-source-mismatch',
      workflowId: 'stored-workflow-id',
      source: { kind: 'path', path: '/repo/workflows/stored-workflow.mjs' },
    });

    await expect(loadWorkflowFromConfig(config)).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_MISMATCH',
      message: `Source-backed workflow for logical workflow 'stored-workflow-id' loaded definition 'loaded-workflow-id'.`,
    });
  });

  it('allows runFile source-loaded workflows whose workflowId is the executionId', async () => {
    mockLoadWorkflowModule.mockResolvedValueOnce({
      definition: makeDefinition({ id: 'workflow-file-export-id' }),
      runtimeHandlers: new Map([['step1', () => ({ ok: true })]]),
    });

    const config = makeConfig({
      executionId: 'wfx-run-file',
      workflowId: 'wfx-run-file',
      source: { kind: 'path', path: '/repo/workflows/file-run.mjs' },
    });

    const loaded = await loadWorkflowFromConfig(config);

    expect(loaded.definition.id).toBe('workflow-file-export-id');
    expect(loaded.runtimeHandlers.size).toBe(1);
  });
});

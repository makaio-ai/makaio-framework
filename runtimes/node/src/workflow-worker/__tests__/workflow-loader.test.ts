import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  FunctionWorkflowStep,
  ForEachWorkflowStep,
  GateWorkflowStep,
  ShellWorkflowStep,
  WorkflowDefinition,
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
const { loadWorkflowFromConfig, findFunctionStep } = await import('../workflow-loader.js');

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
    steps: [],
    scope: { type: 'global' as const },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
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
// findFunctionStep
// ---------------------------------------------------------------------------

/** A minimal valid {@link ShellWorkflowStep} for testing (command is an array). */
const SHELL_STEP: ShellWorkflowStep = { id: 'shell-step', type: 'shell', command: ['echo', 'hi'] };
/** A minimal valid {@link GateWorkflowStep} for testing. */
const GATE_STEP: GateWorkflowStep = {
  id: 'gate-step',
  type: 'gate',
  prompt: 'Approve?',
  autoAction: 'reject',
  timeoutMs: null,
};
/** A minimal valid {@link FunctionWorkflowStep} for testing. */
const FUNCTION_STEP: FunctionWorkflowStep = { id: 'fn-step', type: 'function', runtime: true };

describe('findFunctionStep', () => {
  it('returns undefined when no function steps exist', () => {
    const result = findFunctionStep([SHELL_STEP, GATE_STEP]);

    expect(result).toBeUndefined();
  });

  it('returns the first function step found', () => {
    const result = findFunctionStep([SHELL_STEP, FUNCTION_STEP]);

    expect(result).toBe(FUNCTION_STEP);
  });

  it('finds function steps nested inside for-each steps', () => {
    const nestedFunctionStep: FunctionWorkflowStep = { id: 'nested-fn', type: 'function', runtime: true };
    const forEachStep: ForEachWorkflowStep = {
      id: 'for-each-step',
      type: 'for-each',
      collection: 'items',
      steps: [nestedFunctionStep],
    };

    const result = findFunctionStep([forEachStep]);

    expect(result).toBe(nestedFunctionStep);
  });

  it('returns undefined for an empty steps array', () => {
    expect(findFunctionStep([])).toBeUndefined();
  });
});

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
    expect(loaded.runtimeSteps).toBeInstanceOf(Map);
    expect(loaded.runtimeSteps.size).toBe(0);
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

  it('throws when the definition contains a function step', async () => {
    const definition = makeDefinition({
      steps: [FUNCTION_STEP],
    });
    const config = makeConfig({ definition });

    await expect(loadWorkflowFromConfig(config)).rejects.toThrow(
      `Definition-sourced workflow "wf-001" contains function step "fn-step".`,
    );
    expect(mockLoadWorkflowModule).not.toHaveBeenCalled();
  });

  it('throws when a nested function step is detected inside a for-each step', async () => {
    const nestedFunctionStep: FunctionWorkflowStep = { id: 'nested-fn', type: 'function', runtime: true };
    const forEachStep: ForEachWorkflowStep = {
      id: 'for-each-step',
      type: 'for-each',
      collection: 'items',
      steps: [nestedFunctionStep],
    };
    const definition = makeDefinition({ steps: [forEachStep] });
    const config = makeConfig({ definition });

    await expect(loadWorkflowFromConfig(config)).rejects.toThrow(/contains function step/i);
    expect(mockLoadWorkflowModule).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// loadWorkflowFromConfig — path / source delegation
// ---------------------------------------------------------------------------

describe('loadWorkflowFromConfig — path and source delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates path-sourced config to loadWorkflowModule', async () => {
    const expectedLoaded = {
      definition: makeDefinition({ id: 'path-wf' }),
      runtimeSteps: new Map(),
    };
    mockLoadWorkflowModule.mockResolvedValueOnce(expectedLoaded);

    const config = makeConfig({ source: { kind: 'path', path: '/workflows/my-workflow.mjs' } });
    const loaded = await loadWorkflowFromConfig(config);

    expect(mockLoadWorkflowModule).toHaveBeenCalledOnce();
    expect(mockLoadWorkflowModule).toHaveBeenCalledWith(config.source);
    expect(loaded).toBe(expectedLoaded);
  });

  it('delegates source-kind config to loadWorkflowModule', async () => {
    const expectedLoaded = {
      definition: makeDefinition({ id: 'source-wf' }),
      runtimeSteps: new Map(),
    };
    mockLoadWorkflowModule.mockResolvedValueOnce(expectedLoaded);

    const config = makeConfig({
      source: { kind: 'source', filename: 'inline.mjs', source: 'export default {}' },
    });
    const loaded = await loadWorkflowFromConfig(config);

    expect(mockLoadWorkflowModule).toHaveBeenCalledOnce();
    expect(mockLoadWorkflowModule).toHaveBeenCalledWith(config.source);
    expect(loaded).toBe(expectedLoaded);
  });
});

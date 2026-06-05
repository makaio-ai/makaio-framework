import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowDefinition, WorkflowWorkerConfig } from '@makaio/contracts';
import { createBusInstance } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { createMockBus } from '@makaio/test-utils';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Mocks — declared before dynamic imports
// ---------------------------------------------------------------------------

const mockRunWorkflowOrchestrator = vi.fn();
const mockLoadWorkflowFromConfig = vi.fn();

vi.mock('@makaio/subsystem-workflow-engine/workflow-orchestrator', () => ({
  runWorkflowOrchestrator: mockRunWorkflowOrchestrator,
}));

vi.mock('../workflow-loader.js', () => ({
  loadWorkflowFromConfig: mockLoadWorkflowFromConfig,
}));

// Import after mocking
const { InProcessWorkflowRunner } = await import('../in-process-workflow-runner.js');

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
    definition: makeDefinition(),
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

/**
 * Build a stub {@link IMakaioBus} with minimum required surface for testing.
 * @returns A mock bus instance.
 */
function makeBus() {
  return createMockBus().bus;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InProcessWorkflowRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads the workflow from config and passes it to the orchestrator', async () => {
    const bus = makeBus();
    const runner = new InProcessWorkflowRunner({ bus });

    const loadedWorkflow = { definition: makeDefinition(), runtimeHandlers: new Map() };
    const expectedResult = { executionId: 'exec-001', workflowId: 'wf-001', status: 'completed' as const };
    const signal = new AbortController().signal;
    const config = makeConfig();

    mockLoadWorkflowFromConfig.mockResolvedValueOnce(loadedWorkflow);
    mockRunWorkflowOrchestrator.mockResolvedValueOnce(expectedResult);

    const result = await runner.run(config, signal);

    expect(mockLoadWorkflowFromConfig).toHaveBeenCalledOnce();
    expect(mockLoadWorkflowFromConfig).toHaveBeenCalledWith(config);
    expect(result).toBe(expectedResult);
  });

  it('forwards the validated config to the orchestrator', async () => {
    const bus = makeBus();
    const runner = new InProcessWorkflowRunner({ bus });

    const loadedWorkflow = { definition: makeDefinition(), runtimeHandlers: new Map() };
    const config = makeConfig({ workflowId: 'specific-workflow' });
    const signal = new AbortController().signal;

    mockLoadWorkflowFromConfig.mockResolvedValueOnce(loadedWorkflow);
    mockRunWorkflowOrchestrator.mockResolvedValueOnce({
      executionId: 'exec-001',
      workflowId: 'specific-workflow',
      status: 'completed',
    });

    await runner.run(config, signal);

    expect(mockRunWorkflowOrchestrator).toHaveBeenCalledOnce();
    expect(mockRunWorkflowOrchestrator).toHaveBeenCalledWith(expect.objectContaining({ config }));
  });

  it('preserves start artifact references through worker config validation', async () => {
    const bus = makeBus();
    const runner = new InProcessWorkflowRunner({ bus });

    const artifactRef = { kind: 'implementation-plan', id: 'artifact-42' };
    const loadedWorkflow = { definition: makeDefinition(), runtimeHandlers: new Map() };
    const config = makeConfig({ artifactRef });
    const signal = new AbortController().signal;

    mockLoadWorkflowFromConfig.mockResolvedValueOnce(loadedWorkflow);
    mockRunWorkflowOrchestrator.mockResolvedValueOnce({
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed',
    });

    await runner.run(config, signal);

    expect(mockLoadWorkflowFromConfig).toHaveBeenCalledWith(expect.objectContaining({ artifactRef }));
    expect(mockRunWorkflowOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ artifactRef }),
      }),
    );
  });

  it('validates config before loading the workflow', async () => {
    const bus = makeBus();
    const runner = new InProcessWorkflowRunner({ bus });
    const signal = new AbortController().signal;
    const invalidConfig = makeConfig();
    Object.assign(invalidConfig, { workflowId: 123 });

    await expect(runner.run(invalidConfig, signal)).rejects.toThrow();

    expect(mockLoadWorkflowFromConfig).not.toHaveBeenCalled();
    expect(mockRunWorkflowOrchestrator).not.toHaveBeenCalled();
  });

  it('forwards the loaded workflow to the orchestrator', async () => {
    const bus = makeBus();
    const runner = new InProcessWorkflowRunner({ bus });

    const loadedWorkflow = { definition: makeDefinition(), runtimeHandlers: new Map() };
    const signal = new AbortController().signal;

    mockLoadWorkflowFromConfig.mockResolvedValueOnce(loadedWorkflow);
    mockRunWorkflowOrchestrator.mockResolvedValueOnce({
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed',
    });

    await runner.run(makeConfig(), signal);

    expect(mockRunWorkflowOrchestrator).toHaveBeenCalledWith(expect.objectContaining({ loaded: loadedWorkflow }));
  });

  it('forwards the bus to the orchestrator', async () => {
    const bus = makeBus();
    const runner = new InProcessWorkflowRunner({ bus });

    const loadedWorkflow = { definition: makeDefinition(), runtimeHandlers: new Map() };
    const signal = new AbortController().signal;

    mockLoadWorkflowFromConfig.mockResolvedValueOnce(loadedWorkflow);
    mockRunWorkflowOrchestrator.mockResolvedValueOnce({
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed',
    });

    await runner.run(makeConfig(), signal);

    expect(mockRunWorkflowOrchestrator).toHaveBeenCalledWith(expect.objectContaining({ bus }));
  });

  it('forwards the abort signal to the orchestrator', async () => {
    const bus = makeBus();
    const runner = new InProcessWorkflowRunner({ bus });

    const loadedWorkflow = { definition: makeDefinition(), runtimeHandlers: new Map() };
    const controller = new AbortController();
    const signal = controller.signal;

    mockLoadWorkflowFromConfig.mockResolvedValueOnce(loadedWorkflow);
    mockRunWorkflowOrchestrator.mockResolvedValueOnce({
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed',
    });

    await runner.run(makeConfig(), signal);

    expect(mockRunWorkflowOrchestrator).toHaveBeenCalledWith(expect.objectContaining({ signal }));
  });

  it('waits for bus-event triggers when triggerPayload is empty', async () => {
    const bus = createBusInstance();
    const { subjects } = bus.registerNamespace(
      createBusNamespace('demo', { started: z.object({ buildId: z.string() }) }),
    );
    const runner = new InProcessWorkflowRunner({ bus });
    const signal = new AbortController().signal;
    const loadedWorkflow = {
      definition: makeDefinition({
        triggers: [{ type: 'bus-event', subject: 'demo.started' }],
      }),
      runtimeHandlers: new Map(),
    };
    const expectedResult = { executionId: 'exec-001', workflowId: 'wf-001', status: 'completed' as const };

    mockLoadWorkflowFromConfig.mockResolvedValueOnce(loadedWorkflow);
    mockRunWorkflowOrchestrator.mockResolvedValueOnce(expectedResult);

    const runPromise = runner.run(makeConfig(), signal);
    await Promise.resolve();
    await bus.emit(subjects.started, { buildId: 'build-001' });

    await expect(runPromise).resolves.toBe(expectedResult);
    expect(mockRunWorkflowOrchestrator.mock.calls[0]?.[0].config.triggerPayload).toEqual({ buildId: 'build-001' });
  });

  it('ignores the manifest parameter — in-process runners share the host contribution set', async () => {
    const bus = makeBus();
    const runner = new InProcessWorkflowRunner({ bus });

    const loadedWorkflow = { definition: makeDefinition(), runtimeHandlers: new Map() };
    const signal = new AbortController().signal;
    const manifest = { packages: [{ name: 'ignored-pkg', importPath: 'file:///ext/ignored.mjs' }] };

    mockLoadWorkflowFromConfig.mockResolvedValueOnce(loadedWorkflow);
    mockRunWorkflowOrchestrator.mockResolvedValueOnce({
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed',
    });

    // Should not throw even though the manifest is provided
    await runner.run(makeConfig(), signal, manifest);

    // Manifest is never forwarded to the orchestrator
    expect(mockRunWorkflowOrchestrator).toHaveBeenCalledWith(expect.not.objectContaining({ manifest }));
  });

  it('propagates errors from the orchestrator', async () => {
    const bus = makeBus();
    const runner = new InProcessWorkflowRunner({ bus });

    const loadedWorkflow = { definition: makeDefinition(), runtimeHandlers: new Map() };
    const signal = new AbortController().signal;
    const orchestratorError = new Error('Orchestrator failed');

    mockLoadWorkflowFromConfig.mockResolvedValueOnce(loadedWorkflow);
    mockRunWorkflowOrchestrator.mockRejectedValueOnce(orchestratorError);

    await expect(runner.run(makeConfig(), signal)).rejects.toThrow('Orchestrator failed');
  });

  it('propagates errors from loadWorkflowFromConfig', async () => {
    const bus = makeBus();
    const runner = new InProcessWorkflowRunner({ bus });
    const signal = new AbortController().signal;
    const loaderError = new Error('Loader failed');

    mockLoadWorkflowFromConfig.mockRejectedValueOnce(loaderError);

    await expect(runner.run(makeConfig(), signal)).rejects.toThrow('Loader failed');
    expect(mockRunWorkflowOrchestrator).not.toHaveBeenCalled();
  });
});

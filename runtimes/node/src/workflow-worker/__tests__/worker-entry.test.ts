import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBusInstance, type BusMessage, type BusTransport } from '@makaio/bus-core';
import type { WorkflowDefinition, WorkflowWorkerConfig } from '@makaio/contracts';
import { createWorkflowWorkerReadyMessage } from '../worker-ready-message.js';

// ---------------------------------------------------------------------------
// Mocks — declared before dynamic imports
// ---------------------------------------------------------------------------

const mockBootWorkerBus = vi.fn();
const mockBootWorkerRuntime = vi.fn();
const mockLoadWorkflowModule = vi.fn();
const mockRunWorkflowOrchestrator = vi.fn();
const mockLoadWorkerContributions = vi.fn();
const mockParentPortPostMessage = vi.fn();

vi.mock('node:worker_threads', () => ({
  parentPort: { postMessage: mockParentPortPostMessage },
}));

vi.mock('../runtime/worker-boot.js', () => ({
  bootWorkerBus: mockBootWorkerBus,
  bootWorkerRuntime: mockBootWorkerRuntime,
}));

vi.mock('../runtime/worker-contributions.js', () => ({
  loadWorkerContributions: mockLoadWorkerContributions,
}));

vi.mock('../workflow-file-loader.js', () => ({
  loadWorkflowModule: mockLoadWorkflowModule,
}));

vi.mock('@makaio/subsystem-workflow-engine/workflow-orchestrator', () => ({
  runWorkflowOrchestrator: mockRunWorkflowOrchestrator,
}));

// Import after mocking
const { runWorkflowInWorker } = await import('../worker-entry.js');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal WorkflowWorkerConfig for testing.
 * @param overrides - Optional field overrides.
 * @returns Valid WorkflowWorkerConfig stub.
 */
function makeConfig(overrides: Partial<WorkflowWorkerConfig> = {}): WorkflowWorkerConfig {
  return {
    source: { kind: 'path', path: '/tmp/workflow.mjs' },
    executionId: 'exec-001',
    workflowId: 'wf-001',
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
    coordinatorSessionId: 'session-001',
    cancelSubject: 'workflow.cancel.wf-001',
    suspensionStrategy: 'wait-in-process',
    ...overrides,
  };
}

/**
 * Build a minimal LoadedWorkflow stub.
 * @returns A mock LoadedWorkflow object.
 */
function makeLoadedWorkflow() {
  return {
    definition: {
      id: 'wf-001',
      name: 'Test Workflow',
      root: { id: 'wf-001__root', type: 'sequence' as const, nodes: [] },
      triggers: [],
      scope: { type: 'global' as const },
    },
    runtimeHandlers: new Map(),
  };
}

/**
 * Build a mock WorkerBusHandle.
 * @returns Mock bus handle with bus object and close spy.
 */
function makeBusHandle() {
  const unsubscribe = vi.fn();
  return {
    bus: { on: vi.fn().mockReturnValue(unsubscribe), off: vi.fn(), emit: vi.fn() },
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Build a bus handle whose transport-level subscribe is externally released.
 * @returns Worker bus handle plus subscription propagation controls.
 */
function makePropagationControlledBusHandle() {
  let resolveSubscribe!: () => void;
  const subscribePromise = new Promise<void>((resolve) => {
    resolveSubscribe = resolve;
  });
  const transport: BusTransport = {
    name: 'delayed-subscribe',
    send: async <TMessage extends BusMessage>(_message: TMessage) => true as never,
    onReceive: () => () => undefined,
    connect: async () => undefined,
    disconnect: async () => undefined,
    subscribe: vi.fn().mockReturnValue(subscribePromise),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    isReady: () => true,
  };
  const bus = createBusInstance();
  const registration = bus.registerTransport(transport);
  const close = vi.fn(async () => {
    registration.unregister();
    await transport.disconnect();
  });
  return { busHandle: { bus, close }, resolveSubscribe, transport };
}

/**
 * Build a mock WorkerRuntimeHandle.
 * @returns Mock runtime handle with close spy.
 */
function makeRuntimeHandle() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Build a minimal WorkflowDefinition stub (as returned by storage).
 * @returns Valid WorkflowDefinition with all required fields.
 */
function makeWorkflowDefinition(): WorkflowDefinition {
  return {
    id: 'wf-001',
    name: 'DB Workflow',
    root: { id: 'wf-001__root', type: 'sequence', nodes: [] },
    triggers: [],
    scope: { type: 'global' as const },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runWorkflowInWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('boots bus once, loads contributions once, boots runtime once, loads workflow once, and calls orchestrator once', async () => {
    const busHandle = makeBusHandle();
    const runtimeHandle = makeRuntimeHandle();
    const loadedWorkflow = makeLoadedWorkflow();
    // Non-empty contributions so the runtime is booted.
    const contributions = {
      toolsets: [{ name: 'test-toolset', tools: [] }],
    };
    const expectedResult = {
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed' as const,
    };

    mockBootWorkerBus.mockResolvedValueOnce(busHandle);
    mockLoadWorkerContributions.mockResolvedValueOnce(contributions);
    mockBootWorkerRuntime.mockResolvedValueOnce(runtimeHandle);
    mockLoadWorkflowModule.mockResolvedValueOnce(loadedWorkflow);
    mockRunWorkflowOrchestrator.mockResolvedValueOnce(expectedResult);

    const config = makeConfig();
    const result = await runWorkflowInWorker({
      config,
      manifest: { packages: [{ name: 'test-pkg', importPath: './test.mjs' }] },
    });

    expect(mockBootWorkerBus).toHaveBeenCalledOnce();
    expect(mockLoadWorkerContributions).toHaveBeenCalledOnce();
    expect(mockBootWorkerRuntime).toHaveBeenCalledOnce();
    expect(mockLoadWorkflowModule).toHaveBeenCalledOnce();
    expect(mockLoadWorkflowModule).toHaveBeenCalledWith(config.source);
    expect(mockRunWorkflowOrchestrator).toHaveBeenCalledOnce();
    expect(result).toEqual(expectedResult);
  });

  it('posts ready after cancel subscription is propagated', async () => {
    const { busHandle, resolveSubscribe, transport } = makePropagationControlledBusHandle();
    const expectedResult = {
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed' as const,
    };

    mockBootWorkerBus.mockResolvedValueOnce(busHandle);
    mockLoadWorkerContributions.mockResolvedValueOnce({ toolsets: [] });
    mockLoadWorkflowModule.mockResolvedValueOnce(makeLoadedWorkflow());
    mockRunWorkflowOrchestrator.mockResolvedValueOnce(expectedResult);

    const config = makeConfig();
    const runPromise = runWorkflowInWorker({ config, manifest: { packages: [] } });
    await vi.waitFor(() => expect(transport.subscribe).toHaveBeenCalled());

    expect(mockParentPortPostMessage).not.toHaveBeenCalled();

    resolveSubscribe();
    await runPromise;

    expect(mockParentPortPostMessage).toHaveBeenCalledWith(
      createWorkflowWorkerReadyMessage(config.executionId, config.cancelSubject),
    );
    const cancelSubscriptionOrder = vi.mocked(transport.subscribe).mock.invocationCallOrder[0];
    const readyMessageOrder = mockParentPortPostMessage.mock.invocationCallOrder[0];
    if (cancelSubscriptionOrder === undefined || readyMessageOrder === undefined) {
      throw new Error('Missing invocation order for ready message assertion');
    }
    expect(cancelSubscriptionOrder).toBeLessThan(readyMessageOrder);
  });

  it('closes runtime and bus in the finally block on success', async () => {
    const busHandle = makeBusHandle();
    const runtimeHandle = makeRuntimeHandle();
    // Non-empty contributions so the runtime is booted and must be closed.
    const contributions = { toolsets: [{ name: 'test', tools: [] }] };

    mockBootWorkerBus.mockResolvedValueOnce(busHandle);
    mockLoadWorkerContributions.mockResolvedValueOnce(contributions);
    mockBootWorkerRuntime.mockResolvedValueOnce(runtimeHandle);
    mockLoadWorkflowModule.mockResolvedValueOnce(makeLoadedWorkflow());
    mockRunWorkflowOrchestrator.mockResolvedValueOnce({
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed',
    });

    await runWorkflowInWorker({ config: makeConfig(), manifest: { packages: [] } });

    expect(runtimeHandle.close).toHaveBeenCalledOnce();
    expect(busHandle.close).toHaveBeenCalledOnce();
  });

  it('closes runtime and bus in the finally block when orchestrator throws', async () => {
    const busHandle = makeBusHandle();
    const runtimeHandle = makeRuntimeHandle();
    // Non-empty contributions so the runtime is booted and must be closed even on error.
    const contributions = { toolsets: [{ name: 'test', tools: [] }] };

    mockBootWorkerBus.mockResolvedValueOnce(busHandle);
    mockLoadWorkerContributions.mockResolvedValueOnce(contributions);
    mockBootWorkerRuntime.mockResolvedValueOnce(runtimeHandle);
    mockLoadWorkflowModule.mockResolvedValueOnce(makeLoadedWorkflow());
    mockRunWorkflowOrchestrator.mockRejectedValueOnce(new Error('Orchestrator exploded'));

    await expect(runWorkflowInWorker({ config: makeConfig(), manifest: { packages: [] } })).rejects.toThrow(
      'Orchestrator exploded',
    );

    expect(runtimeHandle.close).toHaveBeenCalledOnce();
    expect(busHandle.close).toHaveBeenCalledOnce();
  });

  it('skips bootWorkerRuntime when contributions are empty', async () => {
    const busHandle = makeBusHandle();
    const loadedWorkflow = makeLoadedWorkflow();
    const expectedResult = {
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed' as const,
    };

    mockBootWorkerBus.mockResolvedValueOnce(busHandle);
    // No toolsets or adapters
    mockLoadWorkerContributions.mockResolvedValueOnce({ toolsets: [] });
    mockLoadWorkflowModule.mockResolvedValueOnce(loadedWorkflow);
    mockRunWorkflowOrchestrator.mockResolvedValueOnce(expectedResult);

    await runWorkflowInWorker({ config: makeConfig(), manifest: { packages: [] } });

    // bootWorkerRuntime is only called when contributions are non-empty
    expect(mockBootWorkerRuntime).not.toHaveBeenCalled();
    expect(busHandle.close).toHaveBeenCalledOnce();
  });

  it('passes WorkflowWorkerConfig fields to bootWorkerBus', async () => {
    const busHandle = makeBusHandle();

    mockBootWorkerBus.mockResolvedValueOnce(busHandle);
    mockLoadWorkerContributions.mockResolvedValueOnce({ toolsets: [] });
    mockLoadWorkflowModule.mockResolvedValueOnce(makeLoadedWorkflow());
    mockRunWorkflowOrchestrator.mockResolvedValueOnce({
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed',
    });

    const config = makeConfig({
      busUrl: 'ws://localhost:9999',
      busAuth: { kind: 'hmac', secret: 'test-secret' },
    });
    await runWorkflowInWorker({ config, manifest: { packages: [] } });

    expect(mockBootWorkerBus).toHaveBeenCalledWith(
      expect.objectContaining({ busUrl: 'ws://localhost:9999', busAuth: { kind: 'hmac', secret: 'test-secret' } }),
    );
  });

  it('rejects with schema parse error for invalid config', async () => {
    const invalidConfig = { source: { kind: 'path', path: '' } }; // path too short

    await expect(
      runWorkflowInWorker({
        config: invalidConfig as WorkflowWorkerConfig,
        manifest: { packages: [] },
      }),
    ).rejects.toThrow();

    // Bus should never be booted for an invalid config
    expect(mockBootWorkerBus).not.toHaveBeenCalled();
  });

  it('uses config.definition directly for definition-sourced workflows without calling loadWorkflowModule', async () => {
    const busHandle = makeBusHandle();
    const definition = makeWorkflowDefinition();
    const expectedResult = {
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed' as const,
    };

    mockBootWorkerBus.mockResolvedValueOnce(busHandle);
    mockLoadWorkerContributions.mockResolvedValueOnce({ toolsets: [] });
    mockRunWorkflowOrchestrator.mockResolvedValueOnce(expectedResult);

    const config = makeConfig({
      source: { kind: 'definition', workflowId: 'wf-001' },
      definition,
    });
    const result = await runWorkflowInWorker({ config, manifest: { packages: [] } });

    // File-loader must never be called for definition-sourced workflows
    expect(mockLoadWorkflowModule).not.toHaveBeenCalled();
    // Orchestrator receives the definition directly with an empty runtimeHandlers Map
    expect(mockRunWorkflowOrchestrator).toHaveBeenCalledOnce();
    expect(mockRunWorkflowOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        loaded: {
          definition,
          runtimeHandlers: new Map(),
        },
      }),
    );
    expect(result).toEqual(expectedResult);
  });

  it('throws when source.kind is definition but config.definition is absent', async () => {
    const busHandle = makeBusHandle();

    mockBootWorkerBus.mockResolvedValueOnce(busHandle);
    mockLoadWorkerContributions.mockResolvedValueOnce({ toolsets: [] });

    const config = makeConfig({
      source: { kind: 'definition', workflowId: 'wf-001' },
      // definition intentionally omitted
    });

    await expect(runWorkflowInWorker({ config, manifest: { packages: [] } })).rejects.toThrow(
      `Definition-sourced worker config for workflowId "wf-001" is missing the required 'definition' field.`,
    );

    expect(mockLoadWorkflowModule).not.toHaveBeenCalled();
    expect(mockRunWorkflowOrchestrator).not.toHaveBeenCalled();
  });
});

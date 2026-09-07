import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBusInstance, type BusMessage, type BusTransport } from '@makaio/bus-core';
import type { WorkflowDefinition, WorkflowWorkerConfig } from '@makaio/contracts';
import { ExecutionAttemptNamespace, ExecutionAttemptSubjects } from '@makaio/contracts';
import { createWorkflowWorkerReadyMessage } from '../worker-ready-message.js';

// ---------------------------------------------------------------------------
// Mocks — declared before dynamic imports
// ---------------------------------------------------------------------------

const mockBootWorkerBus = vi.fn();
const mockCreateWorkerBus = vi.fn();
const mockBootWorkerRuntime = vi.fn();
const mockLoadWorkflowModule = vi.fn();
const mockRunWorkflowOrchestrator = vi.fn();
const mockLoadWorkerRuntimeContributions = vi.fn();
const mockParentPortPostMessage = vi.fn();
const mockInstallOperationDeliveryEndpoint = vi.fn();
const mockRegisterAndAdmitWorkflowRun = vi.fn();
const mockEndpointBindGeneration = vi.fn();
const mockEndpointCleanup = vi.fn();

vi.mock('node:worker_threads', () => ({
  parentPort: { postMessage: mockParentPortPostMessage },
}));

vi.mock('../runtime/worker-boot.js', () => ({
  bootWorkerBus: mockBootWorkerBus,
  createWorkerBus: mockCreateWorkerBus,
  bootWorkerRuntime: mockBootWorkerRuntime,
}));

vi.mock('../runtime/worker-contributions.js', () => ({
  loadWorkerRuntimeContributions: mockLoadWorkerRuntimeContributions,
}));

vi.mock('../runtime-registration-client.js', () => ({
  installOperationDeliveryEndpoint: mockInstallOperationDeliveryEndpoint,
  registerAndAdmitWorkflowRun: mockRegisterAndAdmitWorkflowRun,
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
 * Build a mock WorkerRuntimeBusHandle.
 * @returns Mock bus handle with bus object and close spy.
 */
function makeBusHandle() {
  const unsubscribe = vi.fn();
  return {
    bus: {
      on: vi.fn().mockReturnValue(unsubscribe),
      off: vi.fn(),
      emit: vi.fn(),
      request: vi.fn().mockResolvedValue({ status: 'permitted' }),
    },
    connect: vi.fn().mockResolvedValue(undefined),
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
  bus.registerNamespace(ExecutionAttemptNamespace);
  const offStart = bus.on(ExecutionAttemptSubjects.bootstrap.awaitStart, (ctx) => {
    ctx.setResult({ status: 'permitted' });
  });
  const registration = bus.registerTransport(transport);
  const close = vi.fn(async () => {
    offStart();
    registration.unregister();
    await transport.disconnect();
  });
  return { busHandle: { bus, close, connect: async () => {} }, resolveSubscribe, transport };
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

/** Attempt the attempt-bound cases below register their runtime against. */
const TEST_ATTEMPT_ID = 'attempt-001';

describe('runWorkflowInWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstallOperationDeliveryEndpoint.mockResolvedValue({
      bindGeneration: mockEndpointBindGeneration,
      cleanup: mockEndpointCleanup,
    });
    mockRegisterAndAdmitWorkflowRun.mockResolvedValue({ runtimeGeneration: 7, operationId: 'operation-1' });
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
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce(contributions);
    mockBootWorkerRuntime.mockResolvedValueOnce(runtimeHandle);
    mockLoadWorkflowModule.mockResolvedValueOnce(loadedWorkflow);
    mockRunWorkflowOrchestrator.mockResolvedValueOnce(expectedResult);

    const config = makeConfig();
    const result = await runWorkflowInWorker({
      kind: 'unbound',
      config,
      manifest: {
        contributionRefs: [
          { packageName: 'test-pkg', version: '1.0.0', entrypoint: 'test.mjs', integrity: 'sha384-test' },
        ],
      },
      contributionEntrypoints: ['/verified/test.mjs'],
    });

    expect(mockBootWorkerBus).toHaveBeenCalledOnce();
    expect(mockLoadWorkerRuntimeContributions).toHaveBeenCalledOnce();
    expect(mockBootWorkerRuntime).toHaveBeenCalledOnce();
    expect(mockLoadWorkflowModule).toHaveBeenCalledOnce();
    expect(mockLoadWorkflowModule).toHaveBeenCalledWith(config.source);
    expect(mockRunWorkflowOrchestrator).toHaveBeenCalledOnce();
    expect(result).toEqual(expectedResult);
  });

  it('posts ready after cancel subscription is propagated and the attempt accepted the runtime', async () => {
    const { busHandle, resolveSubscribe, transport } = makePropagationControlledBusHandle();
    const expectedResult = {
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed' as const,
    };

    mockCreateWorkerBus.mockReturnValueOnce(busHandle);
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce({ toolsets: [] });
    mockLoadWorkflowModule.mockResolvedValueOnce(makeLoadedWorkflow());
    mockRunWorkflowOrchestrator.mockResolvedValueOnce(expectedResult);

    const config = makeConfig();
    const runPromise = runWorkflowInWorker({
      kind: 'attempt-bound',
      executionAttemptId: TEST_ATTEMPT_ID,
      bootstrapDeadlineAt: new Date(Date.now() + 120_000).toISOString(),
      config,
      manifest: { contributionRefs: [] },
      contributionEntrypoints: [],
    });
    await vi.waitFor(() => expect(transport.subscribe).toHaveBeenCalled());

    expect(mockParentPortPostMessage).not.toHaveBeenCalled();

    resolveSubscribe();
    await runPromise;

    expect(mockParentPortPostMessage).toHaveBeenCalledWith(
      createWorkflowWorkerReadyMessage(config.executionId, config.cancelSubject, TEST_ATTEMPT_ID),
    );
    const cancelSubscriptionOrder = vi.mocked(transport.subscribe).mock.invocationCallOrder[0];
    const readyMessageOrder = mockParentPortPostMessage.mock.invocationCallOrder[0];
    if (cancelSubscriptionOrder === undefined || readyMessageOrder === undefined) {
      throw new Error('Missing invocation order for ready message assertion');
    }
    expect(cancelSubscriptionOrder).toBeLessThan(readyMessageOrder);
  });

  it('registers and admits before it loads any contribution', async () => {
    const busHandle = makeBusHandle();
    mockCreateWorkerBus.mockReturnValueOnce(busHandle);
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce({ toolsets: [] });
    mockLoadWorkflowModule.mockResolvedValueOnce(makeLoadedWorkflow());
    mockRunWorkflowOrchestrator.mockResolvedValueOnce({
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed',
    });

    await runWorkflowInWorker({
      kind: 'attempt-bound',
      executionAttemptId: TEST_ATTEMPT_ID,
      bootstrapDeadlineAt: new Date(Date.now() + 120_000).toISOString(),
      config: makeConfig(),
      manifest: { contributionRefs: [] },
      contributionEntrypoints: [],
    });

    // The delivery endpoint exists before registration, because the Authority
    // delivers its bounded probe inside the register request.
    const endpointOrder = mockInstallOperationDeliveryEndpoint.mock.invocationCallOrder[0];
    const startOrder = busHandle.bus.request.mock.invocationCallOrder[0];
    const registerOrder = mockRegisterAndAdmitWorkflowRun.mock.invocationCallOrder[0];
    const contributionOrder = mockLoadWorkerRuntimeContributions.mock.invocationCallOrder[0];
    if (
      endpointOrder === undefined ||
      startOrder === undefined ||
      registerOrder === undefined ||
      contributionOrder === undefined
    ) {
      throw new Error('Missing invocation order for the attempt registration assertion');
    }
    expect(endpointOrder).toBeLessThan(startOrder);
    expect(startOrder).toBeLessThan(registerOrder);
    expect(busHandle.bus.request).toHaveBeenCalledWith(
      ExecutionAttemptSubjects.bootstrap.awaitStart,
      { executionAttemptId: TEST_ATTEMPT_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal), timeout: expect.any(Number) }),
    );
    // Readiness must not depend on what the runtime later composes.
    expect(registerOrder).toBeLessThan(contributionOrder);

    // The endpoint is addressed to this attempt and this incarnation, and the
    // same incarnation registers and admits the run.
    const endpointIdentity = mockInstallOperationDeliveryEndpoint.mock.calls[0]?.[1] as {
      executionAttemptId: string;
      runtimeIncarnationId: string;
    };
    expect(endpointIdentity).toMatchObject({
      executionAttemptId: TEST_ATTEMPT_ID,
      runtimeIncarnationId: expect.any(String),
    });
    expect(mockInstallOperationDeliveryEndpoint).toHaveBeenCalledWith(
      busHandle.bus,
      endpointIdentity,
      {},
      expect.any(AbortSignal),
    );
    expect(mockRegisterAndAdmitWorkflowRun).toHaveBeenCalledWith(
      busHandle.bus,
      expect.objectContaining({
        executionAttemptId: TEST_ATTEMPT_ID,
        runtimeIncarnationId: endpointIdentity.runtimeIncarnationId,
        endpoint: { bindGeneration: mockEndpointBindGeneration, cleanup: mockEndpointCleanup },
      }),
    );
    // The endpoint is released when the run ends.
    expect(mockEndpointCleanup).toHaveBeenCalledTimes(1);
    // The thread claims the attempt on its socket: the Authority's gates read
    // the caller identity off the authenticated transport peer.
    expect(mockCreateWorkerBus).toHaveBeenCalledWith(expect.objectContaining({ identityId: TEST_ATTEMPT_ID }));
  });

  it('neither registers nor reports readiness for a run no attempt owns', async () => {
    mockBootWorkerBus.mockResolvedValueOnce(makeBusHandle());
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce({ toolsets: [] });
    mockLoadWorkflowModule.mockResolvedValueOnce(makeLoadedWorkflow());
    mockRunWorkflowOrchestrator.mockResolvedValueOnce({
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed',
    });

    await runWorkflowInWorker({
      kind: 'unbound',
      config: makeConfig(),
      manifest: { contributionRefs: [] },
      contributionEntrypoints: [],
    });

    // There is no attempt to prove anything to, so there is no readiness fact
    // to report either.
    expect(mockInstallOperationDeliveryEndpoint).not.toHaveBeenCalled();
    expect(mockRegisterAndAdmitWorkflowRun).not.toHaveBeenCalled();
    expect(mockParentPortPostMessage).not.toHaveBeenCalled();
    expect(mockBootWorkerBus).toHaveBeenCalledWith(
      expect.not.objectContaining({ identityId: expect.anything() }),
      expect.any(AbortSignal),
    );
  });

  it('closes runtime and bus in the finally block on success', async () => {
    const busHandle = makeBusHandle();
    const runtimeHandle = makeRuntimeHandle();
    // Non-empty contributions so the runtime is booted and must be closed.
    const contributions = { toolsets: [{ name: 'test', tools: [] }] };

    mockBootWorkerBus.mockResolvedValueOnce(busHandle);
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce(contributions);
    mockBootWorkerRuntime.mockResolvedValueOnce(runtimeHandle);
    mockLoadWorkflowModule.mockResolvedValueOnce(makeLoadedWorkflow());
    mockRunWorkflowOrchestrator.mockResolvedValueOnce({
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed',
    });

    await runWorkflowInWorker({
      kind: 'unbound',
      config: makeConfig(),
      manifest: { contributionRefs: [] },
      contributionEntrypoints: [],
    });

    expect(runtimeHandle.close).toHaveBeenCalledOnce();
    expect(busHandle.close).toHaveBeenCalledOnce();
  });

  it('closes runtime and bus in the finally block when orchestrator throws', async () => {
    const busHandle = makeBusHandle();
    const runtimeHandle = makeRuntimeHandle();
    // Non-empty contributions so the runtime is booted and must be closed even on error.
    const contributions = { toolsets: [{ name: 'test', tools: [] }] };

    mockBootWorkerBus.mockResolvedValueOnce(busHandle);
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce(contributions);
    mockBootWorkerRuntime.mockResolvedValueOnce(runtimeHandle);
    mockLoadWorkflowModule.mockResolvedValueOnce(makeLoadedWorkflow());
    mockRunWorkflowOrchestrator.mockRejectedValueOnce(new Error('Orchestrator exploded'));

    await expect(
      runWorkflowInWorker({
        kind: 'unbound',
        config: makeConfig(),
        manifest: { contributionRefs: [] },
        contributionEntrypoints: [],
      }),
    ).rejects.toThrow('Orchestrator exploded');

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
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce({ toolsets: [] });
    mockLoadWorkflowModule.mockResolvedValueOnce(loadedWorkflow);
    mockRunWorkflowOrchestrator.mockResolvedValueOnce(expectedResult);

    await runWorkflowInWorker({
      kind: 'unbound',
      config: makeConfig(),
      manifest: { contributionRefs: [] },
      contributionEntrypoints: [],
    });

    // bootWorkerRuntime is only called when contributions are non-empty
    expect(mockBootWorkerRuntime).not.toHaveBeenCalled();
    expect(busHandle.close).toHaveBeenCalledOnce();
  });

  it('passes WorkflowWorkerConfig fields to bootWorkerBus', async () => {
    const busHandle = makeBusHandle();

    mockBootWorkerBus.mockResolvedValueOnce(busHandle);
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce({ toolsets: [] });
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
    await runWorkflowInWorker({
      kind: 'unbound',
      config,
      manifest: { contributionRefs: [] },
      contributionEntrypoints: [],
    });

    expect(mockBootWorkerBus).toHaveBeenCalledWith(
      expect.objectContaining({ busUrl: 'ws://localhost:9999', busAuth: { kind: 'hmac', secret: 'test-secret' } }),
      expect.any(AbortSignal),
    );
  });

  it('rejects with schema parse error for invalid config', async () => {
    const invalidConfig = { source: { kind: 'path', path: '' } }; // path too short

    await expect(
      runWorkflowInWorker({
        kind: 'unbound',
        config: invalidConfig as WorkflowWorkerConfig,
        manifest: { contributionRefs: [] },
        contributionEntrypoints: [],
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
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce({ toolsets: [] });
    mockRunWorkflowOrchestrator.mockResolvedValueOnce(expectedResult);

    const config = makeConfig({
      source: { kind: 'definition', workflowId: 'wf-001' },
      definition,
    });
    const result = await runWorkflowInWorker({
      kind: 'unbound',
      config,
      manifest: { contributionRefs: [] },
      contributionEntrypoints: [],
    });

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
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce({ toolsets: [] });

    const config = makeConfig({
      source: { kind: 'definition', workflowId: 'wf-001' },
      // definition intentionally omitted
    });

    await expect(
      runWorkflowInWorker({
        kind: 'unbound',
        config,
        manifest: { contributionRefs: [] },
        contributionEntrypoints: [],
      }),
    ).rejects.toThrow(
      `Definition-sourced worker config for workflowId "wf-001" is missing the required 'definition' field.`,
    );

    expect(mockLoadWorkflowModule).not.toHaveBeenCalled();
    expect(mockRunWorkflowOrchestrator).not.toHaveBeenCalled();
  });

  it('fails closed when contribution loading throws — no orchestration', async () => {
    const busHandle = makeBusHandle();

    mockBootWorkerBus.mockResolvedValueOnce(busHandle);
    mockLoadWorkerRuntimeContributions.mockRejectedValueOnce(new Error('contribution import failure'));

    await expect(
      runWorkflowInWorker({
        kind: 'unbound',
        config: makeConfig(),
        manifest: {
          contributionRefs: [
            { packageName: 'broken-pkg', version: '1.0.0', entrypoint: 'broken.mjs', integrity: 'sha384-test' },
          ],
        },
        contributionEntrypoints: ['/verified/broken.mjs'],
      }),
    ).rejects.toThrow('contribution import failure');

    // Orchestrator must never run when contributions fail to load
    expect(mockRunWorkflowOrchestrator).not.toHaveBeenCalled();
    // Worker ready message must not be sent before composition completes
    expect(mockParentPortPostMessage).not.toHaveBeenCalled();
    // Bus must be closed in the finally block
    expect(busHandle.close).toHaveBeenCalledOnce();
  });

  it('loads only materializer-verified contribution entrypoints', async () => {
    const busHandle = makeBusHandle();

    mockBootWorkerBus.mockResolvedValueOnce(busHandle);
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce({ toolsets: [] });
    mockLoadWorkflowModule.mockResolvedValueOnce(makeLoadedWorkflow());
    mockRunWorkflowOrchestrator.mockResolvedValueOnce({
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed',
    });

    const entrypoints = ['/verified/test.mjs'];
    const manifest = {
      contributionRefs: [
        { packageName: 'test-pkg', version: '1.0.0', entrypoint: 'test.mjs', integrity: 'sha384-test' },
      ],
    };
    await runWorkflowInWorker({
      kind: 'unbound',
      config: makeConfig(),
      manifest,
      contributionEntrypoints: entrypoints,
    });

    expect(mockLoadWorkerRuntimeContributions).toHaveBeenCalledWith(entrypoints, {
      bus: busHandle.bus,
      signal: expect.any(AbortSignal),
    });
  });
});

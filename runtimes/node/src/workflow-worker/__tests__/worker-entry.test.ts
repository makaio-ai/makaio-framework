import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowDefinition, WorkflowWorkerConfig } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';

// ---------------------------------------------------------------------------
// Mocks — declared before dynamic imports
// ---------------------------------------------------------------------------

const mockCreateWorkerBus = vi.fn();
const mockBootWorkerRuntime = vi.fn();
const mockLoadWorkflowModule = vi.fn();
const mockRunWorkflowOrchestrator = vi.fn();
const mockRunCallerLocalWorkflowOrchestrator = vi.fn();
const mockLoadWorkerRuntimeContributions = vi.fn();
vi.mock('../runtime/worker-boot.js', () => ({
  createWorkerBus: mockCreateWorkerBus,
  bootWorkerRuntime: mockBootWorkerRuntime,
}));

vi.mock('../runtime/worker-contributions.js', () => ({
  loadWorkerRuntimeContributions: mockLoadWorkerRuntimeContributions,
}));

vi.mock('../workflow-file-loader.js', () => ({
  loadWorkflowModule: mockLoadWorkflowModule,
}));

vi.mock('@makaio/subsystem-workflow-engine/workflow-orchestrator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@makaio/subsystem-workflow-engine/workflow-orchestrator')>()),
  runWorkflowOrchestrator: mockRunWorkflowOrchestrator,
  runCallerLocalWorkflowOrchestrator: mockRunCallerLocalWorkflowOrchestrator,
}));

// Import after mocking
const { default: runPiscinaWorker, runWorkflowInWorker } = await import('../worker-entry.js');

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
    definition: makeWorkflowDefinition(),
    executionId: 'exec-001',
    workflowId: 'wf-001',
    triggerPayload: {},
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    env: {},
    coordinatorSessionId: 'session-001',
    cancelSubject: 'workflow.cancel.wf-001',
    ...overrides,
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
      own: vi.fn(() => createTestCall()),
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
    vi.resetAllMocks();
  });

  it('boots once and calls the process orchestrator without loading the supplied file', async () => {
    const busHandle = makeBusHandle();
    const runtimeHandle = makeRuntimeHandle();
    // Non-empty contributions so the runtime is booted.
    const contributions = {
      toolsets: [{ name: 'test-toolset', tools: [] }],
    };
    const expectedResult = {
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed' as const,
    };

    mockCreateWorkerBus.mockReturnValueOnce(busHandle);
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce(contributions);
    mockBootWorkerRuntime.mockResolvedValueOnce(runtimeHandle);
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

    expect(mockCreateWorkerBus).toHaveBeenCalledOnce();
    expect(mockLoadWorkerRuntimeContributions).toHaveBeenCalledOnce();
    expect(mockBootWorkerRuntime).toHaveBeenCalledOnce();
    expect(mockLoadWorkflowModule).not.toHaveBeenCalled();
    expect(mockRunWorkflowOrchestrator).toHaveBeenCalledOnce();
    expect(mockRunCallerLocalWorkflowOrchestrator).not.toHaveBeenCalled();
    expect(result).toEqual(expectedResult);
  });

  it('loads caller-local file tasks through the worker bus', async () => {
    const busHandle = makeBusHandle();
    const definition = makeWorkflowDefinition();
    const loaded = { definition, runtimeHandlers: new Map() };
    const result = { executionId: 'exec-001', workflowId: 'wf-001', status: 'completed' };
    mockCreateWorkerBus.mockReturnValueOnce(busHandle);
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce({ toolsets: [] });
    mockLoadWorkflowModule.mockResolvedValueOnce(loaded);
    mockRunCallerLocalWorkflowOrchestrator.mockResolvedValueOnce(result);

    await expect(
      runPiscinaWorker({
        kind: 'caller-local-file',
        config: makeConfig(),
        manifest: { contributionRefs: [] },
        contributionEntrypoints: [],
      }),
    ).resolves.toEqual(result);

    expect(mockLoadWorkflowModule).toHaveBeenCalledWith({ kind: 'path', path: '/tmp/workflow.mjs' });
    expect(mockRunCallerLocalWorkflowOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({ loaded, bus: busHandle.bus }),
    );
    expect(mockRunWorkflowOrchestrator).not.toHaveBeenCalled();
  });

  it('refuses the caller-local file task for an Authority-owned run', async () => {
    mockCreateWorkerBus.mockReturnValueOnce(makeBusHandle());
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce({ toolsets: [] });
    mockRunWorkflowOrchestrator.mockResolvedValueOnce({
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed',
    });

    await expect(
      runPiscinaWorker({
        kind: 'caller-local-file',
        config: makeConfig({ terminalAuthority: 'authority' }),
        manifest: { contributionRefs: [] },
        contributionEntrypoints: [],
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_EXECUTABLE' });
    expect(mockCreateWorkerBus).not.toHaveBeenCalled();
    expect(mockLoadWorkflowModule).not.toHaveBeenCalled();
  });

  it('closes runtime and bus in the finally block on success', async () => {
    const busHandle = makeBusHandle();
    const runtimeHandle = makeRuntimeHandle();
    // Non-empty contributions so the runtime is booted and must be closed.
    const contributions = { toolsets: [{ name: 'test', tools: [] }] };

    mockCreateWorkerBus.mockReturnValueOnce(busHandle);
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce(contributions);
    mockBootWorkerRuntime.mockResolvedValueOnce(runtimeHandle);
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

    mockCreateWorkerBus.mockReturnValueOnce(busHandle);
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce(contributions);
    mockBootWorkerRuntime.mockResolvedValueOnce(runtimeHandle);
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
    const expectedResult = {
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed' as const,
    };

    mockCreateWorkerBus.mockReturnValueOnce(busHandle);
    // No toolsets or adapters
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce({ toolsets: [] });
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

  it('passes transport configuration to the worker connection factory', async () => {
    const busHandle = makeBusHandle();

    mockCreateWorkerBus.mockReturnValueOnce(busHandle);
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce({ toolsets: [] });
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

    expect(mockCreateWorkerBus).toHaveBeenCalledWith(
      expect.objectContaining({ busUrl: 'ws://localhost:9999', busAuth: { kind: 'hmac', secret: 'test-secret' } }),
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
    expect(mockCreateWorkerBus).not.toHaveBeenCalled();
  });

  it('uses config.definition directly for definition-sourced workflows without calling loadWorkflowModule', async () => {
    const busHandle = makeBusHandle();
    const definition = makeWorkflowDefinition();
    const expectedResult = {
      executionId: 'exec-001',
      workflowId: 'wf-001',
      status: 'completed' as const,
    };

    mockCreateWorkerBus.mockReturnValueOnce(busHandle);
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
    // The orchestrator receives frozen data and a required step runner.
    expect(mockRunWorkflowOrchestrator).toHaveBeenCalledOnce();
    expect(mockRunWorkflowOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        loaded: { definition },
        stepRunner: expect.objectContaining({ run: expect.any(Function) }),
      }),
    );
    expect(result).toEqual(expectedResult);
  });

  it('throws when source.kind is definition but config.definition is absent', async () => {
    const busHandle = makeBusHandle();

    mockCreateWorkerBus.mockReturnValueOnce(busHandle);
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce({ toolsets: [] });

    const config = makeConfig({
      source: { kind: 'definition', workflowId: 'wf-001' },
      definition: undefined,
    });

    await expect(
      runWorkflowInWorker({
        kind: 'unbound',
        config,
        manifest: { contributionRefs: [] },
        contributionEntrypoints: [],
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_SNAPSHOT_UNAVAILABLE' });

    expect(mockLoadWorkflowModule).not.toHaveBeenCalled();
    expect(mockRunWorkflowOrchestrator).not.toHaveBeenCalled();
  });

  it('fails closed when contribution loading throws — no orchestration', async () => {
    const busHandle = makeBusHandle();

    mockCreateWorkerBus.mockReturnValueOnce(busHandle);
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
    // Bus must be closed in the finally block
    expect(busHandle.close).toHaveBeenCalledOnce();
  });

  it('loads only materializer-verified contribution entrypoints', async () => {
    const busHandle = makeBusHandle();

    mockCreateWorkerBus.mockReturnValueOnce(busHandle);
    mockLoadWorkerRuntimeContributions.mockResolvedValueOnce({ toolsets: [] });
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

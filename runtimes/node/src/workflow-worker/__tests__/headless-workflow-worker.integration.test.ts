import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createBusInstance, waitForSubscriptionPropagation, type IMakaioBus } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import {
  createWorkflowCancelSubject,
  CapabilitySubjects,
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  WorkerNodeSubjects,
  WorkflowRunResultSchema,
  WorkflowSubjects,
  type OutcomeAckDecision,
  type WorkerRuntimeContext,
  type WorkflowRunContext,
  type WorkflowRunResult,
} from '@makaio/contracts';
import { KernelSubjects } from '@makaio/kernel';
import { registerMemorySessionStorage } from '../../../../../services/core/src/session/storage/memory-handler.js';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { BusServerTransportProvider } from '../../bus-server-transport.js';
import { runHeadlessWorkflowWorker, type HeadlessWorkflowWorkerDeps } from '../headless-workflow-worker.js';
import { OutcomeDeliveryError } from '../outcome-submission.js';
import {
  computeContributionPackageDigest,
  computeDirectoryDigest,
  materializeLocalDirectory,
} from '../local-directory-materializer.js';

// ─────────────────────────────────────────────────────────────
// Test infrastructure
// ─────────────────────────────────────────────────────────────

/**
 * Minimal run context fixture for integration tests.
 * @param executionId - Execution identifier.
 * @returns Valid WorkflowRunContext with minimal required fields.
 */
function makeRunContext(executionId: string): WorkflowRunContext {
  return {
    executionId,
    workflowId: 'test-workflow',
    source: { kind: 'definition', workflowId: 'test-workflow' },
    definitionSnapshot: {
      id: 'test-workflow',
      name: 'Test Workflow',
      root: { id: 'root', type: 'sequence', nodes: [] },
      scope: { type: 'global' },
    },
    workerManifest: { contributionRefs: [] },
    inputs: {},
    scope: { type: 'global' },
    triggerPayload: {},
    coordinatorSessionId: 'coordinator-session-1',
    cancelSubject: `workflow.${executionId}.cancel`,
    env: {},
    createdAt: Date.now(),
    suspensionStrategy: 'wait-in-process',
  };
}

/** Build the read-only empty adapter repository required by the runtime seam. */
function createEmptyAdapterRepository() {
  return {
    async loadAdapterConfigs() {
      return { configs: new Map() };
    },
    async loadProviderConfigs() {
      return { configs: new Map() };
    },
    async writeProviderConfig(): Promise<void> {
      throw new Error('read only');
    },
    async deleteProviderConfig(): Promise<boolean> {
      throw new Error('read only');
    },
    async writeAdapterFile(): Promise<void> {
      throw new Error('read only');
    },
    async deleteAdapterFile(): Promise<boolean> {
      throw new Error('read only');
    },
  };
}

/** Tracked lifecycle events for assertion. */
interface LifecycleCapture {
  kernelReadyEvents: Array<{ machineId: string }>;
  attemptReadyEvents: Array<{
    executionAttemptId: string;
    executionId: string;
    adapters: string[];
  }>;
  outcomeSubmissions: Array<{
    executionAttemptId: string;
    executionId: string;
    result: WorkflowRunResult;
  }>;
}

/**
 * Authority-side test harness.
 *
 * Sets up a real bus with WS server and registers handlers for the harness
 * lifecycle subjects: getRunContext, attempt-ready, outcome.submit, and
 * kernel.ready.
 */
interface AuthoritySide {
  bus: IMakaioBus;
  port: number;
  capture: LifecycleCapture;
  /** Run context the authority will return. */
  runContext: WorkflowRunContext;
  /** Override the outcome decision returned by the authority. */
  outcomeDecision: OutcomeAckDecision;
  /** Count of transient failures to inject before the real decision. */
  outcomeTransientFailures: number;
  /** Optional hook invoked for every received outcome submission. */
  onOutcomeSubmit?: (callCount: number) => void;
  /** Optional gate that keeps the run-context request pending. */
  runContextGate?: Promise<void>;
  /** Optional hook invoked when the run-context request reaches the Authority. */
  onRunContextRequest?: () => void;
  cleanup: () => Promise<void>;
}

/**
 * Create a full authority-side test harness.
 * @param executionId - Execution identifier.
 * @returns Authority harness with bus, WS server, and lifecycle capture.
 */
async function createAuthoritySide(executionId: string): Promise<AuthoritySide> {
  const authority = createBusInstance();
  authority.registerNamespaces([...FrameworkContractNamespaces, ...FrameworkStorageNamespaces]);
  const offStorage = registerMemorySessionStorage(authority);

  const server = createServer();
  const port = await listenOnLoopback(server);
  const serverTransport = new BusServerTransportProvider({ httpServer: server });
  await serverTransport.connect(authority, 'headless-test-authority');

  const runContext = makeRunContext(executionId);

  const state: AuthoritySide = {
    bus: authority,
    port,
    capture: {
      kernelReadyEvents: [],
      attemptReadyEvents: [],
      outcomeSubmissions: [],
    },
    runContext,
    outcomeDecision: 'accepted',
    outcomeTransientFailures: 0,
    cleanup: async () => {
      offGetRunContext();
      offAttemptReady();
      offOutcomeSubmit();
      offKernelReady();
      offStorage();
      await serverTransport.disconnect();
      await closeHttpServer(server);
    },
  };

  // Register getRunContext handler
  const offGetRunContext = authority.on(
    WorkflowSubjects.getRunContext,
    async (ctx) => {
      state.onRunContextRequest?.();
      await state.runContextGate;
      ctx.setResult(state.runContext);
    },
    { filter: { executionId } },
  );

  // Capture attempt-ready events
  const offAttemptReady = authority.on(WorkerNodeSubjects.control['attempt-ready'], (ctx) => {
    state.capture.attemptReadyEvents.push({
      executionAttemptId: ctx.payload.executionAttemptId,
      executionId: ctx.payload.executionId,
      adapters: [...ctx.payload.adapters],
    });
  });

  // Handle outcome submission with configurable decision and transient failures
  let outcomeCallCount = 0;
  const offOutcomeSubmit = authority.on(WorkerNodeSubjects.control.outcome.submit, (ctx) => {
    state.capture.outcomeSubmissions.push({
      executionAttemptId: ctx.payload.executionAttemptId,
      executionId: ctx.payload.executionId,
      result: WorkflowRunResultSchema.parse(ctx.payload.result),
    });
    outcomeCallCount++;
    state.onOutcomeSubmit?.(outcomeCallCount);
    if (outcomeCallCount <= state.outcomeTransientFailures) {
      throw new Error('Transient outcome submission failure');
    }
    ctx.setResult({ decision: state.outcomeDecision });
  });

  // Capture kernel ready events
  const offKernelReady = authority.on(KernelSubjects.ready, (ctx) => {
    state.capture.kernelReadyEvents.push({ machineId: ctx.payload.machineId });
  });

  return state;
}

/**
 * Create a WS bus connector for integration tests.
 * @param port - Authority WS server port.
 * @param onSubscriptionStart - Optional hook invoked before a subscription is propagated.
 * @returns Bus connector function that creates a WS client transport.
 */
function createTestBusConnector(
  port: number,
  onSubscriptionStart?: (subject: string) => Promise<void>,
): HeadlessWorkflowWorkerDeps['connectBus'] {
  return async (bus, _credentials, _signal) => {
    const transport = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}/bus`,
      autoReconnect: false,
    });
    const subscribe = transport.subscribe.bind(transport);
    transport.subscribe = async (subject, filter, priorities, deliveryClass) => {
      await onSubscriptionStart?.(subject);
      await subscribe(subject, filter, priorities, deliveryClass);
    };
    bus.registerTransport(transport);
    await bus.connect();
  };
}

/**
 * Create default test dependencies.
 * @param authoritySide - Authority-side harness.
 * @param options - Optional overrides.
 * @returns HeadlessWorkflowWorkerDeps for test use.
 */
function createTestDeps(
  authoritySide: AuthoritySide,
  options?: {
    cwd?: string;
    executionId?: string;
    executionAttemptId?: string;
    execute?: HeadlessWorkflowWorkerDeps['execute'];
    materialize?: HeadlessWorkflowWorkerDeps['materialize'];
    loadContributions?: HeadlessWorkflowWorkerDeps['loadContributions'];
    bootstrap?: HeadlessWorkflowWorkerDeps['bootstrap'];
    onPostCommit?: HeadlessWorkflowWorkerDeps['onPostCommit'];
    outcomeRetry?: HeadlessWorkflowWorkerDeps['outcomeRetry'];
  },
): HeadlessWorkflowWorkerDeps {
  const executionId = options?.executionId ?? 'exec-1';
  const executionAttemptId = options?.executionAttemptId ?? 'attempt-1';
  const cwd = options?.cwd ?? tmpdir();

  const defaultRuntimeContext: WorkerRuntimeContext = {
    workspaceRoot: cwd,
    sourcePath: join(cwd, 'workflow.ts'),
    contributionEntrypoints: [],
    platform: 'linux',
    arch: 'x64',
  };

  return {
    executionId,
    executionAttemptId,
    bootstrap:
      options?.bootstrap ??
      (async () => ({
        busUrl: `ws://127.0.0.1:${authoritySide.port}/bus`,
        busAuthSecret: 'test-secret',
      })),
    connectBus: createTestBusConnector(authoritySide.port),
    materialize: options?.materialize ?? (async () => ({ context: defaultRuntimeContext })),
    loadContributions: options?.loadContributions ?? (async () => []),
    execute:
      options?.execute ??
      (async (_bus, runContext) => ({
        executionId: runContext.executionId,
        workflowId: runContext.workflowId,
        status: 'completed' as const,
      })),
    configRepository: createEmptyAdapterRepository(),
    toolsets: [],
    onPostCommit: options?.onPostCommit,
    outcomeRetry: options?.outcomeRetry,
  };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('runHeadlessWorkflowWorker integration', () => {
  let authoritySide: AuthoritySide;
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-headless-worker-'));
  });

  afterEach(async () => {
    if (authoritySide !== undefined) {
      await authoritySide.cleanup();
    }
    await rm(cwd, { recursive: true, force: true });
  });

  it('runs the full lifecycle: bootstrap -> connect -> pull -> materialize -> compose -> ready -> execute -> ACK -> cleanup', async () => {
    const executionId = 'exec-full-lifecycle';
    const executionAttemptId = 'attempt-full-lifecycle';
    authoritySide = await createAuthoritySide(executionId);

    const phaseLog: string[] = [];
    const abortController = new AbortController();

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
      bootstrap: async () => {
        phaseLog.push('bootstrap');
        return {
          busUrl: `ws://127.0.0.1:${authoritySide.port}/bus`,
          busAuthSecret: 'test-secret',
        };
      },
      materialize: async (runContext) => {
        phaseLog.push('materialize');
        expect(runContext.executionId).toBe(executionId);
        return {
          context: {
            workspaceRoot: cwd,
            sourcePath: join(cwd, 'workflow.ts'),
            contributionEntrypoints: [],
            platform: 'linux',
            arch: 'x64',
          },
        };
      },
      loadContributions: async () => {
        phaseLog.push('loadContributions');
        return [];
      },
      execute: async (_bus, runContext) => {
        phaseLog.push('execute');
        return {
          executionId: runContext.executionId,
          workflowId: runContext.workflowId,
          status: 'completed' as const,
        };
      },
      onPostCommit: async (result, decision) => {
        phaseLog.push('postCommit');
        expect(result.status).toBe('completed');
        expect(decision).toBe('accepted');
      },
    });

    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    // Verify result
    expect(workerResult.result.status).toBe('completed');
    expect(workerResult.decision).toBe('accepted');

    // Verify phase ordering
    expect(phaseLog).toEqual(['bootstrap', 'materialize', 'loadContributions', 'execute', 'postCommit']);

    // Verify attempt-ready was received by the authority
    await vi.waitFor(() => {
      expect(authoritySide.capture.attemptReadyEvents).toHaveLength(1);
    });
    expect(authoritySide.capture.attemptReadyEvents[0]).toMatchObject({
      executionAttemptId,
      executionId,
    });

    // Verify outcome was submitted
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(1);
    expect(authoritySide.capture.outcomeSubmissions[0]).toMatchObject({
      executionAttemptId,
      executionId,
      result: { status: 'completed' },
    });
  }, 20_000);

  it('emits kernel ready BEFORE attempt ready', async () => {
    const executionId = 'exec-ready-order';
    const executionAttemptId = 'attempt-ready-order';
    authoritySide = await createAuthoritySide(executionId);

    const readyOrder: string[] = [];

    // Listen for kernel ready on the authority side
    const offKernelReady = authoritySide.bus.on(KernelSubjects.ready, () => {
      readyOrder.push('kernel-ready');
    });
    const offAttemptReady = authoritySide.bus.on(WorkerNodeSubjects.control['attempt-ready'], () => {
      readyOrder.push('attempt-ready');
    });

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
    });

    await runHeadlessWorkflowWorker(deps, abortController.signal);

    // The kernel ready event should appear before the attempt ready event
    // in the authority's observation order.
    offKernelReady();
    offAttemptReady();

    await vi.waitFor(() => {
      expect(readyOrder).toContain('kernel-ready');
      expect(readyOrder).toContain('attempt-ready');
    });
    expect(readyOrder.indexOf('kernel-ready')).toBeLessThan(readyOrder.indexOf('attempt-ready'));
  }, 20_000);

  it('activates contributed packages with surface: headless and skips interactive-only packages', async () => {
    const executionId = 'exec-headless-surface';
    const executionAttemptId = 'attempt-headless-surface';
    authoritySide = await createAuthoritySide(executionId);

    const activatedPackages: string[] = [];

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
      loadContributions: async () => {
        return [
          {
            name: 'headless-package',
            displayName: 'Headless Package',
            version: '1.0.0',
            surface: 'headless' as const,
            create: () => {
              activatedPackages.push('headless-package');
              return {};
            },
          },
          {
            name: 'any-surface-package',
            displayName: 'Any Surface Package',
            version: '1.0.0',
            surface: 'any' as const,
            create: () => {
              activatedPackages.push('any-surface-package');
              return {};
            },
          },
          {
            name: 'interactive-only-package',
            displayName: 'Interactive Only Package',
            version: '1.0.0',
            surface: 'interactive' as const,
            create: () => {
              activatedPackages.push('interactive-only-package');
              return {};
            },
          },
        ];
      },
    });

    await runHeadlessWorkflowWorker(deps, abortController.signal);

    // headless and any-surface packages should activate; interactive-only should be skipped
    expect(activatedPackages).toContain('headless-package');
    expect(activatedPackages).toContain('any-surface-package');
    expect(activatedPackages).not.toContain('interactive-only-package');
  }, 20_000);

  it('captures execution error as failed result and submits it', async () => {
    const executionId = 'exec-execution-error';
    const executionAttemptId = 'attempt-execution-error';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
      execute: async () => {
        throw new Error('Workflow step exploded');
      },
    });

    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    expect(workerResult.result.status).toBe('failed');
    expect(workerResult.result).toMatchObject({
      executionId,
      workflowId: 'test-workflow',
      status: 'failed',
      error: 'Workflow step exploded',
    });
    expect(workerResult.decision).toBe('accepted');

    // The failed result was submitted
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(1);
    expect(authoritySide.capture.outcomeSubmissions[0]!.result.status).toBe('failed');
  }, 20_000);

  it('retries outcome submission on transient failures', async () => {
    const executionId = 'exec-retry';
    const executionAttemptId = 'attempt-retry';
    authoritySide = await createAuthoritySide(executionId);
    authoritySide.outcomeTransientFailures = 2; // Fail first 2 attempts

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
    });

    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    expect(workerResult.decision).toBe('accepted');
    // 3 submissions: 2 transient failures + 1 success
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(3);
  }, 30_000);

  it('throws OutcomeDeliveryError on conflict decision', async () => {
    const executionId = 'exec-conflict';
    const executionAttemptId = 'attempt-conflict';
    authoritySide = await createAuthoritySide(executionId);
    authoritySide.outcomeDecision = 'conflict';

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
    });

    await expect(runHeadlessWorkflowWorker(deps, abortController.signal)).rejects.toThrow(OutcomeDeliveryError);
  }, 20_000);

  it('accepts duplicate as successful delivery', async () => {
    const executionId = 'exec-duplicate';
    const executionAttemptId = 'attempt-duplicate';
    authoritySide = await createAuthoritySide(executionId);
    authoritySide.outcomeDecision = 'duplicate';

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
    });

    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    expect(workerResult.decision).toBe('duplicate');
    expect(workerResult.result.status).toBe('completed');
  }, 20_000);

  // ─── Cancellation tests ─────────────────────────────────────

  it('throws on cancellation during bootstrap', async () => {
    const executionId = 'exec-cancel-bootstrap';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      bootstrap: async (signal) => {
        abortController.abort();
        signal.throwIfAborted();
        return { busUrl: '', busAuthSecret: '' };
      },
    });

    await expect(runHeadlessWorkflowWorker(deps, abortController.signal)).rejects.toThrow();
  }, 20_000);

  it('aborts a blocked run-context pull without readiness or outcome traffic', async () => {
    const executionId = 'exec-cancel-context-pull';
    authoritySide = await createAuthoritySide(executionId);

    let releaseRunContext!: () => void;
    authoritySide.runContextGate = new Promise<void>((resolve) => {
      releaseRunContext = resolve;
    });
    let markRunContextRequested!: () => void;
    const runContextRequested = new Promise<void>((resolve) => {
      markRunContextRequested = resolve;
    });
    authoritySide.onRunContextRequest = markRunContextRequested;

    const abortController = new AbortController();
    const worker = runHeadlessWorkflowWorker(
      createTestDeps(authoritySide, { cwd, executionId }),
      abortController.signal,
    );

    await runContextRequested;
    abortController.abort();
    await expect(worker).rejects.toMatchObject({ name: 'AbortError' });
    releaseRunContext();

    expect(authoritySide.capture.kernelReadyEvents).toHaveLength(0);
    expect(authoritySide.capture.attemptReadyEvents).toHaveLength(0);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(0);
  }, 20_000);

  it('cancellation during materialization produces a cancelled result', async () => {
    const executionId = 'exec-cancel-materialize';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      materialize: async (_runContext, signal) => {
        abortController.abort();
        signal.throwIfAborted();
        return {
          context: {
            workspaceRoot: cwd,
            sourcePath: join(cwd, 'workflow.ts'),
            contributionEntrypoints: [],
            platform: 'linux',
            arch: 'x64',
          },
        };
      },
    });

    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);
    expect(workerResult.result.status).toBe('cancelled');

    // No attempt-ready should have been emitted
    expect(authoritySide.capture.attemptReadyEvents).toHaveLength(0);
  }, 20_000);

  it('cleans up deterministically on materialization failure', async () => {
    const executionId = 'exec-materialize-failure';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const materializeError = new Error('Snapshot digest mismatch');
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      materialize: async () => {
        throw materializeError;
      },
    });

    await expect(runHeadlessWorkflowWorker(deps, abortController.signal)).rejects.toBe(materializeError);

    // No attempt-ready or outcome should have been emitted
    expect(authoritySide.capture.attemptReadyEvents).toHaveLength(0);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(0);
  }, 20_000);

  it('cleans up deterministically when already-aborted signal is passed', async () => {
    const executionId = 'exec-already-aborted';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    abortController.abort();

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
    });

    await expect(runHeadlessWorkflowWorker(deps, abortController.signal)).rejects.toThrow();

    // Nothing should have been emitted
    expect(authoritySide.capture.attemptReadyEvents).toHaveLength(0);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(0);
  }, 20_000);

  it('post-commit observation failures are swallowed', async () => {
    const executionId = 'exec-postcommit-error';
    const executionAttemptId = 'attempt-postcommit-error';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
      onPostCommit: async () => {
        throw new Error('Artifact write failed');
      },
    });

    // Should not throw despite postCommit failure
    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    expect(workerResult.result.status).toBe('completed');
    expect(workerResult.decision).toBe('accepted');
  }, 20_000);

  it('shuts down deterministically when authority connection fails during runtime composition', async () => {
    const executionId = 'exec-runtime-fail';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    let connectCallCount = 0;
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
    });
    // Override connectBus: succeed on the first call (pre-composition bus),
    // but fail on the second call (runtime composition's connectAuthority).
    const originalConnect = deps.connectBus;
    const failingDeps: HeadlessWorkflowWorkerDeps = {
      ...deps,
      connectBus: async (bus, credentials, signal) => {
        connectCallCount++;
        if (connectCallCount >= 2) {
          throw new Error('Authority reconnection failed');
        }
        return originalConnect(bus, credentials, signal);
      },
    };

    await expect(runHeadlessWorkflowWorker(failingDeps, abortController.signal)).rejects.toThrow(
      'Authority reconnection failed',
    );

    // No attempt-ready or outcome should have been emitted
    expect(authoritySide.capture.attemptReadyEvents).toHaveLength(0);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(0);
  }, 20_000);

  it('cancellation during execution produces a cancelled result with ACK', async () => {
    const executionId = 'exec-cancel-during-exec';
    const executionAttemptId = 'attempt-cancel-during-exec';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
      execute: async (_bus, _runContext, _runtimeContext, signal) => {
        // Simulate long-running workflow that gets cancelled
        abortController.abort();
        signal.throwIfAborted();
        return {
          executionId,
          workflowId: 'test-workflow',
          status: 'completed' as const,
        };
      },
    });

    // The execution error is caught — cooperative cancellation produces a
    // 'cancelled' result (not 'failed'), which is then submitted for ACK.
    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    expect(workerResult.result.status).toBe('cancelled');
    expect(workerResult.decision).toBe('accepted');
  }, 20_000);

  // ─── Finding 3: connectBus failure still disconnects preBus ────

  it('disconnects preBus when connectBus throws', async () => {
    const executionId = 'exec-connect-fail';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
    });

    // Replace connectBus with one that always throws
    const failingDeps: HeadlessWorkflowWorkerDeps = {
      ...deps,
      connectBus: async () => {
        throw new Error('Bus connection refused');
      },
    };

    await expect(runHeadlessWorkflowWorker(failingDeps, abortController.signal)).rejects.toThrow(
      'Bus connection refused',
    );

    // If the preBus was leaked (not disconnected), subsequent tests would see
    // a lingering connection. The test passing without hanging confirms cleanup.
    expect(authoritySide.capture.attemptReadyEvents).toHaveLength(0);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(0);
  }, 20_000);

  // ─── Finding 4: Cancellation during materialization via bus ────

  it('cancel during materialization via bus produces no attempt-ready and cancelled outcome', async () => {
    const executionId = 'exec-cancel-bus-materialize';
    const executionAttemptId = 'attempt-cancel-bus-materialize';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
      materialize: async () => {
        // Simulate cancellation during materialization by emitting cancel
        // on the authority bus. The preBus cancel listener should pick it up.
        const cancelSubject = `workflow.${executionId}.cancel`;
        await authoritySide.bus.emit(createWorkflowCancelSubject(cancelSubject), { executionId });
        // Give the event a moment to propagate
        await new Promise<void>((r) => setTimeout(r, 100));
        // Return normally — the harness should detect the abort
        return {
          context: {
            workspaceRoot: cwd,
            sourcePath: join(cwd, 'workflow.ts'),
            contributionEntrypoints: [],
            platform: 'linux' as const,
            arch: 'x64',
          },
        };
      },
    });

    // Cancellation between phases should prevent attempt-ready
    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    // No attempt-ready should have been emitted
    expect(authoritySide.capture.attemptReadyEvents).toHaveLength(0);
    // Outcome should be cancelled
    expect(workerResult.result.status).toBe('cancelled');
  }, 20_000);

  it('carries cancellation from the pre-composition bus while runtime subscription propagation is pending', async () => {
    const executionId = 'exec-cancel-handoff-propagation';
    const executionAttemptId = 'attempt-cancel-handoff-propagation';
    authoritySide = await createAuthoritySide(executionId);

    const cancelSubject = `workflow.${executionId}.cancel`;
    const cancellationSubject = createWorkflowCancelSubject(cancelSubject);
    let runtimeConnectionCount = 0;
    let cancellationPropagationPending = false;
    let releaseCancellationPropagation!: () => void;
    const cancellationPropagation = new Promise<void>((resolve) => {
      releaseCancellationPropagation = resolve;
    });
    let markPreCompositionCancellation!: () => void;
    const preCompositionCancellation = new Promise<void>((resolve) => {
      markPreCompositionCancellation = resolve;
    });

    const baseDeps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
      materialize: async (_runContext, signal) => {
        signal.addEventListener('abort', markPreCompositionCancellation, { once: true });
        return {
          context: {
            workspaceRoot: cwd,
            sourcePath: join(cwd, 'workflow.ts'),
            contributionEntrypoints: [],
            platform: 'linux',
            arch: 'x64',
          },
        };
      },
    });
    const deps: HeadlessWorkflowWorkerDeps = {
      ...baseDeps,
      connectBus: async (bus, credentials, signal) => {
        runtimeConnectionCount++;
        const onSubscriptionStart =
          runtimeConnectionCount === 2
            ? async (subject: string) => {
                if (subject === cancelSubject) {
                  cancellationPropagationPending = true;
                  await cancellationPropagation;
                }
              }
            : undefined;
        await createTestBusConnector(authoritySide.port, onSubscriptionStart)(bus, credentials, signal);
      },
    };

    const worker = runHeadlessWorkflowWorker(deps, new AbortController().signal);
    await vi.waitFor(() => {
      expect(cancellationPropagationPending).toBe(true);
    });

    await authoritySide.bus.emit(cancellationSubject, { executionId });
    await preCompositionCancellation;
    releaseCancellationPropagation();

    const workerResult = await worker;
    expect(workerResult.result.status).toBe('cancelled');
    expect(authoritySide.capture.attemptReadyEvents).toHaveLength(0);
  }, 20_000);

  it('abort between composition and attempt-ready emits no ready event', async () => {
    const executionId = 'exec-abort-pre-ready';
    const executionAttemptId = 'attempt-abort-pre-ready';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();

    let composeCount = 0;
    const baseDeps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
    });

    // Override connectBus to abort on the second call (during runtime composition)
    // right after it succeeds so the runtime is composed but abort fires before attempt-ready.
    const originalConnect = baseDeps.connectBus;
    const deps: HeadlessWorkflowWorkerDeps = {
      ...baseDeps,
      connectBus: async (bus, credentials, signal) => {
        composeCount++;
        await originalConnect(bus, credentials, signal);
        if (composeCount >= 2) {
          // Abort after runtime composition succeeds
          abortController.abort();
        }
      },
    };

    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    // No attempt-ready should have been emitted
    expect(authoritySide.capture.attemptReadyEvents).toHaveLength(0);
    expect(workerResult.result.status).toBe('cancelled');
  }, 20_000);

  it('cancellation during adapter discovery after the runtime handoff prevents attempt-ready', async () => {
    const executionId = 'exec-cancel-runtime-adapters';
    const executionAttemptId = 'attempt-cancel-runtime-adapters';
    authoritySide = await createAuthoritySide(executionId);

    let markAdapterDiscoveryStarted!: () => void;
    const adapterDiscoveryStarted = new Promise<void>((resolve) => {
      markAdapterDiscoveryStarted = resolve;
    });
    let releaseAdapterDiscovery!: () => void;
    const adapterDiscovery = new Promise<void>((resolve) => {
      releaseAdapterDiscovery = resolve;
    });
    const offListProviders = authoritySide.bus.on(CapabilitySubjects.listProviders, async (ctx) => {
      markAdapterDiscoveryStarted();
      await adapterDiscovery;
      ctx.setResult({ providers: [] });
    });
    await waitForSubscriptionPropagation(offListProviders);

    try {
      const worker = runHeadlessWorkflowWorker(
        createTestDeps(authoritySide, { cwd, executionId, executionAttemptId }),
        new AbortController().signal,
      );
      await adapterDiscoveryStarted;

      await authoritySide.bus.emit(createWorkflowCancelSubject(`workflow.${executionId}.cancel`), { executionId });
      releaseAdapterDiscovery();

      const workerResult = await worker;
      expect(workerResult.result.status).toBe('cancelled');
      expect(authoritySide.capture.attemptReadyEvents).toHaveLength(0);
      expect(authoritySide.capture.outcomeSubmissions).toHaveLength(1);
      expect(authoritySide.capture.outcomeSubmissions[0]?.result.status).toBe('cancelled');
    } finally {
      offListProviders();
    }
  }, 20_000);

  it('cancellation during loadContributions prevents attempt-ready', async () => {
    const executionId = 'exec-cancel-contributions';
    const executionAttemptId = 'attempt-cancel-contributions';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
      loadContributions: async () => {
        abortController.abort();
        return [];
      },
    });

    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    expect(authoritySide.capture.attemptReadyEvents).toHaveLength(0);
    expect(workerResult.result.status).toBe('cancelled');
  }, 20_000);

  it('contribution load failure blocks attempt-ready', async () => {
    const executionId = 'exec-contribution-fail';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      loadContributions: async () => {
        throw new Error('Package import failed');
      },
    });

    await expect(runHeadlessWorkflowWorker(deps, abortController.signal)).rejects.toThrow('Package import failed');

    expect(authoritySide.capture.attemptReadyEvents).toHaveLength(0);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(0);
  }, 20_000);

  it('rejects a tampered transitive contribution module before attempt-ready', async () => {
    const executionId = 'exec-contribution-helper-tamper';
    authoritySide = await createAuthoritySide(executionId);
    const packageRoot = join(cwd, 'node_modules', '@acme', 'tools');
    const entrypoint = join(packageRoot, 'dist', 'server.mjs');
    const helper = join(packageRoot, 'dist', 'helper.mjs');
    await mkdir(join(cwd, 'node_modules', '@acme', 'tools', 'dist'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@acme/tools', version: '1.0.0' }));
    await writeFile(entrypoint, `import { tool } from './helper.mjs'; export { tool };`);
    await writeFile(helper, 'export const tool = () => "original";');
    await writeFile(join(cwd, 'workflow.ts'), 'export default {};');
    const integrity = await computeContributionPackageDigest(packageRoot, 'sha384');
    const rootDigest = await computeDirectoryDigest(cwd);
    await writeFile(helper, 'export const tool = () => "tampered";');
    const ref = {
      packageName: '@acme/tools',
      version: '1.0.0',
      entrypoint: 'dist/server.mjs',
      integrity,
    };
    authoritySide.runContext = {
      ...authoritySide.runContext,
      workerManifest: { contributionRefs: [ref] },
    };

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      materialize: async () => ({
        context: await materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'workspace-1',
            rootDigest,
            sourcePath: 'workflow.ts',
          },
          [ref],
          { resolveWorkspaceRoot: async () => cwd },
        ),
      }),
    });

    await expect(runHeadlessWorkflowWorker(deps, new AbortController().signal)).rejects.toMatchObject({
      code: 'contribution-integrity-mismatch',
    });
    expect(authoritySide.capture.kernelReadyEvents).toHaveLength(0);
    expect(authoritySide.capture.attemptReadyEvents).toHaveLength(0);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(0);
  }, 20_000);

  // ─── Finding 5: MaterializedWorkspace cleanup contract ─────────

  it('calls materializer cleanup on success', async () => {
    const executionId = 'exec-cleanup-success';
    const executionAttemptId = 'attempt-cleanup-success';
    authoritySide = await createAuthoritySide(executionId);

    let cleanupCalled = false;
    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
      materialize: async () => ({
        context: {
          workspaceRoot: cwd,
          sourcePath: join(cwd, 'workflow.ts'),
          contributionEntrypoints: [],
          platform: 'linux' as const,
          arch: 'x64',
        },
        cleanup: async () => {
          cleanupCalled = true;
        },
      }),
    });

    await runHeadlessWorkflowWorker(deps, abortController.signal);

    expect(cleanupCalled).toBe(true);
  }, 20_000);

  it('keeps outcome ACK retry durable after cancellation and cleans up exactly once', async () => {
    const executionId = 'exec-cancel-outcome-retry';
    const executionAttemptId = 'attempt-cancel-outcome-retry';
    authoritySide = await createAuthoritySide(executionId);
    authoritySide.outcomeTransientFailures = 1;

    const abortController = new AbortController();
    authoritySide.onOutcomeSubmit = (callCount) => {
      if (callCount === 1) {
        abortController.abort();
      }
    };
    let cleanupCallCount = 0;
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
      materialize: async () => ({
        context: {
          workspaceRoot: cwd,
          sourcePath: join(cwd, 'workflow.ts'),
          contributionEntrypoints: [],
          platform: 'linux',
          arch: 'x64',
        },
        cleanup: async () => {
          cleanupCallCount++;
        },
      }),
      outcomeRetry: {
        maxRetries: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        deadlineMs: 5_000,
      },
    });

    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    expect(workerResult).toMatchObject({
      result: { status: 'completed' },
      decision: 'accepted',
    });
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(2);
    expect(cleanupCallCount).toBe(1);
  }, 20_000);

  it('awaits cleanup exactly once when cancellation arrives during teardown', async () => {
    const executionId = 'exec-cancel-cleanup';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    let cleanupCallCount = 0;
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      materialize: async () => ({
        context: {
          workspaceRoot: cwd,
          sourcePath: join(cwd, 'workflow.ts'),
          contributionEntrypoints: [],
          platform: 'linux',
          arch: 'x64',
        },
        cleanup: async () => {
          cleanupCallCount++;
          markCleanupStarted();
          await cleanupGate;
        },
      }),
    });

    const worker = runHeadlessWorkflowWorker(deps, abortController.signal);
    let workerSettled = false;
    void worker.then(
      () => {
        workerSettled = true;
      },
      () => {
        workerSettled = true;
      },
    );
    await cleanupStarted;
    abortController.abort();
    await Promise.resolve();

    expect(workerSettled).toBe(false);
    expect(cleanupCallCount).toBe(1);

    releaseCleanup();
    const workerResult = await worker;
    expect(workerResult.decision).toBe('accepted');
    expect(cleanupCallCount).toBe(1);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(1);
  }, 20_000);

  it('calls materializer cleanup on failure after materialization succeeded', async () => {
    const executionId = 'exec-cleanup-failure';
    const executionAttemptId = 'attempt-cleanup-failure';
    authoritySide = await createAuthoritySide(executionId);

    let cleanupCalled = false;
    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
      materialize: async () => ({
        context: {
          workspaceRoot: cwd,
          sourcePath: join(cwd, 'workflow.ts'),
          contributionEntrypoints: [],
          platform: 'linux' as const,
          arch: 'x64',
        },
        cleanup: async () => {
          cleanupCalled = true;
        },
      }),
      loadContributions: async () => {
        throw new Error('Load failed');
      },
    });

    await expect(runHeadlessWorkflowWorker(deps, abortController.signal)).rejects.toThrow('Load failed');

    expect(cleanupCalled).toBe(true);
  }, 20_000);

  // ─── Finding 6: Teardown must not mask primary failures ────────

  it('execution failure + failing shutdown still rejects with the execution error', async () => {
    const executionId = 'exec-teardown-mask';
    const executionAttemptId = 'attempt-teardown-mask';
    authoritySide = await createAuthoritySide(executionId);

    let connectCallCount = 0;
    const abortController = new AbortController();
    const baseDeps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      executionAttemptId,
    });

    // Make the second connectBus throw so runtime composition fails.
    // The finally's shutdown should fail (runtime was never created)
    // but the primary error should propagate.
    const originalConnect = baseDeps.connectBus;
    const deps: HeadlessWorkflowWorkerDeps = {
      ...baseDeps,
      connectBus: async (bus, credentials, signal) => {
        connectCallCount++;
        if (connectCallCount >= 2) {
          throw new Error('Primary composition failure');
        }
        return originalConnect(bus, credentials, signal);
      },
    };

    await expect(runHeadlessWorkflowWorker(deps, abortController.signal)).rejects.toThrow(
      'Primary composition failure',
    );
  }, 20_000);
});

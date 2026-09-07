import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import {
  createWorkflowCancelSubject,
  ExecutionAttemptSubjects,
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  WorkerSubjects,
  WorkflowRunResultSchema,
  type ExecutionAttemptOutcome,
  type WorkspaceRequirement,
  type WorkerRuntimeContext,
  type WorkflowRunContext,
  type WorkflowRunResult,
} from '@makaio/contracts';
import { KernelSubjects } from '@makaio/kernel';
import { registerMemorySessionStorage } from '../../../../../services/core/src/session/storage/memory-handler.js';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { BusServerTransportProvider } from '../../bus-server-transport.js';
import { runHeadlessWorkflowWorker, type HeadlessWorkflowWorkerDeps } from '../headless-workflow-worker.js';
import { AttemptOutcomeDeliveryError } from '../outcome-submission.js';
import {
  computeContributionPackageDigest,
  computeDirectoryDigest,
  materializeLocalDirectory,
} from '../local-directory-materializer.js';
import {
  createAttemptAuthorityHarness,
  freezeWorkflowInstruction,
  type AttemptAuthorityHarness,
} from './attempt-authority-harness.js';

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

/**
 * Assert that a returned outcome really contains a workflow-produced result.
 * @param outcome - Generic terminal outcome.
 * @returns Validated workflow result, rejecting technical failures.
 */
function workflowResult(outcome: ExecutionAttemptOutcome): WorkflowRunResult {
  expect(outcome.kind).toBe('workload-result');
  return WorkflowRunResultSchema.parse(outcome.kind === 'workload-result' ? outcome.result : undefined);
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
  outcomeSubmissions: Array<{
    executionAttemptId: string;
    executionId: string;
    outcome: ExecutionAttemptOutcome;
  }>;
}

/**
 * Authority-side test harness.
 *
 * Sets up a real bus with WS server and registers handlers for the harness
 * lifecycle subjects: frozen instruction retrieval, generic outcome.submit, and kernel.ready. The
 * ExecutionAttempt gates the worker registers and admits against come from
 * {@link createAttemptAuthorityHarness}, which also owns the attempt identity
 * this side authenticates.
 */
interface AuthoritySide {
  bus: IMakaioBus;
  port: number;
  capture: LifecycleCapture;
  /** Authority-side ExecutionAttempt gates, attempt identity, and gate captures. */
  attempt: AttemptAuthorityHarness;
  /** Insert a different durable outcome to exercise the real conflict decision. */
  conflictingPriorOutcome: boolean;
  /** Count of transient failures to inject before the real decision. */
  outcomeTransientFailures: number;
  /** Remaining failures after canonical commitment but before owner convergence. */
  convergenceTransientFailures: number;
  /** Optional hook invoked for every received outcome submission. */
  onOutcomeSubmit?: (callCount: number) => void;
  /** Optional gate that keeps the runtime-input request pending. */
  runtimeInputsGate?: Promise<void>;
  /** Optional hook invoked when the runtime-input request reaches the Authority. */
  onRuntimeInputsRequest?: () => void;
  cleanup: () => Promise<void>;
}

/**
 * Create a full authority-side test harness.
 * @param executionId - Execution identifier.
 * @param workspace - Optional project working-area requirement, separate from executable files.
 * @param runContext - Owner snapshot frozen before Attempt creation.
 * @returns Authority harness with bus, WS server, and lifecycle capture.
 */
async function createAuthoritySide(
  executionId: string,
  workspace?: WorkspaceRequirement,
  runContext = makeRunContext(executionId),
): Promise<AuthoritySide> {
  const authority = createBusInstance();
  authority.registerNamespaces([...FrameworkContractNamespaces, ...FrameworkStorageNamespaces]);
  const offStorage = registerMemorySessionStorage(authority);
  let state!: AuthoritySide;
  let outcomeCallCount = 0;
  const attempt = await createAttemptAuthorityHarness(authority, executionId, {
    instruction: freezeWorkflowInstruction(runContext, workspace),
    beforeCommit: async (_outcome, report) => {
      state.capture.outcomeSubmissions.push({
        executionAttemptId: state.attempt.executionAttemptId,
        executionId,
        outcome: report,
      });
      outcomeCallCount++;
      state.onOutcomeSubmit?.(outcomeCallCount);
      if (outcomeCallCount <= state.outcomeTransientFailures) throw new Error('Transient outcome submission failure');
      if (state.conflictingPriorOutcome) {
        const prior = {
          kind: 'technical-failure' as const,
          stage: 'workload-invocation' as const,
          message: 'Previously committed different outcome',
        };
        await state.attempt.authority.commitOutcome(
          state.attempt.executionAttemptId,
          executionId,
          state.attempt.authority.canonicalizeOutcome(prior),
        );
      }
    },
    beforeConverge: async () => {
      if (state.convergenceTransientFailures > 0) {
        state.convergenceTransientFailures--;
        throw new Error('Transient owner convergence failure after commit');
      }
    },
  });

  const server = createServer();
  const port = await listenOnLoopback(server);
  const serverTransport = new BusServerTransportProvider({ httpServer: server, auth: attempt.serverAuth });
  await serverTransport.connect(authority, 'headless-test-authority');

  state = {
    bus: authority,
    port,
    capture: {
      kernelReadyEvents: [],
      outcomeSubmissions: [],
    },
    attempt,
    conflictingPriorOutcome: false,
    outcomeTransientFailures: 0,
    convergenceTransientFailures: 0,
    cleanup: async () => {
      offGetRunContext();
      offKernelReady();
      await attempt.cleanup();
      offStorage();
      await serverTransport.disconnect();
      await closeHttpServer(server);
    },
  };

  // Selected realization inputs are frozen separately; this is not the instruction lookup.
  const runtimeInputs = structuredClone({
    workerManifest: runContext.workerManifest,
    suspensionStrategy: runContext.suspensionStrategy,
  });
  const offGetRunContext = authority.on(
    WorkerSubjects.runtime.inputs.get,
    async (ctx) => {
      state.onRuntimeInputsRequest?.();
      await state.runtimeInputsGate;
      ctx.setResult({ runtimeInputs });
    },
    { filter: { executionAttemptId: attempt.executionAttemptId } },
  );

  // Capture kernel ready events
  const offKernelReady = authority.on(KernelSubjects.ready, (ctx) => {
    state.capture.kernelReadyEvents.push({ machineId: ctx.payload.machineId });
  });

  return state;
}

/**
 * Create a WS bus connector for integration tests.
 *
 * Every worker socket authenticates as the attempt peer the Authority-side
 * gates fence on: an unauthenticated connection cannot register a runtime.
 * @param authoritySide - Authority-side harness owning the port and the attempt identity.
 * @returns Bus connector function that creates a WS client transport.
 */
function createTestBusConnector(authoritySide: AuthoritySide): HeadlessWorkflowWorkerDeps['connectBus'] {
  return async (bus, _credentials, _signal) => {
    const transport = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${authoritySide.port}/bus`,
      autoReconnect: false,
      auth: authoritySide.attempt.createClientAuth(),
    });
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
    workspaceRoot?: string;
    workflowEnv?: Readonly<Record<string, string>>;
    setupEnv?: HeadlessWorkflowWorkerDeps['setupEnv'];
    executionId?: string;
    execute?: HeadlessWorkflowWorkerDeps['execute'];
    materialize?: HeadlessWorkflowWorkerDeps['materialize'];
    loadContributions?: HeadlessWorkflowWorkerDeps['loadContributions'];
    bootstrap?: HeadlessWorkflowWorkerDeps['bootstrap'];
    onPostCommit?: HeadlessWorkflowWorkerDeps['onPostCommit'];
    outcomeRetry?: HeadlessWorkflowWorkerDeps['outcomeRetry'];
  },
): HeadlessWorkflowWorkerDeps {
  const executionId = options?.executionId ?? 'exec-1';
  // The attempt identity is the Authority's, not the test's: the transport
  // authenticates it and both gates refuse anything else.
  const executionAttemptId = authoritySide.attempt.executionAttemptId;
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
    bootstrapDeadlineAt: authoritySide.attempt.bootstrapDeadlineAt,
    workflowEnv: options?.workflowEnv ?? {},
    setupEnv: options?.setupEnv,
    bootstrap:
      options?.bootstrap ??
      (async () => ({
        busUrl: `ws://127.0.0.1:${authoritySide.port}/bus`,
        busAuthSecret: 'test-secret',
      })),
    connectBus: createTestBusConnector(authoritySide),
    ...(options?.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
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

  it('executes its frozen instruction without inventing a project Workspace', async () => {
    const executionId = 'exec-frozen-no-workspace';
    const selected = { ...makeRunContext(executionId), inputs: { chosen: 'original' } };
    authoritySide = await createAuthoritySide(executionId, undefined, selected);
    selected.inputs = { chosen: 'changed later' };
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      execute: async (_bus, runContext) => {
        expect(runContext.inputs).toEqual({ chosen: 'original' });
        return { executionId, workflowId: runContext.workflowId, status: 'completed' };
      },
    });
    const result = await runHeadlessWorkflowWorker(deps, new AbortController().signal);
    expect(workflowResult(result.outcome).status).toBe('completed');
    expect(authoritySide.attempt.operationAdmittedEvents.map((event) => event.operationKind)).toEqual([
      'workload-invocation',
    ]);
  });

  it('snapshots explicit workflow environment for materialization and execution without importing ambient values', async () => {
    const executionId = 'exec-explicit-workflow-env';
    authoritySide = await createAuthoritySide(executionId);
    const workflowEnv = { WORKFLOW_ENV_PROOF: 'host-configured' };
    const received: Array<Record<string, string>> = [];
    vi.stubEnv('WORKFLOW_AMBIENT_ONLY', 'must-not-enter-the-explicit-map');
    const baseDeps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      workflowEnv,
      materialize: async (runContext) => {
        received.push(runContext.env);
        await writeFile(join(cwd, 'environment-proof'), runContext.env['WORKFLOW_ENV_PROOF'] ?? 'missing');
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
      execute: async (_bus, runContext) => {
        received.push(runContext.env);
        expect(await readFile(join(cwd, 'environment-proof'), 'utf8')).toBe('host-configured');
        return { executionId, workflowId: runContext.workflowId, status: 'completed' };
      },
    });
    const deps: HeadlessWorkflowWorkerDeps = {
      ...baseDeps,
      connectBus: async (...args) => {
        workflowEnv.WORKFLOW_ENV_PROOF = 'changed-after-adapter-creation';
        await baseDeps.connectBus(...args);
      },
    };
    try {
      const result = await runHeadlessWorkflowWorker(deps, new AbortController().signal);
      expect(workflowResult(result.outcome).status).toBe('completed');
      expect(received).toEqual([{ WORKFLOW_ENV_PROOF: 'host-configured' }, { WORKFLOW_ENV_PROOF: 'host-configured' }]);
      expect(authoritySide.capture.outcomeSubmissions).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('prepares an optional scratch Workspace before acquiring and invoking workflow code', async () => {
    const executionId = 'exec-project-workspace';
    const workspaceRoot = join(cwd, 'project');
    const sentinel = 'headless-private-setup-value';
    expect(process.env.MAKAIO_HEADLESS_SETUP_SENTINEL).toBeUndefined();
    expect(process.env.MAKAIO_WORKFLOW_ONLY_SENTINEL).toBeUndefined();
    authoritySide = await createAuthoritySide(executionId, {
      provisioning: 'create',
      custody: 'disposable',
      sourceRoots: [],
      setup: [
        {
          command: process.execPath,
          args: [
            '-e',
            "require('fs').writeFileSync('ready',JSON.stringify({setup:process.env.MAKAIO_HEADLESS_SETUP_SENTINEL,workflowOnly:process.env.MAKAIO_WORKFLOW_ONLY_SENTINEL??null}))",
          ],
          env: {},
          timeoutMs: 5_000,
        },
      ],
    });
    const deps = createTestDeps(authoritySide, {
      cwd,
      workspaceRoot,
      executionId,
      setupEnv: { MAKAIO_HEADLESS_SETUP_SENTINEL: sentinel },
      workflowEnv: { MAKAIO_WORKFLOW_ONLY_SENTINEL: 'workflow-only-value' },
      execute: async (_bus, runContext, runtimeContext) => {
        expect(runtimeContext.workspaceRoot).toBe(await realpath(workspaceRoot));
        expect(runtimeContext.sourcePath).toBe(join(cwd, 'workflow.ts'));
        expect(JSON.parse(await readFile(join(runtimeContext.workspaceRoot, 'ready'), 'utf8'))).toEqual({
          setup: sentinel,
          workflowOnly: null,
        });
        expect(runContext.env).toEqual({ MAKAIO_WORKFLOW_ONLY_SENTINEL: 'workflow-only-value' });
        return { executionId, workflowId: runContext.workflowId, status: 'completed' };
      },
    });
    const result = await runHeadlessWorkflowWorker(deps, new AbortController().signal);
    expect(workflowResult(result.outcome).status).toBe('completed');
    expect(JSON.stringify(authoritySide.capture.outcomeSubmissions)).not.toContain(sentinel);
    expect(process.env.MAKAIO_HEADLESS_SETUP_SENTINEL).toBeUndefined();
    expect(authoritySide.attempt.operationAdmittedEvents.map((event) => event.operationKind)).toEqual([
      'workspace-preparation',
      'workload-invocation',
    ]);
    await expect(stat(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(cwd)).isDirectory()).toBe(true);
  });

  it('runs the full lifecycle: bootstrap -> connect -> register -> admit -> pull -> materialize -> compose -> execute -> ACK -> cleanup', async () => {
    const executionId = 'exec-full-lifecycle';
    authoritySide = await createAuthoritySide(executionId);
    const executionAttemptId = authoritySide.attempt.executionAttemptId;

    const phaseLog: string[] = [];
    const abortController = new AbortController();
    // Readiness and admission precede acquisition of selected Runtime inputs,
    // so both are counted at the instant the pull reaches the Authority.
    let readyAtRuntimeInputsPull = -1;
    let admittedAtRuntimeInputsPull = -1;
    authoritySide.onRuntimeInputsRequest = () => {
      readyAtRuntimeInputsPull = authoritySide.attempt.runtimeReadyEvents.length;
      admittedAtRuntimeInputsPull = authoritySide.attempt.operationAdmittedEvents.length;
    };

    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
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
    expect(workflowResult(workerResult.outcome).status).toBe('completed');
    expect(workerResult.decision).toBe('accepted');

    // Verify phase ordering
    expect(phaseLog).toEqual(['bootstrap', 'materialize', 'loadContributions', 'execute', 'postCommit']);

    // The Authority published readiness and admitted the run, both before the
    // worker was allowed to pull its selected runtime inputs.
    expect(readyAtRuntimeInputsPull).toBe(1);
    expect(admittedAtRuntimeInputsPull).toBe(1);
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(1);
    expect(authoritySide.attempt.runtimeReadyEvents[0]).toMatchObject({ executionAttemptId });
    expect(authoritySide.attempt.operationAdmittedEvents).toHaveLength(1);
    expect(authoritySide.attempt.operationAdmittedEvents[0]).toMatchObject({
      executionAttemptId,
      operationKind: 'workload-invocation',
    });

    // Verify outcome was submitted
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(1);
    expect(authoritySide.capture.outcomeSubmissions[0]).toMatchObject({
      executionAttemptId,
      executionId,
      outcome: { kind: 'workload-result', result: { status: 'completed' } },
    });
  }, 20_000);

  it('publishes runtime.ready BEFORE kernel ready', async () => {
    const executionId = 'exec-ready-order';
    authoritySide = await createAuthoritySide(executionId);

    const readyOrder: string[] = [];

    // Listen for kernel ready on the authority side
    const offKernelReady = authoritySide.bus.on(KernelSubjects.ready, () => {
      readyOrder.push('kernel-ready');
    });
    const offRuntimeReady = authoritySide.bus.on(ExecutionAttemptSubjects.runtime.ready, () => {
      readyOrder.push('runtime-ready');
    });

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
    });

    await runHeadlessWorkflowWorker(deps, abortController.signal);

    // Registration precedes composition, and kernel readiness is emitted by
    // `createIsolatedWorkflowRuntime` during composition.
    offKernelReady();
    offRuntimeReady();

    await vi.waitFor(() => {
      expect(readyOrder).toContain('kernel-ready');
      expect(readyOrder).toContain('runtime-ready');
    });
    expect(readyOrder.indexOf('runtime-ready')).toBeLessThan(readyOrder.indexOf('kernel-ready'));
  }, 20_000);

  it('activates contributed packages with surface: headless and skips interactive-only packages', async () => {
    const executionId = 'exec-headless-surface';
    authoritySide = await createAuthoritySide(executionId);

    const activatedPackages: string[] = [];

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
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

  it('commits an unexpected adapter exception as a technical failure and converges the owner', async () => {
    const executionId = 'exec-execution-error';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      execute: async () => {
        throw new Error('Workflow step exploded');
      },
    });

    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    expect(workerResult.outcome).toMatchObject({
      kind: 'technical-failure',
      stage: 'workload-invocation',
      message: 'Workflow step exploded',
    });
    expect(workerResult.decision).toBe('accepted');

    // The failed result was submitted
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(1);
    expect(authoritySide.capture.outcomeSubmissions[0]!.outcome).toEqual(workerResult.outcome);
    expect(authoritySide.attempt.convergedOutcomes).toEqual([workerResult.outcome]);
  }, 20_000);

  it('retries outcome submission on transient failures', async () => {
    const executionId = 'exec-retry';
    authoritySide = await createAuthoritySide(executionId);
    authoritySide.outcomeTransientFailures = 2; // Fail first 2 attempts

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
    });

    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    expect(workerResult.decision).toBe('accepted');
    // 3 submissions: 2 transient failures + 1 success
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(3);
  }, 30_000);

  it('throws AttemptOutcomeDeliveryError on a real conflicting durable outcome', async () => {
    const executionId = 'exec-conflict';
    authoritySide = await createAuthoritySide(executionId);
    authoritySide.conflictingPriorOutcome = true;

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
    });

    await expect(runHeadlessWorkflowWorker(deps, abortController.signal)).rejects.toThrow(AttemptOutcomeDeliveryError);
  }, 20_000);

  it('recovers a lost convergence acknowledgement without executing the workload twice', async () => {
    const executionId = 'exec-duplicate';
    authoritySide = await createAuthoritySide(executionId);
    authoritySide.convergenceTransientFailures = 1;

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
    });

    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    expect(workerResult.decision).toBe('duplicate');
    expect(workflowResult(workerResult.outcome).status).toBe('completed');
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(2);
    expect(authoritySide.attempt.operationAdmittedEvents).toHaveLength(1);
    expect(authoritySide.attempt.convergedOutcomes).toHaveLength(1);
  }, 20_000);

  // ─── Cancellation tests ─────────────────────────────────────

  it('binds the frozen cancel subject before setup, stops its process and commits cancellation without invoking workflow code', async () => {
    const executionId = 'exec-cancel-setup';
    const workspaceRoot = join(cwd, 'project');
    const cancelSubject = 'workflow.custom-preparation-control.cancel';
    authoritySide = await createAuthoritySide(
      executionId,
      {
        provisioning: 'create',
        custody: 'disposable',
        sourceRoots: [],
        setup: [
          {
            command: process.execPath,
            args: [
              '-e',
              "require('fs').writeFileSync('setup-ready',String(process.pid));setTimeout(()=>require('fs').writeFileSync('too-late','must-not-happen'),1500);setInterval(()=>{},100)",
            ],
            env: {},
            timeoutMs: 10_000,
          },
        ],
      },
      { ...makeRunContext(executionId), cancelSubject },
    );
    const onPostCommit = vi.fn(async () => {});
    const base = createTestDeps(authoritySide, { cwd, workspaceRoot, executionId, onPostCommit });
    const materialize = vi.fn(base.materialize);
    const execute = vi.fn(base.execute);
    const worker = runHeadlessWorkflowWorker({ ...base, materialize, execute }, new AbortController().signal);
    let setupPid = 0;
    await vi.waitFor(
      async () => {
        setupPid = Number(await readFile(join(workspaceRoot, 'setup-ready'), 'utf8'));
        expect(setupPid).toBeGreaterThan(0);
      },
      { interval: 10, timeout: 5_000 },
    );

    await authoritySide.bus.emit(createWorkflowCancelSubject(cancelSubject), { executionId });
    const result = await worker;

    expect(result).toMatchObject({ outcome: { kind: 'cancelled' }, decision: 'accepted' });
    expect(authoritySide.attempt.convergedOutcomes).toEqual([result.outcome]);
    expect(authoritySide.attempt.operationAdmittedEvents.map((event) => event.operationKind)).toEqual([
      'workspace-preparation',
    ]);
    expect(materialize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(onPostCommit).not.toHaveBeenCalled();
    expect(() => process.kill(setupPid, 0)).toThrow();
    expect((await stat(workspaceRoot)).isDirectory()).toBe(true);
    await delay(1_600);
    await expect(stat(join(workspaceRoot, 'too-late'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('preserves a cancellation result actually returned by the workflow as a workload result', async () => {
    const executionId = 'exec-workflow-returned-cancelled';
    authoritySide = await createAuthoritySide(executionId);
    const onPostCommit = vi.fn(async () => {});
    const result = await runHeadlessWorkflowWorker(
      createTestDeps(authoritySide, {
        cwd,
        executionId,
        onPostCommit,
        execute: async () => ({
          executionId,
          workflowId: 'test-workflow',
          status: 'cancelled',
          reason: 'Workflow chose to stop',
        }),
      }),
      new AbortController().signal,
    );
    expect(workflowResult(result.outcome)).toMatchObject({ status: 'cancelled', reason: 'Workflow chose to stop' });
    expect(onPostCommit).toHaveBeenCalledTimes(1);
    expect(authoritySide.attempt.convergedOutcomes).toEqual([workflowResult(result.outcome)]);
  }, 20_000);

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

    // The abort lands inside `deps.bootstrap`, before the pre-bus exists.
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(0);
  }, 20_000);

  it('settles canonical cancellation during a blocked selected-runtime-input pull', async () => {
    const executionId = 'exec-cancel-context-pull';
    authoritySide = await createAuthoritySide(executionId);

    let releaseRuntimeInputs!: () => void;
    authoritySide.runtimeInputsGate = new Promise<void>((resolve) => {
      releaseRuntimeInputs = resolve;
    });
    let markRuntimeInputsRequested!: () => void;
    const runtimeInputsRequested = new Promise<void>((resolve) => {
      markRuntimeInputsRequested = resolve;
    });
    authoritySide.onRuntimeInputsRequest = markRuntimeInputsRequested;

    const abortController = new AbortController();
    const worker = runHeadlessWorkflowWorker(
      createTestDeps(authoritySide, { cwd, executionId }),
      abortController.signal,
    );

    await runtimeInputsRequested;
    abortController.abort();
    const result = await worker;
    expect(result.outcome).toMatchObject({ kind: 'cancelled' });
    releaseRuntimeInputs();

    // The pull is reached only after registration and admission succeeded.
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(1);
    expect(authoritySide.attempt.operationAdmittedEvents).toHaveLength(1);
    expect(authoritySide.attempt.operationAdmittedEvents[0]).toMatchObject({ operationKind: 'workload-invocation' });
    expect(authoritySide.capture.kernelReadyEvents).toHaveLength(0);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(1);
  }, 20_000);

  it('cancellation during materialization produces canonical cancellation', async () => {
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
    expect(workerResult.outcome).toMatchObject({ kind: 'cancelled' });

    // Materialization runs after registration, so readiness stands.
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(1);
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

    const result = await runHeadlessWorkflowWorker(deps, abortController.signal);
    expect(result.outcome).toMatchObject({
      kind: 'technical-failure',
      stage: 'workload-invocation',
      message: materializeError.message,
    });

    // Acquisition is admitted Invocation; its failure commits without inventing a workflow result.
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(1);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(1);
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

    // The signal is checked before the pre-bus is created, so nothing ran.
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(0);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(0);
  }, 20_000);

  it('asynchronous post-commit observation failures are swallowed', async () => {
    const executionId = 'exec-postcommit-error';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      onPostCommit: async () => {
        throw new Error('Artifact write failed');
      },
    });

    // Should not throw despite postCommit failure
    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    expect(workflowResult(workerResult.outcome).status).toBe('completed');
    expect(workerResult.decision).toBe('accepted');
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(1);
  }, 20_000);

  it('synchronous post-commit observation failure preserves the original canonical result and ACK', async () => {
    const executionId = 'exec-postcommit-sync-error';
    authoritySide = await createAuthoritySide(executionId);
    const observed: string[] = [];
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      onPostCommit: (result, decision) => {
        observed.push(result.status, decision);
        throw new Error('Artifact observer threw before returning a promise');
      },
    });
    const workerResult = await runHeadlessWorkflowWorker(deps, new AbortController().signal);
    expect(observed).toEqual(['completed', 'accepted']);
    expect(workflowResult(workerResult.outcome)).toEqual({
      executionId,
      workflowId: 'test-workflow',
      status: 'completed',
    });
    expect(workerResult.decision).toBe('accepted');
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(1);
    expect(authoritySide.attempt.convergedOutcomes).toEqual([workflowResult(workerResult.outcome)]);
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

    const result = await runHeadlessWorkflowWorker(failingDeps, abortController.signal);
    expect(result.outcome).toMatchObject({ kind: 'technical-failure', message: 'Authority reconnection failed' });

    // Composition follows registration and admission, so readiness stands.
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(1);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(1);
  }, 20_000);

  it('cooperative cancellation during execution produces canonical cancellation with ACK', async () => {
    const executionId = 'exec-cancel-during-exec';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
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

    // Cooperative AbortError produces confirmed cancellation, not a fabricated
    // workflow result or infrastructure failure, and still requires an ACK.
    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    expect(workerResult.outcome).toMatchObject({ kind: 'cancelled' });
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
    // The failure precedes registration, so nothing was published.
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(0);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(0);
  }, 20_000);

  // ─── Finding 4: Cancellation during materialization via bus ────

  it('cancel during materialization via bus produces a cancelled outcome', async () => {
    const executionId = 'exec-cancel-bus-materialize';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
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

    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    // Readiness was published before the runtime inputs were pulled.
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(1);
    // Outcome should be cancelled
    expect(workerResult.outcome).toMatchObject({ kind: 'cancelled' });
  }, 20_000);

  it('carries cancellation on the retained control bus while runtime composition is connecting', async () => {
    const executionId = 'exec-cancel-handoff-propagation';
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
        if (runtimeConnectionCount === 2) {
          cancellationPropagationPending = true;
          await cancellationPropagation;
        }
        await createTestBusConnector(authoritySide)(bus, credentials, signal);
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
    expect(workerResult.outcome).toMatchObject({ kind: 'cancelled' });
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(1);
  }, 20_000);

  it('abort after runtime composition produces canonical cancellation', async () => {
    const executionId = 'exec-abort-pre-ready';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();

    let composeCount = 0;
    const baseDeps = createTestDeps(authoritySide, {
      cwd,
      executionId,
    });

    // Override connectBus to abort on the second call (during runtime composition)
    // right after it succeeds, so the runtime is composed but the run never executes.
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

    // Readiness was published once, long before composition.
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(1);
    expect(workerResult.outcome).toMatchObject({ kind: 'cancelled' });
  }, 20_000);

  it('cancellation during loadContributions produces canonical cancellation', async () => {
    const executionId = 'exec-cancel-contributions';
    authoritySide = await createAuthoritySide(executionId);

    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
      loadContributions: async () => {
        abortController.abort();
        return [];
      },
    });

    const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(1);
    expect(workerResult.outcome).toMatchObject({ kind: 'cancelled' });
  }, 20_000);

  it('contribution load failure fails the run after readiness', async () => {
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

    const result = await runHeadlessWorkflowWorker(deps, abortController.signal);
    expect(result.outcome).toMatchObject({ kind: 'technical-failure', message: 'Package import failed' });

    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(1);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(1);
  }, 20_000);

  it('rejects a tampered transitive contribution module', async () => {
    const executionId = 'exec-contribution-helper-tamper';
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
    const runContext = {
      ...makeRunContext(executionId),
      workerManifest: { contributionRefs: [ref] },
    };
    authoritySide = await createAuthoritySide(executionId, undefined, runContext);

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

    const result = await runHeadlessWorkflowWorker(deps, new AbortController().signal);
    expect(result.outcome).toMatchObject({ kind: 'technical-failure', stage: 'workload-invocation' });
    expect(authoritySide.attempt.runtimeReadyEvents).toHaveLength(1);
    expect(authoritySide.capture.kernelReadyEvents).toHaveLength(0);
    expect(authoritySide.capture.outcomeSubmissions).toHaveLength(1);
  }, 20_000);

  // ─── Finding 5: MaterializedWorkspace cleanup contract ─────────

  it('calls materializer cleanup on success', async () => {
    const executionId = 'exec-cleanup-success';
    authoritySide = await createAuthoritySide(executionId);

    let cleanupCalled = false;
    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
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
      outcome: { kind: 'workload-result', result: { status: 'completed' } },
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

  it('retains executable files after a technical failure despite its durable acknowledgement', async () => {
    const executionId = 'exec-cleanup-failure';
    authoritySide = await createAuthoritySide(executionId);

    let cleanupCalled = false;
    const abortController = new AbortController();
    const deps = createTestDeps(authoritySide, {
      cwd,
      executionId,
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

    const result = await runHeadlessWorkflowWorker(deps, abortController.signal);
    expect(result.outcome).toMatchObject({ kind: 'technical-failure', message: 'Load failed' });

    expect(cleanupCalled).toBe(false);
  }, 20_000);

  // ─── Finding 6: Teardown must not mask primary failures ────────

  it('returns the primary composition failure through the generic outcome path', async () => {
    const executionId = 'exec-teardown-mask';
    authoritySide = await createAuthoritySide(executionId);

    let connectCallCount = 0;
    const abortController = new AbortController();
    const baseDeps = createTestDeps(authoritySide, {
      cwd,
      executionId,
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

    const result = await runHeadlessWorkflowWorker(deps, abortController.signal);
    expect(result.outcome).toMatchObject({ kind: 'technical-failure', message: 'Primary composition failure' });
  }, 20_000);
});

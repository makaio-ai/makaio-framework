import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import {
  ExecutionAttemptSubjects,
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  WorkerSubjects,
  WorkflowRunResultSchema,
  type ExecutionAttemptOutcome,
  type WorkerMaterializationSpec,
  type WorkflowRunContext,
  type WorkflowRunResult,
} from '@makaio/contracts';
import { KernelSubjects } from '@makaio/kernel';
import { parseWorkflowAttemptInstruction } from '@makaio/subsystem-workflow-engine';
import { registerMemorySessionStorage } from '../../../../../services/core/src/session/storage/memory-handler.js';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { BusServerTransportProvider } from '../../bus-server-transport.js';
import {
  runHeadlessWorkflowWorker,
  type HeadlessWorkflowWorkerDeps,
  type HeadlessWorkerMaterializer,
  type HeadlessWorkerBootstrap,
} from '../headless-workflow-worker.js';
import {
  createAttemptAuthorityHarness,
  freezeWorkflowInstruction,
  type AttemptAuthorityHarness,
} from './attempt-authority-harness.js';

// ─────────────────────────────────────────────────────────────
// Provider composition descriptor
// ─────────────────────────────────────────────────────────────

/**
 * Describes a single provider composition variant for the parameterized test.
 *
 * Each composition supplies a materialization spec, a materializer function,
 * and a bootstrap function so the same headless harness lifecycle can be
 * exercised identically across all three target environments.
 */
interface ProviderComposition {
  /** Human-readable composition name used in test titles. */
  readonly name: string;
  /** Returns the portable materialization spec for this variant. */
  readonly makeSpec: () => WorkerMaterializationSpec;
  /**
   * Creates a materializer scoped to the given working directory.
   * @param cwd - Temporary workspace root for the test.
   * @returns A materializer that resolves to a `WorkerRuntimeContext`.
   */
  readonly createMaterialize: (cwd: string) => HeadlessWorkerMaterializer;
  /**
   * Creates a bootstrap function scoped to the given authority port.
   * @param port - Authority WS server port.
   * @returns A bootstrap function returning bus credentials.
   */
  readonly createBootstrap: (port: number) => HeadlessWorkerBootstrap;
}

// ─────────────────────────────────────────────────────────────
// Three provider compositions
// ─────────────────────────────────────────────────────────────

const compositions: readonly ProviderComposition[] = [
  {
    name: 'piscina-local-directory',
    makeSpec: () => ({
      kind: 'local-directory' as const,
      workspaceId: 'workspace-1',
      rootDigest: 'sha256-test-digest',
      sourcePath: 'workflow.ts',
    }),
    createMaterialize: (cwd) => async (_runContext, signal) => {
      signal.throwIfAborted();
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
    createBootstrap: (port) => async () => ({
      busUrl: `ws://127.0.0.1:${port}/bus`,
      busAuthSecret: 'piscina-test-secret',
      runtimeEnv: {},
    }),
  },
  {
    name: 'github-workspace-snapshot',
    makeSpec: () => ({
      kind: 'workspace-snapshot' as const,
      snapshotId: 'github-snap-abc123',
      digest: 'sha256-github-digest',
      sourcePath: 'workflows/deploy.ts',
    }),
    createMaterialize: (cwd) => async (_runContext, signal) => {
      signal.throwIfAborted();
      return {
        context: {
          workspaceRoot: cwd,
          sourcePath: join(cwd, 'workflows/deploy.ts'),
          contributionEntrypoints: [],
          platform: 'linux' as const,
          arch: 'x64',
        },
      };
    },
    createBootstrap: (port) => async () => ({
      busUrl: `ws://127.0.0.1:${port}/bus`,
      busAuthSecret: 'github-test-secret',
      runtimeEnv: {},
    }),
  },
  {
    name: 'fly-workspace-snapshot',
    makeSpec: () => ({
      kind: 'workspace-snapshot' as const,
      snapshotId: 'fly-snap-xyz789',
      digest: 'sha256-fly-digest',
      sourcePath: 'workflows/build.ts',
    }),
    createMaterialize: (cwd) => async (_runContext, signal) => {
      signal.throwIfAborted();
      return {
        context: {
          workspaceRoot: cwd,
          sourcePath: join(cwd, 'workflows/build.ts'),
          contributionEntrypoints: [],
          platform: 'linux' as const,
          arch: 'x64',
        },
      };
    },
    createBootstrap: (port) => async () => ({
      busUrl: `ws://127.0.0.1:${port}/bus`,
      busAuthSecret: 'fly-test-secret',
      runtimeEnv: {},
    }),
  },
];

// ─────────────────────────────────────────────────────────────
// Test infrastructure (mirrors headless-workflow-worker.integration.test.ts)
// ─────────────────────────────────────────────────────────────

/**
 * Create a minimal run context fixture with an optional materialization spec.
 * @param executionId - Execution identifier.
 * @param materializationSpec - Optional portable materialization spec.
 * @returns Valid WorkflowRunContext with minimal required fields.
 */
function makeRunContext(executionId: string, materializationSpec?: WorkerMaterializationSpec): WorkflowRunContext {
  return {
    executionId,
    workflowId: 'test-workflow',
    source: materializationSpec
      ? { kind: 'path', path: materializationSpec.sourcePath }
      : { kind: 'definition', workflowId: 'test-workflow' },
    definitionSnapshot: materializationSpec
      ? undefined
      : {
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
    materializationSpec,
  };
}

/**
 * Read only an actual workflow-produced result from a generic outcome.
 * @param outcome - Canonical terminal report.
 * @returns Validated workflow result.
 */
function workflowResult(outcome: ExecutionAttemptOutcome): WorkflowRunResult {
  expect(outcome.kind).toBe('workload-result');
  return WorkflowRunResultSchema.parse(outcome.kind === 'workload-result' ? outcome.result : undefined);
}

/**
 * Build a read-only empty adapter repository required by the runtime seam.
 * @returns Adapter repository stub that throws on write operations.
 */
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
 * Authority-side test harness with lifecycle event capture.
 */
interface AuthoritySide {
  bus: IMakaioBus;
  port: number;
  capture: LifecycleCapture;
  /** Authority-side ExecutionAttempt gates, attempt identity, and gate captures. */
  attempt: AttemptAuthorityHarness;
  cleanup: () => Promise<void>;
}

/**
 * Create a full authority-side test harness.
 * @param executionId - Execution identifier.
 * @param materializationSpec - Optional materialization spec for the run context.
 * @returns Authority harness with bus, WS server, and lifecycle capture.
 */
async function createAuthoritySide(
  executionId: string,
  materializationSpec?: WorkerMaterializationSpec,
): Promise<AuthoritySide> {
  const authority = createBusInstance();
  authority.registerNamespaces([...FrameworkContractNamespaces, ...FrameworkStorageNamespaces]);
  const offStorage = registerMemorySessionStorage(authority);
  const runContext = makeRunContext(executionId, materializationSpec);
  let state!: AuthoritySide;
  const attempt = await createAttemptAuthorityHarness(authority, executionId, {
    instruction: freezeWorkflowInstruction(runContext),
    beforeCommit: async (_outcome, report) => {
      state.capture.outcomeSubmissions.push({
        executionAttemptId: state.attempt.executionAttemptId,
        executionId,
        outcome: report,
      });
    },
  });

  const server = createServer();
  const port = await listenOnLoopback(server);
  const serverTransport = new BusServerTransportProvider({
    httpServer: server,
    auth: attempt.serverAuth,
  });
  await serverTransport.connect(authority, 'headless-test-authority');

  state = {
    bus: authority,
    port,
    capture: {
      kernelReadyEvents: [],
      outcomeSubmissions: [],
    },
    attempt,
    cleanup: async () => {
      offGetRunContext();
      offKernelReady();
      await attempt.cleanup();
      offStorage();
      await serverTransport.disconnect();
      await closeHttpServer(server);
    },
  };

  // Host-selected realization inputs are frozen separately from the immutable instruction.
  const runtimeInputs = structuredClone({
    workerManifest: runContext.workerManifest,
    suspensionStrategy: runContext.suspensionStrategy,
  });
  const offGetRunContext = authority.on(
    WorkerSubjects.runtime.inputs.get,
    (ctx) => {
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
 * Create test dependencies for a given provider composition.
 * @param authoritySide - Authority-side harness.
 * @param composition - Provider composition descriptor.
 * @param cwd - Temporary workspace root.
 * @param executionId - Execution identifier.
 * @param phaseLog - Mutable array to record phase ordering.
 * @returns HeadlessWorkflowWorkerDeps for test use.
 */
function createCompositionDeps(
  authoritySide: AuthoritySide,
  composition: ProviderComposition,
  cwd: string,
  executionId: string,
  phaseLog: string[],
): HeadlessWorkflowWorkerDeps {
  const materialize = composition.createMaterialize(cwd);
  const bootstrapFn = composition.createBootstrap(authoritySide.port);

  return {
    executionId,
    executionAttemptId: authoritySide.attempt.executionAttemptId,
    bootstrapDeadlineAt: authoritySide.attempt.bootstrapDeadlineAt,
    workflowEnv: {},
    bootstrap: async (signal) => {
      phaseLog.push('bootstrap');
      return bootstrapFn(signal);
    },
    connectBus: createTestBusConnector(authoritySide),
    materialize: async (runContext, signal) => {
      phaseLog.push('materialize');
      return materialize(runContext, signal);
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
    configRepository: createEmptyAdapterRepository(),
    toolsets: [],
    onPostCommit: async () => {
      phaseLog.push('postCommit');
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('portable provider-neutral harness', () => {
  let authoritySide: AuthoritySide | undefined;
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'makaio-portable-worker-'));
  });

  afterEach(async () => {
    if (authoritySide !== undefined) {
      await authoritySide.cleanup();
      authoritySide = undefined;
    }
    await rm(cwd, { recursive: true, force: true });
  });

  // ─── Parameterized lifecycle tests ────────────────────────

  describe.each(compositions)('composition: $name', (composition) => {
    it('runs identical lifecycle: register -> admit -> context pull -> contribution activation -> execute -> outcome ACK -> cleanup', async () => {
      const executionId = `exec-${composition.name}`;
      const spec = composition.makeSpec();
      const authority = await createAuthoritySide(executionId, spec);
      authoritySide = authority;
      const executionAttemptId = authority.attempt.executionAttemptId;

      const phaseLog: string[] = [];
      const readyOrder: string[] = [];
      const abortController = new AbortController();

      // Track runtime-ready and kernel-ready ordering on the authority bus
      const offKernelReady = authority.bus.on(KernelSubjects.ready, () => {
        readyOrder.push('kernel-ready');
      });
      const offRuntimeReady = authority.bus.on(ExecutionAttemptSubjects.runtime.ready, () => {
        readyOrder.push('runtime-ready');
      });

      const deps = createCompositionDeps(authority, composition, cwd, executionId, phaseLog);

      const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

      offKernelReady();
      offRuntimeReady();

      // Verify phase ordering is identical across all compositions
      expect(phaseLog).toEqual(['bootstrap', 'materialize', 'loadContributions', 'execute', 'postCommit']);

      // Verify exactly one runtime readiness and one generic Invocation admission.
      expect(authority.attempt.runtimeReadyEvents).toHaveLength(1);
      expect(authority.attempt.runtimeReadyEvents[0]).toMatchObject({ executionAttemptId });
      expect(authority.attempt.operationAdmittedEvents).toHaveLength(1);
      expect(authority.attempt.operationAdmittedEvents[0]).toMatchObject({
        executionAttemptId,
        operationKind: 'workload-invocation',
      });

      // Verify exactly 1 outcome with status 'completed'
      expect(authority.capture.outcomeSubmissions).toHaveLength(1);
      expect(authority.capture.outcomeSubmissions[0]).toMatchObject({
        executionAttemptId,
        executionId,
        outcome: { kind: 'workload-result', result: { status: 'completed' } },
      });

      // Verify worker result
      expect(workerResult.decision).toBe('accepted');
      expect(workflowResult(workerResult.outcome).status).toBe('completed');

      // Registration precedes composition, which is what emits kernel readiness
      await vi.waitFor(() => {
        expect(readyOrder).toContain('kernel-ready');
        expect(readyOrder).toContain('runtime-ready');
      });
      expect(readyOrder.indexOf('runtime-ready')).toBeLessThan(readyOrder.indexOf('kernel-ready'));
    }, 20_000);

    it('handles cancellation during materialization identically', async () => {
      const executionId = `exec-cancel-${composition.name}`;
      const spec = composition.makeSpec();
      const authority = await createAuthoritySide(executionId, spec);
      authoritySide = authority;

      const abortController = new AbortController();
      const phaseLog: string[] = [];

      const deps: HeadlessWorkflowWorkerDeps = {
        executionId,
        executionAttemptId: authority.attempt.executionAttemptId,
        bootstrapDeadlineAt: authority.attempt.bootstrapDeadlineAt,
        workflowEnv: {},
        bootstrap: async (signal) => {
          phaseLog.push('bootstrap');
          const bootstrapFn = composition.createBootstrap(authority.port);
          return bootstrapFn(signal);
        },
        connectBus: createTestBusConnector(authority),
        materialize: async (_runContext, signal) => {
          phaseLog.push('materialize');
          // Cancel during materialization
          abortController.abort();
          signal.throwIfAborted();
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
        configRepository: createEmptyAdapterRepository(),
        toolsets: [],
      };

      const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

      // Cooperative cancellation produces a canonical cancellation, not a workflow result
      expect(workerResult.outcome).toMatchObject({ kind: 'cancelled' });

      // Materialization runs after registration, so readiness stands
      expect(authority.attempt.runtimeReadyEvents).toHaveLength(1);
      // Cancelled outcome IS submitted
      expect(authority.capture.outcomeSubmissions).toHaveLength(1);
      expect(authority.capture.outcomeSubmissions[0]!.outcome).toMatchObject({ kind: 'cancelled' });
      expect(authority.attempt.convergedOutcomes).toEqual([workerResult.outcome]);

      // Cleanup is deterministic: phases stop at materialize
      expect(phaseLog).toContain('bootstrap');
      expect(phaseLog).toContain('materialize');
      expect(phaseLog).not.toContain('execute');
      expect(phaseLog).not.toContain('postCommit');
    }, 20_000);
  });

  // ─── Durable record portability ───────────────────────────

  describe('durable record portability', () => {
    /**
     * Patterns that must NOT appear in the serialized frozen instruction.
     *
     * These cover absolute paths, Authority-local state, host platform
     * leaks, secret material references, and package installation paths.
     */
    const forbiddenPatterns = [
      'makaioHome',
      'worktree',
      'repoPath',
      'node_modules',
      'process.platform',
      'process.arch',
      'MAKAIO_HOME',
      'process.env',
    ] as const;

    it('frozen instruction excludes local paths, runtime composition and credentials', () => {
      for (const composition of compositions) {
        const spec = composition.makeSpec();
        const runContext = makeRunContext(`exec-portability-${composition.name}`, spec);
        runContext.env = { INJECTED_TOKEN: 'fixture-secret-not-for-durable-input' };
        const instruction = freezeWorkflowInstruction(runContext);
        const serialized = JSON.stringify(instruction);
        expect(serialized).not.toContain('fixture-secret-not-for-durable-input');
        expect(serialized).not.toContain('workerManifest');
        expect(serialized).not.toContain('suspensionStrategy');

        // No absolute paths (Unix or Windows)
        expect(serialized).not.toMatch(/":\/[^"]/);
        expect(serialized).not.toMatch(/"[A-Z]:\\[^"]/);

        // No forbidden field names or platform-local references
        for (const pattern of forbiddenPatterns) {
          expect(serialized).not.toContain(pattern);
        }

        // materializationSpec is present and has the expected kind
        const actualSpec = parseWorkflowAttemptInstruction(instruction).materializationSpec;
        expect(actualSpec).toBeDefined();
        if (actualSpec === undefined) throw new Error('materializationSpec missing');
        expect(actualSpec.kind).toBe(spec.kind);

        // Verify kind-specific fields
        if (spec.kind === 'local-directory' && actualSpec.kind === 'local-directory') {
          expect(actualSpec.workspaceId).toBe(spec.workspaceId);
          expect(actualSpec.rootDigest).toBe(spec.rootDigest);
          expect(actualSpec.sourcePath).toBe(spec.sourcePath);
        } else if (spec.kind === 'workspace-snapshot' && actualSpec.kind === 'workspace-snapshot') {
          expect(actualSpec.snapshotId).toBe(spec.snapshotId);
          expect(actualSpec.digest).toBe(spec.digest);
          expect(actualSpec.sourcePath).toBe(spec.sourcePath);
        }
      }
    });
  });
});

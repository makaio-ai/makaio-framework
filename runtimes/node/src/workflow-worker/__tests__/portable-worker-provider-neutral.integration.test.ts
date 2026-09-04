import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import {
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  WorkerSubjects,
  WorkflowRunResultSchema,
  WorkflowSubjects,
  type OutcomeAckDecision,
  type WorkerMaterializationSpec,
  type WorkflowRunContext,
  type WorkflowRunResult,
} from '@makaio/contracts';
import { KernelSubjects } from '@makaio/kernel';
import { registerMemorySessionStorage } from '../../../../../services/core/src/session/storage/memory-handler.js';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { BusServerTransportProvider } from '../../bus-server-transport.js';
import {
  runHeadlessWorkflowWorker,
  type HeadlessWorkflowWorkerDeps,
  type HeadlessWorkerMaterializer,
  type HeadlessWorkerBootstrap,
} from '../headless-workflow-worker.js';

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
 * Authority-side test harness with lifecycle event capture.
 */
interface AuthoritySide {
  bus: IMakaioBus;
  port: number;
  capture: LifecycleCapture;
  /** Run context the authority will return. */
  runContext: WorkflowRunContext;
  /** Override the outcome decision returned by the authority. */
  outcomeDecision: OutcomeAckDecision;
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

  const server = createServer();
  const port = await listenOnLoopback(server);
  const serverTransport = new BusServerTransportProvider({
    httpServer: server,
  });
  await serverTransport.connect(authority, 'headless-test-authority');

  const runContext = makeRunContext(executionId, materializationSpec);

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
    (ctx) => {
      ctx.setResult(state.runContext);
    },
    { filter: { executionId } },
  );

  // Capture attempt-ready events
  const offAttemptReady = authority.on(WorkerSubjects.control['attempt-ready'], (ctx) => {
    state.capture.attemptReadyEvents.push({
      executionAttemptId: ctx.payload.executionAttemptId,
      executionId: ctx.payload.executionId,
      adapters: [...ctx.payload.adapters],
    });
  });

  // Handle outcome submission
  const offOutcomeSubmit = authority.on(WorkerSubjects.control.outcome.submit, (ctx) => {
    state.capture.outcomeSubmissions.push({
      executionAttemptId: ctx.payload.executionAttemptId,
      executionId: ctx.payload.executionId,
      result: WorkflowRunResultSchema.parse(ctx.payload.result),
    });
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
 * @returns Bus connector function that creates a WS client transport.
 */
function createTestBusConnector(port: number): HeadlessWorkflowWorkerDeps['connectBus'] {
  return async (bus, _credentials, _signal) => {
    const transport = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}/bus`,
      autoReconnect: false,
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
 * @param executionAttemptId - Attempt identifier.
 * @param phaseLog - Mutable array to record phase ordering.
 * @returns HeadlessWorkflowWorkerDeps for test use.
 */
function createCompositionDeps(
  authoritySide: AuthoritySide,
  composition: ProviderComposition,
  cwd: string,
  executionId: string,
  executionAttemptId: string,
  phaseLog: string[],
): HeadlessWorkflowWorkerDeps {
  const materialize = composition.createMaterialize(cwd);
  const bootstrapFn = composition.createBootstrap(authoritySide.port);

  return {
    executionId,
    executionAttemptId,
    bootstrap: async (signal) => {
      phaseLog.push('bootstrap');
      return bootstrapFn(signal);
    },
    connectBus: createTestBusConnector(authoritySide.port),
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
    it('runs identical lifecycle: context pull -> contribution activation -> attempt-ready -> execute -> outcome ACK -> cleanup', async () => {
      const executionId = `exec-${composition.name}`;
      const executionAttemptId = `attempt-${composition.name}`;
      const spec = composition.makeSpec();
      const authority = await createAuthoritySide(executionId, spec);
      authoritySide = authority;

      const phaseLog: string[] = [];
      const readyOrder: string[] = [];
      const abortController = new AbortController();

      // Track kernel-ready and attempt-ready ordering on the authority bus
      const offKernelReady = authority.bus.on(KernelSubjects.ready, () => {
        readyOrder.push('kernel-ready');
      });
      const offAttemptReady = authority.bus.on(WorkerSubjects.control['attempt-ready'], () => {
        readyOrder.push('attempt-ready');
      });

      const deps = createCompositionDeps(authority, composition, cwd, executionId, executionAttemptId, phaseLog);

      const workerResult = await runHeadlessWorkflowWorker(deps, abortController.signal);

      offKernelReady();
      offAttemptReady();

      // Verify phase ordering is identical across all compositions
      expect(phaseLog).toEqual(['bootstrap', 'materialize', 'loadContributions', 'execute', 'postCommit']);

      // Verify exactly 1 attempt-ready with correct IDs
      await vi.waitFor(() => {
        expect(authority.capture.attemptReadyEvents).toHaveLength(1);
      });
      expect(authority.capture.attemptReadyEvents[0]).toMatchObject({
        executionAttemptId,
        executionId,
      });

      // Verify exactly 1 outcome with status 'completed'
      expect(authority.capture.outcomeSubmissions).toHaveLength(1);
      expect(authority.capture.outcomeSubmissions[0]).toMatchObject({
        executionAttemptId,
        executionId,
        result: { status: 'completed' },
      });

      // Verify worker result
      expect(workerResult.decision).toBe('accepted');
      expect(workerResult.result.status).toBe('completed');

      // Verify kernel ready fires before attempt ready
      await vi.waitFor(() => {
        expect(readyOrder).toContain('kernel-ready');
        expect(readyOrder).toContain('attempt-ready');
      });
      expect(readyOrder.indexOf('kernel-ready')).toBeLessThan(readyOrder.indexOf('attempt-ready'));
    }, 20_000);

    it('handles cancellation during materialization identically', async () => {
      const executionId = `exec-cancel-${composition.name}`;
      const executionAttemptId = `attempt-cancel-${composition.name}`;
      const spec = composition.makeSpec();
      const authority = await createAuthoritySide(executionId, spec);
      authoritySide = authority;

      const abortController = new AbortController();
      const phaseLog: string[] = [];

      const deps: HeadlessWorkflowWorkerDeps = {
        executionId,
        executionAttemptId,
        bootstrap: async (signal) => {
          phaseLog.push('bootstrap');
          const bootstrapFn = composition.createBootstrap(authority.port);
          return bootstrapFn(signal);
        },
        connectBus: createTestBusConnector(authority.port),
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

      // Cooperative cancellation produces a cancelled result
      expect(workerResult.result.status).toBe('cancelled');

      // No attempt-ready should have been emitted
      expect(authority.capture.attemptReadyEvents).toHaveLength(0);
      // Cancelled outcome IS submitted
      expect(authority.capture.outcomeSubmissions).toHaveLength(1);
      expect(authority.capture.outcomeSubmissions[0]!.result.status).toBe('cancelled');

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
     * Patterns that must NOT appear in a serialized durable run context.
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

    it('durable run context contains no absolute Authority path, makaioHome, worktree, host platform, package installation path, or secret', () => {
      for (const composition of compositions) {
        const spec = composition.makeSpec();
        const runContext = makeRunContext(`exec-portability-${composition.name}`, spec);
        const serialized = JSON.stringify(runContext);

        // No absolute paths (Unix or Windows)
        expect(serialized).not.toMatch(/":\/[^"]/);
        expect(serialized).not.toMatch(/"[A-Z]:\\[^"]/);

        // No forbidden field names or platform-local references
        for (const pattern of forbiddenPatterns) {
          expect(serialized).not.toContain(pattern);
        }

        // materializationSpec is present and has the expected kind
        const actualSpec = runContext.materializationSpec;
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

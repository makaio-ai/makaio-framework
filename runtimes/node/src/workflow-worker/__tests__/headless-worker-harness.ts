import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import {
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  WorkflowRunResultSchema,
  WorkerSubjects,
  type ExecutionAttemptOutcome,
  type WorkerRuntimeContext,
  type WorkflowRunContext,
  type WorkflowRunResult,
  type WorkspaceRequirement,
} from '@makaio/contracts';
import { KernelSubjects } from '@makaio/kernel';
import { registerMemorySessionStorage } from '../../../../../services/core/src/session/storage/memory-handler.js';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { BusServerTransportProvider } from '../../bus-server-transport.js';
import { type HeadlessWorkflowWorkerDeps } from '../headless-workflow-worker.js';
import {
  createAttemptAuthorityHarness,
  freezeWorkflowInstruction,
  type AttemptAuthorityHarness,
  type AttemptAuthorityHarnessOptions,
} from './attempt-authority-harness.js';

// ─────────────────────────────────────────────────────────────
// Shared test helpers (extracted from headless-workflow-worker.integration.test.ts)
// ─────────────────────────────────────────────────────────────

/**
 * Minimal run context fixture for integration tests.
 * @param executionId - Execution identifier.
 * @returns Valid WorkflowRunContext with minimal required fields.
 */
export function makeRunContext(executionId: string): WorkflowRunContext {
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
export function workflowResult(outcome: ExecutionAttemptOutcome): WorkflowRunResult {
  expect(outcome.kind).toBe('workload-result');
  return WorkflowRunResultSchema.parse(outcome.kind === 'workload-result' ? outcome.result : undefined);
}

/**
 * Build the read-only empty adapter repository required by the runtime seam.
 * @returns Stub adapter repository that rejects every write.
 */
export function createEmptyAdapterRepository() {
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
export interface LifecycleCapture {
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
export interface AuthoritySide {
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
  /**
   * Optional gate that holds every `outcome.submit` inside the Authority ingress.
   *
   * The submission is captured before the gate is awaited, so a test can observe
   * that the outcome reached the Authority while its commit is still pending.
   */
  outcomeSubmitGate?: Promise<void>;
  /** Optional hook invoked when the runtime-input request reaches the Authority. */
  onRuntimeInputsRequest?: () => void;
  /**
   * Return the number of raw transport sockets currently open between a worker
   * and the test HTTP server. Each WebSocket connection to the `/bus` endpoint
   * appears here once its HTTP upgrade completes and is removed when the
   * underlying socket closes.
   * @returns Active peer socket count.
   */
  getPeerCount(): number;
  /**
   * Destroy the underlying socket of the first active peer connection, simulating
   * a server-side connection drop without sending a clean WebSocket close frame.
   * Useful for reconnect and report-retry tests.
   * @returns `true` when a peer was found and its socket was destroyed; `false` when no peers are connected.
   */
  dropFirstPeer(): boolean;
  cleanup: () => Promise<void>;
}

/** Optional overrides for {@link createAuthoritySide}. */
export interface CreateAuthoritySideOptions {
  /**
   * Pre-constructed attempt repository forwarded to {@link createAttemptAuthorityHarness}.
   *
   * Supply a SQLite-backed repository when the test needs evidence to survive a
   * database restart; omit to use the default in-memory repository.
   */
  readonly repository?: AttemptAuthorityHarnessOptions['repository'];
}

/**
 * Create a full authority-side test harness.
 * @param executionId - Execution identifier.
 * @param workspace - Optional project working-area requirement, separate from executable files.
 * @param runContext - Owner snapshot frozen before Attempt creation.
 * @param overrides - Optional harness configuration overrides (e.g. SQLite repository).
 * @returns Authority harness with bus, WS server, and lifecycle capture.
 */
export async function createAuthoritySide(
  executionId: string,
  workspace?: WorkspaceRequirement,
  runContext = makeRunContext(executionId),
  overrides?: CreateAuthoritySideOptions,
): Promise<AuthoritySide> {
  const authority = createBusInstance();
  authority.registerNamespaces([...FrameworkContractNamespaces, ...FrameworkStorageNamespaces]);
  const offStorage = registerMemorySessionStorage(authority);
  let state!: AuthoritySide;
  let outcomeCallCount = 0;
  const attempt = await createAttemptAuthorityHarness(authority, executionId, {
    instruction: freezeWorkflowInstruction(runContext, workspace),
    ...(overrides?.repository !== undefined ? { repository: overrides.repository } : {}),
    beforeCommit: async (_outcome, report) => {
      state.capture.outcomeSubmissions.push({
        executionAttemptId: state.attempt.executionAttemptId,
        executionId,
        outcome: report,
      });
      await state.outcomeSubmitGate;
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

  // Track raw transport sockets so tests can inspect the active peer count and
  // simulate server-side disconnects without touching the WebSocket library directly.
  const peerSockets = new Set<Duplex>();
  server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => {
    peerSockets.add(socket);
    socket.once('close', () => peerSockets.delete(socket));
  });

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
    getPeerCount: () => peerSockets.size,
    dropFirstPeer: () => {
      const [first] = peerSockets;
      if (first === undefined) return false;
      first.destroy();
      return true;
    },
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
export function createTestBusConnector(authoritySide: AuthoritySide): HeadlessWorkflowWorkerDeps['connectBus'] {
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
export function createTestDeps(
  authoritySide: AuthoritySide,
  options?: {
    cwd?: string;
    workspaceRoot?: string;
    preparation?: HeadlessWorkflowWorkerDeps['preparation'];
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
    ...(options?.preparation === undefined ? {} : { preparation: options.preparation }),
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
// Process-management helpers (shared across attempt-control tests)
// ─────────────────────────────────────────────────────────────

/** Pids written by the setup command's child and grandchild processes. */
export interface SetupPids {
  readonly child: number;
  readonly grandchild: number;
}

const execFileAsync = promisify(execFile);

/**
 * Node.js source executed as the setup command.
 *
 * The program spawns a grandchild (in the same process group as itself),
 * writes `<childPid>:<grandchildPid>` to the file named by the `PID_FILE`
 * env var, then blocks indefinitely to simulate a long-running setup step.
 * @returns Inline Node.js script string.
 */
export function buildSetupSource(): string {
  return [
    `'use strict';`,
    `const cp = require('child_process');`,
    `const fs = require('fs');`,
    `const gc = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {`,
    `  stdio: 'ignore',`,
    `  detached: false,`,
    `});`,
    `gc.on('error', () => {});`,
    `fs.writeFileSync(process.env.PID_FILE, String(process.pid) + ':' + String(gc.pid));`,
    `setInterval(() => {}, 1000);`,
  ].join('\n');
}

/**
 * Poll for the pid file written by the setup command with a bounded deadline.
 * @param filePath - Absolute path the setup command writes `child:grandchild` pids to.
 * @param timeoutMs - Maximum milliseconds to wait.
 * @returns Parsed setup pids once the file is available and parseable.
 */
export async function pollPidFile(filePath: string, timeoutMs: number): Promise<SetupPids> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(filePath, 'utf8');
      const [childStr, grandchildStr] = content.trim().split(':');
      const child = Number(childStr);
      const grandchild = Number(grandchildStr);
      if (Number.isInteger(child) && child > 0 && Number.isInteger(grandchild) && grandchild > 0) {
        return { child, grandchild };
      }
    } catch {
      // File not yet written — continue polling.
    }
    await sleep(100);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for pid file: ${filePath}`);
}

/**
 * Return true when the process with the given pid is absent from the process
 * table or is a zombie (both indicate the process is no longer running).
 * @param pid - Process identifier to check.
 * @returns True when the pid is absent or zombie; false when still alive.
 */
export async function isPidAbsentOrZombie(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'stat=']);
    const stat = stdout.trim();
    // A zombie shows stat starting with 'Z'; empty means the header-only row
    // (some ps versions on macOS print nothing when the pid is not found).
    return stat === '' || stat.startsWith('Z');
  } catch {
    // ps exits with non-zero when the pid is not found → process is absent.
    return true;
  }
}

/**
 * Poll until `condition` returns true (or resolves true) or the deadline elapses.
 *
 * Accepts both synchronous and asynchronous predicates. An async predicate is
 * awaited on every tick; a synchronous predicate is called normally.
 * @param condition - Predicate (sync or async) checked on each poll tick.
 * @param timeoutMs - Maximum milliseconds to wait.
 * @param options - Optional interval and human-readable description for the error message.
 */
export async function pollUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  options?: { intervalMs?: number; description?: string },
): Promise<void> {
  const intervalMs = options?.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(intervalMs);
  }
  const label = options?.description ?? 'condition';
  throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${label}`);
}

/** A promise together with its fulfillment and rejection callbacks. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

/**
 * Create a deferred promise with explicit resolve and reject handles.
 * @returns Deferred carrying `promise`, `resolve`, and `reject`.
 */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Runtime-context materializer for cases that never reach workload invocation.
 * @param wsRoot - Workspace root the fixed context points at.
 * @returns A materialize dependency returning that fixed context.
 */
export function stubMaterialize(wsRoot: string): HeadlessWorkflowWorkerDeps['materialize'] {
  return async () => ({
    context: {
      workspaceRoot: wsRoot,
      sourcePath: join(wsRoot, 'workflow.ts'),
      contributionEntrypoints: [],
      platform: 'linux',
      arch: 'x64',
    },
  });
}

/**
 * Workspace requirement whose single setup step blocks forever.
 *
 * Every case that must prove setup did or did not run uses this requirement:
 * the pid file appears if and only if the setup command actually started.
 * The caller injects the pid file path via `setupEnv: { PID_FILE: pidFilePath }`.
 * @returns A create/disposable workspace with one blocking setup step.
 */
export function blockingSetupWorkspace(): WorkspaceRequirement {
  return {
    provisioning: 'create',
    custody: 'disposable',
    sourceRoots: [],
    setup: [
      {
        command: process.execPath,
        args: ['-e', buildSetupSource()],
        env: {},
        timeoutMs: 30_000,
      },
    ],
  };
}

/**
 * Workspace requirement whose setup exits 0 immediately without spawning anything.
 * @returns Minimal workspace requirement with a no-op setup.
 */
export function immediateExitWorkspace(): WorkspaceRequirement {
  return {
    provisioning: 'create',
    custody: 'disposable',
    sourceRoots: [],
    setup: [
      {
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        env: {},
        timeoutMs: 5_000,
      },
    ],
  };
}

import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { HmacAuth, WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import {
  ExecutionAttemptNamespace,
  ExecutionAttemptOutcomeSchema,
  ExecutionAttemptSchemas,
  ExecutionAttemptSubjects,
  FrameworkContractNamespaces,
  type ExecutionAttemptInstruction,
  type ExecutionAttemptOutcome,
} from '@makaio/contracts';
import {
  ExecutionAttemptAuthority,
  registerExecutionAttemptHandlers,
  registerOperationAdmissionHandler,
  registerRuntimeRegistrationHandler,
} from '@makaio/subsystem-workflow-engine';
import {
  createInMemoryAttemptRepository,
  driveTestAttemptToAllocated,
} from '@makaio/subsystem-workflow-engine/testing';
import { BusServerTransportProvider } from '../../bus-server-transport.js';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { installOperationDeliveryEndpoint, registerWorkerRuntime } from '../runtime-registration-client.js';
import { runWorkloadInvocation, type InstalledWorkloadAdapter } from '../workload-invocation.js';
import { bindLocalWorkspace, type WorkspaceSetupOptions } from '../../workspace-preparation/workspace-preparation.js';
import { AuthorityRequestDeliveryError } from '@makaio/runtime-node/workflow-worker';

const OWNER = 'workload-invocation-owner';
const TRANSPORT_SECRET = 'workload-invocation-integration-secret';

interface Harness {
  readonly authority: ExecutionAttemptAuthority<ExecutionAttemptOutcome>;
  readonly executionAttemptId: string;
  readonly bus: IMakaioBus;
  readonly cleanup: () => Promise<void>;
}

/**
 * Build a real Authority, authenticated WebSocket bus, and registered Runtime endpoint.
 * @param instruction - Frozen assignment created before allocation.
 * @param options - Optional transient-response failure injection.
 * @returns Connected Runtime and Authority handles for one Attempt.
 */
async function createHarness(
  instruction: ExecutionAttemptInstruction,
  options: {
    readonly dropFirstPreparationReportAck?: boolean;
    readonly dropFirstPreparationAdmissionAck?: boolean;
    readonly dropFirstInvocationAdmissionAck?: boolean;
    readonly failFirstOutcomeRequest?: boolean;
    readonly failOwnerConvergenceAfterCommit?: { readonly submittedPayloads: ExecutionAttemptOutcome[] };
    readonly instructionReadDelayMs?: number;
    readonly afterPreparationReport?: () => void;
    readonly afterPreparationAdmission?: () => void;
    readonly afterInvocationAdmission?: () => void;
    readonly preparationReports?: unknown[];
    readonly admissionGate?: { readonly entered: () => void; readonly proceed: Promise<void> };
  } = {},
): Promise<Harness> {
  const authority = new ExecutionAttemptAuthority(
    createInMemoryAttemptRepository<ExecutionAttemptOutcome>({
      parse: (input) => ExecutionAttemptOutcomeSchema.parse(input),
      serialize: (outcome) => JSON.stringify(outcome),
    }),
    { bootstrapTimeoutMs: 120_000 },
  );
  const { executionAttemptId } = await authority.createAttempt(OWNER, instruction);
  await driveTestAttemptToAllocated(authority, executionAttemptId, OWNER);

  const authorityBus = createBusInstance();
  authorityBus.registerNamespaces(FrameworkContractNamespaces);
  const cleanups = [
    registerRuntimeRegistrationHandler(authorityBus, { bus: authorityBus, authority }),
    registerOperationAdmissionHandler(authorityBus, { bus: authorityBus, authority }),
    registerExecutionAttemptHandlers(authorityBus, {
      authority,
      decodeOutcome: ({ outcome }) => outcome,
      convergence: {
        converge: async () => {
          if (options.failOwnerConvergenceAfterCommit === undefined) return;
          throw new Error('Simulated owner convergence failure after outcome commit');
        },
      },
    }),
  ];
  if (options.admissionGate !== undefined) {
    cleanups.push(
      authorityBus.on(
        ExecutionAttemptSubjects.operation.admit,
        async () => {
          options.admissionGate?.entered();
          await options.admissionGate?.proceed;
        },
        { priority: 100 },
      ),
    );
  }
  if (options.preparationReports !== undefined) {
    cleanups.push(
      authorityBus.on(
        ExecutionAttemptSubjects.operation.report,
        (ctx) => {
          options.preparationReports?.push(ctx.payload);
        },
        { priority: 100 },
      ),
    );
  }
  if (options.dropFirstPreparationReportAck) {
    let dropped = false;
    cleanups.push(
      authorityBus.on(
        ExecutionAttemptSubjects.operation.report,
        async (ctx) => {
          if (dropped) return;
          dropped = true;
          const request = ExecutionAttemptSchemas['operation.report'].request.parse(ctx.payload);
          await authority.reportOperation({ ...request, executionId: OWNER });
          options.afterPreparationReport?.();
          throw new Error('Simulated lost preparation report acknowledgement');
        },
        { priority: 100 },
      ),
    );
  }
  if (options.dropFirstInvocationAdmissionAck) {
    let dropped = false;
    cleanups.push(
      authorityBus.on(
        ExecutionAttemptSubjects.operation.admit,
        async (ctx) => {
          const request = ExecutionAttemptSchemas['operation.admit'].request.parse(ctx.payload);
          if (dropped || request.operationKind !== 'workload-invocation') return;
          dropped = true;
          await authority.admitOperation({ ...request, executionId: OWNER });
          options.afterInvocationAdmission?.();
          throw new Error('Simulated lost Invocation admission acknowledgement');
        },
        { priority: 100 },
      ),
    );
  }
  if (options.dropFirstPreparationAdmissionAck) {
    let dropped = false;
    cleanups.push(
      authorityBus.on(
        ExecutionAttemptSubjects.operation.admit,
        async (ctx) => {
          const request = ExecutionAttemptSchemas['operation.admit'].request.parse(ctx.payload);
          if (dropped || request.operationKind !== 'workspace-preparation') return;
          dropped = true;
          await authority.admitOperation({ ...request, executionId: OWNER });
          options.afterPreparationAdmission?.();
          throw new Error('Simulated lost Preparation admission acknowledgement');
        },
        { priority: 100 },
      ),
    );
  }
  if (options.afterPreparationReport !== undefined) {
    cleanups.push(
      authorityBus.on(
        ExecutionAttemptSubjects.operation.report,
        async (ctx) => {
          const request = ExecutionAttemptSchemas['operation.report'].request.parse(ctx.payload);
          const decision = await authority.reportOperation({ ...request, executionId: OWNER });
          if (decision.kind !== 'accepted' && decision.kind !== 'duplicate') {
            throw new Error(`Preparation report was unexpectedly refused: ${decision.kind}`);
          }
          options.afterPreparationReport?.();
          ctx.setResult({ decision: decision.kind, binding: decision.binding });
        },
        { priority: 100 },
      ),
    );
  }
  if (options.failFirstOutcomeRequest) {
    let failed = false;
    cleanups.push(
      authorityBus.on(
        ExecutionAttemptSubjects.outcome.submit,
        () => {
          if (failed) return;
          failed = true;
          throw new Error('Simulated transient outcome acknowledgement failure');
        },
        { priority: 100 },
      ),
    );
  }
  if (options.failOwnerConvergenceAfterCommit !== undefined) {
    cleanups.push(
      authorityBus.on(
        ExecutionAttemptSubjects.outcome.submit,
        (ctx) => {
          const request = ExecutionAttemptSchemas['outcome.submit'].request.parse(ctx.payload);
          options.failOwnerConvergenceAfterCommit?.submittedPayloads.push(request.outcome);
        },
        { priority: 100 },
      ),
    );
  }
  if (options.instructionReadDelayMs !== undefined) {
    cleanups.push(
      authorityBus.on(
        ExecutionAttemptSubjects.instruction.get,
        async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, options.instructionReadDelayMs));
        },
        { priority: 100 },
      ),
    );
  }
  const server = createServer();
  const port = await listenOnLoopback(server);
  const serverTransport = new BusServerTransportProvider({
    httpServer: server,
    auth: new HmacAuth({
      secret: TRANSPORT_SECRET,
      resolveSecret: (id) => (id === executionAttemptId ? TRANSPORT_SECRET : null),
      resolvePeer: (id) =>
        id === executionAttemptId
          ? { kind: 'workflow-execution-attempt', id, authenticated: true, claims: { executionId: OWNER } }
          : null,
    }),
  });
  await serverTransport.connect(authorityBus, 'workload-invocation-authority');

  const bus = createBusInstance();
  bus.registerNamespace(ExecutionAttemptNamespace);
  const clientTransport = new WebSocketClientTransport({
    url: `ws://127.0.0.1:${port}/bus`,
    autoReconnect: false,
    auth: new HmacAuth({ secret: TRANSPORT_SECRET, identityId: executionAttemptId }),
  });
  bus.registerTransport(clientTransport);
  await bus.connect();
  const endpoint = await installOperationDeliveryEndpoint(
    bus,
    {
      executionAttemptId,
      runtimeIncarnationId: 'runtime-1',
    },
    {},
  );
  const runtimeGeneration = await registerWorkerRuntime(bus, { executionAttemptId, runtimeIncarnationId: 'runtime-1' });
  endpoint.bindGeneration(runtimeGeneration);

  return {
    authority,
    executionAttemptId,
    bus,
    cleanup: async () => {
      endpoint.cleanup();
      await bus.disconnect();
      await serverTransport.disconnect();
      await closeHttpServer(server);
      for (const cleanup of cleanups.reverse()) cleanup();
    },
  };
}

/**
 * A frozen instruction with an optional local scratch area.
 * @param workspace - Optional portable Workspace requirement.
 * @returns Immutable Attempt instruction fixture.
 */
function instruction(workspace: ExecutionAttemptInstruction['workspace'] = undefined): ExecutionAttemptInstruction {
  return {
    id: 'instruction-1',
    revision: '1',
    workload: { kind: 'marker', version: '1', input: { requested: 'marker' } },
    ...(workspace === undefined ? {} : { workspace }),
    preservation: { required: [] },
  };
}

describe('generic workload invocation', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(
      cleanups
        .splice(0)
        .reverse()
        .map((cleanup) => cleanup()),
    );
  });

  it('exposes the public Authority deadline error without invoking work before admission acknowledgement', async () => {
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const harness = await createHarness(instruction(), {
      admissionGate: { entered: entered.resolve, proceed: proceed.promise },
    });
    cleanups.push(harness.cleanup);
    let invocations = 0;
    try {
      const failure = runWorkloadInvocation(harness.bus, {
        executionAttemptId: harness.executionAttemptId,
        runtimeGeneration: 1,
        adapters: [
          {
            kind: 'marker',
            version: '1',
            invoke: async () => {
              invocations += 1;
              return {};
            },
          },
        ],
        retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 50 },
      }).catch((error: unknown) => error);
      await entered.promise;
      const error = await failure;
      expect(error).toBeInstanceOf(AuthorityRequestDeliveryError);
      expect(error).toMatchObject({ reason: 'deadline-exceeded' });
      expect(invocations).toBe(0);
      expect(
        (await harness.authority.getAttemptWithAllocation(harness.executionAttemptId))?.activeOperationId,
      ).toBeNull();
    } finally {
      proceed.resolve();
    }
  });

  it('preserves the preparation instance receiver through real setup, Invocation and ACK cleanup', async () => {
    class InstancePreparation {
      constructor(private readonly binder: typeof bindLocalWorkspace) {}

      prepare(input: Parameters<typeof bindLocalWorkspace>[0]) {
        return this.binder(input);
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'instance-preparation-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspaceRoot = join(root, 'workspace');
    const harness = await createHarness(
      instruction({
        provisioning: 'create',
        custody: 'disposable',
        sourceRoots: [],
        setup: [
          {
            command: process.execPath,
            args: ['-e', "require('fs').writeFileSync('marker','instance-prepared')"],
            env: {},
            timeoutMs: 5_000,
          },
        ],
      }),
    );
    cleanups.push(harness.cleanup);
    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      workspaceRoot,
      preparation: new InstancePreparation(bindLocalWorkspace),
      adapters: [
        {
          kind: 'marker',
          version: '1',
          invoke: async ({ workspace }) => {
            const activeAttempt = await harness.authority.getAttemptWithAllocation(harness.executionAttemptId);
            expect(activeAttempt?.activeOperationKind).toBe('workload-invocation');
            return { marker: await readFile(join(workspace!.workspaceRoot, 'marker'), 'utf8') };
          },
        },
      ],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });
    expect(result).toEqual({
      outcome: { kind: 'workload-result', result: { marker: 'instance-prepared' } },
      decision: 'accepted',
    });
    await expect(readFile(join(workspaceRoot, 'marker'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    false,
    true,
  ])('keeps setup environment private with existing precedence (host override: %s)', async (injectHostEnv) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'private-setup-env-'));
    cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const sentinel = 'private-runtime-setup-value';
    expect(process.env.MAKAIO_PRIVATE_SETUP_SENTINEL).toBeUndefined();
    const reports: unknown[] = [];
    const assignment = instruction({
      provisioning: 'bind',
      custody: 'external',
      sourceRoots: [],
      setup: [
        {
          command: process.execPath,
          args: [
            '-e',
            "require('fs').writeFileSync('setup-env-proof',JSON.stringify({privateValue:process.env.MAKAIO_PRIVATE_SETUP_SENTINEL??null,precedence:process.env.SETUP_PRECEDENCE,inheritedPath:typeof process.env.PATH==='string'}))",
          ],
          env: { SETUP_PRECEDENCE: 'recipe-value' },
          timeoutMs: 5_000,
        },
      ],
    });
    const harness = await createHarness(assignment, { preparationReports: reports });
    cleanups.push(harness.cleanup);
    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      workspaceRoot,
      ...(injectHostEnv
        ? { setupEnv: { MAKAIO_PRIVATE_SETUP_SENTINEL: sentinel, SETUP_PRECEDENCE: 'host-value' } }
        : {}),
      adapters: [
        {
          kind: 'marker',
          version: '1',
          invoke: async ({ workspace }) => {
            expect(reports).toHaveLength(1);
            expect(
              (await harness.authority.getAttemptWithAllocation(harness.executionAttemptId))?.activeOperationKind,
            ).toBe('workload-invocation');
            expect(JSON.parse(await readFile(join(workspace!.workspaceRoot, 'setup-env-proof'), 'utf8'))).toEqual({
              privateValue: injectHostEnv ? sentinel : null,
              precedence: injectHostEnv ? 'host-value' : 'recipe-value',
              inheritedPath: typeof process.env.PATH === 'string',
            });
            return { setupVerified: true };
          },
        },
      ],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });
    expect(result).toEqual({
      outcome: { kind: 'workload-result', result: { setupVerified: true } },
      decision: 'accepted',
    });
    const storedInstruction = await harness.authority.getInstruction({
      executionId: OWNER,
      executionAttemptId: harness.executionAttemptId,
    });
    expect(storedInstruction).toEqual(assignment);
    expect(JSON.stringify({ storedInstruction, reports, outcome: result.outcome })).not.toContain(sentinel);
    expect(process.env.MAKAIO_PRIVATE_SETUP_SENTINEL).toBeUndefined();
  });

  it('prepares scratch, passes the accepted binding to Invocation, and releases only after acknowledgement', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workload-invocation-'));
    await rm(workspaceRoot, { recursive: true, force: true });
    const harness = await createHarness(
      instruction({
        provisioning: 'create',
        custody: 'disposable',
        sourceRoots: [],
        setup: [
          {
            command: process.execPath,
            args: ['-e', "require('fs').writeFileSync('marker','prepared')"],
            env: {},
            timeoutMs: 5_000,
          },
        ],
      }),
    );
    cleanups.push(harness.cleanup);
    let invocationWorkspace: string | undefined;
    const adapter: InstalledWorkloadAdapter = {
      kind: 'marker',
      version: '1',
      invoke: async ({ workspace }) => {
        invocationWorkspace = workspace?.workspaceRoot;
        return { marker: await readFile(join(workspace?.workspaceRoot ?? '', 'marker'), 'utf8') };
      },
    };
    const outcome = harness.authority.waitForOutcome(harness.executionAttemptId);

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      workspaceRoot,
      adapters: [adapter],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result).toEqual({
      outcome: { kind: 'workload-result', result: { marker: 'prepared' } },
      decision: 'accepted',
    });
    expect(invocationWorkspace).toBeDefined();
    await expect(readFile(join(workspaceRoot, 'marker'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(outcome).resolves.toEqual(result.outcome);
  });

  it('settles a missing installed adapter as startup failure without inventing a Workspace', async () => {
    const harness = await createHarness(instruction());
    cleanups.push(harness.cleanup);
    const outcome = harness.authority.waitForOutcome(harness.executionAttemptId);

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      adapters: [],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result.decision).toBe('accepted');
    expect(result.outcome).toMatchObject({ kind: 'technical-failure', stage: 'startup' });
    await expect(outcome).resolves.toEqual(result.outcome);
  });

  it.each([
    undefined,
    new Error('Instruction read cancelled'),
  ])('converges cancellation when the caller aborts the delayed instruction request with %s', async (reason) => {
    const controller = new AbortController();
    const harness = await createHarness(instruction(), { instructionReadDelayMs: 50 });
    cleanups.push(harness.cleanup);
    setTimeout(() => controller.abort(reason), 5);

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      signal: controller.signal,
      adapters: [],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result).toEqual({ outcome: { kind: 'cancelled' }, decision: 'accepted' });
    await expect(harness.authority.getAttemptControlState(harness.executionAttemptId)).resolves.toMatchObject({
      activeOperationId: null,
    });
  });

  it.each([
    'Control binding cancelled',
    new Error('Control binding cancelled'),
  ])('converges cancellation before admission when control binding throws the signal reason %s', async (reason) => {
    const controller = new AbortController();
    const harness = await createHarness(instruction());
    cleanups.push(harness.cleanup);
    const outcome = harness.authority.waitForOutcome(harness.executionAttemptId);
    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      signal: controller.signal,
      adapters: [
        {
          kind: 'marker',
          version: '1',
          bindControl: async ({ signal }) => {
            controller.abort(reason);
            signal?.throwIfAborted();
            throw new Error('Control binding must throw its cancellation reason');
          },
          invoke: async () => {
            throw new Error('Invocation must not start after control binding cancellation');
          },
        },
      ],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result).toEqual({ outcome: { kind: 'cancelled' }, decision: 'accepted' });
    await expect(outcome).resolves.toEqual(result.outcome);
    await expect(harness.authority.getAttemptControlState(harness.executionAttemptId)).resolves.toMatchObject({
      activeOperationId: null,
    });
  });

  it('invokes a workspace-less installed adapter without a synthetic local root', async () => {
    const harness = await createHarness(instruction());
    cleanups.push(harness.cleanup);
    let receivedWorkspace: unknown = 'unset';

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      adapters: [
        {
          kind: 'marker',
          version: '1',
          invoke: async ({ workspace }) => {
            receivedWorkspace = workspace;
            return { mode: 'workspace-less' };
          },
        },
      ],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result).toEqual({
      outcome: { kind: 'workload-result', result: { mode: 'workspace-less' } },
      decision: 'accepted',
    });
    expect(receivedWorkspace).toBeUndefined();
  });

  it('returns the acknowledged result when a workload control release throws', async () => {
    const harness = await createHarness(instruction());
    cleanups.push(harness.cleanup);
    let releases = 0;

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      adapters: [
        {
          kind: 'marker',
          version: '1',
          bindControl: async () => ({
            signal: new AbortController().signal,
            release: () => {
              releases += 1;
              throw new Error('control cleanup failed');
            },
          }),
          invoke: async () => ({ completed: true }),
        },
      ],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result).toEqual({ outcome: { kind: 'workload-result', result: { completed: true } }, decision: 'accepted' });
    expect(releases).toBe(1);
  });

  it('preserves an adopted external Workspace after acknowledged Invocation', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workload-invocation-external-'));
    cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    await writeFile(join(workspaceRoot, 'human-file'), 'retain');
    const harness = await createHarness(
      instruction({ provisioning: 'bind', custody: 'external', sourceRoots: [], setup: [] }),
    );
    cleanups.push(harness.cleanup);

    await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      workspaceRoot,
      adapters: [{ kind: 'marker', version: '1', invoke: async () => null }],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    await expect(readFile(join(workspaceRoot, 'human-file'), 'utf8')).resolves.toBe('retain');
  });

  it('returns the acknowledged workload result when owned scratch release fails', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workload-invocation-release-failed-'));
    cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const harness = await createHarness(
      instruction({ provisioning: 'create', custody: 'disposable', sourceRoots: [], setup: [] }),
    );
    cleanups.push(harness.cleanup);
    let releases = 0;

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      workspaceRoot,
      preparation: {
        prepare: async () => ({
          binding: { workspaceRoot, sourceRoots: [] },
          runSetup: async () => ({ status: 'completed' as const, exitCode: 0 }),
          release: async () => {
            releases += 1;
            throw new Error('cleanup failed');
          },
        }),
      },
      adapters: [{ kind: 'marker', version: '1', invoke: async () => ({ completed: true }) }],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result).toEqual({ outcome: { kind: 'workload-result', result: { completed: true } }, decision: 'accepted' });
    expect(releases).toBe(1);
  });

  it('retries a lost Preparation acknowledgement without rerunning setup', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workload-invocation-report-retry-'));
    await rm(workspaceRoot, { recursive: true, force: true });
    const harness = await createHarness(
      instruction({
        provisioning: 'create',
        custody: 'disposable',
        sourceRoots: [],
        setup: [
          {
            command: process.execPath,
            args: ['-e', "require('fs').appendFileSync('setup-count','x')"],
            env: {},
            timeoutMs: 5_000,
          },
        ],
      }),
      { dropFirstPreparationReportAck: true },
    );
    cleanups.push(harness.cleanup);

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      workspaceRoot,
      adapters: [
        {
          kind: 'marker',
          version: '1',
          invoke: async ({ workspace }) => ({
            setupRuns: await readFile(join(workspace!.workspaceRoot, 'setup-count'), 'utf8'),
          }),
        },
      ],
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result.outcome).toEqual({ kind: 'workload-result', result: { setupRuns: 'x' } });
  });

  it('retries outcome acknowledgement without invoking the adapter twice', async () => {
    const harness = await createHarness(instruction(), { failFirstOutcomeRequest: true });
    cleanups.push(harness.cleanup);
    let invocations = 0;

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      adapters: [
        {
          kind: 'marker',
          version: '1',
          invoke: async () => {
            invocations += 1;
            return { invocations };
          },
        },
      ],
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result.decision).toBe('accepted');
    expect(invocations).toBe(1);
  });

  it('retains scratch and replays only the original outcome when owner convergence fails after commit', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workload-invocation-outcome-exhausted-'));
    await rm(workspaceRoot, { recursive: true, force: true });
    cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const submitted: ExecutionAttemptOutcome[] = [];
    const harness = await createHarness(
      instruction({
        provisioning: 'create',
        custody: 'disposable',
        sourceRoots: [],
        setup: [
          {
            command: process.execPath,
            args: ['-e', "require('fs').writeFileSync('marker','retain')"],
            env: {},
            timeoutMs: 5_000,
          },
        ],
      }),
      { failOwnerConvergenceAfterCommit: { submittedPayloads: submitted } },
    );
    cleanups.push(harness.cleanup);
    let invocations = 0;

    await expect(
      runWorkloadInvocation(harness.bus, {
        executionAttemptId: harness.executionAttemptId,
        runtimeGeneration: 1,
        workspaceRoot,
        adapters: [
          {
            kind: 'marker',
            version: '1',
            bindControl: async () => ({
              signal: new AbortController().signal,
              release: () => {
                throw new Error('control cleanup failed after delivery failure');
              },
            }),
            invoke: async () => {
              invocations += 1;
              return { invocations };
            },
          },
        ],
        retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
      }),
    ).rejects.toThrow('Simulated owner convergence failure after outcome commit');

    const expected = { kind: 'workload-result', result: { invocations: 1 } } as const;
    expect(invocations).toBe(1);
    expect(submitted).toEqual([expected, expected]);
    await expect(readFile(join(workspaceRoot, 'marker'), 'utf8')).resolves.toBe('retain');
  });

  it('retains scratch when Invocation fails after successful Preparation', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workload-invocation-invoke-failed-'));
    await rm(workspaceRoot, { recursive: true, force: true });
    cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const harness = await createHarness(
      instruction({
        provisioning: 'create',
        custody: 'disposable',
        sourceRoots: [],
        setup: [
          {
            command: process.execPath,
            args: ['-e', "require('fs').writeFileSync('marker','retain')"],
            env: {},
            timeoutMs: 5_000,
          },
        ],
      }),
    );
    cleanups.push(harness.cleanup);

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      workspaceRoot,
      adapters: [
        {
          kind: 'marker',
          version: '1',
          invoke: async () => {
            throw new Error('Adapter shutdown failed');
          },
        },
      ],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result.outcome).toMatchObject({ kind: 'technical-failure', stage: 'workload-invocation' });
    await expect(readFile(join(workspaceRoot, 'marker'), 'utf8')).resolves.toBe('retain');
  });

  it('retains scratch after an acknowledged setup failure and never invokes the workload', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workload-invocation-failed-'));
    await rm(workspaceRoot, { recursive: true, force: true });
    cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const harness = await createHarness(
      instruction({
        provisioning: 'create',
        custody: 'disposable',
        sourceRoots: [],
        setup: [
          {
            command: process.execPath,
            args: ['-e', "require('fs').writeFileSync('marker','diagnose');process.exit(1)"],
            env: {},
            timeoutMs: 5_000,
          },
        ],
      }),
    );
    cleanups.push(harness.cleanup);
    const outcome = harness.authority.waitForOutcome(harness.executionAttemptId);
    let invoked = false;

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      workspaceRoot,
      adapters: [
        {
          kind: 'marker',
          version: '1',
          invoke: async () => {
            invoked = true;
            return null;
          },
        },
      ],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result.outcome).toMatchObject({ kind: 'technical-failure', stage: 'workspace-preparation' });
    expect(invoked).toBe(false);
    await expect(readFile(join(workspaceRoot, 'marker'), 'utf8')).resolves.toBe('diagnose');
    await expect(outcome).resolves.toEqual(result.outcome);
  });

  it('settles cancellation before admission without executing the adapter', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = await createHarness(instruction());
    cleanups.push(harness.cleanup);
    let invoked = false;

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      signal: controller.signal,
      adapters: [{ kind: 'marker', version: '1', invoke: async () => ((invoked = true), null) }],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result).toEqual({ outcome: { kind: 'cancelled' }, decision: 'accepted' });
    expect(invoked).toBe(false);
  });

  it('keeps an unquiesced setup failure technical even when cancellation arrives', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workload-invocation-stop-failed-'));
    cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const controller = new AbortController();
    const harness = await createHarness(
      instruction({ provisioning: 'bind', custody: 'external', sourceRoots: [], setup: [] }),
    );
    cleanups.push(harness.cleanup);
    let invoked = false;

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      workspaceRoot,
      signal: controller.signal,
      preparation: {
        prepare: async () => ({
          binding: { workspaceRoot, sourceRoots: [] },
          runSetup: async () => {
            controller.abort();
            return { status: 'stop-failed' as const, exitCode: null };
          },
          release: async () => {},
        }),
      },
      adapters: [{ kind: 'marker', version: '1', invoke: async () => ((invoked = true), null) }],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result.outcome).toEqual({
      kind: 'technical-failure',
      stage: 'workspace-preparation',
      message: 'Workspace setup stop-failed',
    });
    expect(invoked).toBe(false);
  });

  it.each([
    { phase: 'prepare', customReason: true, unrelated: false },
    { phase: 'setup', customReason: true, unrelated: false },
    { phase: 'setup', customReason: false, unrelated: false },
    { phase: 'setup', customReason: true, unrelated: true },
  ] as const)('classifies thrown $phase cancellation (custom: $customReason, unrelated: $unrelated)', async ({
    phase,
    customReason,
    unrelated,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'throwing-preparation-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspaceRoot = join(root, 'workspace');
    const outer = new AbortController();
    const control = new AbortController();
    const reports: unknown[] = [];
    const harness = await createHarness(
      instruction({ provisioning: 'create', custody: 'disposable', sourceRoots: [], setup: [] }),
      { preparationReports: reports },
    );
    cleanups.push(harness.cleanup);
    const settled = harness.authority.waitForOutcome(harness.executionAttemptId);
    const stop = () => {
      control.abort(customReason ? { source: 'custom-preparation-stop' } : undefined);
      if (unrelated) throw new Error('Independent setup storage failure');
      control.signal.throwIfAborted();
    };
    let invocations = 0;
    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      workspaceRoot,
      signal: outer.signal,
      preparation: {
        prepare: async (input) => {
          const handle = await bindLocalWorkspace(input);
          await writeFile(join(workspaceRoot, 'partial-work'), 'retained');
          if (phase === 'prepare') stop();
          return {
            ...handle,
            runSetup: async (options?: WorkspaceSetupOptions) => {
              expect(options?.signal).toBe(control.signal);
              stop();
              return await handle.runSetup(options);
            },
          };
        },
      },
      adapters: [
        {
          kind: 'marker',
          version: '1',
          bindControl: async () => ({ signal: control.signal, release: () => {} }),
          invoke: async () => {
            invocations += 1;
            return {};
          },
        },
      ],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });
    const expected: ExecutionAttemptOutcome = unrelated
      ? { kind: 'technical-failure', stage: 'workspace-preparation', message: 'Independent setup storage failure' }
      : { kind: 'cancelled' };
    expect(result).toEqual({ outcome: expected, decision: 'accepted' });
    await expect(settled).resolves.toEqual(expected);
    expect(invocations).toBe(0);
    expect(reports).toEqual([]);
    expect(outer.signal.aborted).toBe(false);
    expect(await readFile(join(workspaceRoot, 'partial-work'), 'utf8')).toBe('retained');
  });

  it('settles cancellation after Preparation acceptance without invoking the workload', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workload-invocation-cancelled-'));
    await rm(workspaceRoot, { recursive: true, force: true });
    cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const controller = new AbortController();
    const harness = await createHarness(
      instruction({ provisioning: 'create', custody: 'disposable', sourceRoots: [], setup: [] }),
      { afterPreparationReport: () => controller.abort() },
    );
    cleanups.push(harness.cleanup);
    let invoked = false;

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      workspaceRoot,
      signal: controller.signal,
      adapters: [{ kind: 'marker', version: '1', invoke: async () => ((invoked = true), null) }],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result).toEqual({ outcome: { kind: 'cancelled' }, decision: 'accepted' });
    expect(invoked).toBe(false);
    await expect(writeFile(join(workspaceRoot, 'retained-after-cancellation'), 'yes')).resolves.toBeUndefined();
  });

  it('replays a lost Preparation acknowledgement before converging caller cancellation', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workload-invocation-report-cancelled-'));
    await rm(workspaceRoot, { recursive: true, force: true });
    cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const controller = new AbortController();
    const harness = await createHarness(
      instruction({ provisioning: 'create', custody: 'disposable', sourceRoots: [], setup: [] }),
      {
        dropFirstPreparationReportAck: true,
        afterPreparationReport: () => controller.abort(),
      },
    );
    cleanups.push(harness.cleanup);
    let invoked = false;

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      workspaceRoot,
      signal: controller.signal,
      adapters: [{ kind: 'marker', version: '1', invoke: async () => ((invoked = true), null) }],
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result).toEqual({ outcome: { kind: 'cancelled' }, decision: 'accepted' });
    expect(invoked).toBe(false);
  });

  it('does not create a Workspace after recovered Preparation admission sees cancellation', async () => {
    const workspaceRoot = join(tmpdir(), `workload-invocation-no-create-${crypto.randomUUID()}`);
    cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const controller = new AbortController();
    const harness = await createHarness(
      instruction({ provisioning: 'create', custody: 'disposable', sourceRoots: [], setup: [] }),
      {
        dropFirstPreparationAdmissionAck: true,
        afterPreparationAdmission: () => controller.abort(),
      },
    );
    cleanups.push(harness.cleanup);
    let prepared = false;

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      workspaceRoot,
      signal: controller.signal,
      preparation: {
        prepare: async () => {
          prepared = true;
          throw new Error('must not prepare after cancellation');
        },
      },
      adapters: [{ kind: 'marker', version: '1', invoke: async () => null }],
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result).toEqual({ outcome: { kind: 'cancelled' }, decision: 'accepted' });
    expect(prepared).toBe(false);
  });

  it('replays a lost Invocation admission acknowledgement before converging caller cancellation', async () => {
    const controller = new AbortController();
    const harness = await createHarness(instruction(), {
      dropFirstInvocationAdmissionAck: true,
      afterInvocationAdmission: () => controller.abort(),
    });
    cleanups.push(harness.cleanup);
    let invoked = false;
    const adapter: InstalledWorkloadAdapter = {
      kind: 'marker',
      version: '1',
      bindControl: async ({ signal }) => ({
        signal: signal ?? new AbortController().signal,
        release: () => {},
      }),
      invoke: async () => ((invoked = true), null),
    };
    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      signal: controller.signal,
      adapters: [adapter],
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result).toEqual({ outcome: { kind: 'cancelled' }, decision: 'accepted' });
    expect(invoked).toBe(false);
  });

  it.each([
    {
      name: 'standard abort',
      reason: undefined,
      failure: new DOMException('cancelled', 'AbortError'),
      expectedOutcome: { kind: 'cancelled' },
    },
    {
      name: 'custom string reason',
      reason: 'Invocation cancelled',
      failure: undefined,
      expectedOutcome: { kind: 'cancelled' },
    },
    {
      name: 'custom Error reason',
      reason: new Error('Invocation cancelled'),
      failure: undefined,
      expectedOutcome: { kind: 'cancelled' },
    },
    {
      name: 'unrelated shutdown failure after abort',
      reason: new Error('Invocation cancelled'),
      failure: new Error('Runtime shutdown failed'),
      expectedOutcome: {
        kind: 'technical-failure',
        stage: 'workload-invocation',
        message: 'Runtime shutdown failed',
      },
    },
  ])('settles $name against Invocation and retains scratch', async ({ reason, failure, expectedOutcome }) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workload-invocation-abort-'));
    await rm(workspaceRoot, { recursive: true, force: true });
    cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const controller = new AbortController();
    const harness = await createHarness(
      instruction({ provisioning: 'create', custody: 'disposable', sourceRoots: [], setup: [] }),
    );
    cleanups.push(harness.cleanup);

    const result = await runWorkloadInvocation(harness.bus, {
      executionAttemptId: harness.executionAttemptId,
      runtimeGeneration: 1,
      workspaceRoot,
      signal: controller.signal,
      adapters: [
        {
          kind: 'marker',
          version: '1',
          invoke: async ({ signal }) => {
            controller.abort(reason);
            expect(signal?.aborted).toBe(true);
            if (failure !== undefined) throw failure;
            signal?.throwIfAborted();
            return null;
          },
        },
      ],
      retry: { baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 5_000 },
    });

    expect(result).toEqual({ outcome: expectedOutcome, decision: 'accepted' });
    await expect(writeFile(join(workspaceRoot, 'retained-after-abort'), 'yes')).resolves.toBeUndefined();
  });
});

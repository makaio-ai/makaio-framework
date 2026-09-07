import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createBusContext, createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  ExecutionAttemptSubjects,
  WorkflowSubjects,
  createWorkflowCancelSubject,
  type WorkflowExecution,
  type WorkflowGateNode,
  type WorkflowWorkerConfig,
  type JsonValue,
} from '@makaio/contracts';
import { WorkflowStorageSubjects } from '@makaio/subsystem-workflow-engine';
import { HmacAuth, resolveHmacIdentityPeer, resolveHmacIdentitySecret } from '@makaio/bus-transport-websocket';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { BusServerTransportProvider } from '../../bus-server-transport.js';
import { mintWorkflowExecutionBusSecret } from '../../workflow-execution-bus-access.js';
import runPiscinaWorkflow, { runWorkflowInWorker } from '../worker-entry.js';
import { dispatchWithBootstrapHandoff } from '../piscina-bootstrap-handoff.js';
import { createAttemptAuthorityHarness, type AttemptAuthorityHarness } from './attempt-authority-harness.js';

/**
 * Process-global HMAC secret of this host.
 *
 * Attempt-free workers authenticate with it and stay unrestricted, exactly as
 * a host-owned worker connection does today. Attempt-owned workers claim their
 * attempt identity instead and are resolved through the identity registry.
 */
const HOST_BUS_SECRET = 'worker-entry-integration-host-secret';

interface HostWorkflowBus {
  /** WebSocket URL used by worker bus clients. */
  readonly busUrl: string;
  /** Host bus instance — tests may register additional handlers before running a worker. */
  readonly bus: IMakaioBus;
  /** Executions persisted through workflow storage subjects. */
  readonly executions: Map<string, WorkflowExecution>;
  /** Authority-side ExecutionAttempt gates, attempt identity, and gate captures. */
  readonly attempt: AttemptAuthorityHarness;
  /** Release transport, storage handlers, attempt gates, and HTTP server. */
  readonly close: () => Promise<void>;
}

/**
 * Start a real bus transport with in-memory workflow storage handlers.
 *
 * Registers handlers for the storage subjects the orchestrator writes during
 * a workflow run, including the atomic `setExecutionStart` launch checkpoint,
 * and stands up the Authority-side ExecutionAttempt gates an attempt-owned
 * worker registers against. Without those gates such a worker blocks on the
 * request default rather than failing.
 *
 * All cleanup callbacks are collected so `close()` can unregister them in one pass.
 * @param executionId - Execution the host's attempt belongs to.
 * @returns Host bus resources for worker-entry integration tests.
 */
async function startHostWorkflowBus(executionId: string): Promise<HostWorkflowBus> {
  const server = createServer();
  const port = await listenOnLoopback(server);
  const bus = createBusInstance({ context: createBusContext() });
  bus.registerNamespaces(FrameworkContractNamespaces);
  bus.registerNamespaces(FrameworkStorageNamespaces);
  // Before the transport: the gates must be bound and the attempt allocated by
  // the time a worker socket can reach them.
  const attempt = await createAttemptAuthorityHarness(bus, executionId);

  const executions = new Map<string, WorkflowExecution>();

  const offSetExecution = bus.on(WorkflowStorageSubjects.setExecution, (ctx) => {
    // Cast: the storage subject exposes the schema-inferred execution shape,
    // which is structurally the public WorkflowExecution contract used here.
    const execution = ctx.payload.execution as WorkflowExecution;
    executions.set(execution.id, execution);
    ctx.setResult({ id: execution.id });
  });

  const offSetExecutionStart = bus.on(WorkflowStorageSubjects.setExecutionStart, (ctx) => {
    const execution = ctx.payload.execution as WorkflowExecution;
    executions.set(execution.id, execution);
    ctx.setResult({ id: execution.id, executionId: execution.id });
  });

  const offUpdateExecution = bus.on(WorkflowStorageSubjects.updateExecution, (ctx) => {
    const { executionId, status, error, completedAt } = ctx.payload;
    const execution = executions.get(executionId);
    if (!execution) {
      ctx.setResult({ success: false });
      return;
    }
    if (status !== undefined) execution.status = status;
    if (error !== undefined) execution.error = error ?? undefined;
    if (completedAt !== undefined) execution.completedAt = completedAt ?? undefined;
    ctx.setResult({ success: true });
  });

  const offSetSpan = bus.on(WorkflowStorageSubjects.setSpan, (ctx) => {
    ctx.setResult({ id: ctx.payload.span.stepId });
  });

  // An attempt-owned worker runs with `terminalAuthority: 'authority'`, so it
  // hands its loaded definition back through this gateway instead of writing
  // the execution row itself — the attempt's transport allowlist does not
  // carry the storage write subjects.
  const offBootstrapAuthorityState = bus.on(WorkflowSubjects.bootstrapAuthorityState, (ctx) => {
    const execution = executions.get(ctx.payload.executionId);
    if (execution !== undefined) execution.workflowId = ctx.payload.definition.id;
    ctx.setResult({ persisted: true });
  });

  const cleanups: Array<() => void> = [
    offSetExecution,
    offSetExecutionStart,
    offUpdateExecution,
    offSetSpan,
    offBootstrapAuthorityState,
  ];

  // The host's own auth, not the harness's: a Piscina worker builds its socket
  // from the HMAC secret in its worker configuration, so the identity it can
  // claim is the one the process-wide identity registry holds for its attempt.
  const transport = new BusServerTransportProvider({
    httpServer: server,
    auth: new HmacAuth({
      secret: HOST_BUS_SECRET,
      resolveSecret: resolveHmacIdentitySecret,
      resolvePeer: resolveHmacIdentityPeer,
    }),
  });
  try {
    await transport.connect(bus, 'workflow-worker-integration-host');
  } catch (error) {
    for (const off of cleanups) off();
    await attempt.cleanup();
    await transport.disconnect();
    await closeHttpServer(server);
    throw error;
  }

  return {
    busUrl: `ws://127.0.0.1:${port}/bus`,
    bus,
    executions,
    attempt,
    async close() {
      for (const off of cleanups) off();
      await attempt.cleanup();
      await transport.disconnect();
      await closeHttpServer(server);
    },
  };
}

/**
 * Build a definition-sourced worker config that can execute without file loading.
 * @param busUrl - Host bus URL for storage requests.
 * @returns Workflow worker configuration.
 */
function makeDefinitionConfig(busUrl: string): WorkflowWorkerConfig {
  return {
    source: { kind: 'definition', workflowId: 'wf-entry-integration' },
    definition: {
      id: 'wf-entry-integration',
      name: 'Worker Entry Integration',
      root: { id: 'wf-entry-integration__root', type: 'sequence' as const, nodes: [] },
      triggers: [],
      scope: { type: 'global' as const },
    },
    executionId: 'exec-entry-integration',
    workflowId: 'wf-entry-integration',
    triggerPayload: {},
    inputs: {},
    scope: { type: 'global' },
    busUrl,
    busAuth: { kind: 'hmac', secret: HOST_BUS_SECRET },
    env: {},
    coordinatorSessionId: 'session-entry-integration',
    cancelSubject: 'workflow.cancel.exec-entry-integration',
    suspensionStrategy: 'wait-in-process',
  };
}

/**
 * Build a definition-sourced worker config with a single gate step.
 *
 * Used by gate approval and cancellation integration tests. The gate node
 * emits {@link WorkflowSubjects.gate.suspended} when it opens and waits for
 * a {@link WorkflowSubjects.gate.respond} request from the host bus before
 * continuing.
 * @param busUrl - Host bus URL for storage and gate requests.
 * @returns Workflow worker configuration with one gate step.
 */
function makeGateConfig(busUrl: string): WorkflowWorkerConfig {
  return {
    ...makeDefinitionConfig(busUrl),
    executionId: 'exec-entry-gate',
    workflowId: 'wf-entry-gate',
    cancelSubject: 'workflow.cancel.exec-entry-gate',
    definition: {
      id: 'wf-entry-gate',
      name: 'Worker Entry Gate',
      root: {
        id: 'wf-entry-gate__root',
        type: 'sequence' as const,
        nodes: [
          {
            id: 'approval',
            type: 'gate' as const,
            prompt: 'Approve worker execution?',
            autoAction: 'reject' as const,
            timeoutMs: 120_000,
          } as WorkflowGateNode,
        ],
      },
      triggers: [],
      scope: { type: 'global' as const },
    },
  };
}

describe('runWorkflowInWorker integration', () => {
  it('hands off before real Authority permission and completes invocation after the original deadline', async () => {
    const executionId = 'exec-handoff-attempt';
    const host = await startHostWorkflowBus(executionId);
    const identity = mintWorkflowExecutionBusSecret({
      executionAttemptId: host.attempt.executionAttemptId,
      executionId,
    });
    // Operation admission is after actual awaitStart permission. Advancing the
    // wall clock here proves neither handoff scope survives into invocation.
    const off = host.bus.on(ExecutionAttemptSubjects.operation.admitted, () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(host.attempt.bootstrapDeadlineAt) + 1);
    });
    try {
      const result = await dispatchWithBootstrapHandoff(
        host.attempt.bootstrapDeadlineAt,
        new AbortController().signal,
        (bootstrapPort, signal) =>
          runPiscinaWorkflow({
            kind: 'attempt-bound',
            executionAttemptId: host.attempt.executionAttemptId,
            bootstrapDeadlineAt: host.attempt.bootstrapDeadlineAt,
            bootstrapPort,
            signal,
            config: {
              ...makeDefinitionConfig(host.busUrl),
              executionId,
              cancelSubject: `workflow.${executionId}.cancel`,
              busAuth: { kind: 'hmac', secret: identity.secret },
              terminalAuthority: 'authority',
            },
            manifest: { contributionRefs: [] },
            contributionEntrypoints: [],
          }),
      );
      expect(host.attempt.runtimeReadyEvents).toHaveLength(1);
      expect(host.attempt.operationAdmittedEvents).toHaveLength(1);
      expect(result).toMatchObject({ executionId, status: 'completed' });
    } finally {
      vi.restoreAllMocks();
      off();
      identity.cleanup();
      await host.close();
    }
  });

  it('runs a definition-sourced workflow through the real worker lifecycle and host bus storage', async () => {
    const host = await startHostWorkflowBus('exec-entry-integration');

    try {
      const result = await runWorkflowInWorker({
        kind: 'unbound',
        config: makeDefinitionConfig(host.busUrl),
        manifest: { contributionRefs: [] },
        contributionEntrypoints: [],
      });

      expect(result).toEqual({
        executionId: 'exec-entry-integration',
        workflowId: 'wf-entry-integration',
        status: 'completed',
      });
      expect(host.executions.get('exec-entry-integration')).toMatchObject({
        id: 'exec-entry-integration',
        workflowId: 'wf-entry-integration',
        status: 'completed',
      });
    } finally {
      await host.close();
    }
  });

  it('routes a gate approval from the host bus to the worker over WebSocket', async () => {
    const host = await startHostWorkflowBus('exec-entry-gate');

    try {
      const gateEvents: Array<{ executionId: string; nodeId: string; prompt: string | undefined }> = [];

      // Listen for gate.suspended and respond immediately via gate.respond.
      const offGate = host.bus.on(WorkflowSubjects.gate.suspended, (ctx) => {
        gateEvents.push({
          executionId: ctx.payload.executionId,
          nodeId: ctx.payload.nodeId,
          prompt: ctx.payload.prompt,
        });
        // Respond asynchronously on the next tick so the worker's gate.respond
        // subscription is established before the response arrives.
        setTimeout(() => {
          void host.bus
            .request(WorkflowSubjects.gate.respond, {
              executionId: ctx.payload.executionId,
              gateId: ctx.payload.nodeId,
              frameId: ctx.payload.frameId,
              action: 'approve',
              resumeData: null as JsonValue,
            })
            .catch(() => {});
        }, 0);
      });

      try {
        const result = await runWorkflowInWorker({
          kind: 'unbound',
          config: makeGateConfig(host.busUrl),
          manifest: { contributionRefs: [] },
          contributionEntrypoints: [],
        });

        expect(result).toEqual({
          executionId: 'exec-entry-gate',
          workflowId: 'wf-entry-gate',
          status: 'completed',
        });
        expect(gateEvents).toEqual([
          {
            executionId: 'exec-entry-gate',
            nodeId: 'approval',
            prompt: 'Approve worker execution?',
          },
        ]);
      } finally {
        offGate();
      }
    } finally {
      await host.close();
    }
  });

  it('terminates a running gate step when a cancel event reaches the worker over WebSocket', async () => {
    const host = await startHostWorkflowBus('exec-entry-gate');

    try {
      let gateOpened!: () => void;
      const gateOpenedPromise = new Promise<void>((resolve) => {
        gateOpened = resolve;
      });

      // Listen for gate.suspended: this tells us the gate is open and waiting.
      // Do NOT respond — the gate should remain suspended until the cancel fires.
      const offGate = host.bus.on(WorkflowSubjects.gate.suspended, () => {
        gateOpened();
      });

      try {
        const runPromise = runWorkflowInWorker({
          kind: 'unbound',
          config: makeGateConfig(host.busUrl),
          manifest: { contributionRefs: [] },
          contributionEntrypoints: [],
        });

        // Wait until the gate is open before sending the cancel event so the
        // worker bus is fully subscribed on the cancel subject.
        await gateOpenedPromise;

        await host.bus.emit(createWorkflowCancelSubject('workflow.cancel.exec-entry-gate'), {
          executionId: 'exec-entry-gate',
          reason: 'integration cancellation',
        });

        await expect(runPromise).resolves.toMatchObject({
          executionId: 'exec-entry-gate',
          workflowId: 'wf-entry-gate',
          status: 'cancelled',
        });
      } finally {
        offGate();
      }
    } finally {
      await host.close();
    }
  });

  it('registers its runtime and admits the run before it executes anything', async () => {
    const executionId = 'exec-entry-attempt';
    const host = await startHostWorkflowBus(executionId);
    const { executionAttemptId } = host.attempt;
    // The provisioning provider mints this identity in production; here the
    // test stands in for it, because the worker entry is driven directly.
    const identity = mintWorkflowExecutionBusSecret({ executionAttemptId, executionId });

    try {
      const result = await runWorkflowInWorker({
        kind: 'attempt-bound',
        executionAttemptId,
        bootstrapDeadlineAt: host.attempt.bootstrapDeadlineAt,
        config: {
          ...makeDefinitionConfig(host.busUrl),
          executionId,
          cancelSubject: `workflow.${executionId}.cancel`,
          busAuth: { kind: 'hmac', secret: identity.secret },
          terminalAuthority: 'authority',
        },
        manifest: { contributionRefs: [] },
        contributionEntrypoints: [],
      });

      // The Authority published readiness for this runtime, which it only does
      // after its bounded probe reached the worker's delivery endpoint.
      expect(host.attempt.runtimeReadyEvents).toMatchObject([{ executionAttemptId }]);
      // The whole legacy run passed the start gate as one admitted operation.
      expect(host.attempt.operationAdmittedEvents).toMatchObject([
        { executionAttemptId, operationKind: 'workflow-run' },
      ]);
      expect(result).toMatchObject({ executionId, status: 'completed' });
    } finally {
      identity.cleanup();
      await host.close();
    }
  });
});

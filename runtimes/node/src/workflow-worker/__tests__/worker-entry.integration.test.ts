import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createBusContext, createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  WorkflowSubjects,
  createWorkflowCancelSubject,
  type WorkflowExecution,
  type WorkflowGateNode,
  type WorkflowWorkerConfig,
  type JsonValue,
} from '@makaio/contracts';
import { WorkflowStorageSubjects } from '@makaio/subsystem-workflow-engine';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { BusServerTransportProvider } from '../../bus-server-transport.js';
import { runWorkflowInWorker } from '../worker-entry.js';

interface HostWorkflowBus {
  /** WebSocket URL used by worker bus clients. */
  readonly busUrl: string;
  /** Host bus instance — tests may register additional handlers before running a worker. */
  readonly bus: IMakaioBus;
  /** Executions persisted through workflow storage subjects. */
  readonly executions: Map<string, WorkflowExecution>;
  /** Release transport, storage handlers, and HTTP server. */
  readonly close: () => Promise<void>;
}

/**
 * Start a real bus transport with in-memory workflow storage handlers.
 *
 * Registers handlers for the storage subjects the orchestrator writes during
 * a workflow run, including the atomic `setExecutionStart` launch checkpoint.
 * All cleanup callbacks are collected so `close()` can unregister them in one pass.
 * @returns Host bus resources for worker-entry integration tests.
 */
async function startHostWorkflowBus(): Promise<HostWorkflowBus> {
  const server = createServer();
  const port = await listenOnLoopback(server);
  const bus = createBusInstance({ context: createBusContext() });
  bus.registerNamespaces(FrameworkContractNamespaces);
  bus.registerNamespaces(FrameworkStorageNamespaces);

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

  const cleanups: Array<() => void> = [offSetExecution, offSetExecutionStart, offUpdateExecution, offSetSpan];

  const transport = new BusServerTransportProvider({ httpServer: server });
  try {
    await transport.connect(bus, 'workflow-worker-integration-host');
  } catch (error) {
    for (const off of cleanups) off();
    await transport.disconnect();
    await closeHttpServer(server);
    throw error;
  }

  return {
    busUrl: `ws://127.0.0.1:${port}/bus`,
    bus,
    executions,
    async close() {
      for (const off of cleanups) off();
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
  const os =
    process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
      ? process.platform
      : 'linux';

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
    busAuth: { kind: 'none' },
    context: {
      repoPath: '/tmp',
      makaioHome: '/tmp/.makaio',
      os,
      arch: process.arch,
    },
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
  it('runs a definition-sourced workflow through the real worker lifecycle and host bus storage', async () => {
    const host = await startHostWorkflowBus();

    try {
      const result = await runWorkflowInWorker({
        config: makeDefinitionConfig(host.busUrl),
        manifest: { packages: [] },
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
    const host = await startHostWorkflowBus();

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
          config: makeGateConfig(host.busUrl),
          manifest: { packages: [] },
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
    const host = await startHostWorkflowBus();

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
          config: makeGateConfig(host.busUrl),
          manifest: { packages: [] },
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
});

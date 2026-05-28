import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createBusContext, createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  WorkflowSubjects,
  createWorkflowCancelSubject,
  type WorkflowExecution,
  type WorkflowWorkerConfig,
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
 * Registers handlers for the three storage subjects the orchestrator writes
 * during a workflow run: `setExecution`, `updateExecution`, and `setSpan`.
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

  const offUpdateExecution = bus.on(WorkflowStorageSubjects.updateExecution, (ctx) => {
    const { executionId, status, error, completedAt, stepUpdates } = ctx.payload;
    const execution = executions.get(executionId);
    if (!execution) {
      ctx.setResult({ success: false });
      return;
    }
    if (status !== undefined) execution.status = status;
    if (error !== undefined) execution.error = error ?? undefined;
    if (completedAt !== undefined) execution.completedAt = completedAt ?? undefined;
    if (stepUpdates) {
      Object.assign(execution.steps, stepUpdates);
    }
    ctx.setResult({ success: true });
  });

  const offSetSpan = bus.on(WorkflowStorageSubjects.setSpan, (ctx) => {
    ctx.setResult({ id: ctx.payload.span.stepId });
  });

  const cleanups: Array<() => void> = [offSetExecution, offUpdateExecution, offSetSpan];

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
      steps: [],
      triggers: [],
      scope: { type: 'global' },
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
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
  };
}

/**
 * Build a definition-sourced worker config with a single gate step.
 *
 * Used by gate approval and cancellation integration tests. The gate step
 * sends a {@link WorkflowSubjects.gate.awaitApproval} RPC to the host bus
 * over WebSocket, so the test can control approval from the host side.
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
      steps: [
        {
          id: 'approval',
          type: 'gate',
          prompt: 'Approve worker execution?',
          autoAction: 'reject',
          timeoutMs: 120_000,
        },
      ],
      triggers: [],
      scope: { type: 'global' },
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
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
        steps: {},
      });
    } finally {
      await host.close();
    }
  });

  it('routes a gate approval from the host bus to the worker over WebSocket', async () => {
    const host = await startHostWorkflowBus();

    try {
      const gateRequests: Array<{ executionId: string; stepId: string; message: string }> = [];

      const offGate = host.bus.on(WorkflowSubjects.gate.awaitApproval, (ctx) => {
        gateRequests.push({
          executionId: ctx.payload.executionId,
          stepId: ctx.payload.stepId,
          message: ctx.payload.message,
        });
        ctx.setResult({ action: 'approve', source: 'user' });
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
        expect(gateRequests).toEqual([
          {
            executionId: 'exec-entry-gate',
            stepId: 'approval',
            message: 'Approve worker execution?',
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

      const offGate = host.bus.on(WorkflowSubjects.gate.awaitApproval, async () => {
        gateOpened();
        // Hold the gate open indefinitely — the cancel event must terminate the worker.
        return await new Promise<never>(() => undefined);
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

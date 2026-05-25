import { createServer, type Server as HttpServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createBusContext, createBusInstance } from '@makaio/bus-core';
import {
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  type WorkflowExecution,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import { WorkflowStorageSubjects } from '@makaio/subsystem-workflow-engine';
import { BusServerTransportProvider } from '../../bus-server-transport.js';
import { runWorkflowInWorker } from '../worker-entry.js';

interface HostWorkflowBus {
  /** WebSocket URL used by worker bus clients. */
  readonly busUrl: string;
  /** Executions persisted through workflow storage subjects. */
  readonly executions: Map<string, WorkflowExecution>;
  /** Release transport, storage handlers, and HTTP server. */
  readonly close: () => Promise<void>;
}

/**
 * Bind a local HTTP server to a random loopback port.
 * @returns Listening server and selected port.
 */
async function startHttpServer(): Promise<{ server: HttpServer; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to bind workflow worker integration server.');
  }

  return { server, port: address.port };
}

/**
 * Close a Node HTTP server.
 * @param server - Listening server to close.
 */
async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Start a real bus transport with in-memory workflow storage handlers.
 * @returns Host bus resources for worker-entry integration tests.
 */
async function startHostWorkflowBus(): Promise<HostWorkflowBus> {
  const { server, port } = await startHttpServer();
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

  const transport = new BusServerTransportProvider({ httpServer: server });
  await transport.connect(bus, 'workflow-worker-integration-host');

  return {
    busUrl: `ws://127.0.0.1:${port}/bus`,
    executions,
    async close() {
      offSetExecution();
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
});

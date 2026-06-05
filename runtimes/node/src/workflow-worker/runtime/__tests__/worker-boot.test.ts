import { createServer } from 'node:http';
import { describe, it, expect } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { AgentSubjects, FrameworkContractNamespaces, McpSubjects, WorkflowSubjects } from '@makaio/contracts';
import { closeHttpServer, listenOnLoopback } from '../../../__tests__/http-test-helpers.js';
import { BusServerTransportProvider } from '../../../bus-server-transport.js';
import { bootWorkerBus, bootWorkerRuntime } from '../worker-boot.js';

describe('bootWorkerBus', () => {
  it('creates a bus instance without transport when busUrl is absent', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });

    try {
      expect(handle.bus).toBeDefined();
      expect(handle.bus.emit).toBeTypeOf('function');
      expect(handle.bus.on).toBeTypeOf('function');
    } finally {
      await handle.close();
    }
  });

  it('registers framework contract namespaces (agent subjects available)', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });

    try {
      const unsubscribe = handle.bus.on(AgentSubjects.usage, () => {
        // no-op
      });
      unsubscribe();
    } finally {
      await handle.close();
    }
  });

  it('boots the worker-local MCP bridge as part of worker runtime', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const runtime = await bootWorkerRuntime(handle, { toolsets: [], adapters: [] }, { cwd: process.cwd() });

    try {
      const registration = await handle.bus.request(McpSubjects.session.register, {
        adapterSessionId: 'worker-mcp-session',
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
        contextOverrides: {},
      });

      expect(registration.port).toBeGreaterThan(0);
    } finally {
      await runtime.close();
      await handle.close();
    }
  });

  it('worker bus is fully ready for host requests immediately after bootWorkerBus() returns', async () => {
    const hostBus = createBusInstance();
    hostBus.registerNamespaces(FrameworkContractNamespaces);

    const server = createServer();
    const port = await listenOnLoopback(server);

    const transport = new BusServerTransportProvider({ httpServer: server });
    let cleanup = (): void => undefined;
    let worker: Awaited<ReturnType<typeof bootWorkerBus>> | undefined;

    try {
      await transport.connect(hostBus, 'worker-boot-readiness-host');
      cleanup = hostBus.on(WorkflowSubjects.gate.awaitApproval, (ctx) => {
        ctx.setResult({ action: 'approve', source: 'user' });
      });
      worker = await bootWorkerBus({
        busUrl: `ws://127.0.0.1:${port}/bus`,
        busAuth: { kind: 'none' },
      });

      const result = await worker.bus.request(
        WorkflowSubjects.gate.awaitApproval,
        {
          executionId: 'exec-ready',
          stepId: 'gate-ready',
          stepType: 'gate',
          workflowId: 'wf-ready',
          workflowName: 'Readiness',
          title: 'Ready?',
          message: 'Ready?',
          autoAction: 'reject',
          timeoutMs: null,
          openedAt: Date.now(),
        },
        { timeout: 1_000 },
      );

      expect(result).toEqual({ action: 'approve', source: 'user' });
    } finally {
      if (worker) await worker.close();
      cleanup();
      await transport.disconnect();
      await closeHttpServer(server);
    }
  }, 10_000);
});

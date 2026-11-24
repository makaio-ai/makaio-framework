import { createServer } from 'node:http';
import { describe, it, expect } from 'vitest';
import { NO_BOUNDARY_ACCESS_CHECK, createBusInstance, ValidationError } from '@makaio/bus-core';
import {
  AgentSubjects,
  FrameworkContractNamespaces,
  McpSubjects,
  WorkflowNamespace,
  WorkflowSubjects,
} from '@makaio/contracts';
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
    const runtime = await bootWorkerRuntime(handle, { toolsets: [] });

    try {
      // ORIGIN: The test acts as the worker registering its local MCP session.
      const call = handle.bus.own('root');
      const registration = await handle.bus.request(call, McpSubjects.session.register, {
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

  it('validates and routes workflow requests on a worker with no authority connection', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const role = { adapterName: 'test-adapter' };
    const unsubscribe = handle.bus.on(WorkflowSubjects.resolveRole, (ctx) => ctx.setResult(role));

    try {
      // ORIGIN: The test submits role lookups from the worker bus.
      const call = handle.bus.own('root');
      await expect(handle.bus.request(call, WorkflowSubjects.resolveRole, { roleId: '' })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(handle.bus.request(call, WorkflowSubjects.resolveRole, { roleId: 'reviewer' })).resolves.toEqual(
        role,
      );
    } finally {
      unsubscribe();
      await handle.close();
    }
  });

  it('worker bus is fully ready for host requests immediately after bootWorkerBus() returns', async () => {
    const hostBus = createBusInstance();
    hostBus.registerNamespaces([...FrameworkContractNamespaces, WorkflowNamespace]);

    const server = createServer();
    const port = await listenOnLoopback(server);

    const transport = new BusServerTransportProvider({ httpServer: server });
    let cleanup = (): void => undefined;
    let worker: Awaited<ReturnType<typeof bootWorkerBus>> | undefined;

    try {
      await transport.connect(hostBus, {
        machineId: 'worker-boot-readiness-host',
        checkBoundaryAccess: NO_BOUNDARY_ACCESS_CHECK,
      });
      cleanup = hostBus.on(WorkflowSubjects.getExecution, (ctx) => {
        expect(ctx.payload.executionId).toBe('exec-ready');
        ctx.setResult({ execution: null });
      });
      worker = await bootWorkerBus({
        busUrl: `ws://127.0.0.1:${port}/bus`,
        busAuth: { kind: 'none' },
      });

      // ORIGIN: The test acts as a worker reading an execution from the authority.
      const call = worker.bus.own('root');
      const result = await worker.bus.request(
        call,
        WorkflowSubjects.getExecution,
        { executionId: 'exec-ready' },
        { timeout: 1_000 },
      );

      expect(result).toEqual({ execution: null });
    } finally {
      if (worker) await worker.close();
      cleanup();
      await transport.disconnect();
      await closeHttpServer(server);
    }
  }, 10_000);
});

/**
 * Tests for the SubagentService origin guard.
 *
 * The origin guard blocks remote spawn/execute requests unless the sending
 * peer is an authenticated workflow execution or its identity appears in the
 * service's delegation allow-set.
 *
 * The tests use an isolated bus (createBusInstance) + MockTransport to
 * drive the remote-origin code paths without real WebSocket I/O.
 */

import { describe, expect, it, afterEach } from 'vitest';
import {
  createBusContext,
  createBusInstance,
  type BusMessage,
  type BusReceiveHandler,
  type BusTransport,
  NO_HANDLER_ERROR_CODE,
} from '@makaio/bus-core';
import type { TransportReceiveContext } from '@makaio/core';
import {
  AdapterSubjects,
  SessionStorageSubjects,
  SessionSubjects,
  SubagentSubjects,
  type IMakaioSession,
} from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import { SubagentService } from '../subagent-service.js';
import { registerSubagentSessionOrchestrationMocks } from './subagent-service.mocks.js';

// ---------------------------------------------------------------------------
// Minimal transport fixture
// ---------------------------------------------------------------------------

/**
 * Minimal in-process transport that records outbound messages and supports
 * injecting inbound messages via `simulateReceive`.
 */
class StubTransport {
  public readonly name: string;
  public readonly messages: BusMessage[] = [];
  private handler?: BusReceiveHandler;

  public constructor(name: string) {
    this.name = name;
  }

  public send(message: BusMessage): Promise<boolean> {
    if (message.type !== 'subscribe-sync-complete') this.messages.push(message);
    return Promise.resolve(true);
  }

  public onReceive(handler: BusReceiveHandler): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }

  public async connect(): Promise<void> {}
  public async disconnect(): Promise<void> {}
  public async subscribe(_subject: string): Promise<void> {}
  public async unsubscribe(_subject: string): Promise<void> {}

  /**
   * Simulate receiving a message from the remote side.
   * @param message - Message to inject
   * @param context - Optional trusted receive context
   */
  public async simulateReceive(message: BusMessage, context?: TransportReceiveContext): Promise<void> {
    if (this.handler) await this.handler(message, context);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid spawn-RPC payload. */
const SPAWN_PAYLOAD = {
  parentSessionId: 'parent-session-1',
  config: {
    task: 'Test task',
    adapterName: 'test-adapter',
    contextMode: 'fork' as const,
  },
  depth: 1,
};

/** Correlation/message IDs used by all simulated remote requests. */
const REQUEST_IDS = {
  correlationId: 'test-corr-1',
  messageId: 'test-msg-1',
};

/**
 * Build a remote spawn request message to inject via simulateReceive.
 */
function makeRemoteSpawnRequest() {
  return {
    type: 'request' as const,
    namespace: SubagentSubjects.spawn.$meta.namespace,
    subject: SubagentSubjects.spawn.subject as string,
    payload: SPAWN_PAYLOAD,
    ...REQUEST_IDS,
  };
}

/**
 * Build a remote execute request message to inject via simulateReceive.
 */
function makeRemoteExecuteRequest() {
  return {
    type: 'request' as const,
    namespace: SubagentSubjects.execute.$meta.namespace,
    subject: SubagentSubjects.execute.subject as string,
    payload: {
      subagentId: 'subagent-remote-execute',
      parentSessionId: 'parent-session-1',
      task: 'Test task',
      config: {
        task: 'Test task',
        adapterName: 'test-adapter',
        contextMode: 'fork' as const,
      },
      depth: 1,
    },
    correlationId: 'test-corr-execute-1',
    messageId: 'test-msg-execute-1',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubagentService — origin guard on spawn', () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  it('handles spawn from a local origin', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const service = new SubagentService(bus);
    cleanup.push(() => service.destroy());
    await service.init();

    // Register the downstream handlers the service will call (they would
    // normally be provided by other services). Here we just stub them so
    // the spawn can complete without real session/adapter infrastructure.
    bus.on(SubagentSubjects.spawned, () => {
      // swallow the fire-and-forget spawned event
    });

    const result = await bus.request(SubagentSubjects.spawn, SPAWN_PAYLOAD);

    // Spawn RPC sets result immediately; the actual execution is fire-and-forget.
    expect(result).toMatchObject({ status: 'spawning' });
  });

  it('declines a spawn from an unauthenticated remote origin when the delegation allow-set is empty', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    // No delegation allow-set → empty set by default
    const service = new SubagentService(bus);
    cleanup.push(() => service.destroy());
    await service.init();

    const transport = new StubTransport('remote-transport');
    bus.registerTransport(transport as BusTransport);

    await transport.simulateReceive(makeRemoteSpawnRequest(), {
      transportName: 'remote-transport',
      peer: { kind: 'workflow-execution', id: 'exec-unknown' },
    });

    // The handler returned without calling setResult, so the bus sent back a
    // NoHandlerError response to the transport.
    const responseMessages = transport.messages.filter((m) => m.type === 'response');
    expect(responseMessages).toHaveLength(1);
    expect(responseMessages[0]).toMatchObject({
      type: 'response',
      correlationId: REQUEST_IDS.correlationId,
      error: expect.objectContaining({
        code: NO_HANDLER_ERROR_CODE,
        message: expect.stringContaining('No handler registered'),
      }),
    });
  });

  it('handles a spawn from an authenticated workflow execution without an explicit grant', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const service = new SubagentService(bus);
    cleanup.push(() => service.destroy());
    await service.init();

    const transport = new StubTransport('workflow-transport');
    bus.registerTransport(transport as BusTransport);
    bus.on(SubagentSubjects.spawned, () => {});

    await transport.simulateReceive(makeRemoteSpawnRequest(), {
      transportName: 'workflow-transport',
      peer: { kind: 'workflow-execution', id: 'exec-authorized-by-identity', authenticated: true },
    });

    const responseMessages = transport.messages.filter((m) => m.type === 'response');
    expect(responseMessages).toHaveLength(1);
    expect(responseMessages[0]).toMatchObject({
      type: 'response',
      correlationId: REQUEST_IDS.correlationId,
      result: { status: 'spawning' },
    });
  });

  it('handles a spawn from a remote origin when the peer is in the delegation allow-set', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const allowSet = new Set(['workflow-execution:exec-authorized']);
    const service = new SubagentService(bus, undefined, allowSet);
    cleanup.push(() => service.destroy());
    await service.init();

    const transport = new StubTransport('authorized-transport');
    bus.registerTransport(transport as BusTransport);

    // The spawned event is fire-and-forget; just swallow it.
    bus.on(SubagentSubjects.spawned, () => {});

    await transport.simulateReceive(makeRemoteSpawnRequest(), {
      transportName: 'authorized-transport',
      peer: { kind: 'workflow-execution', id: 'exec-authorized', authenticated: true },
    });

    // The handler called setResult, so a successful response was sent.
    const responseMessages = transport.messages.filter((m) => m.type === 'response');
    expect(responseMessages).toHaveLength(1);
    expect(responseMessages[0]).toMatchObject({
      type: 'response',
      correlationId: REQUEST_IDS.correlationId,
      result: { status: 'spawning' },
    });
  });

  it('declines an unauthenticated execute from a remote origin when the delegation allow-set is empty', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const service = new SubagentService(bus);
    cleanup.push(() => service.destroy());
    await service.init();

    const transport = new StubTransport('remote-transport');
    bus.registerTransport(transport as BusTransport);

    await transport.simulateReceive(makeRemoteExecuteRequest(), {
      transportName: 'remote-transport',
      peer: { kind: 'workflow-execution', id: 'exec-unknown' },
    });

    const responseMessages = transport.messages.filter((m) => m.type === 'response');
    expect(responseMessages).toHaveLength(1);
    expect(responseMessages[0]).toMatchObject({
      type: 'response',
      correlationId: 'test-corr-execute-1',
      error: expect.objectContaining({
        code: NO_HANDLER_ERROR_CODE,
        message: expect.stringContaining('No handler registered'),
      }),
    });
  });

  it('handles an execute from a remote origin when the peer is in the delegation allow-set', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const allowSet = new Set(['workflow-execution:exec-authorized']);
    const service = new SubagentService(bus, undefined, allowSet);
    cleanup.push(() => service.destroy());
    await service.init();

    const transport = new StubTransport('authorized-transport');
    bus.registerTransport(transport as BusTransport);

    bus.on(SessionSubjects.create, (ctx) => {
      ctx.setResult({ sessionId: 'child-remote-execute' });
    });
    bus.on(SessionStorageSubjects.get, (ctx) => {
      const now = Date.now();
      const session: IMakaioSession = {
        sessionId: ctx.payload.sessionId,
        createdAt: now,
        lastActivityAt: now,
        agents: [],
        status: 'active',
      };
      ctx.setResult({ session });
    });
    bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `resolved-${ctx.payload.adapterName}` });
    });
    bus.on(AdapterSubjects.startAgent, (ctx) => {
      ctx.setResult({
        success: true,
        agentId: 'agent-remote-execute',
        adapterId: ctx.payload.adapterId,
        ownerInstanceId: 'test-owner-instance',
        adapterSessionId: 'adapter-session-remote-execute',
        sessionId: ctx.payload.sessionId ?? 'child-remote-execute',
      });
    });
    registerSubagentSessionOrchestrationMocks(bus);

    await transport.simulateReceive(makeRemoteExecuteRequest(), {
      transportName: 'authorized-transport',
      peer: { kind: 'workflow-execution', id: 'exec-authorized', authenticated: true },
    });

    const responseMessages = transport.messages.filter((m) => m.type === 'response');
    expect(responseMessages).toHaveLength(1);
    expect(responseMessages[0]).toMatchObject({
      type: 'response',
      correlationId: 'test-corr-execute-1',
      result: { success: true },
    });
  });

  it('handles an execute from an authenticated workflow execution without an explicit grant', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const service = new SubagentService(bus);
    cleanup.push(() => service.destroy());
    await service.init();

    const transport = new StubTransport('workflow-transport');
    bus.registerTransport(transport as BusTransport);

    bus.on(SessionSubjects.create, (ctx) => {
      ctx.setResult({ sessionId: 'child-workflow-execute' });
    });
    bus.on(SessionStorageSubjects.get, (ctx) => {
      const now = Date.now();
      const session: IMakaioSession = {
        sessionId: ctx.payload.sessionId,
        createdAt: now,
        lastActivityAt: now,
        agents: [],
        status: 'active',
      };
      ctx.setResult({ session });
    });
    bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `resolved-${ctx.payload.adapterName}` });
    });
    bus.on(AdapterSubjects.startAgent, (ctx) => {
      ctx.setResult({
        success: true,
        agentId: 'agent-workflow-execute',
        adapterId: ctx.payload.adapterId,
        ownerInstanceId: 'test-owner-instance',
        adapterSessionId: 'adapter-session-workflow-execute',
        sessionId: ctx.payload.sessionId ?? 'child-workflow-execute',
      });
    });
    registerSubagentSessionOrchestrationMocks(bus);

    await transport.simulateReceive(makeRemoteExecuteRequest(), {
      transportName: 'workflow-transport',
      peer: { kind: 'workflow-execution', id: 'exec-authorized-by-identity', authenticated: true },
    });

    const responseMessages = transport.messages.filter((m) => m.type === 'response');
    expect(responseMessages).toHaveLength(1);
    expect(responseMessages[0]).toMatchObject({
      type: 'response',
      correlationId: 'test-corr-execute-1',
      result: { success: true },
    });
  });
});

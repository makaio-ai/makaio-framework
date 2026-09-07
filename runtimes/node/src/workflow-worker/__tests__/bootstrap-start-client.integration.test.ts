import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { BusLifecycle, ConnectionLostError, createBusInstance } from '@makaio/bus-core';
import { HmacAuth, ServerTransport, WebSocketConnectionError } from '@makaio/bus-transport-websocket';
import { ExecutionAttemptSubjects, FrameworkContractNamespaces } from '@makaio/contracts';
import {
  ExecutionAttemptAuthority,
  registerBootstrapStartHandler,
  registerRuntimeRegistrationHandler,
  workflowAttemptOutcomeCodec,
} from '@makaio/subsystem-workflow-engine';
import {
  createInMemoryAttemptRepository,
  driveTestAttemptToAllocated,
  makeTestInstruction,
} from '@makaio/subsystem-workflow-engine/testing';
import { bootstrapWorkerRuntime, BootstrapStartRefusedError } from '../bootstrap-start-client.js';
import { BootstrapDeadlineExceededError } from '../worker-bootstrap-exchange.js';
import { createWorkerBus } from '../runtime/worker-boot.js';
import { registerWorkerRuntime } from '../runtime-registration-client.js';

describe('authenticated bootstrap start client', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups.length = 0;
  });

  /**
   * Run the actual Authority over a real authenticated transport and repository.
   * @param timeoutMs - Explicit fixture-wide bootstrap budget.
   * @param beforeFirstStart - Optional control of the first real request's response timing.
   * @returns Server, Attempt and fresh connection acquisition.
   */
  async function fixture(timeoutMs = 20_000, beforeFirstStart?: () => Promise<void>) {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: timeoutMs });
    const record = await authority.createAttempt('execution', makeTestInstruction());
    if (record.bootstrapDeadlineAt === null) throw new Error('Missing fixture deadline');
    void authority.waitForOutcome(record.executionAttemptId)?.catch(() => undefined);
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    cleanups.push(async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('Expected TCP server');
    const bus = createBusInstance();
    bus.registerNamespaces(FrameworkContractNamespaces);
    const calls: string[] = [];
    cleanups.push(
      registerBootstrapStartHandler(bus, {
        awaitBootstrapStart: async (identity, options) => {
          calls.push(identity.executionAttemptId);
          if (calls.length === 1) await beforeFirstStart?.();
          // A short lease exercises pending renewal without shortening the
          // Attempt's durable budget. State evaluation remains the real Authority.
          return authority.awaitBootstrapStart(identity, { ...options, deadline: Date.now() + 1_020 });
        },
      }),
    );
    cleanups.push(registerRuntimeRegistrationHandler(bus, { bus, authority }));
    bus.registerTransport(
      new ServerTransport({
        websocket: server,
        auth: new HmacAuth({
          secret: 'test-secret',
          resolveSecret: () => 'test-secret',
          resolvePeer: (id) => ({
            kind: 'workflow-execution-attempt',
            id,
            authenticated: true,
            claims: { executionId: 'execution' },
          }),
        }),
      }),
    );
    cleanups.push(() => bus.disconnect());
    await bus.connect();
    const connections: ReturnType<typeof createWorkerBus>[] = [];
    const createConnection = () => {
      const connection = createWorkerBus({
        busUrl: `ws://127.0.0.1:${address.port}`,
        busAuth: { kind: 'hmac', secret: 'test-secret' },
        identityId: record.executionAttemptId,
      });
      connections.push(connection);
      cleanups.push(() => connection.close());
      return connection;
    };
    return {
      repository,
      authority,
      record,
      server,
      calls,
      connections,
      options: {
        executionAttemptId: record.executionAttemptId,
        runtimeIncarnationId: 'runtime',
        bootstrapDeadlineAt: record.bootstrapDeadlineAt,
        signal: new AbortController().signal,
        createConnection,
      },
    };
  }

  it('renews pending on the same bus, waits beyond the former ten-second window, then registers once', async () => {
    const host = await fixture();
    const started = bootstrapWorkerRuntime(host.options);
    void started.catch(() => undefined);
    await vi.waitFor(() => expect(host.calls.length).toBeGreaterThan(1));
    expect(host.connections).toHaveLength(1);
    expect(host.repository.attempts.get(host.record.executionAttemptId)?.runtimeGeneration).toBe(0);
    // Advance elapsed wall time, while keeping real socket/timer scheduling.
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + 10_100);
    await driveTestAttemptToAllocated(host.authority, host.record.executionAttemptId, 'execution');
    const ready = await started;
    expect(host.connections).toHaveLength(1);
    const generation = await registerWorkerRuntime(ready.connection.bus, host.options);
    expect(generation).toBe(1);
    ready.endpoint.cleanup();
  });

  it('rejects a mismatched authenticated identity before permitting registration', async () => {
    const host = await fixture();
    await expect(bootstrapWorkerRuntime({ ...host.options, executionAttemptId: 'another-attempt' })).rejects.toThrow(
      'does not match authenticated peer identity',
    );
    expect(host.calls).toEqual([]);
    expect(host.connections).toHaveLength(1);
  });

  it('reconnects before registration and returns only the surviving bus and endpoint', async () => {
    const requestEntered = Promise.withResolvers<void>();
    const releaseResponse = Promise.withResolvers<void>();
    const secondSession = Promise.withResolvers<void>();
    const host = await fixture(20_000, async () => {
      requestEntered.resolve();
      await releaseResponse.promise;
    });
    cleanups.push(() => releaseResponse.resolve());
    const pending = bootstrapWorkerRuntime({
      ...host.options,
      createConnection: () => {
        const connection = host.options.createConnection();
        if (host.connections.length === 2) secondSession.resolve();
        return connection;
      },
    });
    void pending.catch(() => undefined);
    // Keep an actual RPC pending: a short completed lease is not proof of an
    // in-flight request, and buffered pending responses must be a separate test.
    await Promise.race([requestEntered.promise, pending]);
    const firstConnection = host.connections[0];
    if (!firstConnection) throw new Error('First request has no connection');
    const clientClosed = Promise.withResolvers<void>();
    cleanups.push(firstConnection.bus.on(BusLifecycle.disconnected, () => clientClosed.resolve()));
    for (const socket of host.server.clients) socket.terminate();
    await Promise.race([clientClosed.promise, pending]);
    releaseResponse.resolve();
    // Surface bootstrap rejection directly rather than masking it behind a
    // polling assertion that only says the second session never appeared.
    await Promise.race([secondSession.promise, pending]);
    await driveTestAttemptToAllocated(host.authority, host.record.executionAttemptId, 'execution');
    const started = await pending;
    expect(started.connection).toBe(host.connections[1]);
    expect(await registerWorkerRuntime(started.connection.bus, host.options)).toBe(1);
    expect(
      host.connections[0]?.bus.getContext().requestHandlers.get('execution-attempt.operation.deliver') ?? [],
    ).toHaveLength(0);
    started.endpoint.cleanup();
  });

  /**
   * Hold a real pending reply until its client observes the chosen socket closure.
   * @param host - Real Authority, repository and authenticated transport fixture.
   * @param closeCode - Abrupt network loss or explicit policy refusal.
   * @returns Bootstrap result and deterministic response/replacement observations.
   */
  function startAcrossPendingClose(host: Awaited<ReturnType<typeof fixture>>, closeCode: 1006 | 1008) {
    const responseObserved = Promise.withResolvers<void>();
    const clientClosed = Promise.withResolvers<void>();
    const secondSession = Promise.withResolvers<void>();
    const pending = bootstrapWorkerRuntime({
      ...host.options,
      createConnection: () => {
        const connection = host.options.createConnection();
        if (host.connections.length === 2) {
          secondSession.resolve();
          return connection;
        }
        cleanups.push(connection.bus.on(BusLifecycle.disconnected, () => clientClosed.resolve()));
        const removeMiddleware = connection.bus.on(
          ExecutionAttemptSubjects.bootstrap.awaitStart,
          async (ctx) => {
            // Middleware preserves the real authenticated Authority response,
            // but holds its delivery to the caller until the socket has closed.
            await ctx.next();
            if (ctx.result?.status !== 'pending') return;
            // The next request must use the normal production route, not a
            // test middleware that would wrap its transport error.
            removeMiddleware();
            responseObserved.resolve();
            for (const socket of host.server.clients) {
              if (closeCode === 1008) socket.close(1008, 'policy refusal');
              else socket.terminate();
            }
            await clientClosed.promise;
          },
          { priority: 100 },
        );
        cleanups.push(removeMiddleware);
        return connection;
      },
    });
    void pending.catch(() => undefined);
    return { pending, responseObserved: responseObserved.promise, secondSession: secondSession.promise };
  }

  it('reconnects when a real pending reply is followed by ordinary closure before the next exchange', async () => {
    const host = await fixture();
    const { pending, responseObserved, secondSession } = startAcrossPendingClose(host, 1006);
    await Promise.race([responseObserved, pending]);
    await Promise.race([secondSession, pending]);
    expect(host.connections).toHaveLength(2);
    expect(host.repository.attempts.get(host.record.executionAttemptId)?.runtimeGeneration).toBe(0);
    await driveTestAttemptToAllocated(host.authority, host.record.executionAttemptId, 'execution');
    const started = await pending;
    expect(started.connection).toBe(host.connections[1]);
    expect(await registerWorkerRuntime(started.connection.bus, host.options)).toBe(1);
    expect(
      host.connections[0]?.bus.getContext().requestHandlers.get('execution-attempt.operation.deliver') ?? [],
    ).toHaveLength(0);
    started.endpoint.cleanup();
  });

  it('does not reconnect after policy1008 closure between a real pending reply and the next exchange', async () => {
    const host = await fixture();
    const { pending, responseObserved } = startAcrossPendingClose(host, 1008);
    await Promise.race([responseObserved, pending]);
    const error = await pending.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(WebSocketConnectionError);
    expect(error).not.toBeInstanceOf(ConnectionLostError);
    expect(error).toMatchObject({ code: 'WS_POLICY_REJECTED' });
    expect(host.connections).toHaveLength(1);
    expect(host.calls).toEqual([host.record.executionAttemptId]);
    expect(host.repository.attempts.get(host.record.executionAttemptId)?.runtimeGeneration).toBe(0);
  });

  it('treats an expired durable budget as terminal across pending renewals', async () => {
    const host = await fixture(200);
    await expect(bootstrapWorkerRuntime(host.options)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BootstrapDeadlineExceededError ||
        (error instanceof BootstrapStartRefusedError && error.refusalReason === 'bootstrap-expired'),
    );
    expect(host.connections).toHaveLength(1);
    expect(host.repository.attempts.get(host.record.executionAttemptId)?.runtimeGeneration).toBe(0);
  });

  it('does not apply the bootstrap deadline to registration after timely permission', async () => {
    const host = await fixture();
    await driveTestAttemptToAllocated(host.authority, host.record.executionAttemptId, 'execution');
    const started = await bootstrapWorkerRuntime(host.options);
    const afterDeadline = Date.parse(host.options.bootstrapDeadlineAt) + 1;
    vi.spyOn(Date, 'now').mockReturnValue(afterDeadline);
    const generation = await registerWorkerRuntime(started.connection.bus, host.options);
    expect(generation).toBe(1);
    started.endpoint.cleanup();
  });

  it('closes a pending session on cancellation and never registers', async () => {
    const host = await fixture();
    const controller = new AbortController();
    const pending = bootstrapWorkerRuntime({ ...host.options, signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow('stopped');
    await vi.waitFor(() => expect(host.calls.length).toBeGreaterThan(0));
    controller.abort(new Error('stopped'));
    await rejection;
    expect(host.repository.attempts.get(host.record.executionAttemptId)?.runtimeGeneration).toBe(0);
    await vi.waitFor(() => expect(serverConnectionCount(host.server)).toBe(0));
  });
});

/**
 * Count real socket ownership after client teardown.
 * @param server - Fixture WebSocket server.
 * @returns Number of connections not yet closed.
 */
function serverConnectionCount(server: WebSocketServer): number {
  return server.clients.size;
}

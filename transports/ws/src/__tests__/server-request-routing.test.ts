/**
 * Server-initiated request routing against a real client registry and
 * correlation tracker.
 *
 * These cases need control over the instants between an attempt's rejection
 * and the routing continuation, and over the time serialization spends, which
 * live sockets cannot provide deterministically.
 */

import { CorrelationTracker, NoHandlerError, TimeoutError, type BusRequestMessage } from '@makaio/bus-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientRegistry } from '../client-registry.js';
import { ServerBoundaryAccess } from '../server-boundary-access.js';
import { routeRequestToClients } from '../server-client-setup.js';
import { MockWebSocket } from './test-helpers.js';

const SUBJECT = 'test.action';

describe('routeRequestToClients', () => {
  let registry: ClientRegistry;
  let correlations: CorrelationTracker;
  let route: AbortController;
  let sockets: MockWebSocket[];

  /**
   * Build a server-initiated request envelope for `test.action`.
   * @param payload - Request payload
   * @returns Request envelope with correlation ID `corr`
   */
  function makeRequest(payload: unknown = {}): BusRequestMessage {
    return { type: 'request', namespace: 'test', subject: 'action', payload, correlationId: 'corr', messageId: 'msg' };
  }

  /**
   * Route a request and capture its settlement without an unhandled rejection.
   * @param request - Request envelope
   * @param timeout - Total routing budget in milliseconds
   * @returns Resolved value or rejection reason
   */
  function routeSettled(request: BusRequestMessage, timeout: number): Promise<unknown> {
    return routeRequestToClients(request, timeout, {
      registry,
      correlationsFor: () => correlations,
      signal: route.signal,
    }).then(
      (value: unknown) => value,
      (error: unknown) => error,
    );
  }

  beforeEach(() => {
    registry = new ClientRegistry();
    correlations = new CorrelationTracker();
    route = new AbortController();
    // Two clients advertise a request handler for the subject.
    sockets = [new MockWebSocket(), new MockWebSocket()];
    for (const socket of sockets) {
      registry.addClient(socket);
      registry.handleSubscribeMessage(socket, { type: 'subscribe', subjects: { [SUBJECT]: [0] }, deliveryClasses: {} });
    }
  });

  afterEach(() => {
    correlations.cleanup();
    vi.useRealTimers();
  });

  it('ends routing with the caller reason when cancellation lands right after a no-handler answer', async () => {
    const outcome = routeSettled(makeRequest(), 0);
    expect(sockets[0].sentMessages).toHaveLength(1);

    // The answer settles the attempt; cancellation arrives before routing resumes.
    correlations.reject(JSON.parse(sockets[0].sentMessages[0]).correlationId, new NoHandlerError(SUBJECT));
    const cancellation = new Error('caller cancelled');
    route.abort(cancellation);

    expect(await outcome).toBe(cancellation);
    expect(sockets[1].sentMessages).toHaveLength(0);
  });

  it('ends routing with the caller reason when cancellation lands after the last client answered no handler', async () => {
    registry.removeClient(sockets[1]);
    const outcome = routeSettled(makeRequest(), 0);

    correlations.reject(JSON.parse(sockets[0].sentMessages[0]).correlationId, new NoHandlerError(SUBJECT));
    const cancellation = new Error('caller cancelled');
    route.abort(cancellation);

    expect(await outcome).toBe(cancellation);
  });

  it('propagates a timeout-shaped cancellation reason unchanged', async () => {
    const outcome = routeSettled(makeRequest(), 1_000);

    const cancellation = new TimeoutError('caller.deadline', 5);
    route.abort(cancellation);

    expect(await outcome).toBe(cancellation);
    expect(sockets[1].sentMessages).toHaveLength(0);
  });

  it('sends nothing once serialization has spent the budget', async () => {
    vi.useFakeTimers();
    // Serializing the payload takes longer than the whole budget.
    const payload = {
      toJSON: (): string => {
        vi.setSystemTime(Date.now() + 40);
        return 'slow';
      },
    };

    const error = await routeSettled(makeRequest(payload), 20);

    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ subject: SUBJECT, timeoutMs: 20 });
    expect(sockets.map((socket) => socket.sentMessages.length)).toEqual([0, 0]);
  });

  it('times out when a denied delivery decision spends the routing budget', async () => {
    vi.useFakeTimers();
    const access = new ServerBoundaryAccess('websocket', undefined, async (target) => {
      if (target.operation !== 'handle') return undefined;
      await Promise.resolve();
      vi.setSystemTime(Date.now() + 40);
      return new Error('Delivery denied');
    });
    await expect(
      routeRequestToClients(makeRequest(), 20, {
        access,
        registry,
        correlationsFor: () => correlations,
        signal: route.signal,
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(sockets.map((socket) => socket.sentMessages.length)).toEqual([0, 0]);
  });

  it('sends nothing once candidate lookup has spent the budget', async () => {
    vi.useFakeTimers();
    // Every client filters on `tenant`; reading it while the registry selects
    // candidates takes longer than the whole budget.
    for (const socket of sockets) {
      registry.handleSubscribeMessage(socket, {
        type: 'subscribe',
        subjects: { [SUBJECT]: [0] },
        filters: { [SUBJECT]: { tenant: 'acme' } },
        deliveryClasses: {},
      });
    }
    // Only the first read is slow, so serialization afterwards spends nothing:
    // the exhausted budget can come from candidate lookup alone.
    let slowLookupDone = false;
    const payload = {
      get tenant(): string {
        if (!slowLookupDone) {
          slowLookupDone = true;
          vi.setSystemTime(Date.now() + 40);
        }
        return 'acme';
      },
    };

    const error = await routeSettled(makeRequest(payload), 20);

    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ subject: SUBJECT, timeoutMs: 20 });
    expect(sockets.map((socket) => socket.sentMessages.length)).toEqual([0, 0]);
  });

  /**
   * Make every client filter on `tenant`, so reading it is part of candidate lookup.
   * @param subscribedTenant - Tenant value the clients filter for
   */
  function filterClientsOnTenant(subscribedTenant: string): void {
    for (const socket of sockets) {
      registry.handleSubscribeMessage(socket, {
        type: 'subscribe',
        subjects: { [SUBJECT]: [0] },
        filters: { [SUBJECT]: { tenant: subscribedTenant } },
        deliveryClasses: {},
      });
    }
  }

  it('ends routing with the caller reason when candidate lookup cancels and excludes every client', async () => {
    // The payload tenant never matches the clients' filter, so none is a candidate.
    filterClientsOnTenant('other');
    const cancellation = new Error('cancelled during lookup');
    const payload = {
      get tenant(): string {
        route.abort(cancellation);
        return 'acme';
      },
    };

    expect(await routeSettled(makeRequest(payload), 1_000)).toBe(cancellation);
    expect(sockets.map((socket) => socket.sentMessages.length)).toEqual([0, 0]);
  });

  it('sends nothing when candidate lookup cancels and still selects clients', async () => {
    filterClientsOnTenant('acme');
    const cancellation = new Error('cancelled during lookup');
    const payload = {
      get tenant(): string {
        route.abort(cancellation);
        return 'acme';
      },
    };

    expect(await routeSettled(makeRequest(payload), 1_000)).toBe(cancellation);
    expect(sockets.map((socket) => socket.sentMessages.length)).toEqual([0, 0]);
  });

  it('reports no handler when lookup spent the budget but excluded every client', async () => {
    vi.useFakeTimers();
    // Nothing is sent, so the spent budget guards nothing and the definitive answer wins.
    filterClientsOnTenant('other');
    const payload = {
      get tenant(): string {
        vi.setSystemTime(Date.now() + 40);
        return 'acme';
      },
    };

    expect(await routeSettled(makeRequest(payload), 20)).toBeInstanceOf(NoHandlerError);
  });

  it('sends nothing when serialization cancels the request', async () => {
    // A payload getter or `toJSON` can cancel the request synchronously while it is serialized.
    const cancellation = new Error('cancelled during serialization');
    const payload = {
      toJSON: (): string => {
        route.abort(cancellation);
        return 'cancelling';
      },
    };

    expect(await routeSettled(makeRequest(payload), 1_000)).toBe(cancellation);
    expect(sockets.map((socket) => socket.sentMessages.length)).toEqual([0, 0]);
  });

  it('puts the budget left after serialization on the wire', async () => {
    vi.useFakeTimers();
    // Serialization spends 60 of the 100 ms budget.
    const payload = {
      toJSON: (): string => {
        vi.setSystemTime(Date.now() + 60);
        return 'slow';
      },
    };

    void routeSettled(makeRequest(payload), 100);

    expect(JSON.parse(sockets[0].sentMessages[0])).toMatchObject({ timeout: 40 });
  });

  it('advertises an unbounded request as unbounded on the wire', async () => {
    void routeSettled({ ...makeRequest(), timeout: 5_000 }, 0);

    expect(JSON.parse(sockets[0].sentMessages[0])).toMatchObject({ timeout: 0 });
  });

  it('stops waiting at the shared deadline when serialization spent part of the budget', async () => {
    vi.useFakeTimers();
    // Serialization spends 60 of the 100 ms budget.
    const payload = {
      toJSON: (): string => {
        vi.setSystemTime(Date.now() + 60);
        return 'slow';
      },
    };

    const outcome = routeSettled(makeRequest(payload), 100);
    expect(sockets[0].sentMessages).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(40);
    const error = await Promise.race([outcome, Promise.resolve('pending')]);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ subject: SUBJECT, timeoutMs: 100 });
  });
});

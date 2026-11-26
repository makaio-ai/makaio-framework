import {
  CorrelationTracker,
  DEFAULT_REQUEST_TIMEOUT_MS,
  deserializeTransportError,
  type BusReceiveHandler,
  type BusRequestMessage,
} from '@makaio/bus-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BroadcastAggregator } from '../broadcast-aggregator.js';
import { ClientRegistry } from '../client-registry.js';
import { DeferredSubscriptionReplay } from '../deferred-subscription-replay.js';
import { ServerBoundaryAccess } from '../server-boundary-access.js';
import { createInboundMessageHandler, routeMessage, type MessageHandlerDeps } from '../server-message-handler.js';
import {
  clearHmacIdentitySecretsForTesting,
  registerHmacIdentitySecret,
  resolveHmacIdentityAllowedSubscriptionSubjects,
  resolveHmacIdentityRequiredSubscriptionFilters,
  rotateHmacIdentitySecret,
} from '../auth/identity-secret-registry.js';
import type { TransportAuth, WebSocketLike } from '../types.js';
import { MockWebSocket } from './test-helpers.js';

function makeDeps(overrides: Partial<MessageHandlerDeps> = {}): MessageHandlerDeps {
  return {
    registry: new ClientRegistry(),
    correlations: new CorrelationTracker(),
    broadcastAggregator: new BroadcastAggregator({ timeout: 0 }),
    handlers: new Set<BusReceiveHandler>(),
    auth: undefined,
    normalizeBroadcastTimeout: () => 0,
    sendSafely: vi.fn(),
    debug: true,
    ...overrides,
  };
}

function makeAuth(overrides: Partial<TransportAuth>): TransportAuth {
  return {
    authenticateClient: vi.fn(async () => undefined),
    authenticateServer: vi.fn(async () => undefined),
    handleAuthMessage: vi.fn(() => false),
    cleanupSocket: vi.fn(),
    cleanup: vi.fn(),
    ...overrides,
  };
}

/**
 * Model the verified identity and projected caller for each authenticated socket.
 * @param identities - Verified identity by socket.
 * @param kind - Party kind exposed to receive handlers.
 * @returns Auth stub with per-socket identity and caller context.
 */
function makePerSocketAuth(
  identities: ReadonlyMap<WebSocketLike, string>,
  kind = 'test.worker-bootstrap',
): TransportAuth {
  const getAuthenticatedIdentityId = (socket: WebSocketLike) => identities.get(socket);
  return makeAuth({
    getAuthenticatedIdentityId,
    getReceiveContext: (socket) => {
      const id = socket === undefined ? undefined : getAuthenticatedIdentityId(socket);
      return id === undefined ? undefined : { transportName: 'websocket', authenticated: true, caller: { kind, id } };
    },
  });
}

describe('createInboundMessageHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([0, 20, 40])('charges send authorization against the inbound budget of %i ms', async (timeout) => {
    const socket = new MockWebSocket();
    const requests: BusRequestMessage[] = [];
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let now = 1_000;
    const access = new ServerBoundaryAccess('websocket', undefined, async () => {
      entered.resolve();
      await released.promise;
    });
    const deps = makeDeps({
      access,
      now: () => now,
      handlers: new Set([
        async (message) => {
          if (message.type === 'request') requests.push(message);
        },
      ]),
      sendSafely: (client, frame) => {
        client.send(frame);
        return true;
      },
    });
    deps.registry.addClient(socket);
    const handler = createInboundMessageHandler(socket, deps);
    const pending = handler(
      JSON.stringify({
        type: 'request',
        namespace: 'test',
        subject: 'action',
        correlationId: 'corr',
        messageId: 'msg',
        payload: {},
        timeout,
      }),
    );
    const authorizing = await Promise.race([entered.promise.then(() => true), pending.then(() => false)]);
    now += 20;
    released.resolve();
    await pending;
    expect(authorizing).toBe(true);

    if (timeout === 20) {
      expect(requests).toHaveLength(0);
      expect(socket.sentMessages.map((frame) => JSON.parse(frame))).toMatchObject([
        { type: 'response', correlationId: 'corr', error: { subject: 'test.action', data: { timeoutMs: timeout } } },
      ]);
    } else {
      expect(requests.map((request) => request.timeout)).toEqual([timeout === 0 ? 0 : timeout - 20]);
    }
  });

  it('removes a subscription and rejects its acknowledgement when the peer changes during dispatch', async () => {
    const socket = new MockWebSocket();
    const identities = new Map([[socket, 'before']]);
    const auth = makePerSocketAuth(identities);
    const registry = new ClientRegistry();
    registry.addClient(socket);
    const handle = vi.fn<BusReceiveHandler>(async (message) => {
      if (message.type === 'subscribe') identities.set(socket, 'after');
    });
    const access = new ServerBoundaryAccess('websocket', auth, async () => undefined);
    const deps = makeDeps({ access, auth, registry, handlers: new Set([handle]) });
    await routeMessage(
      {
        type: 'subscribe',
        ackId: 'ack',
        subjects: { 'test.action': [1] },
        deliveryClasses: { 'test.action': 'relayable' },
      },
      socket,
      deps,
    );
    expect(registry.matchesDelivery(socket, 'test.action', {}, 'handler')).toBe(false);
    expect(handle.mock.calls.map(([message]) => message.type)).toEqual(['subscribe', 'unsubscribe']);
    expect(deps.sendSafely).toHaveBeenCalledExactlyOnceWith(socket, expect.any(String));
    const ack = JSON.parse(vi.mocked(deps.sendSafely).mock.calls[0][1]);
    expect(ack).toMatchObject({
      type: 'subscription-ack',
      ackId: 'ack',
      error: { code: 'forbidden' },
    });
    expect(deserializeTransportError(ack.error)).toMatchObject({ data: { reason: 'peer-changed' } });
  });

  it('logs malformed JSON as a parse failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createInboundMessageHandler(new MockWebSocket(), makeDeps());

    await handler('{');

    expect(errorSpy).toHaveBeenCalledWith('[ServerTransport] Failed to parse message:', expect.any(SyntaxError));
    expect(errorSpy).not.toHaveBeenCalledWith('[ServerTransport] Failed to process message:', expect.anything());
  });

  it('logs auth and routing failures as processing failures', async () => {
    const error = new Error('auth failed');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = makeAuth({
      handleAuthMessage: vi.fn(() => {
        throw error;
      }),
    });
    const handler = createInboundMessageHandler(new MockWebSocket(), makeDeps({ auth }));

    await handler(JSON.stringify({ type: 'event', namespace: 'test', subject: 'message', payload: {} }));

    expect(errorSpy).toHaveBeenCalledWith('[ServerTransport] Failed to process message:', error);
    expect(errorSpy).not.toHaveBeenCalledWith('[ServerTransport] Failed to parse message:', expect.anything());
  });

  it('drops non-auth messages while the socket is authenticating', async () => {
    const socket = new MockWebSocket();
    const registry = new ClientRegistry();
    const handlers = new Set<BusReceiveHandler>();
    const handlerSpy = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    handlers.add(handlerSpy);

    // Auth that never claims the message (returns false) — simulates a non-auth frame
    // arriving while the socket is still in the authenticating state.
    const auth = makeAuth({ handleAuthMessage: vi.fn(() => false) });

    registry.addAuthenticating(socket);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const handler = createInboundMessageHandler(socket, makeDeps({ auth, registry, handlers }));

    await handler(JSON.stringify({ type: 'event', namespace: 'test', subject: 'x', payload: {} }));

    // The message must NOT reach any handler — the auth gate must have dropped it.
    expect(handlerSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[ServerTransport] Ignoring message from unauthenticated client');
  });

  it('closes sockets whose authenticated session has expired before routing bus messages', async () => {
    const socket = new MockWebSocket();
    const handlers = new Set<BusReceiveHandler>();
    const handlerSpy = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    handlers.add(handlerSpy);
    const auth = makeAuth({
      handleAuthMessage: vi.fn(() => false),
      isSocketAuthenticated: vi.fn(() => false),
    });
    const closeSpy = vi.spyOn(socket, 'close');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handler = createInboundMessageHandler(socket, makeDeps({ auth, handlers }));

    await handler(JSON.stringify({ type: 'event', namespace: 'test', subject: 'x', payload: {} }));

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(auth.cleanupSocket).toHaveBeenCalledWith(socket);
    expect(closeSpy).toHaveBeenCalledWith(1008, 'Authentication expired');
    expect(warnSpy).toHaveBeenCalledWith('[ServerTransport] Closing socket with expired authentication');
  });

  it('routes messages when auth has no live-socket authorization hook', async () => {
    const socket = new MockWebSocket();
    const handlers = new Set<BusReceiveHandler>();
    const handlerSpy = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    handlers.add(handlerSpy);
    const auth = makeAuth({ handleAuthMessage: vi.fn(() => false) });
    const handler = createInboundMessageHandler(socket, makeDeps({ auth, handlers }));

    await handler(JSON.stringify({ type: 'event', namespace: 'test', subject: 'x', payload: {} }));

    expect(handlerSpy).toHaveBeenCalledOnce();
  });

  it('rejects malformed priority arrays before they enter aggregate state', async () => {
    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const deps = makeDeps({ handlers: new Set([handler]), debug: false });

    const inbound = createInboundMessageHandler(socket, deps);
    await inbound(
      JSON.stringify({
        type: 'subscribe',
        subjects: { 'hook.response': ['invalid'] },
        deliveryClasses: { 'hook.response': 'relayable' },
      }),
    );
    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'hook.response': [100] },
        deliveryClasses: { 'hook.response': 'relayable' },
      },
      new MockWebSocket(),
      deps,
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      {
        type: 'subscribe',
        subjects: { 'hook.response': [100] },
        deliveryClasses: { 'hook.response': 'relayable' },
      },
      undefined,
    );
  });

  it('rejects subscribe with a typed acknowledgement when a handler fails', async () => {
    const socket = new MockWebSocket();
    const sendSafely = vi.fn();
    const handlers = new Set<BusReceiveHandler>([
      async () => {
        throw new Error('subscribe handler failed');
      },
    ]);

    await routeMessage(
      {
        type: 'subscribe',
        ackId: 'subscribe-failed',
        subjects: { 'test.subject': [] },
        deliveryClasses: { 'test.subject': 'relayable' },
      },
      socket,
      makeDeps({ debug: false, handlers, sendSafely }),
    );

    expect(sendSafely).toHaveBeenCalledExactlyOnceWith(socket, expect.any(String));
    const ack = JSON.parse(sendSafely.mock.calls[0][1]);
    expect(ack).toMatchObject({ type: 'subscription-ack', ackId: 'subscribe-failed', error: { code: 'forbidden' } });
    expect(deserializeTransportError(ack.error)).toMatchObject({ data: { reason: 'subscription-dispatch-failed' } });
  });

  it('rejects unsubscribe with a typed acknowledgement when a handler fails', async () => {
    const socket = new MockWebSocket();
    const sendSafely = vi.fn();
    const handlers = new Set<BusReceiveHandler>([
      async () => {
        throw new Error('unsubscribe handler failed');
      },
    ]);

    await routeMessage(
      {
        type: 'unsubscribe',
        ackId: 'unsubscribe-failed',
        subjects: { 'test.subject': [] },
      },
      socket,
      makeDeps({ debug: false, handlers, sendSafely }),
    );

    expect(sendSafely).toHaveBeenCalledExactlyOnceWith(socket, expect.any(String));
    const ack = JSON.parse(sendSafely.mock.calls[0][1]);
    expect(ack).toMatchObject({ type: 'subscription-ack', ackId: 'unsubscribe-failed', error: { code: 'forbidden' } });
    expect(deserializeTransportError(ack.error)).toMatchObject({ data: { reason: 'subscription-dispatch-failed' } });
  });

  it('aggregates priorities and lets first-hop-only win across clients', async () => {
    const clientA = new MockWebSocket();
    const clientB = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const deps = makeDeps({ handlers: new Set([handler]) });

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'hook.response': [100] },
        deliveryClasses: { 'hook.response': 'relayable' },
      },
      clientA,
      deps,
    );
    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'hook.response': [200] },
        deliveryClasses: { 'hook.response': 'first-hop-only' },
      },
      clientB,
      deps,
    );

    expect(handler).toHaveBeenLastCalledWith(
      {
        type: 'subscribe',
        subjects: { 'hook.response': [200, 100] },
        deliveryClasses: { 'hook.response': 'first-hop-only' },
      },
      undefined,
    );
  });

  it('retains the aggregate subscription until the final client unsubscribes', async () => {
    const clientA = new MockWebSocket();
    const clientB = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const deps = makeDeps({ handlers: new Set([handler]) });

    for (const client of [clientA, clientB]) {
      await routeMessage(
        {
          type: 'subscribe',
          subjects: { 'hook.response': client === clientA ? [100] : [200] },
          deliveryClasses: { 'hook.response': client === clientA ? 'relayable' : 'first-hop-only' },
        },
        client,
        deps,
      );
    }

    handler.mockClear();
    await routeMessage({ type: 'unsubscribe', subjects: { 'hook.response': [200] } }, clientB, deps);
    expect(handler).toHaveBeenLastCalledWith(
      {
        type: 'subscribe',
        subjects: { 'hook.response': [100] },
        deliveryClasses: { 'hook.response': 'relayable' },
      },
      undefined,
    );

    await routeMessage({ type: 'unsubscribe', subjects: { 'hook.response': [100] } }, clientA, deps);
    expect(handler).toHaveBeenLastCalledWith({ type: 'unsubscribe', subjects: { 'hook.response': [] } }, undefined);
  });
});

// ---------------------------------------------------------------------------
// Subject restriction enforcement for identity-bound peers
// ---------------------------------------------------------------------------

describe('subject restriction enforcement', () => {
  const ALLOWED_SUBJECT = 'worker.control.bootstrap.claim';
  const BOOTSTRAP_IDENTITY = 'bootstrap-test-id';
  const BOOTSTRAP_SECRET = 'bootstrap-test-secret';

  afterEach(() => {
    clearHmacIdentitySecretsForTesting();
  });

  /**
   * Create an auth stub that returns a caller context referencing a registered
   * identity, simulating a socket authenticated via the identity registry.
   * @param identityId - Identity ID for the authenticated peer.
   * @param partyKind - Caller party kind in owner.name form.
   * @returns TransportAuth stub with the verified identity and caller context wired.
   */
  function makeRestrictedAuth(identityId: string, partyKind: string): TransportAuth {
    return makeAuth({
      getAuthenticatedIdentityId: () => identityId,
      getReceiveContext: () => ({
        transportName: 'websocket',
        authenticated: true,
        caller: {
          kind: partyKind,
          id: identityId,
        },
      }),
    });
  }

  it('allows a request to the permitted subject', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedMessageSubjects: [ALLOWED_SUBJECT],
    });

    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const sendSafely = vi.fn();
    const auth = makeRestrictedAuth(BOOTSTRAP_IDENTITY, 'test.worker-bootstrap');

    await routeMessage(
      {
        type: 'request',
        namespace: 'worker',
        subject: 'control.bootstrap.claim',
        correlationId: 'corr-1',
        messageId: 'msg-1',
        payload: {},
      },
      socket,
      makeDeps({ auth, handlers: new Set([handler]), sendSafely }),
    );

    // The request must reach the handler — not be rejected.
    expect(handler).toHaveBeenCalledOnce();
  });

  it('allows a message-capable peer to originate requests, events, and broadcasts', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedMessageSubjects: [ALLOWED_SUBJECT],
    });

    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const auth = makeRestrictedAuth(BOOTSTRAP_IDENTITY, 'test.worker-bootstrap');
    const deps = makeDeps({ auth, handlers: new Set([handler]) });

    await routeMessage(
      {
        type: 'request',
        namespace: 'worker',
        subject: 'control.bootstrap.claim',
        correlationId: 'message-grant-request',
        messageId: 'message-grant-request-id',
        payload: {},
      },
      socket,
      deps,
    );
    await routeMessage(
      {
        type: 'event',
        namespace: 'worker',
        subject: 'control.bootstrap.claim',
        messageId: 'message-grant-event-id',
        payload: {},
      },
      socket,
      deps,
    );
    await routeMessage(
      {
        type: 'broadcast',
        namespace: 'worker',
        subject: 'control.bootstrap.claim',
        correlationId: 'message-grant-broadcast',
        messageId: 'message-grant-broadcast-id',
        payload: {},
      },
      socket,
      deps,
    );

    expect(handler).toHaveBeenCalledTimes(3);
    handler.mockClear();

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { [ALLOWED_SUBJECT]: [100] },
        deliveryClasses: { [ALLOWED_SUBJECT]: 'relayable' },
      },
      socket,
      deps,
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it('lets a subscription-only peer advertise delivery without originating messages', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: [ALLOWED_SUBJECT],
    });

    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const sendSafely = vi.fn();
    const auth = makeRestrictedAuth(BOOTSTRAP_IDENTITY, 'test.worker-bootstrap');
    const deps = makeDeps({ auth, handlers: new Set([handler]), sendSafely });

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { [ALLOWED_SUBJECT]: [100] },
        deliveryClasses: { [ALLOWED_SUBJECT]: 'relayable' },
      },
      socket,
      deps,
    );
    expect(handler).toHaveBeenCalledOnce();
    handler.mockClear();

    await routeMessage(
      {
        type: 'request',
        namespace: 'worker',
        subject: 'control.bootstrap.claim',
        correlationId: 'subscription-grant-request',
        messageId: 'subscription-grant-request-id',
        payload: {},
      },
      socket,
      deps,
    );
    await routeMessage(
      {
        type: 'event',
        namespace: 'worker',
        subject: 'control.bootstrap.claim',
        messageId: 'subscription-grant-event-id',
        payload: {},
      },
      socket,
      deps,
    );
    await routeMessage(
      {
        type: 'broadcast',
        namespace: 'worker',
        subject: 'control.bootstrap.claim',
        correlationId: 'subscription-grant-broadcast',
        messageId: 'subscription-grant-broadcast-id',
        payload: {},
      },
      socket,
      deps,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(sendSafely).toHaveBeenCalledOnce();
    expect(JSON.parse(sendSafely.mock.calls[0]![1] as string)).toMatchObject({
      type: 'response',
      correlationId: 'subscription-grant-request',
      error: { message: expect.stringContaining('not allowed') },
    });
  });

  it('rejects a request to a disallowed subject with an error response', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedMessageSubjects: [ALLOWED_SUBJECT],
    });

    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const sendSafely = vi.fn();
    const auth = makeRestrictedAuth(BOOTSTRAP_IDENTITY, 'test.worker-bootstrap');

    await routeMessage(
      {
        type: 'request',
        namespace: 'worker',
        subject: 'control.outcome.submit',
        correlationId: 'corr-2',
        messageId: 'msg-2',
        payload: {},
      },
      socket,
      makeDeps({ auth, handlers: new Set([handler]), sendSafely }),
    );

    // The request must NOT reach any handler.
    expect(handler).not.toHaveBeenCalled();

    // An error response must be sent back to the client.
    expect(sendSafely).toHaveBeenCalledOnce();
    const sentData = JSON.parse(sendSafely.mock.calls[0]![1] as string);
    expect(sentData).toMatchObject({
      type: 'response',
      correlationId: 'corr-2',
      error: {
        message: expect.stringContaining('not allowed'),
      },
    });
  });

  it('drops events to a disallowed subject silently', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedMessageSubjects: [ALLOWED_SUBJECT],
    });

    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const sendSafely = vi.fn();
    const auth = makeRestrictedAuth(BOOTSTRAP_IDENTITY, 'test.worker-bootstrap');

    await routeMessage(
      {
        type: 'event',
        namespace: 'worker',
        subject: 'lifecycle.ready',
        messageId: 'msg-3',
        payload: {},
      },
      socket,
      makeDeps({ auth, handlers: new Set([handler]), sendSafely }),
    );

    // Event must NOT reach any handler.
    expect(handler).not.toHaveBeenCalled();
    // No response should be sent for events (drop silently).
    expect(sendSafely).not.toHaveBeenCalled();
  });

  it('drops broadcasts to a disallowed subject', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedMessageSubjects: [ALLOWED_SUBJECT],
    });

    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const sendSafely = vi.fn();
    const auth = makeRestrictedAuth(BOOTSTRAP_IDENTITY, 'test.worker-bootstrap');

    await routeMessage(
      {
        type: 'broadcast',
        namespace: 'worker',
        subject: 'lifecycle.ready',
        correlationId: 'corr-3',
        messageId: 'msg-4',
        payload: {},
      },
      socket,
      makeDeps({ auth, handlers: new Set([handler]), sendSafely }),
    );

    // Broadcast must NOT reach any handler.
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not restrict identities without directional subject grants', async () => {
    registerHmacIdentitySecret('unrestricted-peer', 'unrestricted-secret', {
      partyKind: 'test.workflow-execution',
    });

    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const auth = makeRestrictedAuth('unrestricted-peer', 'test.workflow-execution');

    await routeMessage(
      {
        type: 'request',
        namespace: 'worker',
        subject: 'control.outcome.submit',
        correlationId: 'corr-4',
        messageId: 'msg-5',
        payload: {},
      },
      socket,
      makeDeps({ auth, handlers: new Set([handler]) }),
    );

    // Unrestricted identity — request must reach handler.
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not restrict global-secret peers (no peer identity)', async () => {
    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    // Global-secret auth: getReceiveContext returns undefined (no peer).
    const auth = makeAuth({
      getReceiveContext: () => undefined,
    });

    await routeMessage(
      {
        type: 'request',
        namespace: 'worker',
        subject: 'control.outcome.submit',
        correlationId: 'corr-5',
        messageId: 'msg-6',
        payload: {},
      },
      socket,
      makeDeps({ auth, handlers: new Set([handler]) }),
    );

    // No peer identity — no restriction — request must reach handler.
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Subscribe/unsubscribe subject restriction for identity-bound peers
// ---------------------------------------------------------------------------

describe('subscribe/unsubscribe subject restriction', () => {
  const ALLOWED_SUBJECT = 'worker.control.bootstrap.claim';
  const BOOTSTRAP_IDENTITY = 'bootstrap-sub-test';
  const BOOTSTRAP_SECRET = 'bootstrap-sub-secret';

  afterEach(() => {
    clearHmacIdentitySecretsForTesting();
  });

  it('filters disallowed subjects from a subscribe message', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: [ALLOWED_SUBJECT],
    });

    const restrictedSocket = new MockWebSocket();
    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makePerSocketAuth(socketMap);
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const registry = new ClientRegistry();

    await routeMessage(
      {
        type: 'subscribe',
        subjects: {
          [ALLOWED_SUBJECT]: [100],
          'worker.lifecycle.ready': [100],
        },
        deliveryClasses: {
          [ALLOWED_SUBJECT]: 'relayable',
          'worker.lifecycle.ready': 'relayable',
        },
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );

    // Only the allowed subject should reach the handler; the disallowed
    // subject must be stripped before registry processing.
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'subscribe',
        subjects: expect.objectContaining({ [ALLOWED_SUBJECT]: expect.any(Array) }),
      }),
      expect.anything(),
    );
    // The disallowed subject must NOT appear in the forwarded subscribe.
    const subscribeCalls = handler.mock.calls.filter(([msg]) => msg.type === 'subscribe');
    for (const [msg] of subscribeCalls) {
      if (msg.type === 'subscribe') {
        expect(msg.subjects).not.toHaveProperty('worker.lifecycle.ready');
      }
    }
  });

  it('drops subscribe message entirely when all subjects are disallowed', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: [ALLOWED_SUBJECT],
    });

    const restrictedSocket = new MockWebSocket();
    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makePerSocketAuth(socketMap);
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const registry = new ClientRegistry();

    await routeMessage(
      {
        type: 'subscribe',
        subjects: {
          'worker.lifecycle.ready': [100],
          'worker.control.outcome.submit': [100],
        },
        deliveryClasses: {},
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );

    // No subscribe handler invocation — the message was dropped entirely.
    expect(handler).not.toHaveBeenCalled();
  });

  it('forgets a deferred subscription rejected by the live identity filter', async () => {
    const socket = new MockWebSocket();
    const auth = makePerSocketAuth(new Map([[socket, BOOTSTRAP_IDENTITY]]));
    const replay = new DeferredSubscriptionReplay(socket);
    const subjects = { 'test.action': [] };
    replay.stage({ type: 'subscribe', subjects, deliveryClasses: {} }, {}, subjects);
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: [ALLOWED_SUBJECT],
    });

    expect(replay.snapshot()).toHaveLength(1);
    for (const message of replay.snapshot()) await routeMessage(message, socket, makeDeps({ auth }), replay);
    expect(replay.snapshot()).toEqual([]);
  });

  it('filters disallowed subjects from an unsubscribe message', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: [ALLOWED_SUBJECT],
    });

    const restrictedSocket = new MockWebSocket();
    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makePerSocketAuth(socketMap);
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const registry = new ClientRegistry();

    // First subscribe to the allowed subject so there's state to unsubscribe.
    await routeMessage(
      {
        type: 'subscribe',
        subjects: { [ALLOWED_SUBJECT]: [100] },
        deliveryClasses: {},
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );
    handler.mockClear();

    await routeMessage(
      {
        type: 'unsubscribe',
        subjects: {
          [ALLOWED_SUBJECT]: [100],
          'worker.lifecycle.ready': [100],
        },
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );

    // Only the allowed subject should be processed; disallowed subject stripped.
    const unsubCalls = handler.mock.calls.filter(([msg]) => msg.type === 'unsubscribe');
    for (const [msg] of unsubCalls) {
      if (msg.type === 'unsubscribe') {
        expect(msg.subjects).not.toHaveProperty('worker.lifecycle.ready');
      }
    }
  });

  it('rejects wildcard subscription from a restricted identity', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: [ALLOWED_SUBJECT],
    });

    const restrictedSocket = new MockWebSocket();
    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makePerSocketAuth(socketMap);
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const registry = new ClientRegistry();

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'worker.*': [100] },
        deliveryClasses: {},
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );

    // Wildcard not in allowedSubscriptionSubjects verbatim — must be rejected.
    expect(handler).not.toHaveBeenCalled();
  });

  it('allows a concrete subscription covered by an allowed wildcard pattern', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: ['worker.*'],
    });

    const restrictedSocket = new MockWebSocket();
    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makePerSocketAuth(socketMap);
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'worker.control.bootstrap.claim': [100], 'session.list': [100] },
        deliveryClasses: {},
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry: new ClientRegistry() }),
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'subscribe',
        subjects: { 'worker.control.bootstrap.claim': [100] },
      }),
      expect.anything(),
    );
  });

  it('enforces an option-only required filter without directional allow-lists', async () => {
    const identityId = 'filter-only-identity';
    const protectedSubject = 'workload.operation.deliver';
    registerHmacIdentitySecret(identityId, 'filter-only-secret', {
      partyKind: 'test.job-run',
      requiredSubscriptionFilters: { [protectedSubject]: { executionId: 'attempt-a' } },
    });

    const restrictedSocket = new MockWebSocket();
    const auth = makePerSocketAuth(new Map([[restrictedSocket, identityId]]));
    const registry = new ClientRegistry({
      requiredSubscriptionFilterResolver: () => resolveHmacIdentityRequiredSubscriptionFilters(identityId),
    });
    registry.addClient(restrictedSocket);

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { [protectedSubject]: [100] },
        deliveryClasses: { [protectedSubject]: 'relayable' },
      },
      restrictedSocket,
      makeDeps({ auth, registry }),
    );

    expect(registry.getInterestedRequestClients(protectedSubject, { executionId: 'attempt-a' })).toEqual([
      restrictedSocket,
    ]);
    expect(registry.getInterestedRequestClients(protectedSubject, { executionId: 'attempt-b' })).toEqual([]);
  });

  it('allows a filter-only wildcard advertisement when the policy is enforced at delivery', async () => {
    const identityId = 'filter-only-wildcard-identity';
    const protectedSubject = 'workload.operation.deliver';
    registerHmacIdentitySecret(identityId, 'filter-only-wildcard-secret', {
      partyKind: 'test.job-run',
      requiredSubscriptionFilters: { [protectedSubject]: { executionId: 'attempt-a' } },
    });

    const restrictedSocket = new MockWebSocket();
    const auth = makePerSocketAuth(new Map([[restrictedSocket, identityId]]));
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const registry = new ClientRegistry({
      requiredSubscriptionFilterResolver: () => resolveHmacIdentityRequiredSubscriptionFilters(identityId),
    });
    registry.addClient(restrictedSocket);

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'workload.*': [100] },
        deliveryClasses: { 'workload.*': 'relayable' },
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subscribe', subjects: { 'workload.*': [100] } }),
      expect.anything(),
    );
    expect(registry.getInterestedRequestClients(protectedSubject, { executionId: 'attempt-a' })[0]).toBe(
      restrictedSocket,
    );
    expect(registry.getInterestedRequestClients(protectedSubject, { executionId: 'attempt-b' })).toEqual([]);
  });

  it('allows a wildcard advertisement granted to a restricted identity', async () => {
    const identityId = 'wildcard-filter-identity';
    const protectedSubject = 'workload.operation.deliver';
    registerHmacIdentitySecret(identityId, 'wildcard-filter-secret', {
      partyKind: 'test.job-run',
      allowedMessageSubjects: [],
      allowedSubscriptionSubjects: ['workload.*'],
      requiredSubscriptionFilters: { [protectedSubject]: { executionId: 'attempt-a' } },
    });

    const restrictedSocket = new MockWebSocket();
    const auth = makePerSocketAuth(new Map([[restrictedSocket, identityId]]));
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const registry = new ClientRegistry({
      requiredSubscriptionFilterResolver: () => resolveHmacIdentityRequiredSubscriptionFilters(identityId),
    });
    registry.addClient(restrictedSocket);

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'workload.*': [100] },
        deliveryClasses: { 'workload.*': 'relayable' },
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subscribe', subjects: { 'workload.*': [100] } }),
      expect.anything(),
    );
    expect(registry.getInterestedRequestClients(protectedSubject, { executionId: 'attempt-a' })[0]).toBe(
      restrictedSocket,
    );
    expect(registry.getInterestedRequestClients(protectedSubject, { executionId: 'attempt-b' })).toEqual([]);
  });

  it('allows a concrete protected advertisement through a wildcard grant with its trusted filter', async () => {
    const identityId = 'wildcard-concrete-filter-identity';
    const protectedSubject = 'workload.operation.deliver';
    registerHmacIdentitySecret(identityId, 'wildcard-concrete-filter-secret', {
      partyKind: 'test.job-run',
      allowedMessageSubjects: [],
      allowedSubscriptionSubjects: ['workload.*'],
      requiredSubscriptionFilters: { [protectedSubject]: { executionId: 'attempt-a' } },
    });

    const restrictedSocket = new MockWebSocket();
    const auth = makePerSocketAuth(new Map([[restrictedSocket, identityId]]));
    const registry = new ClientRegistry({
      requiredSubscriptionFilterResolver: () => resolveHmacIdentityRequiredSubscriptionFilters(identityId),
    });
    registry.addClient(restrictedSocket);

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { [protectedSubject]: [100] },
        deliveryClasses: { [protectedSubject]: 'relayable' },
        filters: { [protectedSubject]: { executionId: 'attempt-a' } },
      },
      restrictedSocket,
      makeDeps({ auth, registry }),
    );

    expect(registry.getInterestedRequestClients(protectedSubject, { executionId: 'attempt-a' })).toEqual([
      restrictedSocket,
    ]);
    expect(registry.getInterestedRequestClients(protectedSubject, { executionId: 'attempt-b' })).toEqual([]);
  });

  it('allows an unrelated wildcard advertisement alongside required concrete filters', async () => {
    const identityId = 'safe-wildcard-filter-identity';
    const protectedSubject = 'workload.operation.deliver';
    registerHmacIdentitySecret(identityId, 'safe-wildcard-filter-secret', {
      partyKind: 'test.job-run',
      allowedMessageSubjects: [],
      allowedSubscriptionSubjects: ['workload.*', 'worker.*'],
      requiredSubscriptionFilters: { [protectedSubject]: { executionId: 'attempt-a' } },
    });

    const restrictedSocket = new MockWebSocket();
    const auth = makePerSocketAuth(new Map([[restrictedSocket, identityId]]));
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'worker.*': [100] },
        deliveryClasses: { 'worker.*': 'relayable' },
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]) }),
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subscribe', subjects: { 'worker.*': [100] } }),
      expect.anything(),
    );
  });

  it('allows wildcard subscription when it appears verbatim in allowedSubscriptionSubjects', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: ['worker.*'],
    });

    const restrictedSocket = new MockWebSocket();
    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makePerSocketAuth(socketMap);
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const registry = new ClientRegistry();

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'worker.*': [100] },
        deliveryClasses: {},
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );

    // Wildcard IS in allowedSubscriptionSubjects verbatim — must be accepted.
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'subscribe',
        subjects: expect.objectContaining({ 'worker.*': expect.any(Array) }),
      }),
      expect.anything(),
    );
  });

  it('does not restrict subscribe messages from unrestricted identities', async () => {
    registerHmacIdentitySecret('unrestricted-sub', 'unrestricted-sub-secret', {
      partyKind: 'test.workflow-execution',
      // No directional subject grants — unrestricted
    });

    const socket = new MockWebSocket();
    const socketMap = new Map<MockWebSocket, string>([[socket, 'unrestricted-sub']]);
    const auth = makePerSocketAuth(socketMap);
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const registry = new ClientRegistry();

    await routeMessage(
      {
        type: 'subscribe',
        subjects: {
          'worker.*': [100],
          'adapter.*': [100],
        },
        deliveryClasses: {},
      },
      socket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );

    // Unrestricted identity — all subjects must pass through.
    expect(handler).toHaveBeenCalled();
    const subCalls = handler.mock.calls.filter(([msg]) => msg.type === 'subscribe');
    expect(subCalls.length).toBeGreaterThanOrEqual(1);
    const lastSubMsg = subCalls[subCalls.length - 1]![0];
    if (lastSubMsg.type === 'subscribe') {
      expect(lastSubMsg.subjects).toHaveProperty('worker.*');
      expect(lastSubMsg.subjects).toHaveProperty('adapter.*');
    }
  });

  it('preserves restriction after secret rotation', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: [ALLOWED_SUBJECT],
    });
    rotateHmacIdentitySecret(BOOTSTRAP_IDENTITY, 'new-secret');

    const restrictedSocket = new MockWebSocket();
    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makePerSocketAuth(socketMap);
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const registry = new ClientRegistry();

    await routeMessage(
      {
        type: 'subscribe',
        subjects: {
          'worker.lifecycle.ready': [100],
        },
        deliveryClasses: {},
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );

    // After rotation, allowedSubscriptionSubjects must still be enforced.
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Outbound defense-in-depth: event/broadcast forwarding subject restriction
// ---------------------------------------------------------------------------

describe('outbound subject restriction on forwarding', () => {
  const ALLOWED_SUBJECT = 'worker.control.bootstrap.claim';
  const BOOTSTRAP_IDENTITY = 'bootstrap-fwd-test';
  const BOOTSTRAP_SECRET = 'bootstrap-fwd-secret';

  afterEach(() => {
    clearHmacIdentitySecretsForTesting();
  });

  it('does not forward events to a restricted peer on a disallowed subject', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: [ALLOWED_SUBJECT],
    });

    const senderSocket = new MockWebSocket();
    const restrictedSocket = new MockWebSocket();
    const sendSafely = vi.fn();

    // Build per-socket auth that returns correct identity for each socket.
    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makePerSocketAuth(socketMap);

    const registry = new ClientRegistry({
      debug: false,
      subscriptionSubjectRestrictionResolver: (client) => {
        const peerId = auth.getAuthenticatedIdentityId?.(client);
        if (!peerId) return null;
        return resolveHmacIdentityAllowedSubscriptionSubjects(peerId);
      },
    });

    registry.addClient(senderSocket);
    registry.addClient(restrictedSocket);

    // Restricted peer subscribes to the disallowed subject (simulating a bypass
    // that the inbound layer should have caught — defense-in-depth).
    registry.handleSubscribeMessage(restrictedSocket, {
      type: 'subscribe',
      subjects: { 'worker.lifecycle.ready': [100] },
      deliveryClasses: {},
    });

    // Sender emits an event on the disallowed subject.
    registry.forwardEventToClients(
      senderSocket,
      {
        type: 'event',
        namespace: 'worker',
        subject: 'lifecycle.ready',
        messageId: 'fwd-1',
        payload: {},
      },
      sendSafely,
    );

    // The restricted socket must NOT receive the forwarded event.
    const sentToRestricted = sendSafely.mock.calls.filter(([client]) => client === restrictedSocket);
    expect(sentToRestricted).toHaveLength(0);
  });

  it('forwards events to a restricted peer on an allowed subject', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: [ALLOWED_SUBJECT],
    });

    const senderSocket = new MockWebSocket();
    const restrictedSocket = new MockWebSocket();
    const sendSafely = vi.fn();

    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makePerSocketAuth(socketMap);

    const registry = new ClientRegistry({
      debug: false,
      subscriptionSubjectRestrictionResolver: (client) => {
        const peerId = auth.getAuthenticatedIdentityId?.(client);
        if (!peerId) return null;
        return resolveHmacIdentityAllowedSubscriptionSubjects(peerId);
      },
    });

    registry.addClient(senderSocket);
    registry.addClient(restrictedSocket);

    // Restricted peer subscribes to the allowed subject.
    registry.handleSubscribeMessage(restrictedSocket, {
      type: 'subscribe',
      subjects: { [ALLOWED_SUBJECT]: [100] },
      deliveryClasses: {},
    });

    // Sender emits an event on the allowed subject.
    registry.forwardEventToClients(
      senderSocket,
      {
        type: 'event',
        namespace: 'worker',
        subject: 'control.bootstrap.claim',
        messageId: 'fwd-2',
        payload: {},
      },
      sendSafely,
    );

    // The restricted socket SHOULD receive the event on the allowed subject.
    const sentToRestricted = sendSafely.mock.calls.filter(([client]) => client === restrictedSocket);
    expect(sentToRestricted).toHaveLength(1);
  });

  it('delivers an event to a peer whose wildcard subscription grant matches the full subject', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: ['worker.*'],
    });

    const senderSocket = new MockWebSocket();
    const subscriberSocket = new MockWebSocket();
    const sendSafely = vi.fn();
    const socketMap = new Map<MockWebSocket, string>([[subscriberSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makePerSocketAuth(socketMap);
    const registry = new ClientRegistry({
      debug: false,
      subscriptionSubjectRestrictionResolver: (client) => {
        const peerId = auth.getAuthenticatedIdentityId?.(client);
        return peerId ? resolveHmacIdentityAllowedSubscriptionSubjects(peerId) : null;
      },
    });
    registry.addClient(senderSocket);
    registry.addClient(subscriberSocket);
    const deps = makeDeps({ auth, registry, sendSafely });

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'worker.*': [100] },
        deliveryClasses: { 'worker.*': 'relayable' },
      },
      subscriberSocket,
      deps,
    );
    await routeMessage(
      {
        type: 'event',
        namespace: 'worker',
        subject: 'lifecycle.ready',
        messageId: 'wildcard-delivery',
        payload: {},
      },
      senderSocket,
      deps,
    );

    expect(sendSafely).toHaveBeenCalledWith(subscriberSocket, expect.stringContaining('"subject":"lifecycle.ready"'));
  });

  it('delivers a client-originated broadcast to an authenticated matching subscriber', async () => {
    const senderIdentity = 'broadcast-sender';
    const subscriberIdentity = 'broadcast-subscriber';
    registerHmacIdentitySecret(senderIdentity, 'broadcast-sender-secret', {
      partyKind: 'test.worker-bootstrap',
      allowedMessageSubjects: [ALLOWED_SUBJECT],
    });
    registerHmacIdentitySecret(subscriberIdentity, 'broadcast-subscriber-secret', {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: [ALLOWED_SUBJECT],
    });

    const senderSocket = new MockWebSocket();
    const subscriberSocket = new MockWebSocket();
    const sendSafely = vi.fn();
    const socketMap = new Map<MockWebSocket, string>([
      [senderSocket, senderIdentity],
      [subscriberSocket, subscriberIdentity],
    ]);
    const auth = makePerSocketAuth(socketMap);
    const registry = new ClientRegistry({
      debug: false,
      subscriptionSubjectRestrictionResolver: (client) => {
        const peerId = auth.getAuthenticatedIdentityId?.(client);
        return peerId ? resolveHmacIdentityAllowedSubscriptionSubjects(peerId) : null;
      },
    });
    registry.addClient(senderSocket);
    registry.addClient(subscriberSocket);
    const deps = makeDeps({ auth, registry, sendSafely });

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { [ALLOWED_SUBJECT]: [100] },
        deliveryClasses: { [ALLOWED_SUBJECT]: 'relayable' },
      },
      subscriberSocket,
      deps,
    );
    await routeMessage(
      {
        type: 'broadcast',
        namespace: 'worker',
        subject: 'control.bootstrap.claim',
        correlationId: 'matching-broadcast',
        messageId: 'matching-broadcast-id',
        payload: {},
      },
      senderSocket,
      deps,
    );

    expect(sendSafely).toHaveBeenCalledWith(
      subscriberSocket,
      expect.stringContaining('"messageId":"matching-broadcast-id"'),
    );
  });

  it('does not filter events for unrestricted peers', async () => {
    registerHmacIdentitySecret('unrestricted-fwd', 'unrestricted-fwd-secret', {
      partyKind: 'test.workflow-execution',
      // No directional subject grants — unrestricted
    });

    const senderSocket = new MockWebSocket();
    const unrestrictedSocket = new MockWebSocket();
    const sendSafely = vi.fn();

    const registry = new ClientRegistry({
      debug: false,
      subscriptionSubjectRestrictionResolver: () => null,
    });

    registry.addClient(senderSocket);
    registry.addClient(unrestrictedSocket);

    registry.handleSubscribeMessage(unrestrictedSocket, {
      type: 'subscribe',
      subjects: { 'worker.lifecycle.ready': [100] },
      deliveryClasses: {},
    });

    registry.forwardEventToClients(
      senderSocket,
      {
        type: 'event',
        namespace: 'worker',
        subject: 'lifecycle.ready',
        messageId: 'fwd-3',
        payload: {},
      },
      sendSafely,
    );

    // Unrestricted peer — must receive the event.
    const sentToUnrestricted = sendSafely.mock.calls.filter(([client]) => client === unrestrictedSocket);
    expect(sentToUnrestricted).toHaveLength(1);
  });

  it('excludes restricted peers from getInterestedClients for broadcast routing', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: [ALLOWED_SUBJECT],
    });

    const senderSocket = new MockWebSocket();
    const restrictedSocket = new MockWebSocket();

    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makePerSocketAuth(socketMap);

    const registry = new ClientRegistry({
      debug: false,
      subscriptionSubjectRestrictionResolver: (client) => {
        const peerId = auth.getAuthenticatedIdentityId?.(client);
        if (!peerId) return null;
        return resolveHmacIdentityAllowedSubscriptionSubjects(peerId);
      },
    });

    registry.addClient(senderSocket);
    registry.addClient(restrictedSocket);

    // Restricted peer subscribes (simulating bypass).
    registry.handleSubscribeMessage(restrictedSocket, {
      type: 'subscribe',
      subjects: { 'worker.lifecycle.ready': [100] },
      deliveryClasses: {},
    });

    const interested = registry.getInterestedClients('worker.lifecycle.ready', {}, senderSocket);

    // Restricted peer must NOT appear in interested clients for a disallowed subject.
    expect(interested).not.toContain(restrictedSocket);
  });

  it('uses live registry data, not stale snapshot, after revocation', async () => {
    const cleanup = registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      partyKind: 'test.worker-bootstrap',
      allowedSubscriptionSubjects: [ALLOWED_SUBJECT],
    });

    const senderSocket = new MockWebSocket();
    const restrictedSocket = new MockWebSocket();
    const sendSafely = vi.fn();

    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makePerSocketAuth(socketMap);

    const registry = new ClientRegistry({
      debug: false,
      subscriptionSubjectRestrictionResolver: (client) => {
        const peerId = auth.getAuthenticatedIdentityId?.(client);
        if (!peerId) return null;
        return resolveHmacIdentityAllowedSubscriptionSubjects(peerId);
      },
    });

    registry.addClient(senderSocket);
    registry.addClient(restrictedSocket);

    // Restricted peer subscribes to allowed subject.
    registry.handleSubscribeMessage(restrictedSocket, {
      type: 'subscribe',
      subjects: { [ALLOWED_SUBJECT]: [100] },
      deliveryClasses: {},
    });

    // Revoke the identity — cleanup removes the registration entirely.
    cleanup();

    // After revocation, resolveHmacIdentityAllowedSubscriptionSubjects returns null
    // (identity unknown), which means unrestricted — but the socket's auth
    // context still references the identity. The resolver returns null for
    // revoked identities, so the outbound filter should treat them as
    // unrestricted (revoked sockets get closed by per-message revalidation
    // on inbound; outbound is defense-in-depth).
    registry.forwardEventToClients(
      senderSocket,
      {
        type: 'event',
        namespace: 'worker',
        subject: 'control.bootstrap.claim',
        messageId: 'fwd-revoked',
        payload: {},
      },
      sendSafely,
    );

    // After revocation, resolver returns null => no restriction => event goes through.
    // Inbound revalidation closes the socket on next inbound message.
    const sentToRestricted = sendSafely.mock.calls.filter(([client]) => client === restrictedSocket);
    expect(sentToRestricted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Outbound required recipient filters
// ---------------------------------------------------------------------------

describe('outbound required recipient filters', () => {
  const PROTECTED_SUBJECT = 'workload.operation.deliver';

  afterEach(() => {
    clearHmacIdentitySecretsForTesting();
  });

  it('enforces an attempt filter for events without a subscription and after the last unsubscribe', () => {
    const senderSocket = new MockWebSocket();
    const attemptASocket = new MockWebSocket();
    const attemptBSocket = new MockWebSocket();
    const sendSafely = vi.fn();
    const identities = new Map<MockWebSocket, string>([
      [attemptASocket, 'attempt-a'],
      [attemptBSocket, 'attempt-b'],
    ]);
    registerHmacIdentitySecret('attempt-a', 'attempt-a-secret', {
      partyKind: 'test.job-run',
      requiredSubscriptionFilters: { [PROTECTED_SUBJECT]: { executionId: 'attempt-a' } },
    });
    registerHmacIdentitySecret('attempt-b', 'attempt-b-secret', {
      partyKind: 'test.job-run',
      requiredSubscriptionFilters: { [PROTECTED_SUBJECT]: { executionId: 'attempt-b' } },
    });
    const registry = new ClientRegistry({
      unsubscribedDelivery: 'deliver',
      requiredSubscriptionFilterResolver: (client) => {
        const identityId = identities.get(client as MockWebSocket);
        return identityId ? resolveHmacIdentityRequiredSubscriptionFilters(identityId) : null;
      },
    });
    registry.addClient(senderSocket);
    registry.addClient(attemptASocket);
    registry.addClient(attemptBSocket);

    const event = {
      type: 'event' as const,
      namespace: 'workload',
      subject: 'operation.deliver',
      messageId: 'attempt-filtered-event',
      payload: { executionId: 'attempt-a' },
    };
    registry.forwardEventToClients(senderSocket, event, sendSafely);
    expect(sendSafely).toHaveBeenCalledWith(attemptASocket, expect.any(String));
    expect(sendSafely.mock.calls.some(([client]) => client === attemptBSocket)).toBe(false);

    registry.handleSubscribeMessage(attemptBSocket, {
      type: 'subscribe',
      subjects: { [PROTECTED_SUBJECT]: [100] },
      deliveryClasses: {},
    });
    registry.handleUnsubscribeMessage(attemptBSocket, { [PROTECTED_SUBJECT]: [] });
    sendSafely.mockClear();

    registry.forwardEventToClients(senderSocket, event, sendSafely);
    expect(sendSafely).toHaveBeenCalledWith(attemptASocket, expect.any(String));
    expect(sendSafely.mock.calls.some(([client]) => client === attemptBSocket)).toBe(false);
  });

  it('applies replaced live policy without resubscribing and retains peer filters', async () => {
    const identityId = 'live-policy-identity';
    const secret = 'live-policy-secret';
    const socket = new MockWebSocket();
    const auth = makeAuth({
      getReceiveContext: () => ({
        transportName: 'websocket',
        authenticated: true,
        caller: { kind: 'test.test-peer', id: identityId },
      }),
    });
    const registry = new ClientRegistry({
      requiredSubscriptionFilterResolver: () => resolveHmacIdentityRequiredSubscriptionFilters(identityId),
    });
    registry.addClient(socket);
    registerHmacIdentitySecret(identityId, secret, {
      partyKind: 'test.job-run',
      requiredSubscriptionFilters: { [PROTECTED_SUBJECT]: { executionId: 'attempt-a' } },
    });
    await routeMessage(
      {
        type: 'subscribe',
        subjects: { [PROTECTED_SUBJECT]: [100] },
        deliveryClasses: {},
        filters: { [PROTECTED_SUBJECT]: { kind: 'expected' } },
      },
      socket,
      makeDeps({ auth, registry }),
    );
    const payload = { executionId: 'attempt-b', kind: 'expected' };
    expect(registry.getInterestedClients(PROTECTED_SUBJECT, payload)).toEqual([]);
    registerHmacIdentitySecret(identityId, secret, {
      partyKind: 'test.job-run',
      requiredSubscriptionFilters: {
        [PROTECTED_SUBJECT]: { executionId: { $in: ['attempt-a', 'attempt-b'] } },
      },
    });
    expect(registry.getInterestedClients(PROTECTED_SUBJECT, payload)).toEqual([socket]);
    expect(registry.getInterestedRequestClients(PROTECTED_SUBJECT, payload)).toEqual([socket]);
    expect(registry.getInterestedClients(PROTECTED_SUBJECT, { ...payload, kind: 'unwanted' })).toEqual([]);
    registerHmacIdentitySecret(identityId, secret, {
      partyKind: 'test.job-run',
      requiredSubscriptionFilters: { [PROTECTED_SUBJECT]: { executionId: 'attempt-c' } },
    });
    expect(registry.getInterestedClients(PROTECTED_SUBJECT, payload)).toEqual([]);
    expect(registry.getInterestedRequestClients(PROTECTED_SUBJECT, payload)).toEqual([]);
  });

  it('enforces an attempt filter for client-originated broadcasts without subscriptions', async () => {
    const senderSocket = new MockWebSocket();
    const attemptASocket = new MockWebSocket();
    const attemptBSocket = new MockWebSocket();
    const sendSafely = vi.fn();
    const identities = new Map<MockWebSocket, string>([
      [senderSocket, 'authority'],
      [attemptASocket, 'attempt-a'],
      [attemptBSocket, 'attempt-b'],
    ]);
    registerHmacIdentitySecret('authority', 'authority-secret', {
      partyKind: 'test.workflow-authority',
      allowedMessageSubjects: [PROTECTED_SUBJECT],
    });
    registerHmacIdentitySecret('attempt-a', 'attempt-a-secret', {
      partyKind: 'test.job-run',
      requiredSubscriptionFilters: { [PROTECTED_SUBJECT]: { executionId: 'attempt-a' } },
    });
    registerHmacIdentitySecret('attempt-b', 'attempt-b-secret', {
      partyKind: 'test.job-run',
      requiredSubscriptionFilters: { [PROTECTED_SUBJECT]: { executionId: 'attempt-b' } },
    });
    const auth = makePerSocketAuth(identities, 'test.test-peer');
    const registry = new ClientRegistry({
      unsubscribedDelivery: 'deliver',
      requiredSubscriptionFilterResolver: (client) => {
        const identityId = identities.get(client as MockWebSocket);
        return identityId ? resolveHmacIdentityRequiredSubscriptionFilters(identityId) : null;
      },
    });
    registry.addClient(senderSocket);
    registry.addClient(attemptASocket);
    registry.addClient(attemptBSocket);

    await routeMessage(
      {
        type: 'broadcast',
        namespace: 'workload',
        subject: 'operation.deliver',
        correlationId: 'attempt-filtered-broadcast',
        messageId: 'attempt-filtered-broadcast-id',
        payload: { executionId: 'attempt-a' },
      },
      senderSocket,
      makeDeps({ auth, registry, sendSafely }),
    );

    expect(sendSafely).toHaveBeenCalledWith(
      attemptASocket,
      expect.stringContaining('"messageId":"attempt-filtered-broadcast-id"'),
    );
    expect(sendSafely.mock.calls.some(([client]) => client === attemptBSocket)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Outbound auth re-check: socketAuthChecker on outbound routing
// ---------------------------------------------------------------------------

describe('outbound socketAuthChecker on forwarding', () => {
  afterEach(() => {
    clearHmacIdentitySecretsForTesting();
  });

  it('excludes and closes sockets whose auth has expired on outbound delivery', () => {
    const senderSocket = new MockWebSocket();
    const expiredSocket = new MockWebSocket();
    const sendSafely = vi.fn();
    const closeSpy = vi.spyOn(expiredSocket, 'close');

    // Auth checker: expiredSocket is no longer authenticated.
    const registry = new ClientRegistry({
      debug: false,
      socketAuthChecker: (client) => client !== expiredSocket,
    });

    registry.addClient(senderSocket);
    registry.addClient(expiredSocket);

    // Expired peer subscribes to a subject.
    registry.handleSubscribeMessage(expiredSocket, {
      type: 'subscribe',
      subjects: { 'test.subject': [100] },
      deliveryClasses: {},
    });

    // Sender emits an event on that subject.
    registry.forwardEventToClients(
      senderSocket,
      {
        type: 'event',
        namespace: 'test',
        subject: 'subject',
        messageId: 'auth-check-1',
        payload: {},
      },
      sendSafely,
    );

    // The expired socket must NOT receive the event.
    const sentToExpired = sendSafely.mock.calls.filter(([client]) => client === expiredSocket);
    expect(sentToExpired).toHaveLength(0);

    // The expired socket should have been closed.
    expect(closeSpy).toHaveBeenCalledWith(1008, 'Authentication expired');
  });

  it('does not close sockets that are still authenticated', () => {
    const senderSocket = new MockWebSocket();
    const validSocket = new MockWebSocket();
    const sendSafely = vi.fn();
    const closeSpy = vi.spyOn(validSocket, 'close');

    const registry = new ClientRegistry({
      debug: false,
      socketAuthChecker: () => true,
    });

    registry.addClient(senderSocket);
    registry.addClient(validSocket);

    registry.handleSubscribeMessage(validSocket, {
      type: 'subscribe',
      subjects: { 'test.subject': [100] },
      deliveryClasses: {},
    });

    registry.forwardEventToClients(
      senderSocket,
      {
        type: 'event',
        namespace: 'test',
        subject: 'subject',
        messageId: 'auth-check-2',
        payload: {},
      },
      sendSafely,
    );

    // The valid socket must receive the event.
    const sentToValid = sendSafely.mock.calls.filter(([client]) => client === validSocket);
    expect(sentToValid).toHaveLength(1);

    // The valid socket must NOT be closed.
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('excludes expired sockets from interested request targets', () => {
    const expiredSocket = new MockWebSocket();
    const registry = new ClientRegistry({
      debug: false,
      socketAuthChecker: () => false,
    });

    registry.addClient(expiredSocket);
    registry.handleSubscribeMessage(expiredSocket, {
      type: 'subscribe',
      subjects: { 'test.subject': [100] },
      deliveryClasses: {},
    });

    expect(registry.getInterestedRequestClients('test.subject', {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Inbound request response-route lifetime
// ---------------------------------------------------------------------------

describe('inbound request response-route lifetime', () => {
  function makeRequest(correlationId: string, timeout: number, deadline?: number): BusRequestMessage {
    return {
      type: 'request',
      namespace: 'test',
      subject: 'subject',
      payload: {},
      correlationId,
      messageId: `${correlationId}-message`,
      timeout,
      deadline,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retains a response route until its propagated deadline, beyond sixty seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const registry = new ClientRegistry();
    const requester = new MockWebSocket();
    registry.addClient(requester);

    registry.trackRequestOrigin(requester, makeRequest('long-lived', 120_000, Date.now() + 120_000));
    vi.advanceTimersByTime(60_001);

    expect(registry.takeResponseOrigin('long-lived')?.socket).toBe(requester);
  });

  it('expires a response route when its propagated deadline elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const registry = new ClientRegistry();
    const requester = new MockWebSocket();
    registry.addClient(requester);

    registry.trackRequestOrigin(requester, makeRequest('deadline-expired', 50, Date.now() + 50));
    vi.advanceTimersByTime(50);

    expect(registry.takeResponseOrigin('deadline-expired')).toBeUndefined();
  });

  it('keeps no-timeout request response routes until they are consumed', () => {
    vi.useFakeTimers();
    const registry = new ClientRegistry();
    const requester = new MockWebSocket();
    registry.addClient(requester);

    registry.trackRequestOrigin(requester, makeRequest('no-timeout', 0));
    vi.advanceTimersByTime(86_400_000);

    expect(registry.takeResponseOrigin('no-timeout')?.socket).toBe(requester);
  });

  it('gives a request with an invalid wire timeout the default response-route lifetime', () => {
    // Only `0` means "no timeout": the bus dispatches such a request with the
    // default budget, so its response route must not outlive that budget.
    vi.useFakeTimers();
    const registry = new ClientRegistry();
    const requester = new MockWebSocket();
    registry.addClient(requester);

    registry.trackRequestOrigin(requester, makeRequest('invalid-timeout', -1));
    vi.advanceTimersByTime(DEFAULT_REQUEST_TIMEOUT_MS);

    expect(registry.takeResponseOrigin('invalid-timeout')).toBeUndefined();
  });

  it('tracks the response route when the sender minted a deadline already in the past', () => {
    // A client whose clock trails the server by more than the timeout sends a wire
    // deadline that is already past here, while `timeout` still carries the real
    // remaining budget. Comparing that instant against our clock would drop the route
    // and strand the response with no socket to return to.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const registry = new ClientRegistry();
    const requester = new MockWebSocket();
    registry.addClient(requester);

    registry.trackRequestOrigin(requester, makeRequest('skewed-sender', 30_000, Date.now() - 120_000));
    vi.advanceTimersByTime(29_000);

    expect(registry.takeResponseOrigin('skewed-sender')?.socket).toBe(requester);
  });

  it('expires that route on its own relative budget rather than the sender instant', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const registry = new ClientRegistry();
    const requester = new MockWebSocket();
    registry.addClient(requester);

    registry.trackRequestOrigin(requester, makeRequest('skewed-expiry', 50, Date.now() - 120_000));
    vi.advanceTimersByTime(50);

    expect(registry.takeResponseOrigin('skewed-expiry')).toBeUndefined();
  });

  it('removes a cancelled request response route', () => {
    const registry = new ClientRegistry();
    const requester = new MockWebSocket();
    registry.addClient(requester);

    registry.trackRequestOrigin(requester, makeRequest('cancelled', 0));
    registry.cancelRequestOrigin('cancelled');

    expect(registry.takeResponseOrigin('cancelled')).toBeUndefined();
  });
});

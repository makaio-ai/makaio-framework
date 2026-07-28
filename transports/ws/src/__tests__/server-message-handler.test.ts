import { CorrelationTracker, type BusReceiveHandler, type BusRequestMessage } from '@makaio/bus-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BroadcastAggregator } from '../broadcast-aggregator.js';
import { ClientRegistry } from '../client-registry.js';
import { createInboundMessageHandler, routeMessage, type MessageHandlerDeps } from '../server-message-handler.js';
import {
  clearHmacIdentitySecretsForTesting,
  registerHmacIdentitySecret,
  resolveHmacIdentityAllowedSubjects,
  rotateHmacIdentitySecret,
} from '../auth/identity-secret-registry.js';
import type { TransportAuth } from '../types.js';
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

describe('createInboundMessageHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it('does not acknowledge subscribe messages when a handler fails', async () => {
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

    expect(sendSafely).not.toHaveBeenCalledWith(
      socket,
      JSON.stringify({ type: 'subscription-ack', ackId: 'subscribe-failed' }),
    );
  });

  it('does not acknowledge unsubscribe messages when a handler fails', async () => {
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

    expect(sendSafely).not.toHaveBeenCalledWith(
      socket,
      JSON.stringify({ type: 'subscription-ack', ackId: 'unsubscribe-failed' }),
    );
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
  const ALLOWED_SUBJECT = 'worker-node.control.bootstrap.claim';
  const BOOTSTRAP_IDENTITY = 'bootstrap-test-id';
  const BOOTSTRAP_SECRET = 'bootstrap-test-secret';

  afterEach(() => {
    clearHmacIdentitySecretsForTesting();
  });

  /**
   * Create an auth stub that returns a peer context referencing a registered
   * identity, simulating a socket authenticated via the identity registry.
   * @param identityId - Identity ID for the authenticated peer.
   * @param peerKind - Peer kind string.
   * @returns TransportAuth stub with getReceiveContext wired.
   */
  function makeRestrictedAuth(identityId: string, peerKind: string): TransportAuth {
    return makeAuth({
      getReceiveContext: () => ({
        transportName: 'websocket',
        peer: {
          kind: peerKind,
          id: identityId,
          authenticated: true,
        },
      }),
    });
  }

  it('allows a request to the permitted subject', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      peerKind: 'worker-bootstrap',
      allowedSubjects: [ALLOWED_SUBJECT],
    });

    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const sendSafely = vi.fn();
    const auth = makeRestrictedAuth(BOOTSTRAP_IDENTITY, 'worker-bootstrap');

    await routeMessage(
      {
        type: 'request',
        namespace: 'worker-node',
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

  it('rejects a request to a disallowed subject with an error response', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      peerKind: 'worker-bootstrap',
      allowedSubjects: [ALLOWED_SUBJECT],
    });

    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const sendSafely = vi.fn();
    const auth = makeRestrictedAuth(BOOTSTRAP_IDENTITY, 'worker-bootstrap');

    await routeMessage(
      {
        type: 'request',
        namespace: 'worker-node',
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
      peerKind: 'worker-bootstrap',
      allowedSubjects: [ALLOWED_SUBJECT],
    });

    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const sendSafely = vi.fn();
    const auth = makeRestrictedAuth(BOOTSTRAP_IDENTITY, 'worker-bootstrap');

    await routeMessage(
      {
        type: 'event',
        namespace: 'worker-node',
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
      peerKind: 'worker-bootstrap',
      allowedSubjects: [ALLOWED_SUBJECT],
    });

    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const sendSafely = vi.fn();
    const auth = makeRestrictedAuth(BOOTSTRAP_IDENTITY, 'worker-bootstrap');

    await routeMessage(
      {
        type: 'broadcast',
        namespace: 'worker-node',
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

  it('does not restrict identities without allowedSubjects', async () => {
    registerHmacIdentitySecret('unrestricted-peer', 'unrestricted-secret', {
      peerKind: 'workflow-execution',
    });

    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const auth = makeRestrictedAuth('unrestricted-peer', 'workflow-execution');

    await routeMessage(
      {
        type: 'request',
        namespace: 'worker-node',
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
        namespace: 'worker-node',
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
  const ALLOWED_SUBJECT = 'worker-node.control.bootstrap.claim';
  const BOOTSTRAP_IDENTITY = 'bootstrap-sub-test';
  const BOOTSTRAP_SECRET = 'bootstrap-sub-secret';

  afterEach(() => {
    clearHmacIdentitySecretsForTesting();
  });

  /**
   * Create an auth stub with per-socket identity mapping.
   * @param socketIdentityMap - Map from socket to identity ID
   * @returns TransportAuth stub
   */
  function makePerSocketAuth(socketIdentityMap: Map<MockWebSocket, string>): TransportAuth {
    return makeAuth({
      getReceiveContext: (socket) => {
        const identityId = socketIdentityMap.get(socket as MockWebSocket);
        if (!identityId) return undefined;
        return {
          transportName: 'websocket',
          peer: {
            kind: 'worker-bootstrap',
            id: identityId,
            authenticated: true,
          },
        };
      },
    });
  }

  it('filters disallowed subjects from a subscribe message', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      peerKind: 'worker-bootstrap',
      allowedSubjects: [ALLOWED_SUBJECT],
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
          'worker-node.lifecycle.ready': [100],
        },
        deliveryClasses: {
          [ALLOWED_SUBJECT]: 'relayable',
          'worker-node.lifecycle.ready': 'relayable',
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
        expect(msg.subjects).not.toHaveProperty('worker-node.lifecycle.ready');
      }
    }
  });

  it('drops subscribe message entirely when all subjects are disallowed', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      peerKind: 'worker-bootstrap',
      allowedSubjects: [ALLOWED_SUBJECT],
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
          'worker-node.lifecycle.ready': [100],
          'worker-node.control.outcome.submit': [100],
        },
        deliveryClasses: {},
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );

    // No subscribe handler invocation — the message was dropped entirely.
    expect(handler).not.toHaveBeenCalled();
  });

  it('filters disallowed subjects from an unsubscribe message', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      peerKind: 'worker-bootstrap',
      allowedSubjects: [ALLOWED_SUBJECT],
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
          'worker-node.lifecycle.ready': [100],
        },
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );

    // Only the allowed subject should be processed; disallowed subject stripped.
    const unsubCalls = handler.mock.calls.filter(([msg]) => msg.type === 'unsubscribe');
    for (const [msg] of unsubCalls) {
      if (msg.type === 'unsubscribe') {
        expect(msg.subjects).not.toHaveProperty('worker-node.lifecycle.ready');
      }
    }
  });

  it('rejects wildcard subscription from a restricted identity', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      peerKind: 'worker-bootstrap',
      allowedSubjects: [ALLOWED_SUBJECT],
    });

    const restrictedSocket = new MockWebSocket();
    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makePerSocketAuth(socketMap);
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const registry = new ClientRegistry();

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'worker-node.*': [100] },
        deliveryClasses: {},
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );

    // Wildcard not in allowedSubjects verbatim — must be rejected.
    expect(handler).not.toHaveBeenCalled();
  });

  it('allows wildcard subscription when it appears verbatim in allowedSubjects', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      peerKind: 'worker-bootstrap',
      allowedSubjects: ['worker-node.*'],
    });

    const restrictedSocket = new MockWebSocket();
    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makePerSocketAuth(socketMap);
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const registry = new ClientRegistry();

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'worker-node.*': [100] },
        deliveryClasses: {},
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );

    // Wildcard IS in allowedSubjects verbatim — must be accepted.
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'subscribe',
        subjects: expect.objectContaining({ 'worker-node.*': expect.any(Array) }),
      }),
      expect.anything(),
    );
  });

  it('does not restrict subscribe messages from unrestricted identities', async () => {
    registerHmacIdentitySecret('unrestricted-sub', 'unrestricted-sub-secret', {
      peerKind: 'workflow-execution',
      // No allowedSubjects — unrestricted
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
          'worker-node.*': [100],
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
      expect(lastSubMsg.subjects).toHaveProperty('worker-node.*');
      expect(lastSubMsg.subjects).toHaveProperty('adapter.*');
    }
  });

  it('preserves restriction after secret rotation', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      peerKind: 'worker-bootstrap',
      allowedSubjects: [ALLOWED_SUBJECT],
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
          'worker-node.lifecycle.ready': [100],
        },
        deliveryClasses: {},
      },
      restrictedSocket,
      makeDeps({ auth, handlers: new Set([handler]), registry }),
    );

    // After rotation, allowedSubjects must still be enforced.
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Outbound defense-in-depth: event/broadcast forwarding subject restriction
// ---------------------------------------------------------------------------

describe('outbound subject restriction on forwarding', () => {
  const ALLOWED_SUBJECT = 'worker-node.control.bootstrap.claim';
  const BOOTSTRAP_IDENTITY = 'bootstrap-fwd-test';
  const BOOTSTRAP_SECRET = 'bootstrap-fwd-secret';

  afterEach(() => {
    clearHmacIdentitySecretsForTesting();
  });

  it('does not forward events to a restricted peer on a disallowed subject', async () => {
    registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      peerKind: 'worker-bootstrap',
      allowedSubjects: [ALLOWED_SUBJECT],
    });

    const senderSocket = new MockWebSocket();
    const restrictedSocket = new MockWebSocket();
    const sendSafely = vi.fn();

    // Build per-socket auth that returns correct identity for each socket.
    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makeAuth({
      getReceiveContext: (socket) => {
        const id = socketMap.get(socket as MockWebSocket);
        if (!id) return undefined;
        return {
          transportName: 'websocket',
          peer: { kind: 'worker-bootstrap', id, authenticated: true },
        };
      },
    });

    const registry = new ClientRegistry({
      debug: false,
      subjectRestrictionResolver: (client) => {
        const ctx = auth.getReceiveContext?.(client);
        const peerId = ctx?.peer?.id;
        if (!peerId) return null;
        return resolveHmacIdentityAllowedSubjects(peerId);
      },
    });

    registry.addClient(senderSocket);
    registry.addClient(restrictedSocket);

    // Restricted peer subscribes to the disallowed subject (simulating a bypass
    // that the inbound layer should have caught — defense-in-depth).
    registry.handleSubscribeMessage(restrictedSocket, {
      type: 'subscribe',
      subjects: { 'worker-node.lifecycle.ready': [100] },
      deliveryClasses: {},
    });

    // Sender emits an event on the disallowed subject.
    registry.forwardEventToClients(
      senderSocket,
      {
        type: 'event',
        namespace: 'worker-node',
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
      peerKind: 'worker-bootstrap',
      allowedSubjects: [ALLOWED_SUBJECT],
    });

    const senderSocket = new MockWebSocket();
    const restrictedSocket = new MockWebSocket();
    const sendSafely = vi.fn();

    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makeAuth({
      getReceiveContext: (socket) => {
        const id = socketMap.get(socket as MockWebSocket);
        if (!id) return undefined;
        return {
          transportName: 'websocket',
          peer: { kind: 'worker-bootstrap', id, authenticated: true },
        };
      },
    });

    const registry = new ClientRegistry({
      debug: false,
      subjectRestrictionResolver: (client) => {
        const ctx = auth.getReceiveContext?.(client);
        const peerId = ctx?.peer?.id;
        if (!peerId) return null;
        return resolveHmacIdentityAllowedSubjects(peerId);
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
        namespace: 'worker-node',
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

  it('does not filter events for unrestricted peers', async () => {
    registerHmacIdentitySecret('unrestricted-fwd', 'unrestricted-fwd-secret', {
      peerKind: 'workflow-execution',
      // No allowedSubjects — unrestricted
    });

    const senderSocket = new MockWebSocket();
    const unrestrictedSocket = new MockWebSocket();
    const sendSafely = vi.fn();

    const registry = new ClientRegistry({
      debug: false,
      subjectRestrictionResolver: () => null,
    });

    registry.addClient(senderSocket);
    registry.addClient(unrestrictedSocket);

    registry.handleSubscribeMessage(unrestrictedSocket, {
      type: 'subscribe',
      subjects: { 'worker-node.lifecycle.ready': [100] },
      deliveryClasses: {},
    });

    registry.forwardEventToClients(
      senderSocket,
      {
        type: 'event',
        namespace: 'worker-node',
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
      peerKind: 'worker-bootstrap',
      allowedSubjects: [ALLOWED_SUBJECT],
    });

    const senderSocket = new MockWebSocket();
    const restrictedSocket = new MockWebSocket();

    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makeAuth({
      getReceiveContext: (socket) => {
        const id = socketMap.get(socket as MockWebSocket);
        if (!id) return undefined;
        return {
          transportName: 'websocket',
          peer: { kind: 'worker-bootstrap', id, authenticated: true },
        };
      },
    });

    const registry = new ClientRegistry({
      debug: false,
      subjectRestrictionResolver: (client) => {
        const ctx = auth.getReceiveContext?.(client);
        const peerId = ctx?.peer?.id;
        if (!peerId) return null;
        return resolveHmacIdentityAllowedSubjects(peerId);
      },
    });

    registry.addClient(senderSocket);
    registry.addClient(restrictedSocket);

    // Restricted peer subscribes (simulating bypass).
    registry.handleSubscribeMessage(restrictedSocket, {
      type: 'subscribe',
      subjects: { 'worker-node.lifecycle.ready': [100] },
      deliveryClasses: {},
    });

    const interested = registry.getInterestedClients('worker-node.lifecycle.ready', {}, senderSocket);

    // Restricted peer must NOT appear in interested clients for a disallowed subject.
    expect(interested).not.toContain(restrictedSocket);
  });

  it('uses live registry data, not stale snapshot, after revocation', async () => {
    const cleanup = registerHmacIdentitySecret(BOOTSTRAP_IDENTITY, BOOTSTRAP_SECRET, {
      peerKind: 'worker-bootstrap',
      allowedSubjects: [ALLOWED_SUBJECT],
    });

    const senderSocket = new MockWebSocket();
    const restrictedSocket = new MockWebSocket();
    const sendSafely = vi.fn();

    const socketMap = new Map<MockWebSocket, string>([[restrictedSocket, BOOTSTRAP_IDENTITY]]);
    const auth = makeAuth({
      getReceiveContext: (socket) => {
        const id = socketMap.get(socket as MockWebSocket);
        if (!id) return undefined;
        return {
          transportName: 'websocket',
          peer: { kind: 'worker-bootstrap', id, authenticated: true },
        };
      },
    });

    const registry = new ClientRegistry({
      debug: false,
      subjectRestrictionResolver: (client) => {
        const ctx = auth.getReceiveContext?.(client);
        const peerId = ctx?.peer?.id;
        if (!peerId) return null;
        return resolveHmacIdentityAllowedSubjects(peerId);
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

    // After revocation, resolveHmacIdentityAllowedSubjects returns null
    // (identity unknown), which means unrestricted — but the socket's auth
    // context still references the identity. The resolver returns null for
    // revoked identities, so the outbound filter should treat them as
    // unrestricted (revoked sockets get closed by per-message revalidation
    // on inbound; outbound is defense-in-depth).
    registry.forwardEventToClients(
      senderSocket,
      {
        type: 'event',
        namespace: 'worker-node',
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

  it('keeps request eligibility separate from subscription priority', () => {
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

    const priority = registry.getRequestRoutingPriority(expiredSocket, 'test.subject', {});
    expect(priority).toBe(2);
    expect(registry.getEligibleRequestClients('test.subject')).toEqual([]);
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

    expect(registry.consumeResponseClient('long-lived')).toBe(requester);
  });

  it('expires a response route when its propagated deadline elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const registry = new ClientRegistry();
    const requester = new MockWebSocket();
    registry.addClient(requester);

    registry.trackRequestOrigin(requester, makeRequest('deadline-expired', 50, Date.now() + 50));
    vi.advanceTimersByTime(50);

    expect(registry.consumeResponseClient('deadline-expired')).toBeUndefined();
  });

  it('keeps no-timeout request response routes until they are consumed', () => {
    vi.useFakeTimers();
    const registry = new ClientRegistry();
    const requester = new MockWebSocket();
    registry.addClient(requester);

    registry.trackRequestOrigin(requester, makeRequest('no-timeout', 0));
    vi.advanceTimersByTime(86_400_000);

    expect(registry.consumeResponseClient('no-timeout')).toBe(requester);
  });

  it('removes a cancelled request response route', () => {
    const registry = new ClientRegistry();
    const requester = new MockWebSocket();
    registry.addClient(requester);

    registry.trackRequestOrigin(requester, makeRequest('cancelled', 0));
    registry.cancelRequestOrigin('cancelled');

    expect(registry.consumeResponseClient('cancelled')).toBeUndefined();
  });
});

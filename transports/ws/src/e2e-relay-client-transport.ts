/**
 * E2E encrypted relay client transport wrapper.
 *
 * Wraps WebSocketClientTransport to encrypt outgoing messages and decrypt
 * incoming messages using the session key established by E2ERelayAuth.
 */

import type { WebSocketLike, ClientTransportCodec } from './types.js';
import { WebSocketClientTransport, type WebSocketClientTransportOptions } from './ws-client-transport.js';
import type {
  BusMessage,
  BusResponseMessage,
  BusSubscribeMessage,
  BusSubscriptionAckMessage,
  BusUnsubscribeMessage,
  BusTransport,
} from '@makaio/bus-core';
import type { E2ERelayAuth } from './auth/e2e-relay-auth.js';
import { decryptRelayEnvelope, encryptRelayEnvelope, isRelayEnvelopeMessage } from './e2e-relay-envelope.js';
import { createRelayControlHelpers } from './relay-control-envelope.js';
import type { RelayControlRegistry } from './relay-control-registry.js';

/**
 * E2E relay client transport configuration.
 *
 * Provide a pre-created `websocket` to wrap a caller-owned socket. All other
 * options are forwarded to `WebSocketClientTransport` (excluding `auth`,
 * `messageTransform`, `url`, `codec`, `createWebSocket`, and `autoReconnect`,
 * which are managed internally by this factory).
 */
export interface E2ERelayClientTransportOptions
  extends Omit<
    WebSocketClientTransportOptions,
    'auth' | 'messageTransform' | 'url' | 'createWebSocket' | 'codec' | 'autoReconnect'
  > {
  /**
   * Pre-created WebSocket instance to wrap.
   *
   * The factory treats this socket as caller-owned and disables
   * auto-reconnect. When reconnect is needed, the caller is responsible for
   * creating new sockets.
   */
  websocket: WebSocketLike;
  /**
   * Relay-mode E2E auth instance.
   */
  e2eAuth: E2ERelayAuth;
  /**
   * Frozen relay control registry that classifies plaintext control subjects.
   *
   * Must be frozen before the transport begins connecting. Determines which
   * namespace/subject pairs are routed as relay-control envelopes rather than
   * E2E encrypted messages.
   */
  registry: RelayControlRegistry;
}

const RELAY_CONTROL_RESPONSE_TTL_MS = 5 * 60 * 1000;
const RELAY_CONTROL_RESPONSE_MAX_ENTRIES = 2048;

/**
 * Evict expired and overflow entries from the relay-control response ID map.
 * @param ids - Mutable map of correlation IDs to creation timestamps
 */
function pruneRelayControlIds(ids: Map<string, number>): void {
  const cutoff = Date.now() - RELAY_CONTROL_RESPONSE_TTL_MS;
  for (const [id, createdAt] of ids) {
    if (createdAt >= cutoff) continue;
    ids.delete(id);
  }
  while (ids.size > RELAY_CONTROL_RESPONSE_MAX_ENTRIES) {
    const oldest = ids.keys().next().value as string | undefined;
    if (!oldest) break;
    ids.delete(oldest);
  }
}

/**
 * Check whether a message is a plaintext response.
 * @param message - Candidate message
 * @returns True when message is a plaintext response
 */
const isPlainResponse = (message: unknown): message is BusResponseMessage => {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const candidate = message as { type?: unknown; correlationId?: unknown };
  return candidate.type === 'response' && typeof candidate.correlationId === 'string';
};

/**
 * Check whether a message is a subscribe/unsubscribe frame.
 * @param message - Candidate bus message
 * @returns True when message is a subscription control frame
 */
const isSubscriptionControlMessage = (message: BusMessage): message is BusSubscribeMessage | BusUnsubscribeMessage =>
  message.type === 'subscribe' || message.type === 'unsubscribe';

/**
 * Check whether a message is a subscription acknowledgement frame.
 * @param message - Candidate message
 * @returns True when the message acknowledges a subscribe/unsubscribe frame
 */
const isSubscriptionAckMessage = (message: unknown): message is BusSubscriptionAckMessage => {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { type?: unknown; ackId?: unknown };
  return candidate.type === 'subscription-ack' && typeof candidate.ackId === 'string';
};

/**
 * Create the codec used by relay E2E transport.
 * @param e2eAuth - Relay E2E auth instance
 * @param debug - Enable diagnostic logging
 * @param relayControlResponseIds - Correlation ids that should remain plaintext
 * @param registry - Frozen relay control registry for subject classification
 * @returns Transport codec
 */
function createRelayCodec(
  e2eAuth: E2ERelayAuth,
  debug: boolean,
  relayControlResponseIds: Map<string, number>,
  registry: RelayControlRegistry,
): ClientTransportCodec {
  if (!registry.isFrozen()) {
    throw new Error('E2ERelay transport requires a frozen relay control registry');
  }

  const { createRelayControlEnvelope, isRelayControlEnvelopeMessage, isRelayControlBusMessage } =
    createRelayControlHelpers(registry);

  const trackRelayControlResponseId = (id: string): void => {
    relayControlResponseIds.delete(id);
    relayControlResponseIds.set(id, Date.now());
    pruneRelayControlIds(relayControlResponseIds);
  };

  return {
    encode: async (message: BusMessage): Promise<string> => {
      if (isRelayControlBusMessage(message)) {
        if (message.type === 'request') {
          trackRelayControlResponseId(message.correlationId);
        }
        return JSON.stringify(createRelayControlEnvelope(message));
      }
      pruneRelayControlIds(relayControlResponseIds);
      if (message.type === 'response' && relayControlResponseIds.has(message.correlationId)) {
        relayControlResponseIds.delete(message.correlationId);
        return JSON.stringify(message);
      }
      const sessionKey = e2eAuth.getSessionKey();
      if (!sessionKey && isSubscriptionControlMessage(message)) {
        // Allow transport subscription sync before peer E2E session exists.
        return JSON.stringify(message);
      }
      if (!sessionKey && isSubscriptionAckMessage(message)) {
        return JSON.stringify(message);
      }
      if (!sessionKey) {
        throw new Error('E2E relay session not established');
      }
      const envelope = await encryptRelayEnvelope(message, sessionKey);
      return JSON.stringify(envelope);
    },
    decode: async (message: unknown): Promise<BusMessage> => {
      const sessionKey = e2eAuth.getSessionKey();
      if (isRelayControlEnvelopeMessage(message)) {
        const payload = message.payload;
        if (debug) {
          console.info(
            '[E2ERelayTransport] Decoded relay control envelope:',
            payload.type,
            payload.namespace,
            payload.subject,
          );
        }
        if (payload.type === 'request') {
          trackRelayControlResponseId(payload.correlationId);
        }
        return payload;
      }
      pruneRelayControlIds(relayControlResponseIds);
      if (isPlainResponse(message) && relayControlResponseIds.has(message.correlationId)) {
        relayControlResponseIds.delete(message.correlationId);
        return message;
      }
      if (!sessionKey && isSubscriptionAckMessage(message)) {
        return message;
      }
      if (!sessionKey) {
        throw new Error('E2E relay session not established');
      }
      if (!isRelayEnvelopeMessage(message)) {
        throw new Error('Received plaintext message on relay E2E channel — possible injection');
      }
      return decryptRelayEnvelope(message, sessionKey);
    },
  };
}

/**
 * Return value of {@link createE2ERelayCodec}.
 *
 * The `reset` method clears all tracked relay-control correlation IDs so that
 * stale IDs from a previous WebSocket session do not bleed into the next E2E
 * session when the codec is reused across reconnections.
 */
export interface E2ERelayCodecHandle {
  /** Wire codec for E2E relay encryption. */
  codec: ClientTransportCodec;
  /**
   * Clear all relay-control correlation IDs.
   *
   * Must be called at the start of each new connection attempt when the same
   * codec instance is reused across {@link WebSocketClientTransport}
   * reconnections (e.g. inside `authenticateClient`).
   */
  reset: () => void;
}

/**
 * Create the wire codec for an E2E encrypted relay transport.
 *
 * The codec handles message encryption/decryption and relay-control envelope
 * routing. Use this when constructing a `WebSocketClientTransport` with E2E
 * relay encryption instead of the lower-level `createE2ERelayClientTransport`.
 *
 * The returned `reset()` method **must** be called at the start of each new
 * connection attempt when the codec is reused across reconnections. Failing to
 * reset allows relay-control correlation IDs from a previous session to
 * influence routing decisions in the new E2E session.
 * @param e2eAuth - Relay-mode E2E auth instance
 * @param registry - Frozen relay control registry for subject classification
 * @param debug - Enable diagnostic logging
 * @returns Codec handle containing the wire codec and a session-reset function
 */
export function createE2ERelayCodec(
  e2eAuth: E2ERelayAuth,
  registry: RelayControlRegistry,
  debug = false,
): E2ERelayCodecHandle {
  const relayControlResponseIds = new Map<string, number>();
  return {
    codec: createRelayCodec(e2eAuth, debug, relayControlResponseIds, registry),
    reset: () => relayControlResponseIds.clear(),
  };
}

/**
 * Create an E2E encrypted relay client transport.
 * @param options - Transport configuration
 * @returns BusTransport with relay-mode E2E encryption
 */
export function createE2ERelayClientTransport(options: E2ERelayClientTransportOptions): BusTransport {
  const { e2eAuth, registry, websocket: ws, ...rest } = options;
  const debug = options.debug ?? false;

  const relayControlResponseIds = new Map<string, number>();
  const relayCodec = createRelayCodec(e2eAuth, debug, relayControlResponseIds, registry);

  if (debug) {
    console.info('[E2ERelayTransport] Creating inner transport...');
  }
  // The pre-created socket is injected via createWebSocket so the transport
  // does not attempt to dial a URL. Auto-reconnect is disabled because this
  // factory is responsible for a single caller-owned socket.
  const innerTransport = new WebSocketClientTransport({
    ...rest,
    url: '<pre-connected>',
    createWebSocket: () => ws,
    auth: e2eAuth,
    codec: relayCodec,
    autoReconnect: false,
  });
  if (debug) {
    console.info('[E2ERelayTransport] Inner transport created');
  }

  return {
    name: innerTransport.name,
    connect: async () => {
      if (!registry.isFrozen()) {
        throw new Error('E2ERelayClientTransport: registry must be frozen before connect()');
      }
      relayControlResponseIds.clear();
      try {
        await innerTransport.connect();
      } catch (error) {
        relayControlResponseIds.clear();
        throw error;
      }
    },
    disconnect: async () => {
      relayControlResponseIds.clear();
      try {
        await innerTransport.disconnect();
      } finally {
        relayControlResponseIds.clear();
      }
    },
    send: innerTransport.send.bind(innerTransport),
    cancelRequest: innerTransport.cancelRequest.bind(innerTransport),
    onReceive: (...args: Parameters<typeof innerTransport.onReceive>) => {
      if (debug) {
        console.info('[E2ERelayTransport] onReceive called, delegating to inner transport');
      }
      return innerTransport.onReceive(...args);
    },
    subscribe: innerTransport.subscribe.bind(innerTransport),
    unsubscribe: innerTransport.unsubscribe.bind(innerTransport),
    getSubscriptions: innerTransport.getSubscriptions.bind(innerTransport),
    isReady: () => Boolean(e2eAuth.getSessionKey()) && innerTransport.isReady(),
  };
}

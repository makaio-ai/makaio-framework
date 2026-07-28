/**
 * \@makaio/bus-transport-websocket
 *
 * WebSocket transport for \@makaio/bus-core enabling cross-process
 * communication via WebSocket protocol.
 *
 * ## Features
 * - **Bidirectional**: Full duplex communication over WebSocket
 * - **Client/Server**: Supports both client and server modes
 * - **Authentication**: Optional auth provider for connection validation
 * - **Duck-typed**: Works with any WebSocket-like implementation
 *
 * ## Usage
 *
 * ### Client Mode
 * ```typescript
 * import { createWebSocketTransport } from '@makaio/bus-transport-websocket';
 * import { MakaioBus } from '@makaio/bus-core';
 * import WebSocket from 'ws';
 *
 * const ws = new WebSocket('ws://localhost:8080');
 * const transport = createWebSocketTransport({
 *   mode: 'client',
 *   websocket: ws,
 * });
 *
 * // Register before connect so onReceive is wired before the socket delivers messages.
 * MakaioBus.registerTransport(transport);
 * await transport.connect();
 * ```
 *
 * ### Server Mode
 * ```typescript
 * import { createWebSocketTransport } from '@makaio/bus-transport-websocket';
 * import { MakaioBus } from '@makaio/bus-core';
 * import { WebSocketServer } from 'ws';
 *
 * const wss = new WebSocketServer({ port: 8080 });
 * const transport = createWebSocketTransport({
 *   mode: 'server',
 *   websocket: wss,
 * });
 *
 * MakaioBus.registerTransport(transport);
 * await transport.connect();
 * ```
 */

import { WebSocketClientTransport } from './ws-client-transport.js';
import { ServerTransport } from './server-transport.js';
import type { BusTransport } from '@makaio/bus-core';
import { assertWebSocketTransportOptions } from './types.js';

// Export types
export type { WebSocketCloseEvent, WebSocketLike, WebSocketServerLike, TransportAuth } from './types.js';
export { createWebSocketCloseEvent } from './types.js';

// Export client/server-specific options and types
export type { ClientTransportCodec } from './types.js';

// Export URL-based client transport with built-in reconnection
export { WebSocketClientTransport } from './ws-client-transport.js';
export type {
  WebSocketClientTransportHeartbeatOptions,
  WebSocketClientTransportOptions,
  WebSocketClientTransportReconnectOptions,
} from './ws-client-transport.js';

// Export factory functions
export { ServerTransport } from './server-transport.js';

// Only WebSocket-specific helpers are exported here; generic correlation and
// serialization helpers live at the @makaio/bus-core boundary.
export { extractSocketErrorMessage } from './transport-helpers.js';

// Export authentication implementations
export { HmacAuth } from './auth/index.js';
export {
  clearHmacIdentitySecretsForTesting,
  registerHmacIdentitySecret,
  resolveHmacIdentityAllowedSubjects,
  resolveHmacIdentityPeer,
  resolveHmacIdentitySecret,
  rotateHmacIdentitySecret,
} from './auth/index.js';
export type {
  HmacIdentitySecretRegistrationOptions,
  HmacIdentitySecretRotationOptions,
} from './auth/index.js';
export { E2EAuth } from './auth/index.js';
export { E2ERelayAuth } from './auth/index.js';
export type { E2ERelayAuthOptions } from './auth/index.js';
export { DispatchingAuth } from './auth/index.js';

// Export E2E encrypted transport factories
export { createE2EClientTransport } from './e2e-client-transport.js';
export { createE2ERelayClientTransport, createE2ERelayCodec } from './e2e-relay-client-transport.js';
export { createRelayControlHelpers } from './relay-control-envelope.js';
export type { RelayControlBusMessage, RelayControlHelpers } from './relay-control-envelope.js';
/** @public */
export type { RelayControlEnvelopeMessage } from './relay-control-envelope.js';
export { createRelayControlRegistry } from './relay-control-registry.js';
export type { RelayControlRegistry } from './relay-control-registry.js';

// eslint-disable-next-line no-restricted-syntax -- namespace re-export
export * as crypto from './crypto/index.js';

/**
 * Create a WebSocket transport for the specified mode.
 *
 * For client mode the transport wraps a pre-created `WebSocket` via
 * `WebSocketClientTransport`. Because this factory accepts an already-created
 * socket, caller-supplied dial-time `connectionOptions` cannot be honored here;
 * use `WebSocketClientTransport` directly when you need reconnect or socket
 * creation options.
 * @param options - Transport configuration
 * @returns BusTransport instance
 */
export function createWebSocketTransport(options: import('./types.js').WebSocketTransportOptions): BusTransport {
  assertWebSocketTransportOptions(options);

  if (options.mode === 'client') {
    const legacyConnectionOptions = (
      options as import('./types.js').WebSocketTransportOptions & { connectionOptions?: unknown }
    ).connectionOptions;
    if (legacyConnectionOptions !== undefined) {
      throw new Error(
        'createWebSocketTransport(client) does not support connectionOptions when wrapping a pre-created WebSocket. ' +
          'Use WebSocketClientTransport for reconnect or dial-time socket options.',
      );
    }

    const ws = options.websocket as import('./types.js').WebSocketLike;
    return new WebSocketClientTransport({
      url: '<pre-connected>',
      createWebSocket: () => ws,
      auth: options.auth,
      debug: options.debug,
      // This factory wraps one caller-owned socket instance, so auto-reconnect
      // and dial options are intentionally unsupported here instead of being
      // silently ignored. Use WebSocketClientTransport directly when the
      // transport should own socket creation across reconnect attempts.
      autoReconnect: false,
      // The heartbeat watchdog terminates dead sockets so the reconnect path
      // can recover them. With reconnect unsupported here, terminating a
      // caller-owned socket would change its semantics without any recovery,
      // so heartbeat follows the same rule as autoReconnect: off. Use
      // WebSocketClientTransport directly for supervised connections.
      heartbeat: false,
    });
  } else {
    return new ServerTransport({
      websocket: options.websocket as import('./types.js').WebSocketServerLike,
      auth: options.auth,
      debug: options.debug,
    });
  }
}

/**
 * Module augmentation for BusTransportRegistry.
 *
 * This enables type-safe access to the WebSocket transport:
 * ```typescript
 * const transport = getTransport('websocket'); // Type: BusTransport
 * ```
 */
declare module '@makaio/bus-core' {
  interface BusTransportRegistry {
    websocket: BusTransport;
  }
}

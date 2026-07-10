# @makaio/bus-transport-websocket

WebSocket transport for `@makaio/bus-core` enabling cross-process communication via WebSocket protocol.

## Features

- **Bidirectional**: Full duplex communication over WebSocket
- **Client/Server modes**: Supports both client and server configurations
- **Authentication**: Optional auth provider for connection validation
- **Duck-typed**: Works with any WebSocket-like implementation (browser, ws, etc.)
- **Auto-reconnect**: Built-in connection management with configurable retry logic

## Quick Start

### Client Mode

```typescript
import { createWebSocketTransport } from '@makaio/bus-transport-websocket';
import { MakaioBus } from '@makaio/bus-core';
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8080');
const transport = createWebSocketTransport({
  mode: 'client',
  websocket: ws,
});

MakaioBus.registerTransport(transport);
await MakaioBus.connect();
```

### Server Mode

```typescript
import { createWebSocketTransport } from '@makaio/bus-transport-websocket';
import { MakaioBus } from '@makaio/bus-core';
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });
const transport = createWebSocketTransport({
  mode: 'server',
  websocket: wss,
});

MakaioBus.registerTransport(transport);
await MakaioBus.connect();
```

### With Authentication

```typescript
import { createWebSocketTransport, HmacAuth } from '@makaio/bus-transport-websocket';

const transport = createWebSocketTransport({
  mode: 'client',
  websocket: ws,
  auth: new HmacAuth({ secret: 'your-secret' }),
});
```

## Exports

| Export | Description |
|--------|-------------|
| `createWebSocketTransport` | Factory for wrapping an existing client socket or server |
| `WebSocketClientTransport` | WebSocket client transport |
| `ServerTransport` | WebSocket server transport |
| `HmacAuth` | HMAC-based authentication provider |
| `E2EAuth` | End-to-end encrypted auth provider |
| `E2ERelayAuth` | Relay-based E2E auth provider |
| `DispatchingAuth` | Composite auth (HMAC → E2E hot-swap) |
| `createE2EClientTransport` | E2E encrypted client transport factory |
| `createE2ERelayClientTransport` | E2E relay client transport factory |
| `createE2ERelayCodec` | Codec helper for E2E relay framing |
| `createRelayControlHelpers` | Helpers for relay control envelope messages |
| `createRelayControlRegistry` | Registry for relay control message handlers |
| `extractSocketErrorMessage` | WebSocket error-message helper |
| `createWebSocketCloseEvent` | Normalize close event details |
| `crypto` | Namespaced crypto helpers used by E2E auth |

## Types

| Type | Description |
|------|-------------|
| `WebSocketLike` | Duck-typed client WebSocket interface |
| `WebSocketServerLike` | Duck-typed server WebSocket interface |
| `WebSocketClientTransportOptions` | URL-based client transport configuration |
| `WebSocketClientTransportReconnectOptions` | `{ baseMs?, maxMs? }` reconnect timing |
| `WebSocketClientTransportHeartbeatOptions` | `{ intervalMs?, timeoutMs? }` liveness watchdog timing |
| `ClientTransportCodec` | Client wire codec interface |
| `TransportAuth` | Authentication strategy interface |
| `E2ERelayAuthOptions` | Relay E2E auth strategy options |
| `RelayControlBusMessage` / `RelayControlEnvelopeMessage` / `RelayControlHelpers` / `RelayControlRegistry` | Relay control message types |

## Configuration Options

`createWebSocketTransport()` accepts this object shape; the named options type is internal to the
root entrypoint.

```typescript
interface WebSocketTransportOptions {
  mode: 'client' | 'server';
  websocket: WebSocketLike | WebSocketServerLike;
  auth?: TransportAuth;
  debug?: boolean;
}
```

For client-mode reconnect or socket creation options, use `WebSocketClientTransport`
directly. `createWebSocketTransport({ mode: 'client' })` wraps an already-created
socket and rejects legacy `connectionOptions` instead of silently ignoring them.
Reconnect behavior is scoped to `WebSocketClientTransport`; the generic factory disables
auto-reconnect because it does not own socket creation.

```typescript
import { HmacAuth, WebSocketClientTransport } from '@makaio/bus-transport-websocket';

const transport = new WebSocketClientTransport({
  url: 'ws://localhost:8080',
  auth: new HmacAuth({ secret: 'your-secret' }),
  autoReconnect: { baseMs: 1_000, maxMs: 10_000 },
  connectTimeoutMs: 30_000, // bound per connect attempt (default); prevents a
  // never-answered upgrade from wedging the reconnect loop
  heartbeat: { intervalMs: 30_000, timeoutMs: 10_000 }, // liveness watchdog (default);
  // pings an idle connection and terminates it when no message/pong arrives in time,
  // so half-open TCP connections are detected and healed by the reconnect loop.
  // Requires RFC-6455 ping support on the socket (the `ws` package has it; browser
  // WebSocket does not — the watchdog is inert there). Pass `false` to disable.
});
```

Register transports with the bus before calling `connect()` so receive handlers and subscription
sync are installed before socket messages arrive. The default registry names are `websocket` for
`ServerTransport` and `ws-client` for `WebSocketClientTransport`; pass `name` when a bus registers
more than one WebSocket transport.

## File Structure

```
transports/ws/
├── src/
│   ├── index.ts              # Main exports
│   ├── types.ts              # Type definitions
│   ├── ws-client-transport.ts  # URL-based client transport implementation
│   ├── ws-client-connection.ts
│   ├── ws-client-options.ts
│   ├── ws-client-reconnect.ts
│   ├── ws-client-subscriptions.ts
│   ├── server-transport.ts   # Server transport implementation
│   ├── server-client-setup.ts
│   ├── server-message-handler.ts
│   ├── client-registry.ts
│   ├── subscribe-message.ts
│   ├── broadcast-aggregator.ts
│   ├── relay-control-*.ts
│   └── auth/
│       └── index.ts          # Authentication implementations
├── package.json
└── README.md
```

## Module Augmentation

This package augments `@makaio/bus-core` to provide type-safe transport access:

```typescript
const registry = bus.getContext().transportRegistry;
const transport = registry.getTransport('websocket'); // typed
```

For the transport architecture overview — subscribe-sync handshake, priority-cursor dispatch,
relay behavior, and how to build a custom transport — see the
[Transport Guide](../../docs/transport.md).

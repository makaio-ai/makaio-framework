# @makaio/bus-server

WebSocket server for MakaioBus message routing.

**Core APIs** (`createBusServer`, `startBusServer`): Pure transport layer — bridges WebSocket clients to MakaioBus registry. No adapter logic.

**Vite Plugin**: Moved to `@makaio/bus-server-vite` (`../bus-server-vite/`). That package combines transport + full runtime initialization via `@makaio/runtime-node`.

## Architecture

```
Browser/Client ──WebSocket──→ BusServer ──→ MakaioBus Registry ──→ Handlers
```

## Core APIs

### `createBusServer(config)` — [`src/server.ts`](src/server.ts)

Factory creating a `BusServer` instance. Pure transport — registers WebSocket server with MakaioBus, routes messages.

```typescript
import { WebSocketServer } from 'ws';
import { createBusServer } from '@makaio/bus-server';

const wss = new WebSocketServer({ port: 8080 });
const server = createBusServer({ websocket: wss, debug: true });

await server.start();   // Register transport, begin listening
await server.stop();    // Unregister, disconnect clients
server.getConnectionCount(); // Active connections
```

### `startBusServer(options)` — [`src/server-lifecycle.ts`](src/server-lifecycle.ts)

High-level helper wrapping `createBusServer` with optional HMAC auth setup.

```typescript
import { startBusServer } from '@makaio/bus-server/server-lifecycle';

const server = await startBusServer({
  websocket: wss,
  secret: process.env.BUS_SECRET, // Omit for no auth (dev mode)
  debug: true,
});
```

## Vite Integration

The Vite plugin lives in `@makaio/bus-server-vite` (`../bus-server-vite/`).

## Types — [`src/types.ts`](src/types.ts)

| Type | Description |
|------|-------------|
| `BusServerConfig` | `{ websocket, bus?, auth?, debug? }` |
| `BusServer` | `{ transport, start(), stop(), getConnectionCount() }` |
| `StartBusServerOptions` | `{ websocket, secret?, debug? }` |
| `LoopbackTransportOptions` | Options for the same-server relay proxy |
| `TransportAuth` | Auth strategy type re-exported from the WebSocket transport |
| `WebSocketServerLike` | Duck-typed WebSocket server interface re-exported from the WebSocket transport |

## Module Exports

```
@makaio/bus-server                  → createBusServer, startBusServer, LoopbackTransport, HonoWebSocketBridge
@makaio/bus-server                  → BusServer, BusServerConfig, StartBusServerOptions, LoopbackTransportOptions
@makaio/bus-server                  → TransportAuth, WebSocketServerLike
@makaio/bus-server/server-lifecycle → startBusServer
```

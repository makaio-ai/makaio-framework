# @makaio/runtime-bun

Bun-native overlay for the Makaio AI Framework runtime. Provides Bun-specific
WebSocket/HTTP primitives and re-exports the full portable surface of
`@makaio/runtime-node` so Bun composition roots import a single package.

## Design

The boot sequence itself is engine-agnostic and lives in `@makaio/runtime-node`
as `bootMakaioRuntimeCore`. This package wraps it with a Bun-specific transport
provider (`BunBusServerTransportProvider`) that uses native Bun WebSockets
instead of the `ws` library.

The key difference from Node.js boot: the Bun WebSocket handler must be
extracted _before_ `Bun.serve()` is called and passed directly to `serve({
websocket })`. This makes the bus transport independent of the Hono app
lifecycle — route graph rebuilds create a fresh `new Hono()` but never
interrupt active WebSocket connections.

## Quick Start

```typescript
import {
  BunBusServerTransportProvider,
  bootMakaioRuntime,
  createBunRouteGraphFetch,
  createHonoRouteGraph,
  createHttpRouteGraphBuilder,
} from '@makaio/runtime-bun';
import { HmacAuth } from '@makaio/bus-transport-websocket';
import { Hono } from 'hono';

const auth = new HmacAuth({ secret: process.env.MAKAIO_BUS_SECRET! });
const app = new Hono();
const routeGraph = createHonoRouteGraph(app, {
  health: () => ({ ok: true, auth: true }),
});
const routeGraphBuilder = createHttpRouteGraphBuilder(routeGraph);

// 1. Create the transport first
const transport = new BunBusServerTransportProvider({ auth });

// 2. Extract the WebSocket handler before starting the server
const websocket = transport.createWebSocketHandler();

// 3. Start Bun.serve with the handler
// createBunRouteGraphFetch returns a (request, server) function; Bun passes
// the server argument automatically at call time.
const bunServer = Bun.serve({
  fetch: createBunRouteGraphFetch(routeGraph),
  websocket,
  port: 6252,
});

// 4. Boot the runtime
const runtime = await bootMakaioRuntime({
  transport,
  bunServer,
  routeGraphBuilder,
  surface: 'interactive',
});
routeGraph.markReady();

console.info(`Runtime ready on port ${runtime.port}`);
```

## Bun-Specific Exports

| Export | Description |
|--------|-------------|
| `bootMakaioRuntime` | Boot against a pre-existing Bun server (Bun-specific wrapper) |
| `BunBusServerTransportProvider` | Native Bun WebSocket bus server transport |
| `createBunRouteGraphFetch` | Create a `fetch` handler that delegates to a Hono route graph, with Bun WebSocket upgrade support |
| `resolveListeningPort` | Read the bound port from a Bun server address |

## Types

| Type | Description |
|------|-------------|
| `BunBootMakaioRuntimeOptions` | Options for Bun `bootMakaioRuntime` (adds `bunServer` and `transport`) |
| `BunBusServerTransportOptions` | `{ auth?, loopbackName? }` for `BunBusServerTransportProvider` |
| `BunWebSocketHandler` | Native Bun WebSocket handler shape for `Bun.serve({ websocket })` |
| `BunRouteGraphFetch` | `fetch` handler type for Bun route graph |
| `BunRouteGraphUpgradeServer` | Minimal Bun server interface used by the route graph fetch |
| `BunServer` | Minimal Bun server shape used by `resolveListeningPort` |
| `BunServerAddress` | `{ port, hostname }` shape |

## Re-exported from `@makaio/runtime-node`

All portable runtime-node exports are re-exported unchanged, including
`bootMakaioRuntimeCore`, `FilesystemDescriptorDiscovery`,
`loadOrCreateMachineIdentity`, `FileConfigStorage`, `StoredCredentialProvider`,
`loadExtensions`, `createHonoRouteGraph`, `createHttpRouteGraphBuilder`, and
all associated types. See the
[runtime-node README](../node/README.md) for the full list.

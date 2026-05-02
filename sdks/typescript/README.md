# @makaio/sdk

TypeScript SDK for the Makaio bus protocol. Framework-native facade that wraps
`@makaio/bus-core` and `@makaio/bus-transport-websocket` into a single
developer-friendly API for external consumers building integrations, automation
scripts, and tooling on top of a running Makaio instance.

> **Pre-release.** This package is not yet published to npm.

## How It Differs from the Python and Rust SDKs

The TypeScript SDK is framework-native: it uses the framework's bus packages
directly (`@makaio/bus-core`, `@makaio/bus-transport-websocket`) rather than
the WebSocket wire protocol. This means it participates in the same bus
abstractions (subject types, payload filters, handler priorities) as
first-party framework code.

The Python and Rust SDKs connect over the WebSocket transport using the raw
bus wire protocol.

## Quick Start

```typescript
import { BusClient, SessionSubjects, AgentSubjects } from '@makaio/sdk';

const client = new BusClient();
// URL defaults to ws://127.0.0.1:6252/bus, or set MAKAIO_BUS_URL.
// Auth is resolved automatically from MAKAIO_BUS_SECRET when required.
await client.connect();

// Subscribe to all agent events
const unsubscribe = client.subscribe(AgentSubjects.$all, (ctx) => {
  console.info(ctx.subject, ctx.payload);
});

// Send a message and wait for the response
const response = await client.request(SessionSubjects.sendMessage, {
  sessionId: crypto.randomUUID(),
  agent: { kind: 'canonical-model', model: 'gpt-5.2' },
  message: 'Hello from the SDK!',
});

unsubscribe();
client.close();
```

## API Reference

### `BusClient`

```typescript
const client = new BusClient(url?: string);
```

`url` defaults to `MAKAIO_BUS_URL` or `ws://127.0.0.1:6252/bus`.

| Method | Signature | Description |
|--------|-----------|-------------|
| `connect` | `(options?: BusClientOptions) => Promise<void>` | Open the WebSocket connection. Auto-resolves HMAC auth from `MAKAIO_BUS_SECRET` when the server requires it |
| `subscribe` | `(subject, handler, options?) => () => void` | Subscribe to events. Returns an unsubscribe function |
| `onRequest` | `(subject, handler, options?) => () => void` | Register a request handler. Returns an unsubscribe function |
| `request` | `(subject, payload, options?) => Promise<TRes>` | Send a request and wait for the response |
| `emit` | `(subject, payload) => Promise<void>` | Fire a one-way event |
| `once` | `(subject, options?) => Promise<EventContext<T>>` | Wait for a single matching event |
| `close` | `() => void` | Disconnect and release resources |
| `getBus` | `() => IMakaioBus` | Access the underlying bus instance (throws if not connected) |

### `probeHealth`

```typescript
const health = await probeHealth('ws://localhost:6252/bus');
// => { auth: true } | null
```

Probes the server's `/health` endpoint. Returns `null` when the server is
unreachable. Use this before `connect()` to check whether auth is required
before presenting credentials.

### Connection Options (`BusClientOptions`)

| Option | Type | Description |
|--------|------|-------------|
| `auth` | `TransportAuth` | Explicit auth strategy. When omitted, HMAC auth is resolved from `MAKAIO_BUS_SECRET` if the server requires it |
| `createWebSocket` | `(url) => WebSocketLike` | Custom WebSocket factory (tests, browser, custom impl) |
| `autoReconnect` | `boolean \| WebSocketClientTransportReconnectOptions` | Auto-reconnect config. `true` uses transport defaults |
| `connectTimeoutMs` | `number` | Connection timeout in milliseconds (default: 5000) |
| `debug` | `boolean` | Enable transport debug logging (default: false) |

## Subject Namespaces

The SDK re-exports the framework's subject namespaces so consumers never
import `@makaio/contracts` directly:

| Export | Subjects |
|--------|---------|
| `AgentSubjects` | `agent.started`, `agent.message`, `agent.tool.use`, `agent.complete`, `AgentSubjects.$all` … |
| `SessionSubjects` | `session.sendMessage`, `session.turn.completed`, `SessionSubjects.$all` … |
| `AdapterSubjects` | Adapter lifecycle and config subjects |
| `ToolSubjects` | Tool registration and invocation subjects |
| `ApprovalSubjects` | Human-in-the-loop approval subjects |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `MAKAIO_BUS_URL` | WebSocket URL for the bus server (default: `ws://127.0.0.1:6252/bus`) |
| `MAKAIO_BUS_SECRET` | HMAC shared secret used when the server requires authentication |
| `MAKAIO_DEBUG` | Set to `'true'` to enable transport debug logging |

## Installation

This package is not yet published. Reference it locally via workspace
protocol while the project is in pre-release:

```json
{
  "dependencies": {
    "@makaio/sdk": "workspace:*"
  }
}
```

---

*Part of the [Makaio AI Framework](../../README.md)*

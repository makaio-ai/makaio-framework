---
title: Transport
description: Cross-process bus communication using WebSocket transport for client-server architectures.
---

The bus is a singleton within a single process. Transports extend it across
process boundaries — between the server and browser clients, between the main
thread and workers, or between machines via a relay.

This guide covers how transports work, the shipped implementations, the
subscribe-sync handshake, priority-cursor dispatch, and how to build a custom
transport. For the bus itself, see the [Bus System guide](./bus/).

## The BusTransport Interface

Every transport implements `BusTransport`
(`../packages/bus-core/src/types/transports.ts`):

```ts
interface BusTransport {
  name: string;

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  reconnect?(): Promise<void>;

  // Messaging
  send<TMessage extends BusMessage>(message: TMessage, timeout?: number): Promise<...>;
  onReceive(handler: (message: BusMessage, context?: TransportReceiveContext) => Promise<void>): () => void;
  onBroadcastResults?(correlationId: string, results: ReadonlyArray<...>, error?: BusTransportError): void;

  // Subscription management
  subscribe(subject: string, filter?: PayloadFilter, priorities?: number[]): Promise<void>;
  unsubscribe(subject: string): Promise<void>;

  // Readiness
  ready?: Promise<void>;
  onNewReadySession?: (promise: Promise<void>) => void;
  isReady?(): boolean;

  // Registry callbacks and optional filtering
  onConnected?: () => void;
  onDisconnected?: () => void;
  getSubscriptions?(): Set<string>;
  cancelRequest?(correlationId: string, error?: Error): void;
}
```

The contract has three concerns:

**Messaging** — `send()` pushes a `BusMessage` to the remote peer.
`onReceive()` registers the callback that handles incoming messages. The bus
calls `onReceive()` once during registration and routes all incoming messages
through it.

**Subscriptions** — `subscribe()` and `unsubscribe()` advertise which subjects
this node can handle. Request priorities populate the peer's remote handler
registry for priority-cursor dispatch. Event-only subscriptions are advertised
with an empty priority list and can be used by multiplexing transports, such as
the WebSocket server transport, for per-client delivery filtering.

**Readiness** — `ready` is a Promise that resolves after the subscribe-sync
handshake completes. `bus.connect()` awaits this by default. If a caller uses
`connect({ awaitReady: false })`, request dispatch performs a bounded lazy wait
for pending ready promises before building the remote handler chain. `isReady()`
is the hot-path synchronous check used to skip transports whose connection or
auth session is not currently usable.

## Shipped Transports

### WebSocket Transport

**Package:** `../transports/ws/`

The primary transport for server-to-client communication. Ships in both client
and server modes:

```ts
import { createWebSocketTransport, HmacAuth } from '@makaio/bus-transport-websocket';

// Server mode — wraps a WebSocketServer
const serverTransport = createWebSocketTransport({
  mode: 'server',
  websocket: wss,
  auth: new HmacAuth({ secret }),
});

// Client mode — wraps a pre-created WebSocket
const clientTransport = createWebSocketTransport({
  mode: 'client',
  websocket: ws,
  auth: new HmacAuth({ secret }),
});
```

For reconnection and socket lifecycle management, use `WebSocketClientTransport`
directly:

```ts
import { HmacAuth, WebSocketClientTransport } from '@makaio/bus-transport-websocket';

const transport = new WebSocketClientTransport({
  url: 'ws://localhost:6252/bus',
  auth: new HmacAuth({ secret }),
  autoReconnect: { baseMs: 1_000, maxMs: 10_000 },
});
```

The WebSocket transport is duck-typed — it works with the browser's native
`WebSocket`, the `ws` library, or any object matching the `WebSocketLike` /
`WebSocketServerLike` interfaces.

**Authentication options:**

| Auth | Purpose |
|------|---------|
| `HmacAuth` | HMAC-SHA256 shared secret (loopback / trusted networks) |
| `E2EAuth` | End-to-end encrypted (machine-to-machine) |
| `E2ERelayAuth` | E2E via relay server (browser-to-machine through cloud) |
| `DispatchingAuth` | Hot-swaps between auth strategies at runtime |

#### Workflow Execution Attempt Access

Node hosts can provision the canonical restricted identity for a remote workflow
execution attempt through the public runtime API:

```ts
import { registerWorkflowExecutionBusSecret } from '@makaio/framework/runtime-node/workflow-execution-bus-access';

const registration = registerWorkflowExecutionBusSecret({
  executionAttemptId,
  executionId,
  secret: providerDeliveredSecret,
});
```

The registration uses peer kind `workflow-execution-attempt`, attaches
`executionId` as an authenticated claim, and defaults to the framework's
execution-attempt subject set. Call `registration.cleanup()` when the attempt
ends to revoke that exact secret.

`allowedSubjects` is an authorization boundary: it restricts the messages and
subscription patterns the peer may send. It does not advertise request-handler
interest. A remote attempt receives a server-routed request only after it has
also advertised a matching request subscription.

### MessagePort Transport

**Package:** `../transports/message-channel/`

For communication between threads, workers, and iframes using the
`MessageChannel` / `MessagePort` API:

```ts
import { createMessagePortTransport } from '@makaio/bus-transport-message-channel';

// In the main thread
const channel = new MessageChannel();
const transport = createMessagePortTransport({
  port: channel.port1,
  name: 'worker',
});

// Pass channel.port2 to the worker
worker.postMessage({ port: channel.port2 }, [channel.port2]);
```

The transport wraps any `MessagePortLike` — browser `MessagePort`, Node.js
`worker_threads.MessagePort`, or a custom adapter. It supports optional
channel enveloping (`{ channel: 'bus', message }`) for multiplexed ports
like SharedWorker connections.

### Loopback Transport

**Package:** `../packages/bus-server/src/loopback-transport.ts`

An outbound-only proxy that delegates `send()` to an existing transport under
a different name. Used for same-server relay routing — when a request arrives
on the WebSocket transport and needs to be routed back through the same
server-side transport under a different identity:

```ts
import { LoopbackTransport } from '@makaio/bus-server';

const loopback = new LoopbackTransport({
  target: serverTransport,
  name: 'electron',
});
bus.registerTransport(loopback);
// Requests arriving on 'websocket' can now relay to 'electron'
```

Lifecycle methods (`connect`, `disconnect`) are no-ops — the target transport
owns its own lifecycle.

## Registration and Connection

Transport registration follows a strict sequence:

```ts
// 1. Register transports (before connect)
const registration = bus.registerTransport(transport);

// 2. Connect all transports
await bus.connect();

// 3. Wait for readiness (already resolved by default connect())
await bus.ready;
```

**During registration**, the bus calls `transport.onReceive(handler)` to wire
the inbound message handler. It then calls `syncAllSubjectsToTransport()` to
push all currently registered local handler subjects to the new transport.

**During connect**, the bus calls `transport.connect()` on each registered
transport, then waits for subscribe-sync readiness unless
`connect({ awaitReady: false })` is used.

**Registration after connect has started is blocked** — all transports must
be registered before calling `bus.connect()`.

## Subscribe-Sync Handshake

When a transport connects, the bus and its remote peer need to synchronize
their handler registrations. The handshake works like this:

```text
Server                              Client
  |                                   |
  |  <-- subscribe(subject, prios) -- |  (client tells server what it handles)
  |  <-- subscribe(subject, prios) -- |
  |  <-- subscribe(subject, prios) -- |
  |                                   |
  |  -- subscribe(subject, prios) --> |  (server tells client what it handles)
  |  -- subscribe(subject, prios) --> |
  |                                   |
  |  -- subscribe-sync-complete ----> |  (server signals sync is done)
  |  <-- subscribe-sync-complete ---- |  (client signals sync is done)
  |                                   |
  |  transport.ready resolves         |  transport.ready resolves
```

Both sides push their full advertised handler state, then send
`subscribe-sync-complete`. The `transport.ready` Promise resolves when the
peer's sync-complete arrives. With the default `bus.connect()` behavior, callers
start dispatch only after this readiness promise resolves. If a caller opts into
`connect({ awaitReady: false })`, request dispatch checks the registry's pending
ready promises, waits within the caller's timeout/signal budget, then rebuilds
the remote handler chain before dispatching.

This prevents a race condition where a request would be evaluated before the
remote side has advertised its handlers, resulting in a false `NoHandlerError`.

## Advertised State and Routing

Subscriptions are the wire format for handler advertisement, but they do not
mean every bus send is subscription-filtered. Routing depends on message kind.

### Requests: Advertised-State Dispatch

When `bus.on(subject, handler)` is called locally, the bus recomputes the
**advertised state** for each target transport. The advertised state for a
(transport, subject) pair is the union of:

- local request handler priorities for that subject
- foreign remote handler priorities from other transports, excluding the target
  to avoid loops
- event-handler presence, represented as an empty priority array

This computation happens in `pushAdvertisedSubject()`
(`../packages/bus-core/src/registries/advertised-state.ts`). The function calls
`transport.subscribe(subject, filter, priorities)` with the aggregated data, or
`transport.unsubscribe(subject)` when no handlers remain.

When a `subscribe` wire message arrives, the bus updates
`remoteRequestHandlers` for request priorities and `remoteEventHandlers` for
event-only presence. Request dispatch then merges local entries with matching
remote request entries in priority order.

### Events and Broadcasts: Relay Plus Transport Filtering

The bus sends outbound events to all ready transports unless the caller provides
an explicit transport list or the subject is local-only. Inbound event relay
also forwards to all other ready transports, excluding the source transport.

Broadcasts execute local handlers and send to ready transports. Inbound
broadcast relay is intentionally not subscription-gated at the transport
registry layer; otherwise a stale subscription snapshot could silently drop a
valid responder and produce an incomplete result array.

`ServerTransport` adds per-client filtering inside a WebSocket server transport:
event, broadcast, and request delivery use each client's subscriptions and
payload filters. Requests require an explicit matching subscription, never
route back to their origin socket, and retry matching clients in connection
order when a `NoHandlerError` or timeout occurs.

## Priority-Cursor Dispatch

The dispatch chain for `request()` merges local and remote handlers into a
single list sorted by priority (highest first):

```text
Priority 100  Local handler A
Priority  80  Remote handler (transport: 'websocket')
Priority  50  Local handler B
Priority   0  Remote handler (transport: 'worker')
```

The dispatcher walks this list from highest to lowest priority:

1. **Local entry** — execute the handler directly. If it calls `setResult()`,
   done. If it calls `next()`, advance to the next entry.
2. **Remote entry** — send a `BusRequestMessage` to that transport with a
   `priority` cursor. The remote node starts its own dispatch chain from that
   priority downward.
3. If the remote returns `NoHandlerError`, the local chain continues to the
   next entry.
4. If no handler in the entire chain produces a result, `NoHandlerError` is
   thrown (or `{ handled: false }` for `requestOptional`).

The priority cursor is what makes cross-transport dispatch correct. Without it,
the remote node would start from its highest-priority handler and potentially
re-execute work that a higher-priority local handler already did.

## Relay Behavior

The bus server acts as a **relay** for multi-client topologies. When a message
arrives from one transport, the server:

**Events** — Relayed to all other ready transports (excluding the source).
Local handlers also execute. In `ServerTransport`, same-transport WebSocket
client fan-out is handled per client with subscription and payload filtering.

**Requests** — Dispatched through the merged priority chain. If a remote entry
points to a different transport than the source, the request is forwarded there.

**Broadcasts** — Local handlers execute and relay sends to all other ready
transports. Results are aggregated as `{ nodeId, payload }` entries from local
handlers and relay transports. `ServerTransport` filters only its internal
per-client fan-out.

### Security: Locality Enforcement

The transport layer enforces two locality primitives that restrict how subjects
interact with transports:

**`localSubject()` — full transport isolation.** Messages targeting local
subjects are **dropped** at the transport boundary. The transport registry
checks `isLocalSubject()` for inbound events and rejects them with a warning.
Local subjects are never serialized, never sent over the wire, and never
advertised to peers. This prevents remote peers from invoking process-internal
subjects.

**`hostLocalRequest()` — direct ingress, no relay.** Host-local request
subjects accept direct remote ingress but the receiving bus never relays the
request onward to other transports. This is enforced through three layers of
defense-in-depth:

1. **Advertisement filtering** — `pushAdvertisedSubject()` excludes all foreign
   (learned) priorities for host-local request subjects. Only receiver-local
   handler priorities are advertised to peers. This prevents relay nodes from
   discovering a forwarding path to a handler they do not own.
2. **Dispatch enforcement** — `handleRequestMessage()` in the transport
   registry checks `isHostLocalRequestSubject()` on every inbound request. When
   the subject is host-local, dispatch runs with `localOnly: true`, which
   causes the handler chain to skip all remote entries and bypass the readiness
   gate.
3. **Receiver-resolved trust** — the receiver looks up host-local semantics
   from its own namespace registry. It never trusts a caller-supplied wire flag.
   The wire protocol carries no host-local marker; locality is resolved
   entirely by the receiving runtime.

With buses A—B—C, A can send a host-local request to B (direct connection), but
A cannot reach C's host-local handler through B. The caller must connect
directly to the owning runtime.

| Behavior | `localSubject()` | `hostLocalRequest()` |
|----------|-----------------|---------------------|
| Schema constraint | Events and requests | Requests only |
| Local origin | Stays local | Stays local |
| Remote ingress | Rejected | Allowed (direct only) |
| Advertisement | Not advertised | Local priorities only |
| Relay (A→B→C) | N/A | Forbidden |
| Transport serialization | Never | On first hop only |
| Readiness gating | Local only | Local only on receive |
| Trust model | N/A | Receiver-resolved metadata |

### `RequestContext.deadline`

Request handlers receive a `deadline` property on their context — an absolute
Unix timestamp (ms) minted once at the request entry point. It propagates
unchanged through every handler in the dispatch chain (local and remote).
Handlers can compare `deadline` to `Date.now()` to determine their remaining
time budget. `deadline` is `undefined` when the request was made with
`timeout: 0`.

This is the handler-visible surface of the `deadline` field on
`BusRequestMessage`. On each remote hop, the transport computes remaining time
as `Math.max(0, deadline - Date.now())` for the wire `timeout` field. Without
this absolute-timestamp approach, each hop would restart its timeout from the
original value, allowing unbounded total execution.

## Module Augmentation

Transport implementations declare their name in the `BusTransportRegistry`
interface via TypeScript declaration merging:

```ts
// In the WebSocket transport package
declare module '@makaio/bus-core' {
  interface BusTransportRegistry {
    websocket: BusTransport;
  }
}

// In the MessagePort transport package
declare module '@makaio/bus-core' {
  interface BusTransportRegistry {
    'message-channel': BusTransport;
  }
}
```

This makes transport names type-safe. When accessing a transport by name, only
declared names are accepted:

```ts
const registry = bus.getContext().transportRegistry;
const ws = registry.getTransport('websocket'); // typed
```

## Implementing a Custom Transport

To build a new transport (e.g., gRPC, Unix socket, SharedWorker):

### 1. Implement BusTransport

```ts
import type { BusTransport, BusMessage, PayloadFilter } from '@makaio/bus-core';
import {
  CorrelationTracker,
  DEFAULT_REQUEST_TIMEOUT_MS,
  handleCorrelationResponse,
  trackMessageCorrelation,
} from '@makaio/bus-core';

export class MyTransport implements BusTransport {
  public readonly name = 'my-transport';
  public readonly ready: Promise<void>;

  private receiveHandler?: (message: BusMessage, context?: TransportReceiveContext) => Promise<void>;
  private readonly correlations = new CorrelationTracker();
  private readyResolve!: () => void;

  public constructor() {
    this.ready = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  public onReceive(handler: (message: BusMessage, context?: TransportReceiveContext) => Promise<void>): () => void {
    this.receiveHandler = handler;
    return () => { this.receiveHandler = undefined; };
  }

  public async connect(): Promise<void> {
    // Open your connection here
    // When you receive a message from the remote peer:
    //   await this.receiveHandler?.(message);
    // When you receive subscribe-sync-complete:
    //   this.readyResolve();
  }

  public async disconnect(): Promise<void> {
    // Close your connection
  }

  public async send<T extends BusMessage>(message: T, timeout?: number): Promise<...> {
    // Serialize and send to remote peer
    // For requests, use CorrelationTracker:
    return trackMessageCorrelation(message, this.correlations, timeout ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  public async subscribe(subject: string, filter?: PayloadFilter, priorities?: number[]): Promise<void> {
    // Send a subscribe message to the remote peer
  }

  public async unsubscribe(subject: string): Promise<void> {
    // Send an unsubscribe message to the remote peer
  }
}
```

### 2. Declare the Type

```ts
declare module '@makaio/bus-core' {
  interface BusTransportRegistry {
    'my-transport': BusTransport;
  }
}
```

### 3. Register and Connect

```ts
const transport = new MyTransport();
bus.registerTransport(transport);
await bus.connect();
```

### Key Integration Points

- **`CorrelationTracker`** — Matches request messages to their responses via
  `correlationId`. Use `trackMessageCorrelation()` to register a pending
  request and `handleCorrelationResponse()` to resolve it when the response
  arrives.

- **`subscribe-sync-complete`** — After sending your initial handler set via
  `subscribe()` calls, send a `{ type: 'subscribe-sync-complete' }` message.
  Resolve your `ready` promise when you receive one from the remote peer.

- **`transport.ready` / `isReady()`** — `bus.connect()` awaits `ready` by
  default, and request dispatch performs a bounded lazy wait if readiness is
  still pending. Implement `isReady()` when the transport has a cheap
  connection/auth check that should skip sends on the hot path.

- **Error serialization** — Transport errors must be serializable. Use
  `serializeTransportError()` from `@makaio/bus-core` to convert Error objects
  to wire format.

## Message Types

Messages on the wire are discriminated by `type`:

| Type | Key fields | Purpose |
|------|------------|---------|
| `event` | `subject`, `namespace`, `payload`, `messageId`, `correlationId?` | Fire-and-forget event delivery |
| `request` | `subject`, `namespace`, `payload`, `correlationId`, `messageId`, `timeout?`, `priority?`, `deadline?` | RPC request with priority cursor and optional hop deadline |
| `response` | `correlationId`, `result?`, `error?` | Reply to a request |
| `broadcast` | `subject`, `namespace`, `payload`, `correlationId`, `messageId`, `timeout?` | Multi-handler request |
| `broadcast-response` | `correlationId`, `results?`, `error?` | Broadcast results as `{ nodeId, payload }[]`, or a structured error |
| `subscribe` | `subjects`, `filters?` | Advertise subject priorities with `Record<string, number[]>`; empty arrays mean event-only handlers |
| `unsubscribe` | `subjects` | Remove subject advertisements with `Record<string, number[]>` |
| `subscribe-sync-complete` | none beyond `type` | End of initial handler sync |
| `heartbeat` | `timestamp` | Connection keepalive |

Only `event`, `request`, and `broadcast` messages carry `namespace` and
`messageId`. Responses are keyed by `correlationId`; subscription, handshake,
and heartbeat messages use their own compact shapes.

<!-- web:hide -->

## Key Source Files

| File | Purpose |
|------|---------|
| `../packages/bus-core/src/types/transports.ts` | `BusTransport` interface and message types |
| `../packages/bus-core/src/registries/transport-registry.ts` | Transport registration, relay routing, message handling |
| `../packages/bus-core/src/registries/advertised-state.ts` | Subscription propagation and advertised state computation |
| `../packages/bus-core/src/methods/request/dispatch.ts` | Priority-cursor dispatch chain |
| `../transports/ws/src/index.ts` | WebSocket transport factory and exports |
| `../transports/ws/src/ws-client-transport.ts` | URL-based WebSocket client with reconnection |
| `../transports/ws/src/server-transport.ts` | WebSocket server transport |
| `../packages/bus-core/src/utils/correlation-tracker.ts` | Request/response correlation |
| `../transports/ws/src/ws-client-connection.ts` | WebSocket connect/reconnect session lifecycle |
| `../transports/ws/src/ws-client-reconnect.ts` | Reconnect backoff helpers |
| `../transports/ws/src/auth/` | Authentication implementations (HMAC, E2E, relay) |
| `../transports/message-channel/src/message-port-transport.ts` | MessagePort transport |
| `../packages/bus-server/src/loopback-transport.ts` | Loopback transport for relay |
| `../packages/bus-server/src/server.ts` | `createBusServer` factory |
| `../core/makaio-core/src/subject-helpers/host-local-request-schema.ts` | `hostLocalRequest()` wrapper and `isHostLocalRequestSchema()` |
| `../core/makaio-core/src/subject-helpers/is-local-schema.ts` | `localSubject()` wrapper and `isLocalSchema()` |
| `../core/makaio-core/src/types/context.ts` | `RequestContext.deadline` definition |

<!-- /web:hide -->

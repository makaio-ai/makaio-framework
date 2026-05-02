---
title: Bus Architecture
---

The Makaio Bus is a typed event and RPC system. Framework composition uses the
global `MakaioBus` singleton so services, adapters, tools, and storage handlers
share one runtime bus. Tests and isolated runtimes can create independent bus
instances with `createBusInstance()`.

Every message — event or request — carries a Zod-validated payload, is routed
through a subject with a registered schema, and crosses process boundaries only
when a transport has a matching subscription. Transports track which subjects
(and which payload filters) each client has subscribed to and apply that routing
server-side, so uninterested clients never see the message on the wire. The
result is a bus that scales with the number of relevant listeners, not with the
total number of connected clients.

This is the entry point. For specific topics, follow the links at the bottom.

## Two Kinds of Messages

The bus supports two communication patterns:

**Events** are fire-and-forget in the sense that they do not produce a response
value and the emitter should not depend on a receiver. `emit()` still awaits
local handlers and transport sends before it resolves. Use events for telemetry,
lifecycle notifications, and anything where the sender should not need a result.

```ts
await bus.emit(AgentSubjects.started, {
  agentId: 'agent-1',
  adapterId: 'claude-primary',
  adapterName: 'claude-code',
  adapterSessionId: 'provider-session-1',
  sessionId: 'session-1',
  model: 'claude-sonnet-4-5',
  cwd: '/workspace',
});
```

**Requests** are RPC. The caller sends a typed payload and awaits a typed response.
Exactly one handler produces the result. Use requests for queries, mutations, and
anything where the caller needs a value back.

```ts
const { capabilities, nativeTools } = await bus.request(
  AdapterSubjects.getCapabilities,
  { adapterName: 'openai-node' },
);
```

The distinction is enforced at the type level. You cannot `emit()` on a request
subject, and you cannot `request()` on an event subject — TypeScript will reject it.

## Subjects and Schemas

A **subject** is a named, typed message channel. Subjects are defined with Zod
schemas that describe their payload shape:

```ts
// Event subject — a single Zod schema
const MySchemas = {
  userJoined: z.object({
    userId: z.string(),
    name: z.string(),
  }),
};

// Request subject — an object with `request` and `response` keys
const MySchemas = {
  getUser: {
    request: z.object({ userId: z.string() }),
    response: z.object({ user: UserSchema.nullable() }),
  },
};
```

Namespace registration stores the schemas and subject metadata. Payloads are
validated against those registered schemas when `emit()` or `request()` runs,
and request responses are validated before `request()` returns. Runtime
validation is enabled outside production builds; production is trust-based.
TypeScript infers handler parameter types and response types directly from the
schema definitions — no manual type annotations needed.

## Namespaces

Subjects are grouped into **namespaces**. A namespace is a named, self-contained
domain that owns a set of subjects:

```ts
import { MakaioBus } from '@makaio/bus-core';
import { z } from 'zod';

const NotificationSchemas = {
  sent: z.object({
    recipientId: z.string(),
    message: z.string(),
  }),
  'delivery.confirmed': z.object({
    recipientId: z.string(),
    deliveredAt: z.number(),
  }),
  resolve: {
    request: z.object({ notificationId: z.string() }),
    response: z.object({ notification: z.unknown().nullable() }),
  },
};

const NotificationNamespace = MakaioBus.registerNamespace(
  'notification',
  NotificationSchemas,
);

export const NotificationSubjects = NotificationNamespace.subjects;
```

After registration:

- `NotificationSubjects.sent` is the typed reference for the `notification.sent`
  event subject
- `NotificationSubjects.delivery.confirmed` is the typed reference for
  `notification.delivery.confirmed` (dotted keys become nested accessors)
- `NotificationSubjects.resolve` is the typed reference for the
  `notification.resolve` request subject

Registration is idempotent — calling `registerNamespace` with the same domain
name returns the cached namespace.

**Hierarchical namespaces** use colon separators for sub-domains:

```ts
const ClaudeCodeNamespace = MakaioBus.registerNamespace('adapter:claudeCode', {
  thinking: z.object({ agentId: z.string(), content: z.string() }),
});
// Subject key: adapter:claudeCode.thinking
```

This is how adapter implementations register their provider-specific subjects
while remaining discoverable under the `adapter:` prefix.

### Real Examples from the Codebase

The framework's own subjects are defined in `../packages/contracts/src/`:

- **Agent namespace** (`agent/namespace.ts`): agent lifecycle
  (`started`, `complete`, `idle`), streaming (`message_delta`, `reasoning_delta`),
  tool orchestration (`tool.use`, `tool.output`, `toolApprove`), and turn tracking
  (`turn.started`, `turn.completed`).

- **Adapter namespace** (`adapter/namespace.ts`): adapter
  lifecycle (`initialized`, `error`), session management (`session.created`,
  `session.closed`), and agent control (`startAgent`, `stopAgent`,
  `getCapabilities`).

- **Tool namespace** (`tool/namespace.ts`): tool registration
  (`registered`, `registryChanged`), execution lifecycle (`started`, `completed`,
  `error`), and the core RPCs (`list`, `execute`).

## Subscribing and Emitting

### Event Subscription

```ts
const unsub = bus.on(AgentSubjects.message_delta, (ctx) => {
  // ctx.payload is fully typed from the Zod schema
  console.info(ctx.payload.text);
});

// Later: unsubscribe
unsub();
```

The handler receives an `EventContext` with:

- `payload` — the typed payload
- `subject` — the string subject key
- `messageId` — unique ID for this emission
- `correlationId` — optional, for tracing related messages

### One-Time Listeners

```ts
// Promise-based: resolves on the next matching event
const ctx = await bus.once(AgentSubjects.complete, {
  filter: { agentId: 'agent-1' },
  timeoutMs: 30_000,
});
console.info(ctx.payload);

// Callback-based: fires once then auto-unsubscribes
bus.once(AgentSubjects.started, (ctx) => {
  console.info('First agent started:', ctx.payload.agentId);
});
```

### Emitting Events

```ts
await bus.emit(AgentSubjects.started, {
  agentId: 'agent-1',
  adapterId: 'claude-primary',
  adapterName: 'claude-code',
  adapterSessionId: 'provider-session-1',
  sessionId: 'session-1',
  model: 'claude-sonnet-4-5',
  cwd: '/workspace',
});
```

`emit()` returns `Promise<void>`. It resolves after all local handlers have been
called and all transport sends have completed.

## Request / Response (RPC)

### Handling Requests

Register a handler with `bus.on()`. Call `ctx.setResult()` to produce the
response:

```ts
bus.on(ToolSubjects.list, (ctx) => {
  const tools = registry.getAll();
  ctx.setResult({ tools, toolsets: registry.getToolsets() });
});
```

### Making Requests

```ts
const { tools, toolsets } = await bus.request(ToolSubjects.list, {});
```

`request()` throws if:

- No handler is registered (`NoHandlerError`)
- The handler throws an error (propagated to the caller)
- The request times out (`TimeoutError`, default 60 seconds)

### `requestOptional` — Graceful Absence

When a handler might not be registered (e.g., an optional extension), use
`requestOptional()`:

```ts
const result = await bus.requestOptional(
  HarnessSubjects.resolve,
  { agentId, toolName },
);

if (result.handled) {
  applyPolicy(result.data);
} else {
  applyDefaultPolicy();
}
```

The return type is a discriminated union:
`{ handled: true; data: Response } | { handled: false }`.

Only `NoHandlerError` is converted to `{ handled: false }`. All other errors
(timeouts, handler exceptions) propagate normally.

## Broadcast

`broadcast()` collects responses from all handlers (not just the first one):

```ts
const results = await bus.broadcast(
  CapabilitySubjects.listProviders,
  { capabilityId: 'log-import' },
);

for (const { payload } of results) {
  providers.push(...payload.providers);
}
```

The result shape is always `{ nodeId, payload }`, so callers aggregate from the
handler payloads rather than checking a success/data wrapper.

## Local and Channel Subjects

### Local Subjects

Wrap a schema with `localSubject()` to prevent it from being routed over
transports:

```ts
import { localSubject } from '@makaio/bus-core';

const MySchemas = {
  internalState: localSubject(z.object({ state: z.string() })),
};
```

Local subjects are invisible to transports — they are never sent over the wire.
Use them for process-internal coordination that should not leak across boundaries.

### Channel Subjects

Channel subjects (`channelSubject()`) are restricted to `DirectChannel`
connections — they cannot be used on the public bus. They are blocked at the
type level (the `on()` signature returns `never` for channel subjects on the
global bus). Channels are used for point-to-point communication between specific
bus clients, such as the relay pairing protocol.

## Transports

The bus is a singleton within a process. **Transports** bridge it across process
boundaries. The `BusTransport` interface defines the contract:

```ts
interface BusTransport {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: BusMessage, timeout?: number): Promise<...>;
  onReceive(handler: (message: BusMessage, context?: TransportReceiveContext) => Promise<void>): () => void;
  subscribe(subject: string, filter?: PayloadFilter, priorities?: number[]): Promise<void>;
  unsubscribe(subject: string): Promise<void>;
  ready?: Promise<void>;
  isReady?(): boolean;
}
```

The framework ships three transport implementations:

| Transport | Package | Use case |
|-----------|---------|----------|
| **WebSocket** | `transports/ws/` | Server-to-client (browser, CLI, mobile) |
| **MessagePort** | `transports/message-channel/` | Workers, iframes, SharedWorker tabs |
| **Loopback** | `packages/bus-server/` | Same-server relay routing |

### Subscription-Based Routing

Transports do not broadcast all traffic to all clients. Each client sends a
`subscribe` message declaring which subjects it cares about, optionally with a
per-subject payload filter. The server tracks these subscriptions per client and
evaluates them before sending:

1. **Subject match** — if a client has subscriptions but none match the message
   subject, the message is never sent to that client.
2. **Payload filter** — if the subscription includes a filter (e.g.,
   `{ sessionId: 'abc' }`), the server checks the message payload against it.
   Only messages whose payload satisfies the filter are forwarded.

This means `filter` is not client-side convenience — it is server-side routing.
A WebSocket client subscribing to `agent.message_delta` with
`{ filter: { sessionId } }` only receives deltas for that session over the
wire, regardless of how many other sessions are active on the bus.

Requests are the exception: they bypass subscription routing because the bus
must find the one handler that can respond, which may live on any connected
client.

For a full treatment of transport internals, the subscribe-sync handshake,
relay behavior, and how to implement a custom transport, see
[transport.md](../transport.md).

## Subject Naming Conventions

| Pattern | Example | When to use |
|---------|---------|-------------|
| `domain.action` | `agent.started` | Standard event |
| `domain.entity.action` | `agent.tool.use` | Nested entity lifecycle |
| `domain:qualifier.action` | `adapter:claudeCode.thinking` | Implementation-specific |
| `storage:domain.operation` | `storage:session.get` | Storage CRUD (via `createStorageNamespace`) |

Keep domains short and descriptive. Use dotted keys for logical nesting — the
bus transforms them into nested accessor objects on the `subjects` export.

## Error Handling

| Error | When | Recovery |
|-------|------|----------|
| `NoHandlerError` | `request()` finds no handler | Use `requestOptional()` for optional services |
| `TimeoutError` | Request exceeds timeout (default 60s) | Pass `{ timeout: 120_000 }` in options |
| Handler exception | Handler throws during execution | Error propagates to the `request()` caller |
| Schema validation | Payload or response fails Zod validation | Fix the value — validation runs outside production |

Set a custom timeout per request:

```ts
const result = await bus.request(SlowSubjects.compute, payload, {
  timeout: 120_000,
});
```

Pass `timeout: 0` to disable the timeout entirely (use with caution).

<!-- web:hide -->

## Key Source Files

| File | Purpose |
|------|---------|
| `../packages/bus-core/src/bus.ts` | `MakaioBus` singleton and `createBusInstance` |
| `../packages/bus-core/src/types/bus.ts` | `IMakaioBus` interface — all method signatures |
| `../packages/bus-core/src/registries/namespace-registry.ts` | `registerNamespace` implementation |
| `../packages/bus-core/src/types/transports.ts` | `BusTransport` interface |
| `../packages/contracts/src/agent/namespace.ts` | `AgentSubjects` registration |
| `../packages/contracts/src/adapter/namespace.ts` | `AdapterSubjects` registration |
| `../packages/contracts/src/tool/namespace.ts` | `ToolSubjects` registration |

<!-- /web:hide -->

## Deep Dives

| Topic | What it covers |
|-------|----------------|
| [Bus Patterns](./patterns.md) | Scoped buses, filtered buses, interceptors, handler priority and chaining |
| [Storage via Bus](./storage.md) | Bus-mediated storage namespaces, handler implementation, backend swapping |
| [Decoupling Patterns](./decoupling.md) | Dependency inversion, contract lifting, UI-intent relay, boot-time injection |
| [Testing](./testing.md) | Isolated bus contexts, global bus reset, test fixtures |

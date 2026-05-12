---
title: Bus Patterns
---

Advanced bus features that give extensions and services fine-grained control over
message routing, event transformation, and handler composition.

## Scoped Bus

A **scoped bus** restricts operations to a single namespace. It validates that
every `on()`, `emit()`, and `request()` call targets a subject owned by that
namespace:

```ts
const agentBus = await AgentNamespace.scopedBus();

// These work — AgentSubjects belongs to the agent namespace
agentBus.on(AgentSubjects.started, handler);
await agentBus.emit(AgentSubjects.started, payload);

// This would be a type error — AdapterSubjects belongs to a different namespace
// agentBus.on(AdapterSubjects.initialized, handler);
```

Get a scoped bus from a namespace:

```ts
const scopedBus = await MyNamespace.scopedBus();
```

The `scopedBus()` method preserves full type safety — including typed
`withFilter()` keys derived from the namespace's payload schemas.

**When to use:** Adapter implementations use scoped buses so they cannot
accidentally subscribe to or emit on subjects they do not own. Extensions that
register their own namespace should do the same — it is a guardrail, not a
limitation.

## Filtered Bus

A **filtered bus** pre-applies a payload filter to every subscription. Without
it, every handler would need to pass a `{ filter: { agentId } }` option
individually — repetitive and easy to forget. A filtered bus applies the filter
once and every handler registered through it inherits it automatically:

```ts
const agentBus = bus.withFilter({ agentId: 'agent-1' });

// All three handlers only fire when payload.agentId === 'agent-1'
// — no per-handler filter option needed
agentBus.on(AgentSubjects.sendMessage, handleMessage);
agentBus.on(AgentSubjects.getCapabilities, handleCapabilities);
agentBus.on(AgentSubjects.cwd.change, handleCwdChange);
```

Each agent creates a filtered bus scoped to its own `agentId`, then registers
all its handlers through it. The filter is type-safe —
`FilterablePayloadIntersection` computes the union of all payload fields across
all subjects in the namespace, so TypeScript knows which fields are valid filter
keys.

**Filters compose:**

```ts
const sessionBus = bus.withFilter({ sessionId: 'session-1' });
const agentSessionBus = sessionBus.withFilter({ agentId: 'agent-1' });
// Both filters apply: sessionId AND agentId must match
```

**When to use:** Any time your extension handles events for a specific entity
(agent, session, adapter). Instead of checking `if (payload.agentId === myId)`
in every handler, create a filtered bus once and register all handlers through it.

## Interceptors

Interceptors are event-only middleware that run before handlers. They can
transform payloads or block propagation:

```ts
const unsub = bus.intercept(AgentSubjects.message_delta, (ctx) => {
  // Transform the payload for all downstream handlers
  ctx.replacePayload({
    ...ctx.payload,
    text: sanitize(ctx.payload.text),
  });
});

// Or block the event entirely
bus.intercept(AgentSubjects.started, (ctx) => {
  if (isBlocked(ctx.payload.agentId)) {
    ctx.stopPropagation();
  }
}, { priority: 1000 }); // Higher priority = runs first
```

Interceptors run sequentially in priority order. Continuation is implicit —
each interceptor runs unless a previous one called `stopPropagation()`.
`stopPropagation()` prevents all subsequent interceptors and all event handlers
from firing.

**Extension use cases:**

- **Content filtering:** Sanitize or redact sensitive data in streaming deltas
  before other subscribers see it
- **Rate limiting:** Block events that exceed a threshold
- **Telemetry enrichment:** Add metadata to events before they reach handlers
- **Feature gating:** Suppress events for disabled features

Interceptors are event-only. For request/response middleware, use the
`ctx.next()` chaining pattern described below.

## Handler Priority and Chaining

Handlers run in priority order (highest first). A handler can call `ctx.next()`
to delegate to the next handler in the chain:

```ts
// Priority 100 — runs first, can wrap lower-priority handlers
bus.on(SessionStorageSubjects.get, async (ctx) => {
  const cached = cache.get(ctx.payload.sessionId);
  if (cached) {
    ctx.setResult({ session: cached });
    return;
  }
  // Delegate to the next handler (e.g., database)
  await ctx.next();
}, { priority: 100 });

// Priority 0 (default) — the database handler
bus.on(SessionStorageSubjects.get, async (ctx) => {
  const session = await db.query(ctx.payload.sessionId);
  ctx.setResult({ session });
});
```

This is how the framework layers caching, enrichment, and storage without
coupling them. The priority chain is also how request handlers interleave across
local and remote transports.

**Extension use cases:**

- **Caching layer:** Your extension adds a cache in front of an existing storage
  handler — register at a higher priority, serve from cache when possible,
  `ctx.next()` on miss
- **Validation layer:** Validate or enrich request payloads before the primary
  handler sees them
- **Audit logging:** Observe and log requests at high priority, then always
  `ctx.next()` to let the real handler run
- **Override behavior:** Replace a framework handler's response entirely for
  specific payloads by setting the result without calling `ctx.next()`

## Combining Patterns

These patterns compose naturally:

```ts
// Scoped to your namespace + filtered to your entity + high priority
const myBus = await MyExtensionNamespace.scopedBus();
const entityBus = myBus.withFilter({ entityId: myEntity.id });

entityBus.on(MyExtensionSubjects.process, async (ctx) => {
  // Only fires for your namespace + your entity
  // Can still use ctx.next() for priority chaining
  await ctx.next();
}, { priority: 50 });
```

The bus does not force you into one pattern — scope where you want isolation,
filter where you want entity targeting, chain where you want layered behavior.

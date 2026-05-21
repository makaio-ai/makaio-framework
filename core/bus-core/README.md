# @makaio/bus-core

Type-safe, distributed event bus for the Makaio framework. Supports fire-and-forget
events and request-response RPCs over a pluggable transport layer, with full
TypeScript inference from subject definitions.

## Installation

`@makaio/bus-core` is a private workspace package. Internal packages depend on
it with `"@makaio/bus-core": "workspace:*"`; it is not installed from npm.

## Usage

### Define a namespace

```typescript
import { MakaioBus } from '@makaio/bus-core';
import { z } from 'zod';

const MyNamespace = MakaioBus.registerNamespace('my-service', {
  // Event: fire-and-forget
  taskStarted: z.object({ taskId: z.string() }),

  // Request: request-response
  getStatus: {
    request: z.object({ taskId: z.string() }),
    response: z.object({ status: z.string(), progress: z.number() }),
  },
});
const { subjects: MySubjects } = MyNamespace;
```

### Emit and subscribe to events

```typescript
// Subscribe
MakaioBus.on(MySubjects.taskStarted, ({ payload }) => {
  console.log('Task started:', payload.taskId);
});

// Emit
await MakaioBus.emit(MySubjects.taskStarted, { taskId: 'abc-123' });
```

### Register and call request handlers

```typescript
// Register a handler
MakaioBus.on(MySubjects.getStatus, (ctx) => {
  ctx.setResult({ status: 'running', progress: 0.5 });
});

// Make a typed request
const result = await MakaioBus.request(MySubjects.getStatus, { taskId: 'abc-123' });
console.log(result.status); // 'running'
```

### Scoped bus (filtered by session / agent ID)

```typescript
const scopedBus = await MyNamespace.scopedBus({ sessionId: 'sess-1' });
scopedBus.on(MySubjects.taskStarted, (ctx) => { /* only sees sess-1 events */ });
```

## API overview

| Export | Description |
|--------|-------------|
| `MakaioBus` | Singleton bus instance |
| `createBusInstance()` | Create an isolated bus instance (testing, workers) |
| `createFilteredBus()` | Wrap a bus with a static payload filter |
| `localSubject()` | Define a subject handled only in the local process |
| `channelSubject()` | Define a bidirectional channel subject |
| `openChannel()` / `createChannelEndpoint()` | Establish direct peer-to-peer channels |
| `CorrelationTracker` | Low-level correlation ID tracking for transport implementations |
| `matchesSubscription()` / `matchesAnySubscription()` | Subscription matching helpers |
| `parseBusUrl()` | Parse a `makaio-bus://` connection URL |
| `DEFAULT_REQUEST_TIMEOUT_MS` | Default request timeout constant |
| `type IMakaioBus` | Full bus interface |
| `type BusTransport` | Transport interface for custom implementations |
| `type ScopedBus` | Filtered, scoped bus interface |
| `type BusNamespace` | Typed namespace returned by `registerNamespace` |

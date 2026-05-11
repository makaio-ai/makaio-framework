---
title: Testing with the Bus
---

The bus provides isolation primitives for testing. Unit tests get an isolated
bus that does not leak handlers between tests. Integration tests can use the
global singleton with cleanup.

## Isolated Bus Context

For unit tests, create an isolated bus context so handlers from one test do not
leak into another:

```ts
import { createBusContext, createBusInstance } from '@makaio/bus-core';

const testContext = createBusContext();
const testBus = createBusInstance({ context: testContext });

// Register handlers on testBus — isolated from the global MakaioBus
testBus.on(MySubjects.getData, (ctx) => {
  ctx.setResult({ data: 'test' });
});

const result = await testBus.request(MySubjects.getData, {});
```

Each isolated bus has its own handler registry, transport list, and namespace
state. Nothing registered on one isolated bus is visible to another or to the
global singleton.

## Resetting the Global Bus

For integration tests that need the global singleton:

```ts
import { MakaioBus } from '@makaio/bus-core';

afterEach(() => {
  MakaioBus.__resetHandlers?.();
});
```

This clears all registered handlers but preserves namespace registrations.
The method is only defined when `NODE_ENV === 'test'` — it is `undefined`
in all other environments. Use optional chaining (`?.()`) as a defensive
call pattern.

## Framework Test Utilities

The framework ships test helpers in `@makaio/test-utils`:

- **`createTestBusInstance()`** — convenience wrapper around
  `createBusInstance` with an isolated context, ready to use. Payload schema
  validation applies for namespaces registered in that bus context.
- **`createMockBus()` / `createMockGlobalBus()` / `createMockScopedBus()`** —
  Vitest mock factories for unit tests where you want to assert bus calls
  without triggering real handlers
- **`makeStubExtensionContext()`** — satisfies the `ExtensionContext` type
  for handler registration in tests
- **`@makaio/test-utils/drizzle-harness`** — SQLite-backed test database
  helpers (`createTempDb`, `createPluginTestDb`, `createDbCleanup`,
  `usePluginStorageTestLifecycle`) for storage handler integration tests

When writing extension tests, prefer `createTestBusInstance()` for real bus
behavior or `createMockBus()` for isolated unit tests. Avoid
`MakaioBus.__resetHandlers?.()` unless you specifically need the global
singleton — isolated contexts are deterministic and cannot be affected by
test ordering.

## Testing Storage Handlers

Storage handlers are bus request handlers, so they test naturally:

```ts
const testBus = createBusInstance({ context: createBusContext() });

// Register the handler under test
const cleanup = registerMyStorageHandlers(testBus);

// Exercise via bus requests — same API as production
await testBus.request(MyStorageSubjects.set, {
  id: '1',
  data: { name: 'test' },
});

const { item } = await testBus.request(MyStorageSubjects.get, { id: '1' });
expect(item).toEqual({ name: 'test' });

cleanup();
```

No mocks needed — the bus is the test boundary. Register the real handler,
call the real subjects, assert the real responses.

## Testing Event Flows

Use `bus.once()` to wait for expected events in tests:

```ts
const completedPromise = testBus.once(MySubjects.completed, {
  filter: { jobId: 'job-1' },
  timeoutMs: 5_000,
});

// Emit the event under test directly.
await testBus.emit(MySubjects.completed, {
  jobId: 'job-1',
  status: 'ok',
});

const ctx = await completedPromise;
expect(ctx.payload.jobId).toBe('job-1');
```

## Testing Interceptors

Interceptors are registered on the bus like handlers. Test them by registering
the interceptor, emitting an event, and verifying the transformation:

```ts
const received: Array<{ text: string; sanitized: boolean }> = [];

// Register interceptor under test
bus.intercept(MySubjects.data, (ctx) => {
  ctx.replacePayload({ ...ctx.payload, sanitized: true });
});

// Register a handler to capture the transformed payload
bus.on(MySubjects.data, (ctx) => {
  received.push(ctx.payload);
});

await bus.emit(MySubjects.data, { text: 'raw', sanitized: false });
expect(received[0].sanitized).toBe(true);
```

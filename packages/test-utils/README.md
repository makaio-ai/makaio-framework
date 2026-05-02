# @makaio/test-utils

Shared test harnesses for bus mocking and SQLite database lifecycle in Vitest suites.

## What This Is

Centralises the two most common test setup patterns across Makaio framework packages:

- **Bus harnesses** - Type-safe mock bus instances without `as unknown as IMakaioBus` casts scattered across test files
- **Drizzle harnesses** - Temporary SQLite databases with table creation, data clearing, and handler registration lifecycle tied to Vitest hooks

## Installation

This is a private workspace package. Add it to a consuming workspace package with the workspace
protocol:

```json
{
  "devDependencies": {
    "@makaio/test-utils": "workspace:*"
  }
}
```

## Key Exports

### `@makaio/test-utils`

Root exports are bus and extension-context test helpers only:

- `createMockBus()` — Partial mock for unit tests (request, emit, on, requestOptional, withFilter)
- `createMockGlobalBus(namespace?)` — Full mock for adapter/agent tests (adds once, scoped, __onAny, getContext, registerNamespace, getSchema)
- `createMockScopedBus(namespace?)` — Mock `ScopedBus<string>` for adapter-internal tests
- `createTestBusInstance()` — Real bus instance for integration tests. Payload schema validation applies for namespaces registered in that bus context.
- `makeStubExtensionContext(bus)` — Minimal extension context for service and package tests

**Root types:**
- `MockBusResult` / `MockGlobalBusResult` / `MockScopedBusResult`

### `@makaio/test-utils/drizzle-harness`

The Drizzle helpers are intentionally isolated behind a subpath so ordinary bus tests do not import
SQLite, Drizzle, or Vitest lifecycle helpers:

- `createTempDb(name)` — Creates a temp SQLite file with foreign keys enabled
- `createPluginTestDb(config)` — Suite-level DB with `clearData()`, `registerHandlers()`, and `close()` lifecycle methods
- `createDbCleanup(handlerCleanup, close, dbPath)` — Composes handler cleanup, database close, and file delete
- `usePluginStorageTestLifecycle(createTestDbFn)` — Registers beforeAll/beforeEach/afterEach/afterAll hooks automatically

**Drizzle subpath types:**
- `TestDbContext` / `TestDbContextWithCleanup`
- `PluginTestDbContext` / `PluginTestDbConfig` / `PluginStorageTestContext`

## Basic Usage

```typescript
import { createMockBus, createTestBusInstance } from '@makaio/test-utils';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { usePluginStorageTestLifecycle, createPluginTestDb } from '@makaio/test-utils/drizzle-harness';

// Unit test: mock bus
const { bus, request } = createMockBus();
request.mockResolvedValue({ profile: null });
const service = new MyService(bus);
expect(request).toHaveBeenCalledWith(expect.anything(), { id: '123' });

const MakaioBus = createTestBusInstance();

// Integration test: real SQLite with managed lifecycle
const ctx = usePluginStorageTestLifecycle(() =>
  createPluginTestDb({
    name: 'my-service',
    schemas: [sql`CREATE TABLE ...`],
    tables: ['my_table'],
    registerHandlers: (db) => registerMyHandlers(MakaioBus, db, makeStubExtensionContext(MakaioBus)),
  }),
);

it('stores and retrieves', async () => {
  await MakaioBus.request(MySubjects.set, { entity: { id: '1', ... } });
  const result = await MakaioBus.request(MySubjects.get, { id: '1' });
  expect(result.entity).toBeDefined();
});
```

`makeStubExtensionContext(bus)` requires an explicit bus so tests do not hide which bus instance
storage handlers are registered against. The stub fills only the structural context fields needed
by handler registration; it does not wire real services.

## Architecture

`@makaio/test-utils` is a `devDependency` for all packages that test storage or bus behaviour. It is never imported at runtime.

The `usePluginStorageTestLifecycle` helper solves a recurring problem: rapid SQLite client creation/destruction between tests causes Neon/Rust panics. The suite-level pattern (create DB once in `beforeAll`, clear data in `beforeEach`, register handlers per-test) keeps the client alive across the suite while isolating handler state.

---

*Part of Makaio Framework*

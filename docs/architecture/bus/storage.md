---
title: Storage via Bus
---

The bus is the seam for storage in the framework. Storage handlers are bus
request handlers — consumers call `bus.request()` against storage subjects
without knowing whether the backend is in-memory, SQLite, or something else.

This means storage backends are swappable at composition time. Tests use
in-memory handlers; production uses Drizzle/SQLite. Extensions can register
their own storage namespaces and swap backends without changing consumers.

## Defining a Storage Namespace

```ts
import { createStorageNamespaceDefinition } from '@makaio/storage-core';

const SessionStorageNamespace = createStorageNamespaceDefinition('session', {
  schemas: {
    get: {
      request: z.object({ sessionId: z.string() }),
      response: z.object({ session: MakaioSessionSchema.nullable() }),
    },
    set: {
      request: z.object({ sessionId: z.string(), session: MakaioSessionSchema }),
      response: z.object({ success: z.boolean() }),
    },
    delete: {
      request: z.object({ sessionId: z.string() }),
      response: z.object({ deleted: z.boolean() }),
    },
    list: {
      request: z.object({ status: z.string().optional() }),
      response: z.object({ sessions: z.array(MakaioSessionSchema) }),
    },
  },
});

export const SessionStorageSubjects = SessionStorageNamespace.subjects;
// Subjects: storage:session.get, storage:session.set, etc.
```

`createStorageNamespaceDefinition` prepends `storage:` and creates typed
subjects and schemas. Extensions declare static definitions in their manifest's
`namespaces` array or claim runtime definitions with `ctx.namespaces.lease(definition)`.
Host code registers a definition at composition time on an `IHostMakaioBus`:

```ts
bus.registerNamespace(SessionStorageNamespace);
```

## Implementing a Handler

A storage handler is a function that registers bus request handlers for the
storage subjects. It returns a cleanup function that unsubscribes all handlers:

```ts
export function registerMemorySessionStorage(bus: IMakaioBus): () => void {
  const store = new Map<string, IMakaioSession>();
  const unsubs: Array<() => void> = [];

  unsubs.push(
    bus.on(SessionStorageSubjects.get, (ctx) => {
      const session = store.get(ctx.payload.sessionId);
      ctx.setResult({ session: session ?? null });
    }),
  );

  unsubs.push(
    bus.on(SessionStorageSubjects.set, (ctx) => {
      store.set(ctx.payload.sessionId, ctx.payload.session);
      ctx.setResult({ success: true });
    }),
  );

  return () => unsubs.forEach((fn) => fn());
}
```

## Drizzle Handler Factories

For production use, the framework ships handler factories that generate
bus-backed CRUD handlers from a Drizzle table definition:

- `createDrizzleCrudHandlers` — generates `get`, `set`, `delete` handlers
- `createDrizzleListHandler` — generates `list` handlers with filtering

These live in `@makaio/storage-handlers` and return a registration function
`(bus, db) => () => void` — the additional `db` parameter is the only
difference from the in-memory version above. Consumers cannot tell which
backend serves their requests.

## Consuming Storage

```ts
import { SessionStorageSubjects } from '@makaio/contracts/session';

// ORIGIN: The caller looks up a session on this bus.
const { session } = await bus.request(
  bus.own('root'),
  SessionStorageSubjects.get,
  { sessionId: '123' },
);
```

The consumer talks to contracts. The handler is swapped at composition time:
`registerMemorySessionStorage` for tests, the Drizzle handler for production.

## Extension Storage

Extensions define their own storage namespaces using the same pattern. The
`MakaioExtension.storage` surface lets extensions declare Drizzle migrations
and register storage handlers during extension boot:

```ts
const myExtension: MakaioExtension = {
  name: 'my-extension',
  namespaces: [MyStorageNamespace],
  storage: {
    packageRoot: import.meta.dirname,
    migrations: './drizzle',
    registerHandlers: (bus, db, ctx) => registerMyStorageHandlers(bus, db),
  },
  // ...
};
```

`packageRoot` anchors relative storage paths. `migrations` is a relative path
from that package root to the Drizzle migration folder.
`registerHandlers` receives the bus, a database instance, and a host context —
it returns an optional cleanup function.

The kernel runs migrations in dependency order during boot, then calls each
extension's `registerHandlers` to wire up handlers. Your extension's consumers
use `bus.request(call, MyStorageSubjects.get, ...)` — they never import your handler
implementation.

## Why Bus-Mediated Storage

**Swappable backends.** Tests run against in-memory handlers. Production runs
against Drizzle (SQLite or PostgreSQL, selected by connection URL). An
extension could register an alternative backend — for example an in-memory
store for ephemeral hosts — at higher priority and transparently replace the
default.

**Cross-process transparency.** When a transport bridges the bus across
processes, storage requests route through the same dispatch mechanism as any
other bus request. A browser client can request session data from the server
without a dedicated REST endpoint — the bus handles it.

**Priority layering.** A caching extension can register a high-priority handler
that serves from cache and calls `ctx.next()` on miss (see
[Handler Priority and Chaining](./patterns#handler-priority-and-chaining)).
The primary storage handler never knows about the cache.

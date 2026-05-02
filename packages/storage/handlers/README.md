# @makaio/storage-handlers

Factory functions for Drizzle-backed bus storage handlers with minimal boilerplate.

## What This Is

Eliminates repetitive handler registration code for services that store entities in SQLite via Drizzle. Provides:

- **CRUD factories** - Generate get-by-id, upsert, and delete bus handlers from a single config object
- **List factory** - Generate list handlers from caller-provided SQL predicates
- **Scope predicate helper** - Optional `buildScopePredicates(table, projectId)` for the common
  `default` plus project scope model
- **Lifecycle events** - Optional `created`/`updated`/`deleted` bus event emission on CRUD mutations
- **Null conversion helpers** - `nullToUndefined(obj, keys)` / `undefinedToNull(obj, keys)` for
  DB ↔ API boundary mapping

## Key Exports

**Main entry (`@makaio/storage-handlers`):**
- `createDrizzleCrudHandlers(config)` — Returns a `(bus, db) => cleanup` factory for get/set/delete handlers
- `createDrizzleListHandler(config)` — Returns a `(bus, db) => cleanup` factory for list handlers
- `buildScopePredicates(table, projectId)` — Builds default/project scope SQL predicates; opt in
  from `createDrizzleListHandler({ buildPredicates })`
- `nullToUndefined(obj, keys)` / `undefinedToNull(obj, keys)` — Null ↔ undefined converters for
  specified object keys

**Drizzle sub-entry (`@makaio/storage-handlers/drizzle`):**
- Same factories, directly from the drizzle subfolder

**Types:**
- `DrizzleCrudConfig<TTable, ApiType, TIdField, InputType, TSingularKey>` — CRUD factory configuration
- `DrizzleListConfig<TTable, ApiType, QueryPayload, TPluralKey>` — List factory configuration
- `CrudLifecycleConfig<TEntity>` — Optional lifecycle event subjects (`created`, `updated`, `deleted`)

## Basic Usage

```typescript
import { createDrizzleCrudHandlers, createDrizzleListHandler } from '@makaio/storage-handlers';

// Define once at service startup
const registerProfileHandlers = createDrizzleCrudHandlers({
  table: profilesTable,          // Drizzle table (must have createdAt/updatedAt)
  subjects: ProfileStorageSubjects,
  idField: 'profileId',
  singularKey: 'profile',
  mapper: (row) => toProfileApi(row),
  toDbValues: (input) => toProfileDb(input),
  // Optional: emit lifecycle events
  lifecycle: {
    created: ProfileSubjects.subjects.created,
    updated: ProfileSubjects.subjects.updated,
    deleted: ProfileSubjects.subjects.deleted,
  },
});

// Register against bus + db, receive cleanup function
const cleanup = registerProfileHandlers(bus, db);

// List handler with scope filtering
const registerListHandler = createDrizzleListHandler({
  table: profilesTable,
  subject: ProfileStorageSubjects.list,
  pluralKey: 'profiles',
  mapper: toProfileApi,
  buildPredicates: (payload, table) => buildScopePredicates(table, payload.projectId),
});
```

`createDrizzleListHandler()` does not apply scope rules by default. It calls the supplied
`buildPredicates(payload, table)` function and combines the returned predicates with `and(...)`.
Use `buildScopePredicates()` when a table has a `scope` column and should include default records
plus the active project scope.

## Architecture

`@makaio/storage-handlers` is a low-level infrastructure package. It has no opinion about which entities exist — it only knows how to wire Drizzle queries to the bus.

CRUD tables used with `createDrizzleCrudHandlers` **must** have `createdAt` and `updatedAt`
timestamp columns because the upsert path writes them automatically. List-only tables used with
`createDrizzleListHandler` do not have that timestamp requirement.

Type safety is enforced at call sites through configuration generics. Internal Drizzle query builder calls use minimal type assertions to satisfy Drizzle's dynamic API constraints; these are isolated within the factories and not exposed to consumers.

---

*Part of Makaio Framework*

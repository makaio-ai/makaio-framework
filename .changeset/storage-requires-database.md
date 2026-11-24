---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/kernel": major
"@makaio/runtime-node": major
"@makaio/subsystem-client": major
"@makaio/services-core": minor
"@makaio/storage-drizzle": major
"@makaio/storage-pg": patch
---

Extensions that declare storage require `storage.drizzle`. When a surface-matching extension requires unavailable `storage.drizzle`, including an unavailable version required by a storage declaration, startup fails with `ExtensionStorageCapabilityError`, which names the storage extensions and their required dependents. A storage handler that reaches startup requires a database.
On hosts without `storage.drizzle`, a surface-matching extension with a `storage` declaration or an explicit `storage.drizzle` requirement fails selection before other environment requirements are evaluated.

Breaking: `NodeExtensionContext` now requires `database` and `journal`. Hosts that supply `ExtensionContextBase` must provide `constructContext`. Full Node hosts bind both capabilities there. Hosts that run without either capability can return the shared fields as `IsolatedNodeExtensionContext`.

Breaking: `createClientsCorePackage` no longer registers persistent client runtime, binary, and profile handlers. Full hosts must add `clientStoragePackage` to their load set. Client startup fails when a full host has no active client storage package.

Breaking: `IsolatedWorkflowRuntime.coordinator`, `CreateIsolatedWorkflowRuntimeOptions.contributedPackages`, and its contribution loader now use the isolated context. Manifests requiring the full Node context cannot be supplied to this runtime. `PrepareAdapterRuntimeInput`, `PreparedAdapterRuntime`, and `prepareAdapterRuntime` use a host context type parameter, defaulting to the full Node context.

Breaking: custom Drizzle `DatabaseClient` implementations must supply `signals`. In-memory engines can use `{ kind: 'none', reason: 'in-memory' }`.

Each PostgreSQL database client exposes database signals through a dedicated, lazily opened `LISTEN` connection and closes it before shutting down the query pool.

Breaking for consumers of the journal API in development snapshots: `RecordEntryInput` drops `witnessed`; pass it in `AcceptEntryInput` for inbound edge deliveries. `JournalRecordErrorCode` gains `record-before-active`, `key-subject-mismatch`, `foreign-transaction`, and `transaction-finished`. If a record call rejects a live transaction from another database facade, the owning transaction rolls back even if the caller catches the error. `witnessed-not-owned` is now accept-only, and accept also reports `accept-during-own-start`. Deliveries arriving during startup wait for the host to become ready and fail with `accept-startup-timeout` if that wait expires. Hosts can set `CoreBootOptions.journalStartupWaitTimeoutMs`. The 30-second default allows slow extension initialization while bounding dependency cycles. The subject directory can return `NotProjectableSchemaMark` for an event payload or either side of a request, so consumers of `SubjectDirectoryEntrySchema` must handle that marker.

`MakaioExtension` accepts optional `edges` and `accountResolver` contributions. The journal implementation and its storage API are available from `@makaio/framework/services/journal` and `@makaio/framework/services/journal/storage`. The Drizzle storage API adds host transaction query, rollback and wake helpers, a database wake dispatcher, and database signal bindings for cross-process delivery.

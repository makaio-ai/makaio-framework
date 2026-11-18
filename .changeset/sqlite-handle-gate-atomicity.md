---
"@makaio/framework": major
---

Make SQLite transactions atomic and isolated per database handle on both drivers.

Under Bun, `executeTransaction` on a `bun:sqlite` handle committed at the callback's first `await`, so later statements ran outside the transaction and a rejection did not roll them back. Every statement the callback awaits now commits together when it resolves and rolls back together when it rejects, including nested `tx.transaction()` savepoints, which roll back only their own statements.

One shared per-handle serialization gate (`HandleGate`) now fronts local `bun:sqlite` and `@libsql/client` handles. While a transaction is open on a handle, statements issued from outside its callback wait until it commits or rolls back: they no longer join it, observe its uncommitted writes, or fail with `SQLITE_BUSY` (on libsql they used to block the event loop until the busy timeout). Statements issued from inside the callback are never held back. Transactions and sessions on one handle run one at a time.

Raw `BEGIN`/`COMMIT` paths go through the same gate: `RawSqlExecutor.withSession` on SQLite now holds the handle exclusively for the duration of the session callback, so a raw transaction neither collides with other statements nor swallows them. `createSqliteRawSqlExecutor` accepts an optional handle-exclusivity argument; handles created without one are not serialized.

Connection settings now apply to every connection of a handle. libsql opens a new connection after each transaction; `busy_timeout` and `foreign_keys` are now applied to each connection it opens instead of only the first. `journal_mode = WAL` is stored in the database file and is still applied once per handle.

Statements are prepared behind the gate as well as executed: under Bun a reader from outside no longer fails with "no such table" for a table whose `DROP` a still-open transaction later rolls back. The nested transactions (savepoints) of one transaction run one at a time in request order on both drivers; two that overlapped used to fail with "no such savepoint".

`close()` of a local SQLite handle goes through the gate: it waits for the transaction or raw session holding the handle and for statements already queued, then closes the connection. A handle whose initialization fails releases its connection. A rollback that fails while a transaction is already failing no longer replaces the original error: the original is rethrown and the rollback failure is attached to it.

**Breaking:** in-memory SQLite URLs (`:memory:`, `file::memory:`, `mode=memory`) are rejected by the libsql driver (Node.js). libsql hands its connection to every transaction and continues on a new, empty one, so an in-memory database was lost after the first transaction. Use a temporary database file; `bun:sqlite` keeps a single connection and still serves in-memory databases. `file::memory:` is no longer classified as a file database.

**Breaking:** a transaction callback (and a `withSession` callback) must contain database work only. It must not await work started outside it that uses the same handle (bus requests, other queued database operations): that work waits for the transaction, which waits for the callback, and both stall. Requesting a transaction, a `serializeDatabaseOperation`, a raw session or a `close()` on the same handle from inside such a callback is now rejected with a `ReentrantOperationError` instead of deadlocking; the same holds for `serializeByKey` called for a key its own work holds. Cycles through promises started elsewhere cannot be detected and remain the callback's responsibility. Code that previously awaited such work inside a transaction, which could succeed on libsql, must move it before or after the transaction.

---
'@makaio/contracts': minor
'@makaio/storage-drizzle': minor
---

Add the host database seam `HostDatabase`/`HostTransaction` under `@makaio/contracts/host-database` and, in `@makaio/storage-drizzle`, a query context bound to exactly one host transaction. Every builder or prepared query created through the context runs in that transaction; once the transaction ended, execution fails with `transaction-finished` before the database is touched (a rejected promise on libsql and node-postgres, a synchronous throw on bun:sqlite). Transactions do not nest: a transaction call from inside the open one is rejected, calls from elsewhere wait. `executeTransaction` now rejects a hand-rolled bun-sqlite handle that was not created by `createDatabaseClient`, before any statement runs: its native transaction would commit at the callback's first `await`.

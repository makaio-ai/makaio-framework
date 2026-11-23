---
'@makaio/storage-drizzle': patch
---

Report unsupported host transaction dialects and invalid PostgreSQL driver results with typed transaction errors. The raw PostgreSQL transaction adapter is available through a dedicated internal entry for storage adapters.

The adapter also refuses transactions opened on a different database handle with `transaction-database-mismatch`.

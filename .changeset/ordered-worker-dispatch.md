---
"@makaio/contracts": minor
"@makaio/framework": patch
"@makaio/services-core": patch
"@makaio/storage-migrations": patch
"@makaio/storage-pg": patch
---

Lay the internal groundwork for ordered worker dispatch and allocation
supervision. The dispatch port remains internal pending host integration.
Add the allocation scope binding and dispatch claim tables through the SQLite
and PostgreSQL migrations.

`AllocationListingRequest` accepts an optional `provisioningStartedAt`
lower bound for recovery searches.

This version of the ordered dispatch port compares allocation references
exactly and treats a refined reference as a conflict. The port does not accept
reference refinements in this version. This is a known deviation from the
worker capability contract, which allows a refined reference. Providers that
refine references are not yet supported by this port. Support for accepting
refinements will follow in a separate change.

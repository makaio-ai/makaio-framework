---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/services-core": major
---

Split observed `SessionStart` handling by start mode instead of routing every mode
through the import upsert.

`fresh`, `clear`, `fork` and an absent start mode keep registering through
`storage:session.importUpsert` (fork still registers its lineage immediately).
`resume` and `compact` announce a *continuation* of a session that already exists,
so they now go through the new `storage:session.rebindObserved` subject: it
refreshes runtime and locality facts only — working directory, transcript path and
owning machine — and cannot reach origin identity, lineage, import status,
lifecycle status, creation time, metadata or content. Machine ownership overwrites
on a rebind (the machine running the continuation owns the provider-native session
store), while absent fields leave stored values untouched.

`'not-found'` is a modeled outcome rather than a silent create. A continuation of a
session storage has never seen carries no trustworthy creation time, lineage or
content; inventing a row would stamp import provenance and a `createdAt` taken from
the resume moment, which the import upsert's timestamp-correction clause could
never repair afterwards. The registration is skipped and the transcript import
creates the session from real data on the next completed turn. Skipping is only
correct while such an import is still coming, so the outcome is resolved by the
observed-session ingestion policy: under a metadata-only `discovered` verdict no
content import will ever run, and the continuation degrades to the regular
metadata registration instead of disappearing.

Breaking behavior change: a `resume` of a watcher-discovered row no longer promotes
it to `tracking`/`active` and no longer stamps `clientId` on it — content import
still runs on the next completed turn and the import path owns the promotion.

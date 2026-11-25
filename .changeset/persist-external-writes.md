---
'@makaio/contracts': minor
'@makaio/kernel': minor
'@makaio/services-core': minor
'@makaio/runtime-node': minor
'@makaio/storage-migrations': minor
'@makaio/storage-pg': minor
---

Add the external write journal for SQLite and PostgreSQL. A Node host can enable the journal with a write authorization and deadline policy. Extensions can contribute external writers, transactional write participants and a purpose-based credential resolver. The journal records intentions before external effects and supports recovery, authorized paged reads and manual resolution.

Writer callbacks must return or throw by the supplied deadline, when external effects must also stop. The journal awaits the callbacks and records late `written`, `notWritten`, `found` and explicit `undecidable` responses. Writers may report `absent` only if the intended object or content is absent and the earlier attempt can no longer produce it. A late `absent` or a failed lookup leaves the intent open. An authorized operator can resolve an unresolved intent or an intent whose deadline has passed.

The journal preserves the last applied write across failed attempts and evaluates new requests after recovering an earlier intent. Reusing a key for a different target returns `invalid-request` with reason `key-target-mismatch`. An inactive required participant returns `participant-unavailable`.

If a participant rejects a completed write, the unresolved record exposes the reported object for manual review. Releasing the intent restores the previous object reference so a retry uses the original create or update target.

Breaking change to manual resolution requests. Supply the `intentId` returned with the write record. A decision for a stale intent returns `stale-intent`. Failed or rejected credential lookups return the retryable `credential-unavailable` reason while the deadline is active.

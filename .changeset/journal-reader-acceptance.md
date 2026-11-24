---
"@makaio/contracts": minor
"@makaio/runtime-node": minor
---

Activate declarative journal readers in Node hosts. Readers resume durable positions, authorize stored payloads through the host rights resolver, and commit database effects atomically with their reading state. Hosts expose journal queries and can requeue failed reader entries.

If a rights source denies access to an entry, it is marked done with `access-denied` for this reader and is never delivered to it again. When a rights source is unavailable or resolution fails, the reader retries with backoff and records the reason in its reading state.

Each reader processes entries in order within an `orderKey` among entries selected by its current subject patterns. An entry whose handler keeps throwing is retried without an attempt limit and blocks later selected entries on that key until it succeeds or the reader reports `failed`. Other keys and readers can continue. Operators can inspect retries through `makaio:journal.reader-states` and requeue entries already marked `failed` through `makaio:journal.reprocess`.

The host may call `handle` more than once for the same entry after a retry or claim expiry. An abandoned attempt can keep running in the background and overlap a later attempt. Effects outside `commit` have at-least-once semantics and must tolerate duplicate execution. Without a rights answer source for subscriptions, every entry is readable by every reader by default.

Postgres wakes other processes through the database signal. SQLite and libSQL wake readers only in the process that commits; another process catches up on restart or its next local wake.

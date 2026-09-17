---
'@makaio/contracts': minor
'@makaio/framework': minor
'@makaio/services-core': minor
'@makaio/storage-pg': patch
---

Track how often a conversation has been compacted, live from the hook path.

Sessions gain a `generation` column: a count of provider compactions, starting at
0 and defaulted so existing rows read as "never compacted" without a backfill. A
continuation reporting `startMode: 'compact'` advances it as part of the same
statement that refreshes the session's locality; a `resume` continues the same
context and leaves it alone.

This gives consumers a generation boundary at the moment compaction happens.
Until now the only marker of a compaction was the `compress` lineage row, which
only a transcript import can create: those rows are identified by the compaction
boundary record inside the transcript, and no hook payload carries it. The
ordinal and the lineage answer different questions and both remain — the ordinal
says a new generation started, the lineage carries the compacted content once the
import catches up.

The advance is at-least-once, because nothing deduplicates hook deliveries. That
is deliberate: `generation` is an ordinal, not a tally. It changes on compaction
and never repeats or regresses, which is what change detection needs; a skipped
number is harmless where a missed one would silently merge two generations.

Two seams write the ordinal, because one key cannot reach every row.
`storage:session.rebindObserved` accepts an optional `startMode` and advances
atomically with the rebind, addressing hook-observed rows by their
`(source, adapterSessionId)` import identity. Adapter-managed sessions carry no
`source`, so that key can never match them; `storage:session.update` gains an
`advanceGeneration` flag that reaches them by `sessionId`. Both increment in SQL
relative to the stored value, never from a caller-supplied number.

A whole-record `session.set` leaves the column untouched on an existing row, so a
caller holding a pre-compaction snapshot cannot rewind it, but still carries a
supplied value onto a fresh row — a snapshot import of an already compacted
session lands where it left off instead of at 0.

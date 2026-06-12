# n/a marker: `0001_messages_content_tsv` has no SQLite counterpart

This marker pairs (by tag stem) with the hand-written Postgres migration
`drizzle-postgres/0001_messages_content_tsv.sql`, which adds the
`messages.content_tsv` generated `tsvector` column and its GIN index.

There is **intentionally no SQLite counterpart**. SQLite full-text search is
not provisioned through the migration chain at all — it is created at runtime by
`createFts5Tables`, which builds FTS5 virtual tables (and their sync triggers)
against the `messages` table. Postgres provisions search through a stored
generated column in the schema, so its migration lands in the chain; SQLite's
search backend is a runtime concern and therefore absent from the chain by
design.

The generated-DDL parity lint (`scripts/validate-ddl-parity.ts`) reads this
marker to confirm the `messages.content_tsv` divergence is reviewed and accepted
rather than an accidental missing column. This file is documentation only and is
never read by any runtime path.

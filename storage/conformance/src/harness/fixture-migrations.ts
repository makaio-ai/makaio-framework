/**
 * Synthetic migration builder for conformance suites that exercise the migration runner itself.
 *
 * Produces {@link MigrationMeta} entries without touching the filesystem, using the same
 * hash and breakpoint format the production reader emits.
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';
import type { MigrationMeta } from '@makaio/storage-migrations';

/**
 * Base epoch for fixture migration `folderMillis` values.
 *
 * Chosen to be well in the past so fixture entries sort before any real migration.
 */
const FIXTURE_BASE_MILLIS = 1700000000000;

/**
 * Build a synthetic migration entry.
 *
 * `raw` is the statements joined with the statement-breakpoint separator —
 * exactly the content the filesystem reader would see in an on-disk `.sql`
 * file. Both derived fields mirror the reader byte-for-byte: the hash is the
 * SHA-256 hex digest of `raw`, and `sql` is the breakpoint split of `raw`,
 * whose segments keep their surrounding newlines just like the reader's
 * segments do. `folderMillis` is `FIXTURE_BASE_MILLIS + order`. `bps` is
 * always `true`.
 * @param tag - Journal-style tag (also used in error messages).
 * @param statements - Individual SQL statements.
 * @param order - Ordering offset for folderMillis. Default 0.
 * @returns Synthetic migration entry compatible with {@link applyMigrations}.
 */
export function fixtureMigration(tag: string, statements: readonly string[], order = 0): MigrationMeta {
  const raw = statements.join('\n--> statement-breakpoint\n');
  const hash = createHash('sha256').update(raw).digest('hex');

  return {
    tag,
    sql: raw.split('--> statement-breakpoint'),
    folderMillis: FIXTURE_BASE_MILLIS + order,
    hash,
    bps: true,
  };
}

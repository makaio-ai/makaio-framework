import { sql, type SQL } from 'drizzle-orm';
import { getDatabaseDialect, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { JsonValue } from '@makaio/contracts';

/**
 * Convert a workflow state JSON value for storage in a non-null JSON column.
 *
 * Drizzle JSON columns treat JavaScript `null` as SQL `NULL` on write, but
 * workflow state uses `null` as a valid JSON value. Emit a dialect-specific
 * JSON-null literal so the database column stays non-null while round-tripping
 * as JSON `null`.
 * @param db - Database handle used to resolve the active dialect.
 * @param value - Workflow state JSON value.
 * @returns Drizzle column value for a workflow state JSON column.
 */
export function toWorkflowStateJsonColumnValue(db: MakaioDatabase, value: JsonValue): JsonValue | SQL {
  if (value !== null) {
    return value;
  }
  return getDatabaseDialect(db) === 'postgres' ? sql`'null'::jsonb` : sql`'null'`;
}

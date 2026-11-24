import { JournalError, type AcceptInput, type EdgeCursorValue, type EdgeName } from '@makaio/contracts';
import { resolveSchema, type TransactionQueryContext } from '@makaio/storage-drizzle';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { journalStorageSchema } from './schema.variants.js';

/** An expected cursor and its replacement for a single edge partition. */
type EdgeCursorMove = NonNullable<AcceptInput['cursor']> & { readonly edge: EdgeName };

/**
 * Move an edge cursor within the delivery transaction.
 * @param q - Query context of the caller's transaction.
 * @param move - Edge, partition, expected cursor and replacement cursor.
 * @throws A `JournalError` with code `cursor-moved` when the expected cursor is stale.
 */
export async function moveEdgeCursor(
  q: TransactionQueryContext,
  { edge, partition, from, to }: EdgeCursorMove,
): Promise<void> {
  const { journalEdgeCursors: table } = resolveSchema(q, journalStorageSchema);
  const changed =
    from === null
      ? await q
          .insert(table)
          .values({ edge, partition, value: to })
          .onConflictDoUpdate({
            target: [table.edge, table.partition],
            set: { value: to },
            setWhere: isNull(table.value),
          })
          .returning({ partition: table.partition })
      : await q
          .update(table)
          .set({ value: to })
          .where(and(eq(table.edge, edge), eq(table.partition, partition), eq(table.value, from)))
          .returning({ partition: table.partition });

  if (changed.length === 0) {
    throw new JournalError('cursor-moved', `Cursor for edge "${edge}", partition "${partition}" has already moved.`);
  }
}

/**
 * Read one cursor per requested partition, in request order.
 * @param q - Query context of the caller's transaction.
 * @param edge - Edge whose cursors to read.
 * @param partitions - Partition names, including any repetitions.
 * @returns The requested cursors, with null values for missing partitions.
 */
export async function readEdgeCursors(
  q: TransactionQueryContext,
  edge: EdgeName,
  partitions: readonly string[],
): Promise<EdgeCursorValue[]> {
  if (partitions.length === 0) return [];

  const { journalEdgeCursors: table } = resolveSchema(q, journalStorageSchema);
  const rows = await q
    .select({ partition: table.partition, value: table.value })
    .from(table)
    .where(and(eq(table.edge, edge), inArray(table.partition, [...new Set(partitions)])));
  const values = new Map(rows.map(({ partition, value }) => [partition, value]));

  return partitions.map((partition) => ({ partition, value: values.get(partition) ?? null }));
}

import {
  type ExternalObjectRef,
  type JournalWritesPage,
  type JournalWritesRequest,
  WRITE_PAGE_DEFAULT_LIMIT,
  type WriteRecordView,
} from '@makaio/contracts/journal';
import type { HostDatabase, HostTransaction } from '@makaio/contracts';
import { getHostTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import { and, asc, eq, gt, or } from 'drizzle-orm';
import { z } from 'zod';
import { journalStorageSchema } from './schema.variants.js';
import type { JournalWriteRow } from './write-schema.js';

const CursorSchema = z.tuple([z.number().int(), z.string()]);

/**
 * Encode the stable external identity used in index lookups.
 * @param object - External object or parent.
 * @returns Identity without URL or enclosing parent metadata.
 */
export function externalIdentity(object: ExternalObjectRef): string {
  return JSON.stringify([object.extension, object.site, object.objectType, object.externalId]);
}

/**
 * Project a persisted write record into its public view.
 * @param row - Persisted row.
 * @returns Public record.
 */
export function writeView(row: JournalWriteRow): WriteRecordView {
  const { writeRecordId, writer, key, state, object, parent, intentId, checksum, appliedOrder, ctx } = row;
  return {
    writeRecordId,
    writer,
    key,
    state,
    object,
    parent,
    intentId,
    checksum,
    appliedOrder,
    ctx,
    intendedSince: state === 'intended' ? new Date(row.intent.startedAt).toISOString() : null,
  };
}

/** Database access for conditional write transitions and reads within a caller transaction. */
export class WriteStore {
  /**
   * @param host - Database facade that authorizes journal transactions.
   */
  public constructor(private readonly host: HostDatabase) {}

  /**
   * Read a row without exposing its stored intent to the public capability.
   * @param selector - Stable record ID or writer and key.
   * @returns Current record, if present.
   */
  public load(
    selector: { writeRecordId: string } | { writer: string; key: string },
  ): Promise<JournalWriteRow | undefined> {
    return this.host.transaction(async (tx) => {
      const q = getHostTransactionQueryContext(this.host, tx);
      const { journalWrites: t } = resolveSchema(q, journalStorageSchema);
      const where =
        'writeRecordId' in selector
          ? eq(t.writeRecordId, selector.writeRecordId)
          : and(eq(t.writer, selector.writer), eq(t.key, selector.key));
      const [row] = await q.select().from(t).where(where).limit(1);
      return row;
    });
  }

  /**
   * Persist a conditional transition, then run its participant on the very same transaction.
   * @param before - Expected version of the record, if it already exists.
   * @param after - Resulting row.
   * @param commit - Work participating in the transition.
   * @returns Whether the expected version was still current and committed.
   */
  public change(
    before: JournalWriteRow | undefined,
    after: JournalWriteRow,
    commit?: (tx: HostTransaction) => Promise<void>,
  ): Promise<boolean> {
    return this.host.transaction(async (tx) => {
      const q = getHostTransactionQueryContext(this.host, tx);
      const { journalWrites: t } = resolveSchema(q, journalStorageSchema);
      const rows =
        before === undefined
          ? await q.insert(t).values(after).onConflictDoNothing().returning({ id: t.writeRecordId })
          : await q
              .update(t)
              .set(after)
              .where(and(eq(t.writeRecordId, before.writeRecordId), eq(t.version, before.version)))
              .returning({ id: t.writeRecordId });
      if (rows.length === 0) return false;
      await commit?.(tx);
      return true;
    });
  }

  /**
   * Read a keyset page, using exactly the transaction supplied by the caller when present.
   * @param input - Selector and paging bounds.
   * @param tx - Optional caller transaction on this host.
   * @returns Public records, with a cursor when a further row exists.
   */
  public page(input: JournalWritesRequest, tx?: HostTransaction): Promise<JournalWritesPage> {
    const run = async (transaction: HostTransaction): Promise<JournalWritesPage> => {
      const q = getHostTransactionQueryContext(this.host, transaction);
      const { journalWrites: t } = resolveSchema(q, journalStorageSchema);
      const limit = input.limit ?? WRITE_PAGE_DEFAULT_LIMIT;
      const selector =
        'byKey' in input
          ? and(eq(t.writer, input.byKey.writer), eq(t.key, input.byKey.key))
          : or(eq(t.objectKey, externalIdentity(input.byObject)), eq(t.parentKey, externalIdentity(input.byObject)));
      const cursor =
        input.cursor === undefined
          ? undefined
          : CursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
      const lower =
        cursor === undefined
          ? undefined
          : or(gt(t.createdAt, cursor[0]), and(eq(t.createdAt, cursor[0]), gt(t.writeRecordId, cursor[1])));
      const rows = await q
        .select()
        .from(t)
        .where(and(selector, lower))
        .orderBy(asc(t.createdAt), asc(t.writeRecordId))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        writes: page.map(writeView),
        ...(last &&
          rows.length > limit && {
            nextCursor: Buffer.from(JSON.stringify([last.createdAt, last.writeRecordId])).toString('base64url'),
          }),
      };
    };
    return tx === undefined ? this.host.transaction(run) : run(tx);
  }
}

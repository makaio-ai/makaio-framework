import type { HostDatabase } from '@makaio/contracts';
import {
  JOURNAL_PAGE_DEFAULT_LIMIT,
  JournalEntriesRequestSchema,
  PositionSchema,
  ReaderStatesRequestSchema,
  type JournalEntriesPage,
  type JournalEntriesRequest,
  type JournalEntry,
  type ReaderEntryState,
  type ReaderStatesPage,
  type ReaderStatesRequest,
  type SubjectPattern,
} from '@makaio/contracts/journal';
import { getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import { and, asc, eq, getTableColumns, gt, gte, lte, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { JournalEntryRow, JournalReaderStateRow } from './schema.js';
import { journalStorageSchema } from './schema.variants.js';

/** Maximum rows read from the journal in one transaction or authorization batch. */
export const READER_BATCH_SIZE = 64;

type CursorKind = 'entries' | 'states';

/**
 * Build the SQL projection of the validated bus subscription grammar.
 * @param subject - Column storing the canonical subject name.
 * @param patterns - Validated patterns, where an empty array matches nothing.
 * @returns An optional SQL predicate. Undefined means every subject matches.
 */
export function selectSubjects(subject: SQLWrapper, patterns?: readonly SubjectPattern[]): SQL | undefined {
  if (patterns === undefined || patterns.includes('*')) return undefined;
  if (patterns.length === 0) return sql`1 = 0`;
  return or(
    ...[...new Set(patterns)].map((pattern) => {
      if (!pattern.endsWith('*')) return eq(subject, pattern);
      const prefix = pattern.slice(0, -1);
      return sql`substr(${subject}, 1, ${[...prefix].length}) = ${prefix}`;
    }),
  );
}

/**
 * Convert a durable row to its public shape.
 * @param row - The durable journal row.
 * @returns A serializable journal entry.
 */
export function toJournalEntry(row: JournalEntryRow): JournalEntry {
  return {
    entryId: row.entryId,
    position: row.position,
    subject: row.subject,
    payload: row.payload,
    schemaVersion: row.schemaVersion,
    key: row.key,
    ...(row.orderKey === null ? {} : { orderKey: row.orderKey }),
    origin: row.origin,
    recordedAt: new Date(row.recordedAt).toISOString(),
  };
}

/**
 * Convert a reading state to its public shape.
 * @param row - The reader's durable state.
 * @returns A view without the claim credentials.
 */
function toReaderState(row: JournalReaderStateRow): ReaderEntryState {
  return {
    entryId: row.entryId,
    position: row.position,
    state: row.state,
    ...(row.reason === null ? {} : { reason: row.reason }),
    retries: row.retries,
    ...(row.notBefore === null ? {} : { notBefore: new Date(row.notBefore).toISOString() }),
  };
}

/**
 * Encode the position already scanned as an opaque, operation-specific cursor.
 * @param kind - Operation that consumes the cursor.
 * @param position - Last scanned position to exclude on the next page.
 * @returns The continuation token.
 */
function encodeCursor(kind: CursorKind, position: number): string {
  return Buffer.from(`v1:${kind}:${position}`).toString('base64url');
}

/**
 * Decode a cursor and reject malformed, noncanonical and cross-operation tokens.
 * @param kind - Operation that consumes the cursor.
 * @param cursor - Incoming continuation token.
 * @returns The last scanned position.
 */
function decodeCursor(kind: CursorKind, cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString();
  const position = Number(decoded.slice(decoded.lastIndexOf(':') + 1));
  if (!PositionSchema.safeParse(position).success || encodeCursor(kind, position) !== cursor) {
    throw new Error('Invalid journal continuation cursor.');
  }
  return position;
}

/**
 * Read the stored states of one reader.
 * @param host - Host journal database.
 * @param input - Exact entry or paged query.
 * @returns The matching reader states.
 */
export async function queryReaderStates(host: HostDatabase, input: ReaderStatesRequest): Promise<ReaderStatesPage> {
  const {
    reader,
    entryId,
    state,
    since,
    cursor,
    limit = JOURNAL_PAGE_DEFAULT_LIMIT,
  } = ReaderStatesRequestSchema.parse(input);
  const after = cursor === undefined || entryId !== undefined ? undefined : decodeCursor('states', cursor);
  const page = await host.transaction(async (tx) => {
    const q = getTransactionQueryContext(tx);
    const { journalReaderStates: states, journalReaderCursors: cursors } = resolveSchema(q, journalStorageSchema);
    const positionFilter =
      after === undefined ? since !== undefined && gte(states.position, since) : gt(states.position, after);
    // Read the frontier and the page from one statement snapshot, even when no state matches.
    return await q
      .select({ readerPosition: cursors.position, state: getTableColumns(states) })
      .from(cursors)
      .leftJoin(
        states,
        and(
          eq(states.reader, cursors.reader),
          state === undefined ? undefined : eq(states.state, state),
          entryId === undefined ? positionFilter || undefined : eq(states.entryId, entryId),
        ),
      )
      .where(eq(cursors.reader, reader))
      .orderBy(asc(states.position))
      .limit(limit + 1);
  });

  const readerPosition = page[0]?.readerPosition;
  const rows = page.flatMap(({ state }) => (state === null ? [] : [state]));
  const states = rows.slice(0, limit).map(toReaderState);
  const last = states.at(-1);
  return {
    states,
    ...(readerPosition === undefined ? {} : { readerPosition }),
    ...(rows.length > limit && last !== undefined ? { nextCursor: encodeCursor('states', last.position) } : {}),
  };
}

/**
 * Read and authorize one entry by ID without retaining a transaction during authorization.
 * @param host - Host journal database.
 * @param entryId - Exact entry ID.
 * @param mayRead - Authorization check for the stored entry.
 * @returns One visible entry or an empty page.
 */
async function readOneEntry(
  host: HostDatabase,
  entryId: string,
  mayRead: (entry: JournalEntry) => Promise<boolean>,
): Promise<JournalEntriesPage> {
  const [row] = await host.transaction(async (tx) => {
    const q = getTransactionQueryContext(tx);
    const { journalEntries: entries } = resolveSchema(q, journalStorageSchema);
    return await q.select().from(entries).where(eq(entries.entryId, entryId));
  });
  const entry = row === undefined ? undefined : toJournalEntry(row);
  return { entries: entry !== undefined && (await mayRead(entry)) ? [entry] : [] };
}

/** A bounded journal scan; only authorization, not SQL, decides which rows enter the page. */
interface EntryScan {
  readonly after?: number;
  readonly from: number;
  readonly through: number;
  readonly subject?: SubjectPattern;
}

/**
 * Read a bounded batch from the journal in position order.
 * @param host - Host journal database.
 * @param scan - Immutable upper bound and resume point of the scan.
 * @returns The stored journal rows in this batch.
 */
function readEntryBatch(host: HostDatabase, scan: EntryScan): Promise<JournalEntryRow[]> {
  return host.transaction(async (tx) => {
    const q = getTransactionQueryContext(tx);
    const { journalEntries: entries } = resolveSchema(q, journalStorageSchema);
    return await q
      .select()
      .from(entries)
      .where(
        and(
          scan.after === undefined ? gte(entries.position, scan.from) : gt(entries.position, scan.after),
          lte(entries.position, scan.through),
          selectSubjects(entries.subject, scan.subject === undefined ? undefined : [scan.subject]),
        ),
      )
      .orderBy(asc(entries.position))
      .limit(READER_BATCH_SIZE);
  });
}

/**
 * Read the committed high-water mark. Positions commit in order.
 * @param host - Host journal database.
 * @returns The highest committed position, or zero when the journal is empty.
 */
export function readJournalHead(host: HostDatabase): Promise<number> {
  return host.transaction(async (tx) => {
    const q = getTransactionQueryContext(tx);
    const { journalPositionCounter: counter } = resolveSchema(q, journalStorageSchema);
    const [row] = await q.select({ value: counter.value }).from(counter).where(eq(counter.id, 'journal'));
    return row?.value ?? 0;
  });
}

/**
 * Walk a position-bounded journal snapshot. Check each candidate outside the database transaction.
 * @param host - Host journal database.
 * @param input - Exact entry or paged query.
 * @param mayRead - Authorization check for the stored entry.
 * @returns A page containing only authorized entries.
 */
export async function queryEntries(
  host: HostDatabase,
  input: JournalEntriesRequest,
  mayRead: (entry: JournalEntry) => Promise<boolean>,
): Promise<JournalEntriesPage> {
  const query = JournalEntriesRequestSchema.parse(input);
  if ('entryId' in query) return readOneEntry(host, query.entryId, mayRead);

  const { from = 0, subject, cursor, limit = JOURNAL_PAGE_DEFAULT_LIMIT } = query;
  let after = cursor === undefined ? undefined : decodeCursor('entries', cursor);
  const through = await readJournalHead(host);
  const entries: JournalEntry[] = [];

  while (true) {
    const batch = await readEntryBatch(host, { from, after, through, subject });
    for (const row of batch) {
      const entry = toJournalEntry(row);
      if (await mayRead(entry)) {
        if (entries.length === limit && after !== undefined) {
          return { entries, nextCursor: encodeCursor('entries', after) };
        }
        entries.push(entry);
      }
      after = row.position;
    }
    if (batch.length < READER_BATCH_SIZE) return { entries };
  }
}

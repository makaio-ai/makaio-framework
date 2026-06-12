/* eslint max-lines: ["error", { "max": 420, "skipBlankLines": true, "skipComments": true }] */
import { eq, asc, desc, gt, lt, gte, lte, and, or, sql, count } from 'drizzle-orm';
import {
  getDatabaseDialect,
  getRawSqlExecutor,
  resolveSchema,
  sanitizeFtsQuery,
  type MakaioDatabase,
} from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionContext, SessionMessage, SessionMessageBlock } from '@makaio/contracts';
import { MessageStorageSubjects } from './namespace.js';
import type { SelectMessage } from './schema.js';
import { messagesSchema } from './schema.variants.js';
import { emitMessageSessionEvent } from './shared.js';
import { messageToCursor } from '@makaio/contracts';

/**
 * Shared dependencies for message handlers.
 */
interface MessageHandlerDeps {
  bus: IMakaioBus;
  db: MakaioDatabase;
}

/**
 * Convert database row to SessionMessage type.
 * @param row - Database row to convert
 * @returns SessionMessage object
 */
function rowToMessage(row: SelectMessage): SessionMessage {
  return {
    messageId: row.messageId,
    turnId: row.turnId,
    sessionId: row.sessionId,
    role: row.role as 'user' | 'assistant',
    contentText: row.contentText,
    blocks: JSON.parse(row.blocks) as SessionMessageBlock[],
    agentId: row.agentId ?? undefined,
    adapterSessionId: row.adapterSessionId ?? undefined,
    adapterMessageId: row.adapterMessageId ?? undefined,
    timestamp: row.timestamp,
    editOf: row.editOf ?? undefined,
    origin: row.origin ?? undefined,
  };
}

/**
 * Register handler for storage:message.append.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerAppendHandler(deps: MessageHandlerDeps): () => void {
  const { bus, db } = deps;
  const { messages } = resolveSchema(db, messagesSchema);

  return bus.on(MessageStorageSubjects.append, async (ctx) => {
    const { message: input, emitEvent } = ctx.payload;
    const messageId = input.messageId ?? crypto.randomUUID();

    const message: SessionMessage = {
      ...input,
      messageId,
      blocks: input.blocks ?? [],
    };

    await db.insert(messages).values({
      messageId,
      turnId: message.turnId,
      sessionId: message.sessionId,
      role: message.role,
      contentText: message.contentText,
      blocks: JSON.stringify(message.blocks),
      agentId: message.agentId ?? null,
      adapterSessionId: message.adapterSessionId ?? null,
      adapterMessageId: message.adapterMessageId ?? null,
      timestamp: message.timestamp,
      editOf: message.editOf ?? null,
      origin: message.origin ?? null,
    });

    ctx.setResult({ message });

    if (emitEvent ?? true) {
      await emitMessageSessionEvent(bus, message);
    }
  });
}

/**
 * Register handler for storage:message.getBySession.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetBySessionHandler(deps: MessageHandlerDeps): () => void {
  const { bus, db } = deps;
  const { messages } = resolveSchema(db, messagesSchema);

  return bus.on(MessageStorageSubjects.getBySession, async (ctx) => {
    const { sessionId, limit, after, includeAfter = false, order = 'asc' } = ctx.payload;
    const orderFn = order === 'desc' ? desc : asc;
    // "after" cursor means "continue past this timestamp" in the sort direction.
    // Callers can opt into an inclusive first page via includeAfter.

    let query = db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(orderFn(messages.timestamp), orderFn(messages.messageId));

    if (after) {
      const cursorPredicate =
        order === 'desc'
          ? or(
              lt(messages.timestamp, after.timestamp),
              and(
                eq(messages.timestamp, after.timestamp),
                includeAfter ? lte(messages.messageId, after.messageId) : lt(messages.messageId, after.messageId),
              ),
            )
          : or(
              gt(messages.timestamp, after.timestamp),
              and(
                eq(messages.timestamp, after.timestamp),
                includeAfter ? gte(messages.messageId, after.messageId) : gt(messages.messageId, after.messageId),
              ),
            );

      query = db
        .select()
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), cursorPredicate))
        .orderBy(orderFn(messages.timestamp), orderFn(messages.messageId));
    }

    const pageLimit = limit ?? 100;
    const rows = await (query.limit(pageLimit + 1) as typeof query);

    const hasMore = rows.length > pageLimit;
    const resultRows = hasMore ? rows.slice(0, pageLimit) : rows;
    const nextCursor = hasMore && resultRows.length > 0 ? messageToCursor(resultRows[resultRows.length - 1]) : null;

    ctx.setResult({
      messages: resultRows.map(rowToMessage),
      nextCursor,
    });
  });
}

/**
 * Register handler for storage:message.getByTurn.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetByTurnHandler(deps: MessageHandlerDeps): () => void {
  const { bus, db } = deps;
  const { messages } = resolveSchema(db, messagesSchema);

  return bus.on(MessageStorageSubjects.getByTurn, async (ctx) => {
    const { turnId } = ctx.payload;

    const rows = await db.select().from(messages).where(eq(messages.turnId, turnId)).orderBy(asc(messages.timestamp));

    ctx.setResult({ messages: rows.map(rowToMessage) });
  });
}

/**
 * Register handler for storage:message.get.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetHandler(deps: MessageHandlerDeps): () => void {
  const { bus, db } = deps;
  const { messages } = resolveSchema(db, messagesSchema);

  return bus.on(MessageStorageSubjects.get, async (ctx) => {
    const { messageId } = ctx.payload;

    const [row] = await db.select().from(messages).where(eq(messages.messageId, messageId)).limit(1);

    ctx.setResult({ message: row ? rowToMessage(row) : null });
  });
}

/**
 * Register handler for storage:message.search.
 *
 * On SQLite the search is performed via FTS5 with bm25 relevance ranking.
 * On Postgres the search uses the `content_tsv` stored generated tsvector column
 * and a GIN index, with ts_rank relevance ordering.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
// eslint-disable-next-line max-lines-per-function -- carries both full dialect implementations behind one registration seam
function registerSearchHandler(deps: MessageHandlerDeps): () => void {
  const { bus, db } = deps;

  const dialect = getDatabaseDialect(db);
  if (dialect === 'postgres') {
    return bus.on(MessageStorageSubjects.search, async (ctx) => {
      const { query, sessionId, limit } = ctx.payload;
      const pageLimit = limit ?? 50;

      // Short-circuit on empty/whitespace queries without a DB roundtrip.
      if (!query.trim()) {
        ctx.setResult({ messages: [], total: 0 });
        return;
      }

      // websearch_to_tsquery performs its own query parsing, so the FTS5
      // sanitizer is deliberately not applied on the Postgres path.
      const { messages } = resolveSchema(db, messagesSchema);
      const tsQuery = sql`websearch_to_tsquery('english', ${query})`;
      const matches = sql`content_tsv @@ ${tsQuery}`;
      const where = sessionId ? and(eq(messages.sessionId, sessionId), matches) : matches;

      const rows = await db
        .select()
        .from(messages)
        .where(where)
        .orderBy(sql`ts_rank(content_tsv, ${tsQuery}) DESC`, asc(messages.timestamp), asc(messages.messageId))
        .limit(pageLimit);

      const [countRow] = await db.select({ total: count() }).from(messages).where(where);

      ctx.setResult({
        messages: rows.map(rowToMessage),
        total: countRow?.total ?? 0,
      });
    });
  }

  return bus.on(MessageStorageSubjects.search, async (ctx) => {
    const { query, sessionId, limit } = ctx.payload;
    const pageLimit = limit ?? 50;

    // Short-circuit on empty/whitespace queries — sanitizeFtsQuery would
    // produce a quoted empty phrase that triggers invalid FTS5 MATCH.
    if (!query.trim()) {
      ctx.setResult({ messages: [], total: 0 });
      return;
    }

    const sanitized = sanitizeFtsQuery(query);

    // Use FTS5 content-backed table (joins via rowid, order by bm25 relevance).
    // Columns are aliased to camelCase to match SelectMessage / rowToMessage expectations.
    const SELECT_ALIASED = sql`
      m.message_id       AS messageId,
      m.turn_id          AS turnId,
      m.session_id       AS sessionId,
      m.role             AS role,
      m.content_text     AS contentText,
      m.blocks           AS blocks,
      m.agent_id         AS agentId,
      m.adapter_session_id AS adapterSessionId,
      m.adapter_message_id AS adapterMessageId,
      m.timestamp        AS timestamp,
      m.edit_of          AS editOf,
      m.origin           AS origin
    `;

    const ftsQuery = sessionId
      ? sql`
          SELECT ${SELECT_ALIASED}
          FROM messages m
          JOIN messages_fts fts ON m.rowid = fts.rowid
          WHERE messages_fts MATCH ${sanitized}
          AND fts.session_id = ${sessionId}
          ORDER BY bm25(messages_fts)
          LIMIT ${pageLimit}
        `
      : sql`
          SELECT ${SELECT_ALIASED}
          FROM messages m
          JOIN messages_fts fts ON m.rowid = fts.rowid
          WHERE messages_fts MATCH ${sanitized}
          ORDER BY bm25(messages_fts)
          LIMIT ${pageLimit}
        `;

    const rawSql = getRawSqlExecutor(db);
    const rows = await rawSql.all<SelectMessage>(ftsQuery);

    // Get total count
    const countQuery = sessionId
      ? sql`
          SELECT COUNT(*) as count FROM messages_fts
          WHERE messages_fts MATCH ${sanitized}
          AND session_id = ${sessionId}
        `
      : sql`
          SELECT COUNT(*) as count FROM messages_fts
          WHERE messages_fts MATCH ${sanitized}
        `;

    const [countRow] = await rawSql.all<{ count: number }>(countQuery);
    const total = countRow?.count ?? 0;

    ctx.setResult({
      messages: rows.map(rowToMessage),
      total,
    });
  });
}

type MessageFtsRow = {
  message_id: string;
  session_id: string;
  score: number;
  excerpt: string;
};

/**
 * Executes a BM25-ranked FTS5 search over messages.
 *
 * Supports optional scoping by `sessionId` (direct FTS column).
 * @param db - Drizzle database instance
 * @param sanitized - Already-sanitized FTS5 query string
 * @param limit - Maximum number of rows to return
 * @param sessionId - Optional session scope filter
 * @returns Ranked message FTS rows
 */
async function fetchFtsRows(
  db: MakaioDatabase,
  sanitized: string,
  limit: number,
  sessionId: string | undefined,
): Promise<MessageFtsRow[]> {
  const SELECT_COLS = sql`
    m.message_id AS message_id,
    fts.session_id AS session_id,
    -bm25(messages_fts) AS score,
    snippet(messages_fts, 1, '<mark>', '</mark>', '...', 40) AS excerpt
  FROM messages_fts fts
  JOIN messages m ON m.rowid = fts.rowid`;

  const rawSql = getRawSqlExecutor(db);
  if (sessionId !== undefined) {
    return rawSql.all<MessageFtsRow>(sql`
      SELECT ${SELECT_COLS}
      WHERE messages_fts MATCH ${sanitized}
        AND fts.session_id = ${sessionId}
      ORDER BY score DESC
      LIMIT ${limit}
    `);
  }
  return rawSql.all<MessageFtsRow>(sql`
    SELECT ${SELECT_COLS}
    WHERE messages_fts MATCH ${sanitized}
    ORDER BY score DESC
    LIMIT ${limit}
  `);
}

/**
 * Counts total FTS5 matches for a query, with optional scoping.
 * @param db - Drizzle database instance
 * @param sanitized - Already-sanitized FTS5 query string
 * @param sessionId - Optional session scope filter
 * @returns Total number of matching rows
 */
async function fetchFtsTotal(db: MakaioDatabase, sanitized: string, sessionId: string | undefined): Promise<number> {
  const rawSql = getRawSqlExecutor(db);
  const countRow = await (sessionId !== undefined
    ? rawSql.all<{ total: number }>(sql`
        SELECT COUNT(*) AS total
        FROM messages_fts
        WHERE messages_fts MATCH ${sanitized}
          AND session_id = ${sessionId}
      `)
    : rawSql.all<{ total: number }>(sql`
        SELECT COUNT(*) AS total
        FROM messages_fts
        WHERE messages_fts MATCH ${sanitized}
      `));
  return countRow[0]?.total ?? 0;
}

/**
 * Register handler for storage:message.ftsSearch with ranked excerpts.
 *
 * On SQLite the search uses FTS5 with bm25 scoring and the `snippet()` function.
 * On Postgres the search uses the `content_tsv` stored generated tsvector column
 * and a GIN index, with ts_rank scoring and ts_headline for excerpt generation.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerFtsSearchHandler(deps: MessageHandlerDeps): () => void {
  const { bus, db } = deps;

  const dialect = getDatabaseDialect(db);
  if (dialect === 'postgres') {
    return bus.on(MessageStorageSubjects.ftsSearch, async (ctx) => {
      const { query, sessionId, limit = 20 } = ctx.payload;

      const trimmed = query.trim();
      // Short-circuit on empty/whitespace queries without a DB roundtrip.
      if (!trimmed) {
        ctx.setResult({ results: [], total: 0 });
        return;
      }

      // websearch_to_tsquery performs its own query parsing, so the FTS5
      // sanitizer is deliberately not applied on the Postgres path.
      const { messages } = resolveSchema(db, messagesSchema);
      const tsQuery = sql`websearch_to_tsquery('english', ${trimmed})`;
      const matches = sql`content_tsv @@ ${tsQuery}`;
      const where = sessionId !== undefined ? and(eq(messages.sessionId, sessionId), matches) : matches;

      const rows = await db
        .select({
          messageId: messages.messageId,
          sessionId: messages.sessionId,
          score: sql<number>`ts_rank(content_tsv, ${tsQuery})`,
          excerpt: sql<string>`ts_headline('english', content_text, ${tsQuery}, 'StartSel=<mark>, StopSel=</mark>, MaxWords=40, MinWords=15')`,
        })
        .from(messages)
        .where(where)
        .orderBy(sql`ts_rank(content_tsv, ${tsQuery}) DESC`, asc(messages.timestamp), asc(messages.messageId))
        .limit(limit);

      const [countRow] = await db.select({ total: count() }).from(messages).where(where);

      ctx.setResult({
        results: rows,
        total: countRow?.total ?? 0,
      });
    });
  }

  return bus.on(MessageStorageSubjects.ftsSearch, async (ctx) => {
    const { query, sessionId, limit = 20 } = ctx.payload;

    const trimmed = query.trim();
    if (!trimmed) {
      ctx.setResult({ results: [], total: 0 });
      return;
    }

    const sanitized = sanitizeFtsQuery(trimmed);
    const [rows, total] = await Promise.all([
      fetchFtsRows(db, sanitized, limit, sessionId),
      fetchFtsTotal(db, sanitized, sessionId),
    ]);

    ctx.setResult({
      results: rows.map((row) => ({
        messageId: row.message_id,
        sessionId: row.session_id,
        score: row.score,
        excerpt: row.excerpt,
      })),
      total,
    });
  });
}

/**
 * Register handler for storage:message.getByAdapterMessageId.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetByAdapterMessageIdHandler(deps: MessageHandlerDeps): () => void {
  const { bus, db } = deps;
  const { messages } = resolveSchema(db, messagesSchema);

  return bus.on(MessageStorageSubjects.getByAdapterMessageId, async (ctx) => {
    const { adapterMessageId } = ctx.payload;

    const [row] = await db.select().from(messages).where(eq(messages.adapterMessageId, adapterMessageId)).limit(1);

    ctx.setResult({
      message: row ? rowToMessage(row) : null,
    });
  });
}

/**
 * Register handler for storage:message.upsertByAdapterMessageId.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerUpsertByAdapterMessageId(deps: MessageHandlerDeps): () => void {
  const { bus, db } = deps;
  const { messages } = resolveSchema(db, messagesSchema);

  return bus.on(MessageStorageSubjects.upsertByAdapterMessageId, async (ctx) => {
    const {
      adapterMessageId,
      sessionId,
      turnId,
      role,
      contentText,
      blocks,
      agentId,
      adapterSessionId,
      timestamp,
      origin,
    } = ctx.payload;

    // Check if message already exists by adapterMessageId
    const [existing] = await db
      .select({ messageId: messages.messageId })
      .from(messages)
      .where(eq(messages.adapterMessageId, adapterMessageId))
      .limit(1);

    if (existing) {
      // First import wins - return existing message ID
      ctx.setResult({ messageId: existing.messageId, created: false });
      return;
    }

    // Insert new message
    const messageId = crypto.randomUUID();
    await db.insert(messages).values({
      messageId,
      turnId,
      sessionId,
      role,
      contentText,
      blocks: JSON.stringify(blocks),
      agentId: agentId ?? null,
      adapterSessionId: adapterSessionId ?? null,
      adapterMessageId,
      timestamp,
      editOf: null,
      origin: origin ?? null,
    });

    ctx.setResult({ messageId, created: true });

    // Emit session event for unified history (only for newly created messages)
    const storedMessage: SessionMessage = {
      messageId,
      sessionId,
      turnId,
      role,
      contentText,
      blocks,
      agentId: agentId ?? undefined,
      adapterSessionId: adapterSessionId ?? undefined,
      adapterMessageId,
      timestamp,
      editOf: undefined,
      origin: origin ?? undefined,
    };
    await emitMessageSessionEvent(bus, storedMessage);
  });
}

/**
 * Register Drizzle-based message storage handlers.
 *
 * Manages message persistence via Drizzle ORM.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @param _ctx - Extension context (unused; reserved for future use)
 * @returns Cleanup function to unsubscribe all handlers
 */
export function registerDrizzleMessageStorage(bus: IMakaioBus, db: MakaioDatabase, _ctx: ExtensionContext): () => void {
  const deps: MessageHandlerDeps = { bus, db };
  const cleanups = [
    registerAppendHandler(deps),
    registerGetBySessionHandler(deps),
    registerGetByTurnHandler(deps),
    registerGetHandler(deps),
    registerSearchHandler(deps),
    registerFtsSearchHandler(deps),
    registerUpsertByAdapterMessageId(deps),
    registerGetByAdapterMessageIdHandler(deps),
  ];

  return () => cleanups.forEach((fn) => fn());
}

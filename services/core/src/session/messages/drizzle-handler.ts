import { eq, asc, desc, gt, lt, gte, lte, and, or } from 'drizzle-orm';
import { resolveSchema, resolveStorageEngine, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { SessionMessage, SessionMessageBlock } from '@makaio/contracts';
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
 * The ranked search itself is engine-owned (`StorageEngine.fts`): FTS5 with
 * bm25 relevance on SQLite, the `content_tsv` tsvector column with ts_rank
 * ordering on Postgres. The handler keeps payload defaults, the empty-query
 * short-circuit, and the row mapping.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerSearchHandler(deps: MessageHandlerDeps): () => void {
  const { bus, db } = deps;
  const { messages } = resolveSchema(db, messagesSchema);
  const fts = resolveStorageEngine(db).fts;

  return bus.on(MessageStorageSubjects.search, async (ctx) => {
    const { query, sessionId, limit } = ctx.payload;
    const pageLimit = limit ?? 50;

    // Short-circuit on empty/whitespace queries without a DB roundtrip.
    if (!query.trim()) {
      ctx.setResult({ messages: [], total: 0 });
      return;
    }

    const { rows, total } = await fts.searchMessages<SelectMessage>(db, messages, {
      query,
      sessionId,
      limit: pageLimit,
    });

    ctx.setResult({
      messages: rows.map(rowToMessage),
      total,
    });
  });
}

/**
 * Register handler for storage:message.ftsSearch with ranked excerpts.
 *
 * Excerpt generation is engine-owned (`StorageEngine.fts`): bm25 scoring with
 * `snippet()` on SQLite, ts_rank scoring with ts_headline on Postgres. The
 * handler keeps payload defaults and the empty-query short-circuit; excerpt
 * hits pass through unchanged.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerFtsSearchHandler(deps: MessageHandlerDeps): () => void {
  const { bus, db } = deps;
  const { messages } = resolveSchema(db, messagesSchema);
  const fts = resolveStorageEngine(db).fts;

  return bus.on(MessageStorageSubjects.ftsSearch, async (ctx) => {
    const { query, sessionId, limit = 20 } = ctx.payload;

    // Short-circuit on empty/whitespace queries without a DB roundtrip.
    if (!query.trim()) {
      ctx.setResult({ results: [], total: 0 });
      return;
    }

    const { results, total } = await fts.searchMessageExcerpts(db, messages, { query, sessionId, limit });

    ctx.setResult({ results, total });
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
 *
 * Idempotency semantics:
 * - Per-session first-import-wins pre-check: an existing row with the same
 *   adapterMessageId in the same session short-circuits.
 * - Hard per-session backstop: the insert targets the unique
 *   `(adapter_message_id, session_id)` index with `ON CONFLICT DO NOTHING`,
 *   so two concurrent imports of the same transcript record (hook trigger
 *   racing the watcher) can never produce duplicate rows — the loser reads
 *   the winner's row back and reports `created: false`.
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

    // Per-session pre-check: first import wins within a session.
    const [existing] = await db
      .select({ messageId: messages.messageId, turnId: messages.turnId })
      .from(messages)
      .where(and(eq(messages.adapterMessageId, adapterMessageId), eq(messages.sessionId, sessionId)))
      .limit(1);

    if (existing) {
      if (existing.turnId === null && turnId !== null) {
        await db.update(messages).set({ turnId }).where(eq(messages.messageId, existing.messageId));
      }
      ctx.setResult({ messageId: existing.messageId, created: false });
      return;
    }

    // Atomic insert-if-absent on the per-session unique index.
    const messageId = crypto.randomUUID();
    const inserted = await db
      .insert(messages)
      .values({
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
      })
      .onConflictDoNothing({ target: [messages.adapterMessageId, messages.sessionId] })
      .returning({ messageId: messages.messageId });

    if (inserted.length === 0) {
      // A concurrent upsert won the race between the pre-check and the insert.
      const [winner] = await db
        .select({ messageId: messages.messageId, turnId: messages.turnId })
        .from(messages)
        .where(and(eq(messages.adapterMessageId, adapterMessageId), eq(messages.sessionId, sessionId)))
        .limit(1);
      if (winner === undefined) {
        throw new Error('Message upsert conflict winner disappeared before reread completed');
      }
      if (winner.turnId === null && turnId !== null) {
        await db.update(messages).set({ turnId }).where(eq(messages.messageId, winner.messageId));
      }
      ctx.setResult({ messageId: winner.messageId, created: false });
      return;
    }

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
 * @returns Cleanup function to unsubscribe all handlers
 */
export function registerDrizzleMessageStorage(bus: IMakaioBus, db: MakaioDatabase): () => void {
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

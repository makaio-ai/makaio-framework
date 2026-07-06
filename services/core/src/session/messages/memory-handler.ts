import type { IMakaioBus } from '@makaio/bus-core';
import type { SessionMessage } from '@makaio/contracts';
import { MessageStorageSubjects } from './namespace.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { emitMessageSessionEvent } from './shared.js';
import { compareMessageCursorAsc, compareMessageCursorDesc, messageToCursor } from '@makaio/contracts';

/**
 * Sort messages by deterministic ascending pagination order.
 * @param a - First message
 * @param b - Second message
 * @returns Negative if a is before b, positive if a is after b
 */
function sortByTimestampAsc(a: SessionMessage, b: SessionMessage): number {
  return compareMessageCursorAsc(messageToCursor(a), messageToCursor(b));
}

/**
 * Sort messages by deterministic descending pagination order.
 * @param a - First message
 * @param b - Second message
 * @returns Positive if a is before b, negative if a is after b
 */
function sortByTimestampDesc(a: SessionMessage, b: SessionMessage): number {
  return compareMessageCursorDesc(messageToCursor(a), messageToCursor(b));
}

type MessageIdsBySessionAdapterMessageId = Map<string, Map<string, string>>;

/**
 * Get or create the adapter-message index for a session.
 * @param index - Session-scoped adapter-message index.
 * @param sessionId - Session identifier for the nested index.
 * @returns Mutable adapter-message map for the session.
 */
function getOrCreateSessionAdapterIndex(
  index: MessageIdsBySessionAdapterMessageId,
  sessionId: string,
): Map<string, string> {
  const existing = index.get(sessionId);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, string>();
  index.set(sessionId, created);
  return created;
}

/**
 * Attach an existing adapter-message row to a turn once a completed import
 * observes the turn boundary.
 * @param messagesById - Message lookup map.
 * @param messageIdsByTurn - Turn-to-message index.
 * @param messageId - Existing message row to update.
 * @param turnId - Turn to attach, or null when no turn is known.
 */
function attachExistingMessageToTurn(
  messagesById: Map<string, SessionMessage>,
  messageIdsByTurn: Map<string, string[]>,
  messageId: string,
  turnId: string | null,
): void {
  if (turnId === null) {
    return;
  }
  const message = messagesById.get(messageId);
  if (message === undefined || message.turnId !== null) {
    return;
  }

  message.turnId = turnId;
  const turnList = messageIdsByTurn.get(turnId) ?? [];
  if (!turnList.includes(messageId)) {
    turnList.push(messageId);
    messageIdsByTurn.set(turnId, turnList);
  }
}

/* eslint max-lines-per-function: ["error", { "max": 170 }] */
/**
 * Register in-memory message storage handlers.
 *
 * Intended for dev/test runtime usage. Durable storage is provided by the
 * Drizzle handlers in ./drizzle-handler.ts.
 * @param bus - The bus instance to register handlers on
 * @returns Cleanup function to unregister handlers
 */
export function registerMemoryMessageStorage(bus: IMakaioBus): () => void {
  const messagesById = new Map<string, SessionMessage>();
  const messageIdsBySession = new Map<string, string[]>();
  const messageIdsByTurn = new Map<string, string[]>();
  const messageIdsBySessionAdapterMessageId: MessageIdsBySessionAdapterMessageId = new Map();
  const indexMessage = createMessageIndexer(
    messagesById,
    messageIdsBySession,
    messageIdsByTurn,
    messageIdsBySessionAdapterMessageId,
  );

  const unsubs = [
    registerAppendHandler(bus, messagesById, indexMessage),
    registerGetBySessionHandler(bus, messagesById, messageIdsBySession),
    registerGetByTurnHandler(bus, messagesById, messageIdsByTurn),
    registerGetHandler(bus, messagesById),
    registerSearchHandler(bus, messagesById),
    registerUpsertByAdapterMessageIdHandler(
      bus,
      messagesById,
      messageIdsByTurn,
      messageIdsBySessionAdapterMessageId,
      indexMessage,
    ),
    registerCascadeDeleteHandler(
      bus,
      messagesById,
      messageIdsBySession,
      messageIdsByTurn,
      messageIdsBySessionAdapterMessageId,
    ),
  ];

  return () => unsubs.forEach((fn) => fn());
}

/**
 * Create an indexer for stored messages.
 * @param messagesById - Message lookup map
 * @param messageIdsBySession - Session-to-message index
 * @param messageIdsByTurn - Turn-to-message index
 * @param messageIdsBySessionAdapterMessageId - Session-scoped adapter message lookup map
 * @returns Indexer function
 */
function createMessageIndexer(
  messagesById: Map<string, SessionMessage>,
  messageIdsBySession: Map<string, string[]>,
  messageIdsByTurn: Map<string, string[]>,
  messageIdsBySessionAdapterMessageId: MessageIdsBySessionAdapterMessageId,
): (msg: SessionMessage) => void {
  return (msg) => {
    messagesById.set(msg.messageId, msg);

    const sessionList = messageIdsBySession.get(msg.sessionId) ?? [];
    sessionList.push(msg.messageId);
    messageIdsBySession.set(msg.sessionId, sessionList);

    if (msg.turnId) {
      const turnList = messageIdsByTurn.get(msg.turnId) ?? [];
      turnList.push(msg.messageId);
      messageIdsByTurn.set(msg.turnId, turnList);
    }

    if (msg.adapterMessageId) {
      getOrCreateSessionAdapterIndex(messageIdsBySessionAdapterMessageId, msg.sessionId).set(
        msg.adapterMessageId,
        msg.messageId,
      );
    }
  };
}

/**
 * Register handler for storage:message.append.
 * @param bus - The bus instance to register handlers on
 * @param messagesById - Message lookup map
 * @param indexMessage - Indexer function for messages
 * @returns Cleanup function to unregister the handler
 */
function registerAppendHandler(
  bus: IMakaioBus,
  messagesById: Map<string, SessionMessage>,
  indexMessage: (msg: SessionMessage) => void,
): () => void {
  return bus.on(MessageStorageSubjects.append, async (ctx) => {
    const { message: input, emitEvent } = ctx.payload;
    const messageId = input.messageId ?? crypto.randomUUID();

    const message: SessionMessage = {
      ...input,
      messageId,
      blocks: input.blocks ?? [],
    };

    indexMessage(message);
    ctx.setResult({ message });

    if (emitEvent ?? true) {
      await emitMessageSessionEvent(bus, message);
    }
  });
}

/**
 * Register handler for storage:message.getBySession.
 * @param bus - The bus instance to register handlers on
 * @param messagesById - Message lookup map
 * @param messageIdsBySession - Session-to-message index
 * @returns Cleanup function to unregister the handler
 */
function registerGetBySessionHandler(
  bus: IMakaioBus,
  messagesById: Map<string, SessionMessage>,
  messageIdsBySession: Map<string, string[]>,
): () => void {
  return bus.on(MessageStorageSubjects.getBySession, async (ctx) => {
    const { sessionId, limit, after, includeAfter = false, order = 'asc' } = ctx.payload;
    const ids = messageIdsBySession.get(sessionId) ?? [];
    const sortFn = order === 'desc' ? sortByTimestampDesc : sortByTimestampAsc;

    let msgs = ids
      .map((id) => messagesById.get(id))
      .filter((m): m is SessionMessage => !!m)
      .sort(sortFn);

    if (after) {
      // For desc order, cursor means "before this message"; for asc, "after".
      // includeAfter opts the first page into an inclusive boundary.
      msgs = msgs.filter((m) => {
        const comparison =
          order === 'desc'
            ? compareMessageCursorDesc(messageToCursor(m), after)
            : compareMessageCursorAsc(messageToCursor(m), after);
        return includeAfter ? comparison >= 0 : comparison > 0;
      });
    }

    const pageLimit = limit ?? 100;
    const hasMore = msgs.length > pageLimit;
    const page = hasMore ? msgs.slice(0, pageLimit) : msgs;
    const nextCursor = hasMore && page.length > 0 ? messageToCursor(page[page.length - 1]) : null;

    ctx.setResult({ messages: page, nextCursor });
  });
}

/**
 * Register handler for storage:message.getByTurn.
 * @param bus - The bus instance to register handlers on
 * @param messagesById - Message lookup map
 * @param messageIdsByTurn - Turn-to-message index
 * @returns Cleanup function to unregister the handler
 */
function registerGetByTurnHandler(
  bus: IMakaioBus,
  messagesById: Map<string, SessionMessage>,
  messageIdsByTurn: Map<string, string[]>,
): () => void {
  return bus.on(MessageStorageSubjects.getByTurn, async (ctx) => {
    const { turnId } = ctx.payload;
    const ids = messageIdsByTurn.get(turnId) ?? [];

    const msgs = ids
      .map((id) => messagesById.get(id))
      .filter((m): m is SessionMessage => !!m)
      .sort(sortByTimestampAsc);

    ctx.setResult({ messages: msgs });
  });
}

/**
 * Register handler for storage:message.get.
 * @param bus - The bus instance to register handlers on
 * @param messagesById - Message lookup map
 * @returns Cleanup function to unregister the handler
 */
function registerGetHandler(bus: IMakaioBus, messagesById: Map<string, SessionMessage>): () => void {
  return bus.on(MessageStorageSubjects.get, async (ctx) => {
    ctx.setResult({ message: messagesById.get(ctx.payload.messageId) ?? null });
  });
}

/**
 * Register handler for storage:message.search.
 * @param bus - The bus instance to register handlers on
 * @param messagesById - Message lookup map
 * @returns Cleanup function to unregister the handler
 */
function registerSearchHandler(bus: IMakaioBus, messagesById: Map<string, SessionMessage>): () => void {
  return bus.on(MessageStorageSubjects.search, async (ctx) => {
    const { query, sessionId, limit } = ctx.payload;
    const pageLimit = limit ?? 50;
    const q = query.trim().toLowerCase();

    const all = [...messagesById.values()].filter((m) => (sessionId ? m.sessionId === sessionId : true));
    const matches = q.length === 0 ? [] : all.filter((m) => m.contentText.toLowerCase().includes(q));
    matches.sort(sortByTimestampAsc);

    ctx.setResult({
      messages: matches.slice(0, pageLimit),
      total: matches.length,
    });
  });
}

/**
 * Register handler for storage:message.upsertByAdapterMessageId.
 * @param bus - The bus instance to register handlers on
 * @param messagesById - Message lookup map
 * @param messageIdsByTurn - Turn-to-message index
 * @param messageIdsBySessionAdapterMessageId - Session-scoped adapter message lookup map
 * @param indexMessage - Indexer function for messages
 * @returns Cleanup function to unregister the handler
 */
function registerUpsertByAdapterMessageIdHandler(
  bus: IMakaioBus,
  messagesById: Map<string, SessionMessage>,
  messageIdsByTurn: Map<string, string[]>,
  messageIdsBySessionAdapterMessageId: MessageIdsBySessionAdapterMessageId,
  indexMessage: (msg: SessionMessage) => void,
): () => void {
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

    const existing = messageIdsBySessionAdapterMessageId.get(sessionId)?.get(adapterMessageId);
    if (existing) {
      attachExistingMessageToTurn(messagesById, messageIdsByTurn, existing, turnId);
      ctx.setResult({ messageId: existing, created: false });
      return;
    }

    const messageId = crypto.randomUUID();
    const message: SessionMessage = {
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

    indexMessage(message);
    ctx.setResult({ messageId, created: true });

    await emitMessageSessionEvent(bus, message);
  });
}

/**
 * Register handler for storage:session.delete to cascade message cleanup.
 * @param bus - The bus instance to register handlers on
 * @param messagesById - Message lookup map
 * @param messageIdsBySession - Session-to-message index
 * @param messageIdsByTurn - Turn-to-message index
 * @param messageIdsBySessionAdapterMessageId - Session-scoped adapter message lookup map
 * @returns Cleanup function to unregister the handler
 */
function registerCascadeDeleteHandler(
  bus: IMakaioBus,
  messagesById: Map<string, SessionMessage>,
  messageIdsBySession: Map<string, string[]>,
  messageIdsByTurn: Map<string, string[]>,
  messageIdsBySessionAdapterMessageId: MessageIdsBySessionAdapterMessageId,
): () => void {
  return bus.on(SessionStorageSubjects.delete, (ctx) => {
    const { sessionId } = ctx.payload;
    const ids = messageIdsBySession.get(sessionId) ?? [];

    for (const messageId of ids) {
      const message = messagesById.get(messageId);
      if (!message) {
        continue;
      }

      messagesById.delete(messageId);

      if (message.turnId) {
        const turnIds = messageIdsByTurn.get(message.turnId) ?? [];
        const nextTurnIds = turnIds.filter((id) => id !== messageId);
        if (nextTurnIds.length === 0) {
          messageIdsByTurn.delete(message.turnId);
        } else {
          messageIdsByTurn.set(message.turnId, nextTurnIds);
        }
      }

      if (message.adapterMessageId) {
        const adapterIndex = messageIdsBySessionAdapterMessageId.get(message.sessionId);
        adapterIndex?.delete(message.adapterMessageId);
        if (adapterIndex?.size === 0) {
          messageIdsBySessionAdapterMessageId.delete(message.sessionId);
        }
      }
    }

    messageIdsBySession.delete(sessionId);
  });
}

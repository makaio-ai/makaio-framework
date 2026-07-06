import type { IMakaioBus } from '@makaio/bus-core';
import type { Turn } from '@makaio/contracts';
import { TurnStorageSubjects } from '../../turn/namespace.js';

/**
 * Register in-memory turn storage handlers.
 *
 * Suitable for development and tests. Data is lost on process exit.
 * @param bus - The bus instance to register handlers on
 * @returns Cleanup function to unsubscribe all handlers
 */
export function registerMemoryTurnStorage(bus: IMakaioBus): () => void {
  const turnsById = new Map<string, Turn>();
  const turnIdsBySession = new Map<string, string[]>();
  const maxTurnNumberBySession = new Map<string, number>();
  const indexTurn = createTurnIndexer(turnsById, turnIdsBySession, maxTurnNumberBySession);

  const turnIdsBySessionAnchor = new Map<string, Map<string, string>>();

  const unsubs = [
    registerCreateHandler(bus, indexTurn, maxTurnNumberBySession),
    registerIngestCompletedHandler(bus, turnsById, indexTurn, maxTurnNumberBySession, turnIdsBySessionAnchor),
    registerCompleteHandler(bus, turnsById, indexTurn),
    registerSetHandler(bus, indexTurn),
    registerGetHandler(bus, turnsById),
    registerGetBySessionHandler(bus, turnsById, turnIdsBySession),
    registerGetActiveHandler(bus, turnsById, turnIdsBySession),
    registerListActiveHandler(bus, turnsById),
  ];

  return () => unsubs.forEach((fn) => fn());
}

/**
 * Build a turn indexer for in-memory storage.
 *
 * Updates the id list, the by-id map, and the per-session max turnNumber so
 * that {@link registerCreateHandler} can always assign a strictly greater number
 * even after restore/set operations upsert turns with existing ordinals.
 * @param turnsById - Turn lookup map
 * @param turnIdsBySession - Session-to-turn index
 * @param maxTurnNumberBySession - Tracks highest assigned turnNumber per session
 * @returns Indexer function
 */
function createTurnIndexer(
  turnsById: Map<string, Turn>,
  turnIdsBySession: Map<string, string[]>,
  maxTurnNumberBySession: Map<string, number>,
): (turn: Turn) => void {
  return (turn) => {
    turnsById.set(turn.turnId, turn);
    const ids = turnIdsBySession.get(turn.sessionId) ?? [];
    if (!ids.includes(turn.turnId)) {
      ids.push(turn.turnId);
    }
    turnIdsBySession.set(turn.sessionId, ids);
    const currentMax = maxTurnNumberBySession.get(turn.sessionId) ?? 0;
    if (turn.turnNumber > currentMax) {
      maxTurnNumberBySession.set(turn.sessionId, turn.turnNumber);
    }
  };
}

/**
 * Register handler for storage:turn.create.
 *
 * Uses {@link maxTurnNumberBySession} (updated by the indexer on every write)
 * rather than the id-list length. This avoids reusing ordinals after
 * restore/set operations that upsert turns with existing turnNumbers.
 * @param bus - The bus instance to register handlers on
 * @param indexTurn - Indexer function for turns
 * @param maxTurnNumberBySession - Tracks highest assigned turnNumber per session
 * @returns Cleanup function to unregister the handler
 */
function registerCreateHandler(
  bus: IMakaioBus,
  indexTurn: (turn: Turn) => void,
  maxTurnNumberBySession: Map<string, number>,
): () => void {
  return bus.on(TurnStorageSubjects.create, (ctx) => {
    const { sessionId, turnId, initiator } = ctx.payload;
    const now = Date.now();
    const id = turnId ?? crypto.randomUUID();

    // Derive next ordinal from the highest known turnNumber for this session.
    const turnNumber = (maxTurnNumberBySession.get(sessionId) ?? 0) + 1;

    const turn: Turn = {
      turnId: id,
      sessionId,
      turnNumber,
      startedAt: now,
      status: 'active',
      ...(initiator !== undefined && { initiator }),
    };

    indexTurn(turn);
    ctx.setResult({ turn });
  });
}

/**
 * Register handler for storage:turn.ingestCompleted.
 *
 * Mirrors the Drizzle anchor-upsert semantics in memory: turns are keyed by
 * `(sessionId, turnAnchorId)`. A miss creates the turn with the next per-session
 * ordinal; a hit updates completion fields only (`completedAt`, `status`,
 * `error`, `usage`) and never changes `turnId`, `turnNumber`, `startedAt`, or
 * `initiator` — `(sessionId, turnNumber)` is a stable downstream watermark.
 * @param bus - The bus instance to register handlers on
 * @param turnsById - Turn lookup map
 * @param indexTurn - Indexer function for turns
 * @param maxTurnNumberBySession - Tracks highest assigned turnNumber per session
 * @param turnIdsBySessionAnchor - Nested session/anchor index for completed-turn ingestion
 * @returns Cleanup function to unregister the handler
 */
function registerIngestCompletedHandler(
  bus: IMakaioBus,
  turnsById: Map<string, Turn>,
  indexTurn: (turn: Turn) => void,
  maxTurnNumberBySession: Map<string, number>,
  turnIdsBySessionAnchor: Map<string, Map<string, string>>,
): () => void {
  return bus.on(TurnStorageSubjects.ingestCompleted, (ctx) => {
    const { sessionId, turnAnchorId, startedAt, completedAt, status, error, usage, initiator } = ctx.payload;
    const sessionAnchors = turnIdsBySessionAnchor.get(sessionId) ?? new Map<string, string>();

    const existingTurnId = sessionAnchors.get(turnAnchorId);
    if (existingTurnId !== undefined) {
      const existing = turnsById.get(existingTurnId);
      if (!existing) {
        throw new Error(`Turn not found for anchor in session: ${sessionId}`);
      }

      // Re-ingestion: update completion fields only; identity and ordinal stay.
      const updated: Turn = {
        ...existing,
        completedAt,
        status,
        error: error ?? undefined,
        usage: usage ?? undefined,
      };
      indexTurn(updated);
      ctx.setResult({ turn: updated, created: false });
      return;
    }

    const turn: Turn = {
      turnId: crypto.randomUUID(),
      sessionId,
      turnNumber: (maxTurnNumberBySession.get(sessionId) ?? 0) + 1,
      startedAt,
      completedAt,
      status,
      error: error ?? undefined,
      usage: usage ?? undefined,
      ...(initiator !== undefined && { initiator }),
    };

    indexTurn(turn);
    sessionAnchors.set(turnAnchorId, turn.turnId);
    turnIdsBySessionAnchor.set(sessionId, sessionAnchors);
    ctx.setResult({ turn, created: true });
  });
}

/**
 * Register handler for storage:turn.complete.
 * @param bus - The bus instance to register handlers on
 * @param turnsById - Turn lookup map
 * @param indexTurn - Indexer function for turns
 * @returns Cleanup function to unregister the handler
 */
function registerCompleteHandler(
  bus: IMakaioBus,
  turnsById: Map<string, Turn>,
  indexTurn: (turn: Turn) => void,
): () => void {
  return bus.on(TurnStorageSubjects.complete, (ctx) => {
    const { turnId, status, expectedStatus, error, usage } = ctx.payload;
    const existing = turnsById.get(turnId);
    if (!existing) {
      throw new Error(`Turn not found: ${turnId}`);
    }

    if (expectedStatus && existing.status !== expectedStatus) {
      ctx.setResult({ turn: existing, transitioned: false });
      return;
    }

    const isTerminal = existing.status === 'completed' || existing.status === 'error';
    const updated: Turn = isTerminal
      ? {
          ...existing,
          usage: usage ?? existing.usage,
        }
      : {
          ...existing,
          completedAt: Date.now(),
          status,
          error: error ?? undefined,
          usage: usage ?? existing.usage,
        };

    indexTurn(updated);
    ctx.setResult({ turn: updated, transitioned: !isTerminal });
  });
}

/**
 * Register handler for storage:turn.set.
 * @param bus - The bus instance to register handlers on
 * @param indexTurn - Indexer function for turns
 * @returns Cleanup function to unregister the handler
 */
function registerSetHandler(bus: IMakaioBus, indexTurn: (turn: Turn) => void): () => void {
  return bus.on(TurnStorageSubjects.set, (ctx) => {
    const { turn } = ctx.payload;
    indexTurn(turn);
    ctx.setResult({ turn });
  });
}

/**
 * Register handler for storage:turn.get.
 * @param bus - The bus instance to register handlers on
 * @param turnsById - Turn lookup map
 * @returns Cleanup function to unregister the handler
 */
function registerGetHandler(bus: IMakaioBus, turnsById: Map<string, Turn>): () => void {
  return bus.on(TurnStorageSubjects.get, (ctx) => {
    ctx.setResult({ turn: turnsById.get(ctx.payload.turnId) ?? null });
  });
}

/**
 * Register handler for storage:turn.getBySession.
 * @param bus - The bus instance to register handlers on
 * @param turnsById - Turn lookup map
 * @param turnIdsBySession - Session-to-turn index
 * @returns Cleanup function to unregister the handler
 */
function registerGetBySessionHandler(
  bus: IMakaioBus,
  turnsById: Map<string, Turn>,
  turnIdsBySession: Map<string, string[]>,
): () => void {
  return bus.on(TurnStorageSubjects.getBySession, (ctx) => {
    const { sessionId, status, limit } = ctx.payload;
    const ids = turnIdsBySession.get(sessionId) ?? [];
    let turns = ids.map((id) => turnsById.get(id)).filter((t): t is Turn => Boolean(t));

    if (status) {
      turns = turns.filter((turn) => turn.status === status);
    }

    turns.sort((a, b) => a.turnNumber - b.turnNumber);

    if (limit) {
      turns = turns.slice(0, limit);
    }

    ctx.setResult({ turns });
  });
}

/**
 * Register handler for storage:turn.getActive.
 * @param bus - The bus instance to register handlers on
 * @param turnsById - Turn lookup map
 * @param turnIdsBySession - Session-to-turn index
 * @returns Cleanup function to unregister the handler
 */
function registerGetActiveHandler(
  bus: IMakaioBus,
  turnsById: Map<string, Turn>,
  turnIdsBySession: Map<string, string[]>,
): () => void {
  return bus.on(TurnStorageSubjects.getActive, (ctx) => {
    const { sessionId } = ctx.payload;
    const ids = turnIdsBySession.get(sessionId) ?? [];
    const turns = ids.map((id) => turnsById.get(id)).filter((t): t is Turn => Boolean(t));
    const active = turns
      .filter((turn) => turn.status === 'active')
      .sort((a, b) => b.turnNumber - a.turnNumber)
      .at(0);
    ctx.setResult({ turn: active ?? null });
  });
}

/**
 * Register handler for storage:turn.listActive.
 *
 * Returns all turns with status 'active' across all sessions.
 * Used at startup to identify orphaned turns from a prior process crash.
 * @param bus - The bus instance to register handlers on
 * @param turnsById - Turn lookup map
 * @returns Cleanup function to unregister the handler
 */
function registerListActiveHandler(bus: IMakaioBus, turnsById: Map<string, Turn>): () => void {
  return bus.on(TurnStorageSubjects.listActive, (ctx) => {
    const active = [...turnsById.values()]
      .filter((turn) => turn.status === 'active')
      .sort((a, b) => a.startedAt - b.startedAt);
    ctx.setResult({ turns: active });
  });
}

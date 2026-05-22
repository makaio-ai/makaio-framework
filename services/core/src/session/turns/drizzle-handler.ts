import { eq, and, asc, desc, sql } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { TurnUsageSchema, type ExtensionContext, type Turn, type TurnStatus, type TurnUsage } from '@makaio/contracts';
import { TurnStorageSubjects } from '../../turn/namespace.js';
import { turns, type SelectTurn } from './schema.js';

/**
 * Parse stored usage JSON into a TurnUsage object.
 * @param usage - Stored usage JSON string
 * @returns Parsed usage or undefined if invalid
 */
function parseUsage(usage: string | null): TurnUsage | undefined {
  if (!usage) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(usage);
    const result = TurnUsageSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Convert database row to Turn type.
 * @param row - Database row to convert
 * @returns Turn object
 */
function rowToTurn(row: SelectTurn): Turn {
  return {
    turnId: row.turnId,
    sessionId: row.sessionId,
    turnNumber: row.turnNumber,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    status: row.status as TurnStatus,
    error: row.error ?? undefined,
    usage: parseUsage(row.usage),
  };
}

/**
 * Register Drizzle-based turn storage handlers.
 *
 * Manages turn lifecycle in SQLite/libSQL via Drizzle ORM.
 *
 * CONCURRENCY INVARIANT: All handlers must use single-statement operations only.
 * Storage handlers share a single DB connection. Fire-and-forget bus events
 * (e.g., agent.added) race with sequential RPC handlers (e.g., turn.create).
 * db.transaction() holds write locks across await boundaries, causing SQLITE_BUSY
 * deadlocks on the same connection. Single statements serialize automatically
 * via SQLite's busy_timeout + WAL mode.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @param _ctx - Extension context (unused; reserved for future use)
 * @returns Cleanup function to unsubscribe all handlers
 */
export function registerDrizzleTurnStorage(bus: IMakaioBus, db: MakaioDatabase, _ctx: ExtensionContext): () => void {
  const unsubs = [
    registerCreateHandler(bus, db),
    registerCompleteHandler(bus, db),
    registerSetHandler(bus, db),
    registerGetHandler(bus, db),
    registerGetBySessionHandler(bus, db),
    registerGetActiveHandler(bus, db),
    registerListActiveHandler(bus, db),
  ];

  return () => unsubs.forEach((fn) => fn());
}

/**
 * Register handler for storage:turn.create.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @returns Cleanup function to unregister the handler
 */
function registerCreateHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  return bus.on(TurnStorageSubjects.create, async (ctx) => {
    const { sessionId, turnId } = ctx.payload;
    const now = Date.now();
    const id = turnId ?? crypto.randomUUID();

    // Atomic turn number assignment via CTE-based INSERT (single statement).
    // Eliminates the SELECT MAX + INSERT race: concurrent inserts for the same
    // session both read the MAX before either inserts, producing duplicate turnNumbers.
    // libsql does not support subqueries in INSERT VALUES position; a CTE-based
    // INSERT...SELECT is the equivalent single-statement form.
    // The unique index on (sessionId, turnNumber) enforces the invariant at the DB level.
    await db.run(sql`
      WITH next_num AS (
        SELECT COALESCE(MAX(turn_number), 0) + 1 AS n
        FROM turns
        WHERE session_id = ${sessionId}
      )
      INSERT INTO turns (turn_id, session_id, turn_number, started_at, status)
      SELECT ${id}, ${sessionId}, n, ${now}, ${'active'}
      FROM next_num
    `);

    // Read back the assigned turnNumber — the CTE result isn't returned by INSERT.
    const [inserted] = await db.select({ turnNumber: turns.turnNumber }).from(turns).where(eq(turns.turnId, id));

    const turn: Turn = {
      turnId: id,
      sessionId,
      turnNumber: inserted.turnNumber,
      startedAt: now,
      status: 'active',
    };

    ctx.setResult({ turn });
  });
}

/**
 * Register handler for storage:turn.complete.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @returns Cleanup function to unregister the handler
 */
function registerCompleteHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  return bus.on(TurnStorageSubjects.complete, async (ctx) => {
    const { turnId, status, expectedStatus, error, usage } = ctx.payload;
    const now = Date.now();
    const updateFields: Partial<typeof turns.$inferInsert> = {
      completedAt: now,
      status,
      error: error ?? null,
    };

    if (usage !== undefined) {
      updateFields.usage = JSON.stringify(usage);
    }

    const whereClause = expectedStatus
      ? and(eq(turns.turnId, turnId), eq(turns.status, expectedStatus))
      : eq(turns.turnId, turnId);

    const updatedRows = await db.update(turns).set(updateFields).where(whereClause).returning();

    if (updatedRows.length > 0) {
      ctx.setResult({ turn: rowToTurn(updatedRows[0]), transitioned: true });
      return;
    }

    const [row] = await db.select().from(turns).where(eq(turns.turnId, turnId)).limit(1);

    if (!row) {
      throw new Error(`Turn not found: ${turnId}`);
    }

    ctx.setResult({ turn: rowToTurn(row), transitioned: false });
  });
}

/**
 * Register handler for storage:turn.set.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @returns Cleanup function to unregister the handler
 */
function registerSetHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  return bus.on(TurnStorageSubjects.set, async (ctx) => {
    const { turn } = ctx.payload;
    const values: typeof turns.$inferInsert = {
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      turnNumber: turn.turnNumber,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt ?? null,
      status: turn.status,
      error: turn.error ?? null,
      usage: turn.usage ? JSON.stringify(turn.usage) : null,
    };

    await db.insert(turns).values(values).onConflictDoUpdate({ target: turns.turnId, set: values });

    ctx.setResult({ turn });
  });
}

/**
 * Register handler for storage:turn.get.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @returns Cleanup function to unregister the handler
 */
function registerGetHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  return bus.on(TurnStorageSubjects.get, async (ctx) => {
    const { turnId } = ctx.payload;

    const [row] = await db.select().from(turns).where(eq(turns.turnId, turnId)).limit(1);

    ctx.setResult({ turn: row ? rowToTurn(row) : null });
  });
}

/**
 * Register handler for storage:turn.getBySession.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @returns Cleanup function to unregister the handler
 */
function registerGetBySessionHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  return bus.on(TurnStorageSubjects.getBySession, async (ctx) => {
    const { sessionId, limit, status } = ctx.payload;

    let query = db.select().from(turns).where(eq(turns.sessionId, sessionId)).orderBy(asc(turns.turnNumber));

    if (status) {
      query = db
        .select()
        .from(turns)
        .where(and(eq(turns.sessionId, sessionId), eq(turns.status, status)))
        .orderBy(asc(turns.turnNumber));
    }

    if (limit) {
      query = query.limit(limit) as typeof query;
    }

    const rows = await query;
    ctx.setResult({ turns: rows.map(rowToTurn) });
  });
}

/**
 * Register handler for storage:turn.getActive.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @returns Cleanup function to unregister the handler
 */
function registerGetActiveHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  return bus.on(TurnStorageSubjects.getActive, async (ctx) => {
    const { sessionId } = ctx.payload;

    const [row] = await db
      .select()
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.status, 'active')))
      .orderBy(desc(turns.turnNumber))
      .limit(1);

    ctx.setResult({ turn: row ? rowToTurn(row) : null });
  });
}

/**
 * Register handler for storage:turn.listActive.
 *
 * Returns all turns with status 'active' across all sessions, ordered by startedAt.
 * Intentionally unbounded: this query runs once at startup to identify orphaned turns
 * from a prior process crash. Under normal operation, the result set is small (only
 * turns left active by an unclean shutdown). A large result set indicates a systemic
 * bug in turn finalization, not a query that needs capping.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @returns Cleanup function to unregister the handler
 */
function registerListActiveHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  return bus.on(TurnStorageSubjects.listActive, async (ctx) => {
    const rows = await db.select().from(turns).where(eq(turns.status, 'active')).orderBy(asc(turns.startedAt));
    ctx.setResult({ turns: rows.map(rowToTurn) });
  });
}

import { eq, and, asc, desc, sql, type SQL } from 'drizzle-orm';
import {
  getRawSqlExecutor,
  getStorageEngine,
  resolveSchema,
  type MakaioDatabase,
  type RawSqlExecutor,
} from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  TurnInitiatorSchema,
  TurnUsageSchema,
  type Turn,
  type TurnInitiator,
  type TurnStatus,
  type TurnUsage,
} from '@makaio/contracts';
import { TurnStorageSubjects } from '../../turn/namespace.js';
import type { SelectTurn } from './schema.js';
import { turnsSchema } from './schema.variants.js';

/**
 * The canonical `turns` table type. {@link resolveSchema} returns the
 * SQLite-typed face for both dialects, so `.sqlite` names the type of the
 * resolved table under either dialect — it is not a SQLite-only assumption.
 */
type TurnsTable = typeof turnsSchema.sqlite.turns;

/**
 * Unique index enforcing one turn number per session — the retry target of
 * the turn-create statement (declared in the turns schema on both dialects).
 */
const TURN_NUMBER_UNIQUE_INDEX = 'uniq_turns_session_number';

/**
 * Bound for the turn-create retry loop. Every retry implies a concurrent
 * create for the same session committed in between (global progress is
 * guaranteed: each conflicting round has exactly one winner), so the bound
 * is effectively the number of simultaneously in-flight creates per session.
 */
const TURN_CREATE_MAX_ATTEMPTS = 32;

/**
 * Run a CTE-based turn insert with bounded retry for dialects where MAX-based
 * turn-number assignment can race under concurrent writes.
 * @param rawSql - Raw SQL executor for the active database
 * @param buildStatement - Builds the INSERT statement for the current attempt
 */
async function runTurnNumberInsertWithRetry(rawSql: RawSqlExecutor, buildStatement: () => SQL): Promise<void> {
  const engine = getStorageEngine(rawSql.dialect);

  for (let attempt = 1; ; attempt++) {
    try {
      await rawSql.run(buildStatement());
      return;
    } catch (error) {
      if (
        attempt >= TURN_CREATE_MAX_ATTEMPTS ||
        !engine.capabilities.maxCounterAssignmentRaces ||
        !engine.errors.isUniqueViolationError(error, TURN_NUMBER_UNIQUE_INDEX)
      ) {
        throw error;
      }
    }
  }
}

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
 * Serialize turn initiator metadata for storage.
 * @param initiator - Turn initiator metadata
 * @returns JSON blob for persistence, or null when absent
 */
function serializeInitiator(initiator: TurnInitiator | undefined): string | null {
  return initiator ? JSON.stringify(initiator) : null;
}

/**
 * Parse stored initiator JSON into a TurnInitiator object.
 * @param initiator - Stored initiator JSON value
 * @returns Parsed initiator or undefined if absent/invalid
 */
function parseInitiator(initiator: string | null): TurnInitiator | undefined {
  if (!initiator) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(initiator);
    const result = TurnInitiatorSchema.safeParse(parsed);
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
  const initiator = parseInitiator(row.initiator);
  return {
    turnId: row.turnId,
    sessionId: row.sessionId,
    turnNumber: row.turnNumber,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    status: row.status as TurnStatus,
    error: row.error ?? undefined,
    usage: parseUsage(row.usage),
    ...(initiator !== undefined && { initiator }),
  };
}

/**
 * Register Drizzle-based turn storage handlers.
 *
 * Manages turn lifecycle via Drizzle ORM.
 *
 * CONCURRENCY INVARIANT: All handlers must use single-statement operations only.
 * Storage handlers share a single DB connection. Fire-and-forget bus events
 * (e.g., agent.added) race with sequential RPC handlers (e.g., turn.create).
 * db.transaction() holds write locks across await boundaries, causing SQLITE_BUSY
 * deadlocks on the same connection. Single statements serialize automatically
 * via SQLite's busy_timeout + WAL mode.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @returns Cleanup function to unsubscribe all handlers
 */
export function registerDrizzleTurnStorage(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const unsubs = [
    registerCreateHandler(bus, db),
    registerIngestCompletedHandler(bus, db),
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
  const rawSql = getRawSqlExecutor(db);
  const { turns } = resolveSchema(db, turnsSchema);

  return bus.on(TurnStorageSubjects.create, async (ctx) => {
    const { sessionId, turnId, initiator } = ctx.payload;
    const now = Date.now();
    const id = turnId ?? crypto.randomUUID();
    const serializedInitiator = serializeInitiator(initiator);

    // Turn number assignment via CTE-based INSERT (single statement) plus a
    // bounded retry on unique-violation:
    // - Engines whose writes serialize at the connection level (SQLite) make
    //   the statement atomic, so the first attempt always succeeds and the
    //   statement stream is unchanged. (libsql does not support subqueries in
    //   INSERT VALUES position; the CTE-based INSERT...SELECT is the
    //   equivalent single-statement form.)
    // - Engines whose concurrency model lets MAX-based assignment race report
    //   it via capabilities.maxCounterAssignmentRaces. The concrete instance
    //   is Postgres under READ COMMITTED: two concurrent statements evaluate
    //   MAX against snapshots that exclude each other's uncommitted rows and
    //   compute the same number. The unique index on (sessionId, turnNumber)
    //   converts that race into a unique violation, which is retried with a
    //   fresh MAX — preserving a contiguous 1..N sequence without a
    //   transaction or per-session lock.
    // The retry is gated on the capability and scoped to the turn-number
    // index via the engine's classifier: where the race is impossible, any
    // unique violation (e.g. a caller-supplied duplicate turnId) rethrows
    // immediately.
    await runTurnNumberInsertWithRetry(
      rawSql,
      () => sql`
          WITH next_num AS (
            SELECT COALESCE(MAX(turn_number), 0) + 1 AS n
            FROM turns
            WHERE session_id = ${sessionId}
          )
          INSERT INTO turns (turn_id, session_id, turn_number, started_at, status, initiator)
          SELECT ${id}, ${sessionId}, n, ${now}, ${'active'}, ${serializedInitiator}
          FROM next_num
        `,
    );

    // Read back the assigned turnNumber — the CTE result isn't returned by INSERT.
    const [inserted] = await db.select({ turnNumber: turns.turnNumber }).from(turns).where(eq(turns.turnId, id));

    const turn: Turn = {
      turnId: id,
      sessionId,
      turnNumber: inserted.turnNumber,
      startedAt: now,
      status: 'active',
      ...(initiator !== undefined && { initiator }),
    };

    ctx.setResult({ turn });
  });
}

/**
 * Register handler for storage:turn.ingestCompleted.
 *
 * Idempotent upsert of an externally-completed turn keyed on
 * `(sessionId, turnAnchorId)`. Mirrors {@link registerCreateHandler}'s
 * CTE-based single-statement turn-number assignment, extended with an
 * `ON CONFLICT` clause on the anchor index:
 *
 * - First ingestion inserts the row with `turnNumber = MAX + 1`.
 * - Re-ingestion of the same anchor updates completion fields only
 *   (`completed_at`, `status`, `error`, `usage`) and never touches
 *   `turn_id`, `turn_number`, `started_at`, or `initiator` —
 *   `(sessionId, turnNumber)` is a stable downstream watermark.
 *
 * The `WHERE true` disambiguator is required by SQLite's parser for
 * `INSERT ... SELECT` combined with `ON CONFLICT` (and is a no-op on
 * Postgres). The bounded retry loop targets ONLY the turn-number index:
 * anchor conflicts are absorbed by `ON CONFLICT`; a turn-number race
 * (Postgres READ COMMITTED, see {@link registerCreateHandler}) retries
 * with a fresh MAX; any other unique violation rethrows.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @returns Cleanup function to unregister the handler
 */
function registerIngestCompletedHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const rawSql = getRawSqlExecutor(db);
  const { turns } = resolveSchema(db, turnsSchema);

  return bus.on(TurnStorageSubjects.ingestCompleted, async (ctx) => {
    const { sessionId, turnAnchorId, startedAt, completedAt, status, error, usage, initiator } = ctx.payload;
    const candidateId = crypto.randomUUID();
    const serializedInitiator = serializeInitiator(initiator);
    const serializedUsage = usage !== undefined ? JSON.stringify(usage) : null;

    await runTurnNumberInsertWithRetry(
      rawSql,
      () => sql`
          WITH next_num AS (
            SELECT COALESCE(MAX(turn_number), 0) + 1 AS n
            FROM turns
            WHERE session_id = ${sessionId}
          )
          INSERT INTO turns (turn_id, session_id, turn_number, started_at, completed_at, status, error, usage, initiator, turn_anchor_id)
          SELECT ${candidateId}, ${sessionId}, n, ${startedAt}, ${completedAt}, ${status}, ${error ?? null}, ${serializedUsage}, ${serializedInitiator}, ${turnAnchorId}
          FROM next_num
          WHERE true
          ON CONFLICT(session_id, turn_anchor_id) DO UPDATE SET
            completed_at = excluded.completed_at,
            status = excluded.status,
            error = excluded.error,
            usage = excluded.usage
        `,
    );

    // Read back by the anchor key — on conflict the surviving row keeps its
    // original turnId, which is how first-ingestion is detected.
    const [row] = await db
      .select()
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.turnAnchorId, turnAnchorId)))
      .limit(1);

    ctx.setResult({ turn: rowToTurn(row), created: row.turnId === candidateId });
  });
}

/**
 * Register handler for storage:turn.complete.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @returns Cleanup function to unregister the handler
 */
function registerCompleteHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { turns } = resolveSchema(db, turnsSchema);
  return bus.on(TurnStorageSubjects.complete, async (ctx) => {
    const { turnId, status, expectedStatus, error, usage } = ctx.payload;
    const now = Date.now();

    const transitionWhere = expectedStatus
      ? and(
          eq(turns.turnId, turnId),
          eq(turns.status, expectedStatus),
          sql`${turns.status} not in ('completed', 'error')`,
        )
      : and(eq(turns.turnId, turnId), sql`${turns.status} not in ('completed', 'error')`);
    const transitionFields: Partial<TurnsTable['$inferInsert']> = {
      completedAt: now,
      status,
      error: error ?? null,
      ...(usage !== undefined && { usage: JSON.stringify(usage) }),
    };
    const [transitionedRow] = await db.update(turns).set(transitionFields).where(transitionWhere).returning();
    if (transitionedRow) {
      ctx.setResult({ turn: rowToTurn(transitionedRow), transitioned: true });
      return;
    }

    const [existingRow] = await db.select().from(turns).where(eq(turns.turnId, turnId)).limit(1);
    if (!existingRow) {
      throw new Error(`Turn not found: ${turnId}`);
    }

    if (expectedStatus) {
      ctx.setResult({ turn: rowToTurn(existingRow), transitioned: false });
      return;
    }

    const isTerminal = existingRow.status === 'completed' || existingRow.status === 'error';
    if (!isTerminal || usage === undefined) {
      ctx.setResult({ turn: rowToTurn(existingRow), transitioned: false });
      return;
    }

    const [updatedRow] = await db
      .update(turns)
      .set({ usage: JSON.stringify(usage) })
      .where(and(eq(turns.turnId, turnId), sql`${turns.status} in ('completed', 'error')`))
      .returning();

    ctx.setResult({ turn: rowToTurn(updatedRow ?? existingRow), transitioned: false });
  });
}

/**
 * Register handler for storage:turn.set.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @returns Cleanup function to unregister the handler
 */
function registerSetHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { turns } = resolveSchema(db, turnsSchema);
  return bus.on(TurnStorageSubjects.set, async (ctx) => {
    const { turn } = ctx.payload;
    const values: TurnsTable['$inferInsert'] = {
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      turnNumber: turn.turnNumber,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt ?? null,
      status: turn.status,
      error: turn.error ?? null,
      usage: turn.usage ? JSON.stringify(turn.usage) : null,
      initiator: serializeInitiator(turn.initiator),
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
  const { turns } = resolveSchema(db, turnsSchema);
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
  const { turns } = resolveSchema(db, turnsSchema);
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
  const { turns } = resolveSchema(db, turnsSchema);
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
  const { turns } = resolveSchema(db, turnsSchema);
  return bus.on(TurnStorageSubjects.listActive, async (ctx) => {
    const rows = await db.select().from(turns).where(eq(turns.status, 'active')).orderBy(asc(turns.startedAt));
    ctx.setResult({ turns: rows.map(rowToTurn) });
  });
}

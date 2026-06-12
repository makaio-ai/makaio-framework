/**
 * Drizzle-based storage handlers for supervisor runtime subjects.
 *
 * Provides persistent storage for supervisor runtime metadata using Drizzle
 * ORM. Each handler responds to a bus subject and delegates to the
 * `supervisor_runtimes` table. The dialect-correct table objects are resolved
 * at registration time via {@link resolveSchema}.
 *
 * Scrollback and terminal output are NOT stored here.
 * @packageDocumentation
 */

import { eq, type SQL } from 'drizzle-orm';
import { resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { SupervisorRuntimeStorageSubjects } from './namespace.js';
import { supervisorRuntimesSchema } from './schema.variants.js';
import { runtimeToRow, rowToRuntime } from './map-runtime.js';

/**
 * The canonical `supervisorRuntimes` table type. {@link resolveSchema} returns
 * the SQLite-typed face for both dialects (`DialectSchema` intentionally types
 * its `postgres` record as the SQLite one), so `.sqlite` names the type of the
 * resolved table under either dialect — it is not a SQLite-only assumption.
 */
type SupervisorRuntimesTable = typeof supervisorRuntimesSchema.sqlite.supervisorRuntimes;

// ---------------------------------------------------------------------------
// Per-subject handler factories
// ---------------------------------------------------------------------------

/**
 * Register the `get` storage handler.
 * @param bus - The Makaio bus instance.
 * @param db - Drizzle database instance.
 * @returns Unsubscribe function.
 */
function registerGetHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { supervisorRuntimes } = resolveSchema(db, supervisorRuntimesSchema);
  return bus.on(SupervisorRuntimeStorageSubjects.get, async (ctx) => {
    const locator = ctx.payload;

    const predicate: SQL =
      'supervisorSessionId' in locator
        ? eq(supervisorRuntimes.supervisorSessionId, locator.supervisorSessionId)
        : 'sessionId' in locator
          ? eq(supervisorRuntimes.sessionId, locator.sessionId)
          : eq(supervisorRuntimes.adapterSessionId, locator.adapterSessionId);

    const rows = await db.select().from(supervisorRuntimes).where(predicate).limit(1);
    const row = rows[0];
    ctx.setResult({ runtime: row !== undefined ? rowToRuntime(row) : null });
  });
}

/**
 * Register the `set` storage handler.
 * @param bus - The Makaio bus instance.
 * @param db - Drizzle database instance.
 * @returns Unsubscribe function.
 */
function registerSetHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { supervisorRuntimes } = resolveSchema(db, supervisorRuntimesSchema);
  return bus.on(SupervisorRuntimeStorageSubjects.set, async (ctx) => {
    const row = runtimeToRow(ctx.payload);

    await db
      .insert(supervisorRuntimes)
      .values(row)
      .onConflictDoUpdate({
        target: supervisorRuntimes.supervisorSessionId,
        set: {
          clientId: row.clientId,
          pid: row.pid,
          status: row.status,
          cwd: row.cwd,
          command: row.command,
          argsJson: row.argsJson,
          envJson: row.envJson,
          sessionId: row.sessionId,
          adapterSessionId: row.adapterSessionId,
          startedAt: row.startedAt,
          stoppedAt: row.stoppedAt,
          metadataJson: row.metadataJson,
        },
      });

    ctx.setResult({ success: true });
  });
}

/**
 * Register the `update` storage handler.
 * @param bus - The Makaio bus instance.
 * @param db - Drizzle database instance.
 * @returns Unsubscribe function.
 */
function registerUpdateHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { supervisorRuntimes } = resolveSchema(db, supervisorRuntimesSchema);
  return bus.on(SupervisorRuntimeStorageSubjects.update, async (ctx) => {
    const { supervisorSessionId, pid, status, sessionId, adapterSessionId, stoppedAt, metadata } = ctx.payload;

    const updateValues: Partial<SupervisorRuntimesTable['$inferInsert']> = {};

    if (pid !== undefined) updateValues.pid = pid;
    if (status !== undefined) updateValues.status = status;
    if (sessionId !== undefined) updateValues.sessionId = sessionId;
    if (adapterSessionId !== undefined) updateValues.adapterSessionId = adapterSessionId;
    if (stoppedAt !== undefined) updateValues.stoppedAt = stoppedAt;
    if (metadata !== undefined) updateValues.metadataJson = JSON.stringify(metadata);

    if (Object.keys(updateValues).length === 0) {
      ctx.setResult({ success: true });
      return;
    }

    const updated = await db
      .update(supervisorRuntimes)
      .set(updateValues)
      .where(eq(supervisorRuntimes.supervisorSessionId, supervisorSessionId))
      .returning({ supervisorSessionId: supervisorRuntimes.supervisorSessionId });

    ctx.setResult({ success: updated.length > 0 });
  });
}

/**
 * Register the `delete` storage handler.
 * @param bus - The Makaio bus instance.
 * @param db - Drizzle database instance.
 * @returns Unsubscribe function.
 */
function registerDeleteHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { supervisorRuntimes } = resolveSchema(db, supervisorRuntimesSchema);
  return bus.on(SupervisorRuntimeStorageSubjects.delete, async (ctx) => {
    const deleted = await db
      .delete(supervisorRuntimes)
      .where(eq(supervisorRuntimes.supervisorSessionId, ctx.payload.supervisorSessionId))
      .returning({ supervisorSessionId: supervisorRuntimes.supervisorSessionId });

    ctx.setResult({ success: deleted.length > 0 });
  });
}

/**
 * Register the `list` storage handler.
 * @param bus - The Makaio bus instance.
 * @param db - Drizzle database instance.
 * @returns Unsubscribe function.
 */
function registerListHandler(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { supervisorRuntimes } = resolveSchema(db, supervisorRuntimesSchema);
  return bus.on(SupervisorRuntimeStorageSubjects.list, async (ctx) => {
    const { status, limit } = ctx.payload;

    const statusPredicate = status !== undefined ? eq(supervisorRuntimes.status, status) : undefined;
    const baseQuery = statusPredicate
      ? db.select().from(supervisorRuntimes).where(statusPredicate)
      : db.select().from(supervisorRuntimes);

    const rows = await (limit !== undefined ? baseQuery.limit(limit) : baseQuery);
    ctx.setResult({ runtimes: rows.map(rowToRuntime) });
  });
}

// ---------------------------------------------------------------------------
// Public registration entry-point
// ---------------------------------------------------------------------------

/**
 * Registers Drizzle-based bus storage handlers for supervisor runtime subjects.
 *
 * Handles the full CRUD lifecycle:
 * - `get` — lookup by supervisorSessionId, sessionId, or adapterSessionId
 * - `set` — upsert (insert or replace) a full runtime record
 * - `update` — apply a partial update to an existing record
 * - `delete` — remove a record by supervisorSessionId
 * - `list` — list all (or status-filtered) runtimes as full records
 * @param bus - The Makaio bus instance.
 * @param db - Drizzle database instance.
 * @returns Cleanup function that unregisters all handlers.
 */
export function registerDrizzleSupervisorRuntimeStorage(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const unsubGet = registerGetHandler(bus, db);
  const unsubSet = registerSetHandler(bus, db);
  const unsubUpdate = registerUpdateHandler(bus, db);
  const unsubDelete = registerDeleteHandler(bus, db);
  const unsubList = registerListHandler(bus, db);

  return () => {
    unsubGet();
    unsubSet();
    unsubUpdate();
    unsubDelete();
    unsubList();
  };
}

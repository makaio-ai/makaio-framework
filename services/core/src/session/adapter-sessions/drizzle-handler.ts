import { and, desc, eq, sql } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionContext } from '@makaio/contracts';
import { AdapterSubjects } from '@makaio/contracts';
import { AdapterSessionStorageNamespace, AdapterSessionStorageSubjects } from './namespace.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { MessageStorageSubjects } from '../messages/namespace.js';
import type { SelectAdapterSession } from './schema.js';

/** Shared dependencies for adapter session handlers */
interface AdapterSessionHandlerDeps {
  bus: IMakaioBus;
  db: MakaioDatabase;
}

/**
 * Monotonic timestamp source for adapter-session discovery writes.
 *
 * `Date.now()` can repeat within the same millisecond; upsert created-detection
 * relies on comparing returned discoveredAt against the attempted insert value.
 * This guarantees a strictly increasing integer per process.
 */
let lastDiscoveredAt = 0;

/**
 * Returns a strictly increasing discoveredAt timestamp in milliseconds.
 * @returns Monotonic timestamp value
 */
function nextDiscoveredAt(): number {
  const now = Date.now();
  lastDiscoveredAt = now > lastDiscoveredAt ? now : lastDiscoveredAt + 1;
  return lastDiscoveredAt;
}

/**
 * Convert database row to response shape.
 * @param row - Database row to convert
 * @returns Session-shaped adapter record containing identity, lineage,
 * runtime metadata, discovery timestamps, status, and kind fields.
 */
function rowToSession(row: SelectAdapterSession) {
  return {
    adapterSessionId: row.adapterSessionId,
    adapterName: row.adapterName,
    parentAdapterSessionId: row.parentAdapterSessionId,
    forkPointMessageId: row.forkPointMessageId,
    sessionId: row.sessionId,
    model: row.model,
    cwd: row.cwd,
    logFilePath: row.logFilePath,
    discoveredAt: row.discoveredAt,
    startedAt: row.startedAt,
    status: row.status,
    kind: row.kind,
  };
}

/**
 * Register handler for storage:adapterSession.upsert.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerUpsertHandler(deps: AdapterSessionHandlerDeps): () => void {
  const { bus, db } = deps;
  const { adapterSessions } = AdapterSessionStorageNamespace.extensions.drizzle!;

  return bus.on(AdapterSessionStorageSubjects.upsert, async (ctx) => {
    const {
      adapterSessionId,
      adapterName,
      parentAdapterSessionId,
      forkPointMessageId,
      model,
      cwd,
      logFilePath,
      kind,
      startedAt,
    } = ctx.payload;

    // Single-statement upsert — avoids SELECT+INSERT/UPDATE race on the shared
    // SQLite connection (see lessons-learned: SQLite Single-Connection Concurrency).
    // COALESCE preserves existing non-null values for nullable enrichment fields.
    // discoveredAt is NOT updated on conflict, allowing us to detect new rows:
    // if the returned discoveredAt equals nowMs, the row was just inserted.
    const nowMs = nextDiscoveredAt();

    const [row] = await db
      .insert(adapterSessions)
      .values({
        adapterSessionId,
        adapterName,
        parentAdapterSessionId,
        forkPointMessageId,
        model: model ?? null,
        cwd: cwd ?? null,
        logFilePath: logFilePath ?? null,
        kind,
        discoveredAt: nowMs,
        startedAt: startedAt ?? nowMs,
        status: 'discovered',
      })
      .onConflictDoUpdate({
        target: adapterSessions.adapterSessionId,
        set: {
          parentAdapterSessionId,
          forkPointMessageId,
          model: sql`COALESCE(excluded.model, ${adapterSessions.model})`,
          cwd: sql`COALESCE(excluded.cwd, ${adapterSessions.cwd})`,
          logFilePath: sql`COALESCE(excluded.log_file_path, ${adapterSessions.logFilePath})`,
          startedAt:
            startedAt === undefined
              ? sql`${adapterSessions.startedAt}`
              : sql`CASE
                  WHEN ${adapterSessions.startedAt} = ${adapterSessions.discoveredAt}
                    THEN ${startedAt}
                  ELSE ${adapterSessions.startedAt}
                END`,
          kind,
        },
      })
      .returning({
        adapterSessionId: adapterSessions.adapterSessionId,
        sessionId: adapterSessions.sessionId,
        discoveredAt: adapterSessions.discoveredAt,
      });

    // If discoveredAt equals nowMs, the row was freshly inserted (not a conflict update).
    const created = row.discoveredAt === nowMs;

    ctx.setResult({ adapterSessionId: row.adapterSessionId, sessionId: row.sessionId, created });
  });
}

/**
 * Register handler for storage:adapterSession.updateStatus.
 *
 * Updates the status column and emits an `adapter.session.statusChanged` event
 * so the entity cache reacts to import-status transitions.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerUpdateStatusHandler(deps: AdapterSessionHandlerDeps): () => void {
  const { bus, db } = deps;
  const { adapterSessions } = AdapterSessionStorageNamespace.extensions.drizzle!;

  return bus.on(AdapterSessionStorageSubjects.updateStatus, async (ctx) => {
    const { adapterSessionId, status } = ctx.payload;

    const result = await db
      .update(adapterSessions)
      .set({ status })
      .where(and(eq(adapterSessions.adapterSessionId, adapterSessionId), sql`${adapterSessions.status} <> ${status}`));

    // SQLite returns rowsAffected, check if any rows were updated
    const success = result.rowsAffected > 0;
    ctx.setResult({ success });

    if (success) {
      // Emit lifecycle event so the entity cache reacts to status transitions.
      // Fire-and-forget: UI reactivity is best-effort; caller does not need to await.
      void bus
        .emit(AdapterSubjects.session.statusChanged, { adapterSessionId, status })
        .catch((err) => console.error('[AdapterSessionStorage] Failed to emit statusChanged event:', err));
    }
  });
}

/**
 * Register handler for storage:adapterSession.linkSession.
 *
 * Links an adapter session to a Makaio session and emits `adapter.session.linked`.
 * The event intentionally omits `adapterId` — linkage can occur before the adapter
 * instance is configured. Also normalizes `forkPointMessageId` from adapter message ID
 * to Makaio message ID when a corresponding message exists.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerLinkSessionHandler(deps: AdapterSessionHandlerDeps): () => void {
  const { bus, db } = deps;
  const { adapterSessions } = AdapterSessionStorageNamespace.extensions.drizzle!;

  return bus.on(AdapterSessionStorageSubjects.linkSession, async (ctx) => {
    const { adapterSessionId, sessionId } = ctx.payload;

    // Query the adapter session to get adapterName, current sessionId, and forkPointMessageId
    const [row] = await db
      .select({
        adapterName: adapterSessions.adapterName,
        currentSessionId: adapterSessions.sessionId,
        forkPointMessageId: adapterSessions.forkPointMessageId,
      })
      .from(adapterSessions)
      .where(eq(adapterSessions.adapterSessionId, adapterSessionId))
      .limit(1);

    if (!row) {
      ctx.setResult({ success: false });
      return;
    }

    // Idempotent: already linked to same session → success, no event
    if (row.currentSessionId === sessionId) {
      ctx.setResult({ success: true });
      return;
    }

    // Error: already linked to a different session
    if (row.currentSessionId !== null) {
      ctx.setResult({ success: false });
      return;
    }

    // Transition from null → sessionId.
    await db.update(adapterSessions).set({ sessionId }).where(eq(adapterSessions.adapterSessionId, adapterSessionId));

    await bus.emit(AdapterSubjects.session.linked, {
      adapterName: row.adapterName,
      adapterSessionId,
      sessionId,
    });

    // Normalize forkPointMessageId from adapter message ID to Makaio message ID
    // and propagate to main session if present
    if (row.forkPointMessageId) {
      let normalizedForkPointMessageId = row.forkPointMessageId;

      try {
        const { message } = await bus.request(MessageStorageSubjects.getByAdapterMessageId, {
          adapterMessageId: row.forkPointMessageId,
        });
        if (message) {
          normalizedForkPointMessageId = message.messageId;
        }
      } catch {
        // Message lookup failed (e.g., no handler registered, message not imported yet)
        // Fall back to adapter message ID - will be normalized later if message is imported
      }

      try {
        // Adapter-session linkage is the source of truth. Session fork metadata propagation
        // is best-effort so linkSession remains idempotent even if dependent handlers fail.
        await bus.request(SessionStorageSubjects.update, {
          sessionId,
          forkPointMessageId: normalizedForkPointMessageId,
        });
      } catch {
        // Best-effort: keep successful link even when session metadata update cannot run.
      }
    }

    ctx.setResult({ success: true });
  });
}

/**
 * Register Drizzle-based adapter session storage handlers.
 *
 * Manages adapter session persistence in SQLite/libSQL via Drizzle ORM.
 * Adapter sessions track sessions discovered from external adapter logs
 * and maintain lineage information for fork detection.
 * @param bus - The bus instance to register handlers on
 * @param db - The Drizzle database instance
 * @param _ctx - Extension context (unused; reserved for future use)
 * @returns Cleanup function to unsubscribe all handlers
 */
export function registerDrizzleAdapterSessionStorage(
  bus: IMakaioBus,
  db: MakaioDatabase,
  _ctx: ExtensionContext,
): () => void {
  const { adapterSessions } = AdapterSessionStorageNamespace.extensions.drizzle!;
  const unsubs: Array<() => void> = [];

  // storage:adapterSession.upsert
  unsubs.push(registerUpsertHandler({ bus, db }));

  // storage:adapterSession.get
  unsubs.push(
    bus.on(AdapterSessionStorageSubjects.get, async (ctx) => {
      const { adapterSessionId } = ctx.payload;

      const [row] = await db
        .select()
        .from(adapterSessions)
        .where(eq(adapterSessions.adapterSessionId, adapterSessionId))
        .limit(1);

      ctx.setResult({
        session: row ? rowToSession(row) : null,
      });
    }),
  );

  // storage:adapterSession.updateStatus
  unsubs.push(registerUpdateStatusHandler({ bus, db }));

  // storage:adapterSession.list
  unsubs.push(
    bus.on(AdapterSessionStorageSubjects.list, async (ctx) => {
      const rows = await db.select().from(adapterSessions).orderBy(desc(adapterSessions.startedAt));

      ctx.setResult({
        sessions: rows.map(rowToSession),
      });
    }),
  );

  // storage:adapterSession.getByLogFilePath
  unsubs.push(
    bus.on(AdapterSessionStorageSubjects.getByLogFilePath, async (ctx) => {
      const { logFilePath } = ctx.payload;

      // log_file_path is unique for disk-backed imports, so this lookup is deterministic.
      const [row] = await db
        .select()
        .from(adapterSessions)
        .where(eq(adapterSessions.logFilePath, logFilePath))
        .limit(1);

      ctx.setResult({
        session: row ? rowToSession(row) : null,
      });
    }),
  );

  // storage:adapterSession.linkSession
  unsubs.push(registerLinkSessionHandler({ bus, db }));

  // storage:adapterSession.countByAdapter
  unsubs.push(
    bus.on(AdapterSessionStorageSubjects.countByAdapter, async (ctx) => {
      const { adapterName } = ctx.payload;

      // Count total, imported/tracking, and discovered in a single query
      const rows = await db
        .select({
          status: adapterSessions.status,
          count: sql<number>`count(*)`,
        })
        .from(adapterSessions)
        .where(eq(adapterSessions.adapterName, adapterName))
        .groupBy(adapterSessions.status);

      let total = 0;
      let imported = 0;
      let discovered = 0;

      for (const row of rows) {
        const count = Number(row.count);
        total += count;
        if (row.status === 'imported' || row.status === 'tracking') imported += count;
        if (row.status === 'discovered') discovered = count;
      }

      ctx.setResult({ total, imported, discovered });
    }),
  );

  return () => unsubs.forEach((fn) => fn());
}

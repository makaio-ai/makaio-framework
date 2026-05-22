import { eq } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionContext } from '@makaio/contracts';
import { LogImportSubjects } from '../namespace.js';
import type { LogImportSettings } from '../schemas/index.js';
import { logImportSettings } from './schema.js';
import type { SelectLogImportSettings } from './schema.js';

/** Shared dependencies for log-import storage handlers. */
interface LogImportHandlerDeps {
  bus: IMakaioBus;
  db: MakaioDatabase;
}

/**
 * Maps a database row to the {@link LogImportSettings} API type.
 *
 * Exported so the host-owned scoped-settings handler can reuse the same
 * mapping when it falls back to the framework global row.
 * @param row - Database row from `log_import_settings`
 * @returns Mapped `LogImportSettings` object
 */
export function rowToSettings(row: SelectLogImportSettings): LogImportSettings {
  return {
    adapterName: row.adapterName,
    mode: row.mode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Registers the `log-import.getMode` handler.
 *
 * Looks up the global (adapter-level) row in `log_import_settings`. Returns
 * `'disabled'` when no row exists. Project-scoped overrides are handled by the
 * host-owned priority-100 handler which calls `ctx.next()` to reach this
 * framework default.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerGetModeHandler(deps: LogImportHandlerDeps): () => void {
  const { bus, db } = deps;

  return bus.on(LogImportSubjects.getMode, async (ctx) => {
    const { adapterName } = ctx.payload;

    const [row] = await db
      .select()
      .from(logImportSettings)
      .where(eq(logImportSettings.adapterName, adapterName))
      .limit(1);

    ctx.setResult({ mode: row?.mode ?? 'disabled' });
  });
}

/**
 * Registers the `log-import.setMode` handler.
 *
 * Upserts the global adapter row in `log_import_settings`. Project-scoped
 * writes are handled by the host-owned priority-100 handler which intercepts
 * requests carrying a `projectId` before they reach this framework default.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerSetModeHandler(deps: LogImportHandlerDeps): () => void {
  const { bus, db } = deps;

  return bus.on(LogImportSubjects.setMode, async (ctx) => {
    const { adapterName, mode } = ctx.payload;
    const now = Date.now();

    await db
      .insert(logImportSettings)
      .values({
        adapterName,
        mode,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: logImportSettings.adapterName,
        set: {
          mode,
          updatedAt: now,
        },
      });

    ctx.setResult({ success: true });
  });
}

/**
 * Registers the `log-import.listSettings` handler.
 *
 * Returns all rows from the `log_import_settings` table mapped to the
 * {@link LogImportSettings} API type. Only global adapter rows are included;
 * project-scoped rows live in the host-owned `log_import_scoped_settings`
 * table.
 * @param deps - Handler dependencies (bus and db)
 * @returns Cleanup function to unsubscribe the handler
 */
function registerListSettingsHandler(deps: LogImportHandlerDeps): () => void {
  const { bus, db } = deps;

  return bus.on(LogImportSubjects.listSettings, async (ctx) => {
    const rows = await db.select().from(logImportSettings);
    ctx.setResult({ settings: rows.map(rowToSettings) });
  });
}

/**
 * Registers all Drizzle-based log-import settings storage handlers with the bus.
 *
 * Handles `getMode`, `setMode`, and `listSettings` operations for the
 * `log_import_settings` table.
 * @param bus - MakaioBus instance for message handling
 * @param db - Drizzle database instance
 * @param _ctx - Extension context (unused; reserved for future use)
 * @returns Cleanup function to unregister all handlers
 */
export function registerDrizzleLogImportStorage(
  bus: IMakaioBus,
  db: MakaioDatabase,
  _ctx: ExtensionContext,
): () => void {
  const deps: LogImportHandlerDeps = { bus, db };
  const cleanups = [registerGetModeHandler(deps), registerSetModeHandler(deps), registerListSettingsHandler(deps)];
  return () => cleanups.forEach((fn) => fn());
}

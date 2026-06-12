/**
 * Drizzle handler for import cursor storage.
 *
 * Provides persistent cursor tracking for log import resume.
 * @packageDocumentation
 */

import { eq } from 'drizzle-orm';
import { didAffectRows, resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionContext } from '@makaio/contracts';
import { ImportCursorStorageSubjects } from '@makaio/ai-adapters-core';
import { importCursorsSchema } from './schema.variants.js';

/**
 * Register Drizzle-backed import cursor storage handlers.
 *
 * Provides persistent cursor storage for efficient log import resume.
 * On restart, import continues from the last processed byte offset.
 * @param bus - The bus instance to register handlers on
 * @param db - Drizzle database instance
 * @param _ctx - Extension context (unused; reserved for future use)
 * @returns Cleanup function to unsubscribe all handlers
 * @example
 * ```typescript
 * import { registerDrizzleImportCursorStorage } from '@makaio/services-core/session';
 *
 * const cleanup = registerDrizzleImportCursorStorage(bus, db, ctx);
 *
 * // Later, when shutting down:
 * cleanup();
 * ```
 */
export function registerDrizzleImportCursorStorage(
  bus: IMakaioBus,
  db: MakaioDatabase,
  _ctx: ExtensionContext,
): () => void {
  const { importCursors } = resolveSchema(db, importCursorsSchema);
  const unsubs: Array<() => void> = [];

  // storage:importCursor.get
  unsubs.push(
    bus.on(ImportCursorStorageSubjects.get, async (ctx) => {
      const { filePath } = ctx.payload;

      const rows = await db.select().from(importCursors).where(eq(importCursors.filePath, filePath)).limit(1);

      const row = rows[0];
      if (!row) {
        ctx.setResult({ cursor: null });
        return;
      }

      ctx.setResult({
        cursor: {
          filePath: row.filePath,
          bytesRead: row.bytesRead,
          lastModified: row.lastModified,
        },
      });
    }),
  );

  // storage:importCursor.set
  unsubs.push(
    bus.on(ImportCursorStorageSubjects.set, async (ctx) => {
      const { filePath, bytesRead, lastModified } = ctx.payload;

      await db
        .insert(importCursors)
        .values({
          filePath,
          bytesRead,
          lastModified,
          updatedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: importCursors.filePath,
          set: {
            bytesRead,
            lastModified,
            updatedAt: Date.now(),
          },
        });

      ctx.setResult({ success: true });
    }),
  );

  // storage:importCursor.delete
  unsubs.push(
    bus.on(ImportCursorStorageSubjects.delete, async (ctx) => {
      const { filePath } = ctx.payload;

      const result = await db.delete(importCursors).where(eq(importCursors.filePath, filePath));

      ctx.setResult({ success: didAffectRows(result) });
    }),
  );

  return () => {
    unsubs.forEach((unsub) => unsub());
  };
}

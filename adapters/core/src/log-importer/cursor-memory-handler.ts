/**
 * In-memory handler for import cursor storage.
 *
 * Provides a simple Map-based implementation for development and testing.
 * Data is lost when the process exits.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { ImportCursorStorageSubjects } from './cursor-storage.js';
import type { ImportCursorPosition } from './types.js';

/**
 * Register in-memory import cursor storage handlers.
 *
 * Suitable for development, testing, and single-instance deployments.
 * For production with persistence, implement a file-based or database-backed handler.
 * @param bus - The bus instance to register handlers on
 * @returns Cleanup function to unsubscribe all handlers
 * @example
 * ```typescript
 * import { registerMemoryImportCursorStorage } from '@makaio/ai-adapters-core';
 *
 * const cleanup = registerMemoryImportCursorStorage(bus);
 *
 * // Later, when shutting down:
 * cleanup();
 * ```
 */
export function registerMemoryImportCursorStorage(bus: IMakaioBus): () => void {
  const cursors = new Map<string, ImportCursorPosition>();
  const unsubs: Array<() => void> = [];

  // storage:importCursor.get
  unsubs.push(
    bus.on(ImportCursorStorageSubjects.get, (ctx) => {
      const { filePath } = ctx.payload;
      const cursor = cursors.get(filePath) ?? null;
      ctx.setResult({ cursor });
    }),
  );

  // storage:importCursor.set
  unsubs.push(
    bus.on(ImportCursorStorageSubjects.set, (ctx) => {
      const { filePath, bytesRead, lastModified } = ctx.payload;
      cursors.set(filePath, { filePath, bytesRead, lastModified });
      ctx.setResult({ success: true });
    }),
  );

  // storage:importCursor.delete
  unsubs.push(
    bus.on(ImportCursorStorageSubjects.delete, (ctx) => {
      const { filePath } = ctx.payload;
      const existed = cursors.delete(filePath);
      ctx.setResult({ success: existed });
    }),
  );

  return () => {
    unsubs.forEach((unsub) => unsub());
    cursors.clear();
  };
}

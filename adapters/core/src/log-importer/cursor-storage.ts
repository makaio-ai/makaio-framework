import { z } from 'zod';
import { createStorageNamespaceDefinition } from '@makaio/storage-core';

import type { ImportCursorPosition } from './types.js';

/**
 * Zod schema for session context stored with cursor (for incremental imports).
 *
 * Uses z.custom<T>() because the session context contains complex types
 * (SubjectDefinition, NormalizedEvent) that can't be expressed in Zod.
 * Runtime validation is skipped; type safety is preserved at compile time.
 */
const SessionContextSchema = z.custom<NonNullable<ImportCursorPosition['sessionContext']>>(() => true);

/**
 * Zod schema for import cursor position.
 *
 * Mirrors the {@link ImportCursorPosition} interface for runtime validation.
 * Used in storage requests and responses.
 */
export const ImportCursorPositionSchema = z.object({
  /** Absolute path to the log file being tracked */
  filePath: z.string(),

  /** Number of bytes successfully read and processed */
  bytesRead: z.number(),

  /** ISO 8601 timestamp of file's last modification when cursor was saved */
  lastModified: z.string(),

  /**
   * Session context for incremental imports (persisted on first read).
   * Contains adapter-specific state needed to resume processing mid-session.
   */
  sessionContext: SessionContextSchema.optional(),
});

/**
 * Import cursor storage namespace.
 *
 * Provides bus subjects for tracking import progress within external log files.
 * Cursors enable resumption from the last successfully processed position
 * after restarts, preventing duplicate event emission.
 * @remarks
 * Storage domain: `storage:importCursor`
 *
 * Cursors track byte offsets rather than line numbers for efficiency.
 * The `lastModified` timestamp enables detection of file truncation/rotation:
 * if the file's mtime is older than the stored cursor, the file was likely
 * rotated and should be re-read from the beginning.
 * @example
 * ```typescript
 * import { ImportCursorStorageSubjects } from '@makaio/ai-adapters-core';
 *
 * // Get cursor for file (returns null if not found)
 * const result = await bus.request(ImportCursorStorageSubjects.get, {
 *   filePath: '/home/user/.claude/projects/foo/session.jsonl',
 * });
 *
 * if (result.cursor) {
 *   console.log(`Resuming from byte ${result.cursor.bytesRead}`);
 * }
 *
 * // Update cursor after processing
 * await bus.request(ImportCursorStorageSubjects.set, {
 *   filePath: '/home/user/.claude/projects/foo/session.jsonl',
 *   bytesRead: 12345,
 *   lastModified: '2025-12-09T10:30:00Z',
 * });
 * ```
 * @see {@link ImportCursorPosition} - Type definition for cursor positions
 */
export const ImportCursorStorageNamespace = createStorageNamespaceDefinition('importCursor', {
  schemas: {
    /**
     * Get the cursor position for a log file.
     *
     * Subject: `storage:importCursor.get`
     * Type: Request (RPC)
     * @returns Cursor position or null if not found
     */
    get: {
      request: z.object({
        /** Absolute path to the log file */
        filePath: z.string(),
      }),
      response: z.object({
        /** Cursor position or null if no cursor exists for this file */
        cursor: ImportCursorPositionSchema.nullable(),
      }),
    },

    /**
     * Set or update the cursor position for a log file.
     *
     * Subject: `storage:importCursor.set`
     * Type: Request (RPC)
     */
    set: {
      request: ImportCursorPositionSchema,
      response: z.object({
        /** Whether the cursor was successfully stored */
        success: z.boolean(),
      }),
    },

    /**
     * Delete the cursor for a log file.
     *
     * Subject: `storage:importCursor.delete`
     * Type: Request (RPC)
     * @remarks
     * Useful when a file is detected as rotated/truncated and needs
     * to be re-read from the beginning.
     */
    delete: {
      request: z.object({
        /** Absolute path to the log file */
        filePath: z.string(),
      }),
      response: z.object({
        /** Whether a cursor was found and deleted */
        success: z.boolean(),
      }),
    },
  },
});

/**
 * Typed subjects for import cursor storage operations.
 *
 * Provides type-safe access to cursor storage subjects for bus requests.
 * @example
 * ```typescript
 * // Get cursor
 * const { cursor } = await bus.request(ImportCursorStorageSubjects.get, {
 *   filePath: '/path/to/log.jsonl',
 * });
 *
 * // Set cursor
 * await bus.request(ImportCursorStorageSubjects.set, {
 *   filePath: '/path/to/log.jsonl',
 *   bytesRead: 1024,
 *   lastModified: new Date().toISOString(),
 * });
 *
 * // Delete cursor (on file rotation)
 * await bus.request(ImportCursorStorageSubjects.delete, {
 *   filePath: '/path/to/log.jsonl',
 * });
 * ```
 */
export const ImportCursorStorageSubjects = ImportCursorStorageNamespace.subjects;

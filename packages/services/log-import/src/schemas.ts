import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

import {
  GetLogImportStatsSchema,
  ScanLogSessionsSchema,
  LogImportAllSchema,
  LogImportProgressSchema,
  UploadLogSessionFilesSchema,
  LogImportConfirmationRequestSchema,
  LogImportConfirmationResponseSchema,
  ListImportersSchema,
  LogImportModeSchema,
  LogImportSettingsSchema,
} from './schemas/index.js';

/**
 * Log import domain schemas.
 *
 * Subjects for session log import bus communication.
 * Each key becomes a subject identifier as: `log-import.{key}`
 *
 * **Dotted keys become nested properties:**
 * Schema keys with dots (e.g., `'confirmation.request'`) are transformed into nested
 * subject accessors.
 * @example
 * ```typescript
 * // Schema key: 'confirmation.request' -> Access as: LogImportSubjects.confirmation.request
 * bus.on(LogImportSubjects.confirmation.request, (ctx) => { ... });
 *
 * // Non-dotted keys remain flat
 * bus.emit(LogImportSubjects.getStats, { adapterName: 'claude-code' });
 * ```
 */
export const LogImportSchemas = {
  getStats: GetLogImportStatsSchema,
  scan: ScanLogSessionsSchema,
  importAll: LogImportAllSchema,
  progress: LogImportProgressSchema,
  uploadFiles: UploadLogSessionFilesSchema,
  listImporters: ListImportersSchema,
  'confirmation.request': LogImportConfirmationRequestSchema,
  'confirmation.response': LogImportConfirmationResponseSchema,

  /**
   * Lazy-load a single discovered session — fetch its full message history on demand.
   *
   * Subject: `log-import.importSession`
   * Type: Request (RPC)
   * Purpose: Imports one discovered adapter session into Makaio on demand.
   */
  importSession: {
    request: z.object({
      /** External session ID provided by the adapter. */
      adapterSessionId: z.string(),
      /** Adapter type name (e.g., 'claude-code'). */
      adapterName: z.string(),
    }),
    response: z.object({
      /** Makaio session ID that was populated. */
      sessionId: z.string(),
      /** Number of messages imported into the session. */
      messageCount: z.number(),
    }),
  },

  /**
   * Resolve the effective global import mode for a given adapter.
   *
   * Subject: `log-import.getMode`
   * Type: Request (RPC)
   * Purpose: Returns the effective global import mode for the requested adapter.
   *
   * Hosts that need scoped resolution can register a higher-priority handler
   * that falls through to this global default with `ctx.next()`.
   */
  getMode: {
    request: z.object({
      /** Adapter type name (e.g., 'claude-code'). */
      adapterName: z.string(),
    }),
    response: z.object({
      /** Resolved global import mode for this adapter. */
      mode: LogImportModeSchema,
    }),
  },

  /**
   * Set the global import mode for an adapter.
   *
   * Subject: `log-import.setMode`
   * Type: Request (RPC)
   * Purpose: Persists the global import mode for the requested adapter.
   *
   * Hosts that need scoped writes can register a higher-priority handler
   * that falls through to this global default with `ctx.next()`.
   */
  setMode: {
    request: z.object({
      /** Adapter type name (e.g., 'claude-code'). */
      adapterName: z.string(),
      /** Import mode to persist. */
      mode: LogImportModeSchema,
    }),
    response: z.object({
      /** Whether the mode was persisted successfully. */
      success: z.boolean(),
    }),
  },

  /**
   * List all persisted import settings rows.
   *
   * Subject: `log-import.listSettings`
   * Type: Request (RPC)
   * Purpose: Returns every persisted global log-import settings row.
   */
  listSettings: {
    request: z.object({}),
    response: z.object({
      /** All persisted settings rows from the `log_import_settings` table. */
      settings: z.array(LogImportSettingsSchema),
    }),
  },
} satisfies SchemaRecord;

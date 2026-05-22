import { z } from 'zod';

/**
 * Request log import stats from an adapter.
 *
 * Subject: `log-import.getStats`
 * Type: Request (RPC)
 * Purpose: Returns import statistics for a specific adapter including
 *          session counts and last scan timestamp.
 */
export const GetLogImportStatsSchema = {
  request: z.object({
    /** Adapter type name (e.g., 'claude-code') */
    adapterName: z.string(),
  }),
  response: z.object({
    /** Adapter type name (e.g., 'claude-code') */
    adapterName: z.string(),
    /** Whether this adapter supports session import */
    supportsImport: z.boolean(),
    /** Number of sessions found in adapter's log directory */
    sessionsFound: z.number(),
    /** Number of sessions already imported to Makaio */
    sessionsImported: z.number(),
    /** Last scan timestamp (ISO 8601) */
    lastScanAt: z.string().nullable(),
  }),
};

export type GetLogImportStatsRequest = z.infer<typeof GetLogImportStatsSchema.request>;
export type GetLogImportStatsResponse = z.infer<typeof GetLogImportStatsSchema.response>;

/**
 * Trigger a scan of adapter's log directory.
 *
 * Subject: `log-import.scan`
 * Type: Request (RPC)
 * Purpose: Scans the adapter's log directory for new sessions.
 */
export const ScanLogSessionsSchema = {
  request: z.object({
    /** Adapter type name (e.g., 'claude-code') */
    adapterName: z.string(),
  }),
  response: z.object({
    /** Adapter type name (e.g., 'claude-code') */
    adapterName: z.string(),
    sessionsFound: z.number(),
    newSessions: z.number(),
  }),
};

export type ScanLogSessionsRequest = z.infer<typeof ScanLogSessionsSchema.request>;
export type ScanLogSessionsResponse = z.infer<typeof ScanLogSessionsSchema.response>;

/**
 * Import all unimported sessions from an adapter.
 *
 * Subject: `log-import.importAll`
 * Type: Request (RPC)
 * Purpose: Imports all sessions that haven't been imported yet.
 */
export const LogImportAllSchema = {
  request: z.object({
    /** Adapter type name (e.g., 'claude-code') */
    adapterName: z.string(),
  }),
  response: z.object({
    /** Adapter type name (e.g., 'claude-code') */
    adapterName: z.string(),
    imported: z.number(),
    skipped: z.number(),
    errors: z.number(),
  }),
};

export type LogImportAllRequest = z.infer<typeof LogImportAllSchema.request>;
export type LogImportAllResponse = z.infer<typeof LogImportAllSchema.response>;

/**
 * Log import progress event (emitted during long imports).
 *
 * Subject: `log-import.progress`
 * Type: Request (RPC - for acknowledgment pattern)
 * Purpose: Notifies UI about import progress.
 */
export const LogImportProgressSchema = {
  request: z.object({
    /** Adapter type name (e.g., 'claude-code') */
    adapterName: z.string(),
    current: z.number(),
    total: z.number(),
    currentFile: z.string().optional(),
  }),
  response: z.object({ received: z.boolean() }),
};

export type LogImportProgressRequest = z.infer<typeof LogImportProgressSchema.request>;
export type LogImportProgressResponse = z.infer<typeof LogImportProgressSchema.response>;

import { z } from 'zod';

/**
 * Information about a registered log importer.
 */
export const LogImporterInfoSchema = z.object({
  /** Unique ID: adapterId for adapters, `package:{name}` for extensions */
  id: z.string(),
  /** Adapter name used for session lookup and provenance tracking */
  adapterName: z.string(),
  /** Human-readable name */
  displayName: z.string(),
  /** Source type */
  source: z.enum(['adapter', 'extension']),
  /** Glob pattern for log files */
  logFilePattern: z.string(),
  /** Whether orchestrator is currently running */
  isRunning: z.boolean(),
  /** Whether this importer supports manual scan/import (defaults to true) */
  supportsManualImport: z.boolean().default(true),
  /**
   * Stable client application id (e.g., 'claude-code') whose native hooks
   * observe the sessions this importer ingests. Enables client-agnostic
   * framework components to resolve the importer for a `client.session.*`
   * event. Any string is valid — framework logic never hard-codes specific
   * client ids.
   */
  clientId: z.string().optional(),
});

export type LogImporterInfo = z.infer<typeof LogImporterInfoSchema>;

/**
 * List all registered log importers.
 *
 * Subject: `log-import.listImporters`
 * Type: Request (RPC)
 * Purpose: Returns information about all registered importers (adapters + extensions).
 */
export const ListImportersSchema = {
  request: z.object({}),
  response: z.object({
    importers: z.array(LogImporterInfoSchema),
  }),
};

export type ListImportersRequest = z.infer<typeof ListImportersSchema.request>;
export type ListImportersResponse = z.infer<typeof ListImportersSchema.response>;

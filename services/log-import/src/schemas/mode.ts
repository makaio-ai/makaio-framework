import { z } from 'zod';

/**
 * Tri-state import mode for external session discovery.
 *
 * - `disabled`: No scanning or import
 * - `discover`: Shallow scan creates stubs in session list (lazy-load on demand)
 * - `import`: Full import of all sessions and messages
 */
export const LogImportModeSchema = z.enum(['disabled', 'discover', 'import']);

/** Tri-state import mode for external session discovery. */
export type LogImportMode = z.infer<typeof LogImportModeSchema>;

/**
 * Persisted settings shape for the `log_import_settings` table.
 *
 * Represents a global (adapter-level) import mode row. Project-scoped settings
 * live in the host-owned `log_import_scoped_settings` table and are not
 * represented here.
 */
export const LogImportSettingsSchema = z.object({
  /** Adapter name (e.g., 'claude-code'). */
  adapterName: z.string(),
  /** Import mode. */
  mode: LogImportModeSchema,
  /** Timestamp in milliseconds. */
  createdAt: z.number(),
  /** Timestamp in milliseconds. */
  updatedAt: z.number(),
});

/**
 * Persisted settings shape for the `log_import_settings` table.
 *
 * Represents a global (adapter-level) import mode row.
 */
export type LogImportSettings = z.infer<typeof LogImportSettingsSchema>;

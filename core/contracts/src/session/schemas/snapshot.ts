import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { MakaioSessionEventSchema } from './event.js';
import { MakaioSessionAgentSchema } from './agent.js';
import { MakaioSessionSchema } from './session.js';
import { SessionMessageSchema, TurnSchema } from './message.js';

/**
 * Export options for session snapshots.
 *
 * Controls what data is included in the exported snapshot file.
 */
export const SnapshotExportOptionsSchema = z.object({
  /** Include session events audit trail (turn lifecycle, branch events, squash) */
  includeEvents: z.boolean().default(false),
  /** Keep tool_output blocks in messages. When false, blocks are removed entirely. */
  includeToolOutputs: z.boolean().default(false),
  /** Include parent chain up to root. When false, non-root sessions are detached. */
  includeAncestors: z.boolean().default(true),
  /** Include forked/branched descendant sessions */
  includeChildren: z.boolean().default(false),
});

export type SnapshotExportOptions = z.infer<typeof SnapshotExportOptionsSchema>;

/**
 * Preview data extracted from a session snapshot file.
 *
 * Used by UI layers to display snapshot statistics before import.
 */
export interface SnapshotPreviewData {
  /** Number of sessions in the snapshot */
  sessionCount: number;
  /** Total number of messages across all sessions */
  messageCount: number;
  /** Total number of turns across all sessions */
  turnCount: number;
  /** Whether the snapshot includes event audit trails */
  hasEvents: boolean;
  /** Timestamp when the snapshot was exported */
  exportedAt: number;
  /** Size of the snapshot file in bytes */
  fileSizeBytes: number;
}

/**
 * Conflict error payload for snapshot imports.
 *
 * Used to signal conflicts when importing session snapshots.
 */
export interface SnapshotImportConflictErrorData {
  /** Error code for conflict handling */
  code: 'IMPORT_CONFLICT';
  /** Session IDs that already exist */
  conflicts: string[];
  /** Session IDs that would be orphaned by overwrite */
  orphans?: string[];
}

/**
 * Schema version for forward compatibility.
 *
 * Used to detect schema changes and enable migration logic in future versions.
 */
export const SNAPSHOT_VERSION = '1.0' as const;

/**
 * Session snapshot schema.
 *
 * Defines the public contract for session snapshot files used for backup/transfer.
 * Snapshots are JSON files containing session data that can be exported and imported.
 * @example
 * ```typescript
 * import { SessionSnapshotSchema } from '@makaio/contracts';
 *
 * const snapshot = SessionSnapshotSchema.parse({
 *   version: '1.0',
 *   exportedAt: Date.now(),
 *   options: { includeEvents: false, includeToolOutputs: false, includeAncestors: true, includeChildren: false },
 *   sessions: [],
 *   agents: [],
 *   messages: [],
 *   turns: [],
 * });
 * ```
 */
export const SessionSnapshotSchema = z.object({
  /**
   * Schema version for forward compatibility.
   *
   * Enables detection of schema changes and migration logic in future versions.
   * Current version is "1.0".
   */
  version: z.literal(SNAPSHOT_VERSION),

  /**
   * Export timestamp (Unix milliseconds).
   *
   * Records when the snapshot was created.
   */
  exportedAt: z.number(),

  /**
   * Export options used to create this snapshot.
   *
   * Records which options were used during export, allowing import handlers
   * to understand the snapshot's composition.
   */
  options: SnapshotExportOptionsSchema,

  /**
   * Session records (flat array, linked by parentSessionId).
   *
   * Sessions are stored in a flat array structure with relationships
   * defined via parentSessionId and rootSessionId fields.
   */
  sessions: z.array(MakaioSessionSchema),

  /**
   * Agent records per session.
   *
   * Contains agent information for all sessions in the snapshot.
   */
  agents: z.array(MakaioSessionAgentSchema),

  /**
   * Message records with blocks.
   *
   * If includeToolOutputs was false during export, tool_output blocks
   * are completely removed from messages (not replaced with placeholders).
   */
  messages: z.array(SessionMessageSchema),

  /**
   * Turn records with usage metrics.
   *
   * Contains turn-level data including timing, status, and usage metrics.
   */
  turns: z.array(TurnSchema),

  /**
   * Session events (only present if includeEvents was true).
   *
   * Contains the full event audit trail when requested during export.
   * Includes turn lifecycle events, branch events, and squash operations.
   */
  events: z.array(MakaioSessionEventSchema).optional(),
});

export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

/**
 * Validates a snapshot object against the schema.
 * @param snapshot - The snapshot object to validate
 * @returns The validated snapshot if valid
 * @throws ZodError If the snapshot is invalid
 */
export function validateSnapshot(snapshot: unknown): SessionSnapshot {
  return SessionSnapshotSchema.parse(snapshot);
}

/**
 * Safely validates a snapshot object against the schema.
 * @param snapshot - The snapshot object to validate
 * @returns An object with success status and either the validated snapshot or validation errors
 */
export function safeValidateSnapshot(
  snapshot: unknown,
): { success: true; data: SessionSnapshot } | { success: false; error: z.ZodError } {
  const result = SessionSnapshotSchema.safeParse(snapshot);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Snapshot-related RPC schemas.
 *
 * Handles export, import, and validation of session snapshots.
 */
export const SnapshotSchemas = {
  /**
   * Export a session to a snapshot file.
   *
   * Subject: `session.snapshot.export`
   * Type: Request (RPC)
   *
   * Creates a snapshot file containing session data for backup or transfer.
   * Supports filtering what data to include via export options.
   * @example
   * ```typescript
   * // Export with default options (ancestors included, no events/outputs)
   * const { snapshot } = await bus.request(SessionSubjects.snapshot.export, {
   *   sessionId: 'abc123',
   * });
   *
   * // Export with custom options
   * const { snapshot } = await bus.request(SessionSubjects.snapshot.export, {
   *   sessionId: 'abc123',
   *   options: {
   *     includeEvents: true,
   *     includeToolOutputs: true,
   *     includeAncestors: false,
   *     includeChildren: true,
   *   },
   * });
   * ```
   */
  'snapshot.export': {
    request: z.object({
      /** Session ID to export */
      sessionId: z.string(),
      /** Export options controlling what data to include */
      options: SnapshotExportOptionsSchema.optional(),
    }),
    response: z.object({
      /** The exported snapshot object */
      snapshot: SessionSnapshotSchema,
    }),
  },

  /**
   * Import sessions from a snapshot file.
   *
   * Subject: `session.snapshot.import`
   * Type: Request (RPC)
   *
   * Imports session data from a snapshot file, with conflict resolution
   * options for handling existing sessions.
   * @example
   * ```typescript
   * // Import with fail-on-conflict (default)
   * const { imported, skipped, errors } = await bus.request(
   *   SessionSubjects.snapshot.import,
   *   {
   *     snapshot: mySnapshot,
   *     onConflict: 'fail',
   *   },
   * );
   *
   * // Import with skip-on-conflict (skip existing sessions)
   * const { imported, skipped, errors } = await bus.request(
   *   SessionSubjects.snapshot.import,
   *   {
   *     snapshot: mySnapshot,
   *     onConflict: 'skip',
   *   },
   * );
   *
   * // Import with overwrite (replace existing sessions)
   * const { imported, skipped, errors } = await bus.request(
   *   SessionSubjects.snapshot.import,
   *   {
   *     snapshot: mySnapshot,
   *     onConflict: 'overwrite',
   *   },
   * );
   * ```
   */
  'snapshot.import': {
    request: z.object({
      /** The snapshot object to import */
      snapshot: SessionSnapshotSchema,
      /** Conflict resolution strategy */
      onConflict: z.enum(['fail', 'skip', 'overwrite']).default('fail'),
    }),
    response: z.object({
      /** Session IDs successfully imported */
      imported: z.array(z.string()),
      /** Session IDs skipped (already exist) */
      skipped: z.array(z.string()),
      /** Import errors with session IDs and error messages */
      errors: z.array(
        z.object({
          /** Session ID that failed to import */
          sessionId: z.string(),
          /** Error message describing the failure */
          error: z.string(),
        }),
      ),
    }),
  },

  /**
   * Validate a snapshot object against the schema.
   *
   * Subject: `session.snapshot.validate`
   * Type: Request (RPC)
   *
   * Validates a snapshot object without importing it. Useful for
   * checking snapshot files before import.
   * @example
   * ```typescript
   * // Validate a snapshot before importing
   * const { valid, errors } = await bus.request(
   *   SessionSubjects.snapshot.validate,
   *   { snapshot: mySnapshot },
   * );
   *
   * if (!valid) {
   *   console.error('Invalid snapshot:', errors);
   * } else {
   *   console.log('Snapshot is valid');
   * }
   * ```
   */
  'snapshot.validate': {
    request: z.object({
      /** The snapshot object to validate (may be invalid/unknown shape) */
      snapshot: z.unknown(),
    }),
    response: z.object({
      /** Whether the snapshot is valid */
      valid: z.boolean(),
      /** Array of validation error messages (empty if valid) */
      errors: z.array(z.string()),
    }),
  },
} satisfies SchemaRecord;

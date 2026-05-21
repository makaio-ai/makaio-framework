import { z } from 'zod';
import { BaseAdapterEventSchema } from './base-event.js';
import { SessionMetadataSchema } from '../../agent/schemas/started.js';
import { SessionLineageSchema } from './session-lineage.js';

/**
 * Adapter session discovered during log import.
 *
 * Subject: `adapter.session.discovered`
 * Type: Event (fire-and-forget)
 * Emitted when: Log importer discovers a session from external logs
 *
 * Unlike session.created (live sessions), this event does NOT include
 * a Makaio sessionId because the session hasn't been created yet.
 * The handler creates the adapter_session record and optionally the Makaio session.
 */
const SessionDiscoveredMetadataSchema = BaseAdapterEventSchema.merge(SessionMetadataSchema).extend({
  /** Claude Code's session ID (from log file) */
  adapterSessionId: z.string(),

  /** Human-readable session title (first user message, truncated) */
  title: z.string().optional(),

  /**
   * Absolute path to the source log file on disk.
   *
   * Injected by the discovery orchestrator (which knows the file path) after
   * the importer builds the session context. Optional because importers that
   * do not run through DiscoveryOrchestrator may omit it.
   */
  logFilePath: z.string().nullable().optional(),

  /** Unix ms timestamp of when the session started in the external tool. */
  startedAt: z.number().finite().optional(),
});

export const SessionDiscoveredSchema = SessionDiscoveredMetadataSchema.and(SessionLineageSchema);

export type SessionDiscovered = z.infer<typeof SessionDiscoveredSchema>;

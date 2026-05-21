import { z } from 'zod';
import { AdapterSessionStatusSchema } from './adapter-session-status.js';

/**
 * Adapter session status changed.
 *
 * Subject: `adapter.session.statusChanged`
 * Type: Event (fire-and-forget)
 * Emitted when: An adapter session's import status transitions
 * (e.g., discovered → imported, discovered → tracking).
 *
 * Used by the entity cache to keep `adapterSessions` reactive in the UI.
 * Emitted by the storage layer, so `adapterId` is not available.
 */
export const SessionStatusChangedSchema = z.object({
  /** Adapter-specific session identifier */
  adapterSessionId: z.string(),
  /**
   * New status value.
   *
   * - 'discovered': Found in logs, not fully imported yet
   * - 'imported': All messages imported
   * - 'live': Created by Makaio (not imported)
   * - 'tracking': Imported but source file is still actively being written to
   */
  status: AdapterSessionStatusSchema,
});

export type SessionStatusChanged = z.infer<typeof SessionStatusChangedSchema>;

/**
 * Announcement for compaction-ordinal advances made through
 * `storage:session.update`.
 *
 * Shared by both storage backends so the two cannot drift on whether an advance
 * is observable.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';

/**
 * Announce that a session's compaction ordinal advanced.
 *
 * The rebind seam already names `generation` in the `session.updated` it emits,
 * so a consumer that refetches on lifecycle events stays current for
 * hook-observed sessions. Adapter-managed sessions advance through
 * `storage:session.update` instead, and without the same announcement their
 * readers would hold a stale ordinal forever — the two seams must be
 * indistinguishable from outside.
 *
 * Deliberately called only for that one flag rather than on every `update`: the
 * subject has never announced its other writes, and making it do so now would
 * wake every session consumer on writes they have never been told about.
 *
 * Fire-and-forget, exactly as on the rebind path: entity-cache reactivity is
 * best-effort and must not fail the write that already landed.
 * @param bus - Bus to emit on
 * @param sessionId - Session whose ordinal advanced
 */
export function emitSessionGenerationAdvanced(bus: IMakaioBus, sessionId: string): void {
  void bus
    .emit(SessionSubjects.updated, { sessionId, changedProperties: ['generation'] })
    .catch((err) => console.error('[SessionStorage] Failed to emit session.updated:', err));
}

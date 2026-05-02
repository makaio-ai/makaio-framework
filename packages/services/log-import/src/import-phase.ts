/**
 * Import lifecycle phase constants for the log-import persistence path.
 * @packageDocumentation
 */

/**
 * Named phases of the import lifecycle executed by {@link importSegmentTree}.
 *
 * Each phase represents a durable checkpoint with explicit invariants.
 * Phases always progress in order; no phase is skipped or rolled back within a
 * single segment tree traversal.
 *
 * ```
 * linked ──► persisted ──► finalized
 * ```
 *
 * **linked**
 * The Makaio session has been created and bound to its adapter session ID via
 * `AdapterSessionStorageSubjects.createAndLink`. Messages may not exist yet.
 * Lineage-sensitive consumers that require stored message content (e.g.
 * `compress-lineage-resolver`) must not act on the linked signal alone during
 * an active import; they should wait for the `persisted` phase.
 *
 * **persisted**
 * All messages for this segment have been written to storage via
 * `MessageStorageSubjects.upsertByAdapterMessageId`. If this segment is a
 * compaction child, the `session.compacted` event has been appended to the
 * parent session. At this point the session's message content is queryable, but
 * the session status is still `'discovered'`.
 *
 * **finalized**
 * The entire subtree (this segment and all descendants) has been persisted.
 * The adapter session status has been moved to `'imported'` and the Makaio
 * session status has been moved to `'active'`. The session is fully visible and
 * queryable. Status finalization is always bottom-up: a parent only reaches
 * `finalized` after every child has reached `finalized`.
 */
export const ImportPhase = {
  /**
   * Session link created; messages may not exist yet.
   *
   * Invariant: `AdapterSessionStorageSubjects.createAndLink` has returned
   * successfully and the Makaio `sessionId` is stable.
   */
  linked: 'linked',

  /**
   * Messages stored and compaction events emitted.
   *
   * Invariant: all messages for this segment are in storage; if this segment
   * carries compaction metadata, `session.compacted` has been appended to the
   * parent session.
   */
  persisted: 'persisted',

  /**
   * Status moved to `'imported'` / `'active'` after full subtree succeeds.
   *
   * Invariant: this segment and every descendant have reached `persisted`;
   * `AdapterSessionStorageSubjects.updateStatus` has set the adapter session to
   * `'imported'` and `SessionStorageSubjects.update` has set the Makaio session
   * to `'active'`.
   */
  finalized: 'finalized',
} as const;

/**
 * Union of all valid import lifecycle phase names.
 *
 * Derived from {@link ImportPhase} so the type and the runtime value are
 * always in sync.
 */
export type ImportPhaseValue = (typeof ImportPhase)[keyof typeof ImportPhase];

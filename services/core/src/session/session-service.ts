// NOTE: do NOT change without explicit human approval
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { appendSessionLifecycleEvent, registerSessionLifecycleEventWriters } from './session-lifecycle-events.js';
import { registerCoreSessionServiceHandlers } from './session-service-handlers-core.js';
import { TurnStorageSubjects } from './turns/index.js';

/**
 * Framework-core session service for managing makaio sessions.
 *
 * Registers the minimal, load-bearing session handlers that the framework SDK
 * requires: `session.create`, `session.get`, `session.list`, `session.close`,
 * `session.turn.await`, `session.restartAgents`, `session.agent.added`, and
 * `session.agent.removed`.
 *
 * Host-specific handlers (search, update, resume, archive, purge, analytics,
 * context window, branching) are registered by the host session service which
 * depends on this service.
 *
 * Storage is fully decoupled via bus — this service calls
 * `SessionStorageSubjects.*` subjects. Register appropriate storage handlers
 * (memory or drizzle) before creating this service.
 *
 * Session lifecycle rows in `session_events` (agent.added, branch.created)
 * are written by the subscription writers registered during init
 * (see `registerSessionLifecycleEventWriters`); turn lifecycle rows are
 * persisted inline at their emit sites. No separate logger component needs
 * to be wired by hosts.
 * @example
 * ```typescript
 * import { MakaioBus } from '@makaio/bus-core';
 * import {
 *   MakaioSessionService,
 *   registerMemorySessionStorage,
 * } from '@makaio/services-core/session';
 *
 * // Register storage handlers first
 * registerMemorySessionStorage(MakaioBus);
 *
 * // Create and initialise the service
 * const sessionService = new MakaioSessionService(MakaioBus);
 * await sessionService.init();
 *
 * // Now clients can interact via bus
 * const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
 * const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });
 *
 * // Cleanup when done
 * sessionService.destroy();
 * ```
 */
export class MakaioSessionService extends BaseService {
  /**
   * Creates a new MakaioSessionService instance.
   * @param bus - The event bus for inter-service communication
   */
  public constructor(bus: IMakaioBus = MakaioBus) {
    super(bus);
  }

  /**
   * Initialize the service.
   *
   * Registers the framework-core session bus handlers, then performs
   * startup reconciliation to close any turns that were left `active` by a
   * prior process crash. Each orphaned turn is closed with status `'error'`
   * and a `'process-restart'` error message, and a `turn.completed` event is
   * emitted so the UI can update accordingly.
   *
   * The reconciliation uses `requestOptional` so it is silently skipped when
   * no `storage:turn.listActive` handler is registered (e.g., in unit tests
   * that do not register turn storage).
   */
  protected async onInit(): Promise<void> {
    for (const cleanup of registerCoreSessionServiceHandlers({ bus: this.bus })) {
      this.addCleanup(cleanup);
    }
    // Persist agent.added / branch.created lifecycle rows in every host that
    // composes the session service (turn lifecycle rows persist at emit sites).
    this.addCleanup(registerSessionLifecycleEventWriters(this.bus));
    await this.reconcileOrphanedTurns();
  }

  /**
   * Close any turns left `active` from a prior process crash.
   *
   * Queries all active turns via `storage:turn.listActive`. For each orphaned
   * turn, attempts to atomically mark it as `error` only if it is still `active`,
   * then emits `session.turn.completed` only when that transition succeeds.
   * This prevents clobbering turns completed concurrently by other components.
   *
   * Uses `requestOptional` so that environments without a turn storage handler
   * (e.g., isolated unit tests) are unaffected.
   */
  private async reconcileOrphanedTurns(): Promise<void> {
    const result = await this.bus.requestOptional(TurnStorageSubjects.listActive, {});
    if (!result.handled) return;

    const { turns } = result.data;
    for (const turn of turns) {
      try {
        const { transitioned } = await this.bus.request(TurnStorageSubjects.complete, {
          turnId: turn.turnId,
          status: 'error',
          expectedStatus: 'active',
          error: 'process-restart',
        });

        if (transitioned) {
          const completedPayload = {
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            turnNumber: turn.turnNumber,
            success: false,
            error: 'process-restart',
            // Restart-reconcile closes a managed live turn: stamp 'live'
            // explicitly so every `session.turn.completed` emit site carries
            // a marker (uniform with SessionTurnManager and the ingestion seam).
            ingestionMarker: 'live' as const,
          };
          // Lifecycle row persists before consumers see the event
          // (persist-before-emit, same discipline as SessionTurnManager).
          await appendSessionLifecycleEvent(this.bus, {
            type: 'turn.completed',
            sessionId: turn.sessionId,
            payload: completedPayload,
          });
          await this.bus.emit(SessionSubjects.turn.completed, completedPayload);
        }
      } catch (error) {
        console.error(`[MakaioSessionService] Failed to reconcile orphaned turn ${turn.turnId}:`, error);
      }
    }
  }
}

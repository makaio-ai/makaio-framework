import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type { MakaioSessionEvent, SessionEventType } from '@makaio/contracts';
import type { EventContext, SubjectDefinition } from '@makaio/core';
import { SessionEventStorageSubjects } from './session-events/index.js';

/**
 * Transform function for event payloads before storage emission.
 * Use for redaction, PII filtering, or payload normalization.
 *
 * **Scope:** Only affects events emitted to `storage:sessionEvent.append`.
 * Individual subjects (`session.agent.*`, `session.user_message.*`) still receive
 * raw payloads. For full bus-level PII protection, redaction must happen at emit sites
 * (e.g., in SessionOrchestrator before emitting user_message.sent).
 * @param event - The event to transform
 * @returns Transformed event, or null to skip storage emission
 */
export type EventTransform = (event: MakaioSessionEvent) => MakaioSessionEvent | null;

/**
 * Options for SessionLogger.
 */
export interface SessionLoggerOptions {
  /**
   * Transform function applied before storage emission.
   * Return null to skip storage entirely.
   * Note: Does not affect individual session.* subjects (see EventTransform docs).
   * Default: identity (no transformation)
   */
  transform?: EventTransform;
}

/**
 * Bridges session lifecycle events to storage layer for persistence.
 *
 * **Architecture (Normalized Message Model):**
 * - Messages: Stored in `messages` table via MessageStorageSubjects (by SessionOrchestrator/SessionBridge)
 * - SessionLogger: Stores LIFECYCLE events only — agent.added, turn.started, turn.completed
 *
 * **NO longer subscribes to user_message.* events** — user messages are now
 * first-class entities in the `messages` table, not embedded in event payloads.
 *
 * The correlation link is `session.agent.added` which maps:
 * `sessionId ↔ agentId ↔ adapterSessionId`
 *
 * Subscribes to:
 * - session.agent.added — correlation link for multi-agent reconstruction
 * - session.turn.started, session.turn.completed — turn lifecycle
 * - session.branch.created — branch creation audit trail
 *
 * Does NOT subscribe to session.branch.merged or session.squash — those
 * handlers (merge-handler, compress-handler) own their persistence directly
 * using a stable eventId so retries are idempotent.
 *
 * Emits transformed events to `storage:sessionEvent.append` for persistence.
 * @example
 * ```typescript
 * // Basic usage - lifecycle events are emitted to storage:sessionEvent.append
 * const sessionLogger = new SessionLogger(MakaioBus);
 *
 * // With redaction transform (mainly for turn error messages)
 * const sessionLogger = new SessionLogger(MakaioBus, {
 *   transform: (event) => {
 *     // Redact sensitive info if needed
 *     return event;
 *   },
 * });
 * ```
 */
export class SessionLogger {
  private readonly cleanups: Array<() => void> = [];
  private readonly transform: EventTransform;

  public constructor(
    private readonly bus: IMakaioBus = MakaioBus,
    private readonly options: SessionLoggerOptions = {},
  ) {
    this.transform = options.transform ?? ((e) => e);
    this.registerHandlers();
  }

  /**
   * Emit a session event to storage layer.
   *
   * Creates event envelope, applies transform, and emits to storage subject.
   * If transform returns null, event is skipped.
   * @param eventType - Event type for classification
   * @param sessionId - Session identifier
   * @param payload - Event payload to persist
   */
  private async emitStorageEvent(eventType: SessionEventType, sessionId: string, payload: unknown): Promise<void> {
    const rawEvent = {
      sessionId,
      eventId: crypto.randomUUID(),
      timestamp: Date.now(),
      type: eventType,
      payload,
    } as MakaioSessionEvent;

    // Apply transform (PII protection)
    const event = this.transform(rawEvent);
    if (!event) return;

    await this.bus.request(SessionEventStorageSubjects.append, { event });
  }

  /**
   * Register a handler for a session event subject.
   * @param subject - Subject definition to subscribe to
   * @param eventType - Event type for persistence
   */
  private registerHandler<TSubject extends SubjectDefinition & { $meta: { payload: { sessionId: string } } }>(
    subject: TSubject,
    eventType: SessionEventType,
  ): void {
    this.cleanups.push(
      // Casts are safe: session logger subjects are never channel-only.
      // TypeScript cannot resolve the IsChannel conditional for unresolved generic type parameters.
      this.bus.on(
        subject as never,
        (async (ctx: EventContext<TSubject['$meta']['payload']>) => {
          try {
            await this.emitStorageEvent(eventType, ctx.payload.sessionId, ctx.payload);
          } catch (error) {
            console.error(`[SessionLogger] Failed to emit ${eventType} to storage:`, error);
          }
        }) as never,
      ),
    );
  }

  /**
   * Register all session lifecycle event handlers.
   *
   * **Normalized Message Model:**
   * - User messages are stored in `messages` table by SessionOrchestrator
   * - Assistant messages are stored by SessionBridge on agent.complete
   * - SessionLogger only stores LIFECYCLE events for audit/correlation
   */
  private registerHandlers(): void {
    // Correlation link: maps sessionId ↔ agentId ↔ adapterSessionId
    this.registerHandler(SessionSubjects.agent.added, 'agent.added');

    // Turn lifecycle (for audit trail, NOT for message content)
    this.registerHandler(SessionSubjects.turn.started, 'turn.started');
    this.registerHandler(SessionSubjects.turn.completed, 'turn.completed');

    // Branch created lifecycle event.
    // NOTE: branch.merged and squash are NOT subscribed here — those handlers
    // (merge-handler, compress-handler) own their own persistence directly and
    // call SessionEventStorageSubjects.append with a stable eventId before
    // emitting the lifecycle subject. Subscribing here would duplicate records.
    this.registerHandler(SessionSubjects.branch.created, 'branch.created');

    // NOTE: user_message.* events are NO LONGER persisted here.
    // User messages are now first-class entities in the `messages` table,
    // stored directly by SessionOrchestrator when processing sendMessage.
  }

  /**
   * Stop the logger and clean up subscriptions.
   */
  public destroy(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups.length = 0;
  }
}

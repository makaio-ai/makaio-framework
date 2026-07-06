/**
 * Session lifecycle event persistence helpers.
 *
 * Single write path for lifecycle rows in `session_events` (agent.added,
 * turn.started, turn.completed, branch.created). Emit sites call
 * {@link appendSessionLifecycleEvent} inline so the row is durable before
 * the corresponding `session.*` bus event reaches consumers
 * (persist-before-emit). {@link emitSessionTurnStarted} bundles that
 * append with the canonical `session.turn.started` emission, and
 * {@link registerSessionLifecycleEventWriters} covers the lifecycle
 * subjects that have no single emit site (agent.added, branch.created).
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type { MakaioSessionEvent, SessionEventType } from '@makaio/contracts';
import type { ExtractSubjectPayload } from '@makaio/core';
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
 * Arguments for {@link appendSessionLifecycleEvent}.
 */
export interface SessionLifecycleEventArgs {
  /** Event type for classification (e.g. 'turn.started'). */
  type: SessionEventType;
  /** Session the event belongs to. */
  sessionId: string;
  /** Event payload to persist. */
  payload: unknown;
  /**
   * Stable event identifier. Provide one when the caller needs idempotent
   * retries; defaults to a fresh UUID per call.
   */
  eventId?: string;
  /** Event timestamp (Unix ms). Defaults to `Date.now()`. */
  timestamp?: number;
}

/**
 * Append a session lifecycle row to `session_events`.
 *
 * Builds the {@link MakaioSessionEvent} envelope, applies the optional
 * transform (null result skips persistence), then requests
 * `storage:sessionEvent.append` via `requestOptional` so ephemeral mode
 * (no session-event storage registered) degrades gracefully. A handled
 * append failure propagates to the caller so emit sites can preserve the
 * persist-before-emit contract.
 *
 * This is the single write path for lifecycle rows in `session_events`.
 * It MUST NOT be used for `branch.merged` / `squash` — those handlers
 * (merge-handler, compress-handler) own their own idempotent persistence
 * with stable eventIds; double-writing here would duplicate rows.
 * @param bus - Bus used to reach session-event storage
 * @param args - Event envelope fields (type, sessionId, payload, optional eventId/timestamp)
 * @param transform - Optional transform applied before persistence (return null to skip)
 */
export async function appendSessionLifecycleEvent(
  bus: IMakaioBus,
  args: SessionLifecycleEventArgs,
  transform?: EventTransform,
): Promise<void> {
  // Cast is safe for core lifecycle types whose payloads match the schema;
  // plugin event types are accepted as records by the storage schema.
  const rawEvent = {
    sessionId: args.sessionId,
    eventId: args.eventId ?? crypto.randomUUID(),
    timestamp: args.timestamp ?? Date.now(),
    type: args.type,
    payload: args.payload,
  } as MakaioSessionEvent;

  const event = transform ? transform(rawEvent) : rawEvent;
  if (!event) {
    return;
  }

  await bus.requestOptional(SessionEventStorageSubjects.append, { event });
}

/**
 * Payload of the canonical `session.turn.started` event.
 */
export type SessionTurnStartedPayload = ExtractSubjectPayload<typeof SessionSubjects.turn.started>;

/**
 * Persist the `turn.started` lifecycle row, then emit `session.turn.started`.
 *
 * This is the only sanctioned emit path for live-path `session.turn.started`
 * emissions (single-emitter discipline): the orchestration emit sites
 * (SessionOrchestrator, attach handler, MakaioSession entity) all route
 * through this helper so the `session_events` row is durable before any
 * consumer observes the event (persist-before-emit). The turn ingestion seam
 * (`ingestCompletedTurn`) is the one other sanctioned emitter — it batches
 * both lifecycle rows before emitting and must not be rerouted through this
 * helper (doing so would reorder its persist-before-emit batch).
 * @param bus - Bus used for lifecycle persistence and event emission
 * @param payload - The exact `session.turn.started` payload to persist and emit
 */
export async function emitSessionTurnStarted(bus: IMakaioBus, payload: SessionTurnStartedPayload): Promise<void> {
  await appendSessionLifecycleEvent(bus, { type: 'turn.started', sessionId: payload.sessionId, payload });
  await bus.emit(SessionSubjects.turn.started, payload);
}

/**
 * Register subscription-based `session_events` writers for the lifecycle
 * subjects that have no single emit site: `session.agent.added` (persisted as
 * type `agent.added`, the sessionId ↔ agentId ↔ adapterSessionId correlation
 * link) and `session.branch.created` (branch creation audit trail).
 *
 * `turn.started` / `turn.completed` rows are NOT written here — their emit
 * sites persist inline ({@link emitSessionTurnStarted}, SessionTurnManager's
 * completion barrier, the turn ingestion seam) so the row lands before the
 * event fires.
 *
 * Deliberately does NOT subscribe to `session.branch.merged` or
 * `session.squash`: the merge and compress handlers own their persistence
 * directly and call `storage:sessionEvent.append` with a stable eventId so
 * retries are idempotent. Subscribing here would duplicate those rows.
 *
 * Wired by `MakaioSessionService` during init, so the writers run in every
 * host that composes the session package.
 * @param bus - Bus to subscribe on and persist through
 * @param transform - Optional transform applied before persistence (return null to skip)
 * @returns Cleanup function cancelling both subscriptions
 */
export function registerSessionLifecycleEventWriters(bus: IMakaioBus, transform?: EventTransform): () => void {
  const cleanups: Array<() => void> = [
    bus.on(SessionSubjects.agent.added, async (ctx) => {
      await appendSubscriptionLifecycleEvent(
        bus,
        { type: 'agent.added', sessionId: ctx.payload.sessionId, payload: ctx.payload },
        transform,
      );
    }),
    bus.on(SessionSubjects.branch.created, async (ctx) => {
      await appendSubscriptionLifecycleEvent(
        bus,
        { type: 'branch.created', sessionId: ctx.payload.sessionId, payload: ctx.payload },
        transform,
      );
    }),
  ];
  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}

/**
 * Append a subscription-owned lifecycle row without failing the source event.
 *
 * Unlike turn lifecycle emit sites, subscription-owned audit rows are
 * best-effort side effects. A storage outage must not reject the operation
 * that already emitted `session.agent.added` or `session.branch.created`.
 * @param bus - Bus used for lifecycle persistence
 * @param args - Event envelope fields
 * @param transform - Optional transform applied before persistence
 */
async function appendSubscriptionLifecycleEvent(
  bus: IMakaioBus,
  args: SessionLifecycleEventArgs,
  transform?: EventTransform,
): Promise<void> {
  try {
    await appendSessionLifecycleEvent(bus, args, transform);
  } catch (error) {
    console.warn('[session-lifecycle-events] Failed to persist subscription lifecycle event', {
      type: args.type,
      sessionId: args.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Turn lifecycle ingestion seam.
 *
 * Single entry point for ingesting externally-completed turns (observed
 * sessions: log imports, hook-triggered imports) into the canonical session
 * model. Persists the turn row and its messages, then emits the canonical
 * `session.turn.started` / `session.turn.completed` events exactly once per
 * turn (first ingestion, or a resume when a prior attempt failed before its
 * side effects completed). This keeps the "one emitter" principle: import
 * paths never emit `session.turn.*` themselves; they feed this seam.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type {
  SessionMessageBlock,
  SessionMessageOrigin,
  TurnIngestionMarker,
  TurnInitiator,
  TurnUsage,
} from '@makaio/contracts';
import { TurnStorageSubjects } from '../turn/namespace.js';
import { MessageStorageSubjects } from './messages/namespace.js';
import { SessionEventStorageSubjects } from './session-events/index.js';
import { appendSessionLifecycleEvent } from './session-lifecycle-events.js';

/**
 * A message belonging to an ingested turn.
 *
 * Mirrors the `storage:message.upsertByAdapterMessageId` request minus
 * `sessionId` / `turnId`, which the seam supplies from the ingested turn.
 */
export interface IngestTurnMessage {
  /** Adapter's message ID (external record uuid) — the idempotency key. */
  adapterMessageId: string;
  /** Message role. */
  role: 'user' | 'assistant';
  /** Plain text content for FTS indexing. */
  contentText: string;
  /** Structured content blocks. */
  blocks: SessionMessageBlock[];
  /** Agent ID (for assistant messages). */
  agentId?: string;
  /** Adapter's session ID. */
  adapterSessionId?: string;
  /** Message timestamp (Unix ms). */
  timestamp: number;
  /** Origin of the message (e.g. voice/text). */
  origin?: SessionMessageOrigin;
}

/**
 * Parameters for {@link ingestCompletedTurn}.
 */
export interface IngestCompletedTurnParams {
  /** Makaio session the turn belongs to. */
  sessionId: string;
  /**
   * Content-derived idempotency anchor — the adapterMessageId of the
   * turn-start user message. Re-ingesting the same anchor is a no-op.
   */
  turnAnchorId: string;
  /** Turn start timestamp (Unix ms). */
  startedAt: number;
  /** Turn completion timestamp (Unix ms). */
  completedAt: number;
  /** Final turn status. */
  status: 'completed' | 'error';
  /** Error message when status is 'error'. */
  error?: string;
  /** Aggregated token usage for the turn. */
  usage?: TurnUsage;
  /** Actor provenance of whoever started the turn. */
  initiator?: TurnInitiator;
  /** Whether this emission is live ingestion or historical backfill. */
  ingestionMarker: TurnIngestionMarker;
  /** Messages of the turn, in transcript order. */
  messages: IngestTurnMessage[];
}

/**
 * Result of {@link ingestCompletedTurn}.
 */
export interface IngestCompletedTurnResult {
  /** Makaio turn ID (stable across re-ingestion of the same anchor). */
  turnId: string;
  /** Monotonic per-session ordinal (stable across re-ingestion). */
  turnNumber: number;
  /** True on first ingestion; false when the anchor already existed. */
  created: boolean;
}

/**
 * In-flight ingestion chains keyed by `(sessionId, turnAnchorId)`.
 *
 * Concurrent hook- and watcher-triggered imports of the same transcript can
 * reach this seam for the same anchor at the same time. The anchor upsert is
 * atomic (only one caller observes `created: true`), but the emission-resume
 * probe below reads durable state that the concurrent winner has not written
 * yet — serializing per anchor makes that read see the winner's completed
 * side effects instead of racing them. Entries are removed once the chain
 * drains (same pattern as the per-file import mutex in the log-import
 * service).
 */
const ingestChainByAnchor = new Map<string, Promise<unknown>>();

/**
 * Serialize an ingestion execution on its anchor key.
 * @param anchorKey - `(sessionId, turnAnchorId)` composite key
 * @param execute - The ingestion body to run once prior executions settle
 * @returns The execution's result (rejections propagate to this caller only)
 */
function chainOnAnchor<T>(anchorKey: string, execute: () => Promise<T>): Promise<T> {
  const previous = ingestChainByAnchor.get(anchorKey) ?? Promise.resolve();
  const execution = previous.then(execute);

  // The stored tail never rejects, so later chains cannot inherit a rejection.
  const tail = execution.then(
    () => undefined,
    () => undefined,
  );
  ingestChainByAnchor.set(anchorKey, tail);
  void tail.then(() => {
    if (ingestChainByAnchor.get(anchorKey) === tail) {
      ingestChainByAnchor.delete(anchorKey);
    }
  });

  return execution;
}

/**
 * Deterministic `session_events` eventId for an ingested turn's lifecycle row.
 *
 * Determinism serves two invariants: the idempotent append semantics of
 * `storage:sessionEvent.append` (conflict on eventId is a no-op) make retried
 * emissions write exactly one row, and the durable row doubles as the
 * "side effects completed" record that the emission-resume probe reads.
 * @param type - Lifecycle row type ('turn.started' | 'turn.completed')
 * @param turnId - Stable Makaio turn ID
 * @returns Deterministic eventId
 */
function turnLifecycleEventId(type: 'turn.started' | 'turn.completed', turnId: string): string {
  return `${type}:${turnId}`;
}

/**
 * Check whether a prior ingestion recorded the turn's `turn.completed`
 * lifecycle row (the durable marker that the turn's `session.turn.*` side
 * effects ran to completion).
 * @param bus - Bus used for the session-event storage probe
 * @param sessionId - Session the turn belongs to
 * @param turnId - Stable Makaio turn ID
 * @returns `true`/`false` when session-event storage answered; `undefined`
 *   when no session-event storage is registered (resume detection impossible)
 */
async function turnCompletionRecorded(
  bus: IMakaioBus,
  sessionId: string,
  turnId: string,
): Promise<boolean | undefined> {
  const probe = await bus.requestOptional(SessionEventStorageSubjects.getByIds, {
    sessionId,
    eventIds: [turnLifecycleEventId('turn.completed', turnId)],
  });
  if (!probe.handled) {
    return undefined;
  }
  return probe.data.events.length > 0;
}

/**
 * Ingest an externally-completed turn: persist the turn row and its messages,
 * then emit the canonical `session.turn.*` events exactly once.
 *
 * Steps (persist-before-emit by construction):
 * 1. Upsert the turn row via `storage:turn.ingestCompleted` (anchor-keyed).
 *    Uses `bus.request`, not `requestOptional`: import paths always run with
 *    turn storage registered — a missing handler is a caller error and must
 *    surface, not silently drop the turn.
 * 2. Upsert every message via `storage:message.upsertByAdapterMessageId`
 *    with the real `turnId`. NEVER `storage:message.append` — append mints
 *    fresh messageIds and would break re-import idempotency.
 * 3. When the turn's `session.turn.*` side effects have not completed yet:
 *    persist `turn.started` / `turn.completed` lifecycle rows into
 *    `session_events` (deterministic eventIds, idempotent appends), then emit
 *    `session.turn.started` followed by `session.turn.completed`.
 * 4. Return the stable `(turnId, turnNumber)` identity plus `created`.
 *
 * Both events are emitted AFTER all persistence resolves. This deliberately
 * differs from the managed orchestration path, which emits `turn.started`
 * before routing to agents: here the turn is already finished, so there is
 * no in-progress phase to signal — and emitting only after persistence is
 * what guarantees the four-point consumer contract (session row, completed
 * turn row, `getByTurn`-queryable messages, complete event payload) holds
 * at emission time.
 *
 * Invariants:
 * - (a) Never touches SessionTurnManager in-memory state
 *   (`activeTurns` / `completingSessions`) — the turn is already complete
 *   and never passes through the live turn lifecycle.
 * - (b) Re-ingestion of the same anchor is a storage no-op and re-emits
 *   nothing once the `turn.completed` lifecycle row is durable. Emission is
 *   NOT gated on the anchor claim alone: a prior ingestion that claimed the
 *   anchor but failed before its side effects completed (partial message
 *   upsert, lifecycle append failure) leaves that row absent, and the next
 *   ingestion of the same anchor resumes the emission instead of suppressing
 *   it forever. Executions are serialized per anchor so concurrent hook- and
 *   watcher-triggered ingestion stays exactly-once. Residual window: a
 *   process crash between the lifecycle append and the bus emit loses that
 *   emission (the durable row already claims it) — an accepted at-most-once
 *   bound absent a transactional outbox. Without session-event storage
 *   registered, resume detection is impossible and emission falls back to
 *   first-ingestion-only.
 * - (c) The four-point consumer contract holds when `session.turn.*` fires.
 *
 * Guard: when `params.messages` is empty, event emission is skipped
 * (contract point 3 — `getByTurn` — would be unfulfillable) and a warning is
 * logged; the turn row still persists, and a later re-ingestion that carries
 * messages emits via the resume path.
 * @param bus - Bus used for storage requests and event emission
 * @param params - Turn identity, completion state, marker, and messages
 * @returns Stable turn identity and whether this call created the turn
 */
export function ingestCompletedTurn(
  bus: IMakaioBus,
  params: IngestCompletedTurnParams,
): Promise<IngestCompletedTurnResult> {
  const anchorKey = JSON.stringify([params.sessionId, params.turnAnchorId]);
  return chainOnAnchor(anchorKey, () => executeIngestCompletedTurn(bus, params));
}

/**
 * The serialized body of {@link ingestCompletedTurn} — see its contract docs.
 * @param bus - Bus used for storage requests and event emission
 * @param params - Turn identity, completion state, marker, and messages
 * @returns Stable turn identity and whether this call created the turn
 */
async function executeIngestCompletedTurn(
  bus: IMakaioBus,
  params: IngestCompletedTurnParams,
): Promise<IngestCompletedTurnResult> {
  const { sessionId, turnAnchorId, startedAt, completedAt, status, error, usage, initiator } = params;

  // 1. Anchor-keyed turn upsert — assigns turnNumber on first ingestion only.
  const { turn, created } = await bus.request(TurnStorageSubjects.ingestCompleted, {
    sessionId,
    turnAnchorId,
    startedAt,
    completedAt,
    status,
    error,
    usage,
    initiator,
  });

  // 2. Persist messages with the real turnId (idempotent by adapterMessageId).
  let firstUserMessageId: string | undefined;
  let firstMessageId: string | undefined;
  for (const message of params.messages) {
    const { messageId } = await bus.request(MessageStorageSubjects.upsertByAdapterMessageId, {
      sessionId,
      turnId: turn.turnId,
      adapterMessageId: message.adapterMessageId,
      role: message.role,
      contentText: message.contentText,
      blocks: message.blocks,
      agentId: message.agentId,
      adapterSessionId: message.adapterSessionId,
      timestamp: message.timestamp,
      origin: message.origin,
    });
    firstMessageId ??= messageId;
    if (firstUserMessageId === undefined && message.role === 'user') {
      firstUserMessageId = messageId;
    }
  }

  // 3. Exactly-once side effects: first ingestion emits; re-ingestion resumes
  //    only when the durable completion record is missing (invariant b).
  let shouldEmit = created;
  if (!created) {
    const recorded = await turnCompletionRecorded(bus, sessionId, turn.turnId);
    shouldEmit = recorded === false;
  }

  if (shouldEmit) {
    // firstMessageId is defined iff at least one message was persisted, so
    // this doubles as the empty-messages guard.
    if (firstMessageId === undefined) {
      console.warn(
        `[turn-ingest] Turn ${turn.turnId} (session ${sessionId}) ingested without messages — ` +
          `skipping session.turn.* emission (getByTurn contract unfulfillable)`,
      );
    } else {
      await emitIngestedTurnEvents(bus, params, turn, firstUserMessageId ?? firstMessageId);
    }
  }

  return { turnId: turn.turnId, turnNumber: turn.turnNumber, created };
}

/**
 * Persist the `turn.started` / `turn.completed` lifecycle rows, then emit the
 * canonical `session.turn.*` events for an ingested turn.
 *
 * Lifecycle rows persist BEFORE the events fire (persist-before-emit) and use
 * deterministic eventIds, so retried appends are idempotent and the completed
 * row doubles as the durable "side effects done" marker read by the
 * emission-resume probe.
 * @param bus - Bus used for lifecycle persistence and event emission
 * @param params - Original ingestion parameters (payload fields, marker)
 * @param turn - Stable turn identity from the anchor upsert
 * @param anchorMessageId - Started-event anchor: the first user message's
 *   messageId, falling back to the first message of any role (assistant-only
 *   continuations still need an anchor message)
 */
async function emitIngestedTurnEvents(
  bus: IMakaioBus,
  params: IngestCompletedTurnParams,
  turn: { turnId: string; turnNumber: number },
  anchorMessageId: string,
): Promise<void> {
  const { sessionId, status, error, usage, initiator, ingestionMarker } = params;
  const startedPayload = {
    sessionId,
    turnId: turn.turnId,
    turnNumber: turn.turnNumber,
    messageId: anchorMessageId,
    agentIds: [...new Set(params.messages.flatMap((m) => (m.role === 'assistant' && m.agentId ? [m.agentId] : [])))],
    initiator,
    ingestionMarker,
  };
  const completedPayload = {
    sessionId,
    turnId: turn.turnId,
    turnNumber: turn.turnNumber,
    success: status === 'completed',
    error,
    usage,
    initiator,
    ingestionMarker,
  };

  await appendSessionLifecycleEvent(bus, {
    type: 'turn.started',
    sessionId,
    payload: startedPayload,
    eventId: turnLifecycleEventId('turn.started', turn.turnId),
  });
  await appendSessionLifecycleEvent(bus, {
    type: 'turn.completed',
    sessionId,
    payload: completedPayload,
    eventId: turnLifecycleEventId('turn.completed', turn.turnId),
  });

  await bus.emit(SessionSubjects.turn.started, startedPayload);
  await bus.emit(SessionSubjects.turn.completed, completedPayload);
}

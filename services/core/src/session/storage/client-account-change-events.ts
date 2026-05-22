import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type { IMakaioSession } from '@makaio/contracts';

type SessionClientAccountState = Pick<
  IMakaioSession,
  'sessionId' | 'clientId' | 'clientAccountId' | 'lastClientIdentityObservation'
>;

interface SessionClientAccountTransition {
  previousClientAccountId: string | null;
  clientAccountId: string;
}

/**
 * Return the canonical client-account transition when the session linkage changed.
 * @param previous - Persisted session state before the write, when available
 * @param next - Persisted session state after the write
 * @returns Transition details, or `null` when no canonical change occurred
 */
function getSessionClientAccountTransition(
  previous: SessionClientAccountState | null,
  next: SessionClientAccountState,
): SessionClientAccountTransition | null {
  const previousClientAccountId = previous?.clientAccountId ?? null;
  const clientAccountId = next.clientAccountId ?? null;
  if (!clientAccountId || previousClientAccountId === clientAccountId) {
    return null;
  }

  return {
    previousClientAccountId,
    clientAccountId,
  };
}

/**
 * Enforce that persisted session client-account state remains observation-backed and coherent.
 * @param _previous - Persisted session state before the write, when available
 * @param next - Persisted session state after the write
 */
export function assertSessionClientAccountStateIsConsistent(
  _previous: SessionClientAccountState | null,
  next: SessionClientAccountState,
): void {
  const observation = next.lastClientIdentityObservation;
  if (next.clientAccountId !== undefined && !observation) {
    throw new Error(`Session "${next.sessionId}" cannot persist clientAccountId without lastClientIdentityObservation`);
  }

  if (next.clientAccountId !== undefined && next.clientId === undefined) {
    throw new Error(`Session "${next.sessionId}" cannot persist clientAccountId without clientId`);
  }

  if (observation && next.clientId !== undefined && next.clientId !== observation.clientId) {
    throw new Error(
      `Session "${next.sessionId}" cannot persist clientId "${next.clientId}" because lastClientIdentityObservation belongs to "${observation.clientId}"`,
    );
  }
}

/**
 * Emit the session client-account changed event after a persisted linkage transition.
 *
 * Storage is authoritative. Listener failures are logged but must not roll back
 * the committed session write.
 * @param bus - Bus instance used for event emission
 * @param previous - Persisted session state before the write, when available
 * @param next - Persisted session state after the write
 */
export function emitSessionClientAccountChangedIfNeeded(
  bus: IMakaioBus,
  previous: SessionClientAccountState | null,
  next: SessionClientAccountState,
): void {
  const transition = getSessionClientAccountTransition(previous, next);
  if (!transition) {
    return;
  }

  const observation = next.lastClientIdentityObservation;
  if (!observation) {
    return;
  }

  const payload = {
    sessionId: next.sessionId,
    clientId: observation.clientId,
    previousClientAccountId: transition.previousClientAccountId,
    clientAccountId: transition.clientAccountId,
    source: observation.source,
    observedAt: observation.observedAt,
    lastClientIdentityObservation: structuredClone(observation),
  };

  queueMicrotask(() => {
    void Promise.resolve()
      .then(() => bus.emit(SessionSubjects.clientAccount.changed, payload))
      .catch((error: unknown) => {
        console.error('[SessionStorage] Failed to emit session.clientAccount.changed:', error);
      });
  });
}

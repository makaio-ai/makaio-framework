import type { IMakaioSession, SessionStorageUpdateSchema } from '@makaio/contracts';
import type { z } from 'zod';
import type { assertSessionClientAccountStateIsConsistent } from './client-account-change-events.js';

type SessionUpdatePayload = z.infer<typeof SessionStorageUpdateSchema.request>;

/**
 * Project the next client-account state from the persisted session plus partial updates.
 * @param previousSession - Persisted session state before the update attempt
 * @param payload - Partial session update payload
 * @returns Client-account state after applying the payload
 */
export function buildNextSessionClientAccountState(
  previousSession: IMakaioSession,
  payload: Pick<SessionUpdatePayload, 'clientId' | 'clientAccountId' | 'lastClientIdentityObservation'>,
): Parameters<typeof assertSessionClientAccountStateIsConsistent>[1] {
  return {
    sessionId: previousSession.sessionId,
    clientId: payload.clientId ?? previousSession.clientId,
    clientAccountId: payload.clientAccountId ?? previousSession.clientAccountId,
    lastClientIdentityObservation:
      payload.lastClientIdentityObservation ?? previousSession.lastClientIdentityObservation,
  };
}

/**
 * Detect whether an update payload changes the session's client-account linkage state.
 * @param payload - Parsed session update payload
 * @returns `true` when optimistic linkage guards must apply
 */
export function touchesClientAccountState(
  payload: Pick<SessionUpdatePayload, 'clientId' | 'clientAccountId' | 'lastClientIdentityObservation'>,
): boolean {
  return (
    payload.clientId !== undefined ||
    payload.clientAccountId !== undefined ||
    payload.lastClientIdentityObservation !== undefined
  );
}

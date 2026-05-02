import type { IMakaioSession } from '@makaio/contracts';
import type {
  ClientAccountObserveRequest,
  ClientIdentityObservation,
  ClientSessionAccountObserveRequest,
  ClientSessionAccountObserveResponse,
} from '@makaio/contracts/client';

/**
 * Session resolved from a session/account observation locator.
 */
export interface ResolvedClientObservationSession {
  /** Resolved Makaio session identifier. */
  readonly sessionId: string;
  /** Current persisted session snapshot. */
  readonly session: IMakaioSession;
}

/**
 * Normalized client-account observation request derived from a session observation.
 */
export interface DerivedClientAccountObservation {
  /** Raw observation persisted onto the session row. */
  readonly observation: ClientIdentityObservation;
  /** Canonical account-observe request forwarded to clients-core. */
  readonly accountObserveRequest: ClientAccountObserveRequest;
}

/**
 * Request handler signature for session-scoped client account observation.
 */
export type SessionClientAccountObserveHandler = (
  payload: ClientSessionAccountObserveRequest,
) => Promise<ClientSessionAccountObserveResponse>;

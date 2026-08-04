import type { IMakaioSession, MakaioSessionAgent, AdapterSessionClaimRecord } from '@makaio/contracts';

/**
 * In-memory backing state shared by the session, agent and ownership memory handlers.
 *
 * Extracting the maps from their individual handler closures is what allows the
 * ownership handler to read and mutate agent and session rows written by the other
 * two handlers — a property that cannot be achieved with three disconnected private
 * `Map` instances. Pass one `SessionStorageMemoryState` to all three `register*`
 * functions to make them share the same rows.
 */
export interface SessionStorageMemoryState {
  /** Session rows keyed by `sessionId`. */
  readonly sessions: Map<string, IMakaioSession>;
  /** Agent rows keyed by `agentId`. */
  readonly agents: Map<string, MakaioSessionAgent>;
  /** Claim rows keyed by `claimId`. */
  readonly claims: Map<string, AdapterSessionClaimRecord>;
}

/**
 * Allocate a fresh, empty in-memory state instance.
 *
 * Each call returns an independent set of maps. Pass the same instance to all
 * three memory handler registrations when they must share the same rows; pass
 * separate instances to isolate them (the default when no state is supplied).
 * @returns A new `SessionStorageMemoryState` with empty maps
 */
export function createSessionStorageMemoryState(): SessionStorageMemoryState {
  return {
    sessions: new Map<string, IMakaioSession>(),
    agents: new Map<string, MakaioSessionAgent>(),
    claims: new Map<string, AdapterSessionClaimRecord>(),
  };
}

/**
 * Drop every claim row matching a predicate.
 *
 * The cascade the SQL backends get from their foreign keys: an agent or session
 * that no longer exists cannot keep blocking an ownership key. Deleting during
 * iteration is defined behaviour for a `Map` — a removed entry is simply not
 * revisited, and no surviving entry is skipped.
 * @param state - Shared in-memory state to delete from
 * @param matches - Predicate selecting the claims to drop
 */
export function deleteClaimsWhere(
  state: SessionStorageMemoryState,
  matches: (claim: AdapterSessionClaimRecord) => boolean,
): void {
  for (const [claimId, claim] of state.claims) {
    if (matches(claim)) state.claims.delete(claimId);
  }
}

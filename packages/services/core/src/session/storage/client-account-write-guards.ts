import { eq, and, isNull, type SQL } from 'drizzle-orm';
import { SessionStorageSetSessionSchema, type IMakaioSession } from '@makaio/contracts';
import { sessions } from './schema.js';

type SessionRow = typeof sessions.$inferSelect;

/** Maximum optimistic retries for client-account baseline-sensitive writes. */
export const CLIENT_ACCOUNT_WRITE_RETRY_LIMIT = 3;

/**
 * Parse a full session payload for storage:set and enforce the refined observation invariant.
 * @param session - Candidate session payload.
 * @returns Parsed session.
 */
export function parseSetSession(session: unknown): IMakaioSession {
  return SessionStorageSetSessionSchema.parse(session);
}

/**
 * Build an optimistic concurrency predicate for the client-account linkage baseline.
 * @param previousRow - Session row observed before the write, when available.
 * @returns SQL predicate that matches only if the relevant baseline is unchanged.
 */
export function buildClientAccountBaselinePredicate(previousRow: SessionRow | undefined): SQL {
  const previousClientId = previousRow?.clientId ?? null;
  const previousClientAccountId = previousRow?.clientAccountId ?? null;
  const previousObservation = previousRow?.lastClientIdentityObservation ?? null;
  return and(
    previousClientId === null ? isNull(sessions.clientId) : eq(sessions.clientId, previousClientId),
    previousClientAccountId === null
      ? isNull(sessions.clientAccountId)
      : eq(sessions.clientAccountId, previousClientAccountId),
    previousObservation === null
      ? isNull(sessions.lastClientIdentityObservation)
      : eq(sessions.lastClientIdentityObservation, previousObservation),
  )!;
}

import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { SessionStorageUpdateSchema } from '@makaio/contracts';
import type { z } from 'zod';
import { sessionStorageSchema } from './schema.variants.js';

type SessionsTable = typeof sessionStorageSchema.sqlite.sessions;
type SessionInsertValues = SessionsTable['$inferInsert'];
type SessionIdentityUpdateFields = Partial<
  Pick<SessionInsertValues, 'adapterName' | 'adapterId' | 'adapterSessionId' | 'lastActivityAt'>
>;

/** Parsed payload for the session update storage operation. */
export type SessionUpdatePayload = z.infer<typeof SessionStorageUpdateSchema.request>;

/** Atomic predicates that accompany a projected session update. */
interface SessionUpdateGuards {
  status: SQL | undefined;
  identity: SQL | undefined;
  reconciliation: SQL | undefined;
}

/**
 * Project the identity columns written by a session update authority mode.
 * @param payload - Session update payload.
 * @returns Identity fields to merge into the Drizzle update projection.
 */
export function buildSessionIdentityUpdateFields(payload: SessionUpdatePayload): SessionIdentityUpdateFields {
  const reconciliation = payload.reconcileAdapterSession;
  if (reconciliation !== undefined) {
    return {
      adapterName: reconciliation.adapterName,
      adapterId: reconciliation.adapterId,
      adapterSessionId: reconciliation.adapterSessionId,
      lastActivityAt: reconciliation.lastActivityAt,
    };
  }
  const identity = payload.identity;
  if (identity === undefined) return {};
  return {
    adapterName: identity.adapterName,
    adapterId: identity.adapterId,
    ...(identity.adapterSessionId === undefined ? {} : { adapterSessionId: identity.adapterSessionId }),
  };
}

/**
 * Build the atomic compare-and-swap predicates for a session update.
 * @param payload - Session update payload.
 * @param sessions - Dialect-resolved sessions table object.
 * @returns Predicates for status, identity backfill, and reconciliation authority.
 */
export function buildSessionUpdateGuards(payload: SessionUpdatePayload, sessions: SessionsTable): SessionUpdateGuards {
  const expectedLead = payload.expectIdentityOpenForLead;
  const reconciliation = payload.reconcileAdapterSession;
  return {
    status: payload.expectedStatus === undefined ? undefined : inArray(sessions.status, payload.expectedStatus),
    identity:
      expectedLead === undefined
        ? undefined
        : and(
            isNull(sessions.adapterName),
            isNull(sessions.adapterId),
            expectedLead === null ? isNull(sessions.leadAgentId) : eq(sessions.leadAgentId, expectedLead),
          ),
    reconciliation:
      reconciliation === undefined
        ? undefined
        : and(
            isNull(sessions.adapterSessionId),
            eq(sessions.leadAgentId, reconciliation.agentId),
            or(
              and(isNull(sessions.adapterName), isNull(sessions.adapterId)),
              and(
                eq(sessions.adapterName, reconciliation.adapterName),
                eq(sessions.adapterId, reconciliation.adapterId),
              ),
            ),
          ),
  };
}

import type { IMakaioSession, SessionStorageUpdateSchema } from '@makaio/contracts';
import type { z } from 'zod';

type SessionUpdatePayload = z.infer<typeof SessionStorageUpdateSchema.request>;

/**
 * Whether an identity backfill must be refused against this stored row.
 *
 * The predicate `expectIdentityOpenForLead` states, in one place, both halves of
 * the rule the session row's adapter identity lives under: the identity is
 * **open** — neither column populated — and the row names the agent the caller
 * is writing for as its **lead**. A row failing either half already describes a
 * conversation, or describes someone else's, and a write that landed anyway
 * would replace a value it never observed.
 *
 * Both halves are named here so the two backends cannot drift on them. The SQL
 * backend still carries the same conjuncts *inside* its update statement — that
 * is what makes the check atomic with the write — and calls this only where it
 * has already read the row for another reason, to distinguish a refusal from the
 * write race its baseline loop retries. The memory backend has no statement to
 * put a predicate in and evaluates it here, against the stored row rather than
 * against the caller's snapshot, which is the same thing the SQL predicate does.
 *
 * A payload carrying no predicate is never refused: the schema pairs the
 * predicate with the identity write, so its absence means this update touches no
 * identity column at all.
 * @param stored - The row as storage holds it right now.
 * @param payload - The update being applied.
 * @returns `true` when the identity write may not land.
 */
export function isIdentityBackfillRefused(stored: IMakaioSession, payload: SessionUpdatePayload): boolean {
  const expectedLeadAgentId = payload.expectIdentityOpenForLead;
  if (expectedLeadAgentId === undefined) return false;
  if (stored.adapterName !== undefined || stored.adapterId !== undefined) return true;
  return (stored.leadAgentId ?? null) !== expectedLeadAgentId;
}

/**
 * Whether a lead's provider-session reconciliation must be refused.
 *
 * A reconciliation fills a missing provider session ID. It may establish a fully
 * open identity or confirm the exact identity already stored, but it must never
 * repair a half-open identity: that malformed row does not identify a trustworthy
 * conversation for this announcement to complete.
 * @param stored - The row as storage holds it right now.
 * @param payload - The update carrying an optional reconciliation operation.
 * @returns `true` when the reconciliation may not land.
 */
export function isAdapterSessionReconciliationRefused(stored: IMakaioSession, payload: SessionUpdatePayload): boolean {
  const reconciliation = payload.reconcileAdapterSession;
  if (reconciliation === undefined) return false;
  if (stored.adapterSessionId !== undefined || stored.leadAgentId !== reconciliation.agentId) return true;

  const identityIsOpen = stored.adapterName === undefined && stored.adapterId === undefined;
  const identityMatches =
    stored.adapterName === reconciliation.adapterName && stored.adapterId === reconciliation.adapterId;
  return !identityIsOpen && !identityMatches;
}

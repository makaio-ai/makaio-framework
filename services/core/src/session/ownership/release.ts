import {
  SessionOwnershipStorageSubjects,
  type SessionOwnershipReleaseAgentClaimsResult,
  type SessionOwnershipReleaseServiceRequest,
} from '@makaio/contracts';
import type { OwnershipAuthorityContext } from './context.js';

/**
 * Give up an agent's claims — one named generation, or every one it holds.
 *
 * A pass-through by design, and identity-independent: releasing needs no
 * machine identity, because the authority to give a claim up is having been the
 * one who took it. It is likewise never `disposed`-guarded — retiring a removed
 * agent's claims is the one ownership act it must still be able to perform, and
 * a guard here would strand exactly the claims that most need retiring.
 *
 * Idempotent in every form: an agent with no claims, including one whose row is
 * gone entirely, yields empty lists rather than an error, and a foreign token
 * reports `claimTokenNotFound` without revealing who holds it.
 *
 * The disposition is the caller's evidence and is never inferred here. Only a
 * failure that provably never reached the provider may release cleanly; a
 * teardown after dispatch files `abandoned`, because the provider process may
 * still be alive under that key.
 *
 * **A host without ownership storage answers, it does not fail.** The authority
 * is composed with the session service, but the ownership *storage* handlers are
 * registered separately, so the two can legitimately come apart. Requesting
 * hard there would turn "there are no claims here" into a rejection — and the
 * one caller that cannot survive that is `agent.removed`, an event handler
 * whose own `requestOptional` suppresses an unhandled *subject* but not a
 * handler that threw. A removal would then fail on a host that owns no claims
 * to begin with. Same degrade posture as everywhere else in this wave: no
 * store, nothing taken, nothing to give back.
 * @param context - Composed authority context.
 * @param request - Which claims to give up, and how.
 * @returns What the release retired.
 */
export async function runRelease(
  context: OwnershipAuthorityContext,
  request: SessionOwnershipReleaseServiceRequest,
): Promise<SessionOwnershipReleaseAgentClaimsResult> {
  const released = await context.bus.requestOptional(SessionOwnershipStorageSubjects.releaseAgentClaims, {
    agentId: request.agentId,
    ...(request.claimToken !== undefined && { claimToken: request.claimToken }),
    disposition: request.disposition,
  });
  if (released.handled) return released.data;
  return {
    releasedProviderSessionIds: [],
    markedClaims: [],
    // A named token matched nothing, because nothing is stored at all — the
    // same answer the store gives for a token this agent does not hold.
    claimTokenNotFound: request.claimToken !== undefined,
  };
}

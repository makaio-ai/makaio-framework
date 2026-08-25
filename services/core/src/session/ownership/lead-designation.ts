import type { IMakaioBus } from '@makaio/bus-core';
import { SessionOwnershipStorageSubjects, type SessionOwnershipClaimResult } from '@makaio/contracts';
import { mintClaimToken } from './claim-token.js';

/**
 * The ownership key a designation-only claim is filed under — none.
 *
 * A keyless reservation writes no claim row at all: its whole effect is the
 * compare-and-swap designation and the currency mirror that follows a promotion.
 * The machine/adapter/provider triple is required by the shared key schema and is
 * read by neither backend on that path, so it is stated as an explicit sentinel
 * rather than filled from whatever adapter identity the caller happens to hold.
 * Two reasons: nothing can then come to depend on a value that names nothing
 * here, and a designation keeps working in a host with no machine identity —
 * which is correct, because designating a session's lead has never been an act
 * that owns a provider session.
 */
export const KEYLESS_DESIGNATION_KEY = {
  machineId: 'keyless-designation',
  adapterId: 'keyless-designation',
  adapterName: 'keyless-designation',
} as const;

/** A compare-and-swap write of a session's lead designation. */
export interface LeadDesignationRequest {
  /** Session whose designation is being written. */
  readonly sessionId: string;
  /**
   * Agent the designation is written for.
   *
   * The new lead, or — with {@link LeadDesignationRequest.clear} — the departing
   * one whose designation is being unset.
   */
  readonly agentId: string;
  /**
   * Lead the caller observed, `null` for "no lead yet".
   *
   * Required, and never inferred: a designation that took whatever it found
   * would not be a compare-and-swap, and would let two concurrent starts both
   * believe they lead.
   */
  readonly expectedLeadAgentId: string | null;
  /** Unset the designation instead of pointing it at `agentId`. */
  readonly clear?: true;
  /** Mark this as failed-start cleanup restoring a prior non-null lead. */
  readonly restore?: true;
}

/**
 * Write a session's lead designation through the reserving transaction.
 *
 * Lead designation has exactly one writer, and this is the call that reaches it.
 * The whole-record session surface preserves the stored designation precisely so
 * that a caller holding a pre-designation snapshot cannot overwrite or unset one
 * it never observed — which leaves the keyless claim as the only way to write it,
 * for the paths Wave 2 reorders and for the ones it does not alike.
 *
 * Best-effort by construction: a host with no ownership storage registered gets
 * `undefined` rather than a throw, the same degradation every other session
 * storage read in these handlers already accepts.
 * @param bus - Bus the claim is issued on.
 * @param request - The designation to write.
 * @returns The claim outcome, or `undefined` when no ownership storage answered.
 */
export async function designateSessionLead(
  bus: IMakaioBus,
  request: LeadDesignationRequest,
): Promise<SessionOwnershipClaimResult | undefined> {
  const result = await bus.requestOptional(SessionOwnershipStorageSubjects.claim, {
    ...KEYLESS_DESIGNATION_KEY,
    providerSessionId: null,
    sessionId: request.sessionId,
    agentId: request.agentId,
    claimToken: mintClaimToken(),
    designateLead: {
      expectedLeadAgentId: request.expectedLeadAgentId,
      ...(request.clear === true && { clear: true as const }),
      ...(request.restore === true && { restore: true as const }),
    },
  });
  return result.handled ? result.data : undefined;
}

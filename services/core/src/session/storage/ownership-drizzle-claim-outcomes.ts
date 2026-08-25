import type { SessionOwnershipClaimResult } from '@makaio/contracts';
import { mapClaim, type ClaimRow, type LeadDesignationOutcome } from './ownership-drizzle-rows.js';

/**
 * Name the modeled `lead-conflict` outcome.
 * @param currentLeadAgentId - Lead the session actually names, or `null`.
 * @returns The `lead-conflict` result.
 */
export function leadConflict(currentLeadAgentId: string | null): SessionOwnershipClaimResult {
  return { outcome: 'lead-conflict', currentLeadAgentId };
}

/**
 * Report a claim that was taken, or recognized as already taken.
 * @param outcome - Whether this call took the generation or found its own.
 * @param claim - The generation as it now stands, or `null` for a keyless reservation.
 * @param lead - What the sessions phase established.
 * @returns The modeled claim outcome.
 */
export function takenClaim(
  outcome: 'claimed' | 'idempotent',
  claim: ClaimRow | null,
  lead: LeadDesignationOutcome,
): SessionOwnershipClaimResult {
  return {
    outcome,
    claim: claim === null ? null : mapClaim(claim),
    leadDesignated: lead.leadDesignated,
    previousLeadAgentId: lead.previousLeadAgentId,
  };
}

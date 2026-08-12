/** Structural classification for lead-designation-only ownership requests. */
import { z } from 'zod';

/** Lead designation flags accepted by the ownership claim contract. */
export interface SessionOwnershipLeadDesignationMutation {
  readonly expectedLeadAgentId: string | null;
  readonly clear?: true;
  readonly restore?: true;
}

/** Fields that determine whether a claim only mutates a lead designation. */
export interface SessionOwnershipDesignationMutationCandidate {
  readonly agentId: string;
  readonly providerSessionId: string | null;
  readonly ownerInstance?: unknown;
  readonly recoveryGuard?: unknown;
  readonly recoveryAttemptId?: unknown;
  readonly supersedes?: unknown;
  readonly designateLead?: SessionOwnershipLeadDesignationMutation;
}

/**
 * Whether a request carries no ownership acquisition fields.
 * @param value - Claim fields relevant to acquisition.
 * @returns Whether the request is structurally designation-only.
 */
function hasPureDesignationShape(value: SessionOwnershipDesignationMutationCandidate): boolean {
  return (
    value.providerSessionId === null &&
    value.ownerInstance === undefined &&
    value.recoveryGuard === undefined &&
    value.recoveryAttemptId === undefined &&
    value.supersedes === undefined
  );
}

/**
 * Whether a request is a keyless, unguarded lead relinquishment.
 * @param value - Claim fields relevant to acquisition.
 * @returns Whether no authority is acquired or published.
 */
export function isPureLeadRelinquishment(value: SessionOwnershipDesignationMutationCandidate): boolean {
  return (
    value.designateLead?.clear === true &&
    value.designateLead.restore !== true &&
    value.designateLead.expectedLeadAgentId === value.agentId &&
    hasPureDesignationShape(value)
  );
}

/**
 * Whether a request is a keyless, unguarded restoration of a prior lead.
 * @param value - Claim fields relevant to acquisition.
 * @returns Whether the request only restores a designation under CAS.
 */
export function isPureLeadRestoration(value: SessionOwnershipDesignationMutationCandidate): boolean {
  return (
    value.designateLead?.restore === true &&
    value.designateLead.clear !== true &&
    value.designateLead.expectedLeadAgentId !== null &&
    value.designateLead.expectedLeadAgentId !== value.agentId &&
    hasPureDesignationShape(value)
  );
}

/**
 * Whether a designation mutation is safe after the session becomes inactive.
 * @param value - Claim fields relevant to acquisition.
 * @returns Whether the request only clears or restores a prior designation.
 */
export function isInactiveSafeLeadDesignationMutation(value: SessionOwnershipDesignationMutationCandidate): boolean {
  return isPureLeadRelinquishment(value) || isPureLeadRestoration(value);
}

/**
 * Explain why a flagged designation request is not a pure mutation.
 * @param value - Claim fields relevant to acquisition.
 * @returns The contract violation, or `undefined` for a valid mutation.
 */
export function getLeadDesignationMutationViolation(
  value: SessionOwnershipDesignationMutationCandidate,
): string | undefined {
  const designation = value.designateLead;
  if (designation?.clear === true && designation.restore === true) {
    return 'a lead designation cannot be both cleared and restored';
  }
  if (designation?.clear === true && !isPureLeadRelinquishment(value)) {
    return 'a lead clear must be a keyless, unguarded relinquishment';
  }
  if (designation?.restore === true && !isPureLeadRestoration(value)) {
    return 'a lead restore must be a keyless, unguarded restoration';
  }
  return undefined;
}

/**
 * Add canonical designation-mutation issues to a claim schema refinement.
 * @param value - Claim fields relevant to designation and recovery.
 * @param ctx - Active schema refinement context.
 */
export function validateLeadDesignationMutation(
  value: SessionOwnershipDesignationMutationCandidate,
  ctx: z.RefinementCtx,
): void {
  const violation = getLeadDesignationMutationViolation(value);
  if (violation !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['designateLead'], message: violation });
  }
  if (value.recoveryGuard !== undefined && value.designateLead !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['designateLead'],
      message: 'a guarded recovery claim cannot designate the session lead',
    });
  }
}

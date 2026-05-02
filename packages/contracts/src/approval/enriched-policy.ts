import { z } from 'zod';

/**
 * RPC schema for resolving a persona/profile-enriched approval policy.
 *
 * ToolApprovalService uses this RPC to obtain enriched approval policies
 * without importing host-tier storage subjects. The host-tier handler
 * performs persona/profile lookups and returns the merged policy decision.
 */
export const ResolveEnrichedPolicySchema = {
  /**
   * Resolve an enriched approval policy for a given tool and agent context.
   *
   * Subject: `approval.resolveEnrichedPolicy`
   * Type: Request (RPC)
   * @example
   * ```typescript
   * const policy = await bus.request(
   *   ApprovalSubjects.resolveEnrichedPolicy,
   *   { toolName: 'bash', personaId: 'persona-uuid' },
   * );
   * // policy.action === 'ask'
   * // policy.riskLevel === 'destructive'
   * ```
   */
  resolveEnrichedPolicy: {
    request: z.object({
      /** Tool name to resolve the approval policy for. */
      toolName: z.string(),
      /** Persona identifier for policy lookup. Uses default policy when omitted. */
      personaId: z.string().optional(),
      /** Profile identifier for policy lookup. Uses default policy when omitted. */
      profileId: z.string().optional(),
    }),
    response: z.object({
      /** Resolved approval action for the tool. */
      action: z.enum(['allow', 'deny', 'ask']),
      /** Risk level inherited from the persona/profile policy. */
      riskLevel: z.enum(['safe', 'neutral', 'destructive']).optional(),
      /**
       * Directory restrictions from the resolved profile.
       * Absent when no profile is active or the profile sets no restrictions.
       */
      allowedDirectories: z.array(z.string()).optional(),
      /** Human-readable display name of the active persona, if resolved. */
      personaName: z.string().optional(),
      /** Human-readable display name of the active profile, if resolved. */
      profileName: z.string().optional(),
    }),
  },
};

/** Inferred request type for `approval.resolveEnrichedPolicy`. */
export type ResolveEnrichedPolicyRequest = z.infer<typeof ResolveEnrichedPolicySchema.resolveEnrichedPolicy.request>;

/** Inferred response type for `approval.resolveEnrichedPolicy`. */
export type ResolveEnrichedPolicyResponse = z.infer<typeof ResolveEnrichedPolicySchema.resolveEnrichedPolicy.response>;

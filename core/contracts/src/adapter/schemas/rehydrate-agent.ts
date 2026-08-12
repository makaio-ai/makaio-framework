import { z } from 'zod';

/**
 * Rehydrate an agent by swapping its connector.
 *
 * Subject: `adapter.rehydrateAgent`
 * Type: Request (RPC)
 * Purpose: Allows the orchestrator to swap an agent's connector (e.g., after a crash)
 * instead of killing and recreating the agent. This preserves the agent's
 * identity and session state while replacing the underlying execution context.
 *
 * The adapter will:
 * 1. Stop the existing connector for the specified agent
 * 2. Create a new connector with optional config overrides (cwd, model)
 * 3. Wire the new connector to the existing agent instance
 *
 * The response is a disposition union, mirroring `adapter.startAgent`. A refusal
 * the adapter takes *before* anything reaches the provider — a disposed agent,
 * or a provider session already claimed by another in-flight operation — is
 * modelled as `{ success: false, dispatch: 'not-dispatched' }` so a caller that
 * reserved provider-session ownership can give the reservation back cleanly
 * instead of retiring it as possibly-live debris. Every other failure still
 * throws, and a throw is `'dispatch-uncertain'` by construction: it can come
 * from anywhere in provider-context activation, agent creation or the connector
 * swap.
 * @param adapterId - Target adapter instance ID
 * @param agentId - Agent to rehydrate
 * @param cwd - Optional working directory override for new connector
 * @param model - Optional model override for new connector
 * @param resumeAdapterSessionId - Optional provider session to natively resume
 * @param callerOwnsAgentRow - Set when the caller owns the agent row's status transitions
 */
export const RehydrateAgentSchema = {
  request: z.object({
    /** Target adapter instance ID */
    adapterId: z.string(),

    /** Exact runtime incarnation to target when owner routing is required. */
    ownerInstanceId: z.string().optional(),

    /** Agent to rehydrate */
    agentId: z.string(),

    /** Optional working directory override for new connector */
    cwd: z.string().optional(),

    /** Optional model override for new connector (adapter-specific, e.g., 'sonnet', 'opus') */
    model: z.string().optional(),

    /**
     * Provider-native session ID to resume.
     *
     * When present the adapter creates the connector in native-resume mode so
     * the provider session continues where it left off, and the resumed
     * generation adopts it as its identity. The caller (service layer) is
     * responsible for evaluating locality before setting this field; the
     * adapter trusts it without re-evaluation. Without it the replacement
     * connector starts fresh and mints a new provider session identity —
     * pinning a used session ID on a fresh generation collides with the
     * provider's durable session store.
     */
    resumeAdapterSessionId: z.string().optional(),

    /**
     * The caller owns the agent row for this rehydrate.
     *
     * Set by a caller that reserved provider-session ownership and moved the
     * row to `starting` before dispatching. Its effect is exactly the effect
     * `agentId` has on `startAgent`: the adapter registers the connector and
     * emits lifecycle events as usual but writes **no** `storage:agent.status`,
     * because the caller owns the `starting → idle` transition and performs it
     * as a compare-and-swap after settlement. An unconditional adapter write
     * would revive a row that was removed mid-rehydrate and strand a live
     * connector on it.
     *
     * The flag belongs to the attempt that *starts* the rehydrate. Rehydrates
     * are deduplicated per agent, so a caller may join an attempt another
     * caller started under the other ownership mode; the joiner resolves that
     * divergence on its own side rather than by splitting the dedupe key.
     *
     * Omitted, the adapter owns the status exactly as it always has.
     */
    callerOwnsAgentRow: z.literal(true).optional(),
  }),

  response: z.discriminatedUnion('success', [
    z.object({
      success: z.literal(true),

      /** Runtime incarnation that owns the rehydrated agent. */
      ownerInstanceId: z.string().optional(),

      /**
       * Provider session the connector is **actually** current on after the
       * rehydrate.
       *
       * Not necessarily the `resumeAdapterSessionId` that was requested: the
       * manager prefers the live connector's own identity over the persisted
       * one, because persisted values go stale across restarts and connector
       * replacements. A caller that settles currency must settle on *this*
       * value; settling on what it asked for would write back an identity the
       * provider has already moved off.
       *
       * Absent only when the provider confirmed none; the movement seam
       * announces it later in that case.
       */
      adapterSessionId: z.string().optional(),

      /** Opaque token required to acknowledge a caller-owned settlement. */
      settlementAckToken: z.string().optional(),
    }),
    z.object({
      success: z.literal(false),

      /** Error message describing the refusal. */
      message: z.string(),

      /**
       * Always `'not-dispatched'`.
       *
       * Narrowed to the literal rather than carrying the full
       * `AdapterStartDispositionSchema` union, because `rehydrateAgent`
       * has no way to produce the other member: a *modeled* refusal is by
       * construction a refusal to start, and every failure that may have
       * reached the provider leaves by **throwing**. A field whose only
       * possible value is one member is better spelled as that member — it
       * makes the caller's classification total instead of merely
       * exhaustive-by-convention.
       */
      dispatch: z.literal('not-dispatched'),
    }),
  ]),
};

export type RehydrateAgentRequest = z.infer<typeof RehydrateAgentSchema.request>;
export type RehydrateAgentResponse = z.infer<typeof RehydrateAgentSchema.response>;

import { z } from 'zod';
import { TeardownEvidenceSchema } from './teardown.js';

/**
 * Stop and dispose an agent.
 *
 * Subject: `adapter.stopAgent`
 * Type: Request (RPC)
 * Purpose: Aborts the agent and removes it from the adapter's tracking.
 */
export const StopAgentSchema = {
  request: z.object({
    /** Target adapter instance ID */
    adapterId: z.string(),
    /** Exact runtime incarnation that owns the agent. */
    ownerInstanceId: z.string(),
    /** Agent to stop */
    agentId: z.string(),
    /** Recovery cleanup closes only the hosted connector; ownership writes the row. */
    teardown: z.enum(['connector-only']).optional(),
  }),
  response: z.object({
    /**
     * Whether a live agent was found and its teardown attempted.
     *
     * Unchanged in meaning, deliberately: `false` still means "no such agent
     * here", which several callers legitimately treat as "already gone". What
     * changes is that `true` no longer implies closure — `evidence` says that.
     */
    success: z.boolean(),
    /**
     * What the adapter observed about the teardown.
     *
     * `released` when there was nothing to tear down (`success: false`): a
     * consumer asking "may I claim this key" gets the same answer from "it is
     * gone" as from "it closed cleanly", and that equivalence is the point.
     *
     * A response is attributable to the exact runtime owner named by the
     * request, so an absent agent is terminal for that owner.
     */
    evidence: TeardownEvidenceSchema,
    /** Why the class is not stronger. Present for `detached` and `unknown`. */
    detail: z.string().optional(),
  }),
};

export type StopAgentRequest = z.infer<typeof StopAgentSchema.request>;
export type StopAgentResponse = z.infer<typeof StopAgentSchema.response>;

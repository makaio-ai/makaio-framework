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
    /** Agent to stop */
    agentId: z.string(),
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
     * **Nothing decides anything on this field today, and that is deliberate.**
     * It is read by conformance and by diagnostics; every existing caller still
     * reads `success` alone, as "was it there", which stays true under this
     * response. The field exists so the *next* consumer does not have to invent
     * the evidence first — an ownership release that frees a provider session
     * only once nothing can still be speaking on it.
     *
     * That consumer needs one thing more than this field, which is why it is not
     * built here: a stop that provably reaches **the** owner. A release gated on
     * this class alone would refuse whenever the peer that answered does not host
     * the agent — the ordinary case, since the dispatch is first-result-wins —
     * and it would still not stop the second writer it aimed at, because a
     * takeover accepts a disposed incumbent regardless of its claim's
     * disposition. Owner-process identity is what closes both halves.
     */
    evidence: TeardownEvidenceSchema,
    /** Why the class is not stronger. Present for `detached` and `unknown`. */
    detail: z.string().optional(),
  }),
};

export type StopAgentRequest = z.infer<typeof StopAgentSchema.request>;
export type StopAgentResponse = z.infer<typeof StopAgentSchema.response>;

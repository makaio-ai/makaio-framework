import { z } from 'zod';
import { AIReasoningLevelSchema, ReasoningLevelMapSchema } from '../../model/index.js';
import { BaseAgentEventSchema } from './base-event.js';
import { ProviderContextSchema } from '../../adapter/schemas/provider-context.js';

export const TurnActiveBehaviorSchema = z.enum(['reject', 'stageForNextTurn']);
export type TurnActiveBehavior = z.infer<typeof TurnActiveBehaviorSchema>;

/**
 * Request to change the agent model.
 *
 * Subject: `agent.model.change`
 * Type: Request/Response
 * Sent when: Caller wants to switch the model mid-session
 * Handler: AIAgent attempts native in-place change, falls back to connector swap
 */
// All mutation fields are intentionally optional to support three use cases:
// model+reasoning, model-only, reasoning-only. A no-op request (all absent)
// returns success without mutation — harmless and extensible for future
// fields like provider-only changes.
export const ModelChangeSchema = {
  request: BaseAgentEventSchema.extend({
    /**
     * New model identifier. Optional when only changing reasoning effort
     * without switching models.
     */
    newModel: z.string().optional(),
    /** Reasoning effort level to apply after the model change. */
    reasoningEffort: AIReasoningLevelSchema.optional(),
    /** Skip interactive warning dialog for trusted/programmatic callers */
    skipWarning: z.boolean().optional(),

    /**
     * How to handle mutation requests while a turn is active.
     *
     * - `reject`: return `{ success: false, reason: 'turn_active' }`
     * - `stageForNextTurn`: store the latest request and apply it before the next user turn dispatch
     */
    turnActiveBehavior: TurnActiveBehaviorSchema.optional(),

    /**
     * Unresolved provider context (credential refs, not plaintext).
     * Connectors resolve credentials locally via `resolveConnectorCredentials()`.
     */
    providerContext: ProviderContextSchema.optional(),
  }),
  response: z.object({
    /** Whether the model change was successful */
    success: z.boolean(),
    /** Reason for failure (only present when success is false) */
    reason: z.string().optional(),
    /** Whether the connector was swapped (true) or model changed natively in-place (false). Absent on failure. */
    swapped: z.boolean().optional(),
    /** Whether the change was accepted but deferred until the next turn boundary. */
    staged: z.boolean().optional(),
    /** Current model identifier after the change. Absent on failure. */
    model: z.string().optional(),
    /** Reasoning effort level that is now active. Absent on failure or when unchanged. */
    appliedReasoningEffort: AIReasoningLevelSchema.optional(),
    /** Reasoning levels supported by the current model. Absent on failure or when unsupported. */
    supportedReasoningLevels: ReasoningLevelMapSchema.optional(),
  }),
};

export type ModelChangeRequest = z.infer<typeof ModelChangeSchema.request>;
export type ModelChangeResponse = z.infer<typeof ModelChangeSchema.response>;

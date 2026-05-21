import { z } from 'zod';
import { CredentialRefSchema } from '../../config/credential-ref.js';
import { CredentialChangeSequenceSchema } from '../../credential/change-sequence.js';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * Request to change agent credentials mid-session.
 *
 * Subject: `agent.credential.change`
 * Type: Request/Response
 * Sent when: Credential state changes (account-manager rotation or user config update)
 * Handler: AIAgent re-resolves credentials, rebuilds connector if SDK-based
 */
export const CredentialChangeSchema = {
  request: BaseAgentEventSchema.omit({ adapterSessionId: true }).extend({
    /** Provider's native session ID is optional for persisted agents during credential fan-out. */
    adapterSessionId: z.string().optional(),
    /** Provider config UUID whose credentials changed. */
    providerConfigId: z.string(),
    /** Provider definition ID (e.g., `'anthropic'`). */
    definitionId: z.string(),
    /** Monotonic per-provider-config change token used to reject stale fan-out. */
    changeSequence: CredentialChangeSequenceSchema,
    /** Updated credential references to resolve. */
    credentialRefs: z.record(z.string(), CredentialRefSchema),
  }),
  response: z.discriminatedUnion('success', [
    z.object({
      /** Credential change applied successfully. */
      success: z.literal(true),
      /** Connector was rebuilt — credential rotation forces a full connector swap so both SDK and subprocess adapters re-resolve. */
      swapped: z.literal(true),
    }),
    z.object({
      /** Credential change was not applied. */
      success: z.literal(false),
      /** Reason for failure (e.g., `'turn_active'`, `'credential_swap_failed: ...'`). */
      reason: z.string(),
    }),
  ]),
};

export type CredentialChangeRequest = z.infer<typeof CredentialChangeSchema.request>;
export type CredentialChangeResponse = z.infer<typeof CredentialChangeSchema.response>;

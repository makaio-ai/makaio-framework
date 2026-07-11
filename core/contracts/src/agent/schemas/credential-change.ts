import { z } from 'zod';
import { ResolvedProviderContextSchema } from '../../adapter/schemas/provider-context.js';
import { CredentialChangeSequenceSchema } from '../../credential/change-sequence.js';
import { BaseAgentEventSchema } from './base-event.js';

const CredentialChangeFailureReasonSchema = z.enum([
  'provider_mismatch',
  'stale_change',
  'turn_active',
  'credential_activation_failed:manager-unavailable',
  'credential_activation_failed:account-not-found',
  'credential_activation_failed:activation-failed',
  'credential_swap_failed',
]);

/**
 * Request to change agent credentials mid-session.
 *
 * Subject: `agent.credential.change`
 * Type: Request/Response
 * Sent when: Credential state changes (account-manager rotation or user config update)
 * Handler: AIAgent re-resolves credentials, rebuilds connector if SDK-based
 */
export const CredentialChangeSchema = {
  request: BaseAgentEventSchema.omit({ providerConfigId: true })
    .extend({
      /** Monotonic per-provider-config change token used to reject stale fan-out. */
      changeSequence: CredentialChangeSequenceSchema,
      /** Complete refs-only provider context that replaces the active selection. */
      providerContext: ResolvedProviderContextSchema,
    })
    .strict(),
  response: z.discriminatedUnion('success', [
    z
      .object({
        /** Credential change applied successfully. */
        success: z.literal(true),
        /** Connector was rebuilt — credential rotation forces a full connector swap so both SDK and subprocess adapters re-resolve. */
        swapped: z.literal(true),
      })
      .strict(),
    z
      .object({
        /** Credential change was not applied. */
        success: z.literal(false),
        /** Stable credential-free failure category. */
        reason: CredentialChangeFailureReasonSchema,
      })
      .strict(),
  ]),
};

export type CredentialChangeRequest = z.infer<typeof CredentialChangeSchema.request>;
export type CredentialChangeResponse = z.infer<typeof CredentialChangeSchema.response>;

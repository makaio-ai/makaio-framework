import { z } from 'zod';
import { ResponseSchemaDescriptorSchema, StructuredOutputValidationErrorSchema } from '../../shared/response-schema.js';

/**
 * RPC schema for resolving the structured-output retry policy.
 *
 * Subject: `agent.structuredOutput.retryPolicy`
 * Type: Request (RPC)
 * Direction: framework → host
 *
 * Emitted before a retry decision is made. The host layer (or any registered
 * override handler) returns the maximum number of retry attempts permitted for
 * this agent/adapter/schema combination. The framework-owned default policy is
 * `maxRetries: 0`, so structured-output validation does not replay turns unless
 * a host explicitly opts in. Replaying a turn can duplicate non-idempotent tool
 * or outbound side effects.
 */
export const StructuredOutputRetryPolicySchema = {
  request: z
    .object({
      /** Stable identifier of the agent whose output failed validation. */
      agentId: z.string(),
      /** Runtime identifier of the adapter that produced the output. */
      adapterId: z.string(),
      /** Capability tags reported by the adapter (e.g. `'structured-output'`). */
      adapterCapabilities: z.array(z.string()),
      /** Schema descriptor that was active when validation failed. */
      responseSchema: ResponseSchemaDescriptorSchema,
      /** 1-based index of the attempt that just failed. */
      attemptNumber: z.number().int().min(1),
    })
    .strict(),
  response: z
    .object({
      /** Maximum number of retry attempts the host permits (0 = no retries). */
      maxRetries: z.number().int().min(0).max(5),
    })
    .strict(),
};

/**
 * RPC schema for enforcing structured output after validation failures.
 *
 * Subject: `agent.structuredOutput.enforce`
 * Type: Request (RPC)
 * Direction: framework → host
 *
 * Emitted when retry attempts are exhausted and the framework needs the host
 * to decide whether to enforce conformance via a fallback adapter/model or
 * to surface the error upstream. The framework-owned default handler is a
 * no-op that returns `enforced: false`; enforcement only happens when a host
 * registers an override handler. Returning `enforced: true` with a corrected
 * `output` string means the framework treats the turn as successfully completed.
 */
export const StructuredOutputEnforceSchema = {
  request: z
    .object({
      /** Stable identifier of the agent whose output could not be validated. */
      agentId: z.string(),
      /** Runtime identifier of the adapter that produced the output. */
      adapterId: z.string(),
      /** Session identifier for context enrichment, when available. */
      sessionId: z.string().optional(),
      /** Schema descriptor that the output must conform to. */
      responseSchema: ResponseSchemaDescriptorSchema,
      /** Raw output string that failed validation. */
      rawOutput: z.string(),
      /** Validation errors describing why `rawOutput` is non-conformant. */
      validationErrors: z.array(StructuredOutputValidationErrorSchema).min(1),
      /** Whether the primary adapter reports native structured-output capability. */
      adapterHasCapability: z.boolean(),
      /** Adapter ID of a fallback adapter to use for re-inference, if known. */
      fallbackAdapterId: z.string().optional(),
      /** Human-readable name of the fallback adapter. */
      fallbackAdapterName: z.string().optional(),
      /** Model identifier to use on the fallback adapter. */
      fallbackModel: z.string().optional(),
    })
    .strict(),
  response: z.discriminatedUnion('enforced', [
    z
      .object({
        /** Whether enforcement produced a conformant output. Always `true` in this branch. */
        enforced: z.literal(true),
        /** Corrected output string; required when `enforced` is `true`. */
        output: z.string(),
      })
      .strict(),
    z
      .object({
        /** Whether enforcement produced a conformant output. Always `false` in this branch. */
        enforced: z.literal(false),
        /** Human-readable error describing why enforcement failed; required when `enforced` is `false`. */
        error: z.string(),
      })
      .strict(),
  ]),
};

export type StructuredOutputRetryPolicyRequest = z.infer<typeof StructuredOutputRetryPolicySchema.request>;
export type StructuredOutputRetryPolicyResponse = z.infer<typeof StructuredOutputRetryPolicySchema.response>;
export type StructuredOutputEnforceRequest = z.infer<typeof StructuredOutputEnforceSchema.request>;
export type StructuredOutputEnforceResponse = z.infer<typeof StructuredOutputEnforceSchema.response>;

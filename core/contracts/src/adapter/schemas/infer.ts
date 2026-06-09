import { z } from 'zod';
import { ResponseSchemaDescriptorSchema } from '../../shared/index.js';
import { ProviderContextSchema } from './provider-context.js';

/**
 * One-shot inference request/response schema.
 *
 * Subject: `adapter.infer`
 * Type: Request (RPC)
 * Purpose: Ephemeral LLM inference without agent lifecycle overhead.
 *          Used for classification, quick prompts, and meta-LLM calls.
 *
 * The adapter creates a temporary connector, executes the inference,
 * extracts the text response, and cleans up — no persistent agent.
 */
export const InferSchema = {
  request: z.object({
    /** Target adapter instance ID */
    adapterId: z.string(),

    /** User prompt text */
    prompt: z.string(),

    /** Model to use (optional - adapter provides default) */
    model: z.string().optional(),

    /** System prompt for inference instructions (optional) */
    systemPrompt: z.string().optional(),

    /**
     * Structured output descriptor.
     * When present and supported by the adapter, constrains the inference response
     * to the declared JSON Schema.
     */
    responseSchema: ResponseSchemaDescriptorSchema.optional(),

    /**
     * Unresolved provider context (credential refs, not plaintext).
     * Connectors resolve credentials locally via `resolveConnectorCredentials()`.
     */
    providerContext: ProviderContextSchema.optional(),
  }),
  response: z.object({
    /** Extracted text from inference result */
    text: z.string(),

    /** Token usage statistics (optional, adapter-dependent) */
    usage: z
      .object({
        inputTokens: z.number(),
        outputTokens: z.number(),
      })
      .optional(),
  }),
};

export type InferRequest = z.infer<typeof InferSchema.request>;
export type InferResponse = z.infer<typeof InferSchema.response>;

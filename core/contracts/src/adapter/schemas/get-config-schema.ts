import { z } from 'zod';

/**
 * Get adapter config schema as JSON Schema.
 *
 * Subject: `adapter.getConfigSchema`
 * Type: Request (RPC)
 * Purpose: Returns the adapter's providerConfig schema serialized as JSON Schema
 *          for dynamic form generation in web-ui.
 *
 * The response includes the full JSON Schema representation of the adapter's
 * configSchema field, suitable for rendering configuration forms.
 * @example
 * ```typescript
 * const { jsonSchema } = await bus.request(AdapterSubjects.getConfigSchema, {
 *   adapterName: 'claude-code',
 * });
 * // jsonSchema contains the JSON Schema for claude-code's config fields
 * ```
 */
export const GetConfigSchemaSchema = {
  request: z.object({
    /** Adapter name to get schema for (e.g., 'claude-code', 'openai-node') */
    adapterName: z.string(),
  }),
  response: z.object({
    /** Whether a schema was found for this adapter */
    found: z.boolean(),
    /** Adapter name echoed back */
    adapterName: z.string(),
    /** JSON Schema representation of the adapter's configSchema (null if not found) */
    jsonSchema: z.record(z.string(), z.unknown()).nullable(),
  }),
};

export type GetConfigSchemaRequest = z.infer<typeof GetConfigSchemaSchema.request>;
export type GetConfigSchemaResponse = z.infer<typeof GetConfigSchemaSchema.response>;

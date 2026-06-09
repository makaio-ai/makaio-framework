import { z } from 'zod';
import { JsonSchemaRecordSchema } from './json-value.js';

/**
 * Validates that a provider schema name is safe for use with all supported providers.
 *
 * OpenAI requires names that match `[a-zA-Z0-9_-]` and are at most 64 characters.
 * Adapters must derive a conforming name when none is supplied.
 */
export const ResponseSchemaNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/);

/**
 * Descriptor for a JSON Schema document that constrains an agent's structured response.
 *
 * Passed through the session bus so adapters can forward native structured-output
 * constraints to their underlying provider (e.g. OpenAI `response_format`, Anthropic
 * tool-schema trick). Fields are intentionally narrow to stay JSON-safe and
 * round-trippable over the wire.
 */
export const ResponseSchemaDescriptorSchema = z
  .object({
    /** JSON Schema document constraining the agent response. */
    schema: JsonSchemaRecordSchema,
    /** Provider-safe schema name. Required by OpenAI; derived by adapters when absent. */
    name: ResponseSchemaNameSchema.optional(),
    /** Hint for providers that support strict structured output. */
    strict: z.boolean().optional(),
  })
  .strict();

/**
 * Normalized representation of a single structured-output validation error.
 *
 * Mirrors the AJV error shape so validation results from different validators
 * can be mapped to a common format without pulling AJV into every consumer.
 */
export const StructuredOutputValidationErrorSchema = z
  .object({
    /** Human-readable error description. */
    message: z.string(),
    /** JSON Pointer to the failing value in the instance (AJV `instancePath`). */
    instancePath: z.string(),
    /** JSON Pointer into the schema at the failing keyword (AJV `schemaPath`). */
    schemaPath: z.string(),
  })
  .strict();

/**
 * Lifecycle status of a structured-output validation pass.
 *
 * - `passed`   – The response conforms to the declared schema.
 * - `failed`   – Validation errors were found; `errors` will be populated.
 * - `enforced` – A structured-output enforcement handler produced conformant output.
 */
export const StructuredOutputValidationStatusSchema = z.enum(['passed', 'failed', 'enforced']);

/**
 * Full validation result emitted after a turn completes when a
 * {@link ResponseSchemaDescriptor} was active.
 *
 * When `status` is `failed`, `errors` contains at least one entry describing
 * what the agent's response violated. The discriminated union enforces that
 * `errors` is absent for `passed`/`enforced` and required (non-empty) for
 * `failed`.
 */
export const StructuredOutputValidationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('passed') }).strict(),
  z.object({ status: z.literal('enforced') }).strict(),
  z
    .object({
      /** Outcome of the structured-output validation pass. */
      status: z.literal('failed'),
      /** Normalised validation errors; at least one entry is always present. */
      errors: z.array(StructuredOutputValidationErrorSchema).min(1),
    })
    .strict(),
]);

/** @see {@link ResponseSchemaNameSchema} */
export type ResponseSchemaName = z.infer<typeof ResponseSchemaNameSchema>;

/** @see {@link ResponseSchemaDescriptorSchema} */
export type ResponseSchemaDescriptor = z.infer<typeof ResponseSchemaDescriptorSchema>;

/** @see {@link StructuredOutputValidationSchema} */
export type StructuredOutputValidation = z.infer<typeof StructuredOutputValidationSchema>;

/** @see {@link StructuredOutputValidationErrorSchema} */
export type StructuredOutputValidationError = z.infer<typeof StructuredOutputValidationErrorSchema>;

/** @see {@link StructuredOutputValidationStatusSchema} */
export type StructuredOutputValidationStatus = z.infer<typeof StructuredOutputValidationStatusSchema>;

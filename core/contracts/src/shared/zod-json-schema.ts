import { z } from 'zod';
import type { JsonValue } from './json-value.js';

/**
 * Converts a live Zod schema to a plain JSON Schema record compatible with
 * `JsonSchemaRecordSchema`.
 *
 * Uses Zod v4's built-in `z.toJSONSchema()` and strips the `$schema` dialect
 * marker so the result can be embedded directly in serializable payloads —
 * workflow definitions, artifact kind registrations, Reaction descriptors —
 * without triggering schema-dialect validation in consumers.
 * @param schema - Any Zod schema to convert.
 * @param direction - Whether to serialize the schema's input or output shape.
 *   Defaults to output, preserving Zod's default conversion behavior.
 * @returns A plain JSON Schema record without a `$schema` key.
 */
export function zodSchemaToJsonRecord(
  schema: z.ZodType,
  direction: 'input' | 'output' = 'output',
): Record<string, JsonValue> {
  const raw = z.toJSONSchema(schema, { io: direction }) as Record<string, JsonValue>;
  const { $schema: _dropped, ...rest } = raw;
  return rest;
}

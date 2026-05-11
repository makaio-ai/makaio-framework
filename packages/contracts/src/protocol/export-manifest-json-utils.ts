import { z } from 'zod';
import type { JsonObject } from './types.js';
import { compareStrings } from './export-manifest-string-utils.js';

/**
 * Check whether a value is a JSON object.
 * @param value - Value to check
 * @returns True when the value is a non-array object
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively sort JSON object keys while preserving array order.
 * @param value - JSON-compatible value to sort
 * @returns Value with object keys sorted deterministically
 */
export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }

  if (!isJsonObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

/**
 * Convert a Zod schema to the embedded manifest JSON Schema shape.
 * @param namespace - Namespace being exported
 * @param subject - Subject being exported
 * @param schema - Zod schema to convert
 * @returns JSON Schema without a top-level dialect marker
 */
export function toManifestJsonSchema(namespace: string, subject: string, schema: z.ZodType): JsonObject {
  let exportedSchema: unknown;

  try {
    exportedSchema = z.toJSONSchema(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to export JSON Schema for ${namespace}.${subject}: ${message}`);
  }

  if (!isJsonObject(exportedSchema)) {
    throw new Error(`Failed to export JSON Schema for ${namespace}.${subject}: exporter returned a non-object schema`);
  }

  const schemaWithoutDialect = { ...exportedSchema };
  delete schemaWithoutDialect.$schema;
  return sortJsonValue(schemaWithoutDialect) as JsonObject;
}

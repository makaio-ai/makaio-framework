/**
 * Schema introspection utilities for CLI argument manifests.
 *
 * Converts Zod object schemas into serializable {@link CliArgManifest} arrays.
 * Used by `cli.listContributions` to expose typed CLI metadata over the bus
 * without requiring handler code to be loaded on the client.
 */
import { z } from 'zod';
import type { CliArgManifest } from '@makaio/contracts/extension';
import { type FieldSchema, getMeta, isBooleanSchema } from './schema-utils.js';

/**
 * Convert a Zod object schema into serializable CLI argument manifests.
 *
 * Walks the schema's shape, reads `.meta()` from each field (unwrapping
 * optional/default wrappers), and produces a {@link CliArgManifest} per field.
 * This is the serialization counterpart to `schema-adapter.ts`'s registration
 * logic — same introspection, different output format.
 * @param schema - A Zod object schema defining a subcommand's arguments.
 * @returns An array of serializable argument manifests.
 */
export function toCliArgManifests(schema: z.ZodObject<z.ZodRawShape>): CliArgManifest[] {
  const manifests: CliArgManifest[] = [];

  for (const [key, rawField] of Object.entries(schema.shape)) {
    const fieldSchema = rawField as FieldSchema;
    const meta = getMeta(fieldSchema);
    const type = resolveType(fieldSchema);

    manifests.push({
      name: key,
      description: meta?.description ?? '',
      ...(!fieldSchema.isOptional() && { required: true }),
      ...(meta?.positional && { positional: true }),
      ...(meta?.short && { short: meta.short }),
      ...(type !== 'string' && { type }),
    });
  }

  return manifests;
}

/**
 * Resolve the CLI argument type from a Zod schema, unwrapping wrappers as needed.
 * @param schema - The Zod schema to inspect.
 * @returns The argument type string.
 */
function resolveType(schema: FieldSchema): 'string' | 'boolean' | 'number' {
  if (isBooleanSchema(schema)) return 'boolean';
  if (isNumberSchema(schema)) return 'number';
  return 'string';
}

/**
 * Check if a Zod schema resolves to a number type, unwrapping wrappers recursively.
 * @param schema - The Zod schema to inspect.
 * @returns `true` if the schema represents a number value.
 */
function isNumberSchema(schema: FieldSchema): boolean {
  if (schema instanceof z.ZodNumber) return true;
  if ('unwrap' in schema && typeof schema.unwrap === 'function') {
    return isNumberSchema((schema as { unwrap: () => FieldSchema }).unwrap());
  }
  return false;
}

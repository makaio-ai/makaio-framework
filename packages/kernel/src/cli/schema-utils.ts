/**
 * Shared Zod introspection utilities for CLI schema processing.
 *
 * These helpers are consumed by both `schema-introspection.ts` (server-side
 * manifest serialisation) and `schema-adapter.ts` (client-side Commander
 * registration).  Centralised here to avoid duplication.
 */
import { z } from 'zod';

/**
 * Zod 4's `ZodRawShape[string]` resolves to the internal `$ZodType` which
 * lacks public API methods (`.meta()`, `.isOptional()`).  At runtime these
 * methods exist — this type alias restores access.
 */
export type FieldSchema = z.ZodType;

/**
 * Extract `.meta()` from a Zod schema, unwrapping optionals/defaults.
 *
 * Recursively follows `unwrap()` so that meta attached to the inner schema
 * of `z.optional(z.string().meta({…}))` is still found.
 * @param schema - The Zod schema to inspect.
 * @returns The resolved Zod global metadata or `undefined`.
 */
export function getMeta(schema: FieldSchema): z.GlobalMeta | undefined {
  const direct = schema.meta();
  if ('unwrap' in schema && typeof schema.unwrap === 'function') {
    const inner = getMeta((schema as { unwrap: () => FieldSchema }).unwrap());
    return direct ? { ...(inner ?? {}), ...direct } : inner;
  }

  return direct;
}

/**
 * Check if a Zod schema resolves to a boolean type, unwrapping wrappers
 * recursively.
 * @param schema - The Zod schema to inspect.
 * @returns `true` if the schema represents a boolean value.
 */
export function isBooleanSchema(schema: FieldSchema): boolean {
  if (schema instanceof z.ZodBoolean) return true;
  if ('unwrap' in schema && typeof schema.unwrap === 'function') {
    return isBooleanSchema((schema as { unwrap: () => FieldSchema }).unwrap());
  }
  return false;
}

/**
 * Check if a Zod schema resolves to a number type, unwrapping wrappers
 * recursively.
 * @param schema - The Zod schema to inspect.
 * @returns `true` if the schema represents a numeric value.
 */
export function isNumberSchema(schema: FieldSchema): boolean {
  if (schema instanceof z.ZodNumber) return true;
  if ('unwrap' in schema && typeof schema.unwrap === 'function') {
    return isNumberSchema((schema as { unwrap: () => FieldSchema }).unwrap());
  }
  return false;
}

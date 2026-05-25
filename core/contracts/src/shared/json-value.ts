import { z } from 'zod';

/**
 * JSON-safe value type shared by storage and runtime context contracts.
 *
 * Restricting persisted values to JSON keeps the storage contracts aligned
 * with the actual serialization boundary instead of accepting runtime-only
 * values such as functions, Maps, or `undefined`.
 *
 * The object branch intentionally stays broad (`object`) instead of requiring
 * an index signature. The runtime Zod schema remains the source of truth for
 * JSON validation, while the broader TypeScript type keeps regular DTOs and
 * typed fixtures assignable without forcing every interface in the codebase to
 * declare `[key: string]: ...`.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | object;

/**
 * Recursive JSON-safe value schema.
 *
 * Uses `z.lazy()` so arrays and objects can reference the same schema without
 * widening the contract to arbitrary `unknown`.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(
  (): z.ZodType<JsonValue> =>
    z.union([
      z.string(),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(JsonValueSchema),
      z.record(z.string(), JsonValueSchema),
    ]),
);

/**
 * JSON object helper for map-like persisted configuration records.
 *
 * The runtime validation stays strict, while the public TypeScript surface
 * remains `Record<string, unknown>` so opaque config bags do not force callers
 * to thread `JsonValue` through every intermediate type.
 */
export const JsonObjectSchema: z.ZodType<Record<string, unknown>> = z.record(z.string(), JsonValueSchema);

/**
 * Contract-friendly JSON object schema for opaque config bags.
 *
 * Uses the strict runtime validator above and only narrows the public Zod
 * type. Keeping the underlying schema as `z.record()` is important for
 * protocol exports: `z.custom()` validates correctly at runtime but cannot be
 * represented as JSON Schema.
 */
export const JsonObjectContractSchema = JsonObjectSchema as z.ZodType<Record<string, unknown>, Record<string, unknown>>;

import { z } from 'zod';
import { JsonValueSchema, type JsonValue } from '../shared/json-value.js';

/** JSON Patch operation shape accepted by workflow state mutation subjects. */
export type JsonPatchOperation =
  | { op: 'add' | 'replace' | 'test'; path: string; value: JsonValue }
  | { op: 'remove'; path: string }
  | { op: 'move' | 'copy'; path: string; from: string };

const JsonPatchPointerSchema = z.string().refine((path) => path === '' || path.startsWith('/'), {
  message: 'JSON Patch paths must be empty or start with "/".',
});

const JsonPatchValueOperationSchema = z
  .object({
    op: z.enum(['add', 'replace', 'test']),
    path: JsonPatchPointerSchema,
    value: JsonValueSchema,
  })
  .strict();

const JsonPatchPathOperationSchema = z
  .object({
    op: z.literal('remove'),
    path: JsonPatchPointerSchema,
  })
  .strict();

const JsonPatchFromOperationSchema = z
  .object({
    op: z.enum(['move', 'copy']),
    path: JsonPatchPointerSchema,
    from: JsonPatchPointerSchema,
  })
  .strict();

/** Runtime schema for {@link JsonPatchOperation}. */
export const JsonPatchOperationSchema: z.ZodType<JsonPatchOperation> = z.discriminatedUnion('op', [
  JsonPatchValueOperationSchema,
  JsonPatchPathOperationSchema,
  JsonPatchFromOperationSchema,
]) as z.ZodType<JsonPatchOperation>;

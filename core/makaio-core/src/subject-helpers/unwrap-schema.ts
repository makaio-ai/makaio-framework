import type { EventSchema, RequestSchema, SubjectSchema } from '../types/index.js';
import { isCollectorOnlySchema } from './is-collector-only-schema.js';
import { isLocalSchema } from './is-local-schema.js';
import { isChannelSchema } from './is-channel-schema.js';

/**
 * Unwrap any subject schema wrapper (local, collector-only, or channel) to get the inner schema.
 * Returns the schema as-is if not wrapped.
 * @param schema - The schema to unwrap
 * @returns The inner EventSchema or RequestSchema
 */
export function unwrapSchema(schema: SubjectSchema): EventSchema | RequestSchema {
  if (isLocalSchema(schema)) return schema.schema;
  if (isCollectorOnlySchema(schema)) return schema.schema;
  if (isChannelSchema(schema)) return schema.schema;
  return schema;
}

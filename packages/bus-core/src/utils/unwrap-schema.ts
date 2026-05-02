import type { EventSchema, RequestSchema, SubjectSchema } from '@makaio/core';
import { isLocalSchema } from './local-schema.js';
import { isChannelSchema } from './channel-schema.js';

/**
 * Unwrap any subject schema wrapper (local or channel) to get the inner schema.
 * Returns the schema as-is if not wrapped.
 * @param schema - The schema to unwrap
 * @returns The inner EventSchema or RequestSchema
 */
export function unwrapSchema(schema: SubjectSchema): EventSchema | RequestSchema {
  if (isLocalSchema(schema)) return schema.schema;
  if (isChannelSchema(schema)) return schema.schema;
  return schema;
}

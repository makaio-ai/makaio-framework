export { isChannelSchema, channelSubject } from '@makaio/core';
import type { ChannelSubjectSchema, EventSchema, RequestSchema } from '@makaio/core';

/**
 * Unwrap a ChannelSubjectSchema to get the inner schema.
 * Returns the schema as-is if not a channel wrapper (it may still be another
 * wrapper type such as LocalSubjectSchema — callers should use the general
 * `unwrapSchema()` from `@makaio/core` when full unwrapping is needed).
 * @param schema - The schema to unwrap
 * @returns The inner EventSchema or RequestSchema
 */
export function unwrapChannelSchema(schema: ChannelSubjectSchema): EventSchema | RequestSchema {
  return schema.schema;
}

export { isChannelSchema, channelSubject } from '@makaio/core';
import { inspectSubjectSchema } from '@makaio/core';
import type { ChannelSubjectSchema, EventSchema, JournalOrSelf, RequestSchema } from '@makaio/core';

/**
 * Unwrap a channel subject schema, alone or inside a journal wrapper, to its
 * innermost event or request schema.
 * @param schema - The channel schema to unwrap
 * @returns The innermost EventSchema or RequestSchema
 */
export function unwrapChannelSchema(schema: JournalOrSelf<ChannelSubjectSchema>): EventSchema | RequestSchema {
  return inspectSubjectSchema(schema).schema;
}

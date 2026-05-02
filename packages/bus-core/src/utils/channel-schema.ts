import type { ChannelSubjectSchema, EventSchema, RequestSchema, SubjectSchema } from '@makaio/core';

/**
 * Check if a schema is wrapped as a channel subject.
 * @param schema - The schema to check
 * @returns True if the schema is a ChannelSubjectSchema wrapper
 */
export function isChannelSchema(schema: SubjectSchema): schema is ChannelSubjectSchema {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    '__channel' in schema &&
    schema.__channel === true &&
    'schema' in schema
  );
}

/**
 * Unwrap a ChannelSubjectSchema to get the inner schema.
 * Returns the schema as-is if not a channel wrapper (it may still be another
 * wrapper type such as LocalSubjectSchema — callers should use the general
 * `unwrapSchema()` from `./unwrap-schema.js` when full unwrapping is needed).
 * @param schema - The schema to unwrap
 * @returns The inner EventSchema or RequestSchema
 */
export function unwrapChannelSchema(schema: ChannelSubjectSchema): EventSchema | RequestSchema {
  return schema.schema;
}

/**
 * Create a channel-only subject schema wrapper.
 *
 * Channel subjects are rejected by public bus methods and are only
 * routable through the DirectChannel encrypted point-to-point transport.
 * Use this for subjects that must never travel over the public bus.
 * @param schema - The event or request schema to mark as channel-only
 * @returns A ChannelSubjectSchema wrapper
 * @example
 * ```typescript
 * import { channelSubject } from '@makaio/bus-core';
 *
 * const DirectSchemas = {
 *   // Channel event - encrypted, point-to-point only
 *   message: channelSubject(z.object({ text: z.string() })),
 *
 *   // Channel request - encrypted request-response pair
 *   ping: channelSubject({
 *     request: z.object({ ts: z.number() }),
 *     response: z.object({ ts: z.number() }),
 *   }),
 * };
 * ```
 */
export function channelSubject<T extends EventSchema | RequestSchema>(schema: T): ChannelSubjectSchema<T> {
  return { __channel: true, schema } as const;
}

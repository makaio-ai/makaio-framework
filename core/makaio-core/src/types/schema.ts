import { z, ZodType } from 'zod';

/**
 * Schema definition for event subjects (fire-and-forget).
 * Events have only a payload schema, no response.
 * The payload is now separate from the context, so no restrictions needed.
 */
export type EventSchema = z.ZodType;

/**
 * Schema definition for request subjects (request-response).
 * Requests have both a request payload schema and a response schema.
 */
export type RequestSchema<Request extends ZodType = ZodType, Response extends ZodType = ZodType> = {
  request: Request;
  response: Response;
};

/**
 * Wrapper to mark a subject as local-only (never sent to transports).
 *
 * Use `localSubject()` from `@makaio/bus-core` to create these.
 * @example
 * ```typescript
 * import { localSubject } from '@makaio/bus-core';
 *
 * const WidgetSchemas = {
 *   register: localSubject(widgetDefinitionSchema),  // local event
 *   unregister: localSubject(z.object({ widgetId: z.string() })),
 * };
 * ```
 */
export type LocalSubjectSchema<T extends EventSchema | RequestSchema = EventSchema | RequestSchema> = {
  readonly __local: true;
  readonly schema: T;
};

/**
 * Wrapper to mark an event subject as collector-only.
 *
 * Collector-only events may be received from a transport and delivered to local
 * handlers, but the receiving bus must not relay them onward to other
 * transports. Local emits are also kept local.
 */
export type CollectorOnlySubjectSchema<T extends EventSchema = EventSchema> = {
  readonly __collectorOnly: true;
  readonly schema: T;
};

/**
 * Wrapper to mark a subject as channel-only (encrypted point-to-point).
 *
 * Channel subjects are rejected by public bus methods and are only
 * routable through the DirectChannel encrypted transport. Use
 * `channelSubject()` from `@makaio/bus-core` to create these.
 * @example
 * ```typescript
 * import { channelSubject } from '@makaio/bus-core';
 *
 * const DirectSchemas = {
 *   message: channelSubject(z.object({ text: z.string() })),
 *   ping: channelSubject({
 *     request: z.object({ ts: z.number() }),
 *     response: z.object({ ts: z.number() }),
 *   }),
 * };
 * ```
 */
export type ChannelSubjectSchema<T extends EventSchema | RequestSchema = EventSchema | RequestSchema> = {
  readonly __channel: true;
  readonly schema: T;
};

/**
 * Base schema types (unwrapped).
 */
export type BaseSubjectSchema = EventSchema | RequestSchema;

/**
 * Union of all subject schema types (including local and channel wrappers).
 */
export type SubjectSchema = BaseSubjectSchema | LocalSubjectSchema | CollectorOnlySubjectSchema | ChannelSubjectSchema;

export type SchemaRecord = Record<string, SubjectSchema>;

/**
 * Internal type transformation utilities.
 *
 * These helpers extract and transform types from SubjectTokens and schemas.
 * Used by namespace-types.ts and handler-types.ts for type extraction.
 */

import { z } from 'zod';
import { Simplify } from 'type-fest';
import type {
  BaseOf,
  ChannelSubjectSchema,
  DefaultTransportsSubjectSchema,
  EventSchema,
  HostLocalRequestSubjectSchema,
  LocalSubjectSchema,
  MarksOf,
  RequestSchema,
  SubjectSchema,
} from './schema.js';
import type { TransportRoutingDefault } from './subjects.js';

/**
 * Unwrap subject schema wrappers if present. Returns the innermost bare schema for
 * wrapped subjects (including journal-wrapped ones), or the schema as-is otherwise.
 */
type UnwrapSchema<S> = BaseOf<S>;

/**
 * Infer payload type from schema, including subject metadata wrappers.
 *
 * For requests:
 * - Uses z.input for request (what callers pass before validation/defaults)
 * - Uses z.infer for response (what handlers return after processing)
 *
 * This allows schemas with .default() to have optional fields in the caller API
 * while the response type reflects the validated output.
 *
 * Subject schema wrappers are automatically unwrapped before inference.
 *
 * Idempotent: Returns already-inferred types as-is.
 */
export type InferSchemaPayload<S extends SubjectSchema> = InferSchemaPayloadInner<UnwrapSchema<S>>;

type InferSchemaPayloadInner<S> = S extends {
  request: infer Req extends z.ZodType;
  response: infer Res extends z.ZodType;
}
  ? { request: z.input<Req>; response: z.infer<Res> }
  : S extends z.ZodType
    ? Simplify<z.infer<S>>
    : unknown;

/**
 * True when the routing layer `M` carries the brand of `Wrapper`, false otherwise.
 * Distributes over unions of `M`.
 */
type HasMark<M, Wrapper> = M extends Wrapper ? true : false;

/**
 * Default transport routing meta of the routing layer `M`: required when the layer
 * is a `defaultTransports` wrapper, optional otherwise. Distributes over unions of `M`.
 */
type DefaultTransportsMeta<M> =
  M extends DefaultTransportsSubjectSchema<EventSchema | RequestSchema, infer Default>
    ? { defaultTransports: Default }
    : { defaultTransports?: TransportRoutingDefault };

/**
 * Compute all subject meta from the original schema in one place.
 *
 * Resolves payload, locality, channel membership, request/event discriminator,
 * default transport routing, and namespace from a raw SubjectSchema.
 * @typeParam S - The subject schema type
 * @typeParam Ns - The namespace string
 */
export type InferSubjectMeta<S extends SubjectSchema, Ns extends string> = {
  /** True when the subject is a request-response pair, false for events. */
  isRequest: UnwrapSchema<S> extends { request: z.ZodType; response: z.ZodType } ? true : false;
  /** True when the subject is wrapped with `localSubject()`. */
  local: HasMark<MarksOf<S>, LocalSubjectSchema>;
  /** True when the subject is wrapped with `channelSubject()`. */
  channel: HasMark<MarksOf<S>, ChannelSubjectSchema>;
  /**
   * True when the subject is wrapped with `hostLocalRequest()`.
   *
   * Host-local requests accept direct remote ingress but must never be
   * relayed onward to other transports after ingress.
   */
  hostLocalRequest: HasMark<MarksOf<S>, HostLocalRequestSubjectSchema>;
  /** Inferred payload type (request/response pair or event payload). */
  payload: InferSchemaPayload<S>;
  /** The namespace this subject belongs to. */
  namespace: Ns;
} & DefaultTransportsMeta<MarksOf<S>>;

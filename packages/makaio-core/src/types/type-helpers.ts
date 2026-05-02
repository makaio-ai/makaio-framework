/**
 * Internal type transformation utilities.
 *
 * These helpers extract and transform types from SubjectTokens and schemas.
 * Used by namespace-types.ts and handler-types.ts for type extraction.
 */

import { z } from 'zod';
import { Simplify } from 'type-fest';
import type { ChannelSubjectSchema, LocalSubjectSchema, SubjectSchema } from './schema.js';

/**
 * Unwrap LocalSubjectSchema or ChannelSubjectSchema wrappers if present.
 * Returns the inner schema for wrapped subjects, or the schema as-is otherwise.
 */
type UnwrapSchema<S> = S extends { readonly __local: true; readonly schema: infer Inner }
  ? Inner
  : S extends { readonly __channel: true; readonly schema: infer Inner }
    ? Inner
    : S;

/**
 * Infer payload type from schema (handles EventSchema, RequestSchema,
 * LocalSubjectSchema, and ChannelSubjectSchema).
 *
 * For requests:
 * - Uses z.input for request (what callers pass before validation/defaults)
 * - Uses z.infer for response (what handlers return after processing)
 *
 * This allows schemas with .default() to have optional fields in the caller API
 * while the response type reflects the validated output.
 *
 * LocalSubjectSchema and ChannelSubjectSchema wrappers are automatically
 * unwrapped before inference.
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
 * Compute all subject meta from the original schema in one place.
 *
 * Resolves payload, locality, channel membership, request/event discriminator,
 * and namespace from a raw SubjectSchema.
 * @typeParam S - The subject schema type
 * @typeParam Ns - The namespace string
 */
export type InferSubjectMeta<S extends SubjectSchema, Ns extends string> = {
  /** True when the subject is a request-response pair, false for events. */
  isRequest: UnwrapSchema<S> extends { request: z.ZodType; response: z.ZodType } ? true : false;
  /** True when the subject is wrapped with `localSubject()`. */
  local: S extends LocalSubjectSchema ? true : false;
  /** True when the subject is wrapped with `channelSubject()`. */
  channel: S extends ChannelSubjectSchema ? true : false;
  /** Inferred payload type (request/response pair or event payload). */
  payload: InferSchemaPayload<S>;
  /** The namespace this subject belongs to. */
  namespace: Ns;
};

import type {
  DefaultTransportsSubjectSchema,
  EventSchema,
  JournalOrSelf,
  RequestSchema,
  SubjectSchema,
  TransportRoutingDefault,
} from '../types/index.js';
import { inspectSubjectSchema } from './inspect-subject-schema.js';

/**
 * Check if a schema carries a subject-level default transport routing policy,
 * directly or underneath a journal wrapper.
 *
 * A journal wrapper around a default-transports subject narrows to the whole
 * outer schema: it is never claimed to be a bare
 * {@link DefaultTransportsSubjectSchema}.
 * @param schema - The schema to check
 * @returns True if the schema is a DefaultTransportsSubjectSchema wrapper, or a
 *   journal wrapper around one
 */
export function isDefaultTransportsSchema(
  schema: SubjectSchema,
): schema is JournalOrSelf<DefaultTransportsSubjectSchema> {
  return inspectSubjectSchema(schema).marks.defaultTransports !== undefined;
}

/**
 * Create a subject schema wrapper with a subject-level default transport policy.
 *
 * Use this when one subject should override its namespace's default transport
 * routing while still remaining remotely invokable when a caller explicitly
 * targets a transport.
 * @param schema - The event or request schema to wrap
 * @param value - Default transport routing policy for this subject
 * @returns A DefaultTransportsSubjectSchema wrapper
 * @example
 * ```typescript
 * import { defaultTransports } from '@makaio/core';
 *
 * const Schemas = {
 *   internalEvent: defaultTransports(z.object({ id: z.string() }), 'local-only'),
 * };
 * ```
 */
export function defaultTransports<T extends EventSchema | RequestSchema, Default extends TransportRoutingDefault>(
  schema: T,
  value: Default,
): DefaultTransportsSubjectSchema<T, Default> {
  return { __defaultTransports: value, schema } as const;
}

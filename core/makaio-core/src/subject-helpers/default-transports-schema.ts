import type {
  DefaultTransportsSubjectSchema,
  EventSchema,
  RequestSchema,
  SubjectSchema,
  TransportRoutingDefault,
} from '../types/index.js';

/**
 * Check if a schema carries a subject-level default transport routing policy.
 * @param schema - The schema to check
 * @returns True if the schema is a DefaultTransportsSubjectSchema wrapper
 */
export function isDefaultTransportsSchema(schema: SubjectSchema): schema is DefaultTransportsSubjectSchema {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    '__defaultTransports' in schema &&
    (schema.__defaultTransports === 'all' || schema.__defaultTransports === 'local-only') &&
    'schema' in schema
  );
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

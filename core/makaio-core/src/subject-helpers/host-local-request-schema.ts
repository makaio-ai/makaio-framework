import type { HostLocalRequestSubjectSchema, JournalOrSelf, RequestSchema, SubjectSchema } from '../types/index.js';
import { inspectSubjectSchema } from './inspect-subject-schema.js';

/**
 * Check if a schema is wrapped as a host-local request subject, directly or
 * underneath a journal wrapper.
 *
 * A journal wrapper around a host-local request narrows to the whole outer
 * schema: it is never claimed to be a bare {@link HostLocalRequestSubjectSchema}.
 * @param schema - The schema to check
 * @returns True if the schema is a HostLocalRequestSubjectSchema wrapper, or a
 *   journal wrapper around one
 */
export function isHostLocalRequestSchema(
  schema: SubjectSchema,
): schema is JournalOrSelf<HostLocalRequestSubjectSchema> {
  return inspectSubjectSchema(schema).marks.hostLocalRequest;
}

/**
 * Create a host-local request subject schema wrapper.
 *
 * Host-local requests accept direct remote ingress — a transport may deliver
 * the request to this host — but the receiving bus must never relay the
 * request onward to other transports after ingress. This is the correct
 * wrapper for request subjects that should be answerable only by the
 * receiving host, not forwarded across the bus topology.
 *
 * Only request schemas (with `request` and `response` fields) are accepted;
 * plain event schemas are rejected at the type level.
 * @param schema - The request schema to mark as host-local
 * @returns A HostLocalRequestSubjectSchema wrapper
 * @example
 * ```typescript
 * import { hostLocalRequest } from '@makaio/core';
 *
 * const AgentSchemas = {
 *   // Host-local request — answered locally, never relayed
 *   resolveCapability: hostLocalRequest({
 *     request: z.object({ capabilityId: z.string() }),
 *     response: z.object({ available: z.boolean() }),
 *   }),
 * };
 * ```
 */
export function hostLocalRequest<T extends RequestSchema>(schema: T): HostLocalRequestSubjectSchema<T> {
  return { __hostLocalRequest: true, schema } as const;
}

import type { HostLocalRequestSubjectSchema, RequestSchema, SubjectSchema } from '../types/index.js';

/**
 * Check if a schema is wrapped as a host-local request subject.
 * @param schema - The schema to check
 * @returns True if the schema is a HostLocalRequestSubjectSchema wrapper
 */
export function isHostLocalRequestSchema(schema: SubjectSchema): schema is HostLocalRequestSubjectSchema {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    '__hostLocalRequest' in schema &&
    schema.__hostLocalRequest === true &&
    'schema' in schema
  );
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

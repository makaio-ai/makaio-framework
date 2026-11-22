import { createBusNamespace, localSubject, type SchemaRecord } from '@makaio/core';
import { AccessDeniedSchema } from './access-denied.js';
import { AccessRevokeRequestSchema, AccessRevokeResponseSchema } from './schemas.js';

/**
 * Bus schemas of access decisions.
 *
 * - `denied` announces a denial. It is volatile (not recorded) and local to the host process because it carries
 *   the call context with its claims, which never leave the host process.
 * - `revoke` ends the access granted under one revocation key. Only code in the host process may ask for it.
 */
export const AccessSchemas = {
  denied: localSubject(AccessDeniedSchema),
  revoke: localSubject({ request: AccessRevokeRequestSchema, response: AccessRevokeResponseSchema }),
} satisfies SchemaRecord;

/** Access bus namespace, domain `makaio:access`. */
export const AccessNamespace = createBusNamespace('makaio:access', AccessSchemas);

/** Typed subjects of access decisions, for `bus.request()` and `bus.on()`. */
export const AccessSubjects = AccessNamespace.subjects;

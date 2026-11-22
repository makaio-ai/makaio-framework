import { z } from 'zod';

/**
 * Request to revoke the access a verifier or a connection exchange granted
 * under one revocation key.
 */
export const AccessRevokeRequestSchema = z
  .object({
    /** Key a verifier or an exchange returned with the party it accepted. */
    revocationKey: z.string(),
  })
  .strict();
/** Request to revoke the access granted under one revocation key. */
export type AccessRevokeRequest = z.infer<typeof AccessRevokeRequestSchema>;

/**
 * Response to a revocation. It has one outcome and is always fulfilled, also
 * when repeated and when no connection carries the key.
 */
export const AccessRevokeResponseSchema = z.object({}).strict();
/** Response to a revocation. */
export type AccessRevokeResponse = z.infer<typeof AccessRevokeResponseSchema>;

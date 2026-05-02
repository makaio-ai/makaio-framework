import { z } from 'zod';

/**
 * Shared credential-change sequence contract.
 *
 * Safe-integer bounds keep the bus contract aligned with the runtime
 * sequencer, which only accepts exact JavaScript integers.
 */
export const CredentialChangeSequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * Credential-change sequence inferred from the shared schema.
 */
export type CredentialChangeSequence = z.infer<typeof CredentialChangeSequenceSchema>;

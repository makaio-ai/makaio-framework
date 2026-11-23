import { z } from 'zod';
import { RECOVERY_EVIDENCE_LIMITS } from './types.js';

/** Longest provider ID that can serve as a recovery evidence source. */
export const WORKER_PROVIDER_ID_MAX_LENGTH = RECOVERY_EVIDENCE_LIMITS.source;

/** Instance key within one provider kind. */
export const WorkerProviderKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/**
 * Stable provider instance ID in the form of a kind and key separated by a colon.
 * A change in what an instance represents requires a new key. The schema verifies
 * the separator and key syntax and rejects whitespace in the kind. The host verifies
 * ownership of the kind when it installs the instance.
 */
export type WorkerProviderId = string;

/**
 * Parse the stable ID. The host checks ownership separately when installing a provider.
 * @param id - Candidate provider instance ID.
 * @returns The kind and key when the ID is well formed.
 */
function parseWorkerProviderId(id: string): { readonly kind: string; readonly key: string } | undefined {
  if (id.length > WORKER_PROVIDER_ID_MAX_LENGTH) return undefined;
  const separator = id.indexOf(':');
  if (separator < 1) return undefined;

  const kind = id.slice(0, separator);
  const key = id.slice(separator + 1);
  if (/\s/u.test(kind) || !WorkerProviderKeySchema.safeParse(key).success) return undefined;
  return { kind, key };
}

/** Schema for a well-formed provider ID. */
export const WorkerProviderIdSchema: z.ZodType<WorkerProviderId> = z
  .string()
  .refine((id) => parseWorkerProviderId(id) !== undefined, 'Expected a provider ID of the form <kind>:<key>');
